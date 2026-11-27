//! # kition-headless
//!
//! Serves any [`KitDocument`] as a headless kit over the Kit Process Protocol (`kition-kit-server`), so a
//! kit built on the Kition SDK gets its agent executable from the same code its in-page editor
//! runs. A kit's binary is a few lines; what the host is told comes from the kit's own `kit.json`:
//!
//! ```ignore
//! fn main() -> std::process::ExitCode {
//!     kition_headless::run_manifest::<VectorDocument>(include_str!("../../../kit.json"), &[], &[])
//! }
//! ```
//!
//! Files (Kit Process Protocol, section 5): the kit touches no file itself. It opens and
//! saves a document through the host's `storage.*` on the handle the host gave it, and a save
//! commits with the version it read, so a file someone changed meanwhile is a conflict, never
//! overwritten. The files a document refers to are lent through [`kition_kit::host`]: the binding
//! asks the host to resolve each path (`storage.resolve`) and reads it by handle. Engines that reach
//! the file system on their own must not be able to through the agent, so commands whose
//! parameters name a file or folder are refused and left unlisted, unless the kit lists them as
//! `sandboxed` (its I/O is in memory or through lent files).
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod agent_ready;
mod folder;

#[cfg(test)]
mod test_support;

pub use folder::HostFolder;
pub use kition_kit_server::{EmbeddedReplica, FileIdentity};

use std::collections::HashMap;
use std::marker::PhantomData;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit::dispatch::{self, Gate, Refusal, RefusalCode, Role};
use kition_kit::session::KitSessionDocument;
use kition_kit::session::model::{self, Exchange, ModelError, ModelErrorCode, ReplicaPort};
use kition_kit::{KitCommand, KitDocument};
use kition_kit_server::protocol::methods::FilesResolve;
use kition_kit_server::protocol::{ErrorData, FileKind, FilesResolveParams, Origin, base64};
use kition_kit_server::{
    CommandSummary, Describe, DocumentInfo, ErrorReason, Executed, Host, KitBackend, LaunchConfig, OpenRequest, RpcError, Screenshot, ScreenshotRequest,
    Written, serve,
};
use serde_json::{Map, Value, json};

struct HistoricalReader {
    host: Option<Host>,
    token: Option<String>,
}
impl kition_kit::HistoricalBlobs for HistoricalReader {
    fn read(&self, hash: &str, offset: usize, length: usize) -> Result<Vec<u8>, String> {
        let host = self.host.as_ref().ok_or("unsupported")?;
        let token = self.token.as_ref().ok_or("unsupported")?;
        let result = host
            .request::<kition_kit_server::protocol::methods::HistoryBlobRead>(&kition_kit_server::protocol::HistoryBlobReadParams {
                token: token.clone(),
                hash: hash.to_owned(),
                offset,
                length,
            })
            .map_err(|error| error.to_string())?;
        if result["available"] != true {
            return Err(result["reason"].as_str().unwrap_or("unavailable").to_owned());
        }
        base64::decode(result["data"].as_str().ok_or("missing data")?).ok_or_else(|| "invalid base64".to_owned())
    }
}

/// What the host is told about the kit.
#[derive(Clone, Debug, Default)]
pub struct KitInfo {
    /// `kit.<name>`, matching `kit.json`.
    pub id: String,
    pub version: String,
    /// `(format id, extensions)` the kit opens and saves, the native format first.
    pub formats: Vec<(String, Vec<String>)>,
    /// The formats it saves: those the manifest gives the `edit` role (a kit may edit more than
    /// its native format, as Slide edits `.pptx` beside `.kslide`).
    pub saves: Vec<String>,
    /// The extensions it exports to (`kit.json` `exports`), written as new files by
    /// `file.export` through [`KitDocument::export`].
    pub exports: Vec<String>,
    /// Commands whose file parameters are safe: the engine reads them through lent files or
    /// writes them to memory.
    pub sandboxed: Vec<String>,
    /// The kit's editor state in `inspect()`: what describes the editing session, not the file
    /// (the selection, the current part or time, the playhead, the tool). `view.describe` leaves
    /// it out, so it reports only what survives saving and reopening. A name (`selection`) is left
    /// out wherever it is; a JSON Pointer (`/time`) only at that place, so a document field of the
    /// same name elsewhere (a keyframe's `time`) stays. Beyond these, only the session's
    /// bookkeeping at the top (`canUndo`, `dirty`, `revision`, `path`, …) is left out; nothing is
    /// taken for editor state by its name alone. `kit.json` publishes the same list to hosts as
    /// `engine.editorState` (platform K23); [`KitInfo::from_manifest`] refuses a manifest whose
    /// list is another.
    pub volatile: Vec<String>,
    /// The platform capabilities of the executable (`kit.json` `headless.capabilities`), which
    /// `kit.initialize` answers in `capabilities.capabilities`. With
    /// [`kition_kit::text::CAPABILITY`] the kit serves `file.text` through
    /// [`KitDocument::text`].
    pub capabilities: Vec<String>,
    /// The commands the manifest offers the agent (`agent.include`, `*` matching any run of
    /// characters); `None` offers every command the other rules let through.
    pub agent_include: Option<Vec<String>>,
    /// The commands the manifest keeps from the agent (`agent.exclude`, the same patterns).
    pub agent_exclude: Vec<String>,
}

