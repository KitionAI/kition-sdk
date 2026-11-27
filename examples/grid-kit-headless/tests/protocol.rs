//! A host written from `docs/platform/reference/kit-process-protocol.md` alone, with no
//! Kition crate, starts the reference grid kit on Kit Process Protocol version 1 and drives it: the
//! ready line and `kit.initialize` say 1, the kit reads and writes its document only through the
//! host's `storage.*` on file handles, a save commits with the version it read, and a stale version
//! is a `file_conflict`. This is the wire as a Go, Python or Swift host speaks it.
#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kit-host-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

/// A file the test host lends the kit under a handle, with the rights it was minted with.
struct Grant {
    path: PathBuf,
    rights: Vec<&'static str>,
    staged: Vec<u8>,
    committed: bool,
}

/// The host side of KitFiles 1.1 as section 5.1 states it, for one folder.
#[derive(Default)]
struct Files {
    grants: HashMap<String, Grant>,
    /// Every `storage.*` method the kit called, in order.
    calls: Vec<String>,
}

fn version(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{modified}-{}", meta.len()))
}

fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            out.push(if i <= chunk.len() { char::from(A[((n >> (18 - 6 * i)) & 63) as usize]) } else { '=' });
        }
    }
    out
}

fn unb64(text: &str) -> Vec<u8> {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut buffer, mut bits) = (Vec::new(), 0u32, 0);
    for byte in text.trim_end_matches('=').bytes() {
        buffer = (buffer << 6) | A.iter().position(|a| *a == byte).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn kit_error(code: i64, reason: &str) -> Value {
    json!({ "code": code, "message": reason, "data": { "reason": reason } })
}

impl Files {
    fn grant(&mut self, handle: &str, path: PathBuf, rights: &[&'static str]) -> String {
        self.grants.insert(handle.to_owned(), Grant { path, rights: rights.to_vec(), staged: Vec::new(), committed: false });
        handle.to_owned()
    }

    fn serve(&mut self, method: &str, params: &Value) -> Result<Value, Value> {
        self.calls.push(method.to_owned());
        let handle = params["handle"].as_str().unwrap_or_default();
        if method == "storage.release" {
            return Ok(json!({}));
        }
        let Some(grant) = self.grants.get_mut(handle) else { return Err(kit_error(-32014, "file_not_granted")) };
        let name = grant.path.file_name().unwrap().to_string_lossy().into_owned();
        match method {
            "storage.stat" => Ok(json!({ "handle": handle, "name": name, "kind": "file", "version": version(&grant.path), "rights": grant.rights })),
            "storage.read" => {
                if !grant.rights.contains(&"read") {
                    return Err(kit_error(-32014, "file_not_granted"));
                }
                let bytes = std::fs::read(&grant.path).map_err(|_| kit_error(-32013, "io_error"))?;
                Ok(json!({ "data": b64(&bytes), "version": version(&grant.path), "size": bytes.len() }))
            }
            "storage.write" => {
                let creating = grant.rights.contains(&"create") && !grant.committed;
                if !creating && !grant.rights.contains(&"write") {
                    return Err(kit_error(-32014, "file_not_granted"));
                }
                assert_eq!(params["offset"].as_u64(), Some(grant.staged.len() as u64), "chunks follow on");
                grant.staged.extend(unb64(params["data"].as_str().unwrap()));
                if params["final"] != true {
                    return Ok(json!({}));
                }
                let bytes = std::mem::take(&mut grant.staged);
                if creating {
                    if grant.path.exists() {
                        return Err(kit_error(-32015, "file_conflict"));
                    }
                } else if params["expected"].as_str().map(str::to_owned) != version(&grant.path) {
                    return Err(kit_error(-32015, "file_conflict"));
                }
                let temp = grant.path.with_extension("part");
                std::fs::write(&temp, bytes).unwrap();
                std::fs::rename(&temp, &grant.path).unwrap();
                grant.committed = true;
                Ok(json!({ "version": version(&grant.path) }))
            }
            _ => Err(json!({ "code": -32601, "message": "method not found" })),
        }
    }
}

/// One connection: requests to the kit, and `storage.*` requests from the kit answered by `files`.
struct Connection {
    writer: Arc<Mutex<UnixStream>>,
    replies: mpsc::Receiver<Value>,
    next: i64,
}

impl Connection {
    fn open(endpoint: &Path, files: Arc<Mutex<Files>>) -> Self {
        let stream = UnixStream::connect(endpoint).unwrap();
        let writer = Arc::new(Mutex::new(stream.try_clone().unwrap()));
        let (tx, replies) = mpsc::channel();
        let answers = Arc::clone(&writer);
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { return };
                let message: Value = serde_json::from_str(&line).unwrap();
                match (message.get("method").and_then(Value::as_str), message.get("id")) {
                    // A request from the kit to the host (section 5.1).
                    (Some(method), Some(id)) => {
                        let outcome = files.lock().unwrap().serve(method, &message["params"]);
                        let reply = match outcome {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
                        };
                        let mut writer = answers.lock().unwrap();
                        writeln!(writer, "{reply}").unwrap();
                    }
                    (Some(_), None) => {}
                    (None, _) => tx.send(message).unwrap(),
                }
            }
        });
        Self { writer, replies, next: 1 }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next;
        self.next += 1;
        writeln!(self.writer.lock().unwrap(), "{}", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).unwrap();
        loop {
            let reply = self.replies.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| panic!("no answer to {method}"));
            if reply["id"] == id {
                return match reply.get("error") {
                    Some(error) => Err(error.clone()),
                    None => Ok(reply["result"].clone()),
                };
            }
        }
    }

    /// Closes the socket, as a host that crashed or was killed leaves it.
    fn close(&self) {
        let _ = self.writer.lock().unwrap().shutdown(std::net::Shutdown::Both);
    }

    fn notify(&mut self, method: &str) {
        writeln!(self.writer.lock().unwrap(), "{}", json!({ "jsonrpc": "2.0", "method": method, "params": {} })).unwrap();
    }
}

