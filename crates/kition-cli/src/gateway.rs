//! What `kition gateway` leaves for others to find it by, and how they find a live one: the
//! lockfile `$KITION_HOME/run/<key>.json`, one per canonical workspace, readable by this account
//! only (0600, in a 0700 folder), holding the gateway's address, token and process id.
//!
//! ```json
//! {"format":1,"protocol":"kition-gateway/1","version":"0.5.2","pid":4242,"port":51234,
//!  "url":"http://127.0.0.1:51234","apiPrefix":"/api/v1","token":"<64 hex>",
//!  "workspace":"/abs/canonical/folder","unified":true,"started":1795000000}
//! ```
//!
//! `<key>` is the first 32 hex digits of the SHA-256 of the canonical workspace path (UTF-8).
//! A lockfile names a live gateway when `GET <url><apiPrefix>/gateway` with its token answers the
//! same process id and workspace; one that does not (nothing listens, another program answers,
//! the token is refused) is stale.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::home::Home;

/// The lockfile format this kition writes and reads.
pub const LOCKFILE_FORMAT: u32 = 1;
/// The header that carries the gateway's token.
pub const TOKEN_HEADER: &str = "Kition-Token";

/// A gateway's lockfile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lockfile {
    pub format: u32,
    pub protocol: String,
    pub version: String,
    pub pid: u32,
    pub port: u16,
    pub url: String,
    pub api_prefix: String,
    pub token: String,
    /// The canonical workspace folder.
    pub workspace: String,
    /// Whether its MCP tools are the unified set (`kit_<action>`).
    pub unified: bool,
    /// When it started, in Unix seconds.
    pub started: u64,
}

/// `run/`: where gateways leave their lockfiles.
pub fn run_dir(home: &Home) -> PathBuf {
    home.root().join("run")
}

/// The key of a canonical workspace folder.
pub fn workspace_key(canonical: &Path) -> String {
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    hex::encode(&digest[..16])
}

/// The gateway's own data for the workspace `canonical` (the person's view state of its documents).
pub fn data_dir(home: &Home, canonical: &Path) -> PathBuf {
    home.data().join(workspace_key(canonical))
}

/// The lockfile of the gateway for `canonical`.
pub fn lockfile_path(home: &Home, canonical: &Path) -> PathBuf {
    run_dir(home).join(format!("{}.json", workspace_key(canonical)))
}

/// The lockfile at `path`, when there is one this kition reads.
pub fn read(path: &Path) -> Option<Lockfile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Lockfile>(&text).ok().filter(|lock| lock.format == LOCKFILE_FORMAT)
}

/// Makes `run/` readable by this account only.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `lock` at `path` unless a lockfile is there: written whole to a private temporary file
/// first, then linked into place, which fails when the name is taken, so two gateways starting at
/// once cannot both hold it and nobody reads half a lockfile. `Ok(false)` when one is there.
pub fn write_new(path: &Path, lock: &Lockfile) -> std::io::Result<bool> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("a lockfile path has a folder"))?;
    private_dir(dir)?;
    let tag: u64 = rand::random();
    let temporary = dir.join(format!(".{}-{tag:016x}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(serde_json::to_string(lock).map_err(std::io::Error::other)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()
    })();
    let placed = written.and_then(|()| std::fs::hard_link(&temporary, path));
    let _ = std::fs::remove_file(&temporary);
    match placed {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

/// Removes the lockfile at `path` when it is still `lock` (not a gateway's that replaced it).
pub fn remove_if_ours(path: &Path, lock: &Lockfile) {
    if read(path).is_some_and(|found| found.pid == lock.pid && found.token == lock.token) {
        let _ = std::fs::remove_file(path);
    }
}

/// An HTTP agent for the gateway on loopback: no proxy, no connection kept for reuse (so a
/// refused connection always means nothing was sent), statuses as answers.
pub fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(format!("kition/{}", crate::VERSION))
        .proxy(None)
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(2)))
        .timeout_global(timeout)
        .build()
        .new_agent()
}

/// What `GET <apiPrefix>/gateway` answers for `lock`, when the gateway it names is the one that
/// answers.
pub fn identity(lock: &Lockfile) -> Option<Value> {
    let address = format!("{}{}/gateway", lock.url.trim_end_matches('/'), lock.api_prefix);
    let mut response = agent(Some(Duration::from_secs(3))).get(&address).header(TOKEN_HEADER, &lock.token).call().ok()?;
    if response.status() != 200 {
        return None;
    }
    let body: Value = serde_json::from_slice(&response.body_mut().read_to_vec().ok()?).ok()?;
    let data = body.get("data")?.clone();
    let same =
        data.get("pid").and_then(Value::as_u64) == Some(u64::from(lock.pid)) && data.get("workspace").and_then(Value::as_str) == Some(lock.workspace.as_str());
    same.then_some(data)
}

/// The live gateway for the canonical workspace `canonical`, if one is running.
pub fn find_live(home: &Home, canonical: &Path) -> Option<Lockfile> {
    let lock = read(&lockfile_path(home, canonical))?;
    (lock.workspace == canonical.to_string_lossy() && identity(&lock).is_some()).then_some(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock(pid: u32) -> Lockfile {
        Lockfile {
            format: LOCKFILE_FORMAT,
            protocol: "kition-gateway/1".into(),
            version: crate::VERSION.into(),
            pid,
            port: 1,
            url: "http://127.0.0.1:1".into(),
            api_prefix: "/api/v1".into(),
            token: "t".repeat(64),
            workspace: "/w".into(),
            unified: false,
            started: 0,
        }
    }

    #[test]
    fn a_lockfile_is_written_once_privately_and_removed_only_by_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let home = Home::at(dir.path());
        let path = lockfile_path(&home, Path::new("/some/workspace"));
        assert_eq!(path.file_name().and_then(|name| name.to_str()).map(str::len), Some(32 + 5));
        assert!(write_new(&path, &lock(1)).unwrap());
        assert!(!write_new(&path, &lock(2)).unwrap(), "a second gateway cannot take it");
        assert_eq!(read(&path), Some(lock(1)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(run_dir(&home)).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert_eq!(std::fs::read_dir(run_dir(&home)).unwrap().count(), 1, "no temporary file is left");
        remove_if_ours(&path, &lock(2));
        assert!(path.exists(), "another gateway's lockfile stays");
        remove_if_ours(&path, &lock(1));
        assert!(!path.exists());
    }

    #[test]
    fn nothing_listening_is_no_live_gateway() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let stale = Lockfile { port, url: format!("http://127.0.0.1:{port}"), ..lock(std::process::id()) };
        assert!(identity(&stale).is_none());
    }
}
