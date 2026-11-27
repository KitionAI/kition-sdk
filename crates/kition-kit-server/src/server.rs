//! Launch, the connection loop, roles, requests to the host, and method dispatch.
//!
//! Every connection has a reader, a worker and a writer. The reader routes the host's answers to
//! the kit's own requests (`storage.*`) at once and queues everything else; the worker handles the
//! queue in order, one message at a time, so a backend call may wait for the host's answer
//! (protocol section 5.1) while the reader goes on reading it.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::sync::{Notify, mpsc, oneshot};

use crate::backend::{DocumentInfo, Host, HostCall, KitBackend, Notifier, OpenRequest, ScreenshotRequest, Written, with_model_features};
use crate::protocol::framing::{self, read_frame_async, write_frame_async};
use crate::protocol::launch::{ENV_ENDPOINT, ENV_PROTOCOL, ENV_SURFACE, ENV_TOKEN, LAUNCH_ARG, REQUEST_TIMEOUT, ReadyLine, Surface, is_valid_token};
use crate::protocol::methods::is_host_only;
use crate::protocol::transport::{BoxReader, BoxWriter, Listener};
use crate::protocol::{self as p, ErrorReason, Origin, PROTOCOL_VERSION, Request, RequestId, Response, Role, RpcError, base64};
use crate::reply::{self, Incoming};

#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub endpoint: String,
    pub token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("start this program through the Kition kit host ({LAUNCH_ARG})")]
    NotLaunchedByHost,
    #[error("{0}")]
    Environment(String),
    #[error("cannot listen on the endpoint: {0}")]
    Listen(std::io::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl LaunchConfig {
    /// Reads the launch contract (protocol section 3) from the arguments and environment. A
    /// `KITION_KIT_PROTOCOL` other than [`PROTOCOL_VERSION`] still starts the kit: its ready line
    /// says the version it speaks and `kit.initialize` refuses another, so the host can say why.
    pub fn from_env() -> Result<Self, LaunchError> {
        if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(LAUNCH_ARG)) {
            return Err(LaunchError::NotLaunchedByHost);
        }
        let var = |name: &str| std::env::var(name).map_err(|_| LaunchError::Environment(format!("{name} is not set")));
        var(ENV_PROTOCOL)?;
        let token = var(ENV_TOKEN)?;
        if !is_valid_token(&token) {
            return Err(LaunchError::Environment(format!("{ENV_TOKEN} must be 64 lowercase hex characters")));
        }
        // Kits run only headless, for the agent; their editors run in the page.
        let surface = var(ENV_SURFACE)?;
        if Surface::from_env(&surface).is_none() {
            return Err(LaunchError::Environment(format!("{ENV_SURFACE} must be headless, not `{surface}`")));
        }
        Ok(Self { endpoint: var(ENV_ENDPOINT)?, token })
    }
}

/// What a connection's writer task sends.
enum Out {
    Message(Value),
    /// Answered once everything queued before it is written.
    Flush(oneshot::Sender<()>),
}

type Outgoing = mpsc::UnboundedSender<Out>;

fn send(out: &Outgoing, message: Value) {
    let _ = out.send(Out::Message(message));
}

async fn flush(out: &Outgoing) {
    let (done, written) = oneshot::channel();
    if out.send(Out::Flush(done)).is_ok() {
        let _ = written.await;
    }
}

#[derive(Default)]
struct Clients {
    host_connected: bool,
    writers: HashMap<u64, Outgoing>,
}

/// The kit's requests to its host (protocol section 5.1) waiting for an answer.
#[derive(Default)]
struct HostRequests {
    /// The host connection's id and writer.
    connection: Option<(u64, Outgoing)>,
    pending: HashMap<i64, std::sync::mpsc::Sender<Result<Value, RpcError>>>,
    next: i64,
}

fn host_requests(requests: &Mutex<HostRequests>) -> MutexGuard<'_, HostRequests> {
    requests.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The host connection as a backend calls it, from its worker thread.
struct HostLink {
    requests: Arc<Mutex<HostRequests>>,
}

impl HostCall for HostLink {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let (tx, rx) = std::sync::mpsc::channel();
        let id = {
            let mut requests = host_requests(&self.requests);
            let Some((_, out)) = requests.connection.clone() else {
                return Err(RpcError::kit_detail(ErrorReason::IoError, "the host is not connected"));
            };
            requests.next += 1;
            let id = requests.next;
            requests.pending.insert(id, tx);
            send(&out, Request { id: RequestId::Number(id), method: method.to_owned(), params: Some(params) }.to_value());
            id
        };
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                host_requests(&self.requests).pending.remove(&id);
                Err(RpcError::kit_detail(ErrorReason::IoError, format!("the host did not answer {method}")))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(RpcError::kit_detail(ErrorReason::IoError, "the host connection closed")),
        }
    }
}

