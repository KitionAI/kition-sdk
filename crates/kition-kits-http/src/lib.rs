//! The kits' HTTP API over `kition-kits` for one workspace, as Kition's runtime serves it and as
//! `kition gateway` serves it on loopback ([`gateway`]):
//!
//! - `GET /kits`: the kits and whether each is installed;
//! - `PUT /kits/files`: an in-page kit editor saves its document or writes a new file;
//! - `/kits/grants/*`: file grants for kit editor pages (Kition platform KitFiles 1.1);
//! - `GET /kits/bridge` (server-sent events) and `POST /kits/bridge?session=`: the Kit AI bridge,
//!   which runs the agent's calls in the editor that has the file open (`kition_kits::bridge`);
//! - `/kits/drafts{,/compare,/merge,/discard}`: the person's review of the agent's headless drafts;
//! - `POST /mcp/kits`: the kit tools as an MCP server over Streamable HTTP ([`mcp`]);
//! - `GET /kits/editors`, `POST /kits/editors/install`: the kits' editor packages ([`editors`]);
//! - `GET`/`PUT /kits/replicas?path=&kit=`: the replica an editor page keeps beside its document
//!   (Kit UI protocol capability `replica`), in the workspace's `.kition/replicas/`;
//! - `GET`/`PUT`/`DELETE /kits/view-state?path=&kit=`: the person's view state of a document (Kit
//!   UI protocol capability `view-state`), in the server's own data folder, never the workspace.
//!
//! The paths are relative to where the router is mounted (`/api/v1` in the gateway and in
//! Kition's runtime). JSON answers use the envelope `{code, message, data}`
//! (`kition_http_guard::envelope`). Every route takes the caller from the transport guard in front
//! of it (`kition_http_guard::guard`): the API token, or for the bridge stream a signed URL; a
//! router mounted without the guard refuses every request. `/kit-files/*` is [`kit_files`].

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod editors;
pub mod gateway;
pub mod kit_files;
pub mod mcp;
pub mod page;

use std::sync::Arc;

use axum::Router;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header;
use kition_http_guard::gate::{RequireToken, RequireTokenOrSigned};
use kition_http_guard::{ApiError, ApiResult, JsonBody, ok};
use kition_kit_process_protocol::ErrorReason;
use serde::Deserialize;
use serde_json::{Value, json};

use kition_kits::{FileWrite, KitError, KitManager};

/// What the routes serve: the workspace's kits, the MCP connections that told themselves apart,
/// and the kits' editor packages when the host has a store of them.
#[derive(Clone)]
pub struct KitsState {
    pub kits: KitManager,
    pub mcp: Arc<mcp::Connections>,
    pub editors: Option<Arc<dyn editors::EditorStore>>,
    /// The server's own data folder for this workspace (view state), outside the workspace; none:
    /// `/kits/view-state` keeps nothing.
    pub data: Option<Arc<std::path::Path>>,
}

impl KitsState {
    pub fn new(kits: KitManager) -> Self {
        Self { kits, mcp: Arc::default(), editors: None, data: None }
    }

    /// Keeps the server's own data (view state) in `dir`, which must lie outside the workspace.
    #[must_use]
    pub fn with_data(mut self, dir: impl Into<std::path::PathBuf>) -> Self {
        self.data = Some(Arc::from(dir.into()));
        self
    }

    /// Serves `store`'s editor packages too.
    #[must_use]
    pub fn with_editors(mut self, store: Arc<dyn editors::EditorStore>) -> Self {
        self.editors = Some(store);
        self
    }
}

/// The routes, relative to where they are mounted.
pub fn router(state: KitsState) -> Router {
    Router::new()
        .route("/kits", get(list))
        .route("/kits/outline", get(outline))
        .route("/kits/files", axum::routing::put(write_file).layer(axum::extract::DefaultBodyLimit::max(MAX_FILE_BYTES)))
        .route("/kits/grants", post(grant_file))
        .route("/kits/grants/choices", post(grant_choices))
        .route("/kits/grants/create", post(create_file))
        .route("/kits/grants/release", post(release_files))
        .route("/kits/grants/sessions", post(open_grant_session))
        .route("/kits/grants/sessions/{session}", get(grant_session).delete(end_grant_session))
        .route("/kits/grants/{handle}", get(stat_file))
        .route("/kits/grants/{handle}/list", get(list_folder))
        .route("/kits/grants/{handle}/content", get(read_file).put(write_chunk).layer(axum::extract::DefaultBodyLimit::max(MAX_CHUNK_BYTES)))
        .route("/kits/drafts", get(list_drafts))
        .route("/kits/drafts/compare", get(compare_draft))
        .route("/kits/drafts/merge", post(merge_draft))
        .route("/kits/drafts/discard", post(discard_draft))
        .route("/kits/bridge", get(bridge_stream).post(bridge_message))
        .route("/kits/editors", get(list_editors))
        .route("/kits/editors/install", post(install_editor))
        .route("/kits/replicas", get(read_replica).put(write_replica).layer(axum::extract::DefaultBodyLimit::max(MAX_FILE_BYTES)))
        .route(
            "/kits/view-state",
            get(read_view_state)
                .put(write_view_state)
                .delete(delete_view_state)
                .layer(axum::extract::DefaultBodyLimit::max(8 + VIEW_STATE_JSON_LIMIT + VIEW_STATE_BYTES_LIMIT)),
        )
        .route("/mcp/kits", post(mcp::handle))
        .with_state(state)
}

