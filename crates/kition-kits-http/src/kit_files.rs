//! `/kit-files/<path>`: the workspace as kits read it (`host/read`, `host/stamp`, and lent reads
//! by kit engines, Kit UI protocol), `GET` and `HEAD` with single byte ranges. It never serves a
//! hidden file or folder (the host's own store `.kition/`, other documents' replicas and comment
//! threads, among them), a folder, nor a file a link leads to outside the workspace or into a
//! hidden folder (rule LR2). Each file is opened once and checked to be the file at the checked
//! path (`kition_kit_host::files::open_inside`), so a link swapped in between the check and the
//! read is refused. A refused path is answered like a missing one, `404`. Every answer carries
//! `nosniff`, and the scriptable types a sandboxing CSP (`kition_http_guard::files`).
//!
//! A stamp (`HEAD`) costs one `open` and two `stat`s: the kit editor polls it every two seconds.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};

/// The router serving `workspace` (canonical) at its root; mount it at `/kit-files`.
pub fn router(workspace: &Path) -> Router {
    let root = Arc::new(std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf()));
    kition_http_guard::files::file_service(Router::new().fallback(serve).with_state(root))
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

/// The workspace-relative path a request path names, when no segment is hidden (`.` and `..`
/// among them) or empty.
pub fn readable_path(request_path: &str) -> Option<String> {
    let decoded = kition_http_guard::files::percent_decoded(request_path);
    let relative = decoded.strip_prefix('/').unwrap_or(&decoded);
    if relative.is_empty() || relative.contains('\\') || relative.contains('\0') {
        return None;
    }
    if relative.split('/').any(|segment| segment.is_empty() || segment.starts_with('.')) {
        return None;
    }
    Some(relative.to_owned())
}

async fn serve(State(root): State<Arc<PathBuf>>, request: Request) -> Response {
    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        let mut refused = status(StatusCode::METHOD_NOT_ALLOWED);
        refused.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET,HEAD"));
        return refused;
    }
    let Some(relative) = readable_path(request.uri().path()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let headers = request.headers().clone();
    let opened = tokio::task::spawn_blocking(move || {
        let (file, real) = kition_kit_host::files::open_inside(&root, &root.join(&relative), false)?;
        let metadata = file.metadata().ok().filter(std::fs::Metadata::is_file)?;
        Some((file, real, metadata))
    })
    .await
    .ok()
    .flatten();
    let Some((file, real, metadata)) = opened else {
        return status(StatusCode::NOT_FOUND);
    };
    answer(method, &headers, file, &real, &metadata)
}

fn answer(method: Method, request: &HeaderMap, file: std::fs::File, real: &Path, metadata: &std::fs::Metadata) -> Response {
    let size = metadata.len();
    let modified = metadata.modified().ok();
    let mime = mime_guess::from_path(real).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(modified) = modified
        && let Ok(value) = HeaderValue::from_str(&httpdate::fmt_http_date(modified))
    {
        headers.insert(header::LAST_MODIFIED, value);
    }
    if not_modified(request, modified) {
        let mut response = status(StatusCode::NOT_MODIFIED);
        response.headers_mut().extend(headers);
        return response;
    }
    let (code, start, length) = match request.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        None => (StatusCode::OK, 0, size),
        Some(range) => match byte_range(range, size) {
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
            // A range this server does not serve (several, or another unit): the whole file.
            None => (StatusCode::OK, 0, size),
        },
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        match file_body(file, start, length) {
            Some(body) => body,
            None => return status(StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    let mut response = (code, body).into_response();
    response.headers_mut().extend(headers);
    response
}

/// `length` bytes of `file` from `start`, streamed.
fn file_body(mut file: std::fs::File, start: u64, length: u64) -> Option<Body> {
    use std::io::Seek;
    use tokio::io::AsyncReadExt;
    file.seek(std::io::SeekFrom::Start(start)).ok()?;
    Some(Body::from_stream(tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file).take(length))))
}

/// Whether `If-Modified-Since` says the client has this version (and it named no range).
fn not_modified(request: &HeaderMap, modified: Option<SystemTime>) -> bool {
    let (Some(since), Some(modified)) = (request.get(header::IF_MODIFIED_SINCE).and_then(|value| value.to_str().ok()), modified) else {
        return false;
    };
    let Ok(since) = httpdate::parse_http_date(since) else {
        return false;
    };
    // HTTP dates have whole seconds.
    let seconds = |time: SystemTime| time.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |since| since.as_secs());
    seconds(modified) <= seconds(since)
}

/// A single byte range of a file of `size` bytes: `Some(Ok((first, last)))`, both inclusive;
/// `Some(Err(()))` when it is not satisfiable; `None` when it is not one byte range.
fn byte_range(header: &str, size: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (first, last) = (first.trim(), last.trim());
    let range = if first.is_empty() {
        let suffix: u64 = last.parse().ok()?;
        if suffix == 0 || size == 0 {
            return Some(Err(()));
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let first: u64 = first.parse().ok()?;
        let last: u64 = if last.is_empty() { size.saturating_sub(1) } else { last.parse::<u64>().ok()?.min(size.saturating_sub(1)) };
        if first >= size || last < first {
            return Some(Err(()));
        }
        (first, last)
    };
    Some(Ok(range))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_single_byte_ranges() {
        assert_eq!(byte_range("bytes=0-3", 10), Some(Ok((0, 3))));
        assert_eq!(byte_range("bytes=4-", 10), Some(Ok((4, 9))));
        assert_eq!(byte_range("bytes=-3", 10), Some(Ok((7, 9))));
        assert_eq!(byte_range("bytes=5-100", 10), Some(Ok((5, 9))));
        assert_eq!(byte_range("bytes=10-", 10), Some(Err(())));
        assert_eq!(byte_range("bytes=4-2", 10), Some(Err(())));
        assert_eq!(byte_range("bytes=0-1,4-5", 10), None);
        assert_eq!(byte_range("items=0-1", 10), None);
    }

    #[test]
    fn refuses_hidden_empty_and_parent_segments() {
        assert_eq!(readable_path("/art/a%20b.png").as_deref(), Some("art/a b.png"));
        for refused in ["/", "/.kition/x", "/art/.secret.png", "/art/../x", "/art/%2e%2e/x", "/a//b", "/a\\b", "/%2Ekition/x"] {
            assert_eq!(readable_path(refused), None, "{refused}");
        }
    }
}
