//! `kition` as a person and an agent run it, against a kit index made on the spot: `kit list`
//! with and without the index, through a proxy, and `kition mcp` installing the mock kit
//! (`kition-kit-mock`) when the agent first names a `.mocktext` file, then announcing its tools.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, the tests that run it say so and pass. CI requires it.

mod support;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use support::{Entry, IndexBuilder, Server, archive, workspace_binary};

fn kition(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kition"));
    command.env("KITION_HOME", home).env_remove("KITION_INDEX");
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy().into_owned();
        if key.starts_with("KITION_KIT_") || key.to_ascii_lowercase().ends_with("_proxy") {
            command.env_remove(key);
        }
    }
    command
}

fn run(command: &mut Command) -> (bool, String, String) {
    let output = command.output().unwrap();
    (output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
}

/// An index in `dir` listing the mock kit (`mock`, `.mocktext`) built from the workspace's
/// executable and its kit.json.
fn mock_index(dir: &Path, mock: &Path) -> PathBuf {
    let manifest = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../kition-kit-mock/kit.json")).unwrap();
    let program = std::fs::read(mock).unwrap();
    let exe = format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX);
    let bytes = archive(&[Entry::File("kit.json", &manifest, 0o644), Entry::File(&exe, &program, 0o755)]);
    IndexBuilder::new().kit(dir, "mock", "mocktext", &[("0.0.0", "kition-kit/1", bytes)]).write(dir)
}

#[test]
fn version_and_help() {
    let home = tempfile::tempdir().unwrap();
    let (ok, out, _) = run(kition(home.path()).arg("--version"));
    assert!(ok && out.starts_with(&format!("kition {}", env!("CARGO_PKG_VERSION"))) && out.contains("kition-kit/1"), "{out}");
    let (ok, out, _) = run(kition(home.path()).arg("--help"));
    assert!(ok && out.contains("kition kit install") && out.contains("KITION_HOME"), "{out}");
    let (ok, out, _) = run(kition(home.path()).args(["mcp", "--help"]));
    assert!(ok && out.contains("kition mcp --workspace") && out.contains("--no-install") && out.contains("--unified"), "{out}");
    let (ok, out, _) = run(kition(home.path()).args(["serve", "--help"]));
    assert!(ok && out.contains("kition serve --workspace"), "{out}");
    let (ok, _, err) = run(kition(home.path()).arg("frobnicate"));
    assert!(!ok && err.contains("unknown command frobnicate"), "{err}");
}

/// `kit list` shows the installed kits when the index cannot be read, and reads the index through
/// the proxy the environment names.
#[test]
fn list_works_offline_and_through_a_proxy() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let staged = home.join("kits").join("desk").join("1.0.0");
    std::fs::create_dir_all(&staged).unwrap();
    std::fs::write(staged.join("kit.json"), support::manifest("desk", "1.0.0", "kition-kit/1", "kdesk", "kition-desk").to_string()).unwrap();
    std::fs::write(staged.join(format!("kition-desk{}", std::env::consts::EXE_SUFFIX)), b"x").unwrap();

    let missing = dir.path().join("no-index.json").display().to_string();
    let (ok, out, err) = run(kition(&home).args(["kit", "list", "--json", "--index", &missing]));
    assert!(ok, "{err}");
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(listed["index"]["read"], false);
    assert_eq!(listed["kits"][0]["name"], "desk");
    assert_eq!(listed["kits"][0]["inUse"], "1.0.0");
    assert_eq!(listed["kits"][0]["extensions"], json!(["kdesk"]));
    let (ok, out, err) = run(kition(&home).args(["kit", "list", "--index", &missing]));
    assert!(ok && out.contains("desk") && out.contains("1.0.0") && err.contains("installed kits only"), "{out}{err}");

    IndexBuilder::new()
        .kit(&served, "fake", "kfake", &[("0.1.0", "kition-kit/1", support::kit_archive("fake", "0.1.0", "kition-kit/1", "kfake", "kition-fake", b"x"))])
        .write(&served);
    let proxy = Server::start(&served);
    let (ok, out, err) = run(kition(&home).env("HTTP_PROXY", format!("http://127.0.0.1:{}", proxy.port)).env("NO_PROXY", "").args([
        "kit",
        "list",
        "--json",
        "--index",
        "http://kits.example.invalid/kits-index.json",
    ]));
    assert!(ok, "{err}");
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(listed["index"]["read"], true, "{listed}");
    assert_eq!(listed["kits"][1]["name"], "fake");
    assert_eq!(listed["kits"][1]["latest"], "0.1.0");
    assert!(proxy.seen.lock().unwrap().iter().any(|seen| seen.starts_with("kits.example.invalid")), "{:?}", proxy.seen.lock().unwrap());
}

/// A stdio MCP client of `kition mcp`.
struct Client {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<Value>,
    next: u64,
    notifications: Vec<Value>,
}