/// Ends a bridge session when its stream is dropped (the editor's window went away).
struct BridgeStream {
    bridge: Arc<kition_kits::bridge::Bridge>,
    session: u64,
    rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl Drop for BridgeStream {
    fn drop(&mut self) {
        self.bridge.disconnect(self.session);
    }
}

impl tokio_stream::Stream for BridgeStream {
    type Item = Result<axum::response::sse::Event, std::convert::Infallible>;

    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|message| message.map(|message| Ok(axum::response::sse::Event::default().data(message.to_string()))))
    }
}

/// `GET /kits/bridge`: an editor window's stream of bridge requests (one JSON-RPC message per
/// event), the first being `bridge.ready` with the window's session id. With the token, or a
/// signed URL for an `EventSource`.
async fn bridge_stream(State(state): State<KitsState>, _caller: RequireTokenOrSigned) -> Response {
    let bridge = state.kits.bridge().clone();
    let (session, rx) = bridge.connect();
    axum::response::sse::Sse::new(BridgeStream { bridge, session, rx }).keep_alive(axum::response::sse::KeepAlive::default()).into_response()
}

#[derive(Deserialize)]
struct BridgeQuery {
    session: u64,
}

/// `POST /kits/bridge?session=<id>`: an answer to a bridge request, or a `kit.changed` notification.
async fn bridge_message(
    State(state): State<KitsState>,
    _caller: RequireToken,
    Query(query): Query<BridgeQuery>,
    JsonBody(message): JsonBody<Value>,
) -> ApiResult<Response> {
    state.kits.bridge().receive(query.session, &message).map_err(|message| ApiError::new(404, 40402, message))?;
    Ok(ok(json!({})))
}

/// Maps kit failures to statuses an editor page can branch on.
pub fn app_error(error: KitError) -> ApiError {
    let message = error.to_string();
    let (status, code) = match &error {
        KitError::UnknownKit(_) => (404, 40400),
        KitError::NotInstalled { .. } => (409, 40901),
        KitError::NoWorkspace => (409, 40902),
        KitError::InvalidPath(_) => (400, 40000),
        KitError::NotAllowed(_) => (403, 40302),
        KitError::Launch { .. } | KitError::VersionMismatch { .. } => (502, 50201),
        KitError::Stopped { .. } => (503, 50301),
        KitError::MemoryLimit { .. } => (503, 50302),
        KitError::Timeout { .. } => (504, 50401),
        KitError::Cancelled => (409, 40907),
        KitError::Unavailable(_) => (409, 40904),
        KitError::Model { .. } => (400, 40002),
        KitError::Kit { reason, .. } => match reason {
            Some(ErrorReason::DocumentNotFound) => (404, 40401),
            Some(ErrorReason::FileNotGranted | ErrorReason::FileNotAllowed) => (403, 40301),
            Some(ErrorReason::DocumentDirty) => (409, 40903),
            Some(ErrorReason::FileConflict | ErrorReason::FileAlreadyCommitted | ErrorReason::FileUnsavedEdits) => (409, 40906),
            Some(ErrorReason::FileQuota) => (413, 41301),
            Some(_) | None => (400, 40001),
        },
    };
    let reason = match &error {
        KitError::Kit { reason: Some(reason), .. } => serde_json::to_value(reason).unwrap_or(Value::Null),
        KitError::NotInstalled { .. } => json!("not_installed"),
        KitError::Stopped { .. } => json!("stopped"),
        KitError::Cancelled => serde_json::to_value(ErrorReason::RequestCancelled).unwrap_or(Value::Null),
        KitError::Unavailable(_) => json!("unavailable"),
        KitError::NotAllowed(_) => json!("not_allowed"),
        KitError::Model { code, .. } => json!(code),
        _ => Value::Null,
    };
    ApiError::new(status, code, message).with_data(json!({ "reason": reason }))
}