struct Kit {
    child: Child,
    endpoint: PathBuf,
}

impl Drop for Kit {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Section 3: one argument, four variables, one ready line.
fn launch(dir: &Path, protocol: &str) -> (Kit, Option<Value>) {
    let endpoint = dir.join("kit.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_kit-grid"))
        .arg("--kition-kit")
        .env("KITION_KIT_PROTOCOL", protocol)
        .env("KITION_KIT_ENDPOINT", &endpoint)
        .env("KITION_KIT_TOKEN", TOKEN)
        .env("KITION_KIT_SURFACE", "headless")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let ready = serde_json::from_str(&line).ok();
    (Kit { child, endpoint }, ready)
}

fn initialize(connection: &mut Connection, role: &str, version: u32) -> Result<Value, Value> {
    let mut params = json!({ "protocolVersion": version, "token": TOKEN, "role": role, "client": { "name": "spec-host", "version": "0" } });
    if role == "host" {
        params["hostServices"] = json!(["storage"]);
    }
    let result = connection.call("kit.initialize", params)?;
    connection.notify("kit.initialized");
    Ok(result)
}

#[test]
fn a_host_written_from_the_spec_drives_the_kit() {
    let dir = folder("drive");
    let (kit, ready) = launch(&dir, "1");
    assert_eq!(ready, Some(json!({ "type": "ready", "protocolVersion": 1 })), "the ready line (section 3)");
    let files = Arc::new(Mutex::new(Files::default()));
    let mut host = Connection::open(&kit.endpoint, Arc::clone(&files));
    let initialized = initialize(&mut host, "host", 1).unwrap();
    assert_eq!(initialized["protocolVersion"], 1);
    assert_eq!(initialized["kit"]["id"], "example.grid");

    // A new document: a handle on a file that does not exist yet (section 5, H3).
    let target = dir.join("plan.grid");
    let handle = files.lock().unwrap().grant("fh_00000000000000000000000000000001", target.clone(), &["read", "create", "write"]);
    let opened = host.call("file.open", json!({ "file": handle, "create": { "format": "grid" } })).unwrap();
    assert_eq!(opened["name"], "plan.grid");
    assert_eq!(opened["dirty"], true);
    assert!(opened.get("uri").is_none(), "no URI: {opened}");
    let id = opened["documentId"].clone();

    // A host's own change on the person's behalf (origin `system`, section 6) is no undo step;
    // the grid kit's engine cannot keep one out of its undo, so it refuses it rather than make it
    // undoable, and the host edits as the person.
    let edit = json!({ "documentId": id, "command": "grid.set", "params": { "x": 1, "y": 1, "grey": 200 }, "origin": "system" });
    let refused = host.call("command.execute", edit.clone()).unwrap_err();
    assert_eq!(refused["data"]["reason"], "command_disabled", "{refused}");
    let person_edit = json!({ "documentId": id, "command": "grid.set", "params": { "x": 1, "y": 1, "grey": 200 }, "origin": "user" });
    assert_eq!(host.call("command.execute", person_edit.clone()).unwrap()["changed"], true);
    let saved = host.call("file.save", json!({ "documentId": id })).unwrap();
    assert_eq!(saved["name"], "plan.grid");
    assert_eq!(saved["version"].as_str(), version(&target).as_deref(), "the version the commit answered");
    assert!(std::fs::read(&target).unwrap().starts_with(b"GRID"));

    // A second save replaces the file with the version the first one left (FA9).
    host.call("command.execute", person_edit).unwrap();
    host.call("command.execute", json!({ "documentId": id, "command": "grid.set", "params": { "x": 2, "y": 1, "grey": 9 }, "origin": "user" })).unwrap();
    host.call("file.save", json!({ "documentId": id })).unwrap();

    // Someone else changes the file; the next save is a conflict, and the file is theirs (H4).
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(&target, b"GRID 1 1\n\x07").unwrap();
    host.call("command.execute", json!({ "documentId": id, "command": "grid.set", "params": { "x": 0, "y": 0, "grey": 1 }, "origin": "user" })).unwrap();
    let conflict = host.call("file.save", json!({ "documentId": id })).unwrap_err();
    assert_eq!(conflict["code"], -32015, "{conflict}");
    assert_eq!(conflict["data"]["reason"], "file_conflict");
    assert_eq!(std::fs::read(&target).unwrap(), b"GRID 1 1\n\x07");

    // The kit touched the file only through files.* (section 5): no write without a commit.
    let calls = files.lock().unwrap().calls.clone();
    assert!(calls.contains(&"storage.write".to_owned()), "{calls:?}");
    assert!(!dir.join("plan.part").exists());

    // An existing file, read through its handle; an ungranted handle is the host's refusal.
    let existing = files.lock().unwrap().grant("fh_00000000000000000000000000000002", target.clone(), &["read"]);
    let reopened = host.call("file.open", json!({ "file": existing, "readOnly": true })).unwrap();
    assert_eq!(reopened["readOnly"], true);
    let refused = host.call("file.open", json!({ "file": "fh_00000000000000000000000000000099" })).unwrap_err();
    assert_eq!(refused["data"]["reason"], "file_not_granted", "{refused}");

    // An agent may not act as the system (section 6).
    let mut agent = Connection::open(&kit.endpoint, Arc::new(Mutex::new(Files::default())));
    initialize(&mut agent, "agent", 1).unwrap();
    let forbidden = agent.call("command.execute", edit).unwrap_err();
    assert_eq!(forbidden["data"]["reason"], "role_forbidden", "{forbidden}");
    // regressions/issue-agent-command-gate: nor as the person, whose commands get no agent limits
    // (section 1: the agent's connection is where the kit enforces them).
    let as_person = json!({ "documentId": id, "command": "grid.set", "params": { "x": 1, "y": 1, "grey": 7 }, "origin": "user" });
    let forbidden = agent.call("command.execute", as_person).unwrap_err();
    assert_eq!(forbidden["data"]["reason"], "role_forbidden", "{forbidden}");

    host.call("kit.shutdown", json!({})).unwrap();
    drop(kit);
    let _ = std::fs::remove_dir_all(dir);
}

