//! The kit index: one JSON file listing every kit `kition` can install, each version's Kit
//! Process Protocol, and per platform the npm package holding its kit (`kit.json` and the
//! executable), with the package's size and integrity (`schemas/kits-index.schema.json`);
//! per version, the package holding its editor. Packages are downloaded from npm registries
//! (`registry.rs`) and checked against the integrity the index gives.
//!
//! The index is read from `--index` or `KITION_INDEX` (an address or a file), else from the npm
//! package [`Scope::index_package`] (`@kition/kits-index`) at its `latest`, which kition-sdk's `.github/workflows/kits-index.yml`
//! publishes from the kit packages' registry metadata (`tools/kits-index.mjs`); each read is kept
//! in the home's `cache/`, so a person without a network still sees what was there last time.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::home::Home;
use crate::registry::{self, Registries, Scope};

/// The index format this program reads (`schemaVersion`).
pub const SCHEMA_VERSION: u64 = 1;

/// Where the index is when nothing else is named and `KITION_NPM_SCOPE` is not set: the npm
/// package `@kition/kits-index` at its `latest`, from the registries `registry.rs` lists. In
/// another scope, its [`Scope::index_package`] (`<scope>/kits`).
pub const DEFAULT_INDEX: &str = "npm:@kition/kits-index";

/// The variable that names another index: an address or a file.
pub const INDEX_VARIABLE: &str = "KITION_INDEX";

/// The most an index may weigh.
const INDEX_LIMIT: u64 = 8 * 1024 * 1024;

/// The kit index.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub schema_version: u64,
    /// Each kit by its short name (`note` for `kit.note`).
    pub kits: BTreeMap<String, IndexKit>,
}

/// One kit in the index.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexKit {
    /// Its `kit.json` `id`: `kit.<short name>`.
    pub id: String,
    /// Its display name (`kit.json` `name`).
    pub name: String,
    /// The extensions it edits, lowercase, without the dot.
    pub extensions: Vec<String>,
    /// The extensions it only views (opened read-only), lowercase, without the dot; absent from an
    /// index made before the index listed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<String>,
    /// Each version (semver) published.
    pub versions: BTreeMap<String, IndexVersion>,
}

/// One version of a kit.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexVersion {
    /// The Kit Process Protocol it speaks, as its `kit.json` says (`headless.protocol`):
    /// `kition-kit/1`.
    pub protocol: String,
    /// Its package for each platform (`darwin-arm64`, `linux-x64`, `win32-x64`, ...):
    /// `@kition/kit-<kit>-<platform>` (in layout 1 `<scope>/<kit>-<platform>`), `kit.json` and the
    /// executable at its top.
    pub platforms: BTreeMap<String, Archive>,
    /// Its editor package (the kit's UI, engine and fonts for a Kit UI protocol host),
    /// `@kition/kit-<kit>-ui` (in layout 1 `<scope>/<kit>`): one folder `<kit>-ui/` with the editor's `index.html` and the
    /// kit's `kit.json`. The same for every platform. Absent for a version published without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<Archive>,
}

/// One npm package of a kit version, at the version it is listed under: its name, its tarball's
/// size and npm's integrity of it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    /// `@kition/kit-<kit>-<platform>` or `@kition/kit-<kit>-ui` ([`Scope::kit_package`]).
    pub package: String,
    /// The tarball's bytes.
    pub size: u64,
    /// `sha512-<base64>`, as npm's `dist.integrity`.
    pub integrity: String,
}

/// Whether `name` is a kit's short name or an extension: lowercase letters and digits, a letter first.
pub fn short_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// The protocol version a `kition-kit/<n>` names.
pub fn protocol_number(protocol: &str) -> Option<u32> {
    protocol.strip_prefix("kition-kit/")?.parse().ok()
}

