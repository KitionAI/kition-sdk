//! The editor packages in the kit store: `kits/<kit>/ui/<version>/`, beside the kit's headless
//! versions (`store.rs`), each the unpacked package of that kit version (the kit's own editor,
//! its engine and fonts, as a Kit UI protocol host loads it): its `index.html` and the kit's
//! `kit.json` at its top. `ui` is not a version, so the store never reads it as one, and removing
//! a kit removes its editors with it.
//!
//! - A version is installed when its folder holds `index.html` and a `kit.json` whose `id` is
//!   `kit.<kit>` and whose `version` is the folder's name.
//! - Installing downloads the package the index lists for that version (`ui`), checks its size
//!   and SHA-256 against the index (refused on any difference), unpacks it in the home's `tmp/`
//!   (plain files and folders inside the archive only), takes its one top folder (`<kit>-ui/`),
//!   checks it, and renames it into place: a failed or interrupted install leaves nothing in
//!   `kits/`, and two processes installing it both end with the folder that won the rename.
//! - Development builds come from outside the store ([`Editors::with_local`]): a package folder
//!   (`index.html` and `kit.json`), or a kit repository checkout whose editor is built in
//!   `web/dist/` and whose `kit.json` is the repository's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use semver::Version;
use serde_json::Value;

use crate::index::Loaded;
use crate::store::{Outcome, Store};

/// The folder in a kit's store folder that holds its editor packages.
pub const UI_FOLDER: &str = "ui";

/// An editor package a gateway can serve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorFolder {
    /// Short name: `table`.
    pub kit: String,
    pub version: Version,
    /// The folder `index.html` is in.
    pub root: PathBuf,
    /// The kit's `kit.json`, when it is not in `root` (a repository checkout's).
    pub manifest: Option<PathBuf>,
    /// A development build (it may change under the same version): served without long caching.
    pub local: bool,
}

/// The editor packages of a kit store, and development builds named on the command line.
#[derive(Clone, Debug)]
pub struct Editors {
    store: Store,
    local: Vec<EditorFolder>,
}

/// An editor's `kit.json`: the kit's short name and version, when it names a kit.
fn manifest_identity(path: &Path) -> Option<(String, Version)> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let name = value.get("id")?.as_str()?.strip_prefix("kit.")?.to_owned();
    let version = Version::parse(value.get("version")?.as_str()?).ok()?;
    crate::index::short_name(&name).then_some((name, version))
}

/// The installed editor of `name` in `folder` (a `ui/<version>` folder), when it is complete.
fn read_installed(folder: &Path, name: &str) -> Option<EditorFolder> {
    let version = Version::parse(folder.file_name()?.to_str()?).ok()?;
    if !folder.join("index.html").is_file() {
        return None;
    }
    let (kit, manifest_version) = manifest_identity(&folder.join("kit.json"))?;
    (kit == name && manifest_version == version).then(|| EditorFolder { kit: kit.clone(), version, root: folder.to_path_buf(), manifest: None, local: false })
}

/// A development build at `path`: a package folder (`index.html`, `kit.json`), or a kit repository
/// checkout with its editor built in `web/dist/`.
pub fn local_build(path: &Path) -> Result<EditorFolder, String> {
    let shown = path.display();
    let path = std::fs::canonicalize(path).map_err(|_| format!("--kit-ui {shown}: no such folder"))?;
    let (root, manifest) = if path.join("index.html").is_file() {
        (path.clone(), None)
    } else if path.join("web/dist/index.html").is_file() {
        (path.join("web/dist"), Some(path.join("kit.json")))
    } else {
        return Err(format!("--kit-ui {shown}: neither an editor package (index.html) nor a kit repository with its editor built (web/dist/index.html)"));
    };
    let manifest_file = manifest.clone().unwrap_or_else(|| root.join("kit.json"));
    let (kit, version) = manifest_identity(&manifest_file)
        .ok_or_else(|| format!("--kit-ui {shown}: {} names no kit (`id` kit.<name>, a semver `version`)", manifest_file.display()))?;
    Ok(EditorFolder { kit, version, root, manifest, local: true })
}

impl Editors {
    pub fn new(store: Store) -> Self {
        Self { store, local: Vec::new() }
    }