/// A workspace path as a route takes it: `/`-separated and relative, no empty, `.` or `..`
/// segment, no hidden segment, no `\`. An absolute path is refused here, though the kit tools
/// take one inside the workspace: an HTTP caller names files as the workspace does. The refusals
/// are the kit manager's (`400` for a malformed path, `403` for one out of the workspace or
/// hidden), so a path this lets through is refused the same way after it.
fn workspace_path(path: &str) -> ApiResult<&str> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(app_error(KitError::InvalidPath(format!("`{path}` is not a workspace path"))));
    }
    let outside = || app_error(KitError::NotAllowed(format!("`{path}` is outside the workspace")));
    if std::path::Path::new(trimmed).is_absolute() || trimmed.starts_with('/') || trimmed.as_bytes().get(1) == Some(&b':') {
        return Err(outside());
    }
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(outside());
        }
        if segment.starts_with('.') {
            return Err(app_error(KitError::NotAllowed(format!("`{path}` names a hidden file or folder"))));
        }
    }
    Ok(trimmed)
}

/// The kits the workspace's manager holds, then the kits its supply would install on first use
/// (`kition mcp`'s and `kition gateway`'s kit index), not installed: what a page can open.
fn known_kits(kits: &KitManager) -> Vec<Value> {
    let mut known: Vec<Value> = kits.statuses().iter().filter_map(|status| serde_json::to_value(status).ok()).collect();
    for kit in kits.supply().map(|supply| supply.available()).unwrap_or_default() {
        if !known.iter().any(|status| status["id"] == kit.id) {
            let creates: Vec<&str> = kit.creates.iter().map(|(extension, _)| *extension).collect();
            known.push(json!({ "id": kit.id, "name": kit.name, "extensions": kit.extensions, "views": kit.views, "creates": creates, "installed": false }));
        }
    }
    known
}

/// `GET /kits`: the kits and whether each is installed, those a supply installs on first use
/// included; `extensions` they edit, `views` they open read-only.
async fn list(State(state): State<KitsState>, _caller: RequireToken) -> Response {
    ok(json!({ "kits": known_kits(&state.kits) }))
}

#[derive(Deserialize)]
struct OutlineQuery {
    path: String,
}

/// `GET /kits/outline?path=`: the parts of the workspace file `path` a host lists under it, as
/// its kit's outline command answers them (`kit.json` `outline`, platform K24): `items`, each
/// `{ id, title, kind?, view }`, from the file's open editor when it has one, else from the
/// headless kit. `items` is `null` for a kit that declares no outline.
async fn outline(State(state): State<KitsState>, _caller: RequireToken, Query(query): Query<OutlineQuery>) -> ApiResult<Response> {
    let items = kition_kits::outline::outline(&state.kits, &query.path).await.map_err(app_error)?;
    Ok(ok(json!({ "path": query.path, "items": items })))
}

/// The largest file an in-page editor may save in one request.
const MAX_FILE_BYTES: usize = 2 << 30;

#[derive(Deserialize)]
struct WriteFileQuery {
    path: String,
    /// The document an in-page editor opened, when the write saves it: only that file is
    /// replaced. Without it the write makes a new file (a new document or an export).
    document: Option<String>,
    /// The version (`/kit-files/` `ETag`) the editor holds of the file it saves: the save is
    /// refused as `file_conflict` (409) when the file is another version now, so an edit made
    /// meanwhile (an agent's headless run, a merged draft) is never overwritten unseen.
    expected: Option<String>,
}

/// The version stamp of the workspace file at `path` now, `None` when there is none.
fn current_stamp(kits: &KitManager, path: &str) -> Option<String> {
    let file = kits.resolve(path).ok()?;
    std::fs::metadata(file).ok().filter(std::fs::Metadata::is_file).map(|metadata| kit_files::stamp(&metadata))
}

async fn write_file(
    State(state): State<KitsState>,
    _caller: RequireToken,
    Query(query): Query<WriteFileQuery>,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    let write = match query.document.as_deref() {
        Some(document) => FileWrite::Save { document: workspace_path(document)? },
        None => FileWrite::New,
    };
    if let Some(expected) = query.expected.as_deref().filter(|expected| !expected.is_empty())
        && current_stamp(&state.kits, path).as_deref() != Some(expected)
    {
        return Err(ApiError::new(409, 40906, format!("`{path}` changed since the editor read it: reload it, or save elsewhere"))
            .with_data(json!({ "reason": ErrorReason::FileConflict })));
    }
    state.kits.write_file(path, &body, write).map_err(app_error)?;
    Ok(ok(json!({ "path": query.path, "bytes": body.len(), "version": current_stamp(&state.kits, path) })))
}

/// `GET /kits/editors`: each kit's editor package as an editor page needs it, with `base`, the
/// address (relative to the gateway's root) it loads an installed one from.
async fn list_editors(State(state): State<KitsState>, _caller: RequireToken) -> Response {
    let Some(store) = &state.editors else {
        return ok(json!({ "editors": {} }));
    };
    let ids: Vec<String> = known_kits(&state.kits).iter().filter_map(|kit| kit["id"].as_str().map(str::to_owned)).collect();
    // The listing may read the kit index (a file, or the network once an hour).
    let store = store.clone();
    let entries = tokio::task::spawn_blocking(move || store.listing(&ids.iter().map(String::as_str).collect::<Vec<_>>())).await.unwrap_or_default();
    let listed: serde_json::Map<String, Value> = entries
        .into_iter()
        .map(|entry| {
            let short = entry.id.strip_prefix("kit.").unwrap_or(&entry.id).to_owned();
            let mut value = serde_json::to_value(&entry).unwrap_or(Value::Null);
            if entry.installed
                && let Some(version) = &entry.version
            {
                value["base"] = json!(editors::base(&short, version));
            }
            (entry.id, value)
        })
        .collect();
    ok(json!({ "editors": listed }))
}