struct Shared<B> {
    backend: Mutex<B>,
    token: String,
    clients: Mutex<Clients>,
    host: Arc<Mutex<HostRequests>>,
    shutdown: Notify,
}

impl<B> Shared<B> {
    fn clients(&self) -> MutexGuard<'_, Clients> {
        self.clients.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Listens on the endpoint, prints the ready line, and serves until `kit.shutdown`.
pub fn serve<B: KitBackend>(config: LaunchConfig, backend: B) -> Result<(), LaunchError> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(serve_async(config, backend))
}

async fn serve_async<B: KitBackend>(config: LaunchConfig, mut backend: B) -> Result<(), LaunchError> {
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel();
    backend.attach_notifier(Notifier { tx: notify_tx });
    let mut listener = Listener::bind(&config.endpoint).map_err(LaunchError::Listen)?;
    {
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(ReadyLine::default().to_line().as_bytes())?;
        stdout.flush()?;
    }
    let shared = Arc::new(Shared {
        backend: Mutex::new(backend),
        token: config.token,
        clients: Mutex::new(Clients::default()),
        host: Arc::default(),
        shutdown: Notify::new(),
    });
    let notifying = Arc::clone(&shared);
    tokio::spawn(async move {
        while let Some(message) = notify_rx.recv().await {
            broadcast(&notifying, vec![message]);
        }
    });
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((reader, writer)) => {
                    tokio::spawn(connection(Arc::clone(&shared), reader, writer));
                }
                Err(error) => return Err(LaunchError::Io(error)),
            },
            () = shared.shutdown.notified() => return Ok(()),
        }
    }
}

struct Connection {
    id: u64,
    role: Option<Role>,
    out: Outgoing,
}

/// What a handled request asks the connection to do afterwards.
#[derive(Default)]
struct After {
    notifications: Vec<Value>,
    close: bool,
    shutdown: bool,
}

/// A message the worker handles, in the order it came.
enum Work {
    Request { id: RequestId, method: String, params: Value },
    Notification { method: String, params: Value },
}

