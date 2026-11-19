//! Reading the kit index and downloading kit archives, from an `http://` or `https://` address or
//! from a file on this machine (an index made locally, a mirror on a shared drive).
//!
//! HTTPS is rustls with the Mozilla root certificates built in, so nothing depends on the system's
//! TLS library. Proxies come from the usual variables: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`
//! (and their lowercase forms), with `NO_PROXY`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Whether `location` is a web address rather than a file.
pub fn is_url(location: &str) -> bool {
    let lower = location.get(..8).unwrap_or(location).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `reference` (an archive's `url` in the index) read against the index's own address `base`: a
/// full address or an absolute path as it is; a relative one beside the index.
pub fn resolve(base: &str, reference: &str) -> Result<String, String> {
    if is_url(reference) || Path::new(reference).is_absolute() {
        return Ok(reference.to_owned());
    }
    if is_url(base) {
        let base = url::Url::parse(base).map_err(|error| format!("{base}: {error}"))?;
        return base.join(reference).map(String::from).map_err(|error| format!("{reference}: {error}"));
    }
    let folder = Path::new(base).parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(folder.join(reference).display().to_string())
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

/// Downloads `location` to `to`, which must be exactly `size` bytes; answers its SHA-256,
/// lowercase hex. Stops as soon as it reads more than `size` bytes. `progress` hears the bytes
/// read so far after each read.
pub fn download(location: &str, size: u64, to: &Path, progress: &mut dyn FnMut(u64)) -> Result<String, String> {
    let mut reader = open(location)?.take(size + 1);
    let mut file = std::fs::File::create(to).map_err(|error| format!("cannot write {}: {error}", to.display()))?;
    let mut hash = Sha256::new();
    let mut read: u64 = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).map_err(|error| format!("downloading {location} failed: {error}"))?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if read > size {
            return Err(format!("{location} is larger than the {size} bytes the index gives: refused"));
        }
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(|error| format!("cannot write {}: {error}", to.display()))?;
        progress(read);
    }
    if read != size {
        return Err(format!("{location} is {read} bytes, and the index gives {size}: refused"));
    }
    file.sync_all().map_err(|error| format!("cannot write {}: {error}", to.display()))?;
    Ok(hex::encode(hash.finalize()))
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
    fn archive_addresses_resolve_beside_the_index() {
        assert_eq!(resolve("https://example.com/r/latest/kits-index.json", "kition-note.tar.gz").unwrap(), "https://example.com/r/latest/kition-note.tar.gz");
        assert_eq!(resolve("https://example.com/kits-index.json", "https://cdn.example.com/a.tar.gz").unwrap(), "https://cdn.example.com/a.tar.gz");
        let local = resolve("/srv/kits/kits-index.json", "note/a.tar.gz").unwrap();
        assert_eq!(Path::new(&local), Path::new("/srv/kits/note/a.tar.gz"));
        assert!(is_url("HTTPS://x") && !is_url("/tmp/x") && !is_url("C:\\x"));
    }
}
