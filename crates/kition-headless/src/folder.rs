//! A folder as a kit's host serves it (Kit Process Protocol `files.*`), in the kit's own process: for
//! a kit's tests and the Agent-ready checks, which drive a [`crate::Headless`] backend directly
//! rather than through a host. It is the host side Kition and `kition-kits serve` use
//! (`kition_kit_host::KitFiles`), so a test sees the same grants, confinement and conflicts.
//!
//! ```ignore
//! let folder = HostFolder::new(&root)?;
//! let mut backend = kit();
//! backend.set_host(folder.host());
//! let info = backend.open(OpenRequest { file: &folder.file("a.grid")?, read_only: false, create: None })?;
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kition_kit_host::files::{FilesManifest, GrantStore};
use kition_kit_host::{HOST_PRINCIPAL, HostService, KitFiles, file_error};
use kition_kit_server::{Host, HostCall, RpcError};
use serde_json::Value;

/// A folder's files, served to one backend.
pub struct HostFolder {
    root: PathBuf,
    files: Arc<KitFiles>,
}

struct Link(Arc<KitFiles>);

impl HostCall for Link {
    fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.0.serve(method, params)
    }
}

impl HostFolder {
    /// Serves the files under `root`, which must exist.
    pub fn new(root: &Path) -> Result<Self, RpcError> {
        Self::with_manifest(root, FilesManifest::default())
    }

    /// [`HostFolder::new`] for a kit whose manifest `files` lists bound `files.create` (K15).
    pub fn with_manifest(root: &Path, manifest: FilesManifest) -> Result<Self, RpcError> {
        let root = std::fs::canonicalize(root).map_err(|error| RpcError::invalid_params(format!("the folder: {}", error.kind())))?;
        let store = Arc::new(GrantStore::new(Some(root.clone())));
        let files = KitFiles::open(store, "kit", HOST_PRINCIPAL, manifest).map_err(|error| file_error(&error))?;
        Ok(Self { root, files: Arc::new(files) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The host as the backend's [`crate::KitBackend::set_host`] takes it.
    pub fn host(&self) -> Host {
        Host::new(self.files.services(), Arc::new(Link(Arc::clone(&self.files))))
    }

    /// A handle on the file `path` (relative to the folder) for `document.open` or `saveAs`:
    /// `read` and `write` on an existing file, `read`, `create` and `write` on a new one.
    pub fn file(&self, path: &str) -> Result<String, RpcError> {
        self.files.document(path, false, false).map(|stat| stat.handle).map_err(|error| file_error(&error))
    }

    /// A `read` handle on the existing file `path`, for a read-only document.
    pub fn read_only(&self, path: &str) -> Result<String, RpcError> {
        self.files.document(path, true, false).map(|stat| stat.handle).map_err(|error| file_error(&error))
    }

    /// A `create` handle on the new file `path`, for `document.export`.
    pub fn export(&self, path: &str) -> Result<String, RpcError> {
        self.files.export(path).map(|stat| stat.handle).map_err(|error| file_error(&error))
    }

    /// The host side of the files this folder served, for checks on grants and handles.
    pub fn files(&self) -> &KitFiles {
        &self.files
    }
}
