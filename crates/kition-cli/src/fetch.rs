//! Reading a kit index named by an `http://` or `https://` address or a file on this machine (an
//! index made locally, as tests and mirrors do; `KITION_INDEX`). Packages come from npm
//! registries (`registry.rs`).
//!
//! HTTPS is rustls with the Mozilla root certificates built in, so nothing depends on the system's
//! TLS library. Proxies come from the usual variables: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`
//! (and their lowercase forms), with `NO_PROXY`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Whether `location` is a web address rather than a file.
pub fn is_url(location: &str) -> bool {
    let lower = location.get(..8).unwrap_or(location).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(format!("kition/{}", crate::VERSION))
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(300)))
        .build()
        .new_agent()
}

fn open(location: &str) -> Result<Box<dyn Read>, String> {
    if is_url(location) {
        let response = agent().get(location).call().map_err(|error| match error {
            ureq::Error::StatusCode(status) => format!("{location} answered HTTP {status}"),
            other => format!("cannot reach {location}: {other}"),
        })?;
        Ok(Box::new(response.into_body().into_reader()))
    } else {
        let file = std::fs::File::open(location).map_err(|error| format!("cannot read {location}: {error}"))?;
        Ok(Box::new(file))
    }
}

/// The text at `location`, at most `limit` bytes.
pub fn read_text(location: &str, limit: u64) -> Result<String, String> {
    let mut text = String::new();
    open(location)?.take(limit + 1).read_to_string(&mut text).map_err(|error| format!("cannot read {location}: {error}"))?;
    if text.len() as u64 > limit {
        return Err(format!("{location} is larger than {limit} bytes"));
    }
    Ok(text)
}

/// A path for a temporary file or folder in `folder`, with a random name.
pub fn scratch(folder: &Path, prefix: &str) -> PathBuf {
    let tag: u64 = rand::random();
    folder.join(format!("{prefix}-{}-{tag:016x}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_told_from_files() {
        assert!(is_url("HTTPS://x") && is_url("http://127.0.0.1:1/x") && !is_url("/tmp/x") && !is_url("C:\\x"));
    }
}