impl Index {
    /// The index in `text`, checked: the format version this program reads, and every kit,
    /// version and archive well formed, each package named as `scope` names it.
    pub fn parse(text: &str, scope: &Scope) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|error| format!("the kit index is not JSON: {error}"))?;
        match value.get("schemaVersion").and_then(serde_json::Value::as_u64) {
            Some(SCHEMA_VERSION) => {}
            Some(other) => return Err(format!("the kit index is format {other}, and this kition {} reads format {SCHEMA_VERSION}", crate::VERSION)),
            None => return Err(format!("the kit index has no `schemaVersion` {SCHEMA_VERSION}")),
        }
        let mut index: Self = serde_json::from_value(value).map_err(|error| format!("the kit index is malformed: {error}"))?;
        // npm's placeholder of a first publish is no kit version: never chosen, never downloaded.
        for kit in index.kits.values_mut() {
            kit.versions.remove(registry::NPM_PLACEHOLDER);
        }
        index.check(scope)?;
        Ok(index)
    }

    fn check(&self, scope: &Scope) -> Result<(), String> {
        for (name, kit) in &self.kits {
            let bad = |what: String| Err(format!("the kit index is malformed: kit `{name}`: {what}"));
            if !short_name(name) {
                return bad("a kit's name is lowercase letters and digits".into());
            }
            if kit.id != format!("kit.{name}") {
                return bad(format!("its id is `{}`, not `kit.{name}`", kit.id));
            }
            if kit.name.trim().is_empty() {
                return bad("it has no display name".into());
            }
            if kit.extensions.is_empty() || !kit.extensions.iter().all(|extension| short_name(extension)) {
                return bad("its extensions are lowercase letters and digits, without the dot, and at least one".into());
            }
            for (version, entry) in &kit.versions {
                if Version::parse(version).is_err() {
                    return bad(format!("`{version}` is not a version (semver)"));
                }
                if protocol_number(&entry.protocol).is_none() {
                    return bad(format!("{version}: the protocol `{}` is not `kition-kit/<n>`", entry.protocol));
                }
                for (platform, archive) in
                    entry.platforms.iter().map(|(platform, archive)| (platform.as_str(), archive)).chain(entry.ui.iter().map(|ui| ("ui", ui)))
                {
                    let Some(expected) = scope.kit_package(name, platform) else {
                        return bad(format!("{name} is another package's name in {}, not a kit's", scope.name()));
                    };
                    if archive.package != expected || !scope.owns(&archive.package) {
                        return bad(format!("{version} {platform}: its package is `{}`, not {expected}", archive.package));
                    }
                    if archive.size == 0 || !registry::integrity_form(&archive.integrity) {
                        return bad(format!("{version} {platform}: a package has a size above 0 and an integrity sha512-<base64>"));
                    }
                }
            }
        }
        Ok(())
    }

    /// The kit named `name` (`note`), or whose id is `name` (`kit.note`).
    pub fn kit(&self, name: &str) -> Option<(&str, &IndexKit)> {
        let short = name.strip_prefix("kit.").unwrap_or(name);
        self.kits.get_key_value(short).map(|(name, kit)| (name.as_str(), kit))
    }

    /// The kit that edits files with `extension` (lowercase, no dot).
    pub fn for_extension(&self, extension: &str) -> Option<(&str, &IndexKit)> {
        self.kits.iter().find(|(_, kit)| kit.extensions.iter().any(|known| known == extension)).map(|(name, kit)| (name.as_str(), kit))
    }
}

impl IndexKit {
    /// Its versions, newest first.
    pub fn versions(&self) -> Vec<(Version, &IndexVersion)> {
        let mut versions: Vec<(Version, &IndexVersion)> =
            self.versions.iter().filter_map(|(version, entry)| Some((Version::parse(version).ok()?, entry))).collect();
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        versions
    }

    /// The newest version, whatever it speaks and wherever it runs.
    pub fn latest(&self) -> Option<Version> {
        self.versions().into_iter().next().map(|(version, _)| version)
    }
}

/// Where the index is read from.
#[derive(Clone, Debug)]
pub struct Source {
    pub location: String,
}

impl Source {
    /// `given` (`--index`), else `KITION_INDEX`, else the index package of the scope
    /// (`KITION_NPM_SCOPE`; [`DEFAULT_INDEX`] without it): an address or a file, or `npm:<package>`
    /// for the index package on the npm registries. A malformed scope leaves [`DEFAULT_INDEX`]
    /// here; [`load`] refuses it before reading anything.
    pub fn choose(given: Option<&str>) -> Self {
        let location = given
            .map(str::to_owned)
            .or_else(|| std::env::var(INDEX_VARIABLE).ok().filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| Scope::from_env().map_or_else(|_| DEFAULT_INDEX.to_owned(), |scope| format!("npm:{}", scope.index_package())));
        Self { location }
    }

