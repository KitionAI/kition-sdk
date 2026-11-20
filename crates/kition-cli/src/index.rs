//! The kit index: one JSON file listing every kit `kition` can install, each version's Kit
//! Process Protocol, and per platform its archive's address, size and SHA-256
//! (`schemas/kits-index.schema.json`). A kit archive is a `.tar.gz` holding the kit's `kit.json`
//! and its executable.
//!
//! The index is read from `KITION_INDEX`, `--index`, or [`DEFAULT_INDEX`], the index gathered from
//! the kit repositories' releases (kition-sdk's `tools/kits-index.mjs`); each read is kept in the
//! home's `cache/`, so a person without a network still sees what was there last time.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::home::Home;

/// The index format this program reads (`schemaVersion`).
pub const SCHEMA_VERSION: u64 = 1;

/// Where the index is when nothing else is named: the one file of the branch `kits-index` of
/// kition-sdk, which `.github/workflows/kits-index.yml` gathers from every kit repository's releases.
pub const DEFAULT_INDEX: &str = "https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json";

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
    /// Its archive for each platform (`darwin-arm64`, `linux-x64`, `win32-x64`, ...).
    pub platforms: BTreeMap<String, Archive>,
    /// Its editor package (the kit's UI, engine and fonts for a Kit UI protocol host): a `.tar.gz`
    /// holding one folder `<kit>-ui/` with the editor's `index.html` and the kit's `kit.json`.
    /// The same for every platform. Absent for a version published without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<Archive>,
}

/// A kit archive: a `.tar.gz` with `kit.json` and the executable at its top.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    /// Its address, or a path; a relative one is beside the index.
    pub url: String,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: String,
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
    /// version and archive well formed.
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(text).map_err(|error| format!("the kit index is not JSON: {error}"))?;
        match value.get("schemaVersion").and_then(serde_json::Value::as_u64) {
            Some(SCHEMA_VERSION) => {}
            Some(newer) if newer > SCHEMA_VERSION => {
                return Err(format!("the kit index is format {newer}, and this kition {} reads format {SCHEMA_VERSION}: upgrade kition", crate::VERSION));
            }
            _ => return Err(format!("the kit index has no `schemaVersion` {SCHEMA_VERSION}")),
        }
        let index: Self = serde_json::from_value(value).map_err(|error| format!("the kit index is malformed: {error}"))?;
        index.check()?;
        Ok(index)
    }

    fn check(&self) -> Result<(), String> {
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
                    let hex = archive.sha256.len() == 64 && archive.sha256.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
                    if !hex || archive.size == 0 || archive.url.trim().is_empty() {
                        return bad(format!("{version} {platform}: an archive has a url, a size above 0 and a lowercase hex sha256"));
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
    /// `given` (`--index`), else `KITION_INDEX`, else [`DEFAULT_INDEX`].
    pub fn choose(given: Option<&str>) -> Self {
        let location = given
            .map(str::to_owned)
            .or_else(|| std::env::var(INDEX_VARIABLE).ok().filter(|value| !value.trim().is_empty()))
            .unwrap_or_else(|| DEFAULT_INDEX.to_owned());
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
    /// Where it came from, for resolving archive addresses.
    pub location: String,
    /// `Some(why)` when it is the copy kept from an earlier read, because reading it now failed.
    pub stale: Option<String>,
}

/// How fresh the index must be.
#[derive(Clone, Copy, Debug)]
pub enum Freshness {
    /// Read it now; the kept copy only when that fails.
    Now,
    /// The kept copy when it is younger than this; else as [`Freshness::Now`].
    Within(Duration),
}

/// Reads the index from `source`, keeping each good read in the home's cache.
pub fn load(home: &Home, source: &Source, freshness: Freshness) -> Result<Loaded, String> {
    let cache = source.cache_file(home);
    let cached = || -> Option<Index> { Index::parse(&std::fs::read_to_string(&cache).ok()?).ok() };
    if let Freshness::Within(age) = freshness {
        let young = std::fs::metadata(&cache)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|since| since < age);
        if young && let Some(index) = cached() {
            return Ok(Loaded { index, location: source.location.clone(), stale: None });
        }
    }
    let read = crate::fetch::read_text(&source.location, INDEX_LIMIT).and_then(|text| Index::parse(&text).map(|index| (index, text)));
    match read {
        Ok((index, text)) => {
            // A cache that cannot be written only costs the offline copy.
            let _ = std::fs::create_dir_all(home.cache()).and_then(|()| {
                let scratch = crate::fetch::scratch(&home.cache(), "index");
                std::fs::write(&scratch, text)?;
                std::fs::rename(&scratch, &cache)
            });
            Ok(Loaded { index, location: source.location.clone(), stale: None })
        }
        Err(error) => match cached() {
            Some(index) => Ok(Loaded { index, location: source.location.clone(), stale: Some(error) }),
            None => Err(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "kits": { "note": { "id": "kit.note", "name": "Note", "extensions": ["md", "markdown"], "versions": {
                "0.3.0": { "protocol": "kition-kit/1", "platforms": { "darwin-arm64": { "url": "kition-note-0.3.0-darwin-arm64.tar.gz", "size": 10, "sha256": "a".repeat(64) } },
                    "ui": { "url": "kition-note-0.3.0.tgz", "size": 20, "sha256": "b".repeat(64) } },
                "0.10.0": { "protocol": "kition-kit/1", "platforms": {} }
            } } }
        })
    }

    #[test]
    fn reads_a_good_index_and_orders_versions_by_semver() {
        let index = Index::parse(&sample().to_string()).unwrap();
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
        assert!(Index::parse(&newer.to_string()).unwrap_err().contains("upgrade kition"));
        let mut id = sample();
        id["kits"]["note"]["id"] = json!("kit.table");
        assert!(Index::parse(&id.to_string()).unwrap_err().contains("not `kit.note`"));
        let mut hash = sample();
        hash["kits"]["note"]["versions"]["0.3.0"]["platforms"]["darwin-arm64"]["sha256"] = json!("ABC");
        assert!(Index::parse(&hash.to_string()).is_err());
        let mut ui = sample();
        ui["kits"]["note"]["versions"]["0.3.0"]["ui"]["size"] = json!(0);
        assert!(Index::parse(&ui.to_string()).unwrap_err().contains("0.3.0 ui"));
        let mut version = sample();
        version["kits"]["note"]["versions"]["latest"] = json!({ "protocol": "kition-kit/1", "platforms": {} });
        assert!(Index::parse(&version.to_string()).unwrap_err().contains("semver"));
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
