//! The kit store: `kits/<kit>/<version>/` in the Kition home, each holding the kit's `kit.json`
//! and its executable (`kition-<kit>`, `.exe` on Windows). No links and no index file: the folders
//! are the truth, so another program (Kition's desktop app) adds a kit by putting a complete
//! version folder in place with one rename, and `kition` sees it.
//!
//! - A version is installed when its folder is complete: a `kit.json` whose `id` is
//!   `kit.<kit>` and whose `version` is the folder's name, and the executable it names
//!   (`headless.executable`) beside it. Anything else in `kits/` is not a kit and is left alone.
//! - The version in use is the one `kits/<kit>/pinned` names, when that one is installed;
//!   else the newest installed (semver).
//! - Installing downloads into the home's `tmp/`, checks the size and SHA-256 the index gives,
//!   unpacks there (refusing any entry that is not a plain file or folder inside the archive),
//!   checks the unpacked `kit.json` against the index, and then renames the finished folder into
//!   `kits/<kit>/<version>/`. A failed or interrupted install leaves nothing in `kits/`; two
//!   processes installing the same version both end with the one folder that won the rename.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use semver::Version;
use serde_json::Value;

use crate::home::{Home, executable_name};
use crate::index::{IndexKit, Loaded};

/// The most an archive may unpack to.
const UNPACKED_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

/// The file that names a kit's pinned version.
const PINNED: &str = "pinned";

/// An installed version of a kit.
#[derive(Clone, Debug)]
pub struct Installed {
    /// Short name: `note`.
    pub name: String,
    pub version: Version,
    pub folder: PathBuf,
    /// Its `kit.json`, as found.
    pub manifest: String,
    pub executable: PathBuf,
    /// `headless.protocol`, when its `kit.json` says.
    pub protocol: Option<String>,
}

/// A kit in the store: its installed versions, newest first, and the one in use.
#[derive(Clone, Debug)]
pub struct StoredKit {
    pub name: String,
    pub versions: Vec<Installed>,
    pub pinned: Option<Version>,
}

impl StoredKit {
    /// The version in use: the pinned one when installed, else the newest.
    pub fn in_use(&self) -> Option<&Installed> {
        self.pinned.as_ref().and_then(|pinned| self.versions.iter().find(|installed| &installed.version == pinned)).or_else(|| self.versions.first())
    }
}

/// What an install did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed(Version),
    /// That version was installed already (by this program or another).
    Present(Version),
}

impl Outcome {
    pub fn version(&self) -> &Version {
        match self {
            Self::Installed(version) | Self::Present(version) => version,
        }
    }
}

/// The kit store in a Kition home.
#[derive(Clone, Debug)]
pub struct Store {
    home: Home,
}

fn read_version(folder: &Path, name: &str) -> Option<Installed> {
    let version = Version::parse(folder.file_name()?.to_str()?).ok()?;
    let manifest = std::fs::read_to_string(folder.join("kit.json")).ok()?;
    let value: Value = serde_json::from_str(&manifest).ok()?;
    if value.get("id").and_then(Value::as_str) != Some(&format!("kit.{name}")) || value.get("version").and_then(Value::as_str) != Some(&version.to_string()) {
        return None;
    }
    let executable = folder.join(executable_name(value.pointer("/headless/executable").and_then(Value::as_str)?));
    if !executable.is_file() {
        return None;
    }
    let protocol = value.pointer("/headless/protocol").and_then(Value::as_str).map(str::to_owned);
    Some(Installed { name: name.to_owned(), version, folder: folder.to_path_buf(), manifest, executable, protocol })
}

fn hidden(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_none_or(|name| name.starts_with('.'))
}

impl Store {
    pub fn new(home: Home) -> Self {
        Self { home }
    }

    pub fn home(&self) -> &Home {
        &self.home
    }

    fn kit_folder(&self, name: &str) -> PathBuf {
        self.home.kits().join(name)
    }