/// regressions/issue-screenshot-scale: `view.screenshot` takes the `scale` and `maxSize` of section
/// 7 (KHP A39). `maxSize` bounds the longer side; `scale` is device pixels per document pixel, at
/// most 2, drawn by the engine. The grid kit's engine draws real pixels only up to scale 1 (the
/// SDK's default), so a larger scale it would only enlarge is refused, never answered at 1×; and a
/// `target`, which the default screenshot cannot draw, is refused rather than ignored.
#[test]
fn view_screenshot_takes_scale_and_max_size_and_refuses_what_it_cannot_draw() {
    let dir = folder("screenshot");
    let (kit, _) = launch(&dir, "1");
    let files = Arc::new(Mutex::new(Files::default()));
    let mut host = Connection::open(&kit.endpoint, Arc::clone(&files));
    initialize(&mut host, "host", 1).unwrap();
    let handle = files.lock().unwrap().grant("fh_00000000000000000000000000000003", dir.join("shot.grid"), &["read", "create", "write"]);
    let opened = host.call("file.open", json!({ "file": handle, "create": { "format": "grid", "options": { "width": 320, "height": 200 } } })).unwrap();
    let id = opened["documentId"].clone();
    let size = |answer: &Value| (answer["width"].as_u64().unwrap_or(0), answer["height"].as_u64().unwrap_or(0));
    let shot = |host: &mut Connection, extra: Value| {
        let mut params = json!({ "documentId": id, "scope": "canvas" });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        host.call("view.screenshot", params)
    };

    assert_eq!(size(&shot(&mut host, json!({})).unwrap()), (320, 200), "scale 1 by default");
    assert_eq!(size(&shot(&mut host, json!({ "maxSize": 64 })).unwrap()), (64, 40));
    assert_eq!(size(&shot(&mut host, json!({ "scale": 0.5 })).unwrap()), (160, 100));
    assert_eq!(size(&shot(&mut host, json!({ "scale": 2, "maxSize": 320 })).unwrap()), (320, 200), "maxSize brings scale 2 down to 1");

    let enlarged = shot(&mut host, json!({ "scale": 2 })).unwrap_err();
    assert_eq!(enlarged["data"]["reason"], "invalid_params", "{enlarged}");
    assert!(enlarged["data"]["detail"].as_str().unwrap_or_default().contains("scale 1 at most"), "{enlarged}");
    let past = shot(&mut host, json!({ "scale": 3 })).unwrap_err();
    assert_eq!(past["code"], -32602, "scale is at most 2: {past}");
    let target = shot(&mut host, json!({ "target": { "objectId": "obj_1" } })).unwrap_err();
    assert_eq!(target["data"]["reason"], "invalid_params", "{target}");
    assert!(target["data"]["detail"].as_str().unwrap_or_default().contains("target"), "{target}");

    host.call("kit.shutdown", json!({})).unwrap();
    drop(kit);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_wrong_version_is_refused() {
    let dir = folder("version");
    // Launched with a version it does not speak, the kit says which one it does (section 3).
    let (kit, ready) = launch(&dir, "2");
    assert_eq!(ready, Some(json!({ "type": "ready", "protocolVersion": 1 })));
    let mut host = Connection::open(&kit.endpoint, Arc::new(Mutex::new(Files::default())));
    let refused = initialize(&mut host, "host", 2).unwrap_err();
    assert_eq!(refused["code"], -32004);
    assert_eq!(refused["data"]["reason"], "unsupported_protocol");
    drop(kit);
    let _ = std::fs::remove_dir_all(dir);
}

/// A host that crashes or is killed never sends `kit.shutdown`; the kit ends when its
/// host connection closes, within section 4's 5 seconds, and an agent's leaving does not end it.
#[test]
fn a_kit_ends_when_its_host_connection_closes_without_shutdown() {
    let dir = folder("orphan");
    let (mut kit, _) = launch(&dir, "1");
    let files = Arc::new(Mutex::new(Files::default()));
    let mut host = Connection::open(&kit.endpoint, Arc::clone(&files));
    initialize(&mut host, "host", 1).unwrap();
    let mut agent = Connection::open(&kit.endpoint, Arc::new(Mutex::new(Files::default())));
    initialize(&mut agent, "agent", 1).unwrap();
    agent.close();
    std::thread::sleep(Duration::from_millis(500));
    assert!(kit.child.try_wait().unwrap().is_none(), "an agent's leaving does not end the kit");
    host.call("kit.ping", json!({})).unwrap();

    host.close();
    let gone = (0..50).find_map(|_| {
        std::thread::sleep(Duration::from_millis(100));
        kit.child.try_wait().unwrap()
    });
    assert!(gone.is_some_and(|status| status.success()), "the kit is still running 5 s after its host connection closed: {gone:?}");
    drop(kit);
    let _ = std::fs::remove_dir_all(dir);
}

/// `file.identity` and `file.fork` (section 5.6) on a kit whose files embed no replica,
/// served by kition-kit-server's default: the kit lists the feature, a file carries no identity,
/// and a fork is the same bytes in a new file, which it never replaces.
#[test]
fn a_kit_whose_files_embed_no_replica_has_no_identity_and_forks_the_same_bytes() {
    let dir = folder("identity");
    let (kit, _) = launch(&dir, "1");
    let files = Arc::new(Mutex::new(Files::default()));
    let mut host = Connection::open(&kit.endpoint, Arc::clone(&files));
    let initialized = initialize(&mut host, "host", 1).unwrap();
    assert!(initialized["capabilities"]["features"].as_array().unwrap().contains(&json!("file.identity")), "{initialized}");

    let source = dir.join("plan.grid");
    let handle = files.lock().unwrap().grant("fh_00000000000000000000000000000011", source.clone(), &["read", "create", "write"]);
    let opened = host.call("file.open", json!({ "file": handle, "create": { "format": "grid" } })).unwrap();
    let id = opened["documentId"].clone();
    host.call("command.execute", json!({ "documentId": id, "command": "grid.set", "params": { "x": 2, "y": 3, "grey": 90 }, "origin": "user" })).unwrap();
    host.call("file.save", json!({ "documentId": id })).unwrap();

    let read = files.lock().unwrap().grant("fh_00000000000000000000000000000012", source.clone(), &["read"]);
    assert_eq!(host.call("file.identity", json!({ "file": read })).unwrap(), json!({ "docId": null }));
    let target = dir.join("copy.grid");
    let create = files.lock().unwrap().grant("fh_00000000000000000000000000000013", target.clone(), &["create"]);
    let forked = host.call("file.fork", json!({ "file": read, "target": create })).unwrap();
    assert_eq!(forked["docId"], Value::Null, "{forked}");
    assert_eq!(forked["name"], "copy.grid");
    assert_eq!(std::fs::read(&target).unwrap(), std::fs::read(&source).unwrap());

    // The target is a `create` handle: a second fork into it is the host's refusal.
    let again = files.lock().unwrap().grant("fh_00000000000000000000000000000014", target.clone(), &["create"]);
    let refused = host.call("file.fork", json!({ "file": read, "target": again })).unwrap_err();
    assert_eq!(refused["data"]["reason"], "file_conflict", "{refused}");

    host.call("kit.shutdown", json!({})).unwrap();
    drop(kit);
    let _ = std::fs::remove_dir_all(dir);
}
