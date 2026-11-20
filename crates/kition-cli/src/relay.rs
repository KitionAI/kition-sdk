//! `kition mcp` relaying to a running gateway (`kition gateway`, `gateway.rs`). When a live
//! gateway serves the same canonical workspace, every JSON-RPC message from the MCP client on
//! stdin goes to the gateway's `POST /api/v1/mcp/kits` with its token, and the answers come back
//! on stdout: the gateway's kits, with its Kit AI bridge, run the calls, so a file open in a kit
//! editor attached to the gateway is edited live. With no gateway, the kits run in this process,
//! exactly as without the relay.
//!
//! The relay names its connection (`Kition-Mcp-Connection`, a random id for this process), so
//! its request ids and cancellations are its own and it is one agent, the same one after a
//! gateway restart; it passes its call options (`--drafts`, `--guard`, `--require-basis`) along
//! (`Kition-Mcp-Options`). The kits, the sandbox, the limits and the kit store are the gateway's.
//!
//! The gateway can come and go while the client stays:
//!
//! - **It stops.** A message the gateway never received (nothing listens, or its token is
//!   refused: a new gateway took the port) is served here instead: this process makes its own
//!   kits, tells them the client's `initialize` again, and serves from then on. A message the
//!   gateway may have received when the connection broke is not run again, since a write may
//!   already have happened: a tool call answers a tool error saying so, any other request a
//!   JSON-RPC error; the next message finds out where to go.
//! - **It starts, or another takes its place.** Before each request while serving here with
//!   nothing in flight, the relay looks for a live gateway (one lockfile read; the gateway is
//!   asked only when the lockfile changed). When one appears, this process saves and stops its
//!   kits, tells the gateway the client's `initialize`, and relays from then on.
//!
//! Server-to-client notifications (progress, `notifications/tools/list_changed`) do not come
//! through the relay: the gateway's endpoint answers each message with JSON only.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_kits::cli::mcp::{Prepared, Store};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::gateway::{self, Lockfile, TOKEN_HEADER};
use crate::home::Home;

const PROGRAM: &str = "kition mcp";
/// The prefix of the ids of messages the relay sends itself; their answers are not the client's.
const OWN_ID: &str = "kition-relay-";

/// What `kition mcp`'s arguments say the relay needs to know.
pub struct Plan {
    workspace: PathBuf,
    unified: bool,
    options: Value,
    /// Options that choose this process's own kits, which a gateway's kits replace.
    own_kits: Vec<String>,
}

impl Plan {
    /// The plan for `kition mcp` with `args` (after its store flags); `None` when the arguments
    /// ask for something other than serving (the usage, schemas, the kit list, a drafts command)
    /// or cannot be read, which `kition mcp` then answers itself.
    pub fn read(args: &[String], own_flags: &[&str]) -> Option<Self> {
        let mut plan = Self {
            workspace: std::env::current_dir().ok()?,
            unified: false,
            options: json!({}),
            own_kits: own_flags.iter().map(|flag| (*flag).to_owned()).collect(),
        };
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "drafts" | "--help" | "-h" | "--schemas" | "--list-kits" => return None,
                "--workspace" => plan.workspace = PathBuf::from(args.next()?),
                "--unified" => plan.unified = true,
                "--drafts" => plan.options["draft"] = json!(true),
                "--require-basis" => plan.options["requireBasis"] = json!(true),
                "--guard" => plan.options["guard"] = json!(args.next()?),
                "--sandbox" => plan.own_kits.push(arg.clone()),
                "--kit" | "--kits-dir" | "--call-timeout-secs" | "--idle-timeout-secs" | "--memory-limit-mib" => {
                    args.next()?;
                    plan.own_kits.push(arg.clone());
                }
                _ => return None,
            }
        }
        Some(plan)
    }
}

/// Where messages go now.
enum Mode {
    Gateway(Lockfile),
    Local(Local),
}

