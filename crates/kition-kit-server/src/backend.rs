//! The editor side of a kit: documents and commands. The server calls a backend from a blocking
//! worker thread, one call at a time, and turns an escaped panic into an internal error.
//!
//! A backend names files only by the handles the host gave it, and reads and writes them through
//! [`Host`], the host's `files.*` services (protocol section 5.1).

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::identity::FileIdentity;
use crate::protocol::methods::{self, HostServiceMethod};
use crate::protocol::{Appearance, ErrorReason, FILE_CHUNK, FileStat, FilesReadParams, FilesWriteParams, Origin, RpcError, ScreenshotScope, base64};

/// Sends one request to the host and waits for its answer, from a backend's worker thread.
pub trait HostCall: Send + Sync {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

/// The host as a backend reaches it: the services it said it serves (`hostServices`) and its
/// `files.*` (protocol section 5.1). Cheap to clone; a call fails once the host is gone.
#[derive(Clone)]
pub struct Host {
    services: Vec<String>,
    link: Arc<dyn HostCall>,
}

/// A whole file read through its handle, and the version it had.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileBytes {
    pub bytes: Vec<u8>,
    pub version: String,
}

impl Host {
    pub fn new(services: Vec<String>, link: Arc<dyn HostCall>) -> Self {
        Self { services, link }
    }

    /// Whether the host listed `service` in `hostServices`.
    pub fn serves(&self, service: &str) -> bool {
        self.services.iter().any(|known| known == service)
    }

    /// A typed request to the host.
    pub fn request<M: HostServiceMethod>(&self, params: &M::Params) -> Result<M::Result, RpcError> {
        let params = serde_json::to_value(params).map_err(|error| RpcError::internal(error.to_string()))?;
        let answer = self.link.call(M::NAME, params)?;
        serde_json::from_value(answer).map_err(|error| RpcError::kit_detail(ErrorReason::IoError, format!("the host's answer to {}: {error}", M::NAME)))
    }

    pub fn stat(&self, handle: &str) -> Result<FileStat, RpcError> {
        self.request::<methods::FilesStat>(&crate::protocol::FileRef { handle: handle.to_owned() })
    }

    /// Up to `length` bytes from `offset`; the host may answer fewer. Answers the bytes and the
    /// whole file's size.
    pub fn read_range(&self, handle: &str, offset: u64, length: u64) -> Result<(Vec<u8>, u64), RpcError> {
        let length = length.min(FILE_CHUNK as u64);
        let read = self.request::<methods::FilesRead>(&FilesReadParams { handle: handle.to_owned(), offset: Some(offset), length: Some(length) })?;
        let bytes = base64::decode(&read.data).ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host sent bytes that are not base64"))?;
        Ok((bytes, read.size))
    }

    /// The whole file, chunk by chunk, with the version of its first chunk.
    pub fn read(&self, handle: &str) -> Result<FileBytes, RpcError> {
        let mut bytes = Vec::new();
        let mut version = None;
        loop {
            let read = self.request::<methods::FilesRead>(&FilesReadParams {
                handle: handle.to_owned(),
                offset: Some(bytes.len() as u64),
                length: Some(FILE_CHUNK as u64),
            })?;
            let chunk = base64::decode(&read.data).ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host sent bytes that are not base64"))?;
            version.get_or_insert(read.version);
            let done = chunk.is_empty() || bytes.len() as u64 + chunk.len() as u64 >= read.size;
            bytes.extend(chunk);
            if done {
                break;
            }
        }
        Ok(FileBytes { bytes, version: version.unwrap_or_default() })
    }

    /// Writes `bytes` to the file `handle` names in staged chunks, then commits them atomically
    /// (`KitFiles 1.1` FA9). A replacing write carries `expected`, the version the kit read; a
    /// new file's first commit carries none. Answers the committed version.
    pub fn write(&self, handle: &str, bytes: &[u8], expected: Option<&str>) -> Result<String, RpcError> {
        let mut offset = 0usize;
        loop {
            let end = (offset + FILE_CHUNK).min(bytes.len());
            let last = end == bytes.len();
            let chunk = FilesWriteParams {
                handle: handle.to_owned(),
                data: base64::encode(bytes.get(offset..end).unwrap_or_default()),
                offset: offset as u64,
                last: last.then_some(true),
                expected: if last { expected.map(str::to_owned) } else { None },
            };
            let written = self.request::<methods::FilesWrite>(&chunk)?;
            if last {
                return written.version.ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host committed no version"));
            }
            offset = end;
        }
    }
}

/// Sends notifications to every initialized client, from any thread.
#[derive(Clone)]
pub struct Notifier {
    pub(crate) tx: tokio::sync::mpsc::UnboundedSender<Value>,
}

impl Notifier {
    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.tx.send(crate::reply::notification(method, params));
    }
}

/// What the kit knows about one open document.
#[derive(Clone, Debug, PartialEq)]
pub struct DocumentInfo {
    /// Opaque and stable for the document's lifetime.
    pub id: String,
    /// The file's display name (a last segment).
    pub name: String,
    pub title: String,
    pub format: String,
    pub read_only: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// The file changed since the kit read it while the document has unsaved edits.
    pub conflict: bool,
}