impl KitInfo {
    /// The kit as its Kit Harness Protocol (KHP) manifest (`kit.json`) declares it: id, version, and
    /// formats, the `edit` formats first (the first is the native one), then those it reads.
    /// `volatile` is the engine's editor-state list; a manifest that declares
    /// `engine.editorState` must declare exactly it (platform K23).
    pub fn from_manifest(manifest: &str, sandboxed: &[&str], volatile: &[&str]) -> Result<Self, String> {
        let manifest: Value = serde_json::from_str(manifest).map_err(|error| format!("kit.json: {error}"))?;
        let text = |key: &str| manifest[key].as_str().map(str::to_owned).ok_or_else(|| format!("kit.json has no `{key}`"));
        let mut formats: Vec<(String, Vec<String>, bool)> = manifest["formats"]
            .as_array()
            .ok_or("kit.json has no `formats`")?
            .iter()
            .filter_map(|format| {
                let id = format["id"].as_str()?.to_owned();
                let extensions = format["extensions"].as_array()?.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect();
                Some((id, extensions, format["role"] == "edit"))
            })
            .collect();
        formats.sort_by_key(|(_, _, edit)| !*edit);
        if !formats.first().is_some_and(|(_, _, edit)| *edit) {
            return Err("kit.json declares no `edit` format".into());
        }
        // The editor state the manifest publishes to hosts (platform K23) is the engine's list.
        if let Some(declared) = manifest["engine"].get("editorState") {
            let declared: Vec<&str> = declared.as_array().map(|keys| keys.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            if declared != volatile {
                return Err(format!(
                    "kit.json declares the editor state {declared:?} (`engine.editorState`), but the engine gives {volatile:?}: they are one list, in the same order (platform K23)"
                ));
            }
        }
        Ok(Self {
            id: text("id")?,
            version: text("version")?,
            saves: formats.iter().filter(|(_, _, edit)| *edit).map(|(id, _, _)| id.clone()).collect(),
            exports: manifest["exports"]
                .as_array()
                .map(|exports| {
                    exports.iter().filter_map(|export| export["extension"].as_str().map(|e| e.trim_start_matches('.').to_ascii_lowercase())).collect()
                })
                .unwrap_or_default(),
            formats: formats.into_iter().map(|(id, extensions, _)| (id, extensions)).collect(),
            sandboxed: sandboxed.iter().map(|id| (*id).to_owned()).collect(),
            volatile: volatile.iter().map(|key| (*key).to_owned()).collect(),
            capabilities: manifest["headless"]["capabilities"]
                .as_array()
                .map(|capabilities| capabilities.iter().filter_map(|c| c.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
            agent_include: manifest["agent"]["include"].as_array().map(|patterns| strings(patterns)),
            agent_exclude: manifest["agent"]["exclude"].as_array().map(|patterns| strings(patterns)).unwrap_or_default(),
        })
    }

    fn native(&self) -> Option<&str> {
        self.formats.first().map(|(id, _)| id.as_str())
    }

    fn has(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|known| known == capability)
    }

    fn is_sandboxed(&self, command: &str) -> bool {
        self.sandboxed.iter().any(|id| id == command)
    }

    /// Whether a command is listed at all: a protocol id that names no file it may not name.
    fn listed(&self, command: &KitCommand) -> bool {
        is_protocol_id(&command.id) && (self.is_sandboxed(&command.id) || !names_files(command))
    }

    /// Whether the manifest offers `command` to the agent (`agent.include`, `agent.exclude`).
    fn offers_agent(&self, command: &str) -> bool {
        let named = |patterns: &[String]| patterns.iter().any(|pattern| dispatch::pattern_matches(pattern, command));
        self.agent_include.as_deref().is_none_or(named) && !named(&self.agent_exclude)
    }
}

fn strings(values: &[Value]) -> Vec<String> {
    values.iter().filter_map(|value| value.as_str().map(str::to_owned)).collect()
}

/// Parameter names that make a command without a schema reach the file system. A command with a
/// schema names its files by type instead (KHP A28, [`kition_kit::schema::file_params`]).
const FILE_PARAMS: &[&str] = &["path", "paths", "folder", "dir", "directory", "output", "outputDir", "file", "files", "target"];

/// The largest screenshot side.
const MAX_SCREENSHOT: u32 = 4096;
/// New documents' size when `file.open` with `create` gives none.
const DEFAULT_SIZE: (u32, u32) = (1920, 1080);

struct Open<D> {
    id: u64,
    doc: D,
    /// The file's display name (a last segment): it names the format and the title.
    name: String,
    /// The handle of the document's file. A replica opened with `model.open` (a draft, a server's
    /// room) has none until it is saved to a target: it is never found by a file's handle, and
    /// never writes one, so it can never stand in for the file (KHP A12).
    file: Option<String>,
    read_only: bool,
    /// Created by `file.open` with `create` and not saved yet.
    unsaved: bool,
    /// The file's version as last read or written here: a save replaces only this version.
    version: Option<String>,
    /// The file changed since `version` while the document has unsaved edits (Kit Process Protocol section 5).
    conflict: bool,
    /// The object model's scratch replica, for documents served through their [`ReplicaPort`].
    exchange: Exchange,
}

struct Planned<D> {
    document: String,
    doc: D,
    exchange: Exchange,
    step: usize,
    changes: Value,
    before_state: Value,
    before: kition_kit::kdm::Version,
    before_document: kition_kit::kdm::DocId,
    before_model: Value,
    refs: Map<String, Value>,
    operations: usize,
    bytes: usize,
}

/// How a [`Headless`] serves the object model (`model.describe`, `model.batch`) and the replica
/// methods (`model.open`, `model.import`, `model.export`, `model.save`) for `D`.
struct ModelHooks<D> {
    describe: fn(&mut D, &mut Exchange) -> Result<Value, ModelError>,
    batch: fn(&mut D, &mut Exchange, &Value, bool) -> Result<Value, ModelError>,
    /// The document's replica as the object model reads it: what `model.version` and
    /// `model.changes` answer from.
    replica: for<'a> fn(&'a mut D, &'a mut Exchange) -> Result<&'a kition_kit::kdm::Replica, ModelError>,
    /// [`ReplicaPort::model_open_replica`]; `None` when `D` has no way to open a replica.
    open: Option<OpenReplica<D>>,
    import: fn(&mut D, &[u8]) -> Result<(), String>,
    export: fn(&mut D, &[u8]) -> Result<Vec<u8>, String>,
    /// [`ReplicaPort::model_add_blobs`] and [`ReplicaPort::model_blobs_since`]: the media that
    /// `model.import` takes and `model.export` answers beside the changes (`blobs`).
    add_blobs: fn(&mut D, &[u8]) -> Result<(), String>,
    blobs_since: fn(&mut D, &[u8]) -> Result<Vec<u8>, String>,
}

/// Opens a document from a replica: name, snapshot, blobs.
type OpenReplica<D> = fn(&str, &[u8], &[u8]) -> Result<D, String>;

/// The Kit Process Protocol features of the replica methods, listed beside [`kition_kit_server::MODEL_FEATURES`]
/// by a kit whose documents open from a replica: what a server's headless kit pool needs to render
/// previews, export, validate changes, and run batches on a sync room's state.
pub const REPLICA_FEATURES: [&str; 4] = ["model.open", "model.import", "model.export", "model.save"];

/// `model.changes`: what changed in `replica` since `since` (a receipt, KDM
/// `Replica::changes_since`) and its version now; `changes` is `null` with `unavailable` when its
/// history does not hold `since` (the document was reloaded or replaced since), never an empty
/// change set that would read as "nothing changed".
fn changes_answer(replica: &kition_kit::kdm::Replica, since: &kition_kit::kdm::Version) -> Value {
    let version = base64::encode(&replica.version().encode());
    match replica.changes_since(since) {
        Ok(changes) => json!({ "changes": changes.to_recorded_json(replica.schema()), "version": version }),
        Err(error) => json!({ "changes": null, "unavailable": error.to_string(), "version": version }),
    }
}

/// An object-model failure as a protocol error: `data.model` holds `{ code, index, message }`.
fn model_error(error: &ModelError) -> RpcError {
    let reason = match error.code {
        ModelErrorCode::ReadOnly => ErrorReason::CommandDisabled,
        ModelErrorCode::NotFound | ModelErrorCode::InvalidOp | ModelErrorCode::InvalidValue | ModelErrorCode::CommandFailed => ErrorReason::InvalidParams,
    };
    let mut rpc = RpcError::kit_detail(reason, error.to_string());
    if let Some(Value::Object(data)) = rpc.data.as_mut() {
        data.insert("model".into(), error.to_json());
    }
    rpc
}

/// The headless backend for documents of type `D`.
pub struct Headless<D> {
    kit: KitInfo,
    /// The host's files, once it initialized.
    host: Option<Host>,
    /// What answers the engine's reads of lent and granted files.
    lent: Arc<Lent>,
    docs: Vec<Open<D>>,
    next: u64,
    plans: HashMap<String, Planned<D>>,
    next_plan: u64,
    model: Option<ModelHooks<D>>,
    /// Runs a command as an origin (KHP A11: an agent's edit is the agent's, for the person who
    /// started it), for engines that record who acts: contract 2 kits. `None`: contract 1, whose
    /// `execute` knows no origin.
    run_as: Option<RunAs<D>>,
    /// How the kit's files carry their document's identity (`file.identity`,
    /// `file.fork`); `None`: the kit says nothing and serves neither.
    file_identity: Option<FileIdentity>,
    _doc: PhantomData<fn() -> D>,
}

type RunAs<D> = fn(&mut D, &str, Value, &kition_kit::kdm::Origin) -> Result<Value, String>;

/// Who a command runs as: the person, an agent acting for them (KHP A11), or a host feature
/// (origin `system`, its label).
#[derive(Clone, Copy)]
enum Acting<'a> {
    Person,
    Agent,
    System(&'a str),
}

/// How kition-headless runs every document (engine contract E22): the host owns every file.
const HOSTING: kition_kit::host::Hosting = kition_kit::host::Hosting { files_only: true };

/// A document the engine just opened or created, told how the host runs it.
fn hosted<D: KitDocument>(mut doc: D) -> D {
    doc.hosted(&HOSTING);
    doc
}

/// The person a headless kit's host acts for. An agent's calls run as `agent` with this principal
/// (KHP A11), so they are recorded as the agent's and undo in the agent's scope (KitModel M12a).
pub const HOST_PERSON: &str = "person:local";

/// The engine's reads of the files a document refers to (E5) and of granted handles (E15),
/// answered by the host: a path is resolved against the document being served
/// (`storage.resolve`) and read by the handle it answers (`storage.read`).
#[derive(Default)]
struct Lent {
    host: Mutex<Option<Host>>,
    /// The handle of the document the engine is serving now.
    document: Mutex<Option<String>>,
    /// `(document handle, path)` to the handle `storage.resolve` answered.
    resolved: Mutex<HashMap<(String, String), String>>,
}

impl Lent {
    fn host(&self) -> Result<Host, String> {
        self.host.lock().unwrap_or_else(PoisonError::into_inner).clone().ok_or_else(|| "this host lends no files".to_owned())
    }

    /// The handle the host gives for `path` in the current document.
    fn handle(&self, path: &str) -> Result<String, String> {
        self.look_up(path)?.map_err(|error| refusal(path, &error))
    }

    /// [`Lent::handle`], with the host's answer as it gave it: the outer error is one the host
    /// was never asked about (no host, no document).
    fn look_up(&self, path: &str) -> Result<Result<String, RpcError>, String> {
        if kition_kit::host::is_handle(path) {
            return Ok(Ok(path.to_owned()));
        }
        let document = self.document.lock().unwrap_or_else(PoisonError::into_inner).clone().ok_or_else(|| format!("{path}: this document lends no files"))?;
        let key = (document.clone(), path.to_owned());
        if let Some(handle) = self.resolved.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return Ok(Ok(handle.clone()));
        }
        let answer = self.host()?.request::<FilesResolve>(&FilesResolveParams { document_id: None, file: Some(document), link: path.to_owned() });
        Ok(answer.map(|stat| {
            self.resolved.lock().unwrap_or_else(PoisonError::into_inner).insert(key, stat.handle.clone());
            stat.handle
        }))
    }

    /// `kition_kit::host::exists`: `false` only when the host answers `file_not_found` (Kit Process
    /// Protocol section 10), which it does only for a path that passes every check; any other
    /// error, a refusal among them, is the host's error.
    fn exists(&self, path: &str) -> Result<bool, String> {
        match self.look_up(path)? {
            Ok(_) => Ok(true),
            Err(error) if error.reason() == Some(ErrorReason::FileNotFound) => Ok(false),
            Err(error) => Err(refusal(path, &error)),
        }
    }

    fn size(&self, path: &str) -> Result<u64, String> {
        let handle = self.handle(path)?;
        let host = self.host()?;
        match host.stat(&handle).map_err(|error| refusal(path, &error))?.size {
            Some(size) => Ok(size),
            None => host.read_range(&handle, 0, 0).map(|(_, size)| size).map_err(|error| refusal(path, &error)),
        }
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let handle = self.handle(path)?;
        let host = self.host()?;
        let mut out = Vec::with_capacity(len.min(kition_kit_server::protocol::FILE_CHUNK));
        while out.len() < len {
            let (bytes, size) = host.read_range(&handle, offset + out.len() as u64, (len - out.len()) as u64).map_err(|error| refusal(path, &error))?;
            let done = bytes.is_empty() || offset + (out.len() + bytes.len()) as u64 >= size;
            out.extend(bytes);
            if done {
                break;
            }
        }
        Ok(out)
    }
}

/// A host's refusal as the engine reads it: its detail, else its message.
fn refusal(path: &str, error: &RpcError) -> String {
    let detail = error.data.as_ref().and_then(|data| data.get("detail")).and_then(Value::as_str).unwrap_or(&error.message);
    format!("{path}: {detail}")
}

/// [`Lent`] as the SDK's lender of paths and of handles.
struct Lender(Arc<Lent>);

impl kition_kit::host::LentFiles for Lender {
    fn size(&self, path: &str) -> Result<u64, String> {
        self.0.size(path)
    }

    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        self.0.read_range(path, offset, len)
    }

    fn exists(&self, path: &str) -> Result<bool, String> {
        self.0.exists(path)
    }
}

impl kition_kit::host::HandleFiles for Lender {
    fn size(&self, handle: &str) -> Result<u64, String> {
        self.0.size(handle)
    }

    fn read_range(&self, handle: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        self.0.read_range(handle, offset, len)
    }
}

/// Whether a command id fits the protocol's pattern (`group.name`, lowercase first letter).
fn is_protocol_id(id: &str) -> bool {
    let ok = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut segments = id.split('.');
    segments.next().is_some_and(|first| first.starts_with(|c: char| c.is_ascii_lowercase()) && first.chars().all(ok))
        && segments.all(|s| !s.is_empty() && s.chars().all(ok))
}

/// Whether a command's parameters, as documented or as given, name a file or folder.
fn touches_files(notation: Option<&str>, params: Option<&Map<String, Value>>) -> bool {
    let named = |key: &str| FILE_PARAMS.iter().any(|file| file.eq_ignore_ascii_case(key));
    if params.is_some_and(|params| params.keys().any(|key| named(key))) {
        return true;
    }
    let Some(notation) = notation else { return false };
    // `{path?, paths: [..], "folder":...}`: any word followed by `?`, `:` or `,` or `}`.
    let mut word = String::new();
    for c in notation.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        if !word.is_empty() && matches!(c, '?' | ':' | ',' | '}' | '"' | ' ' | '|') && named(&word) {
            return true;
        }
        word.clear();
    }
    false
}

/// Whether a command names files. With a schema, a parameter does when its schema is typed `file`
/// (KHP A28), whatever its name: `target` may be a table field and `path` a place in the document.
/// This server resolves no file parameter (A29), so such a command stays off the agent's list.
/// Without a schema, the parameter notes' names are the only guess there is.
fn names_files(command: &KitCommand) -> bool {
    match &command.schema {
        Some(schema) => !kition_kit::schema::file_params(schema).is_empty(),
        None => touches_files(command.params.as_deref(), None),
    }
}

/// What `command.execute` answers when a command names files the agent may not name.
const NAMES_FILES: &str = "commands that name files are not available to the agent; the host opens and saves documents";

/// The one gate every way a caller runs a command passes (KHP A28, A29, §10.6): `command.execute`,
/// each `command` operation of `model.batch`, and every step a kit's own batch, macro, or script
/// command dispatches through [`kition_kit::dispatch::may_run`] while either runs. It holds the
/// document's commands as they were when the call began.
struct CommandGate {
    role: Role,
    commands: Vec<KitCommand>,
    sandboxed: Vec<String>,
    agent_include: Option<Vec<String>>,
    agent_exclude: Vec<String>,
}

