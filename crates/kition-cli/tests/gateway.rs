//! `kition gateway` as a program (sdk.cli.gateway): the ready line and the lockfile, one gateway
//! per workspace, a stale lockfile replaced, the ways it stops. The kit is the mock kit standing
//! in for Kition Example.
#![cfg(unix)]

mod support;

use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
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