#[derive(Deserialize)]
struct InstallEditorBody {
    /// The kit: `table` or `kit.table`.
    kit: String,
}

/// `POST /kits/editors/install {kit}`: starts installing the kit's editor package (`202`);
/// `GET /kits/editors` follows its download.
async fn install_editor(State(state): State<KitsState>, _caller: RequireToken, JsonBody(body): JsonBody<InstallEditorBody>) -> ApiResult<Response> {
    let short = body.kit.strip_prefix("kit.").unwrap_or(&body.kit).to_owned();
    if !known_kits(&state.kits).iter().any(|status| status["id"].as_str().and_then(|id| id.strip_prefix("kit.")) == Some(short.as_str())) {
        return Err(app_error(KitError::UnknownKit(body.kit)));
    }
    let store =
        state.editors.clone().ok_or_else(|| ApiError::new(409, 40908, "this server keeps no editor packages").with_data(json!({ "reason": "no_store" })))?;
    let started = tokio::task::spawn_blocking(move || store.install(&short))
        .await
        .map_err(|error| ApiError::new(500, 50000, error.to_string()))?
        .map_err(|why| ApiError::new(409, 40909, why).with_data(json!({ "reason": "unavailable" })))?;
    let mut response = ok(json!({ "started": started }));
    *response.status_mut() = http::StatusCode::ACCEPTED;
    Ok(response)
}

// The replica an editor page keeps beside its document (Kit UI protocol `host/replicaRead`,
// `host/replicaWrite`): `.kition/replicas/<key>/replica.bin`, `<key>` the first 32 hex digits of
// the SHA-256 of the workspace path, with `meta.json` `{ path, kit, fileStamp }`. The body of both
// routes is the snapshot's length (8 bytes, little-endian), the snapshot, then the blobs; the
// file stamp the replica belongs to travels in the `Kition-File-Stamp` header. The kit decides
// whether a replica still belongs to its file.

/// Where the replicas are kept, in the workspace.
pub const REPLICAS_DIR: &str = ".kition/replicas";
const FILE_STAMP_HEADER: &str = "kition-file-stamp";

#[derive(Deserialize)]
struct ReplicaQuery {
    path: String,
    kit: String,
}

fn replica_dir(kits: &KitManager, path: &str) -> ApiResult<std::path::PathBuf> {
    use sha2::Digest;
    let workspace = kits.workspace_dir().ok_or_else(|| app_error(KitError::NoWorkspace))?;
    let digest = sha2::Sha256::digest(path.as_bytes());
    let key: String = digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    Ok(workspace.join(REPLICAS_DIR).join(key))
}

/// `GET /kits/replicas?path=&kit=`: the replica `kit`'s editor keeps for `path`; `204` (no
/// content) when none is kept, which is no failure: a document opens from its file then.
async fn read_replica(State(state): State<KitsState>, _caller: RequireToken, Query(query): Query<ReplicaQuery>) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    state.kits.resolve(path).map_err(app_error)?;
    let dir = replica_dir(&state.kits, path)?;
    let none = || http::StatusCode::NO_CONTENT.into_response();
    let Some(meta) = std::fs::read(dir.join("meta.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) else {
        return Ok(none());
    };
    if meta["path"].as_str() != Some(path) || meta["kit"].as_str() != Some(query.kit.as_str()) {
        return Ok(none());
    }
    let stamp = meta["fileStamp"].as_str().unwrap_or_default().to_owned();
    let Ok(bytes) = std::fs::read(dir.join("replica.bin")) else {
        return Ok(none());
    };
    let mut response = ([(header::CONTENT_TYPE, "application/octet-stream".to_owned()), (header::CACHE_CONTROL, "no-store".to_owned())], bytes).into_response();
    if let Ok(value) = http::HeaderValue::from_str(&stamp) {
        response.headers_mut().insert(FILE_STAMP_HEADER, value);
    }
    Ok(response)
}