async fn connection<B: KitBackend>(shared: Arc<Shared<B>>, reader: BoxReader, writer: BoxWriter) {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (out, mut outgoing) = mpsc::unbounded_channel::<Out>();
    tokio::spawn(async move {
        let mut writer = writer;
        while let Some(item) = outgoing.recv().await {
            match item {
                Out::Message(message) => {
                    if let Ok(frame) = framing::encode(&message)
                        && write_frame_async(&mut writer, &frame).await.is_err()
                    {
                        break;
                    }
                }
                Out::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    let cancelled: Arc<Mutex<HashSet<RequestId>>> = Arc::default();
    let (queue, work) = mpsc::unbounded_channel::<Work>();
    let mut worker = tokio::spawn(worker(Arc::clone(&shared), Connection { id, role: None, out: out.clone() }, work, Arc::clone(&cancelled)));
    let mut worker_done = false;
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let read = tokio::select! {
            read = read_frame_async(&mut reader, &mut line) => read,
            _ = &mut worker => {
                worker_done = true;
                break;
            }
        };
        let frame = match read {
            Ok(Some(frame)) => frame,
            // An oversized or non-UTF-8 line was skipped; the stream goes on.
            Err(error) if error.is_recoverable() => {
                send(&out, reply::error_response(None, &RpcError::parse_error()));
                continue;
            }
            Ok(None) | Err(_) => break,
        };
        match reply::parse(&frame) {
            Err(reply) => send(&out, reply),
            Ok(Incoming::Ignored) => {}
            Ok(Incoming::Response(response)) => answer_host_request(&shared, id, response),
            Ok(Incoming::Notification { method, params }) if method == p::methods::CancelRequest::NAME => {
                if let Ok(cancel) = reply::params::<p::CancelRequestParams>(params) {
                    let mut cancelled = cancelled.lock().unwrap_or_else(PoisonError::into_inner);
                    if cancelled.len() > 1024 {
                        cancelled.clear();
                    }
                    cancelled.insert(cancel.id);
                }
            }
            Ok(Incoming::Notification { method, params }) => {
                let _ = queue.send(Work::Notification { method, params });
            }
            Ok(Incoming::Request { id, method, params }) => {
                let _ = queue.send(Work::Request { id, method, params });
            }
        }
    }
    // The host's requests fail first, so a backend call waiting for one returns.
    let was_host = {
        let mut requests = host_requests(&shared.host);
        let host = requests.connection.as_ref().is_some_and(|(host, _)| *host == id);
        if host {
            requests.connection = None;
            requests.pending.clear();
        }
        host
    };
    {
        let mut clients = shared.clients();
        if clients.writers.remove(&id).is_some() && host_requests(&shared.host).connection.is_none() {
            clients.host_connected = false;
        }
    }
    drop(queue);
    if !worker_done {
        let _ = worker.await;
    }
    // The host is gone without `kit.shutdown` (it crashed or was killed): nobody can save or close
    // the documents any more, so the kit ends as it would on `kit.shutdown` (section 4).
    if was_host {
        let _ = with_backend(&shared, |b| {
            b.shutdown();
            Ok(())
        })
        .await;
        shared.shutdown.notify_one();
    }
}

use p::NotificationMethod as _;

/// Routes an answer from the host connection to the kit's request waiting for it.
fn answer_host_request<B>(shared: &Shared<B>, connection: u64, response: Response) {
    let Some(RequestId::Number(id)) = response.id else { return };
    let mut requests = host_requests(&shared.host);
    if requests.connection.as_ref().is_none_or(|(host, _)| *host != connection) {
        return;
    }
    if let Some(waiting) = requests.pending.remove(&id) {
        let _ = waiting.send(response.outcome);
    }
}

async fn worker<B: KitBackend>(
    shared: Arc<Shared<B>>,
    mut connection: Connection,
    mut work: mpsc::UnboundedReceiver<Work>,
    cancelled: Arc<Mutex<HashSet<RequestId>>>,
) {
    while let Some(item) = work.recv().await {
        let (id, method, params) = match item {
            Work::Notification { method, params } => {
                let after = notification(&shared, &connection, &method, params).await;
                broadcast(&shared, after.notifications);
                continue;
            }
            Work::Request { id, method, params } => (id, method, params),
        };
        if cancelled.lock().unwrap_or_else(PoisonError::into_inner).remove(&id) {
            send(&connection.out, reply::error_response(Some(&id), &RpcError::kit(ErrorReason::RequestCancelled)));
            continue;
        }
        let mut after = After::default();
        let outcome = request(&shared, &mut connection, &method, params, &mut after).await;
        let reply = match outcome {
            Ok(result) => reply::result_response(&id, result),
            Err(error) => reply::error_response(Some(&id), &error),
        };
        send(&connection.out, reply);
        broadcast(&shared, after.notifications);
        if after.shutdown {
            flush(&connection.out).await;
            shared.shutdown.notify_one();
            return;
        }
        if after.close {
            flush(&connection.out).await;
            return;
        }
    }
}

fn broadcast<B>(shared: &Shared<B>, notifications: Vec<Value>) {
    if notifications.is_empty() {
        return;
    }
    let writers: Vec<Outgoing> = shared.clients().writers.values().cloned().collect();
    for message in notifications {
        for writer in &writers {
            send(writer, message.clone());
        }
    }
}

/// Runs a backend call on a blocking worker. An escaped panic becomes `-32603` and the backend
/// stays usable: the mutex is recovered rather than treated as poisoned.
async fn with_backend<B: KitBackend, T: Send + 'static>(
    shared: &Arc<Shared<B>>,
    call: impl FnOnce(&mut B) -> Result<T, RpcError> + Send + 'static,
) -> Result<T, RpcError> {
    let shared = Arc::clone(shared);
    let joined = tokio::task::spawn_blocking(move || {
        let mut backend = shared.backend.lock().unwrap_or_else(PoisonError::into_inner);
        catch_unwind(AssertUnwindSafe(|| call(&mut backend)))
    })
    .await;
    match joined {
        Ok(Ok(result)) => result,
        Ok(Err(_)) | Err(_) => Err(RpcError::internal("the kit failed while handling the request; the document was kept")),
    }
}

async fn notification<B: KitBackend>(shared: &Arc<Shared<B>>, connection: &Connection, method: &str, params: Value) -> After {
    let mut after = After::default();
    if connection.role == Some(Role::Host)
        && method == "file.didChangeOnDisk"
        && let Ok(target) = reply::params::<p::DocumentRef>(params)
        && let Ok(Some(info)) = with_backend(shared, move |b| Ok(b.did_change_on_disk(&target.document_id))).await
    {
        after.notifications.push(state_notification(&info));
    }
    after
}

async fn request<B: KitBackend>(
    shared: &Arc<Shared<B>>,
    connection: &mut Connection,
    method: &str,
    params: Value,
    after: &mut After,
) -> Result<Value, RpcError> {
    let Some(role) = connection.role else {
        if method != "kit.initialize" {
            return Err(RpcError::kit(ErrorReason::NotInitialized));
        }
        let result = initialize(shared, connection, params).await;
        after.close = result.as_ref().is_err_and(|error| error.reason() == Some(ErrorReason::Unauthorized));
        return result;
    };
    if role == Role::Agent && is_host_only(method) {
        return Err(RpcError::kit(ErrorReason::RoleForbidden));
    }
    match method {
        "kit.initialize" => Err(RpcError::new(RpcError::INVALID_REQUEST, "already initialized")),
        "kit.ping" => Ok(json!({})),
        "kit.setPreferences" => {
            let prefs: p::SetPreferencesParams = reply::params(params)?;
            with_backend(shared, move |b| {
                b.set_preferences(prefs.locale.as_deref(), prefs.appearance);
                Ok(json!({}))
            })
            .await
        }
        "kit.shutdown" => {
            with_backend(shared, |b| {
                b.shutdown();
                Ok(())
            })
            .await?;
            after.shutdown = true;
            Ok(json!({}))
        }
        "file.open" => {
            let open: p::DocumentOpenParams = reply::params(params)?;
            let info = with_backend(shared, move |b| {
                let create = open.create.as_ref().map(|create| (create.format.as_str(), create.options.as_ref()));
                b.open(OpenRequest { file: &open.file, read_only: open.read_only == Some(true), create })
            })
            .await?;
            after.notifications.push(state_notification(&info));
            Ok(state(&info))
        }
        "file.list" => {
            let documents = with_backend(shared, |b| Ok(b.documents())).await?;
            Ok(json!({ "documents": documents.iter().map(state).collect::<Vec<_>>() }))
        }
        "file.activate" => {
            let target: p::DocumentRef = reply::params(params)?;
            with_backend(shared, move |b| b.activate(&target.document_id)).await?;
            Ok(json!({}))
        }
        "file.save" => {
            let target: p::DocumentRef = reply::params(params)?;
            let (info, written) = with_backend(shared, move |b| b.save(&target.document_id, None, None)).await?;
            Ok(saved(&info, &written, after))
        }
        "file.saveAs" => {
            let save: p::DocumentSaveAsParams = reply::params(params)?;
            let (info, written) = with_backend(shared, move |b| b.save(&save.document_id, Some(&save.file), save.format.as_deref())).await?;
            Ok(saved(&info, &written, after))
        }
        "file.export" => {
            let export: p::DocumentExportParams = reply::params(params)?;
            let written = with_backend(shared, move |b| b.export(&export.document_id, &export.file, &export.format, export.options.as_ref())).await?;
            Ok(json!({ "name": written.name, "version": written.version }))
        }
        "file.reload" => {
            let target: p::DocumentRef = reply::params(params)?;
            let info = with_backend(shared, move |b| b.reload(&target.document_id)).await?;
            after.notifications.push(state_notification(&info));
            Ok(state(&info))
        }
        "file.close" => {
            let close: p::DocumentCloseParams = reply::params(params)?;
            with_backend(shared, move |b| b.close(&close.document_id, close.discard_changes == Some(true))).await?;
            Ok(json!({}))
        }
        "command.list" => {
            let list: p::CommandsListParams = reply::params(params)?;
            let commands =
                with_backend(
                    shared,
                    move |b| {
                        if role == Role::Agent { b.agent_commands(list.document_id.as_deref()) } else { b.commands(list.document_id.as_deref()) }
                    },
                )
                .await?;
            let commands: Vec<Value> = commands
                .iter()
                .filter(|c| list.groups.as_ref().is_none_or(|groups| groups.contains(&c.group)))
                .map(|c| {
                    let mut info = json!({ "id": c.id, "title": c.title, "group": c.group, "params": c.params, "mutates": c.mutates, "enabled": c.enabled });
                    if let Some(description) = &c.description {
                        info["description"] = json!(description);
                    }
                    if let Some(output) = &c.output {
                        info["output"] = output.clone();
                    }
                    if !c.menu.is_empty() {
                        info["menu"] = json!(c.menu);
                    }
                    if let Some(shortcut) = &c.shortcut {
                        info["shortcut"] = json!(shortcut);
                    }
                    if !c.keywords.is_empty() {
                        info["keywords"] = json!(c.keywords);
                    }
                    info
                })
                .collect();
            Ok(json!({ "commands": commands }))
        }
        "command.execute" => {
            let execute: p::CommandsExecuteParams = reply::params(params)?;
            // `system` is the host acting for the person (section 6); an agent never is.
            if execute.origin == Origin::System && role != Role::Host {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "only the host sends origin system"));
            }
            // The agent's connection is the agent's (section 1): the kit applies the agent's
            // limits to every command it runs, so it runs none as the person.
            if role == Role::Agent && execute.origin != Origin::Agent {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "an agent's connection runs commands as origin agent"));
            }
            let label = match (&execute.origin, execute.origin_label.as_deref()) {
                (Origin::System, Some(label)) if !p::is_origin_label(label) => {
                    return Err(RpcError::invalid_params("originLabel is 1 to 64 letters, digits, `-`, `_` or `.`"));
                }
                (Origin::System, label) => label.unwrap_or(p::SYSTEM_LABEL).to_owned(),
                (_, Some(_)) => return Err(RpcError::invalid_params("originLabel goes with origin system")),
                (_, None) => String::new(),
            };
            let (executed, info) = with_backend(shared, move |b| {
                let executed = if execute.origin == Origin::System {
                    b.execute_system(&execute.document_id, &execute.command, execute.params, &label)?
                } else {
                    b.execute(&execute.document_id, &execute.command, execute.params, execute.origin)?
                };
                let info = b.document(&execute.document_id).ok();
                Ok((executed, info))
            })
            .await?;
            if let Some(info) = info {
                after.notifications.push(state_notification(&info));
            }
            let mut result = json!({ "changed": executed.changed });
            if let Some(value) = executed.result {
                result["result"] = value;
            }
            Ok(result)
        }
        "view.screenshot" => {
            let (document_id, shot) = screenshot_request(params)?;
            let image = with_backend(shared, move |b| b.screenshot(&document_id, &shot)).await?;
            Ok(json!({ "mimeType": "image/png", "width": image.width, "height": image.height, "data": base64::encode(&image.png) }))
        }
        "file.check" => {
            let target: p::DocumentRef = reply::params(params)?;
            with_backend(shared, move |b| b.check(&target.document_id)).await
        }
        "file.identity" => {
            let identity: p::DocumentIdentityParams = reply::params(params)?;
            let host = host_of(shared);
            with_backend(shared, move |b| {
                let kind = b.file_identity().ok_or_else(|| RpcError::method_not_found("file.identity"))?;
                let file = host.read(&identity.file)?;
                let doc_id = kind.identity(&file.bytes)?;
                Ok(json!(p::DocumentIdentityResult { doc_id: doc_id.map(|id| id.to_string()) }))
            })
            .await
        }
        "file.fork" => {
            let fork: p::DocumentForkParams = reply::params(params)?;
            let host = host_of(shared);
            with_backend(shared, move |b| {
                let kind = b.file_identity().ok_or_else(|| RpcError::method_not_found("file.fork"))?;
                let file = host.read(&fork.file)?;
                let (bytes, doc_id) = kind.fork(&file.bytes)?;
                // A fork never replaces a file: the target is a `create` handle, committed once.
                let version = host.write(&fork.target, &bytes, None)?;
                let name = host.stat(&fork.target)?.name;
                Ok(json!(p::DocumentForkResult { doc_id: doc_id.map(|id| id.to_string()), name, version }))
            })
            .await
        }
        "file.text" => {
            let request: p::DocumentTextParams = reply::params(params)?;
            let limit = request.limit.unwrap_or(p::DOCUMENT_TEXT_LIMIT);
            with_backend(shared, move |b| b.text(&request.document_id, limit)).await
        }
        "view.describe" => {
            let target: p::DocumentRef = reply::params(params)?;
            let describe = with_backend(shared, move |b| b.describe(&target.document_id)).await?;
            Ok(json!({ "summary": describe.summary, "state": describe.state }))
        }
        "context.get" => {
            let target: p::DocumentRef = reply::params(params)?;
            let state = with_backend(shared, move |b| b.context_get(&target.document_id)).await?;
            Ok(json!({ "state": state }))
        }
        "context.set" => {
            let (document, context) = context_params(params, &["on", "part", "time"])?;
            with_backend(shared, move |b| b.context_set(&document, &context)).await?;
            Ok(json!({}))
        }
        "context.restore" => {
            let (document, mut context) = context_params(params, &["state"])?;
            let state = context.remove("state").unwrap_or(Value::Null);
            with_backend(shared, move |b| b.context_restore(&document, &state)).await?;
            Ok(json!({}))
        }
        "context.under" => {
            let (document, context) = context_params(params, &UNDER_MEMBERS)?;
            with_backend(shared, move |b| b.context_under(&document, &context)).await
        }
        "context.plan" => {
            let (document, context) = context_params(params, &PLAN_MEMBERS)?;
            with_backend(shared, move |b| b.context_plan(&document, &context)).await
        }
        "context.inputs" => {
            let (document, context) = context_params(params, &[])?;
            with_backend(shared, move |b| b.context_inputs(&document, &context)).await
        }
        "context.identity" => {
            let (document, context) = context_params(params, &["objects"])?;
            with_backend(shared, move |b| b.context_identity(&document, &context)).await
        }
        "context.content" => {
            let (document, context) = context_params(params, &["id", "field", "region", "before", "history", "step", "state", "changes"])?;
            with_backend(shared, move |b| b.context_content(&document, &context)).await
        }
        "context.covered" => {
            let (document, context) = context_params(params, &COVERED_MEMBERS)?;
            with_backend(shared, move |b| b.context_covered(&document, &context)).await
        }
        method if method.starts_with("model.") => {
            // A batch on the agent's connection is the agent's (section 1): its `command`
            // operations get the agent's limits, so it runs as no one else.
            if role == Role::Agent && method == "model.batch" && params["origin"]["kind"] != "agent" {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "an agent's connection sends batches with origin { kind: agent, principal }"));
            }
            let method = method.to_owned();
            let document = params.get("documentId").and_then(Value::as_str).map(str::to_owned);
            let (value, info) = with_backend(shared, move |b| {
                let writes = method == "model.batch";
                let value = b.model(&method, params)?;
                let info = if writes { document.and_then(|id| b.document(&id).ok()) } else { None };
                Ok((value, info))
            })
            .await?;
            if let Some(info) = info {
                after.notifications.push(state_notification(&info));
            }
            Ok(value)
        }
        method => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("method not found: {method}"))),
    }
}