impl CommandGate {
    fn new(kit: &KitInfo, commands: Vec<KitCommand>, role: Role) -> Self {
        Self { role, commands, sandboxed: kit.sandboxed.clone(), agent_include: kit.agent_include.clone(), agent_exclude: kit.agent_exclude.clone() }
    }

    fn rules(&self) -> KitInfo {
        KitInfo {
            sandboxed: self.sandboxed.clone(),
            agent_include: self.agent_include.clone(),
            agent_exclude: self.agent_exclude.clone(),
            ..KitInfo::default()
        }
    }

    /// Whether this caller is offered `command`: listed (no file it may not name), and for the
    /// agent kept by the manifest's `agent.include` and `agent.exclude`.
    fn offered(&self, rules: &KitInfo, command: &KitCommand) -> bool {
        rules.listed(command) && (self.role != Role::Agent || rules.offers_agent(&command.id))
    }

    /// The part of the check that does not read parameter values: the command exists and this
    /// caller may run it. A batch checks every command operation so before anything runs.
    fn allowed(&self, command: &str, params: &Value) -> Result<&KitCommand, Refusal> {
        let rules = self.rules();
        let Some(spec) = self.commands.iter().find(|candidate| candidate.id == command) else {
            let offered: Vec<&KitCommand> = self.commands.iter().filter(|candidate| self.offered(&rules, candidate)).collect();
            return Err(Refusal::new(RefusalCode::UnknownCommand, command, unknown_command(command, &offered)));
        };
        if !rules.listed(spec) || (!rules.is_sandboxed(command) && spec.schema.is_none() && touches_files(None, params.as_object())) {
            return Err(Refusal::new(RefusalCode::NotAllowed, command, NAMES_FILES));
        }
        if self.role == Role::Agent && !rules.offers_agent(command) {
            return Err(Refusal::new(
                RefusalCode::NotAllowed,
                command,
                "the kit's manifest does not offer this command to the agent (agent.include, agent.exclude)",
            ));
        }
        Ok(spec)
    }
}

impl Gate for CommandGate {
    fn role(&self) -> Role {
        self.role
    }

    /// [`CommandGate::allowed`], then the parameters its schema states (KHP A5, A18): a key the
    /// schema does not name is refused first, in the words of `refuse_unknown`, so a misspelt
    /// required key is named rather than reported missing; a command whose top level is open
    /// (`open_params`) takes any key.
    fn check(&self, command: &str, params: &Value) -> Result<(), Refusal> {
        let spec = self.allowed(command, params)?;
        let Some(schema) = &spec.schema else { return Ok(()) };
        if !spec.open_params
            && let Err(message) = kition_kit::schema::refuse_unknown(command, schema, params)
        {
            return Err(Refusal::new(RefusalCode::InvalidParams, command, message));
        }
        let errors = kition_kit::schema::param_errors(schema, params.as_object().unwrap_or(&Map::new()));
        match errors.first() {
            Some(first) => Err(Refusal { errors: errors.clone(), ..Refusal::new(RefusalCode::InvalidParams, command, first.message.clone()) }),
            None => Ok(()),
        }
    }
}

/// A refusal of the gate as the protocol error `command.execute` answers for it, with `detail`.
fn refusal_error(refusal: &Refusal, detail: String) -> RpcError {
    match refusal.code {
        RefusalCode::UnknownCommand => RpcError::kit_detail(ErrorReason::CommandNotFound, detail),
        RefusalCode::NotAllowed => RpcError::kit_detail(ErrorReason::CommandDisabled, detail),
        RefusalCode::InvalidParams if refusal.errors.is_empty() => RpcError::kit_detail(ErrorReason::InvalidParams, detail),
        RefusalCode::InvalidParams => RpcError::kit_data(ErrorData {
            reason: ErrorReason::InvalidParams,
            detail: Some(detail),
            errors: Some(refusal.errors.iter().map(|error| serde_json::to_value(error).unwrap_or(Value::Null)).collect()),
        }),
    }
}

/// A refusal inside a command the caller may run (a step the kit's own dispatcher was refused),
/// naming the step's command.
fn nested_refusal(refusal: &Refusal) -> RpcError {
    refusal_error(refusal, format!("`{}`: {}", refusal.command, refusal.message))
}

/// A refused `command` operation of a batch: what `command.execute` answers for the command,
/// with the object model's `data.model` (`{ code, index, message }`, KHP A18 codes).
fn batch_refusal(refusal: &Refusal, index: Option<usize>) -> RpcError {
    let message = format!("`{}`: {}", refusal.command, refusal.message);
    let mut error = refusal_error(refusal, message.clone());
    if let Some(Value::Object(data)) = error.data.as_mut() {
        data.insert("model".into(), json!({ "code": refusal.code.as_str(), "index": index, "message": message }));
    }
    error
}

/// Who a batch runs for, by its `origin` (`kition_kdm::batch::parse_origin`): the agent, or else
/// the person (a person's, an extension's or a script's batch).
fn batch_role(request: &Value) -> Role {
    if request["origin"]["kind"] == "agent" { Role::Agent } else { Role::Person }
}

/// The batch's `command` operations: index, id, and parameters.
fn command_ops(request: &Value) -> Vec<(usize, String, Value)> {
    let ops = request["ops"].as_array().map(Vec::as_slice).unwrap_or_default();
    ops.iter()
        .enumerate()
        .filter(|(_, op)| op["op"] == "command")
        .filter_map(|(index, op)| Some((index, op["id"].as_str()?.to_owned(), op.get("params").cloned().unwrap_or_else(|| json!({})))))
        .collect()
}

/// A command's parameters as the JSON Schema the protocol carries: the SDK's DeepSeek Harness
/// `ParameterSchemaSpec` (name to value spec) as an object's properties, or the parameter notes
/// alone when the command has no schema. A property the spec marks `required: true` is listed in
/// `required`: one a kit wrote by hand, or one its notation requires when the kit opts in
/// (`KitCommand::notation_required`, A6a).
fn json_schema(spec: Option<&Value>, notes: Option<&str>) -> Value {
    let mut schema = json!({ "type": "object" });
    if let Some(Value::Object(properties)) = spec {
        let mut required = Vec::new();
        let converted = properties
            .iter()
            .map(|(name, value)| {
                if value.get("required") == Some(&Value::Bool(true)) {
                    required.push(Value::String(name.clone()));
                }
                (name.clone(), value_schema(value))
            })
            .collect();
        schema["properties"] = Value::Object(converted);
        if !required.is_empty() {
            schema["required"] = Value::Array(required);
        }
    }
    if let Some(notes) = notes.filter(|notes| !notes.is_empty()) {
        schema["description"] = Value::String(notes.to_owned());
    }
    schema
}

/// [`json_schema`] of a command, saying whether its top level takes keys the schema does not
/// name: a command with a schema refuses them (`run_command`) unless it says its top level is
/// open (`KitCommand::open_params`). Its target parameter (`KitCommand::targets`) is marked
/// `"x-khp-role": "targets"` and the editor state it reads (`KitCommand::reads`) is listed as
/// `"x-khp-reads"`; its place parameters (`KitCommand::places`) are marked `"x-khp-role":
/// "place"` and those naming objects by id (`KitCommand::objects`) `"x-khp-role": "object"`, a
/// position-independent command says `"x-khp-position": "independent"`, and a target
/// parameter with an index spelling (`KitCommand::index`) has `"x-khp-index"` (and `"x-khp-index-order":
/// "reversed"` when it counts from the other end, `KitCommand::index_reversed`), and one that reads
/// a number naming no object as a place (`KitCommand::index_numbers`) `"x-khp-index-numbers":
/// true` (Kit Process Protocol section 6).
fn params_schema(command: &KitCommand) -> Value {
    let mut schema = json_schema(command.schema.as_ref(), command.params.as_deref());
    if command.schema.as_ref().is_some_and(Value::is_object) {
        schema["additionalProperties"] = Value::Bool(command.open_params);
    }
    if let Some(property) =
        command.targets.and_then(|name| schema.get_mut("properties").and_then(|properties| properties.get_mut(name))).and_then(Value::as_object_mut)
    {
        property.insert(kition_kit::schema::ROLE_KEYWORD.into(), json!("targets"));
        if let Some(prefix) = command.index {
            property.insert(kition_kit::schema::INDEX_KEYWORD.into(), json!(prefix));
            if command.index_reversed {
                property.insert(kition_kit::schema::INDEX_ORDER_KEYWORD.into(), json!("reversed"));
            }
        }
        if command.index_numbers {
            property.insert(kition_kit::schema::INDEX_NUMBERS_KEYWORD.into(), json!(true));
        }
    }
    if !command.reads.is_empty() {
        schema[kition_kit::schema::READS_KEYWORD] = json!(command.reads.iter().map(|read| read.as_str()).collect::<Vec<_>>());
    }
    for (names, role) in [(command.places, kition_kit::schema::PLACE_ROLE), (command.objects, kition_kit::schema::OBJECT_ROLE)] {
        for name in names {
            if let Some(property) = nested_property(&mut schema, name) {
                property.insert(kition_kit::schema::ROLE_KEYWORD.into(), json!(role));
            }
        }
    }
    for (name, types) in command.object_types {
        if let Some(property) = nested_property(&mut schema, name) {
            property.insert(kition_kit::schema::TYPES_KEYWORD.into(), json!(types));
        }
    }
    for (name, field) in command.name_params {
        if let Some(property) = nested_property(&mut schema, name) {
            property.insert(kition_kit::schema::NAME_KEYWORD.into(), json!(field));
            property.entry(kition_kit::schema::ROLE_KEYWORD).or_insert(json!(kition_kit::schema::OBJECT_ROLE));
        }
    }
    if let Some(field) = command.name_field
        && let Some(property) =
            command.targets.and_then(|name| schema.get_mut("properties").and_then(|properties| properties.get_mut(name))).and_then(Value::as_object_mut)
    {
        property.insert(kition_kit::schema::NAME_KEYWORD.into(), json!(field));
    }
    if command.position_independent {
        schema[kition_kit::schema::POSITION_KEYWORD] = json!("independent");
    }
    schema
}

/// The JSON Schema of the parameter `path` names in `schema`: a top-level parameter (`parent`), or a
/// member nested in one (`rules[].target`: the `target` of each item of `rules`; `a.b`: the member
/// `b` of the object `a`).
fn nested_property<'a>(schema: &'a mut Value, path: &str) -> Option<&'a mut Map<String, Value>> {
    let mut at = schema;
    for segment in path.split('.') {
        let (name, items) = match segment.strip_suffix("[]") {
            Some(name) => (name, true),
            None => (segment, false),
        };
        at = at.get_mut("properties")?.get_mut(name)?;
        if items {
            at = at.get_mut("items")?;
        }
    }
    at.as_object_mut()
}