/// `PUT /kits/replicas?path=&kit=`: keeps the replica `kit`'s editor saved with `path`, written
/// whole and then renamed into place.
async fn write_replica(
    State(state): State<KitsState>,
    _caller: RequireToken,
    Query(query): Query<ReplicaQuery>,
    headers: http::HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    state.kits.resolve(path).map_err(app_error)?;
    if state.kits.kit_for_path(path).is_none_or(|kit| kit.id != query.kit) {
        return Err(app_error(KitError::InvalidPath(format!("{} does not edit `{path}`", query.kit))));
    }
    let length = body.get(..8).and_then(|bytes| bytes.try_into().ok()).map(u64::from_le_bytes);
    if length.is_none_or(|length| length > (body.len() as u64).saturating_sub(8)) {
        return Err(ApiError::new(400, 40004, "a replica is its snapshot's length (8 bytes, little-endian), the snapshot, then the blobs"));
    }
    let stamp = headers.get(FILE_STAMP_HEADER).and_then(|value| value.to_str().ok()).unwrap_or_default();
    let dir = replica_dir(&state.kits, path)?;
    let meta = json!({ "path": path, "kit": query.kit, "fileStamp": stamp });
    let written = (|| {
        std::fs::create_dir_all(&dir)?;
        let scratch = dir.join(format!(".replica-{}.tmp", std::process::id()));
        std::fs::write(&scratch, &body)?;
        std::fs::rename(&scratch, dir.join("replica.bin"))?;
        let scratch = dir.join(format!(".meta-{}.tmp", std::process::id()));
        std::fs::write(&scratch, meta.to_string())?;
        std::fs::rename(&scratch, dir.join("meta.json"))
    })();
    written.map_err(|error| ApiError::new(500, 50011, format!("could not keep the replica of `{path}`: {}", error.kind())))?;
    Ok(ok(json!({ "path": path, "bytes": body.len() })))
}

// The person's view state of a document (Kit UI protocol `host/viewStateRead`,
// `host/viewStateWrite`, section 7n): `<data>/view-state/<key>.bin`, `<key>` the first 32 hex
// digits of the SHA-256 of the workspace path, in the server's own data folder, never in the
// workspace, the replica or the file. The body of `GET` and `PUT` is the JSON's length (8 bytes,
// little-endian), the JSON of the state (an object), then the optional bytes; the file keeps a
// header `{ path, kit }` before it the same way. A missing or damaged entry reads as none (`204`).

/// The largest view state: its JSON and its bytes (Kit UI protocol `VIEW_STATE_JSON_LIMIT`,
/// `VIEW_STATE_BYTES_LIMIT`).
pub const VIEW_STATE_JSON_LIMIT: usize = 256 * 1024;
pub const VIEW_STATE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
/// Where view state is kept, in the server's data folder.
pub const VIEW_STATE_DIR: &str = "view-state";

/// Splits `bytes` at its little-endian length prefix: the part it counts and the rest.
fn framed(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let length = usize::try_from(u64::from_le_bytes(bytes.get(..8)?.try_into().ok()?)).ok()?;
    let rest = bytes.get(8..)?;
    (length <= rest.len()).then(|| rest.split_at(length))
}

fn frame(head: &[u8], rest: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + head.len() + rest.len());
    out.extend_from_slice(&(head.len() as u64).to_le_bytes());
    out.extend_from_slice(head);
    out.extend_from_slice(rest);
    out
}

/// The view state's file for `path` in the server's data folder; checks the path as every route does.
fn view_state_file(state: &KitsState, path: &str) -> ApiResult<std::path::PathBuf> {
    use sha2::Digest;
    state.kits.resolve(path).map_err(app_error)?;
    let data = state.data.as_ref().ok_or_else(|| ApiError::new(404, 40402, "this server keeps no view state").with_data(json!({ "reason": "unsupported" })))?;
    let digest = sha2::Sha256::digest(path.as_bytes());
    let key: String = digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    Ok(data.join(VIEW_STATE_DIR).join(format!("{key}.bin")))
}

