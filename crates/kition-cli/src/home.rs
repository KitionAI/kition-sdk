//! The Kition home: `~/.kition` on every system, or the folder `KITION_HOME` names.
//!
//! ```text
//! ~/.kition/
//!   bin/                      kition itself, when an installer put it there
//!   kits/<kit>/<version>/     an installed kit version: kit.json and kition-<kit> (.exe on Windows)
//!   kits/<kit>/pinned         optional: the version to use instead of the newest
//!   cache/                    the last kit index read from each address
//!   tmp/                      downloads and unpacking in progress; never read as kits
//! ```

use std::path::{Path, PathBuf};

/// The variable that names the Kition home instead of `~/.kition`.
pub const HOME_VARIABLE: &str = "KITION_HOME";

/// The Kition home's folders.
#[derive(Clone, Debug)]
pub struct Home {
    root: PathBuf,
}

impl Home {
    /// The home at `root`.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The home `KITION_HOME` names, else `.kition` in the person's home folder.
    pub fn from_env() -> Result<Self, String> {
        if let Some(root) = std::env::var_os(HOME_VARIABLE).filter(|value| !value.is_empty()) {
            return Ok(Self::at(root));
        }
        match std::env::home_dir() {
            Some(home) => Ok(Self::at(home.join(".kition"))),
            None => Err(format!("cannot tell where your home folder is: set {HOME_VARIABLE} to the folder kition keeps its kits in")),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `bin/`: where an installer puts `kition`.
    pub fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }

    /// `kits/`: one folder per kit, one folder per installed version in it.
    pub fn kits(&self) -> PathBuf {
        self.root.join("kits")
    }

    /// `cache/`: the kit index as last read from each address.
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }

    /// `tmp/`: work in progress. It is on the same volume as `kits/`, so a finished kit moves
    /// into place with one rename.
    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }
}

/// This machine's platform as the kit index names it: `darwin-arm64`, `darwin-x64`,
/// `linux-arm64`, `linux-x64`, `win32-x64`.
pub fn platform() -> String {
    kition_kits::definitions::bundle_platform()
}

/// A kit's executable file name on this system: `kition-note`, `kition-note.exe`.
pub fn executable_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
