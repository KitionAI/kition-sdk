//! The kits' editor packages (each kit's own editor, its engine and fonts, as a Kit UI protocol
//! host loads it in a frame), for the gateway's editor page:
//!
//! - `GET /kits/editors`: each kit's editor as the page needs it ([`EditorEntry`]): the version a
//!   page should load, whether it is installed (and where the page loads it from, `base`), whether
//!   the kit index offers it, and how far its download has come;
//! - `POST /kits/editors/install {kit}`: starts installing a kit's editor package (first use);
//!   the page follows it through `GET /kits/editors`;
//! - `/kits-ui/<kit>@<version>/<file>` ([`router`]): the package's files.
//!
//! The store behind them is the host's ([`EditorStore`]): `kition gateway` serves its kit store's
//! packages (`kits/<kit>/ui/<version>/`) and development builds named with `--kit-ui`.
//!
//! The files are served as a static site the kit loads from relative addresses: `application/wasm`
//! for the engine, JavaScript modules and workers as `text/javascript`, fonts by their types,
//! `nosniff` on everything. Their names carry no content hash, so the version in the path is the
//! cache key: a store package is `Cache-Control: public, max-age=31536000, immutable` (a version
//! is published once and never replaced), a development build `no-cache`; both carry an `ETag`
//! (size and modification time) and answer `If-None-Match` with `304`. `GET` and `HEAD` only,
//! with single byte ranges as `/kit-files/` serves them, and never compressed here (a proxy in
//! front may). A path with an empty, `.`, `..` or hidden segment, a `\` or a NUL, or one a link
//! leads out of the package folder, is answered as missing (`404`). An HTML page may be framed by
//! its own origin only (`frame-ancestors 'self'`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;

/// Where the gateway serves the editor packages.
pub const PREFIX: &str = "/kits-ui";

/// An editor package's folder, as the store found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorPackage {
    /// The folder its `index.html` is in.
    pub root: PathBuf,
    /// The kit's `kit.json`, when it is not in `root` (a kit repository checkout's).
    pub manifest: Option<PathBuf>,
    /// A development build: it may change under the same version, so it is not cached for long.
    pub local: bool,
}

/// How far a download has come.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

/// A kit's editor as the page needs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorEntry {
    /// Its id: `kit.table`.
    pub id: String,
    /// The version a page should load (the headless kit's in use, or a development build's);
    /// `None` when none is known.
    pub version: Option<String>,
    pub installed: bool,
    /// A development build is served.
    pub local: bool,
    /// Whether the kit index offers this version's editor package (`None`: it cannot be read).
    pub available: Option<bool>,
    /// The download in progress.
    pub downloading: Option<Progress>,
    /// Why the last download failed.
    pub failed: Option<String>,
}

/// The host's editor packages.
pub trait EditorStore: Send + Sync + 'static {
    /// Each kit's editor; `kits` are the ids of the kits the gateway serves.
    fn listing(&self, kits: &[&str]) -> Vec<EditorEntry>;
    /// The package of `kit` (short name) at `version`, when it is there.
    fn package(&self, kit: &str, version: &str) -> Option<EditorPackage>;
    /// Starts installing the editor package of `kit` (short name) in the background; `Err` when
    /// it cannot start (the index lists none). Answers whether a download started (`false`: one
    /// is running already, or it is installed).
    fn install(&self, kit: &str) -> Result<bool, String>;
}

/// The address a page loads `kit`'s editor from, relative to the gateway's root:
/// `kits-ui/<kit>@<version>/`.
pub fn base(kit: &str, version: &str) -> String {
    format!("{}/{kit}@{version}/", PREFIX.trim_start_matches('/'))
}

/// The router serving `store`'s packages at its root; mount it at [`PREFIX`].
pub fn router(store: Arc<dyn EditorStore>) -> Router {
    Router::new().fallback(serve).with_state(store)
}

fn status(code: StatusCode) -> Response {
    let mut response = code.into_response();
    response.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

/// The kit, version and file a request path names (`/<kit>@<version>/<file>`, the file
/// `index.html` when it ends at the version's folder), when every segment is plain.
pub fn requested(request_path: &str) -> Option<(String, String, String)> {
    let decoded = kition_http_guard::files::percent_decoded(request_path);
    let relative = decoded.strip_prefix('/')?;
    if relative.contains('\\') || relative.contains('\0') {
        return None;
    }
    let (package, file) = relative.split_once('/')?;
    let (kit, version) = package.split_once('@')?;
    let plain_name = !kit.is_empty() && kit.starts_with(|c: char| c.is_ascii_lowercase()) && kit.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let plain_version = !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !plain_name || !plain_version || version.starts_with('.') {
        return None;
    }
    let file = if file.is_empty() { "index.html" } else { file };
    if file.split('/').any(|segment| segment.is_empty() || segment.starts_with('.')) {
        return None;
    }
    Some((kit.to_owned(), version.to_owned(), file.to_owned()))
}

/// The content type of a package file, by its extension.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("ktable" | "bin" | "kdm") | None => "application/octet-stream",
        Some(_) => "application/octet-stream",
    }
}