/// `GET /kits/view-state?path=&kit=`: the view state `kit`'s editor keeps for `path`; `204` when
/// none is kept or it is damaged, which is no failure.
async fn read_view_state(State(state): State<KitsState>, _caller: RequireToken, Query(query): Query<ReplicaQuery>) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    let file = view_state_file(&state, path)?;
    let none = || http::StatusCode::NO_CONTENT.into_response();
    let Ok(kept) = std::fs::read(&file) else {
        return Ok(none());
    };
    let Some((head, body)) = framed(&kept) else {
        return Ok(none());
    };
    let head = serde_json::from_slice::<Value>(head).unwrap_or_default();
    if head["path"].as_str() != Some(path) || head["kit"].as_str() != Some(query.kit.as_str()) {
        return Ok(none());
    }
    let valid = framed(body).is_some_and(|(json, _)| serde_json::from_slice::<Value>(json).is_ok_and(|value| value.is_object()));
    if !valid {
        return Ok(none());
    }
    Ok(([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")], body.to_vec()).into_response())
}

/// `PUT /kits/view-state?path=&kit=`: replaces the view state `kit`'s editor keeps for `path`,
/// written whole and renamed into place; `413` (`too-large`) over the limits.
async fn write_view_state(
    State(state): State<KitsState>,
    _caller: RequireToken,
    Query(query): Query<ReplicaQuery>,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    let file = view_state_file(&state, path)?;
    if state.kits.kit_for_path(path).is_none_or(|kit| kit.id != query.kit) {
        return Err(app_error(KitError::InvalidPath(format!("{} does not edit `{path}`", query.kit))));
    }
    let Some((json, bytes)) = framed(&body) else {
        return Err(ApiError::new(400, 40005, "a view state is its JSON's length (8 bytes, little-endian), the JSON, then the bytes"));
    };
    if json.len() > VIEW_STATE_JSON_LIMIT || bytes.len() > VIEW_STATE_BYTES_LIMIT {
        return Err(ApiError::new(413, 41302, "a view state is at most 256 KB of JSON and 16 MB of bytes").with_data(json!({ "reason": "too-large" })));
    }
    if !serde_json::from_slice::<Value>(json).is_ok_and(|value| value.is_object()) {
        return Err(ApiError::new(400, 40005, "a view state's JSON is an object"));
    }
    let head = json!({ "path": path, "kit": query.kit }).to_string();
    let written = (|| {
        let dir = file.parent().ok_or_else(|| std::io::Error::other("no folder"))?;
        std::fs::create_dir_all(dir)?;
        let scratch = dir.join(format!(".view-{}.tmp", std::process::id()));
        std::fs::write(&scratch, frame(head.as_bytes(), &body))?;
        std::fs::rename(&scratch, &file)
    })();
    written.map_err(|error| ApiError::new(500, 50012, format!("could not keep the view state of `{path}`: {}", error.kind())))?;
    Ok(ok(json!({ "path": path, "bytes": body.len() })))
}

/// `DELETE /kits/view-state?path=&kit=`: forgets the view state of `path` (none kept is no failure).
async fn delete_view_state(State(state): State<KitsState>, _caller: RequireToken, Query(query): Query<ReplicaQuery>) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    let file = view_state_file(&state, path)?;
    match std::fs::remove_file(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ApiError::new(500, 50012, format!("could not forget the view state of `{path}`: {}", error.kind()))),
    }
    Ok(ok(json!({ "path": path })))
}

// File grants (Kition platform `KitFiles 1.1`, `kition_kit_host::files`): the editor's host page
// serves a kit's `files/*` requests through these routes. A grant session is bound to a kit, the
// person, and the document its editor opened; handles are bound to their session. No answer
// names a path, and no route takes one for the person's pick or drop: the person picks among the
// choices `POST /kits/grants/choices` offers, and the grant names the choice.

/// The largest chunk one `files/write` stages.
const MAX_CHUNK_BYTES: usize = 64 << 20;

/// Maps a refused file request to a status; `data.reason` is the KitFiles reason (section 10),
/// `null` for malformed parameters.
fn file_error(error: kition_kit_host::files::FileError) -> ApiError {
    use kition_kit_host::files::FileError;
    let (status, code) = match &error {
        FileError::NotGranted(_) => (403, 40310),
        FileError::NotAllowed(_) => (403, 40311),
        FileError::NotFound => (404, 40410),
        FileError::AlreadyCommitted => (409, 40910),
        FileError::Conflict(_) => (409, 40911),
        FileError::UnsavedEdits => (409, 40912),
        FileError::Quota => (413, 41310),
        FileError::Io => (500, 50010),
        FileError::BadParams(_) => (400, 40010),
    };
    ApiError::new(status, code, error.to_string()).with_data(json!({ "reason": error.reason() }))
}

/// The person a request acts for, when the server that mounts the routes tells people apart (it
/// puts this in the request's extensions); [`PERSON`] otherwise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal(pub String);

/// The person behind a server that has one (`kition gateway`: whoever holds its token).
pub const PERSON: &str = "person:local";

/// Who calls a grant route: every grant route takes it, so it is the one place a caller check
/// lives. The call must have carried the API token (`kition_http_guard::gate`): a signed URL or
/// an open route never reaches a grant, even if a router were mounted without the gate. The
/// principal is the person a session's handles are bound to (FA1).
struct GrantCaller {
    principal: String,
}