/// The kits served in this process: `kition_kits::mcp::serve` on a pipe, whose answers go to
/// stdout, and the requests it has not answered yet.
struct Local {
    input: tokio::io::DuplexStream,
    pending: Arc<Mutex<HashSet<String>>>,
    serving: tokio::task::JoinHandle<()>,
    output: tokio::task::JoinHandle<()>,
}

/// What the gateway made of a message.
enum Sent {
    /// Its answer (a request's), or nothing (a notification's).
    Answered(Option<String>),
    /// It never got it: nothing listens, or the token is refused.
    Gone,
    /// The connection broke when the gateway may have got it.
    Unknown(String),
    /// It refused the message (`400`, ...).
    Refused(u16, String),
}

struct Relay {
    plan: Plan,
    home: Home,
    canonical: PathBuf,
    connection: String,
    options: String,
    stdout: mpsc::Sender<String>,
    /// The client's `initialize` and whether it said `notifications/initialized`, told again to
    /// whichever server takes over.
    initialize: Option<Value>,
    initialized: bool,
    /// The store, until this process makes its kits; then how to make them again.
    store: Option<Store>,
    prepared: Option<Arc<Prepared>>,
    /// A lockfile already found not to be a gateway to relay to (stale, or another tool set).
    passed_over: Option<Lockfile>,
    replays: u64,
}

/// Serves `kition mcp` on stdio, relaying to a live gateway for the plan's workspace when there
/// is one. `args` are `kition mcp`'s (after its store flags).
pub fn run(plan: Plan, args: Vec<String>, store: Store) -> ExitCode {
    let home = match Home::from_env() {
        Ok(home) => home,
        Err(_) => return kition_kits::cli::mcp::main(PROGRAM, args.into_iter(), Some(store)),
    };
    let Ok(canonical) = std::fs::canonicalize(&plan.workspace) else {
        return kition_kits::cli::mcp::main(PROGRAM, args.into_iter(), Some(store));
    };
    let runtime = match kition_kits::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{PROGRAM}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let code = runtime.block_on(async move {
        let (stdout, lines) = mpsc::channel::<String>(256);
        let writer = tokio::spawn(write_lines(lines));
        let options = plan.options.to_string();
        let relay = Relay {
            plan,
            home,
            canonical,
            connection: hex_id(),
            options,
            stdout,
            initialize: None,
            initialized: false,
            store: Some(store),
            prepared: None,
            passed_over: None,
            replays: 0,
        };
        let code = relay.serve(args).await;
        let _ = writer.await;
        code
    });
    runtime.shutdown_timeout(Duration::from_secs(1));
    code
}

fn hex_id() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

async fn write_lines(mut lines: mpsc::Receiver<String>) {
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.recv().await {
        if stdout.write_all(format!("{line}\n").as_bytes()).await.is_err() || stdout.flush().await.is_err() {
            break;
        }
    }
}

fn is_request(message: &Value) -> bool {
    message.get("method").is_some() && message.get("id").is_some()
}

/// The answer to a request the gateway may have run when its connection broke.
fn uncertain(message: &Value, why: &str) -> Value {
    let text = format!(
        "The Kition gateway stopped answering while it handled this request ({why}); it may or may not have run. Inspect the file before you try again: the next call goes to a gateway again or runs here."
    );
    if message["method"] == "tools/call" {
        json!({ "jsonrpc": "2.0", "id": message["id"], "result": {
            "content": [{ "type": "text", "text": text }],
            "structuredContent": { "error": { "code": "unavailable", "message": text, "retryable": true } },
            "isError": true,
        } })
    } else {
        json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": -32603, "message": text } })
    }
}