/// A DeepSeek Harness `ValueSchemaSpec` as JSON Schema: the `json` type (any value) has no JSON
/// Schema type, and `required` is a property's flag there but its parent's list here.
fn value_schema(spec: &Value) -> Value {
    let Value::Object(map) = spec else { return spec.clone() };
    let mut out = Map::new();
    let mut required = Vec::new();
    for (key, value) in map {
        match key.as_str() {
            "type" if value == "json" => {}
            // A file parameter is a workspace-relative path string in JSON Schema (KHP A29).
            "type" if value == "file" => {
                out.insert(key.clone(), json!("string"));
                let file: Map<String, Value> =
                    ["access", "accept", "kind"].into_iter().filter_map(|name| map.get(name).map(|value| (name.to_owned(), value.clone()))).collect();
                out.insert("x-khp-file".into(), Value::Object(file));
            }
            "access" | "accept" | "kind" if map.get("type") == Some(&json!("file")) => {}
            // The kit's review that a string carries no path (KHP A28) is not JSON Schema.
            "notFile" => {}
            "required" if value.is_boolean() => {}
            "items" => {
                out.insert(key.clone(), value_schema(value));
            }
            "oneOf" => {
                out.insert(key.clone(), Value::Array(value.as_array().map(|all| all.iter().map(value_schema).collect()).unwrap_or_default()));
            }
            "properties" => {
                let properties = value.as_object().map(|all| {
                    all.iter()
                        .map(|(name, inner)| {
                            if inner.get("required") == Some(&Value::Bool(true)) {
                                required.push(Value::String(name.clone()));
                            }
                            (name.clone(), value_schema(inner))
                        })
                        .collect()
                });
                out.insert(key.clone(), Value::Object(properties.unwrap_or_default()));
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    if !required.is_empty() {
        out.insert("required".into(), Value::Array(required));
    }
    Value::Object(out)
}

/// An optional base64 parameter, decoded.
fn base64_param(params: &Value, key: &str) -> Result<Option<Vec<u8>>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => base64::decode(text).map(Some).ok_or_else(|| RpcError::invalid_params(format!("`{key}` is not base64"))),
        Some(_) => Err(RpcError::invalid_params(format!("`{key}` is a base64 string"))),
    }
}

/// An engine's error message as a protocol error.
/// `CommandNotFound`'s detail, at most three ids: the commands with a keyword holding every word
/// of the id first (`layer.delete` finds the command whose keywords say "delete layers"), then the
/// closest listed ids by edit distance and the commands whose title holds a word of the id (KHP
/// A18).
fn unknown_command(command: &str, offered: &[&KitCommand]) -> String {
    let wanted = command.to_ascii_lowercase();
    let words: Vec<&str> = wanted.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| word.len() >= 3).collect();
    let mut picks: Vec<&str> = offered
        .iter()
        .filter(|candidate| !words.is_empty() && candidate.keywords.iter().any(|keyword| words.iter().all(|word| keyword.to_ascii_lowercase().contains(word))))
        .map(|candidate| candidate.id.as_str())
        .take(3)
        .collect();
    let mut scored: Vec<(usize, &str)> =
        offered.iter().map(|candidate| (edit_distance(&wanted, &candidate.id.to_ascii_lowercase()), candidate.id.as_str())).collect();
    scored.sort_unstable();
    let limit = wanted.len().max(4) / 2;
    for (_, id) in scored.iter().filter(|(distance, _)| *distance <= limit) {
        if picks.len() >= 3 {
            break;
        }
        if !picks.contains(id) {
            picks.push(id);
        }
    }
    for candidate in offered {
        if picks.len() >= 3 {
            break;
        }
        let title = candidate.title.to_ascii_lowercase();
        if !picks.contains(&candidate.id.as_str()) && words.iter().any(|word| title.contains(word)) {
            picks.push(&candidate.id);
        }
    }
    if picks.is_empty() {
        format!("no command `{command}`; search the kit's commands for the right id")
    } else {
        format!("no command `{command}`; did you mean {}?", picks.iter().map(|id| format!("`{id}`")).collect::<Vec<_>>().join(", "))
    }
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row.first().copied().unwrap_or(0);
        if let Some(first) = row.first_mut() {
            *first = i + 1;
        }
        for (j, cb) in b.iter().enumerate() {
            let above = row.get(j + 1).copied().unwrap_or(0);
            let left = row.get(j).copied().unwrap_or(0);
            let cost = usize::from(ca != *cb);
            let value = (previous + cost).min(above + 1).min(left + 1);
            previous = above;
            if let Some(cell) = row.get_mut(j + 1) {
                *cell = value;
            }
        }
    }
    row.last().copied().unwrap_or(0)
}

/// The error of a command that did not run: the reason the kit gave (`kition_kit::failure`), else
/// its refusal of the call's parameters (`kition_kit::schema::refusal`); only a message that
/// carries neither is read by its wording.
fn command_error(message: String) -> RpcError {
    if let Some((text, reason)) = kition_kit::failure::parse_failure(&message) {
        let reason = match reason {
            kition_kit::failure::CommandFailure::NotFound => ErrorReason::CommandNotFound,
            kition_kit::failure::CommandFailure::Disabled => ErrorReason::CommandDisabled,
            kition_kit::failure::CommandFailure::InvalidParams => ErrorReason::InvalidParams,
        };
        return RpcError::kit_detail(reason, text);
    }
    // An engine's refusal of the call's parameters (`kition_kit::schema::refusal`).
    if let Some((detail, errors)) = kition_kit::schema::parse_refusal(&message) {
        return RpcError::kit_data(ErrorData {
            reason: ErrorReason::InvalidParams,
            detail: Some(detail.to_owned()),
            errors: Some(errors.iter().map(|error| serde_json::to_value(error).unwrap_or(Value::Null)).collect()),
        });
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("unknown command") || lower.contains("no such command") {
        RpcError::kit_detail(ErrorReason::CommandNotFound, message)
    } else if lower.contains("disabled") || lower.contains("not enabled") || lower.contains("not available") {
        RpcError::kit_detail(ErrorReason::CommandDisabled, message)
    } else {
        RpcError::kit_detail(ErrorReason::InvalidParams, message)
    }
}

/// RGBA8 as a PNG.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, RpcError> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| RpcError::internal(error.to_string()))?;
        writer.write_image_data(rgba).map_err(|error| RpcError::internal(error.to_string()))?;
    }
    Ok(out)
}

