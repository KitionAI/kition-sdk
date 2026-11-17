//! One workspace of the environment's own: a fresh temporary folder, and a kits server
//! (`KitManager`) on it that runs the kit. Every tool call goes through the server's agent tools,
//! exactly as an agent's do.

use std::path::{Path, PathBuf};

use kition_kits::{KitManager, tools};
use serde_json::{Value, json};

use crate::{EnvError, EnvKit, error};

pub(crate) struct Session {
    pub(crate) kits: KitManager,
    pub(crate) kit: EnvKit,
    dir: tempfile::TempDir,
}

impl Session {
    pub(crate) fn new(kit: &EnvKit) -> Result<Self, EnvError> {
        let dir = tempfile::Builder::new().prefix("kit-env-").tempdir()?;
        let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit.definition, kit.executable.clone())]);
        Ok(Self { kits, kit: kit.clone(), dir })
    }

    /// The workspace folder (canonical, as the server resolves paths in it).
    pub(crate) fn root(&self) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap_or_else(|_| self.dir.path().to_path_buf())
    }

    /// Writes `bytes` as the workspace's file `path` (relative, `/`-separated).
    pub(crate) fn write(&self, path: &str, bytes: &[u8]) -> Result<(), EnvError> {
        let full = self.dir.path().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(full, bytes)?;
        Ok(())
    }

    pub(crate) fn read(&self, path: &str) -> Result<Vec<u8>, EnvError> {
        std::fs::read(self.dir.path().join(path)).map_err(|err| error(format!("`{path}`: {err}")))
    }

    /// The kit's tool `<prefix>_<action>` on `path`: its output, or its failure as the tool
    /// answers it (`{ error, … }`).
    pub(crate) async fn call(&self, action: &str, path: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(path);
        self.call_tool(&self.kit.tool(action), &input).await.map(|(output, _)| output)
    }

    /// Any tool of the server by name, with its previews.
    pub(crate) async fn call_tool(&self, tool: &str, input: &Value) -> Result<(Value, Vec<tools::Preview>), Value> {
        match tools::call(&self.kits, tool, input).await {
            Some(Ok(output)) => Ok((output.output, output.previews)),
            Some(Err(failure)) => Err(failure.structured()),
            None => Err(json!({ "error": { "code": "not-found", "message": format!("`{tool}` is not a kit tool") } })),
        }
    }

    /// The error diagnostics `<prefix>_check` reports for `path`; none from a kit that cannot
    /// check documents (`unsupported`).
    pub(crate) async fn errors(&self, path: &str) -> Result<Vec<Value>, EnvError> {
        let checked = match self.call("check", path, json!({})).await {
            Ok(checked) => checked,
            Err(failure) if failure["error"]["code"] == "unsupported" => return Ok(Vec::new()),
            Err(failure) => return Err(error(format!("checking `{path}`: {}", failure["error"]["message"]))),
        };
        Ok(checked["diagnostics"].as_array().into_iter().flatten().filter(|diagnostic| diagnostic["severity"] == "error").cloned().collect())
    }

    /// Closes `path` in the kit without saving, so the next call reads the file again.
    pub(crate) async fn close(&self, path: &str) {
        self.kits.close_file(path).await;
    }

    pub(crate) async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

/// The name of `path`'s file: its last segment.
pub(crate) fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// `path` relative to `root`, `/`-separated.
pub(crate) fn relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}