/// The file `file` names in `package`, when it is a file inside the package's folder (a link out
/// of it is refused); `kit.json` is the package's manifest wherever it is.
fn resolve(package: &EditorPackage, file: &str) -> Option<PathBuf> {
    if file == "kit.json"
        && let Some(manifest) = &package.manifest
    {
        return Some(manifest.clone()).filter(|path| path.is_file());
    }
    let root = std::fs::canonicalize(&package.root).ok()?;
    let real = std::fs::canonicalize(root.join(file)).ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(real)
}

async fn serve(State(store): State<Arc<dyn EditorStore>>, request: Request) -> Response {
    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        let mut refused = status(StatusCode::METHOD_NOT_ALLOWED);
        refused.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET,HEAD"));
        return refused;
    }
    let Some((kit, version, file)) = requested(request.uri().path()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let headers = request.headers().clone();
    let found = tokio::task::spawn_blocking(move || {
        let package = store.package(&kit, &version)?;
        let path = resolve(&package, &file)?;
        let file = std::fs::File::open(&path).ok()?;
        let metadata = file.metadata().ok().filter(std::fs::Metadata::is_file)?;
        Some((file, path, metadata, package.local))
    })
    .await
    .ok()
    .flatten();
    let Some((file, path, metadata, local)) = found else {
        return status(StatusCode::NOT_FOUND);
    };
    answer(&method, &headers, file, &path, &metadata, local)
}

/// A strong validator for a package file: its size and modification time.
fn etag(metadata: &std::fs::Metadata) -> String {
    let modified = metadata.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_nanos());
    format!("\"{:x}-{modified:x}\"", metadata.len())
}

fn answer(method: &Method, request: &HeaderMap, file: std::fs::File, path: &Path, metadata: &std::fs::Metadata, local: bool) -> Response {
    let size = metadata.len();
    let tag = etag(metadata);
    let mut headers = HeaderMap::new();
    let mime = content_type(path);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(if local { "no-cache" } else { "public, max-age=31536000, immutable" }));
    if let Ok(value) = HeaderValue::from_str(&tag) {
        headers.insert(header::ETAG, value);
    }
    if mime.starts_with("text/html") {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("frame-ancestors 'self'"));
    }
    let matches = request
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|wanted| wanted.split(',').any(|candidate| candidate.trim() == tag || candidate.trim() == "*"));
    if matches {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        response.headers_mut().extend(headers);
        return response;
    }
    let (code, start, length) = match request.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        None => (StatusCode::OK, 0, size),
        Some(range) => match crate::kit_files::byte_range(range, size) {
            Some(Ok((start, end))) => {
                if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")) {
                    headers.insert(header::CONTENT_RANGE, value);
                }
                (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
            }
            Some(Err(())) => {
                let mut response = status(StatusCode::RANGE_NOT_SATISFIABLE);
                if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                    response.headers_mut().insert(header::CONTENT_RANGE, value);
                }
                return response;
            }
            None => (StatusCode::OK, 0, size),
        },
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        match crate::kit_files::file_body(file, start, length) {
            Some(body) => body,
            None => return status(StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    let mut response = (code, body).into_response();
    response.headers_mut().extend(headers);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_name_a_kit_a_version_and_a_plain_file() {
        assert_eq!(requested("/table@0.5.6/"), Some(("table".into(), "0.5.6".into(), "index.html".into())));
        assert_eq!(requested("/table@0.5.6/assets/a%20b.js"), Some(("table".into(), "0.5.6".into(), "assets/a b.js".into())));
        assert_eq!(requested("/note@0.1.2-rc.1+build/engine/x.wasm").map(|(_, version, _)| version), Some("0.1.2-rc.1+build".into()));
        for refused in [
            "/table@0.5.6",
            "/table/x.js",
            "/Table@0.5.6/x.js",
            "/table@/x.js",
            "/table@0.5.6/../x.js",
            "/table@0.5.6/%2e%2e/x.js",
            "/table@0.5.6/a/../../x.js",
            "/table@0.5.6/.kition-package.json",
            "/table@0.5.6/a//b.js",
            "/table@0.5.6/a\\b.js",
            "/table@../x.js",
            "/table@0.5.6/a%00.js",
        ] {
            assert_eq!(requested(refused), None, "{refused}");
        }
    }

    #[test]
    fn types_follow_the_extension() {
        for (file, mime) in [
            ("engine/kit_bg.wasm", "application/wasm"),
            ("assets/kitEngine.worker-x.js", "text/javascript; charset=utf-8"),
            ("index.html", "text/html; charset=utf-8"),
            ("fonts/inter/Inter-Variable.ttf", "font/ttf"),
            ("fonts/x.woff2", "font/woff2"),
            ("kit.json", "application/json"),
            ("assets/index.css", "text/css; charset=utf-8"),
            ("templates/blank.ktable", "application/octet-stream"),
        ] {
            assert_eq!(content_type(Path::new(file)), mime, "{file}");
        }
    }
}