impl<D: KitDocument + Send + 'static> Headless<D> {
    pub fn new(kit: KitInfo) -> Self {
        Self {
            kit,
            host: None,
            lent: Arc::default(),
            docs: Vec::new(),
            next: 1,
            plans: HashMap::new(),
            next_plan: 0,
            model: None,
            run_as: None,
            file_identity: None,
            _doc: PhantomData,
        }
    }

    /// Serves `file.identity` and `file.fork` (Kit Process Protocol section 5.6):
    /// [`FileIdentity::NotEmbedded`] for a kit whose files embed no replica,
    /// [`FileIdentity::Embedded`] with where its container keeps one.
    pub fn with_file_identity(mut self, identity: FileIdentity) -> Self {
        self.file_identity = Some(identity);
        self
    }

    fn host(&self) -> Result<Host, RpcError> {
        self.host.clone().ok_or_else(|| RpcError::kit_detail(ErrorReason::FileNotGranted, "the host serves no files"))
    }

    /// The export formats the manifest declares and the engine writes ([`KitDocument::exports`]).
    fn exports(&self) -> Vec<String> {
        let engine = D::exports();
        self.kit.exports.iter().filter(|format| engine.contains(&format.as_str())).cloned().collect()
    }

    fn format_of(&self, name: &str) -> Option<&str> {
        let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
        self.kit.formats.iter().find(|(_, extensions)| extensions.contains(&extension)).map(|(id, _)| id.as_str())
    }

    /// `model.derived`: the derived values `names` of the objects `ids`
    /// ([`kition_kit::KitDocument::derived`]), computed now; nothing changes.
    fn model_derived(&self, params: &Value) -> Result<Value, RpcError> {
        let id = params.get("documentId").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))?;
        let index = self.position(id)?;
        let ids: Vec<Value> = params.get("ids").and_then(Value::as_array).cloned().unwrap_or_default();
        let names: Vec<String> = params.get("names").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let objects = open.doc.derived(&ids, &names).map_err(RpcError::invalid_params)?;
        Ok(json!({ "objects": objects }))
    }

    /// `model.carried`: what the changes of the objects `ids` carry with them
    /// ([`kition_kit::KitDocument::carried`]), read now; nothing changes.
    fn model_carried(&self, params: &Value) -> Result<Value, RpcError> {
        let id = params.get("documentId").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))?;
        let index = self.position(id)?;
        let ids: Vec<Value> = params.get("ids").and_then(Value::as_array).cloned().unwrap_or_default();
        let changes = params.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let objects = open.doc.carried(&ids, &changes).map_err(RpcError::invalid_params)?;
        Ok(json!({ "objects": objects }))
    }

    fn position(&self, id: &str) -> Result<usize, RpcError> {
        let id: u64 = id.parse().map_err(|_| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.docs.iter().position(|open| open.id == id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))
    }

    /// Points the lent files at the document of handle `file` before the engine reads any, and
    /// says the host owns every file ([`kition_kit::host::Hosting`], engine contract E22).
    fn lend_for(&self, file: Option<&str>) {
        kition_kit::host::set_hosting(HOSTING);
        *self.lent.document.lock().unwrap_or_else(PoisonError::into_inner) = file.map(str::to_owned);
        kition_kit::host::set_root(None);
        kition_kit::host::set_lender(Some(Box::new(Lender(Arc::clone(&self.lent)))));
        kition_kit::host::set_handles(Some(Box::new(Lender(Arc::clone(&self.lent)))));
    }

    fn info(&self, index: usize) -> Result<DocumentInfo, RpcError> {
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let inspected = open.doc.inspect().unwrap_or(Value::Null);
        Ok(DocumentInfo {
            id: open.id.to_string(),
            name: open.name.clone(),
            title: open.name.clone(),
            format: self.format_of(&open.name).or(self.kit.native()).unwrap_or_default().to_owned(),
            read_only: open.read_only,
            dirty: open.doc.dirty() || open.unsaved,
            can_undo: inspected["canUndo"] == true,
            can_redo: inspected["canRedo"] == true,
            conflict: open.conflict,
        })
    }

    /// The document in the file of handle `file`, read through the host, and the version read.
    fn read(&self, file: &str, name: &str) -> Result<(D, String), RpcError> {
        let read = self.host()?.read(file)?;
        self.lend_for(Some(file));
        let doc = D::open(name, &read.bytes).map(hosted).map_err(|message| RpcError::kit_detail(ErrorReason::UnsupportedFormat, message))?;
        Ok((doc, read.version))
    }

    /// `model.open`: a document from a replica (`snapshot`, `blobs`, base64), with no file. It is
    /// named `name` (a file name in one of the kit's formats) and is never written unless saved.
    fn open_replica(&mut self, open: OpenReplica<D>, params: &Value) -> Result<Value, RpcError> {
        let name = params.get("name").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`name` is the document's file name"))?;
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(RpcError::invalid_params("`name` is a plain file name"));
        }
        if self.format_of(name).is_none() {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        let snapshot = base64_param(params, "snapshot")?.ok_or_else(|| RpcError::invalid_params("`snapshot` is a base64 KDM snapshot"))?;
        let blobs = base64_param(params, "blobs")?.unwrap_or_default();
        self.lend_for(None);
        let doc = open(name, &snapshot, &blobs).map(hosted).map_err(|message| RpcError::kit_detail(ErrorReason::UnsupportedFormat, message))?;
        let id = self.next;
        self.next += 1;
        let read_only = params.get("readOnly") == Some(&Value::Bool(true));
        self.docs.push(Open {
            id,
            doc,
            name: name.to_owned(),
            file: None,
            read_only,
            unsaved: true,
            version: None,
            conflict: false,
            exchange: Exchange::new(),
        });
        let info = self.info(self.docs.len() - 1)?;
        Ok(json!({ "documentId": info.id, "title": info.title, "format": info.format, "readOnly": info.read_only }))
    }

    /// `model.save`: the document as file bytes in `format` (the native one by default), without
    /// writing a file; the document stays unsaved.
    fn save_bytes(&mut self, index: usize, format: Option<&str>) -> Result<Value, RpcError> {
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let format = format.or_else(|| self.format_of(&open.name)).or(self.kit.native()).unwrap_or_default().to_owned();
        if !self.kit.saves.contains(&format) {
            return Err(RpcError::kit_detail(ErrorReason::UnsupportedFormat, format!("{} saves {} files", self.kit.id, self.kit.saves.join(", "))));
        }
        let extension = self.kit.formats.iter().find(|(id, _)| *id == format).and_then(|(_, extensions)| extensions.first()).cloned().unwrap_or_default();
        let stem = open.name.rsplit_once('.').map_or(open.name.as_str(), |(stem, _)| stem);
        let name = format!("{stem}.{extension}");
        self.lend_for(open.file.as_deref());
        let bytes = open.doc.save(Some(&name)).map_err(|message| RpcError::kit_detail(ErrorReason::IoError, message))?;
        Ok(json!({ "data": base64::encode(&bytes), "format": format, "name": name }))
    }

    /// Runs `command` on document `id` as `acting`, after the checks every caller gets
    /// ([`CommandGate`]): the command is listed, names no file it may not, is offered to the agent
    /// when the agent runs it, and has the parameters its schema states. The gate holds for what
    /// the engine dispatches while it runs ([`kition_kit::dispatch::may_run`]).
    fn run_command(&mut self, id: &str, command: &str, params: Map<String, Value>, acting: Acting<'_>) -> Result<Executed, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let role = match acting {
            Acting::Person => Role::Person,
            Acting::Agent => Role::Agent,
            Acting::System(_) => Role::System,
        };
        let gate = CommandGate::new(&self.kit, open.doc.commands(), role);
        let params = Value::Object(params);
        gate.check(command, &params).map_err(|refusal| refusal_error(&refusal, refusal.message.clone()))?;
        if gate.allowed(command, &params).is_ok_and(|spec| spec.mutates) && open.read_only {
            return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "the document is read-only"));
        }
        if matches!(acting, Acting::System(_)) && self.run_as.is_none() {
            return Err(RpcError::kit_detail(
                ErrorReason::CommandDisabled,
                "this kit cannot keep a host's change out of the undo history; send origin user instead",
            ));
        }
        self.lend_for(open.file.as_deref());
        let run_as = self.run_as;
        let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let before = open.doc.revision();
        let result = dispatch::with_gate(Arc::new(gate), || match (acting, run_as) {
            (Acting::Agent, Some(run_as)) => run_as(&mut open.doc, command, params, &kition_kit::kdm::Origin::agent(HOST_PERSON)),
            // A host's change is no undo step in any history (Kit Process Protocol section 6, KitModel M12a).
            (Acting::System(label), Some(run_as)) => run_as(&mut open.doc, command, params, &kition_kit::kdm::Origin::system(label)),
            _ => open.doc.execute(command, params),
        })
        .map_err(|message| match dispatch::take_refusal() {
            Some(refusal) => nested_refusal(&refusal),
            None => command_error(message),
        })?;
        if result["closed"] == true {
            self.docs.remove(index);
            return Ok(Executed { changed: false, result: Some(result) });
        }
        let changed = open.doc.revision() != before;
        let result = self.reply(id, result)?;
        Ok(Executed { changed, result: (!result.is_null()).then_some(result) })
    }

    /// Runs an editor-state hook (`hook`) on document `id`, which must leave the document as it was:
    /// a hook that moves its revision or dirty state broke the contract (`KitDocument::set_context`)
    /// and is answered as the kit's internal error, so it is never taken for an edit.
    fn unchanged(&mut self, id: &str, hook: &str, call: impl FnOnce(&mut D) -> Result<(), String>) -> Result<(), RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let (revision, dirty) = (open.doc.revision(), open.doc.dirty());
        call(&mut open.doc).map_err(command_error)?;
        if open.doc.revision() != revision || open.doc.dirty() != dirty {
            return Err(RpcError::internal(format!("the kit's {hook} changed the document; setting editor state must not be an edit")));
        }
        Ok(())
    }

    /// The commands listed on document `id` (a new one's without), for the agent when `agent`.
    fn summaries(&mut self, id: Option<&str>, agent: bool) -> Result<Vec<CommandSummary>, RpcError> {
        // Without a document, the commands of a new one: what the kit can do at all.
        let scratch;
        let (doc, read_only) = match id {
            Some(id) => {
                let open = self.docs.get(self.position(id)?).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                self.lend_for(open.file.as_deref());
                (&open.doc, open.read_only)
            }
            None => {
                self.lend_for(None);
                scratch = D::create("untitled", 64, 64).map(hosted).map_err(RpcError::internal)?;
                (&scratch, false)
            }
        };
        Ok(doc
            .commands()
            .into_iter()
            .filter(|command| if agent { self.offered_to_agent(command) } else { self.listed(command) })
            .map(|command| CommandSummary {
                group: command.id.split('.').next().unwrap_or_default().to_owned(),
                params: params_schema(&command),
                output: command.output_schema.as_ref().map(value_schema),
                description: (!command.description.is_empty()).then(|| command.description.clone()),
                enabled: command.enabled && !(read_only && command.mutates),
                mutates: command.mutates,
                menu: command.menu.clone().unwrap_or_default(),
                shortcut: command.shortcut.clone(),
                keywords: command.keywords.clone(),
                title: command.title,
                id: command.id,
            })
            .collect())
    }

    fn listed(&self, command: &KitCommand) -> bool {
        self.kit.listed(command)
    }

    /// Whether the agent is offered `command`: listed, and kept by `agent.include` and
    /// `agent.exclude`.
    fn offered_to_agent(&self, command: &KitCommand) -> bool {
        self.kit.listed(command) && self.kit.offers_agent(&command.id)
    }

    fn reply(&mut self, id: &str, value: Value) -> Result<Value, RpcError> {
        let Some(model) = &self.model else { return Ok(value) };
        let read = model.replica;
        let index = self.position(id)?;
        let open = &mut self.docs[index];
        let replica = read(&mut open.doc, &mut open.exchange).map_err(|error| model_error(&error))?;
        Ok(kition_kit::kdm::tool_ids::ToolIds::show_reply(replica, &value))
    }
}

impl<D: KitDocument + ReplicaPort + Send + 'static> Headless<D> {
    /// Serves the object model through the engine's change exchange ([`Exchange`]): any contract 2
    /// engine, with no object model of its own.
    pub fn with_replica_port(kit: KitInfo) -> Self {
        let mut headless = Self::new(kit);
        headless.model = Some(ModelHooks {
            describe: |doc, exchange| exchange.describe(doc),
            batch: |doc, exchange, request, read_only| exchange.batch(doc, request, read_only),
            replica: |doc, exchange| exchange.replica(doc),
            open: Some(D::model_open_replica),
            import: |doc, bytes| doc.model_import(bytes),
            export: |doc, since| doc.model_export(since),
            add_blobs: |doc, blobs| doc.model_add_blobs(blobs),
            blobs_since: |doc, since| doc.model_blobs_since(since),
        });
        headless.run_as = Some(|doc, command, params, origin| doc.model_command(command, params, origin));
        headless
    }
}

impl<D: KitSessionDocument + Send + 'static> Headless<D> {
    /// Serves the object model on the document's own session: a batch is one undo step.
    pub fn with_session_model(kit: KitInfo) -> Self {
        let mut headless = Self::new(kit);
        headless.model = Some(ModelHooks {
            describe: |doc, _| Ok(model::session_describe(doc)),
            batch: |doc, _, request, read_only| model::session_batch(doc, request, read_only),
            replica: |doc, _| Ok(doc.session().replica()),
            open: None,
            import: |doc, bytes| KitSessionDocument::import_changes(doc, bytes).map(|_| ()),
            export: |doc, since| kition_kit::session::__export_changes(doc, since),
            add_blobs: |_, blobs| if blobs.is_empty() { Ok(()) } else { Err("this kit's changes carry no blobs".into()) },
            blobs_since: |_, _| Ok(Vec::new()),
        });
        headless.run_as = Some(|doc, command, params, origin| KitSessionDocument::execute_as(doc, command, params, origin));
        headless
    }
}