async fn initialize<B: KitBackend>(shared: &Arc<Shared<B>>, connection: &mut Connection, params: Value) -> Result<Value, RpcError> {
    let init: p::InitializeParams = reply::params(params)?;
    if init.protocol_version != PROTOCOL_VERSION {
        return Err(RpcError::kit_detail(ErrorReason::UnsupportedProtocol, format!("this kit speaks Kit Process Protocol version {PROTOCOL_VERSION}")));
    }
    if init.token != shared.token {
        return Err(RpcError::kit(ErrorReason::Unauthorized));
    }
    match init.role {
        Role::Host => {
            {
                let mut clients = shared.clients();
                if clients.host_connected {
                    return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "a host is already connected"));
                }
                clients.host_connected = true;
                clients.writers.insert(connection.id, connection.out.clone());
            }
            *host_requests(&shared.host) = HostRequests { connection: Some((connection.id, connection.out.clone())), pending: HashMap::new(), next: 0 };
            let host = Host::new(init.host_services.clone(), Arc::new(HostLink { requests: Arc::clone(&shared.host) }));
            let (locale, appearance) = (init.locale.clone(), init.appearance);
            let answered = with_backend(shared, move |b| {
                b.set_host(host);
                b.set_preferences(locale.as_deref(), appearance);
                Ok((b.kit_id().to_owned(), b.kit_version().to_owned(), capabilities_of(b)))
            })
            .await;
            let (id, version, capabilities) = match answered {
                Ok(answered) => answered,
                Err(error) => {
                    *host_requests(&shared.host) = HostRequests::default();
                    let mut clients = shared.clients();
                    clients.host_connected = false;
                    clients.writers.remove(&connection.id);
                    return Err(error);
                }
            };
            connection.role = Some(Role::Host);
            Ok(initialize_result(&id, &version, capabilities))
        }
        Role::Agent => {
            {
                let mut clients = shared.clients();
                if !clients.host_connected {
                    return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "the host has not initialized"));
                }
                clients.writers.insert(connection.id, connection.out.clone());
            }
            connection.role = Some(Role::Agent);
            let (id, version, capabilities) = with_backend(shared, |b| Ok((b.kit_id().to_owned(), b.kit_version().to_owned(), capabilities_of(b)))).await?;
            Ok(initialize_result(&id, &version, capabilities))
        }
    }
}

