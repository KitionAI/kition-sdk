//! What a served workspace file carries so it never runs as a page of the server's origin:
//! `X-Content-Type-Options: nosniff` on every answer, and `Content-Security-Policy: sandbox` on
//! the types a browser would run script in (a workspace HTML or SVG file opened at its URL):
//! a sandbox without `allow-scripts` runs no script and gives the page an opaque origin. PDFs and
//! media keep their viewers.

use axum::Router;
use axum::response::Response;
use http::{HeaderMap, HeaderValue, header};

/// The types a browser runs script in when it opens them.
const SCRIPTABLE: [&str; 5] = ["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"];

/// Adds the file headers to `headers`, by the answer's `Content-Type`.
pub fn harden(headers: &mut HeaderMap) {
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    let scriptable = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| SCRIPTABLE.contains(&mime.trim().to_ascii_lowercase().as_str()));
    if scriptable {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    }
}

/// `files` with [`harden`] on every answer.
pub fn file_service(files: Router) -> Router {
    files.layer(axum::middleware::map_response(|mut response: Response| async move {
        harden(response.headers_mut());
        response
    }))
}

/// `path` with its `%XX` escapes decoded; an invalid escape stays as written.
pub fn percent_decoded(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        let escaped =
            (byte == b'%').then(|| bytes.get(index + 1..index + 3)).flatten().and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        match escaped {
            Some(decoded) => {
                out.push(decoded);
                index += 3;
            }
            None => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scriptable_types_are_sandboxed_and_every_file_is_nosniff() {
        for (mime, sandboxed) in [
            ("text/html; charset=utf-8", true),
            ("image/svg+xml", true),
            ("APPLICATION/XHTML+XML", true),
            ("image/png", false),
            ("application/pdf", false),
            ("text/plain", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            harden(&mut headers);
            assert_eq!(headers.get(header::X_CONTENT_TYPE_OPTIONS).and_then(|v| v.to_str().ok()), Some("nosniff"), "{mime}");
            assert_eq!(headers.get(header::CONTENT_SECURITY_POLICY).is_some(), sandboxed, "{mime}");
        }
    }

    #[test]
    fn decodes_escapes_and_keeps_broken_ones() {
        assert_eq!(percent_decoded("/a%20b/%2e%2e/c%zz%2"), "/a b/../c%zz%2");
    }
}