/// Sends `body` to the gateway `lock` names, on the relay's connection.
fn post(lock: &Lockfile, connection: &str, options: &str, body: &str) -> Sent {
    let address = format!("{}{}/mcp/kits", lock.url.trim_end_matches('/'), lock.api_prefix);
    let sent = gateway::agent(None)
        .post(&address)
        .header(TOKEN_HEADER, &lock.token)
        .header("Kition-Mcp-Connection", connection)
        .header("Kition-Mcp-Options", options)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .send(body.as_bytes());
    match sent {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let text = response.body_mut().with_config().limit(1 << 30).read_to_vec().map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
            match (status, text) {
                (200, Ok(text)) => Sent::Answered(Some(text.trim().to_owned())),
                (200, Err(error)) => Sent::Unknown(error.to_string()),
                (202, _) => Sent::Answered(None),
                (401, _) => Sent::Gone,
                (status, text) => Sent::Refused(status, text.unwrap_or_default()),
            }
        }
        Err(ureq::Error::ConnectionFailed | ureq::Error::HostNotFound | ureq::Error::Timeout(ureq::Timeout::Connect | ureq::Timeout::Resolve)) => Sent::Gone,
        Err(ureq::Error::Io(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => Sent::Gone,
        Err(error) => Sent::Unknown(error.to_string()),
    }
}

impl Relay {
    /// The live gateway for the workspace, if one serves it with this client's tool set.
    async fn find_gateway(&mut self, quiet: bool) -> Option<Lockfile> {
        let path = gateway::lockfile_path(&self.home, &self.canonical);
        let lock = gateway::read(&path)?;
        if self.passed_over.as_ref() == Some(&lock) {
            return None;
        }
        let probe = lock.clone();
        let live = tokio::task::spawn_blocking(move || gateway::identity(&probe).is_some()).await.unwrap_or(false);
        if !live || lock.workspace != self.canonical.to_string_lossy() {
            self.passed_over = Some(lock);
            return None;
        }
        if lock.unified != self.plan.unified {
            if !quiet {
                let with = |on: bool| if on { "with --unified" } else { "without --unified" };
                eprintln!(
                    "{PROGRAM}: a gateway (pid {}) serves this workspace {}, and this server runs {}: serving in this process",
                    lock.pid,
                    with(lock.unified),
                    with(self.plan.unified)
                );
            }
            self.passed_over = Some(lock);
            return None;
        }
        Some(lock)
    }

    fn own_kits_note(&self) {
        if !self.plan.own_kits.is_empty() {
            eprintln!("{PROGRAM}: {} apply to the kits of this process only; the gateway's kits serve while it relays", self.plan.own_kits.join(", "));
        }
    }

    async fn serve(mut self, args: Vec<String>) -> ExitCode {
        let mut mode = match self.find_gateway(false).await {
            Some(lock) => {
                self.say_relaying(&lock);
                Mode::Gateway(lock)
            }
            None => match self.start_local(args.clone()).await {
                Ok(local) => Mode::Local(local),
                Err(code) => return code,
            },
        };
        let (retry, mut retries) = mpsc::channel::<Value>(64);
        let mut forwarding = tokio::task::JoinSet::new();
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let mut open = true;
        loop {
            // stdin closed and nothing is on its way to the gateway: done (what it never got is
            // served below).
            if !open && forwarding.is_empty() {
                break;
            }
            let message = tokio::select! {
                line = lines.next_line(), if open => match line {
                    Ok(Some(line)) if line.trim().is_empty() => continue,
                    Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                        Ok(message) if message.is_object() => message,
                        Ok(_) => {
                            let _ = self.stdout.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "a message is one JSON-RPC object" } }).to_string()).await;
                            continue;
                        }
                        Err(_) => {
                            let _ = self.stdout.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } }).to_string()).await;
                            continue;
                        }
                    },
                    Ok(None) | Err(_) => {
                        open = false;
                        continue;
                    }
                },
                Some(message) = retries.recv() => {
                    // The gateway never got it: find where it goes now.
                    if let Mode::Gateway(_) = mode {
                        mode = match self.find_gateway(true).await {
                            Some(lock) => {
                                eprintln!("{PROGRAM}: the gateway changed; relaying to pid {} at {}", lock.pid, lock.url);
                                self.replay_to_gateway(&lock).await;
                                Mode::Gateway(lock)
                            }
                            None => {
                                eprintln!("{PROGRAM}: the gateway stopped; serving in this process");
                                match self.start_local(args.clone()).await {
                                    Ok(mut local) => {
                                        self.replay_to_local(&mut local).await;
                                        Mode::Local(local)
                                    }
                                    Err(code) => return code,
                                }
                            }
                        };
                    }
                    message
                },
                Some(_) = forwarding.join_next(), if !forwarding.is_empty() => continue,
                else => break,
            };
            if message["method"] == "initialize" && is_request(&message) {
                self.initialize = Some(message.clone());
            }
            if message["method"] == "notifications/initialized" {
                self.initialized = true;
            }
            // Serving here with nothing in flight: a gateway that appeared takes over.
            if let Mode::Local(local) = &mode
                && is_request(&message)
                && message["method"] != "initialize"
                && local.pending.lock().unwrap_or_else(PoisonError::into_inner).is_empty()
                && let Some(lock) = self.find_gateway(true).await
                && let Mode::Local(local) = std::mem::replace(&mut mode, Mode::Gateway(lock.clone()))
            {
                stop_local(local).await;
                eprintln!("{PROGRAM}: a gateway started for this workspace; relaying to pid {} at {}", lock.pid, lock.url);
                self.replay_to_gateway(&lock).await;
            }
            match &mut mode {
                Mode::Local(local) => send_local(local, &message).await,
                Mode::Gateway(lock) => {
                    let (lock, connection, options, stdout, retry) =
                        (lock.clone(), self.connection.clone(), self.options.clone(), self.stdout.clone(), retry.clone());
                    forwarding.spawn(async move {
                        let body = message.to_string();
                        let sent = {
                            let (lock, connection, options) = (lock.clone(), connection.clone(), options.clone());
                            tokio::task::spawn_blocking(move || post(&lock, &connection, &options, &body)).await.unwrap_or_else(|error| Sent::Unknown(error.to_string()))
                        };
                        match sent {
                            Sent::Answered(Some(answer)) => {
                                let _ = stdout.send(answer).await;
                            }
                            Sent::Answered(None) => {}
                            Sent::Gone => {
                                let _ = retry.send(message).await;
                            }
                            Sent::Unknown(why) if is_request(&message) => {
                                let _ = stdout.send(uncertain(&message, &why).to_string()).await;
                            }
                            Sent::Unknown(_) => {}
                            Sent::Refused(status, text) if is_request(&message) => {
                                let answer = json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": -32603, "message": format!("the Kition gateway refused the message (HTTP {status}): {}", text.trim()) } });
                                let _ = stdout.send(answer.to_string()).await;
                            }
                            Sent::Refused(..) => {}
                        }
                    });
                }
            }
        }
        while forwarding.join_next().await.is_some() {}
        // Messages the gateway never got while stdin was closing are served here.
        drop(retry);
        let mut late = Vec::new();
        while let Ok(message) = retries.try_recv() {
            late.push(message);
        }
        if !late.is_empty() && matches!(mode, Mode::Gateway(_)) {
            match self.start_local(args.clone()).await {
                Ok(mut local) => {
                    self.replay_to_local(&mut local).await;
                    mode = Mode::Local(local);
                }
                Err(code) => return code,
            }
        }
        if let Mode::Local(mut local) = mode {
            for message in late {
                send_local(&mut local, &message).await;
            }
            stop_local(local).await;
        }
        ExitCode::SUCCESS
    }

    fn say_relaying(&self, lock: &Lockfile) {
        eprintln!(
            "{PROGRAM}: workspace {}: relaying to the Kition gateway (pid {}, {}); --no-relay serves in this process",
            self.canonical.display(),
            lock.pid,
            lock.url
        );
        self.own_kits_note();
    }

    /// This process's kits, made on first use (from the store) or again (after a gateway served).
    async fn start_local(&mut self, args: Vec<String>) -> Result<Local, ExitCode> {
        let kits = match (&self.prepared, self.store.take()) {
            (Some(prepared), _) => {
                let prepared = Arc::clone(prepared);
                match tokio::task::spawn_blocking(move || (prepared.remake)()).await {
                    Ok(Ok(kits)) => kits,
                    Ok(Err(reason)) => {
                        eprintln!("{PROGRAM}: {reason}");
                        return Err(ExitCode::FAILURE);
                    }
                    Err(_) => return Err(ExitCode::FAILURE),
                }
            }
            (None, Some(store)) => {
                let prepared = tokio::task::spawn_blocking(move || kition_kits::cli::mcp::prepare(PROGRAM, args.into_iter(), Some(store)))
                    .await
                    .map_err(|_| ExitCode::FAILURE)??;
                let kits = prepared.kits.clone();
                self.prepared = Some(Arc::new(prepared));
                kits
            }
            (None, None) => return Err(ExitCode::FAILURE),
        };
        let call = self.prepared.as_ref().map(|prepared| prepared.call).unwrap_or_default();
        let (input, server_input) = tokio::io::duplex(1 << 20);
        let (server_output, output) = tokio::io::duplex(1 << 20);
        let serving = tokio::spawn(async move {
            if let Err(error) = kition_kits::mcp::serve(kits, call, server_input, server_output).await {
                eprintln!("{PROGRAM}: {error}");
            }
        });
        let pending: Arc<Mutex<HashSet<String>>> = Arc::default();
        let output = {
            let (pending, stdout) = (Arc::clone(&pending), self.stdout.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(output).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let answer: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    if answer.get("method").is_none()
                        && let Some(id) = answer.get("id")
                    {
                        pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id.to_string());
                        if id.as_str().is_some_and(|id| id.starts_with(OWN_ID)) {
                            continue;
                        }
                    }
                    if stdout.send(line).await.is_err() {
                        break;
                    }
                }
            })
        };
        Ok(Local { input, pending, serving, output })
    }

    fn own_initialize(&mut self) -> Option<Value> {
        let mut message = self.initialize.clone()?;
        self.replays += 1;
        message["id"] = json!(format!("{OWN_ID}{}", self.replays));
        Some(message)
    }

    /// Tells a gateway that takes over the client's `initialize` (its answer is not the client's).
    async fn replay_to_gateway(&mut self, lock: &Lockfile) {
        let Some(initialize) = self.own_initialize() else { return };
        let mut messages = vec![initialize];
        if self.initialized {
            messages.push(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        }
        let (lock, connection, options) = (lock.clone(), self.connection.clone(), self.options.clone());
        let _ = tokio::task::spawn_blocking(move || {
            for message in messages {
                post(&lock, &connection, &options, &message.to_string());
            }
        })
        .await;
    }

    /// Tells this process's kits the client's `initialize`.
    async fn replay_to_local(&mut self, local: &mut Local) {
        let Some(initialize) = self.own_initialize() else { return };
        send_local(local, &initialize).await;
        if self.initialized {
            send_local(local, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        }
    }
}

async fn send_local(local: &mut Local, message: &Value) {
    if is_request(message) {
        local.pending.lock().unwrap_or_else(PoisonError::into_inner).insert(message["id"].to_string());
    }
    let _ = local.input.write_all(format!("{message}\n").as_bytes()).await;
}

/// Stops this process's kits: the server finishes what it accepted, saves and stops every kit.
async fn stop_local(local: Local) {
    let Local { mut input, serving, output, .. } = local;
    let _ = input.shutdown().await;
    drop(input);
    let _ = tokio::time::timeout(Duration::from_secs(60), serving).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), output).await;
}