    /// The kit `name` as the store holds it; `None` when no version of it is installed.
    pub fn kit(&self, name: &str) -> Option<StoredKit> {
        let folder = self.kit_folder(name);
        let mut versions: Vec<Installed> = std::fs::read_dir(&folder)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir() && !hidden(path))
            .filter_map(|path| read_version(&path, name))
            .collect();
        if versions.is_empty() {
            return None;
        }
        versions.sort_by(|a, b| b.version.cmp(&a.version));
        let pinned = std::fs::read_to_string(folder.join(PINNED)).ok().and_then(|text| Version::parse(text.trim()).ok());
        Some(StoredKit { name: name.to_owned(), versions, pinned })
    }

    /// Every kit with an installed version, by name.
    pub fn list(&self) -> Vec<StoredKit> {
        let mut names: Vec<String> = std::fs::read_dir(self.home.kits())
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir() && !hidden(path))
            .filter_map(|path| path.file_name()?.to_str().map(str::to_owned))
            .collect();
        names.sort();
        names.iter().filter_map(|name| self.kit(name)).collect()
    }

    /// Pins `version` of `name` (it is used even when a newer one is installed), or, with
    /// `None`, unpins it.
    pub fn pin(&self, name: &str, version: Option<&Version>) -> Result<(), String> {
        let file = self.kit_folder(name).join(PINNED);
        match version {
            None => match std::fs::remove_file(&file) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot unpin {name}: {error}")),
                _ => Ok(()),
            },
            Some(version) => {
                let scratch = crate::fetch::scratch(&self.kit_folder(name), ".pin");
                std::fs::write(&scratch, format!("{version}\n"))
                    .and_then(|()| std::fs::rename(&scratch, &file))
                    .map_err(|error| format!("cannot pin {name}: {error}"))
            }
        }
    }

    /// The version of `kit` to install: `wanted`, or the newest that speaks this program's
    /// protocol and has an archive for `platform`. Refuses, saying what to do, a version that
    /// speaks another protocol.
    pub fn choose(name: &str, kit: &IndexKit, wanted: Option<&Version>, platform: &str) -> Result<Version, String> {
        let ours = crate::protocol();
        let speaks = |protocol: &str| speaks(name, protocol);
        if let Some(wanted) = wanted {
            let entry = kit.versions.iter().find(|(version, _)| Version::parse(version).ok().as_ref() == Some(wanted)).map(|(_, entry)| entry);
            let Some(entry) = entry else {
                let known: Vec<String> = kit.versions().iter().map(|(version, _)| version.to_string()).collect();
                return Err(format!("{name} {wanted} is not in the kit index; its versions are {}", known.join(", ")));
            };
            speaks(&entry.protocol).map_err(|why| format!("{name} {wanted} cannot be installed: {why}"))?;
            if !entry.platforms.contains_key(platform) {
                return Err(format!(
                    "{name} {wanted} has no build for {platform}; it is built for {}",
                    entry.platforms.keys().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
            return Ok(wanted.clone());
        }
        let versions = kit.versions();
        if let Some((version, _)) = versions.iter().find(|(_, entry)| entry.protocol == ours && entry.platforms.contains_key(platform)) {
            return Ok(version.clone());
        }
        match versions.iter().find(|(_, entry)| entry.platforms.contains_key(platform)) {
            Some((version, entry)) => Err(format!("{name} {version} cannot be installed: {}", speaks(&entry.protocol).err().unwrap_or_default())),
            None => Err(format!("{name} has no build for {platform} in the kit index")),
        }
    }

    /// Installs version `wanted` of the kit `name` (or the newest that this program can run) from
    /// the index `loaded`, for this machine's platform.
    pub fn install(&self, loaded: &Loaded, name: &str, wanted: Option<&Version>) -> Result<(String, Outcome), String> {
        self.install_reporting(loaded, name, wanted, &mut |_, _| {})
    }

    /// [`Store::install`], telling `progress` the bytes downloaded and the archive's size as the
    /// download goes.
    pub fn install_reporting(
        &self,
        loaded: &Loaded,
        name: &str,
        wanted: Option<&Version>,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(String, Outcome), String> {
        let Some((name, kit)) = loaded.index.kit(name) else {
            let known: Vec<&str> = loaded.index.kits.keys().map(String::as_str).collect();
            return Err(format!("no kit named `{name}` is in the kit index; it lists {}", if known.is_empty() { "none".to_owned() } else { known.join(", ") }));
        };
        let platform = crate::home::platform();
        let version = Self::choose(name, kit, wanted, &platform)?;
        if self.kit(name).is_some_and(|stored| stored.versions.iter().any(|installed| installed.version == version)) {
            return Ok((name.to_owned(), Outcome::Present(version)));
        }
        let entry = &kit.versions[&version.to_string()];
        let archive = &entry.platforms[&platform];
        std::fs::create_dir_all(self.home.tmp()).map_err(|error| format!("cannot write {}: {error}", self.home.tmp().display()))?;
        self.sweep();
        let work = crate::fetch::scratch(&self.home.tmp(), &format!("install-{name}-{version}"));
        std::fs::create_dir_all(&work).map_err(|error| format!("cannot write {}: {error}", work.display()))?;
        let done = self.install_in(&work, &loaded.registries, name, kit, &version, entry, archive, progress);
        let _ = std::fs::remove_dir_all(&work);
        done.map(|outcome| (name.to_owned(), outcome))
    }

    #[allow(clippy::too_many_arguments)]
    fn install_in(
        &self,
        work: &Path,
        registries: &crate::registry::Registries,
        name: &str,
        kit: &IndexKit,
        version: &Version,
        entry: &crate::index::IndexVersion,
        archive: &crate::index::Archive,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Outcome, String> {
        let file = work.join("package.tgz");
        let size = archive.size;
        crate::registry::download(registries, &archive.package, &version.to_string(), size, &archive.integrity, &file, &mut |done| progress(done, size))?;
        let shown = format!("{}@{version}", archive.package);
        let unpacked = work.join("unpacked");
        std::fs::create_dir_all(&unpacked).map_err(|error| error.to_string())?;
        unpack(&file, &unpacked).map_err(|why| format!("{shown}: {why}: refused"))?;
        let root = npm_root(&unpacked, &archive.package, version).map_err(|why| format!("{shown}: {why}: refused"))?;
        check_unpacked(&root, &kit.id, version, &entry.protocol).map_err(|why| format!("{shown}: {why}: refused"))?;
        let ready = work.join(version.to_string());
        std::fs::rename(&root, &ready).map_err(|error| error.to_string())?;
        self.place(&ready, name, version)
    }

    /// Moves the checked version folder `unpacked` into `kits/<name>/<version>/` with one rename.
    fn place(&self, unpacked: &Path, name: &str, version: &Version) -> Result<Outcome, String> {
        let target_folder = self.kit_folder(name);
        std::fs::create_dir_all(&target_folder).map_err(|error| format!("cannot write {}: {error}", target_folder.display()))?;
        let target = target_folder.join(version.to_string());
        if target.exists() && read_version(&target, name).is_none() {
            // Not a complete version (left by hand, or by a program that does not rename into
            // place): set it aside rather than mix files into it.
            let aside = crate::fetch::scratch(&self.home.tmp(), &format!("broken-{name}-{version}"));
            let _ = std::fs::rename(&target, &aside);
            let _ = std::fs::remove_dir_all(&aside);
        }
        match std::fs::rename(unpacked, &target) {
            Ok(()) => Ok(Outcome::Installed(version.clone())),
            Err(_) if read_version(&target, name).is_some() => Ok(Outcome::Present(version.clone())),
            Err(error) => Err(format!("cannot move {name} {version} into {}: {error}", target.display())),
        }
    }

    /// Removes every version of `name`; answers the versions removed. The kit's folder leaves
    /// `kits/` with one rename, so no half-removed kit stays behind.
    pub fn remove(&self, name: &str) -> Result<Vec<Version>, String> {
        let Some(kit) = self.kit(name) else { return Err(format!("{name} is not installed")) };
        std::fs::create_dir_all(self.home.tmp()).map_err(|error| error.to_string())?;
        let aside = crate::fetch::scratch(&self.home.tmp(), &format!("remove-{name}"));
        std::fs::rename(self.kit_folder(name), &aside)
            .map_err(|error| format!("cannot remove {name}: {error}; if a program is running it (an MCP server, Kition), close it and try again"))?;
        let _ = std::fs::remove_dir_all(&aside);
        Ok(kit.versions.into_iter().map(|installed| installed.version).collect())
    }

    /// Removes the versions of `name` other than the one in use; answers those removed. One a
    /// running program holds (Windows) stays, and goes next time.
    pub fn prune(&self, name: &str) -> Vec<Version> {
        let Some(kit) = self.kit(name) else { return Vec::new() };
        let keep = kit.in_use().map(|installed| installed.version.clone());
        let mut removed = Vec::new();
        for installed in kit.versions.iter().filter(|installed| Some(&installed.version) != keep.as_ref()) {
            let aside = crate::fetch::scratch(&self.home.tmp(), &format!("remove-{name}-{}", installed.version));
            if std::fs::create_dir_all(self.home.tmp()).and_then(|()| std::fs::rename(&installed.folder, &aside)).is_ok() {
                let _ = std::fs::remove_dir_all(&aside);
                removed.push(installed.version.clone());
            }
        }
        removed
    }

    /// Puts a kit built or copied here into the store, with the checks and the one-rename move of
    /// an install from the index. `path` is a kit archive laid out like the index's (a `.tar.gz`
    /// with `kit.json` and the executable at its top), a folder holding `kit.json` and the
    /// executable, or a kit executable whose `kit.json` is the nearest one above it naming it
    /// (`headless.executable`), as `--kit` finds it. A kit of another Kit Process Protocol is
    /// refused as an install from the index is.
    pub fn add(&self, path: &Path) -> Result<(String, Outcome), String> {
        std::fs::create_dir_all(self.home.tmp()).map_err(|error| format!("cannot write {}: {error}", self.home.tmp().display()))?;
        self.sweep();
        let work = crate::fetch::scratch(&self.home.tmp(), "add");
        std::fs::create_dir_all(&work).map_err(|error| format!("cannot write {}: {error}", work.display()))?;
        let done = self.add_in(&work, path);
        let _ = std::fs::remove_dir_all(&work);
        done
    }

    fn add_in(&self, work: &Path, path: &Path) -> Result<(String, Outcome), String> {
        let shown = path.display();
        let staged = work.join("kit");
        std::fs::create_dir_all(&staged).map_err(|error| error.to_string())?;
        let copy =
            |from: &Path, name: &str| std::fs::copy(from, staged.join(name)).map(|_| ()).map_err(|error| format!("cannot copy {}: {error}", from.display()));
        if path.is_dir() {
            let text = std::fs::read_to_string(path.join("kit.json")).map_err(|_| format!("{shown}: it has no kit.json"))?;
            let executable = executable_name(&manifest_executable(&text).map_err(|why| format!("{shown}: {why}"))?);
            if !path.join(&executable).is_file() {
                return Err(format!("{shown}: it has no {executable} beside its kit.json"));
            }
            copy(&path.join("kit.json"), "kit.json")?;
            copy(&path.join(&executable), &executable)?;
        } else if path.is_file() {
            if gzip(path) {
                unpack(path, &staged).map_err(|why| format!("{shown}: {why}: refused"))?;
            } else {
                let text = kition_kits::definitions::manifest_beside(path).ok_or_else(|| {
                    format!("{shown}: no kit.json above it names it (`headless.executable`); give the kit's archive or the folder holding kit.json and the executable")
                })?;
                let executable = executable_name(&manifest_executable(&text).map_err(|why| format!("{shown}: {why}"))?);
                std::fs::write(staged.join("kit.json"), &text).map_err(|error| error.to_string())?;
                copy(path, &executable)?;
            }
        } else {
            return Err(format!("{shown}: no such file or folder"));
        }
        let text = std::fs::read_to_string(staged.join("kit.json")).map_err(|_| format!("{shown}: it has no kit.json at its top: refused"))?;
        let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("{shown}: its kit.json is not JSON: {error}: refused"))?;
        let field = |pointer: &str| manifest.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_owned();
        let id = field("/id");
        let name = id
            .strip_prefix("kit.")
            .filter(|name| crate::index::short_name(name))
            .map(str::to_owned)
            .ok_or_else(|| format!("{shown}: its kit.json's id `{id}` is not kit.<name>, the name lowercase letters and digits: refused"))?;
        let version = Version::parse(&field("/version"))
            .map_err(|_| format!("{shown}: its kit.json's version `{}` is not a version (semver): refused", field("/version")))?;
        let protocol = field("/headless/protocol");
        if protocol.is_empty() {
            return Err(format!("{shown}: its kit.json names no protocol (`headless.protocol`): refused"));
        }
        speaks(&name, &protocol).map_err(|why| format!("{name} {version} cannot be installed: {why}"))?;
        check_unpacked(&staged, &id, &version, &protocol).map_err(|why| format!("{shown}: {why}: refused"))?;
        if self.kit(&name).is_some_and(|stored| stored.versions.iter().any(|installed| installed.version == version)) {
            return Ok((name, Outcome::Present(version)));
        }
        self.place(&staged, &name, &version).map(|outcome| (name, outcome))
    }

    /// Writes the version in use of `name` into the folder `out` as a kit archive laid out like the
    /// index's, `kition-<kit>-<version>-<platform>.tar.gz` (kit.json and the executable at its
    /// top), for [`Store::add`] on another machine; answers its path.
    pub fn pack(&self, name: &str, out: &Path) -> Result<PathBuf, String> {
        let kit = self.kit(name).ok_or_else(|| format!("{name} is not installed: install it with `kition kit install {name}` or `kition kit add <path>`"))?;
        let installed = kit.in_use().ok_or_else(|| format!("{name} has no version in use"))?;
        let manifest: Value = serde_json::from_str(&installed.manifest).map_err(|error| format!("{name}: its kit.json is not JSON: {error}"))?;
        let executable = executable_name(manifest.pointer("/headless/executable").and_then(Value::as_str).unwrap_or_default());
        std::fs::create_dir_all(out).map_err(|error| format!("cannot write {}: {error}", out.display()))?;
        let file = out.join(format!("kition-{name}-{}-{}.tar.gz", installed.version, crate::home::platform()));
        let scratch = crate::fetch::scratch(out, ".kition-pack");
        let written = write_archive(&scratch, &[("kit.json", &installed.folder.join("kit.json"), 0o644), (&executable, &installed.executable, 0o755)])
            .and_then(|()| std::fs::rename(&scratch, &file).map_err(|error| error.to_string()));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&scratch);
            return Err(format!("cannot write {}: {error}", file.display()));
        }
        Ok(file)
    }

    /// Clears what installs and removals left in `tmp/` more than a day ago (a process that was
    /// killed); work in progress is younger.
    fn sweep(&self) {
        let old = |path: &Path| {
            std::fs::symlink_metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| SystemTime::now().duration_since(at).ok())
                .is_some_and(|age| age > Duration::from_secs(24 * 3600))
        };
        for entry in std::fs::read_dir(self.home.tmp()).into_iter().flatten().flatten() {
            let path = entry.path();
            if old(&path) {
                let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
            }
        }
    }
}