/// `view.screenshot`'s document and what it asks for (section 7): `maxSize` 1024 unless given (16
/// to 4096), `scale` 1 unless given (above 0, at most 2, KHP A39), and `target` (A24).
fn screenshot_request(params: Value) -> Result<(String, ScreenshotRequest), RpcError> {
    let shot: p::ViewScreenshotParams = reply::params(params)?;
    let scale = match shot.scale {
        None => 1.0,
        Some(scale) if scale.is_finite() && scale > 0.0 && scale <= 2.0 => scale,
        Some(_) => return Err(RpcError::invalid_params("`scale` is device pixels per document unit: above 0 and at most 2 (KHP A39)")),
    };
    let max_size = shot.max_size.unwrap_or(1024).clamp(16, 4096);
    Ok((shot.document_id, ScreenshotRequest { scope: shot.scope, max_size, scale, target: shot.target }))
}

/// The members of `context.under` besides `documentId`: the step's command and parameters, its
/// `on` when the command takes it through the selection, its part and time.
const UNDER_MEMBERS: [&str; 8] = ["command", "params", "on", "part", "time", "step", "state", "changes"];

/// The members of `context.covered` besides `documentId`: the step's as for
/// `context.under`, and the objects asked about.
const COVERED_MEMBERS: [&str; 10] = ["command", "params", "on", "part", "time", "objects", "history", "step", "state", "changes"];

