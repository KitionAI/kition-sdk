//! `/page/`: the gateway's editor page (`packages/gateway-page`, built into `page/` beside this
//! crate's sources and embedded here), which opens one workspace file in its kit's editor, is the
//! Kit AI bridge's window for it, and reviews the agent's drafts:
//!
//! - `/page/?path=<workspace path>`: the editor;
//! - `/page/review?path=<workspace path>`: the review of the agent's draft of the file;
//! - `/page/page.js`, `/page/page.css`: its script and style.
//!
//! The page names everything relative to itself, so it works under any path prefix a same-origin
//! proxy puts it at. Its HTML carries a content security policy that lets it load its own origin
//! only and be framed by its own origin only. Everything is `no-cache` with an `ETag` (the
//! content's SHA-256), so a new gateway's page is never mixed with an old one's script.

use std::sync::OnceLock;

use axum::Router;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use http::{HeaderValue, Method, StatusCode, header};
use sha2::Digest;

/// The editor page's content security policy.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'none'; object-src 'none'";

/// The page's files: name, content type, bytes.
const FILES: [(&str, &str, &[u8]); 3] = [
    ("index.html", "text/html; charset=utf-8", include_bytes!("../page/index.html")),
    ("page.js", "text/javascript; charset=utf-8", include_bytes!("../page/page.js")),
    ("page.css", "text/css; charset=utf-8", include_bytes!("../page/page.css")),
];

/// The views the page shows, each its `index.html`.
const VIEWS: [&str; 3] = ["", "index.html", "review"];

fn etags() -> &'static [String; 3] {
    static ETAGS: OnceLock<[String; 3]> = OnceLock::new();
    ETAGS.get_or_init(|| {
        FILES.map(|(_, _, bytes)| {
            let digest = sha2::Sha256::digest(bytes);
            format!("\"{}\"", digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect::<String>())
        })
    })
}

/// The page's file a request path (below `/page`) names.
fn file_for(path: &str) -> Option<usize> {
    let name = path.strip_prefix('/')?;
    let name = if VIEWS.contains(&name) { "index.html" } else { name };
    FILES.iter().position(|(file, _, _)| *file == name)
}

/// The router serving the page at its root; mount it at `/page`.
pub fn router() -> Router {
    Router::new().fallback(serve)
}

async fn serve(request: Request) -> Response {
    let mut response = answer(&request);
    response.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

fn answer(request: &Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET,HEAD")]).into_response();
    }
    let Some(index) = file_for(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (_, mime, bytes) = FILES[index];
    let tag = &etags()[index];
    let mut headers = http::HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // The page's address carries the file it opens: never sent on to another site.
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if let Ok(value) = HeaderValue::from_str(tag) {
        headers.insert(header::ETAG, value);
    }
    if mime.starts_with("text/html") {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    }
    let fresh = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|wanted| wanted.split(',').any(|candidate| candidate.trim() == tag));
    if fresh {
        return (StatusCode::NOT_MODIFIED, headers).into_response();
    }
    let body = if request.method() == Method::HEAD { Vec::new() } else { bytes.to_vec() };
    (StatusCode::OK, headers, body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_are_the_page_and_nothing_else_is_served() {
        assert_eq!(file_for("/"), Some(0));
        assert_eq!(file_for("/review"), Some(0));
        assert_eq!(file_for("/page.js"), Some(1));
        for refused in ["", "/../Cargo.toml", "/review/x", "/src/main.ts", "/page.js/x", "/PAGE.JS"] {
            assert_eq!(file_for(refused), None, "{refused}");
        }
    }
}