pub struct OpenRequest<'a> {
    /// The file's handle.
    pub file: &'a str,
    pub read_only: bool,
    /// `file.open` `create`: the format and options of a new document in the file.
    pub create: Option<(&'a str, Option<&'a Map<String, Value>>)>,
}

/// A file a save or an export committed: its display name and the version the commit answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommandSummary {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub group: String,
    /// A JSON Schema for the command's params.
    pub params: Value,
    /// A JSON Schema for the command's `result`, when the kit publishes one (KHP A1): what an MCP
    /// binding sends as the tool's `outputSchema`, with the A18 error result beside it.
    pub output: Option<Value>,
    pub mutates: bool,
    pub enabled: bool,
    /// Where the command sits in the kit's menus, for example `["Layer", "New"]`; empty for none.
    pub menu: Vec<String>,
    /// The default shortcut, for example `Cmd+Shift+N`.
    pub shortcut: Option<String>,
    /// Words a command search finds it by that its id, title and description do not say.
    pub keywords: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Executed {
    pub changed: bool,
    pub result: Option<Value>,
}

/// What `view.screenshot` asks for (section 7): the image at `scale` device pixels per document
/// unit (1 unless given, at most 2) and at most `max_size` pixels on its longer side, of `target`
/// when one is given (KHP A24, A39).
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenshotRequest {
    pub scope: ScreenshotScope,
    pub max_size: u32,
    pub scale: f64,
    pub target: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Describe {
    pub summary: String,
    pub state: Map<String, Value>,
}

/// The Kit Process Protocol features of the object model (`KitObjectModel 1.0`), listed in
/// `capabilities.features` by a kit that serves it.
pub const MODEL_FEATURES: [&str; 2] = ["model.describe", "model.batch"];

/// `capabilities` with [`MODEL_FEATURES`] added to its `features` when `serves` (each once).
pub fn with_model_features(mut capabilities: Value, serves: bool) -> Value {
    if !serves {
        return capabilities;
    }
    if let Some(object) = capabilities.as_object_mut()
        && let Some(features) = object.entry("features").or_insert_with(|| Value::Array(Vec::new())).as_array_mut()
    {
        for feature in MODEL_FEATURES {
            if !features.iter().any(|known| known == feature) {
                features.push(Value::String(feature.to_owned()));
            }
        }
    }
    capabilities
}

pub trait KitBackend: Send + 'static {
    /// `kit.<name>`, matching `kit.json`.
    fn kit_id(&self) -> &str;
    fn kit_version(&self) -> &str;
    /// Called once before serving, for backends that notify on their own (focus changes,
    /// edits made in the kit's own user interface).
    fn attach_notifier(&mut self, _notifier: Notifier) {}
    /// The `capabilities` object of `kit.initialize`.
    fn capabilities(&self) -> Value;

    /// The host, when it initializes: what the backend reads and writes files through. Documents
    /// opened through an earlier host are closed.
    fn set_host(&mut self, host: Host);
    fn set_preferences(&mut self, _locale: Option<&str>, _appearance: Option<Appearance>) {}

    fn open(&mut self, request: OpenRequest<'_>) -> Result<DocumentInfo, RpcError>;
    fn document(&mut self, id: &str) -> Result<DocumentInfo, RpcError>;
    fn documents(&mut self) -> Vec<DocumentInfo>;
    fn activate(&mut self, id: &str) -> Result<(), RpcError>;
    /// Saves to the document's own file (`target` `None`) or to the file of the handle `target`,
    /// which it then belongs to. Answers the document's state and what was written.
    fn save(&mut self, id: &str, target: Option<&str>, format: Option<&str>) -> Result<(DocumentInfo, Written), RpcError>;
    /// Writes a copy to the file of the `create` handle `target`; the document keeps its own file.
    fn export(&mut self, id: &str, target: &str, format: &str, options: Option<&Map<String, Value>>) -> Result<Written, RpcError>;
    fn close(&mut self, id: &str, discard_changes: bool) -> Result<(), RpcError>;

    fn commands(&mut self, id: Option<&str>) -> Result<Vec<CommandSummary>, RpcError>;
    /// What `command.list` answers on an agent's connection: [`KitBackend::commands`] less what
    /// the kit keeps from the agent (its manifest's `agent.include` and `agent.exclude`).
    fn agent_commands(&mut self, id: Option<&str>) -> Result<Vec<CommandSummary>, RpcError> {
        self.commands(id)
    }
    fn execute(&mut self, id: &str, command: &str, params: Map<String, Value>, origin: Origin) -> Result<Executed, RpcError>;

    /// `commands.execute` with origin `system`: the host's change on the person's behalf, by the
    /// host feature `label` (`emailsync`). It is no undo step in any history (section 6): neither
    /// the person's nor an agent's undo takes it back. A backend that cannot keep a change out of
    /// its undo histories refuses it, as by default.
    fn execute_system(&mut self, _id: &str, _command: &str, _params: Map<String, Value>, _label: &str) -> Result<Executed, RpcError> {
        Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "this kit cannot keep a host's change out of the undo history; send origin user instead"))
    }

    /// `view.screenshot`: what `request` asks for, or an error that says what of it the kit
    /// cannot draw (a `target`, a scale it could only enlarge); never another image instead.
    fn screenshot(&mut self, id: &str, request: &ScreenshotRequest) -> Result<Screenshot, RpcError>;
    fn describe(&mut self, id: &str) -> Result<Describe, RpcError>;

    /// `document.check` (standard 2.0 A21): `{ "diagnostics": [...] }` for the document. A kit
    /// that serves it lists the feature `document.check`; by default there is no such method.
    fn check(&mut self, _id: &str) -> Result<Value, RpcError> {
        Err(RpcError::new(RpcError::METHOD_NOT_FOUND, "method not found: document.check"))
    }

    /// `file.text` (`KitText 1.0`): the document's words, at most `limit` Unicode scalar
    /// values, as `{ text, truncated, parts? }`. Read-only. A kit that serves it lists the
    /// capability `document-text`; by default there is no such method.
    fn text(&mut self, _id: &str, _limit: u64) -> Result<Value, RpcError> {
        Err(RpcError::new(RpcError::METHOD_NOT_FOUND, "method not found: file.text"))
    }

    /// `model.*` methods, the object model (`KitObjectModel 1.0`): `model.describe` and
    /// `model.batch`, each with the `documentId`. A kit without an object model has none.
    fn model(&mut self, method: &str, _params: Value) -> Result<Value, RpcError> {
        Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("method not found: {method}")))
    }

    /// Whether the backend serves `model.*`; `kit.initialize` then lists [`MODEL_FEATURES`] in
    /// `capabilities.features`. By default, whether `model.describe` without a document answers
    /// anything but method-not-found (such a request names no document, so it changes nothing).
    fn serves_model(&mut self) -> bool {
        !matches!(self.model("model.describe", Value::Object(Map::new())), Err(error) if error.code == RpcError::METHOD_NOT_FOUND)
    }

    /// `context.get` (section 7a): the document's editor state (its selection, current part,
    /// current time), opaque to the client, which hands it back to `context.restore`; `Null` for
    /// a kit that keeps none. A kit without the editor-state hooks has no such method.
    fn context_get(&mut self, _id: &str) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.get"))
    }

    /// `context.set`: sets the editor state one call acts in and on (`on`, the ids of the objects;
    /// `part`, as a run's `target` names it; `time`, in seconds), each only when given. It is no
    /// edit: the document stays as it was, not dirty, and nothing joins an undo history.
    fn context_set(&mut self, _id: &str, _context: &Map<String, Value>) -> Result<(), RpcError> {
        Err(RpcError::method_not_found("context.set"))
    }

    /// `context.restore`: puts back what `context.get` answered; no edit either.
    fn context_restore(&mut self, _id: &str, _state: &Value) -> Result<(), RpcError> {
        Err(RpcError::method_not_found("context.restore"))
    }

    /// `context.under`: what a command (`command`, with `params`) names by its place at the call's
    /// `part` and `time`: `{ objects, within? }`, the objects under that place now and the windows of
    /// the lists they are in. No edit: the editor state is as it was after it. A kit that cannot
    /// say has no such method.
    fn context_under(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.under"))
    }

    /// Isolated, bounded run planning and reads of its scratch state.
    fn context_plan(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.plan"))
    }

    /// `context.covered`: whether each object of `objects` (`{ id, before, deleted?,
    /// unknown? }`) was under the place a command names (`command`, `params`, at the call's `part`
    /// and `time`) with its values at the agent's basis: `{ covered: [{ id, covered }] }`. No edit.
    /// A kit that cannot say has no such method.
    fn context_covered(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.covered"))
    }
    /// Whether a declared content region changed at this guarded call's basis.
    fn context_content(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.content"))
    }

    fn context_identity(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.identity"))
    }
    fn context_inputs(&mut self, _id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        Err(RpcError::method_not_found("context.inputs"))
    }

    /// How the kit's files carry their document's identity, for `document.identity` and
    /// `document.fork` (section 5.6): [`FileIdentity::NotEmbedded`] for a kit whose files embed no
    /// replica, [`FileIdentity::Embedded`] with where its container keeps one. `kit.initialize`
    /// then lists the feature `document.identity`. By default the kit says nothing, lists no
    /// feature and answers both "method not found": a kit whose files embed a replica must not
    /// claim they carry no identity.
    fn file_identity(&self) -> Option<FileIdentity> {
        None
    }

    /// The host saw the file change on disk. Returns the new state when it changed: reloaded when
    /// the document had no unsaved edits, else in conflict (section 5).
    fn did_change_on_disk(&mut self, _id: &str) -> Option<DocumentInfo> {
        None
    }

    /// `document.reload`: reads the document's file again, dropping its unsaved edits.
    fn reload(&mut self, _id: &str) -> Result<DocumentInfo, RpcError> {
        Err(RpcError::method_not_found("document.reload"))
    }

    /// Called once before the process exits after `kit.shutdown`. Documents close unsaved.
    fn shutdown(&mut self) {}
}