const PLAN_MEMBERS: [&str; 7] = ["action", "steps", "ops", "step", "token", "method", "params"];

/// The `documentId` of a `context.*` request (section 7a) and its other members, each one of
/// `members`: an unknown member is refused, never ignored.
fn context_params(params: Value, members: &[&str]) -> Result<(String, serde_json::Map<String, Value>), RpcError> {
    let Value::Object(mut fields) = params else { return Err(RpcError::invalid_params("the params are an object with `documentId`")) };
    let document = match fields.remove("documentId") {
        Some(Value::String(id)) => id,
        _ => return Err(RpcError::invalid_params("`documentId` is a string")),
    };
    if let Some(unknown) = fields.keys().find(|key| !members.contains(&key.as_str())) {
        return Err(RpcError::invalid_params(format!("`{unknown}` is not a member of this request; it takes {}", members.join(", "))));
    }
    // Content callbacks consume arbitrary JSON values. Null is a value for these
    // required members, unlike an omitted optional call-context control.
    fields.retain(|key, value| !value.is_null() || matches!(key.as_str(), "region" | "before"));
    Ok((document, fields))
}

/// `kit.initialize`'s `capabilities`: the backend's, with the object model's features when it
/// serves one and `file.identity` when it says how its files carry their identity.
fn capabilities_of<B: KitBackend>(backend: &mut B) -> Value {
    let serves = backend.serves_model();
    let mut capabilities = with_model_features(backend.capabilities(), serves);
    if backend.file_identity().is_some()
        && let Some(object) = capabilities.as_object_mut()
        && let Some(features) = object.entry("features").or_insert_with(|| Value::Array(Vec::new())).as_array_mut()
        && !features.iter().any(|known| known == p::DOCUMENT_IDENTITY_FEATURE)
    {
        features.push(Value::String(p::DOCUMENT_IDENTITY_FEATURE.to_owned()));
    }
    capabilities
}