impl<D: KitDocument + Send + 'static> KitBackend for Headless<D> {
    fn kit_id(&self) -> &str {
        &self.kit.id
    }

    fn kit_version(&self) -> &str {
        &self.kit.version
    }

    fn file_identity(&self) -> Option<FileIdentity> {
        self.file_identity.clone()
    }

    fn capabilities(&self) -> Value {
        let formats: Vec<&str> = self.kit.formats.iter().map(|(id, _)| id.as_str()).collect();
        let mut features = vec!["view.describe", "file.check"];
        if self.model.as_ref().is_some_and(|hooks| hooks.open.is_some()) {
            features.extend(REPLICA_FEATURES);
        }
        let mut capabilities = json!({
            "surfaces": ["headless"],
            "formats": { "open": formats, "save": self.kit.native().map(|native| vec![native]).unwrap_or_default(), "export": self.exports() },
            "features": features,
        });
        if !self.kit.capabilities.is_empty() {
            capabilities["capabilities"] = json!(self.kit.capabilities);
        }
        capabilities
    }

    fn set_host(&mut self, host: Host) {
        self.docs.clear();
        *self.lent.host.lock().unwrap_or_else(PoisonError::into_inner) = Some(host.clone());
        self.lent.resolved.lock().unwrap_or_else(PoisonError::into_inner).clear();
        self.host = Some(host);
    }

    fn open(&mut self, request: OpenRequest<'_>) -> Result<DocumentInfo, RpcError> {
        let host = self.host()?;
        let stat = host.stat(request.file)?;
        let previous = if let Some(index) = self.docs.iter().position(|open| open.file.as_deref() == Some(request.file)) {
            let info = self.info(index)?;
            let replaced = self.docs.get(index).is_some_and(|open| open.version.is_some() && open.version != stat.version);
            if info.dirty || !replaced {
                return Ok(info);
            }
            Some(index)
        } else {
            None
        };
        if stat.kind != FileKind::File {
            return Err(RpcError::invalid_params("the handle names a folder, not a document's file"));
        }
        if self.format_of(&stat.name).is_none() {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        let (mut doc, unsaved, version) = match request.create {
            // A new document in a file its first save makes (H3).
            Some((_, options)) if stat.version.is_none() => {
                let size =
                    |key: &str, default: u32| options.and_then(|o| o.get(key)).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok()).unwrap_or(default);
                self.lend_for(Some(request.file));
                let doc = D::create(&stat.name, size("width", DEFAULT_SIZE.0), size("height", DEFAULT_SIZE.1)).map(hosted).map_err(RpcError::internal)?;
                (doc, true, None)
            }
            _ => {
                let (doc, version) = self.read(request.file, &stat.name)?;
                (doc, false, Some(version))
            }
        };
        if let Some(index) = previous {
            self.preserve_reread(index, &mut doc, true)?;
            self.docs.remove(index);
        }
        let id = self.next;
        self.next += 1;
        self.docs.push(Open {
            id,
            doc,
            name: stat.name,
            file: Some(request.file.to_owned()),
            read_only: request.read_only,
            unsaved,
            version,
            conflict: false,
            exchange: Exchange::new(),
        });
        self.info(self.docs.len() - 1)
    }

    fn document(&mut self, id: &str) -> Result<DocumentInfo, RpcError> {
        let index = self.position(id)?;
        self.info(index)
    }

    fn documents(&mut self) -> Vec<DocumentInfo> {
        (0..self.docs.len()).filter_map(|index| self.info(index).ok()).collect()
    }

    fn activate(&mut self, id: &str) -> Result<(), RpcError> {
        self.position(id).map(|_| ())
    }

    /// Saves through the host: staged `storage.write` on the document's handle (or `target`'s),
    /// committed with the version read, so a file changed meanwhile is a `file_conflict` (FA9).
    fn save(&mut self, id: &str, target: Option<&str>, format: Option<&str>) -> Result<(DocumentInfo, Written), RpcError> {
        let index = self.position(id)?;
        let host = self.host()?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        if open.read_only {
            return Err(RpcError::kit_detail(ErrorReason::IoError, "the document is read-only"));
        }
        let (handle, name, expected) = match (target, &open.file) {
            (Some(target), _) => {
                let stat = host.stat(target)?;
                (target.to_owned(), stat.name, stat.version)
            }
            (None, Some(file)) => (file.clone(), open.name.clone(), open.version.clone()),
            (None, None) => {
                return Err(RpcError::kit_detail(ErrorReason::IoError, "this document was opened from a replica and has no file: save it to a target"));
            }
        };
        let wanted = format.or_else(|| self.format_of(&name));
        if !wanted.is_some_and(|id| self.kit.saves.iter().any(|saved| saved == id)) {
            return Err(RpcError::kit_detail(ErrorReason::UnsupportedFormat, format!("{} saves {} files", self.kit.id, self.kit.saves.join(", "))));
        }
        self.lend_for(open.file.as_deref());
        let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let bytes = open.doc.save(Some(&name)).map_err(|message| RpcError::kit_detail(ErrorReason::IoError, message))?;
        let version = match host.write(&handle, &bytes, expected.as_deref()) {
            Ok(version) => version,
            Err(error) => {
                // The file is not the version the document was read from: it is in conflict.
                if error.reason() == Some(ErrorReason::FileConflict)
                    && target.is_none()
                    && let Some(open) = self.docs.get_mut(index)
                {
                    open.conflict = true;
                }
                return Err(error);
            }
        };
        if let Some(open) = self.docs.get_mut(index) {
            open.doc.mark_saved();
            open.name = name.clone();
            open.file = Some(handle);
            open.unsaved = false;
            open.version = Some(version.clone());
            open.conflict = false;
        }
        Ok((self.info(index)?, Written { name, version }))
    }

    /// Writes the document in an export format (`kit.json` `exports`) to the file of the `create`
    /// handle `target`: an export never replaces a file (KHP A41), and the document itself is left
    /// as it is.
    fn export(&mut self, id: &str, target: &str, format: &str, options: Option<&Map<String, Value>>) -> Result<Written, RpcError> {
        let index = self.position(id)?;
        let host = self.host()?;
        let stat = host.stat(target)?;
        let format = format.trim_start_matches('.').to_ascii_lowercase();
        let format = if format.is_empty() { stat.name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default() } else { format };
        let exports = self.exports();
        if !exports.contains(&format) {
            let known = if exports.is_empty() { "nothing".to_owned() } else { exports.join(", ") };
            return Err(RpcError::kit_detail(ErrorReason::UnsupportedFormat, format!("{} exports {known}, not {format}", self.kit.id)));
        }
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(open.file.as_deref());
        let options = options.cloned().map(Value::Object).unwrap_or(Value::Object(Map::new()));
        let bytes = open.doc.export(&format, &options).map_err(|message| RpcError::kit_detail(ErrorReason::UnsupportedFormat, message))?;
        let version = host.write(target, &bytes, None)?;
        Ok(Written { name: stat.name, version })
    }

    fn close(&mut self, id: &str, discard_changes: bool) -> Result<(), RpcError> {
        let index = self.position(id)?;
        if self.info(index)?.dirty && !discard_changes {
            return Err(RpcError::kit(ErrorReason::DocumentDirty));
        }
        self.docs.remove(index);
        self.plans.retain(|_, plan| plan.document != id);
        Ok(())
    }

    fn commands(&mut self, id: Option<&str>) -> Result<Vec<CommandSummary>, RpcError> {
        self.summaries(id, false)
    }

    /// What the agent's connection lists: [`KitBackend::commands`] less what the manifest keeps
    /// from the agent (`agent.include`, `agent.exclude`).
    fn agent_commands(&mut self, id: Option<&str>) -> Result<Vec<CommandSummary>, RpcError> {
        self.summaries(id, true)
    }

    fn execute(&mut self, id: &str, command: &str, params: Map<String, Value>, origin: Origin) -> Result<Executed, RpcError> {
        let acting = match origin {
            Origin::User => Acting::Person,
            Origin::Agent => Acting::Agent,
            Origin::System => Acting::System(kition_kit_server::protocol::SYSTEM_LABEL),
        };
        self.run_command(id, command, params, acting)
    }

    fn execute_system(&mut self, id: &str, command: &str, params: Map<String, Value>, label: &str) -> Result<Executed, RpcError> {
        self.run_command(id, command, params, Acting::System(label))
    }

    /// The whole document at the request's `scale` (KHP A39), brought down to fit `maxSize`, by
    /// [`KitDocument::render`]: below 1 an exact reduction, above 1 only up to
    /// [`KitDocument::max_render_scale`], since a larger scale the engine could only enlarge would
    /// show nothing more than scale 1. A `target` (A24) is the kit's own render command's: this
    /// screenshot draws none, and says so rather than answer the whole document.
    fn screenshot(&mut self, id: &str, request: &ScreenshotRequest) -> Result<Screenshot, RpcError> {
        let index = self.position(id)?;
        if request.target.is_some() {
            return Err(RpcError::kit_detail(
                ErrorReason::InvalidParams,
                format!("{} draws the whole document in view.screenshot, not a `target` (KHP A24): call it without `target`", self.kit.id),
            ));
        }
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(open.file.as_deref());
        let (w, h) = (open.doc.width().max(1), open.doc.height().max(1));
        let side = request.max_size.clamp(1, MAX_SCREENSHOT);
        let scale = request.scale.min(f64::from(side) / f64::from(w.max(h)));
        let most = open.doc.max_render_scale().max(1.0);
        if scale > most + 1e-9 {
            return Err(RpcError::kit_detail(
                ErrorReason::InvalidParams,
                format!(
                    "{} draws previews at scale {most} at most: at scale {scale} its engine would only enlarge the scale {most} image (KHP A39); ask for scale {most} or less, or a smaller maxSize",
                    self.kit.id
                ),
            ));
        }
        let fit = |size: u32| ((f64::from(size) * scale).round() as u32).clamp(1, side);
        let (width, height) = (fit(w), fit(h));
        let rgba = open.doc.render(0.0, 0.0, scale, width, height).map_err(RpcError::internal)?;
        Ok(Screenshot { png: encode_png(&rgba, width, height)?, width, height })
    }

    fn describe(&mut self, id: &str) -> Result<Describe, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(open.file.as_deref());
        let inspected = open.doc.inspect().map_err(RpcError::internal)?;
        let summary = open.doc.summary();
        let inspected = self.reply(id, inspected)?;
        let state = match kition_kit::document_content(inspected, &self.kit.volatile) {
            Value::Object(state) => state,
            other => Map::from_iter([("inspect".to_owned(), other)]),
        };
        Ok(Describe { summary, state })
    }

    fn check(&mut self, id: &str) -> Result<Value, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(open.file.as_deref());
        let report = kition_kit::diagnostics::report(&open.doc.check());
        self.reply(id, report)
    }

    fn text(&mut self, id: &str, limit: u64) -> Result<Value, RpcError> {
        if !self.kit.has(kition_kit::text::CAPABILITY) {
            return Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("{} does not answer file.text", self.kit.id)));
        }
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(open.file.as_deref());
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        open.doc.text(limit).map(|text| text.to_json()).map_err(RpcError::internal)
    }

    fn serves_model(&mut self) -> bool {
        self.model.is_some()
    }

    fn context_get(&mut self, id: &str) -> Result<Value, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        Ok(open.doc.editor_state())
    }

    fn context_set(&mut self, id: &str, context: &Map<String, Value>) -> Result<(), RpcError> {
        let context: kition_kit::CallContext =
            serde_json::from_value(Value::Object(context.clone())).map_err(|error| RpcError::invalid_params(format!("the call context: {error}")))?;
        self.unchanged(id, "set_context", |doc| doc.set_context(&context))
    }

    fn context_restore(&mut self, id: &str, state: &Value) -> Result<(), RpcError> {
        self.unchanged(id, "restore_editor_state", |doc| doc.restore_editor_state(state))
    }

    /// `context.under`: the step's `on` (as the selection), part and time set (as for `context.set`), what the command
    /// names by its place asked of the document, and the editor state put back; no edit.
    fn context_under(&mut self, id: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let command = params.get("command").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`command` names the command"))?.to_owned();
        let given = params.get("params").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let context = kition_kit::CallContext {
            on: params.get("on").and_then(Value::as_array).cloned().unwrap_or_default(),
            part: params.get("part").filter(|part| !part.is_null()).cloned(),
            time: params.get("time").and_then(Value::as_f64),
        };
        let saved = self.context_get(id)?;
        self.unchanged(id, "set_context", |doc| doc.set_context(&context))?;
        let index = self.position(id)?;
        let answered = match self.docs.get(index) {
            Some(open) => {
                let mut step: kition_kit::PremiseStep = serde_json::from_value(json!(params)).map_err(|error| RpcError::invalid_params(error.to_string()))?;
                step.state = open.doc.editor_state();
                open.doc.under_step(&command, &given, &step)
            }
            None => Err("the document is not open".to_owned()),
        };
        self.context_restore(id, &saved)?;
        match answered.map_err(RpcError::invalid_params)? {
            Some(under) => serde_json::to_value(under).map_err(|error| RpcError::internal(error.to_string())),
            None => Err(RpcError::kit_detail(ErrorReason::CommandDisabled, format!("`{command}` names nothing this kit can tell by its place"))),
        }
    }

    fn context_plan(&mut self, id: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let index = self.position(id)?;
        match params.get("action").and_then(Value::as_str) {
            Some(action @ ("begin" | "advance")) => {
                let steps = params.get("steps").and_then(Value::as_array).ok_or_else(|| RpcError::invalid_params("steps required"))?;
                let ops = params.get("ops").and_then(Value::as_array);
                let operations = steps.len() + ops.map_or(0, Vec::len);
                let bytes = json!(params).to_string().len();
                if action == "begin" && self.plans.len() >= 16 || operations > 256 || bytes > 1024 * 1024 {
                    return Err(RpcError::invalid_params("premise planning limit exceeded"));
                }
                let hooks = self.model.as_ref().ok_or_else(|| RpcError::invalid_params("premise planning requires an object model"))?;
                let read = hooks.replica;
                let (token, mut plan) = if action == "advance" {
                    let token = params.get("token").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("token required"))?;
                    let plan =
                        self.plans.remove(token).filter(|plan| plan.document == id).ok_or_else(|| RpcError::invalid_params("premise plan unavailable"))?;
                    (token.to_owned(), plan)
                } else {
                    let source = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                    let replica = read(&mut source.doc, &mut source.exchange).map_err(|error| model_error(&error))?;
                    let before = replica.version();
                    let before_document = replica.doc_id();
                    let before_model = replica.state_json().map_err(|error| RpcError::internal(error.to_string()))?;
                    let before_state = source.doc.editor_state();
                    let mut doc = match source.doc.fork_for_premises() {
                        Ok(doc) => doc,
                        Err(error) => {
                            let open = hooks.open.ok_or_else(|| RpcError::invalid_params(error))?;
                            let snapshot = read(&mut source.doc, &mut source.exchange)
                                .map_err(|error| model_error(&error))?
                                .snapshot()
                                .map_err(|error| RpcError::internal(error.to_string()))?;
                            let blobs = (hooks.blobs_since)(&mut source.doc, &[]).map_err(RpcError::invalid_params)?;
                            open(&source.name, &snapshot, &blobs).map_err(RpcError::invalid_params)?
                        }
                    };
                    doc.restore_editor_state(&before_state).map_err(RpcError::invalid_params)?;
                    // The plan's replica starts at `before`, before any step runs: a replica loaded
                    // later holds no history before its load, and the changes of the earlier
                    // steps would be missing from the receipt a later step's premises read.
                    let mut exchange = Exchange::new();
                    read(&mut doc, &mut exchange).map_err(|error| model_error(&error))?;
                    self.next_plan += 1;
                    (
                        self.next_plan.to_string(),
                        Planned {
                            document: id.to_owned(),
                            doc,
                            exchange,
                            step: 0,
                            changes: Value::Null,
                            before_state,
                            before,
                            before_document,
                            before_model,
                            refs: Map::new(),
                            operations: 0,
                            bytes: 0,
                        },
                    )
                };
                plan.operations += operations;
                plan.bytes += bytes;
                if plan.operations > 256 || plan.bytes > 1024 * 1024 {
                    return Err(RpcError::invalid_params("premise planning limit exceeded"));
                }
                if let Some(ops) = ops {
                    if ops.iter().any(|op| op["ref"].as_str().is_some_and(|name| plan.refs.contains_key(name))) {
                        return Err(RpcError::invalid_params("premise batch reference is already bound"));
                    }
                    let refs = plan
                        .refs
                        .iter()
                        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), kition_kit::kdm::ObjectId::from_string(value))))
                        .collect();
                    let ops = kition_kit::kdm::batch::resolve_values(&json!(ops), &refs);
                    let answer =
                        (hooks.batch)(&mut plan.doc, &mut plan.exchange, &json!({"ops":ops,"origin":{"kind":"agent","principal":"premise-plan"}}), false)
                            .map_err(|error| model_error(&error))?;
                    plan.refs.extend(answer["refs"].as_object().into_iter().flatten().map(|(key, value)| (key.clone(), value.clone())));
                }
                for step in steps {
                    let command = step["command"].as_str().ok_or_else(|| RpcError::invalid_params("step command required"))?;
                    let given = step.get("params").cloned().unwrap_or(json!({}));
                    if let Some(context) = step.get("context") {
                        let context = serde_json::from_value(context.clone()).map_err(|error| RpcError::invalid_params(format!("step context: {error}")))?;
                        plan.doc.set_context(&context).map_err(RpcError::invalid_params)?;
                    }
                    dispatch::may_run(command, &given).map_err(RpcError::invalid_params)?;
                    let result = match self.run_as {
                        Some(run) => run(&mut plan.doc, command, given, &kition_kit::kdm::Origin::agent("premise-plan")),
                        None => plan.doc.execute(command, given),
                    }
                    .map_err(RpcError::invalid_params)?;
                    // Closing can destroy the replica and editor state. There is no next
                    // premise to read, and the consumed scratch plan is released here.
                    if result["closed"] == true {
                        return Ok(json!({"closed":true}));
                    }
                }
                let replica = read(&mut plan.doc, &mut plan.exchange).map_err(|error| model_error(&error))?;
                // The receipt from the replica's log; when the log does not reach `before` (a step
                // replaced the replica on a new line), from the whole states, which it equals.
                let logged = if replica.doc_id() == plan.before_document {
                    match replica.changes_since(&plan.before) {
                        Ok(changes) => Some(changes),
                        Err(kition_kit::kdm::KdmError::HistoryMissing(_)) => None,
                        Err(error) => return Err(RpcError::invalid_params(error.to_string())),
                    }
                } else {
                    None
                };
                plan.changes = if let Some(changes) = logged {
                    changes
                } else {
                    let now = replica.state_json().map_err(|error| RpcError::internal(error.to_string()))?;
                    kition_kit::kdm::diff::diff_states(&plan.before_model, &now).without_texts().with_leaf_edits(replica.schema()).with_tool_ids(
                        replica.schema(),
                        &kition_kit::kdm::tool_ids::ToolIds::of_state(replica.schema(), &plan.before_model),
                        &replica.tool_ids(),
                    )
                }
                .to_recorded_json(replica.schema());
                plan.step = params.get("step").and_then(Value::as_u64).unwrap_or(plan.operations as u64) as usize;
                let answer = json!({"token":token,"state":plan.doc.editor_state(),"beforeState":plan.before_state,"changes":plan.changes,"refs":plan.refs});
                self.plans.insert(token, plan);
                Ok(answer)
            }
            Some("end") => {
                let token = params.get("token").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("token required"))?;
                if self.plans.get(token).is_some_and(|plan| plan.document == id) {
                    self.plans.remove(token);
                }
                Ok(json!({}))
            }
            Some("read") => {
                let token = params.get("token").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("token required"))?;
                let method = params.get("method").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("method required"))?;
                let mut given = params.get("params").and_then(Value::as_object).cloned().unwrap_or_default();
                if method == "model.batch" && given.get("ops").and_then(Value::as_array).is_none_or(|ops| !ops.is_empty()) {
                    return Err(RpcError::invalid_params("a premise plan only accepts model reads"));
                }
                if !matches!(method, "under" | "covered" | "content" | "state" | "identity" | "model.batch" | "model.describe" | "model.derived") {
                    return Err(RpcError::invalid_params("unsupported premise plan read"));
                }
                let mut plan =
                    self.plans.remove(token).filter(|plan| plan.document == id).ok_or_else(|| RpcError::invalid_params("premise plan unavailable"))?;
                given.insert("step".into(), json!(plan.step));
                given.insert("state".into(), plan.doc.editor_state());
                given.insert("changes".into(), plan.changes.clone());
                let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                std::mem::swap(&mut open.doc, &mut plan.doc);
                std::mem::swap(&mut open.exchange, &mut plan.exchange);
                let result = match method {
                    "under" => self.context_under(id, &given),
                    "covered" => self.context_covered(id, &given),
                    "content" => self.context_content(id, &given),
                    "identity" => self.context_identity(id, &given),
                    "state" => self.context_get(id).map(|state| json!({"state":state,"beforeState":plan.before_state})),
                    _ => {
                        for key in ["step", "state", "changes"] {
                            given.remove(key);
                        }
                        given.insert("documentId".into(), json!(id));
                        self.model(method, json!(given))
                    }
                };
                let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                std::mem::swap(&mut open.doc, &mut plan.doc);
                std::mem::swap(&mut open.exchange, &mut plan.exchange);
                self.plans.insert(token.to_owned(), plan);
                result
            }
            _ => Err(RpcError::invalid_params("plan action is begin, advance, read or end")),
        }
    }

    /// `context.covered`: the step's part and time set as for `context.under`, whether
    /// each object of `objects` was under the place at `basis` asked of the document, and the
    /// editor state put back; no edit.
    fn context_identity(&mut self, id: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let objects = params.get("objects").and_then(Value::as_array).ok_or_else(|| RpcError::invalid_params("objects required"))?;
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let unproven = open.doc.unproven_identities(objects).map_err(RpcError::invalid_params)?;
        Ok(json!({"unproven":unproven}))
    }

    fn context_inputs(&mut self, id: &str, _params: &Map<String, Value>) -> Result<Value, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let inputs = open.doc.external_inputs().map_err(RpcError::invalid_params)?;
        Ok(json!({"inputs":inputs}))
    }

    fn context_content(&mut self, id: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let mut given = params.clone();
        given.remove("history");
        let mut ask: kition_kit::ContentAsk = serde_json::from_value(json!(given)).map_err(|error| RpcError::invalid_params(error.to_string()))?;
        let history = HistoricalReader { host: self.host.clone(), token: params.get("history").and_then(Value::as_str).map(str::to_owned) };
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        ask.step.state = open.doc.editor_state();
        let changed = open.doc.content_at(&ask, &history).map_err(RpcError::invalid_params)?;
        Ok(json!({"changed":changed}))
    }

    fn context_covered(&mut self, id: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let command = params.get("command").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`command` names the command"))?.to_owned();
        let given = params.get("params").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let objects: Vec<kition_kit::CoveredAsk> = serde_json::from_value(params.get("objects").cloned().unwrap_or(Value::Null))
            .map_err(|error| RpcError::invalid_params(format!("`objects` lists {{ id, before, deleted?, unknown? }}: {error}")))?;
        let context = kition_kit::CallContext {
            on: params.get("on").and_then(Value::as_array).cloned().unwrap_or_default(),
            part: params.get("part").filter(|part| !part.is_null()).cloned(),
            time: params.get("time").and_then(Value::as_f64),
        };
        let saved = self.context_get(id)?;
        self.unchanged(id, "set_context", |doc| doc.set_context(&context))?;
        let index = self.position(id)?;
        let history = HistoricalReader { host: self.host.clone(), token: params.get("history").and_then(Value::as_str).map(str::to_owned) };
        let answered = match self.docs.get(index) {
            Some(open) => {
                let mut step: kition_kit::PremiseStep = serde_json::from_value(json!(params)).map_err(|error| RpcError::invalid_params(error.to_string()))?;
                step.state = open.doc.editor_state();
                open.doc.covered_step(&command, &given, &objects, &history, &step)
            }
            None => Err("the document is not open".to_owned()),
        };
        self.context_restore(id, &saved)?;
        match answered.map_err(RpcError::invalid_params)? {
            Some(covered) => serde_json::to_value(covered).map_err(|error| RpcError::internal(error.to_string())),
            None => Err(RpcError::kit_detail(ErrorReason::CommandDisabled, format!("`{command}` names no place this kit can tell as it was"))),
        }
    }

    fn model(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if method == "model.blob.read" {
            let id = params["documentId"].as_str().ok_or_else(|| RpcError::invalid_params("documentId required"))?;
            let index = self.position(id)?;
            let unavailable = || json!({"available": false, "reason":"missing"});
            let Some(source) = self.docs.get(index).and_then(|open| open.doc.blob_source()) else { return Ok(unavailable()) };
            let Some(bytes) = params["hash"].as_str().and_then(|hash| source.get(hash)) else { return Ok(unavailable()) };
            let offset = params["offset"].as_u64().and_then(|n| usize::try_from(n).ok()).filter(|n| *n <= bytes.len());
            let length = params["length"].as_u64().and_then(|n| usize::try_from(n).ok()).filter(|n| *n <= 1024 * 1024);
            let (Some(offset), Some(length)) = (offset, length) else { return Err(RpcError::invalid_params("invalid blob range")) };
            return Ok(json!({"available":true,"size":bytes.len(),"data":base64::encode(&bytes[offset..offset.saturating_add(length).min(bytes.len())])}));
        }
        if method == "model.derived" {
            return self.model_derived(&params);
        }
        if method == "model.carried" {
            return self.model_carried(&params);
        }
        let Some(hooks) = &self.model else {
            return Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("{} has no object model", self.kit.id)));
        };
        let (describe, batch, open_replica, import, export) = (hooks.describe, hooks.batch, hooks.open, hooks.import, hooks.export);
        let replica = hooks.replica;
        let (add_blobs, blobs_since) = (hooks.add_blobs, hooks.blobs_since);
        if method == "model.open" {
            let open_replica =
                open_replica.ok_or_else(|| RpcError::kit_detail(ErrorReason::UnsupportedFormat, "this kit cannot open a document from its replica"))?;
            return self.open_replica(open_replica, &params);
        }
        let id = params.get("documentId").and_then(Value::as_str).ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))?;
        let index = self.position(id)?;
        let file = self.docs.get(index).map(|open| open.file.clone()).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        self.lend_for(file.as_deref());
        let open = self.docs.get_mut(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let answer = match method {
            "model.describe" => describe(&mut open.doc, &mut open.exchange).map(|mut answer| {
                if open.doc.blob_source().is_some() {
                    answer["blobBytes"] = json!(true);
                }
                answer
            }),
            // Its `command` operations pass the gate `command.execute` applies, for whom the
            // batch runs (its `origin`): every one before anything runs, then each again with the
            // parameters it gets, and what the engine dispatches while one runs.
            "model.batch" if !command_ops(&params).is_empty() => {
                let gate = CommandGate::new(&self.kit, open.doc.commands(), batch_role(&params));
                for (at, command, op_params) in command_ops(&params) {
                    gate.allowed(&command, &op_params).map_err(|refusal| batch_refusal(&refusal, Some(at)))?;
                }
                let answer = dispatch::with_gate(Arc::new(gate), || batch(&mut open.doc, &mut open.exchange, &params, open.read_only));
                return answer.map_err(|error| match dispatch::take_refusal() {
                    Some(refusal) => batch_refusal(&refusal, error.index),
                    None => model_error(&error),
                });
            }
            "model.batch" => batch(&mut open.doc, &mut open.exchange, &params, open.read_only),
            "model.import" => {
                let changes = base64_param(&params, "changes")?.ok_or_else(|| RpcError::invalid_params("`changes` is base64 KDM changes"))?;
                // The media the changes reference (`blobs`, as `model.open` takes them) go in first,
                // as a page's `addBlobs` before `importChanges`. Damaged blobs refuse the call before
                // anything is imported; the document stays open.
                let blobs = base64_param(&params, "blobs")?.unwrap_or_default();
                if !blobs.is_empty() {
                    add_blobs(&mut open.doc, &blobs).map_err(|message| RpcError::invalid_params(format!("`blobs`: {message}")))?;
                }
                return match import(&mut open.doc, &changes) {
                    Ok(()) => Ok(json!({})),
                    Err(message) => {
                        // The engine may hold part of what it refused: the document is closed.
                        self.docs.remove(index);
                        let mut error = RpcError::kit_detail(ErrorReason::InvalidParams, format!("the kit refused the changes: {message}"));
                        if let Some(Value::Object(data)) = error.data.as_mut() {
                            data.insert("refused".into(), Value::Bool(true));
                        }
                        Err(error)
                    }
                };
            }
            "model.export" => {
                let since = base64_param(&params, "since")?.unwrap_or_default();
                let changes = export(&mut open.doc, &since).map_err(RpcError::internal)?;
                // The blobs a replica at `since` needs for them, so the changes open elsewhere whole.
                let blobs = blobs_since(&mut open.doc, &since).map_err(RpcError::internal)?;
                let mut answer = json!({ "changes": base64::encode(&changes) });
                if !blobs.is_empty() {
                    answer["blobs"] = Value::String(base64::encode(&blobs));
                }
                return Ok(answer);
            }
            "model.save" => return self.save_bytes(index, params.get("format").and_then(Value::as_str)),
            "model.version" => {
                let replica = replica(&mut open.doc, &mut open.exchange).map_err(|error| model_error(&error))?;
                return Ok(json!({ "version": base64::encode(&replica.version().encode()) }));
            }
            "model.changes" => {
                let since =
                    base64_param(&params, "since")?.ok_or_else(|| RpcError::invalid_params("`since` is a base64 version, as `model.version` answers it"))?;
                let since = kition_kit::kdm::Version::decode(&since).map_err(|error| RpcError::invalid_params(format!("`since`: {error}")))?;
                let replica = replica(&mut open.doc, &mut open.exchange).map_err(|error| model_error(&error))?;
                return Ok(changes_answer(replica, &since));
            }
            _ => return Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("method not found: {method}"))),
        };
        answer.map_err(|error| model_error(&error))
    }

    /// A clean document is read again; one with unsaved edits keeps them and is in conflict when
    /// the file is no longer the version it was read from (Kit Process Protocol section 5), which the state the
    /// server sends says (`conflict`).
    fn did_change_on_disk(&mut self, id: &str) -> Option<DocumentInfo> {
        let index = self.position(id).ok()?;
        let open = self.docs.get(index)?;
        let file = open.file.clone()?;
        if open.doc.dirty() || open.unsaved {
            let now = self.host.as_ref()?.stat(&file).ok()?.version;
            if open.conflict || now == open.version {
                return None;
            }
            self.docs.get_mut(index)?.conflict = true;
            return self.info(index).ok();
        }
        self.reload(id).ok()
    }

    fn reload(&mut self, id: &str) -> Result<DocumentInfo, RpcError> {
        let index = self.position(id)?;
        let open = self.docs.get(index).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        let file = open.file.clone().ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "this document was opened from a replica and has no file"))?;
        let name = open.name.clone();
        let previous_version = open.version.clone();
        let (mut doc, version) = self.read(&file, &name)?;
        self.preserve_reread(index, &mut doc, previous_version.as_ref() != Some(&version))?;
        if let Some(open) = self.docs.get_mut(index) {
            open.doc = doc;
            open.version = Some(version);
            open.unsaved = false;
            open.conflict = false;
            open.exchange.reset();
        }
        self.info(index)
    }
}

