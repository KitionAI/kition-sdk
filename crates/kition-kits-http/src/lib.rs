//! The kits' HTTP API over `kition-kits` for one workspace, as Kition's runtime serves it and as
//! `kition gateway` serves it on loopback ([`gateway`]):
//!
//! - `GET /kits`: the kits and whether each is installed;
//! - `PUT /kits/files`: an in-page kit editor saves its document or writes a new file;
//! - `/kits/grants/*`: file grants for kit editor pages (Kition platform KitFiles 1.1);
//! - `GET /kits/bridge` (server-sent events) and `POST /kits/bridge?session=`: the Kit AI bridge,
//!   which runs the agent's calls in the editor that has the file open (`kition_kits::bridge`);
//! - `/kits/drafts{,/compare,/merge,/discard}`: the person's review of the agent's headless drafts;
//! - `POST /mcp/kits`: the kit tools as an MCP server over Streamable HTTP ([`mcp`]).
//!
//! The paths are relative to where the router is mounted (`/api/v1` in the gateway and in
//! Kition's runtime). JSON answers use the envelope `{code, message, data}`
//! (`kition_http_guard::envelope`). Every route takes the caller from the transport guard in front
//! of it (`kition_http_guard::guard`): the API token, or for the bridge stream a signed URL; a
//! router mounted without the guard refuses every request. `/kit-files/*` is [`kit_files`].

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod gateway;
pub mod kit_files;
pub mod mcp;

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

/// What the routes serve: the workspace's kits, and the MCP connections that told themselves apart.
#[derive(Clone)]
pub struct KitsState {
    pub kits: KitManager,
    pub mcp: Arc<mcp::Connections>,
}

impl KitsState {
    pub fn new(kits: KitManager) -> Self {
        Self { kits, mcp: Arc::default() }
    }
}

/// The routes, relative to where they are mounted.
pub fn router(state: KitsState) -> Router {
    Router::new()
        .route("/kits", get(list))
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

async fn list(State(state): State<KitsState>, _caller: RequireToken) -> Response {
    ok(json!({ "kits": state.kits.statuses() }))
}

/// The largest file an in-page editor may save in one request.
const MAX_FILE_BYTES: usize = 2 << 30;

#[derive(Deserialize)]
struct WriteFileQuery {
    path: String,
    /// The document an in-page editor opened, when the write saves it: only that file is
    /// replaced. Without it the write makes a new file (a new document or an export).
    document: Option<String>,
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
    state.kits.write_file(path, &body, write).map_err(app_error)?;
    Ok(ok(json!({ "path": query.path, "bytes": body.len() })))
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