impl Client {
    fn start(mut command: Command) -> Self {
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let _ = send.send(value);
                }
            }
        });
        Self { child, stdin, lines, next: 0, notifications: Vec::new() }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params })).unwrap();
        loop {
            let message = self.lines.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| panic!("{method} timed out"));
            if message.get("id") == Some(&json!(self.next)) {
                return message;
            }
            self.notifications.push(message);
        }
    }

    fn tools(&mut self) -> Vec<String> {
        let listed = self.request("tools/list", json!({}));
        listed["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect()
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({ "name": name, "arguments": arguments }))["result"].clone()
    }

    fn close(mut self) {
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

fn initialize(client: &mut Client) -> Value {
    let init = client.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }));
    writeln!(client.stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).unwrap();
    init["result"].clone()
}

#[test]
fn mcp_installs_a_kit_when_the_agent_first_names_its_file() {
    let Some(mock) = workspace_binary("kition-kit-mock") else {
        eprintln!("kition-kit-mock is not built: skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("a.mocktext"), "hello").unwrap();
    std::fs::write(workspace.join("b.unknownext"), "?").unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    mock_index(&served, &mock);
    let server = Server::start(&served);

    let mut command = kition(&home);
    command.args(["mcp", "--workspace"]).arg(&workspace).args(["--index", &server.url("kits-index.json")]);
    let mut client = Client::start(command);
    let init = initialize(&mut client);
    assert_eq!(init["capabilities"]["tools"]["listChanged"], true);
    assert!(init["instructions"].as_str().unwrap().contains("Kits installed when you first use a file of theirs"), "{init}");
    assert_eq!(client.tools(), vec!["kit_inspect"], "nothing is installed: only the tool that installs");

    let unknown = client.call("kit_inspect", json!({ "path": "b.unknownext" }));
    assert_eq!(unknown["isError"], true);
    assert_eq!(unknown["structuredContent"]["error"]["code"], "invalid-params");
    assert!(unknown["content"][0]["text"].as_str().unwrap().contains("No Kition kit opens .unknownext files"), "{unknown}");

    let inspected = client.call("kit_inspect", json!({ "path": "a.mocktext" }));
    assert_eq!(inspected["isError"], false, "{inspected}");
    assert!(client.notifications.iter().any(|message| message["method"] == "notifications/tools/list_changed"), "{:?}", client.notifications);
    let tools = client.tools();
    assert!(tools.contains(&"mock_inspect".to_owned()) && tools.contains(&"mock_run".to_owned()) && !tools.contains(&"kit_inspect".to_owned()), "{tools:?}");
    let checked = client.call("mock_check", json!({ "path": "a.mocktext" }));
    assert_eq!(checked["isError"], false, "{checked}");
    client.close();
    assert!(home.join("kits").join("mock").join("0.0.0").join("kit.json").is_file());

    // The next server starts with the kit installed.
    let mut command = kition(&home);
    command.args(["mcp", "--workspace"]).arg(&workspace).args(["--index", &server.url("kits-index.json")]);
    let mut client = Client::start(command);
    initialize(&mut client);
    assert!(client.tools().contains(&"mock_inspect".to_owned()));
    client.close();
}

#[test]
fn mcp_says_how_to_install_when_it_may_not_and_when_offline() {
    let Some(mock) = workspace_binary("kition-kit-mock") else {
        eprintln!("kition-kit-mock is not built: skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("a.mocktext"), "hello").unwrap();
    let index = mock_index(dir.path(), &mock);

    let mut command = kition(&home);
    command.args(["mcp", "--no-install", "--workspace"]).arg(&workspace).args(["--index"]).arg(&index);
    let mut client = Client::start(command);
    initialize(&mut client);
    let refused = client.call("kit_inspect", json!({ "path": "a.mocktext" }));
    assert_eq!(refused["isError"], true);
    assert_eq!(refused["structuredContent"]["error"]["code"], "not-allowed");
    assert!(refused["content"][0]["text"].as_str().unwrap().contains("kition kit install mock"), "{refused}");
    client.close();
    assert!(!home.join("kits").join("mock").exists());

    // Offline: the index read at startup is kept, and the archive cannot be fetched.
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    mock_index(&served, &mock);
    let server = Server::start(&served);
    let url = server.url("kits-index.json");
    for entry in std::fs::read_dir(&served).unwrap().flatten() {
        if entry.path().extension().is_some_and(|extension| extension == "gz") {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    let mut command = kition(&home);
    command.args(["mcp", "--workspace"]).arg(&workspace).args(["--index", &url]);
    let mut client = Client::start(command);
    initialize(&mut client);
    let failed = client.call("kit_inspect", json!({ "path": "a.mocktext" }));
    assert_eq!(failed["isError"], true);
    assert_eq!(failed["structuredContent"]["error"]["code"], "unavailable");
    assert_eq!(failed["structuredContent"]["error"]["retryable"], true);
    assert!(failed["content"][0]["text"].as_str().unwrap().contains("Installing Mock (for .mocktext files) failed"), "{failed}");
    client.close();
    assert!(!home.join("kits").join("mock").exists());
}