    /// Serves `builds` (development builds, [`local_build`]) instead of the store's editors of
    /// their kits.
    #[must_use]
    pub fn with_local(mut self, builds: Vec<EditorFolder>) -> Self {
        self.local = builds;
        self
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    fn folder(&self, name: &str) -> PathBuf {
        self.store.home().kits().join(name).join(UI_FOLDER)
    }

    /// The development build of `name`, when one was named.
    pub fn local(&self, name: &str) -> Option<&EditorFolder> {
        self.local.iter().find(|build| build.kit == name)
    }

    /// The installed editor versions of `name`, newest first.
    pub fn installed(&self, name: &str) -> Vec<EditorFolder> {
        let mut found: Vec<EditorFolder> = std::fs::read_dir(self.folder(name))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter_map(|path| read_installed(&path, name))
            .collect();
        found.sort_by(|a, b| b.version.cmp(&a.version));
        found
    }

    /// The editor of `name` at `version`: a development build of that version, else the store's.
    pub fn find(&self, name: &str, version: &Version) -> Option<EditorFolder> {
        if let Some(build) = self.local(name).filter(|build| &build.version == version) {
            return Some(build.clone());
        }
        read_installed(&self.folder(name).join(version.to_string()), name)
    }

    /// The version whose editor a host should load for `name`: the development build's, else the
    /// version of the headless kit in use, else the newest editor installed.
    pub fn version_for(&self, name: &str) -> Option<Version> {
        if let Some(build) = self.local(name) {
            return Some(build.version.clone());
        }
        if let Some(in_use) = self.store.kit(name).and_then(|kit| kit.in_use().map(|installed| installed.version.clone())) {
            return Some(in_use);
        }
        self.installed(name).into_iter().next().map(|editor| editor.version)
    }

    /// Installs the editor package of `name` at `version` from the index `loaded`; `progress`
    /// hears the bytes downloaded and the package's size.
    pub fn install(&self, loaded: &Loaded, name: &str, version: &Version, progress: &mut dyn FnMut(u64, u64)) -> Result<Outcome, String> {
        if read_installed(&self.folder(name).join(version.to_string()), name).is_some() {
            return Ok(Outcome::Present(version.clone()));
        }
        let Some((name, kit)) = loaded.index.kit(name) else { return Err(format!("no kit named `{name}` is in the kit index")) };
        let entry = kit.versions.get(&version.to_string()).ok_or_else(|| format!("{name} {version} is not in the kit index"))?;
        let package = entry.ui.as_ref().ok_or_else(|| format!("the kit index lists no editor package for {name} {version}"))?;
        let location = crate::fetch::resolve(&loaded.location, &package.url)?;
        let tmp = self.store.home().tmp();
        std::fs::create_dir_all(&tmp).map_err(|error| format!("cannot write {}: {error}", tmp.display()))?;
        let work = crate::fetch::scratch(&tmp, &format!("editor-{name}-{version}"));
        std::fs::create_dir_all(&work).map_err(|error| format!("cannot write {}: {error}", work.display()))?;
        let done = (|| {
            let file = work.join("package.tar.gz");
            let sha256 = crate::fetch::download(&location, package.size, &file, &mut |done| progress(done, package.size))?;
            if sha256 != package.sha256 {
                return Err(format!("{location}: its SHA-256 is {sha256}, and the kit index gives {}: refused", package.sha256));
            }
            let unpacked = work.join("unpacked");
            std::fs::create_dir_all(&unpacked).map_err(|error| error.to_string())?;
            crate::store::unpack(&file, &unpacked).map_err(|why| format!("{location}: {why}: refused"))?;
            let top = package_top(&unpacked).map_err(|why| format!("{location}: {why}: refused"))?;
            let ready = work.join(version.to_string());
            std::fs::rename(&top, &ready).map_err(|error| error.to_string())?;
            if read_installed(&ready, name).is_none() {
                return Err(format!("{location}: it is not the editor of {name} {version} (index.html and a kit.json of kit.{name} {version}): refused"));
            }
            self.place(&ready, name, version)
        })();
        let _ = std::fs::remove_dir_all(&work);
        done
    }

    fn place(&self, ready: &Path, name: &str, version: &Version) -> Result<Outcome, String> {
        let folder = self.folder(name);
        std::fs::create_dir_all(&folder).map_err(|error| format!("cannot write {}: {error}", folder.display()))?;
        let target = folder.join(version.to_string());
        if target.exists() && read_installed(&target, name).is_none() {
            let aside = crate::fetch::scratch(&self.store.home().tmp(), &format!("broken-editor-{name}-{version}"));
            let _ = std::fs::rename(&target, &aside);
            let _ = std::fs::remove_dir_all(&aside);
        }
        match std::fs::rename(ready, &target) {
            Ok(()) => Ok(Outcome::Installed(version.clone())),
            Err(_) if read_installed(&target, name).is_some() => Ok(Outcome::Present(version.clone())),
            Err(error) => Err(format!("cannot move the editor of {name} {version} into {}: {error}", target.display())),
        }
    }

    /// Removes the editor versions of `name` other than `keep`; answers those removed.
    pub fn prune(&self, name: &str, keep: Option<&Version>) -> Vec<Version> {
        let mut removed = Vec::new();
        for editor in self.installed(name).into_iter().filter(|editor| Some(&editor.version) != keep) {
            let aside = crate::fetch::scratch(&self.store.home().tmp(), &format!("remove-editor-{name}-{}", editor.version));
            if std::fs::create_dir_all(self.store.home().tmp()).and_then(|()| std::fs::rename(&editor.root, &aside)).is_ok() {
                let _ = std::fs::remove_dir_all(&aside);
                removed.push(editor.version);
            }
        }
        removed
    }
}

/// The one folder a package unpacked into `unpacked` holds (`<kit>-ui/`), or `unpacked` itself when
/// the package has its files at its top.
fn package_top(unpacked: &Path) -> Result<PathBuf, String> {
    if unpacked.join("index.html").is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let entries: Vec<PathBuf> = std::fs::read_dir(unpacked).map_err(|error| error.to_string())?.flatten().map(|entry| entry.path()).collect();
    match entries.as_slice() {
        [only] if only.is_dir() && only.join("index.html").is_file() => Ok(only.clone()),
        _ => Err("it holds no editor (one folder with index.html at its top)".to_owned()),
    }
}

/// How far the downloads of editor packages a gateway started have come, by kit.
#[derive(Clone, Debug, Default)]
pub struct Downloads(Arc<Mutex<HashMap<String, Download>>>);

/// One download: bytes so far and the package's size, or why it failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Download {
    Running { done: u64, total: u64 },
    Failed(String),
}