impl<D: KitDocument> Headless<D> {
    fn preserve_reread(&mut self, index: usize, fresh: &mut D, outside: bool) -> Result<(), RpcError> {
        let open = &mut self.docs[index];
        fresh.carry_replica_objects(&open.doc).map_err(RpcError::internal)?;
        if open.doc.dirty() || open.unsaved {
            return Ok(());
        }
        let saved = open.doc.editor_state();
        fresh
            .restore_editor_state(&saved)
            .map_err(|message| RpcError::kit_detail(ErrorReason::FileConflict, format!("editor state no longer resolves after reread: {message}")))?;
        if !outside {
            return Ok(());
        }
        if open.doc.reconcile_reread(fresh).map_err(|message| RpcError::kit_detail(ErrorReason::FileConflict, message))? {
            open.doc.mark_saved();
            std::mem::swap(&mut open.doc, fresh);
            return Ok(());
        }
        let state = open.doc.inspect().map_err(RpcError::internal)?;
        let mut history = open.doc.revision() != 0 || state["canUndo"] == true || state["canRedo"] == true;
        if let Some(model) = &self.model {
            let replica = (model.replica)(&mut open.doc, &mut open.exchange).map_err(|error| model_error(&error))?;
            history |= [kition_kit::kdm::UndoScope::Person, kition_kit::kdm::UndoScope::Agent]
                .into_iter()
                .any(|scope| replica.can_undo_in(scope) || replica.can_redo_in(scope));
        }
        if history {
            return Err(RpcError::kit_detail(ErrorReason::FileConflict, "this kit cannot reconcile retained session history after a file reread"));
        }
        Ok(())
    }
}

