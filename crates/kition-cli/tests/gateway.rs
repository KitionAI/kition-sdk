//! `kition gateway` and `kition mcp` relaying to it, as programs (sdk.cli.gateway,
//! sdk.agent.gateway-relay): the ready line and the lockfile, one gateway per workspace, a stale
//! lockfile replaced, the ways it stops; and an MCP client of `kition mcp` whose `kit_run` on a
//! file open in an editor attached to the gateway reaches that editor as `kit/call`, runs headless
//! with no editor, runs in `kition mcp`'s own process once the gateway stops, and goes to a
//! gateway that starts later. The kit is the mock kit standing in for Kition Example; the editor
//! is a scripted client of the gateway's bridge stream.
#![cfg(unix)]

mod support;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{kition, workspace_binary};

const FILE: &str = "notes/Plan.example";

/// A workspace with `FILE`, a kits folder holding the Example kit served by the mock, and a home.
struct Setup {
    _dir: tempfile::TempDir,
    home: PathBuf,
    workspace: PathBuf,
    kits: PathBuf,
}

fn setup() -> Option<Setup> {
    let mock = workspace_binary("kition-kit-mock")?;
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, workspace, kits) = (base.join("home"), base.join("workspace"), base.join("kits"));
    std::fs::create_dir_all(workspace.join("notes")).unwrap();
    std::fs::write(workspace.join(FILE), "plan").unwrap();
    let example = kits.join("example-ui");
    std::fs::create_dir_all(&example).unwrap();
    let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../kition-kits/tests/support/example.json");
    std::fs::copy(&manifest_path, example.join("kit.json")).unwrap();
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let launcher = example.join("kition-example");
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            manifest["version"].as_str().unwrap(),
            mock.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    Some(Setup { _dir: dir, home, workspace, kits })
}

/// A running `kition gateway`: the process, its ready line, and its stdin (held open).
struct Gateway {
    child: Child,
    ready: Value,
    _stdin: Option<ChildStdin>,
}

impl Gateway {
    fn start(setup: &Setup, extra: &[&str]) -> Self {
        let mut child = kition(&setup.home)
            .args(["gateway", "--workspace"])
            .arg(&setup.workspace)
            .args(["--kits-dir"])
            .arg(&setup.kits)
            .args(["--unified"])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let line = line_within(BufReader::new(stdout), Duration::from_secs(30)).unwrap_or_else(|| panic!("no ready line"));
        let ready: Value = serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line}"));
        let stdin = child.stdin.take();
        Self { child, ready, _stdin: stdin }
    }

    fn url(&self) -> String {
        self.ready["url"].as_str().unwrap().to_owned()
    }

    fn lock(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.ready["lockfile"].as_str().unwrap()).unwrap()).unwrap()
    }

    fn token(&self) -> String {
        self.lock()["token"].as_str().unwrap().to_owned()
    }

    /// Sends `signal` and waits for the process: its exit status and stderr.
    fn stop(mut self, signal: &str) -> (Option<i32>, String) {
        let pid = self.child.id().to_string();
        assert!(Command::new("kill").args([&format!("-{signal}"), &pid]).status().unwrap().success());
        let status = wait(&mut self.child, Duration::from_secs(30));
        let mut stderr = String::new();
        let _ = self.child.stderr.take().unwrap().read_to_string(&mut stderr);
        (status, stderr)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The next line of `reader` within `limit`, read on a thread of its own.
fn line_within(reader: impl BufRead + Send + 'static, limit: Duration) -> Option<String> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = send.send(line);
    });
    receive.recv_timeout(limit).ok().filter(|line| !line.is_empty())
}

fn wait(child: &mut Child, limit: Duration) -> Option<i32> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code();
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the process did not exit in {limit:?}");
}