impl Downloads {
    pub fn get(&self, kit: &str) -> Option<Download> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).get(kit).cloned()
    }

    /// Starts tracking `kit`; `false` when its download is running already.
    pub fn start(&self, kit: &str) -> bool {
        let mut downloads = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(downloads.get(kit), Some(Download::Running { .. })) {
            return false;
        }
        downloads.insert(kit.to_owned(), Download::Running { done: 0, total: 0 });
        true
    }

    pub fn update(&self, kit: &str, done: u64, total: u64) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(kit.to_owned(), Download::Running { done, total });
    }

    /// The download ended: forgotten when it worked, kept with its reason when it failed.
    pub fn finish(&self, kit: &str, outcome: Result<(), String>) {
        let mut downloads = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match outcome {
            Ok(()) => downloads.remove(kit),
            Err(why) => downloads.insert(kit.to_owned(), Download::Failed(why)),
        };
    }
}

/// The editor packages `kition gateway` serves: the store's, development builds, and installs it
/// starts when a page first opens a kit (`kition_kits_http::editors`).
pub struct GatewayEditors {
    editors: Editors,
    source: crate::index::Source,
    downloads: Downloads,
    loaded: Mutex<Option<Loaded>>,
}

impl GatewayEditors {
    pub fn new(editors: Editors, source: crate::index::Source) -> Self {
        Self { editors, source, downloads: Downloads::default(), loaded: Mutex::new(None) }
    }