/// [`run`] for the kit `manifest` (its `kit.json`) declares, with the commands that are
/// [`KitInfo::sandboxed`] and the [`KitInfo::volatile`] inspect keys.
pub fn run_manifest<D: KitDocument + Send + 'static>(manifest: &str, sandboxed: &[&str], volatile: &[&str]) -> ExitCode {
    match KitInfo::from_manifest(manifest, sandboxed, volatile) {
        Ok(kit) => run::<D>(&kit),
        Err(error) => {
            eprintln!("kit: {error}");
            ExitCode::from(2)
        }
    }
}

/// [`run_manifest`] with the object model served through the engine's change exchange
/// ([`Headless::with_replica_port`]).
pub fn run_manifest_model<D: KitDocument + ReplicaPort + Send + 'static>(manifest: &str, sandboxed: &[&str], volatile: &[&str]) -> ExitCode {
    match KitInfo::from_manifest(manifest, sandboxed, volatile) {
        Ok(kit) => serve_backend(&kit, Headless::<D>::with_replica_port(kit.clone())),
        Err(error) => {
            eprintln!("kit: {error}");
            ExitCode::from(2)
        }
    }
}

/// The kit executable's `main`: serves documents of type `D` headless when the
/// host launches it (`--kition-kit` and the `KITION_KIT_*` environment).
pub fn run<D: KitDocument + Send + 'static>(kit: &KitInfo) -> ExitCode {
    serve_backend(kit, Headless::<D>::new(kit.clone()))
}

/// Serves `backend` (a [`Headless`] built with or without the object model) when the host
/// launches the kit.
pub fn serve_backend<D: KitDocument + Send + 'static>(kit: &KitInfo, backend: Headless<D>) -> ExitCode {
    // Before anything of the engine runs: the host owns every file (engine contract E22).
    kition_kit::host::set_hosting(HOSTING);
    let name = kit.id.trim_start_matches("kit.");
    let config = match LaunchConfig::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("kition-{name}: {error}");
            return ExitCode::from(2);
        }
    };
    match serve(config, backend) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-{name}: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod hosting_tests;