    fn cache_file(&self, home: &Home) -> PathBuf {
        let key = hex::encode(&Sha256::digest(self.location.as_bytes())[..8]);
        home.cache().join(format!("kits-index-{key}.json"))
    }

    /// How long ago the copy of this index kept in `home` was read; `None` when none is kept.
    pub fn kept_age(&self, home: &Home) -> Option<Duration> {
        let at = std::fs::metadata(self.cache_file(home)).and_then(|meta| meta.modified()).ok()?;
        Some(SystemTime::now().duration_since(at).unwrap_or_default())
    }
}

/// An index read, and how.
#[derive(Clone, Debug)]
pub struct Loaded {
    pub index: Index,
    /// Where it came from: an address, a file, or `npm:<package>@<version> from <registry>`.
    pub location: String,
    /// `Some(why)` when it is the copy kept from an earlier read, because reading it now failed.
    pub stale: Option<String>,
    /// The npm registries its packages are downloaded from (`registry::configured`).
    pub registries: Registries,
}

/// How fresh the index must be.
#[derive(Clone, Copy, Debug)]
pub enum Freshness {
    /// Read it now; the kept copy only when that fails.
    Now,
    /// The kept copy when it is younger than this; else as [`Freshness::Now`].
    Within(Duration),
}

/// Reads the index from `source`, keeping each good read in the home's cache. Its packages must be
/// those of the scope `KITION_NPM_SCOPE` names; a malformed scope is refused before anything is read.
pub fn load(home: &Home, source: &Source, freshness: Freshness) -> Result<Loaded, String> {
    let scope = Scope::from_env()?;
    let cache = source.cache_file(home);
    let cached = || -> Option<Index> { Index::parse(&std::fs::read_to_string(&cache).ok()?, &scope).ok() };
    if let Freshness::Within(age) = freshness {
        let young = std::fs::metadata(&cache)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|since| since < age);
        if young && let Some(index) = cached() {
            return Ok(Loaded { index, location: source.location.clone(), stale: None, registries: registry::configured() });
        }
    }
    let read = match source.location.strip_prefix("npm:") {
        Some(package) => read_package(home, package, &scope),
        None => crate::fetch::read_text(&source.location, INDEX_LIMIT).map(|text| (text, source.location.clone())),
    }
    .and_then(|(text, location)| Index::parse(&text, &scope).map(|index| (index, text, location)));
    match read {
        Ok((index, text, location)) => {
            // A cache that cannot be written only costs the offline copy.
            let _ = std::fs::create_dir_all(home.cache()).and_then(|()| {
                let scratch = crate::fetch::scratch(&home.cache(), "index");
                std::fs::write(&scratch, text)?;
                std::fs::rename(&scratch, &cache)
            });
            Ok(Loaded { index, location, stale: None, registries: registry::configured() })
        }
        Err(error) => match cached() {
            Some(index) => Ok(Loaded { index, location: source.location.clone(), stale: Some(error), registries: registry::configured() }),
            None => Err(error),
        },
    }
}