impl<S: Send + Sync> FromRequestParts<S> for GrantCaller {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut http::request::Parts, state: &S) -> Result<Self, Self::Rejection> {
        RequireToken::from_request_parts(parts, state).await?;
        let principal = parts.extensions.get::<Principal>().map_or_else(|| PERSON.to_owned(), |principal| principal.0.clone());
        Ok(Self { principal })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenGrantSessionBody {
    kit: String,
    #[serde(default)]
    document: Option<String>,
    #[serde(default)]
    files: kition_kit_host::files::FilesManifest,
    #[serde(default)]
    read_only: bool,
}

/// `POST /kits/grants/sessions`: opens a grant session for a kit's editor page.
async fn open_grant_session(State(state): State<KitsState>, caller: GrantCaller, JsonBody(body): JsonBody<OpenGrantSessionBody>) -> ApiResult<Response> {
    let session = state
        .kits
        .grants()
        .open_session(kition_kit_host::files::SessionRequest {
            kit: &body.kit,
            principal: &caller.principal,
            document: body.document.as_deref(),
            manifest: body.files,
            read_only: body.read_only,
        })
        .map_err(file_error)?;
    Ok(ok(json!({ "session": session })))
}

/// `GET /kits/grants/sessions/{session}`: the session's handles and grant log (FA16).
async fn grant_session(State(state): State<KitsState>, caller: GrantCaller, Path(session): Path<String>) -> ApiResult<Response> {
    let view = state.kits.grants().view(&session, &caller.principal).map_err(file_error)?;
    Ok(ok(view))
}

/// `DELETE /kits/grants/sessions/{session}`: ends the session; its handles expire (FA4).
async fn end_grant_session(State(state): State<KitsState>, caller: GrantCaller, Path(session): Path<String>) -> Response {
    let revoked = state.kits.grants().end_session(&session, &caller.principal);
    ok(json!({ "revoked": revoked }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChoicesBody {
    session: String,
    /// A folder choice an earlier answer offered; the workspace's top folder without it.
    #[serde(default)]
    folder: Option<String>,
}

/// `POST /kits/grants/choices`: the entries of a folder the person may pick for the session's
/// kit, `{ folder, choices: [{ choice, name, kind }] }`, `folder` being the listed folder's own
/// choice.
async fn grant_choices(State(state): State<KitsState>, caller: GrantCaller, JsonBody(body): JsonBody<ChoicesBody>) -> ApiResult<Response> {
    let choices = state.kits.grants().choices(&body.session, &caller.principal, body.folder.as_deref()).map_err(file_error)?;
    Ok(ok(choices))
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum PersonFlow {
    Pick,
    Drop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantBody {
    session: String,
    /// What the person picked or dropped, as `POST /kits/grants/choices` offered it.
    choice: String,
    /// A new file the person named in the folder `choice` names (a save-as).
    #[serde(default)]
    name: Option<String>,
    rights: Vec<kition_kit_host::files::Right>,
    #[serde(default)]
    accept: Vec<String>,
    flow: PersonFlow,
}

/// `POST /kits/grants`: grants a handle on the file or folder the person picked or dropped.
async fn grant_file(State(state): State<KitsState>, caller: GrantCaller, JsonBody(body): JsonBody<GrantBody>) -> ApiResult<Response> {
    let flow = match body.flow {
        PersonFlow::Pick => kition_kit_host::files::Flow::Pick,
        PersonFlow::Drop => kition_kit_host::files::Flow::Drop,
    };
    let stat = state
        .kits
        .grants()
        .grant_choice(&body.session, &caller.principal, &body.choice, body.name.as_deref(), &body.rights, &body.accept, flow)
        .map_err(file_error)?;
    Ok(ok(stat))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFileBody {
    session: String,
    suggested_name: String,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

/// `POST /kits/grants/create`: `files/create`, a handle on a new file under an unused name.
async fn create_file(State(state): State<KitsState>, caller: GrantCaller, JsonBody(body): JsonBody<CreateFileBody>) -> ApiResult<Response> {
    let stat =
        state.kits.grants().create(&body.session, &caller.principal, &body.suggested_name, body.mime.as_deref(), body.folder.as_deref()).map_err(file_error)?;
    Ok(ok(stat))
}

#[derive(Deserialize)]
struct ReleaseBody {
    session: String,
    handles: Vec<String>,
}

/// `POST /kits/grants/release`: `files/release`; unknown and expired handles are ignored.
async fn release_files(State(state): State<KitsState>, caller: GrantCaller, JsonBody(body): JsonBody<ReleaseBody>) -> Response {
    state.kits.grants().release(&body.session, &caller.principal, &body.handles);
    ok(json!({}))
}

#[derive(Deserialize)]
struct SessionQuery {
    session: String,
}

/// `GET /kits/grants/{handle}?session=`: `files/stat`.
async fn stat_file(State(state): State<KitsState>, caller: GrantCaller, Path(handle): Path<String>, Query(query): Query<SessionQuery>) -> ApiResult<Response> {
    let stat = state.kits.grants().stat(&query.session, &caller.principal, &handle).map_err(file_error)?;
    Ok(ok(stat))
}

/// `GET /kits/grants/{handle}/list?session=`: `files/list`.
async fn list_folder(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<SessionQuery>,
) -> ApiResult<Response> {
    let files = state.kits.grants().list(&query.session, &caller.principal, &handle).map_err(file_error)?;
    Ok(ok(json!({ "files": files })))
}

#[derive(Deserialize)]
struct ReadQuery {
    session: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    length: Option<u64>,
}

/// `GET /kits/grants/{handle}/content?session=&offset=&length=`: `files/read`. The body is the
/// bytes; `ETag` is the file's version and `Kition-File-Size` its whole size.
async fn read_file(State(state): State<KitsState>, caller: GrantCaller, Path(handle): Path<String>, Query(query): Query<ReadQuery>) -> ApiResult<Response> {
    let read = state.kits.grants().read(&query.session, &caller.principal, &handle, query.offset, query.length).map_err(file_error)?;
    let mut response = (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::ETAG, read.version),
            (http::HeaderName::from_static("kition-file-size"), read.size.to_string()),
        ],
        read.bytes,
    )
        .into_response();
    kition_http_guard::files::harden(response.headers_mut());
    Ok(response)
}

#[derive(Deserialize)]
struct WriteQuery {
    session: String,
    offset: u64,
    #[serde(default, rename = "final")]
    last: bool,
    #[serde(default)]
    expected: Option<String>,
}

/// `PUT /kits/grants/{handle}/content?session=&offset=&final=&expected=`: `files/write`, one
/// chunk of the raw request body. Answers `{}`, or `{ version }` for the final chunk.
async fn write_chunk(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<WriteQuery>,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let version = state
        .kits
        .write_granted(
            &query.session,
            &caller.principal,
            &handle,
            kition_kit_host::files::WriteChunk { bytes: &body, offset: query.offset, last: query.last, expected: query.expected.as_deref() },
        )
        .await
        .map_err(file_error)?;
    Ok(ok(match version {
        Some(version) => json!({ "version": version }),
        None => json!({}),
    }))
}

// Drafts an agent kept beside workspace files (`kition mcp --drafts`, KHP A27): the person
// reviews, merges, or discards them here. The agent can do none of these (A14).

/// Maps a refused draft command to a status a page can branch on; `data.reason` is the command's
/// code (`not-found`, `stale`, or a kit tool's code).
fn draft_error(error: kition_kits::drafts::DraftError) -> ApiError {
    let (status, code) = match error.code {
        "not-found" => (404, 40403),
        "stale" => (409, 40905),
        _ => (400, 40003),
    };
    ApiError::new(status, code, error.message).with_data(json!({ "reason": error.code }))
}

/// `GET /kits/drafts`: the workspace's headless drafts, oldest first, each with `stale`.
async fn list_drafts(State(state): State<KitsState>, _caller: RequireToken) -> Response {
    let drafts = state.kits.workspace_dir().map(kition_kits::drafts::list).unwrap_or_default();
    ok(json!({ "drafts": drafts }))
}

#[derive(Deserialize)]
struct DraftQuery {
    path: String,
    #[serde(default)]
    previews: bool,
}

/// `GET /kits/drafts/compare?path=&previews=`: what merging the draft of `path` would change.
async fn compare_draft(State(state): State<KitsState>, _caller: RequireToken, Query(query): Query<DraftQuery>) -> ApiResult<Response> {
    let path = workspace_path(&query.path)?;
    let answer = kition_kits::drafts::compare(&state.kits, path, query.previews).await.map_err(draft_error)?;
    Ok(ok(answer))
}

#[derive(Deserialize)]
struct MergeDraftBody {
    path: String,
    /// Replaces the file even though it changed since the draft forked (drops those edits).
    #[serde(default)]
    overwrite: bool,
}

/// `POST /kits/drafts/merge`: writes the draft of `path` as the file; refused as `stale` (409)
/// when the file changed since the draft forked, unless `overwrite`.
async fn merge_draft(State(state): State<KitsState>, _caller: RequireToken, JsonBody(body): JsonBody<MergeDraftBody>) -> ApiResult<Response> {
    let path = workspace_path(&body.path)?;
    let answer = kition_kits::drafts::merge(&state.kits, path, body.overwrite).await.map_err(draft_error)?;
    Ok(ok(answer))
}

#[derive(Deserialize)]
struct DiscardDraftBody {
    path: String,
}

/// `POST /kits/drafts/discard`: drops the draft of `path`; the file stays as it is.
async fn discard_draft(State(state): State<KitsState>, _caller: RequireToken, JsonBody(body): JsonBody<DiscardDraftBody>) -> ApiResult<Response> {
    let path = workspace_path(&body.path)?;
    let answer = kition_kits::drafts::discard(&state.kits, path).await.map_err(draft_error)?;
    Ok(ok(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_paths_are_relative_plain_and_visible() {
        assert_eq!(workspace_path(" art/a b.png ").ok(), Some("art/a b.png"));
        for (refused, code) in [
            ("", 40000),
            ("art\\a.png", 40000),
            ("/etc/passwd", 40302),
            ("../outside.png", 40302),
            ("art/../../outside.png", 40302),
            ("art//a.png", 40302),
            ("./a.png", 40302),
            ("C:/Windows/a.png", 40302),
            (".kition/drafts/x", 40302),
            ("art/.secret.png", 40302),
        ] {
            assert_eq!(workspace_path(refused).err().map(|error| error.code), Some(code), "{refused:?}");
        }
    }
}