/// The path of an archive entry inside the folder it unpacks to: relative, with no `..`, no root
/// and no drive. `None` for one that would land elsewhere.
fn inside(path: &Path) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

/// Unpacks the `.tar.gz` `archive` into `to`: plain files and folders only, each inside `to`.
pub fn unpack(archive: &Path, to: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut total: u64 = 0;
    for entry in tar.entries().map_err(|error| format!("not a .tar.gz archive: {error}"))? {
        let mut entry = entry.map_err(|error| format!("not a .tar.gz archive: {error}"))?;
        let raw = entry.path().map_err(|error| format!("an entry's path is unreadable: {error}"))?.into_owned();
        let Some(relative) = inside(&raw) else {
            if raw.components().all(|component| component == Component::CurDir) {
                continue;
            }
            return Err(format!("the entry `{}` would be written outside the kit's folder", raw.display()));
        };
        let target = to.join(&relative);
        match entry.header().entry_type() {
            tar::EntryType::Directory => std::fs::create_dir_all(&target).map_err(|error| error.to_string())?,
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                total += entry.header().size().unwrap_or(0);
                if total > UNPACKED_LIMIT {
                    return Err(format!("it unpacks to more than {UNPACKED_LIMIT} bytes"));
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let mut out = std::fs::File::create(&target).map_err(|error| error.to_string())?;
                std::io::copy(&mut (&mut entry).take(UNPACKED_LIMIT), &mut out)
                    .map_err(|error| format!("unpacking `{}` failed: {error}", relative.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = entry.header().mode().unwrap_or(0o644) & 0o755;
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode | 0o600)).map_err(|error| error.to_string())?;
                }
            }
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader | tar::EntryType::GNULongName => {}
            other => return Err(format!("the entry `{}` is a {other:?}, not a file or folder", raw.display())),
        }
    }
    Ok(())
}