fn http(method: &str, url: &str, token: Option<&str>, body: Option<&Value>) -> (u16, Value) {
    let agent = ureq::Agent::config_builder().proxy(None).http_status_as_error(false).build().new_agent();
    let mut response = match (method, body) {
        ("GET", _) => {
            let request = agent.get(url);
            match token {
                Some(token) => request.header("Kition-Token", token).call(),
                None => request.call(),
            }
        }
        (_, body) => {
            let request = agent.post(url).header("Content-Type", "application/json");
            let request = match token {
                Some(token) => request.header("Kition-Token", token),
                None => request,
            };
            request.send(body.map(Value::to_string).unwrap_or_default().as_bytes())
        }
    }
    .unwrap();
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[test]
fn a_gateway_announces_itself_holds_its_workspace_and_stops_cleanly() {
    let Some(setup) = setup() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let gateway = Gateway::start(&setup, &[]);
    let ready = &gateway.ready;
    assert_eq!(ready["kition"], "gateway-ready");
    assert_eq!(ready["protocol"], "kition-gateway/1");
    assert_eq!(ready["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(ready["pid"], gateway.child.id());
    assert_eq!(ready["apiPrefix"], "/api/v1");
    assert_eq!(ready["workspace"], setup.workspace.display().to_string());
    let port = ready["port"].as_u64().unwrap();
    assert!(port > 0 && ready["url"] == format!("http://127.0.0.1:{port}"), "{ready}");
    assert!(ready.get("token").is_none() && !ready.to_string().contains(&gateway.token()), "the token is not on stdout");
    // The lockfile: the same and the token, readable by this account only.
    let lockfile = PathBuf::from(ready["lockfile"].as_str().unwrap());
    assert_eq!(lockfile.parent(), Some(setup.home.join("run").as_path()));
    assert_eq!(std::fs::metadata(&lockfile).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(setup.home.join("run")).unwrap().permissions().mode() & 0o777, 0o700);
    let lock = gateway.lock();
    assert_eq!(
        (lock["pid"].clone(), lock["port"].clone(), lock["unified"].clone(), lock["format"].clone()),
        (ready["pid"].clone(), ready["port"].clone(), json!(true), json!(1))
    );
    assert!(gateway.token().len() == 64 && gateway.token().bytes().all(|byte| byte.is_ascii_hexdigit()));

    // Loopback only, the health probe open, everything else behind the token.
    let url = gateway.url();
    // Bound to 127.0.0.1 only: this machine's address on its network does not reach it (no packet
    // leaves for the route lookup; without a network there is nothing to check).
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    if probe.connect("192.0.2.1:9").is_ok()
        && let Ok(local) = probe.local_addr()
        && !local.ip().is_loopback()
        && !local.ip().is_unspecified()
    {
        assert!(TcpStream::connect_timeout(&(local.ip(), port as u16).into(), Duration::from_secs(2)).is_err(), "reachable at {}", local.ip());
    }
    assert_eq!(http("GET", &format!("{url}/health"), None, None), (200, json!({ "code": 200, "message": "success", "data": "healthy" })));
    assert_eq!(http("GET", &format!("{url}/api/v1/kits"), None, None).0, 401);
    let (status, identity) = http("GET", &format!("{url}/api/v1/gateway"), Some(&gateway.token()), None);
    assert_eq!((status, identity["data"]["pid"].clone(), identity["data"]["workspace"].clone()), (200, ready["pid"].clone(), ready["workspace"].clone()));

    // A second gateway for the workspace finds the first, says so, and leaves it alone.
    let output = kition(&setup.home)
        .args(["gateway", "--workspace"])
        .arg(setup.workspace.join("notes/.."))
        .args(["--kits-dir"])
        .arg(&setup.kits)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3), "{}", String::from_utf8_lossy(&output.stderr));
    let running: Value = serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).unwrap();
    assert_eq!(
        (running["kition"].clone(), running["pid"].clone(), running["url"].clone()),
        (json!("gateway-running"), ready["pid"].clone(), ready["url"].clone())
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("already serves"));
    assert_eq!(gateway.lock()["pid"], ready["pid"], "the lockfile is still the first gateway's");
    // kition doctor names it.
    let (_, out, _) = support::run(kition(&setup.home).args(["doctor", "--json", "--index"]).arg(setup.home.join("no-index.json")));
    let report: Value = serde_json::from_str(&out).unwrap_or_else(|_| panic!("{out}"));
    let gateways = report["checks"].as_array().unwrap().iter().find(|check| check["name"] == "gateways").cloned().unwrap_or_default();
    assert_eq!(gateways["status"], "info", "{report}");
    assert!(gateways["detail"].as_str().unwrap().contains(&format!("1 running: {} at {}", setup.workspace.display(), url)), "{gateways}");

    // SIGTERM: it stops, and takes its lockfile along.
    let (status, stderr) = gateway.stop("TERM");
    assert_eq!(status, Some(0), "{stderr}");
    assert!(stderr.contains("SIGTERM"), "{stderr}");
    assert!(!lockfile.exists());

    // A lockfile left by a gateway that is gone is replaced.
    let stale = json!({ "format": 1, "protocol": "kition-gateway/1", "version": "0.0.0", "pid": 1, "port": 9, "url": "http://127.0.0.1:9", "apiPrefix": "/api/v1", "token": "0".repeat(64), "workspace": setup.workspace.display().to_string(), "unified": true, "started": 0 });
    std::fs::write(&lockfile, stale.to_string()).unwrap();
    let replacing = Gateway::start(&setup, &[]);
    assert_eq!(replacing.lock()["pid"], replacing.child.id());
    let (status, _) = replacing.stop("INT");
    assert_eq!(status, Some(0));
    assert!(!lockfile.exists());
}