/// The index in the npm package `package` at its `latest`, from the first registry that has it:
/// its `kits-index.json`, and where it came from. The tarball must have the integrity the
/// registry's own metadata gives.
fn read_package(home: &Home, package: &str, scope: &Scope) -> Result<(String, String), String> {
    if !scope.owns(package) {
        return Err(format!("{package} is not a package of {}", scope.name()));
    }
    let registries = registry::configured();
    let (metadata, answered) = registry::read_json(&registries, &registry::metadata_path(package, "latest"), 4 * 1024 * 1024)?;
    let version =
        metadata.get("version").and_then(serde_json::Value::as_str).ok_or_else(|| format!("{answered}: {package}'s latest names no version"))?.to_owned();
    // A first publish: npm points latest at its placeholder until the version published shows.
    if registry::is_placeholder(&version) {
        return Err(registry::being_published(package));
    }
    let integrity = metadata.pointer("/dist/integrity").and_then(serde_json::Value::as_str).filter(|integrity| registry::integrity_form(integrity));
    let integrity = integrity.ok_or_else(|| format!("{answered}: {package}@{version} gives no sha512 integrity"))?.to_owned();
    // The registry that answered first, then the others.
    let mut order = vec![answered.clone()];
    order.extend(registries.0.into_iter().filter(|other| other != &answered));
    std::fs::create_dir_all(home.tmp()).map_err(|error| format!("cannot write {}: {error}", home.tmp().display()))?;
    let file = crate::fetch::scratch(&home.tmp(), "index");
    let got = registry::download_bounded(&Registries(order), package, &version, INDEX_LIMIT, &integrity, &file);
    let text = got.and_then(|from| {
        let text = registry::read_member(&file, "package/kits-index.json", INDEX_LIMIT).map_err(|why| format!("{package}@{version}: {why}"))?;
        Ok((text, format!("npm:{package}@{version} from {from}")))
    });
    let _ = std::fs::remove_file(&file);
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "kits": { "note": { "id": "kit.note", "name": "Note", "extensions": ["md", "markdown"], "versions": {
                "0.3.0": { "protocol": "kition-kit/1", "platforms": { "darwin-arm64": { "package": "@kition/kit-note-darwin-arm64", "size": 10, "integrity": format!("sha512-{}==", "a".repeat(86)) } },
                    "ui": { "package": "@kition/kit-note-ui", "size": 20, "integrity": format!("sha512-{}==", "b".repeat(86)) } },
                "0.10.0": { "protocol": "kition-kit/1", "platforms": {} }
            } } }
        })
    }

    #[test]
    fn reads_a_good_index_and_orders_versions_by_semver() {
        let index = Index::parse(&sample().to_string(), &Scope::default()).unwrap();
        assert_eq!(index.kits["note"].versions["0.3.0"].ui.as_ref().map(|ui| ui.size), Some(20));
        assert!(index.kits["note"].versions["0.10.0"].ui.is_none(), "a version without an editor package");
        let (name, kit) = index.for_extension("markdown").unwrap();
        assert_eq!(name, "note");
        assert_eq!(kit.latest().unwrap().to_string(), "0.10.0");
        assert!(index.kit("kit.note").is_some() && index.kit("table").is_none());
    }

    #[test]
    fn refuses_a_newer_format_and_malformed_entries() {
        let mut newer = sample();
        newer["schemaVersion"] = json!(2);
        assert!(Index::parse(&newer.to_string(), &Scope::default()).unwrap_err().contains("the kit index is format 2, and this kition"));
        let mut id = sample();
        id["kits"]["note"]["id"] = json!("kit.table");
        assert!(Index::parse(&id.to_string(), &Scope::default()).unwrap_err().contains("not `kit.note`"));
        let mut hash = sample();
        hash["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["integrity"] = json!(format!("sha256-{}", "a".repeat(43)));
        assert!(Index::parse(&hash.to_string(), &Scope::default()).is_err());
        // A package of another kit, or out of the scope: an index cannot point a kit at it.
        for other in ["@kition/kit-table-darwin-arm64", "left-pad", "@kition/kit-note-ui"] {
            let mut wrong = sample();
            wrong["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["package"] = json!(other);
            assert!(Index::parse(&wrong.to_string(), &Scope::default()).unwrap_err().contains("its package is"), "{other}");
        }
        let mut addresses = sample();
        addresses["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"] =
            json!({ "url": "https://github.com/x.tar.gz", "size": 1, "sha256": "a".repeat(64) });
        assert!(Index::parse(&addresses.to_string(), &Scope::default()).is_err(), "an index of GitHub addresses is no longer read");
        let mut ui = sample();
        ui["kits"]["note"]["versions"]["0.3.0"]["ui"]["size"] = json!(0);
        assert!(Index::parse(&ui.to_string(), &Scope::default()).unwrap_err().contains("0.3.0 ui"));
        let mut version = sample();
        version["kits"]["note"]["versions"]["latest"] = json!({ "protocol": "kition-kit/1", "platforms": {} });
        assert!(Index::parse(&version.to_string(), &Scope::default()).unwrap_err().contains("semver"));
    }

    /// The sample with layout 1's names in `scope`.
    fn sample_in(scope: &str) -> serde_json::Value {
        let mut index = sample();
        let version = &mut index["kits"]["note"]["versions"]["0.3.0"];
        version["platforms"]["darwin-arm64"]["package"] = json!(format!("{scope}/note-darwin-arm64"));
        version["ui"]["package"] = json!(format!("{scope}/note"));
        index
    }

    #[test]
    fn another_scope_reads_only_its_own_packages_by_layout_1() {
        let stage = Scope::parse(Some("@kitionstage")).unwrap();
        let index = Index::parse(&sample_in("@kitionstage").to_string(), &stage).unwrap();
        assert_eq!(index.kits["note"].versions["0.3.0"].ui.as_ref().map(|ui| ui.package.as_str()), Some("@kitionstage/note"));
        // @kition's index, or @kition's names, are not the stage scope's; nor the other way round.
        assert!(Index::parse(&sample().to_string(), &stage).unwrap_err().contains("not @kitionstage/note-darwin-arm64"));
        assert!(Index::parse(&sample_in("@kitionstage").to_string(), &Scope::default()).unwrap_err().contains("not @kition/kit-note-darwin-arm64"));
        // A package of another scope, or of another kit, is refused.
        for other in
            ["@kition/note-darwin-arm64", "@other/note-darwin-arm64", "@kitionstage/table-darwin-arm64", "@kitionstage/note", "@kitionstage/cli-darwin-arm64"]
        {
            let mut wrong = sample_in("@kitionstage");
            wrong["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["package"] = json!(other);
            assert!(Index::parse(&wrong.to_string(), &stage).unwrap_err().contains("its package is"), "{other}");
        }
        // A kit named like another package of the scope is no kit there.
        let mut cli = json!({ "schemaVersion": 1, "kits": {} });
        cli["kits"]["cli"] = sample_in("@kitionstage")["kits"]["note"].clone();
        cli["kits"]["cli"]["id"] = json!("kit.cli");
        cli["kits"]["cli"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["package"] = json!("@kitionstage/cli-darwin-arm64");
        cli["kits"]["cli"]["versions"]["0.3.0"]["ui"]["package"] = json!("@kitionstage/cli");
        assert!(Index::parse(&cli.to_string(), &stage).unwrap_err().contains("cli is another package's name in @kitionstage"));
        // The schema takes both layouts' names.
        let schema: serde_json::Value = serde_json::from_str(include_str!("../../../schemas/kits-index.schema.json")).unwrap();
        assert!(jsonschema::validator_for(&schema).unwrap().is_valid(&sample_in("@kitionstage")));
    }

    #[test]
    fn npms_placeholder_of_a_first_publish_is_no_kit_version() {
        let mut staged = sample();
        staged["kits"]["note"]["versions"][registry::NPM_PLACEHOLDER] = staged["kits"]["note"]["versions"]["0.3.0"].clone();
        let index = Index::parse(&staged.to_string(), &Scope::default()).unwrap();
        assert!(!index.kits["note"].versions.contains_key(registry::NPM_PLACEHOLDER));
        assert_eq!(index.kits["note"].versions().iter().map(|(version, _)| version.to_string()).collect::<Vec<_>>(), ["0.10.0", "0.3.0"]);
    }

    #[test]
    fn the_sample_validates_against_the_schema() {
        let schema: serde_json::Value = serde_json::from_str(include_str!("../../../schemas/kits-index.schema.json")).unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        assert!(validator.is_valid(&sample()));
        let mut bad = sample();
        bad["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["size"] = json!(0);
        assert!(!validator.is_valid(&bad));
    }

    #[test]
    fn an_unreachable_index_falls_back_to_the_kept_copy() {
        let dir = tempfile::tempdir().unwrap();
        let home = Home::at(dir.path().join("home"));
        let file = dir.path().join("kits-index.json");
        std::fs::write(&file, sample().to_string()).unwrap();
        let source = Source { location: file.display().to_string() };
        assert!(load(&home, &source, Freshness::Now).unwrap().stale.is_none());
        std::fs::remove_file(&file).unwrap();
        let loaded = load(&home, &source, Freshness::Now).unwrap();
        assert!(loaded.stale.is_some());
        assert!(loaded.index.kit("note").is_some());
        assert!(load(&home, &source, Freshness::Within(Duration::from_secs(3600))).unwrap().stale.is_none());
        let other = Source { location: dir.path().join("missing.json").display().to_string() };
        assert!(load(&home, &other, Freshness::Now).is_err());
    }
}