/// The files of the npm package unpacked into `unpacked`: its folder `package/`, whose
/// `package.json` must name `package` at `version` (the package the index lists, nothing else),
/// and which holds nothing else of npm's once that is checked and taken away.
pub(crate) fn npm_root(unpacked: &Path, package: &str, version: &Version) -> Result<PathBuf, String> {
    let root = unpacked.join("package");
    let others: Vec<String> = std::fs::read_dir(unpacked)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != "package")
        .collect();
    if !root.is_dir() || !others.is_empty() {
        return Err("it is not an npm package (one folder `package/` at its top)".to_owned());
    }
    let text = std::fs::read_to_string(root.join("package.json")).map_err(|_| "it has no package/package.json".to_owned())?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("its package.json is not JSON: {error}"))?;
    let field = |name: &str| manifest.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
    if field("name") != package || field("version") != version.to_string() {
        return Err(format!("its package.json is {}@{}, and the kit index lists {package}@{version}", field("name"), field("version")));
    }
    std::fs::remove_file(root.join("package.json")).map_err(|error| error.to_string())?;
    Ok(root)
}

/// Whether this program speaks `protocol`, a kit's (`name`); else why not and what to do.
pub fn speaks(name: &str, protocol: &str) -> Result<(), String> {
    let ours = crate::protocol();
    if protocol == ours {
        return Ok(());
    }
    Err(format!(
        "it speaks {protocol}, and this kition {} speaks {ours}: install a version of the kit that speaks {ours} (`kition kit install {name}`)",
        crate::VERSION
    ))
}