#[test]
fn a_gateway_stops_with_its_stdin_or_when_idle() {
    let Some(setup) = setup() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let mut gateway = Gateway::start(&setup, &["--stdin-lifetime"]);
    let lockfile = PathBuf::from(gateway.ready["lockfile"].as_str().unwrap());
    drop(gateway._stdin.take());
    assert_eq!(wait(&mut gateway.child, Duration::from_secs(30)), Some(0));
    assert!(!lockfile.exists());

    let mut idle = Gateway::start(&setup, &["--idle-timeout", "1"]);
    let started = Instant::now();
    assert_eq!(wait(&mut idle.child, Duration::from_secs(30)), Some(0));
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert!(!lockfile.exists());
}

/// An editor window attached to the gateway's bridge: it lists `FILE` as open, answers every
/// request, and reports each `kit/call` on `calls`. Shutting `socket` down closes the window.
struct Editor {
    socket: TcpStream,
    calls: mpsc::Receiver<Value>,
}

impl Editor {
    fn attach(gateway: &Gateway) -> Self {
        let (url, token, port) = (gateway.url(), gateway.token(), gateway.ready["port"].as_u64().unwrap());
        let mut socket = TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
        write!(socket, "GET /api/v1/kits/bridge HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nKition-Token: {token}\r\nAccept: text/event-stream\r\n\r\n").unwrap();
        let reader = BufReader::new(socket.try_clone().unwrap());
        let (report, calls) = mpsc::channel();
        let (ready, attached) = mpsc::channel();
        std::thread::spawn(move || {
            let mut session = 0;
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Some(data) = line.strip_prefix("data:") else { continue };
                let Ok(message) = serde_json::from_str::<Value>(data.trim()) else { continue };
                let result = match message["method"].as_str() {
                    Some("bridge.ready") => {
                        session = message["params"]["session"].as_u64().unwrap_or_default();
                        let _ = ready.send(());
                        continue;
                    }
                    Some("kit/documents") => json!({ "documents": [{ "path": FILE, "kit": "kit.example", "dirty": false, "revision": 1 }] }),
                    Some("kit/call") => {
                        let _ = report.send(message["params"].clone());
                        json!({ "completed": [{ "command": "text.append", "changed": true, "result": null }], "saved": true, "document": { "summary": "edited in the editor" } })
                    }
                    Some("kit/preview") => json!({ "png": "iVBORw0KGgo=" }),
                    _ => continue,
                };
                http(
                    "POST",
                    &format!("{url}/api/v1/kits/bridge?session={session}"),
                    Some(&token),
                    Some(&json!({ "jsonrpc": "2.0", "id": message["id"], "result": result })),
                );
            }
        });
        attached.recv_timeout(Duration::from_secs(30)).unwrap();
        Self { socket, calls }
    }

    fn close(self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// `kition mcp` as an MCP client starts it, line by line.
struct Client {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next: u64,
}

impl Client {
    fn start(setup: &Setup, extra: &[&str]) -> Self {
        let mut child = kition(&setup.home)
            .args(["mcp", "--workspace"])
            .arg(&setup.workspace)
            .args(["--kits-dir"])
            .arg(&setup.kits)
            .args(["--unified"])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in stdout.lines().map_while(Result::ok) {
                let _ = send.send(line);
            }
        });
        let mut client = Self { child, stdin, lines, next: 0 };
        let init = client
            .request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "relay-test", "version": "1" } }));
        assert_eq!(init["result"]["serverInfo"]["name"], "kition-kits", "{init}");
        writeln!(client.stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).unwrap();
        client
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params })).unwrap();
        let line = self.lines.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| panic!("no answer to {method}"));
        let answer: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(answer["id"], self.next, "{answer}");
        answer
    }

    fn run(&mut self) -> Value {
        self.request(
            "tools/call",
            json!({ "name": "kit_run", "arguments": { "path": FILE, "steps": [{ "command": "text.append", "params": { "text": " B" } }] } }),
        )
    }

    /// Closes stdin: its exit status and its stderr.
    fn finish(mut self) -> (Option<i32>, String) {
        drop(self.stdin);
        let status = wait(&mut self.child, Duration::from_secs(60));
        let mut stderr = String::new();
        let _ = self.child.stderr.take().unwrap().read_to_string(&mut stderr);
        (status, stderr)
    }
}