    /// The kit index, read once (the copy kept within the hour) and kept; `fresh` reads it again
    /// when the kept one is older or was read from the cache because the network failed.
    fn index(&self, fresh: bool) -> Option<Loaded> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(kept) = loaded.as_ref().filter(|kept| !fresh || kept.stale.is_none()) {
            return Some(kept.clone());
        }
        let freshness = if fresh { crate::index::Freshness::Now } else { crate::index::Freshness::Within(crate::supply::STARTUP_FRESHNESS) };
        let read = crate::index::load(self.editors.store().home(), &self.source, freshness).ok()?;
        *loaded = Some(read.clone());
        Some(read)
    }

    /// The version whose editor a page loads for `name`: [`Editors::version_for`], else the newest
    /// version in the index that speaks this kition's protocol and has an editor package.
    fn version(&self, name: &str, fresh: bool) -> Option<Version> {
        if let Some(version) = self.editors.version_for(name) {
            return Some(version);
        }
        let loaded = self.index(fresh)?;
        let (_, kit) = loaded.index.kit(name)?;
        let ours = crate::protocol();
        kit.versions().into_iter().find(|(_, entry)| entry.protocol == ours && entry.ui.is_some()).map(|(version, _)| version)
    }
}

impl kition_kits_http::editors::EditorStore for GatewayEditors {
    fn listing(&self, kits: &[&str]) -> Vec<kition_kits_http::editors::EditorEntry> {
        use kition_kits_http::editors::{EditorEntry, Progress};
        kits.iter()
            .filter_map(|id| {
                let name = id.strip_prefix("kit.")?;
                let version = self.version(name, false);
                let found = version.as_ref().and_then(|version| self.editors.find(name, version));
                let available = match (&found, &version) {
                    (Some(editor), _) if editor.local => None,
                    (_, Some(version)) => self.index(false).map(|loaded| {
                        loaded.index.kits.get(name).and_then(|kit| kit.versions.get(&version.to_string())).is_some_and(|entry| entry.ui.is_some())
                    }),
                    (_, None) => self.index(false).map(|_| false),
                };
                let (downloading, failed) = match self.downloads.get(name) {
                    Some(Download::Running { done, total }) => (Some(Progress { done, total }), None),
                    Some(Download::Failed(why)) => (None, Some(why)),
                    None => (None, None),
                };
                Some(EditorEntry {
                    id: (*id).to_owned(),
                    version: version.map(|version| version.to_string()),
                    installed: found.is_some(),
                    local: found.as_ref().is_some_and(|editor| editor.local),
                    available,
                    downloading,
                    failed,
                })
            })
            .collect()
    }

    fn package(&self, kit: &str, version: &str) -> Option<kition_kits_http::editors::EditorPackage> {
        let version = Version::parse(version).ok()?;
        let found = self.editors.find(kit, &version)?;
        Some(kition_kits_http::editors::EditorPackage { root: found.root, manifest: found.manifest, local: found.local })
    }

    fn install(&self, kit: &str) -> Result<bool, String> {
        let version = self.version(kit, true).ok_or_else(|| format!("the kit index lists no editor package of {kit} that this kition can use"))?;
        if self.editors.find(kit, &version).is_some() {
            return Ok(false);
        }
        let loaded = self.index(true).ok_or_else(|| "the kit index cannot be read".to_owned())?;
        let listed = loaded.index.kits.get(kit).and_then(|entry| entry.versions.get(&version.to_string())).is_some_and(|entry| entry.ui.is_some());
        if !listed {
            return Err(format!("the kit index lists no editor package for {kit} {version}"));
        }
        if !self.downloads.start(kit) {
            return Ok(false);
        }
        let (editors, downloads, kit) = (self.editors.clone(), self.downloads.clone(), kit.to_owned());
        std::thread::spawn(move || {
            let outcome = editors.install(&loaded, &kit, &version, &mut |done, total| downloads.update(&kit, done, total));
            if let Err(why) = &outcome {
                eprintln!("kition gateway: the editor of {kit} {version}: {why}");
            }
            downloads.finish(&kit, outcome.map(|_| ()));
        });
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_has_one_top_folder_with_its_index() {
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().join("table-ui");
        std::fs::create_dir_all(&top).unwrap();
        assert!(package_top(dir.path()).is_err());
        std::fs::write(top.join("index.html"), "<!doctype html>").unwrap();
        assert_eq!(package_top(dir.path()).unwrap(), top);
        std::fs::create_dir_all(dir.path().join("other")).unwrap();
        assert!(package_top(dir.path()).is_err(), "two folders: which one?");
    }
}