/// The executable a kit.json names (`headless.executable`), without a folder.
fn manifest_executable(text: &str) -> Result<String, String> {
    let manifest: Value = serde_json::from_str(text).map_err(|error| format!("its kit.json is not JSON: {error}"))?;
    match manifest.pointer("/headless/executable").and_then(Value::as_str) {
        Some(executable) if !executable.is_empty() && !executable.contains(['/', '\\']) => Ok(executable.to_owned()),
        _ => Err("its kit.json names no executable (`headless.executable`)".to_owned()),
    }
}

/// Whether `path` starts as a gzip stream does.
fn gzip(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic)).is_ok() && magic == [0x1f, 0x8b]
}

/// Writes the `.tar.gz` `archive` holding `files` (name in the archive, the file, its mode) at its
/// top.
fn write_archive(archive: &Path, files: &[(&str, &Path, u32)]) -> Result<(), String> {
    let out = std::fs::File::create(archive).map_err(|error| error.to_string())?;
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(out, flate2::Compression::default()));
    for (name, from, mode) in files {
        let mut file = std::fs::File::open(from).map_err(|error| format!("cannot read {}: {error}", from.display()))?;
        let meta = file.metadata().map_err(|error| error.to_string())?;
        let mut header = tar::Header::new_gnu();
        header.set_size(meta.len());
        header.set_mode(*mode);
        header.set_mtime(meta.modified().ok().and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |since| since.as_secs()));
        header.set_cksum();
        builder.append_data(&mut header, name, &mut file).map_err(|error| error.to_string())?;
    }
    let encoder = builder.into_inner().map_err(|error| error.to_string())?;
    let file = encoder.finish().map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