#[test]
fn kition_mcp_relays_to_the_gateway_and_serves_alone_when_it_is_gone() {
    let Some(setup) = setup() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let read = || std::fs::read_to_string(setup.workspace.join(FILE)).unwrap();
    let gateway = Gateway::start(&setup, &[]);
    let editor = Editor::attach(&gateway);
    let mut client = Client::start(&setup, &[]);

    // (a) The file is open in the editor attached to the gateway: the call reaches it.
    let live = client.run();
    assert_eq!(live["result"]["isError"], false, "{live}");
    assert_eq!(live["result"]["structuredContent"]["live"], true, "{live}");
    let call = editor.calls.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!((call["tool"].as_str(), call["path"].as_str()), (Some("run"), Some(FILE)));
    assert_eq!(read(), "plan", "nothing ran headless");

    // (b) The editor goes away: the gateway's headless kit runs the call.
    editor.close();
    let headless = client.run();
    assert_eq!(headless["result"]["isError"], false, "{headless}");
    assert_ne!(headless["result"]["structuredContent"]["live"], true, "{headless}");
    assert_eq!(read(), "plan B");

    // (c) The gateway stops: the next call runs in kition mcp's own process.
    let (status, _) = gateway.stop("TERM");
    assert_eq!(status, Some(0));
    let alone = client.run();
    assert_eq!(alone["result"]["isError"], false, "{alone}");
    assert_eq!(read(), "plan B B");

    // (d) A gateway starts for the workspace: kition mcp hands over to it.
    let later = Gateway::start(&setup, &[]);
    let editor = Editor::attach(&later);
    let relayed = client.run();
    assert_eq!(relayed["result"]["structuredContent"]["live"], true, "{relayed}");
    assert!(editor.calls.recv_timeout(Duration::from_secs(10)).is_ok());
    assert_eq!(read(), "plan B B");
    let (status, stderr) = client.finish();
    assert_eq!(status, Some(0), "{stderr}");
    assert!(stderr.contains("relaying to the Kition gateway"), "{stderr}");
    assert!(stderr.contains("the gateway stopped; serving in this process"), "{stderr}");
    assert!(stderr.contains("a gateway started for this workspace; relaying"), "{stderr}");

    // --no-relay serves in its own process, gateway or not.
    let mut alone = Client::start(&setup, &["--no-relay"]);
    let ran = alone.run();
    assert_ne!(ran["result"]["structuredContent"]["live"], true, "{ran}");
    assert!(editor.calls.recv_timeout(Duration::from_millis(500)).is_err(), "the editor got nothing");
    assert_eq!(read(), "plan B B B");
    let (status, stderr) = alone.finish();
    assert_eq!(status, Some(0), "{stderr}");
    assert!(!stderr.contains("relaying"), "{stderr}");
    editor.close();
    drop(later);
}