/// The host's `storage.*` for a request the server answers itself (section 5.6).
fn host_of<B>(shared: &Shared<B>) -> Host {
    Host::new(Vec::new(), Arc::new(HostLink { requests: Arc::clone(&shared.host) }))
}

fn initialize_result(id: &str, version: &str, capabilities: Value) -> Value {
    json!({ "protocolVersion": PROTOCOL_VERSION, "kit": { "id": id, "version": version }, "capabilities": capabilities })
}

fn saved(info: &DocumentInfo, written: &Written, after: &mut After) -> Value {
    after.notifications.push(reply::notification("file.didSave", json!({ "documentId": info.id, "name": written.name, "version": written.version })));
    after.notifications.push(state_notification(info));
    json!({ "name": written.name, "version": written.version })
}

fn state(info: &DocumentInfo) -> Value {
    json!({
        "documentId": info.id,
        "name": info.name,
        "title": info.title,
        "format": info.format,
        "readOnly": info.read_only,
        "dirty": info.dirty,
        "canUndo": info.can_undo,
        "canRedo": info.can_redo,
        "conflict": info.conflict,
    })
}

fn state_notification(info: &DocumentInfo) -> Value {
    reply::notification("file.didChangeState", state(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_object_model_joins_the_features_once() {
        let capabilities = json!({ "surfaces": ["headless"], "features": ["view.describe", "model.batch"] });
        assert_eq!(with_model_features(capabilities.clone(), false), capabilities);
        assert_eq!(with_model_features(capabilities, true)["features"], json!(["view.describe", "model.batch", "model.describe"]));
        assert_eq!(with_model_features(json!({ "surfaces": [] }), true)["features"], json!(["model.describe", "model.batch"]));
    }

    #[test]
    fn content_context_preserves_null_values_for_the_kit_callback() {
        let members = ["id", "field", "region", "before"];
        let (_, params) = context_params(json!({"documentId":"1","id":"board","field":"body","region":null,"before":null}), &members).unwrap();
        let callback = |params: &serde_json::Map<String, Value>| {
            assert_eq!(params.get("region"), Some(&Value::Null));
            assert_eq!(params.get("before"), Some(&Value::Null));
        };
        callback(&params);
        let (_, absent) = context_params(json!({"documentId":"1","id":"board","field":"body"}), &members).unwrap();
        assert!(!absent.contains_key("region"));
    }

    #[test]
    fn a_context_request_takes_its_members_and_refuses_others() {
        let (document, members) = context_params(json!({ "documentId": "1", "on": ["s1"], "part": null }), &["on", "part", "time"]).unwrap();
        assert_eq!((document.as_str(), Value::Object(members)), ("1", json!({ "on": ["s1"] })));
        let refused = context_params(json!({ "documentId": "1", "selection": ["s1"] }), &["on", "part", "time"]).unwrap_err();
        // `context.under` takes the step's `on`.
        let (_, under) = context_params(json!({ "documentId": "1", "command": "x", "on": [32], "params": {} }), &UNDER_MEMBERS).unwrap();
        assert_eq!(under["on"], json!([32]));
        assert!(refused.message.contains("`selection`"), "{}", refused.message);
        assert!(context_params(json!({ "on": [] }), &["on"]).is_err(), "documentId is required");
    }

    #[test]
    fn premise_plan_requests_preserve_raw_prefix_operations_and_references() {
        for action in ["begin", "advance"] {
            let prefix = json!([{"op":"create","type":"Node","ref":"$new","fields":{"name":"planned"}}]);
            let (document, plan) =
                context_params(json!({"documentId":"1","action":action,"token":"plan-1","steps":[],"ops":prefix,"step":1}), &PLAN_MEMBERS).unwrap();
            assert_eq!(document, "1");
            assert_eq!(plan["action"], action);
            assert_eq!(plan["ops"], prefix);
            assert_eq!(plan["token"], "plan-1");
            assert_eq!(plan["step"], 1);
        }
    }

    #[test]
    fn a_host_request_without_a_host_fails_at_once() {
        let link = HostLink { requests: Arc::default() };
        let error = link.call("storage.stat", json!({ "handle": "fh_1" })).unwrap_err();
        assert_eq!(error.reason(), Some(ErrorReason::IoError));
    }

    #[test]
    fn the_host_answer_reaches_the_waiting_call() {
        let requests: Arc<Mutex<HostRequests>> = Arc::default();
        let (out, mut sent) = mpsc::unbounded_channel();
        host_requests(&requests).connection = Some((7, out));
        let link = HostLink { requests: Arc::clone(&requests) };
        let waiting = std::thread::spawn(move || link.call("storage.stat", json!({ "handle": "fh_1" })));
        let Some(Out::Message(request)) = sent.blocking_recv() else { panic!("no request") };
        assert_eq!(request["method"], "storage.stat");
        let shared = Shared { backend: Mutex::new(()), token: String::new(), clients: Mutex::default(), host: Arc::clone(&requests), shutdown: Notify::new() };
        // Another connection's answer is not the host's.
        answer_host_request(&shared, 8, Response { id: Some(RequestId::Number(1)), outcome: Ok(json!({ "wrong": true })) });
        answer_host_request(&shared, 7, Response { id: Some(RequestId::Number(1)), outcome: Ok(json!({ "name": "a.grid" })) });
        assert_eq!(waiting.join().unwrap().unwrap(), json!({ "name": "a.grid" }));
    }
}