/// Checks a kit unpacked into `folder` against what it must be: its `kit.json` is the kit `id`
/// at `version`, speaks `protocol`, and its executable is there.
fn check_unpacked(folder: &Path, id: &str, version: &Version, protocol: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(folder.join("kit.json")).map_err(|_| "it has no kit.json at its top".to_owned())?;
    let manifest: Value = serde_json::from_str(&text).map_err(|error| format!("its kit.json is not JSON: {error}"))?;
    let field = |pointer: &str| manifest.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_owned();
    if field("/id") != id {
        return Err(format!("its kit.json is {}, and the index lists {id}", field("/id")));
    }
    if field("/version") != version.to_string() {
        return Err(format!("its kit.json is version {}, and the index lists {version}", field("/version")));
    }
    if field("/headless/protocol") != protocol {
        return Err(format!("its kit.json speaks `{}`, and the index gives {protocol}", field("/headless/protocol")));
    }
    let executable = field("/headless/executable");
    if executable.is_empty() || executable.contains(['/', '\\']) {
        return Err("its kit.json names no executable (`headless.executable`)".to_owned());
    }
    let path = folder.join(executable_name(&executable));
    if !path.is_file() {
        return Err(format!("it has no {} beside its kit.json", executable_name(&executable)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|error| error.to_string())?;
    }
    kition_kits::KitDefinition::from_manifest_text(&text).map_err(|error| format!("its kit.json declares no usable kit: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_outside_the_folder_are_refused() {
        assert_eq!(inside(Path::new("./kit.json")), Some(PathBuf::from("kit.json")));
        assert_eq!(inside(Path::new("bin/x")), Some(PathBuf::from("bin/x")));
        assert_eq!(inside(Path::new("../x")), None);
        assert_eq!(inside(Path::new("a/../../x")), None);
        assert_eq!(inside(Path::new("/etc/passwd")), None);
    }
}
