//! Where kits, their editors and the kit index are downloaded from: npm registries. Every kit
//! version is published as npm packages (`@kition/kit-<kit>-<platform>`, `@kition/kit-<kit>-ui`,
//! kition-sdk's `tools/kit-npm.mjs`), and the kit index as `@kition/kits-index`; npm has mirrors
//! where GitHub is slow or out of reach. `KITION_NPM_SCOPE` names another scope ([`Scope`]),
//! whose packages are named by layout 1: `<scope>/<kit>-<platform>`, `<scope>/<kit>`, `<scope>/kits`.
//!
//! The registries, in the order they are tried ([`Registries::from_env`]):
//!
//! 1. `KITION_NPM_REGISTRY`: one address, or several separated by commas;
//! 2. npm's own setting, as npm reads it for the scope (`@kition`): `@kition:registry` in
//!    `~/.npmrc`, else `npm_config_registry` (or `NPM_CONFIG_REGISTRY`), else `registry` in
//!    `~/.npmrc` (read here; npm is never started);
//! 3. <https://registry.npmjs.org/>, then <https://registry.npmmirror.com/>.
//!
//! A registry that does not answer within [`CONNECT_TIMEOUT`], or answers an error, passes to the
//! next. A download cut short is taken up where it stopped (an HTTP range) once, then from the
//! next registry. Whatever a registry or mirror serves, the bytes must have the integrity (SHA-512)
//! the kit index gives, so no source can substitute another package.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha512};

/// The variable naming the npm scope of the kit packages and the kit index.
pub const SCOPE_VARIABLE: &str = "KITION_NPM_SCOPE";
/// The scope when [`SCOPE_VARIABLE`] is not set (or empty).
pub const DEFAULT_SCOPE: &str = "@kition";
/// The scopes whose packages keep the legacy names (`kit-<kit>-ui`, `kit-<kit>-<platform>`,
/// `kits-index`); every other scope uses layout 1 (`<kit>`, `<kit>-<platform>`, `kits`). On cutover
/// day, when `@kition` moves to layout 1: empty this list, then delete [`Layout::Legacy`] and its
/// arms. The same list is in kition-sdk's `tools/kit-npm.mjs` and KitionAI/kition's
/// `scripts/lib/kitNpm.mjs`.
pub const LEGACY_LAYOUT_SCOPES: &[&str] = &["@kition"];
/// Names that are no kit's in layout 1, where a kit's packages are `<scope>/<kit>` and
/// `<scope>/<kit>-<platform>`: a kit of one of these names would be the scope's other packages
/// (`<scope>/cli`, `<scope>/cli-<platform>`, `<scope>/kits`, `<scope>/kit-editor`, ...).
pub const NOT_KIT_NAMES: &[&str] =
    &["cli", "convergence", "embed", "extensions", "gateway", "kdm", "kit", "kition", "kits", "script", "sdk", "sync", "tessera"];
/// The registries tried after the ones configured.
pub const DEFAULT_REGISTRIES: [&str; 2] = ["https://registry.npmjs.org/", "https://registry.npmmirror.com/"];
/// The variable naming the registries to try first.
pub const REGISTRY_VARIABLE: &str = "KITION_NPM_REGISTRY";
/// How long a registry has to accept the connection before the next is tried.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// npm's placeholder of a package's first publish ("staged publishing"): for several minutes after
/// a name is first published (12 to 24 for a 30 MB package), npm lists this version and points
/// `latest` at it, before the version published is visible. Its tarball is no package of ours.
pub const NPM_PLACEHOLDER: &str = "0.0.0-stage";

/// Whether `version` is [`NPM_PLACEHOLDER`].
pub fn is_placeholder(version: &str) -> bool {
    version == NPM_PLACEHOLDER
}

/// The one line said when `package`'s version on npm is still [`NPM_PLACEHOLDER`].
pub fn being_published(package: &str) -> String {
    format!("{package} is being published on npm (it shows only npm's placeholder {NPM_PLACEHOLDER} yet); try again in a few minutes")
}

/// The registries to try, in order; each address ends with `/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registries(pub Vec<String>);

/// How a scope names its packages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// `<scope>/kit-<kit>-ui`, `<scope>/kit-<kit>-<platform>`, `<scope>/kits-index`.
    Legacy,
    /// `<scope>/<kit>`, `<scope>/<kit>-<platform>`, `<scope>/kits`.
    One,
}

/// The npm scope kition installs kits and reads the kit index from: `@kition` unless
/// `KITION_NPM_SCOPE` names another.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope(String);

impl Default for Scope {
    fn default() -> Self {
        Self(DEFAULT_SCOPE.to_owned())
    }
}

impl Scope {
    /// The scope of this process: [`Scope::parse`] of `KITION_NPM_SCOPE`.
    pub fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var(SCOPE_VARIABLE).ok().as_deref())
    }

    /// `value` (the variable's), checked: `@`, then lowercase letters, digits and dashes; unset or
    /// empty is `@kition`.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        let Some(value) = value.filter(|value| !value.is_empty()) else { return Ok(Self::default()) };
        let well_formed = value.strip_prefix('@').is_some_and(|name| {
            name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
        if well_formed {
            Ok(Self(value.to_owned()))
        } else {
            Err(format!("{SCOPE_VARIABLE} is `{value}`, not an npm scope (@ then lowercase letters, digits and dashes, such as @kition)"))
        }
    }

    /// `@kition`, `@kitionstage`.
    pub fn name(&self) -> &str {
        &self.0
    }

    /// How it names its packages.
    pub fn layout(&self) -> Layout {
        if LEGACY_LAYOUT_SCOPES.contains(&self.0.as_str()) { Layout::Legacy } else { Layout::One }
    }

    /// The package holding its kit index, `kits-index.json` at its top.
    pub fn index_package(&self) -> String {
        match self.layout() {
            Layout::Legacy => format!("{}/kits-index", self.0),
            Layout::One => format!("{}/kits", self.0),
        }
    }

    /// The package of `kit`'s headless kit for `part` (a platform), or of its editor (`ui`); `None`
    /// for a name that is no kit's in this scope ([`NOT_KIT_NAMES`] in layout 1).
    pub fn kit_package(&self, kit: &str, part: &str) -> Option<String> {
        match self.layout() {
            Layout::Legacy => Some(format!("{}/kit-{kit}-{part}", self.0)),
            Layout::One if NOT_KIT_NAMES.contains(&kit) => None,
            Layout::One if part == "ui" => Some(format!("{}/{kit}", self.0)),
            Layout::One => Some(format!("{}/{kit}-{part}", self.0)),
        }
    }

    /// Whether `package` is a package kition may install: in this scope, lowercase letters,
    /// digits and dashes.
    pub fn owns(&self, package: &str) -> bool {
        package.strip_prefix(&format!("{}/", self.0)).is_some_and(|bare| {
            !bare.is_empty()
                && bare.starts_with(|c: char| c.is_ascii_lowercase())
                && bare.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    }
}

/// The registries of this process: [`Registries::from_env`] with the person's home folder.
pub fn configured() -> Registries {
    Registries::from_env(std::env::home_dir().as_deref())
}

impl Registries {
    /// From the environment and the person's `.npmrc`: `npm_config_userconfig` when set (npm's
    /// own variable for it), else `.npmrc` in `home`. As the module's documentation says.
    pub fn from_env(home: Option<&Path>) -> Self {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let file = env("npm_config_userconfig")
            .or_else(|| env("NPM_CONFIG_USERCONFIG"))
            .map(std::path::PathBuf::from)
            .or_else(|| home.map(|home| home.join(".npmrc")));
        let npmrc = file.and_then(|file| std::fs::read_to_string(file).ok()).unwrap_or_default();
        Self::from_settings(&env, &npmrc)
    }

    /// From `env` (a variable's value) and the text of an `.npmrc`.
    pub fn from_settings(env: &dyn Fn(&str) -> Option<String>, npmrc: &str) -> Self {
        let mut list: Vec<String> = Vec::new();
        let mut add = |value: &str| {
            let address = value.trim();
            let lower = address.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return;
            }
            let normal = if address.ends_with('/') { address.to_owned() } else { format!("{address}/") };
            if !list.contains(&normal) {
                list.push(normal);
            }
        };
        for value in env(REGISTRY_VARIABLE).unwrap_or_default().split(',') {
            add(value);
        }
        let settings = parse_npmrc(npmrc, env);
        // A malformed scope reads no scoped setting; reading the index refuses it (index::load).
        if let Ok(scope) = Scope::parse(env(SCOPE_VARIABLE).as_deref())
            && let Some(scoped) = settings.iter().find(|(key, _)| key == &format!("{}:registry", scope.name()))
        {
            add(&scoped.1);
        }
        let general = env("npm_config_registry")
            .or_else(|| env("NPM_CONFIG_REGISTRY"))
            .or_else(|| settings.iter().find(|(key, _)| key == "registry").map(|(_, value)| value.clone()));
        if let Some(general) = general {
            add(&general);
        }
        for address in DEFAULT_REGISTRIES {
            add(address);
        }
        Self(list)
    }

    /// The registries, joined for a message.
    pub fn named(&self) -> String {
        self.0.join(", ")
    }
}

/// The `key=value` settings of an `.npmrc`, in order: comments (`#`, `;`) and blank lines skipped,
/// quotes taken off, `${VAR}` expanded from `env`.
pub fn parse_npmrc(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut settings = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = value.trim();
        if value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''))) {
            value = &value[1..value.len() - 1];
        }
        let mut expanded = String::new();
        let mut rest = value;
        while let Some(start) = rest.find("${") {
            expanded.push_str(&rest[..start]);
            match rest[start + 2..].find('}') {
                Some(end) => {
                    expanded.push_str(&env(&rest[start + 2..start + 2 + end]).unwrap_or_default());
                    rest = &rest[start + 3 + end..];
                }
                None => {
                    expanded.push_str(&rest[start..]);
                    rest = "";
                }
            }
        }
        expanded.push_str(rest);
        settings.push((key.to_owned(), expanded));
    }
    settings
}

/// A package's tarball relative to a registry: `@kition/kit-note-ui/-/kit-note-ui-0.1.3.tgz`.
pub fn tarball_path(package: &str, version: &str) -> String {
    let bare = package.rsplit('/').next().unwrap_or(package);
    format!("{package}/-/{bare}-{version}.tgz")
}

/// A package's metadata at `tag` (a dist-tag or a version) relative to a registry.
pub fn metadata_path(package: &str, tag: &str) -> String {
    format!("{}/{tag}", package.replacen('/', "%2f", 1))
}

/// npm's integrity of `bytes`: `sha512-<base64>`.
pub fn integrity_of(digest: &[u8]) -> String {
    format!("sha512-{}", base64(digest))
}

/// Whether `integrity` is npm's SHA-512 form.
pub fn integrity_form(integrity: &str) -> bool {
    integrity.strip_prefix("sha512-").is_some_and(|encoded| {
        encoded.len() == 88 && encoded.ends_with("==") && encoded[..86].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
    })
}

/// Standard base64 with padding.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(format!("kition/{}", crate::VERSION))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(300)))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// What one registry said about a request: its reason, for the message naming every one tried.
fn failed(registry: &str, why: impl std::fmt::Display) -> String {
    format!("{registry}: {why}")
}

/// The JSON at `path` from the first registry that answers it; with the registry that did.
pub fn read_json(registries: &Registries, path: &str, limit: u64) -> Result<(serde_json::Value, String), String> {
    let mut tried = Vec::new();
    for registry in &registries.0 {
        let address = format!("{registry}{path}");
        let answer = agent().get(&address).header("Accept", "application/json").call();
        match answer {
            Ok(response) if response.status() == 200 => {
                let mut text = String::new();
                match response.into_body().into_reader().take(limit + 1).read_to_string(&mut text) {
                    Ok(_) if text.len() as u64 <= limit => match serde_json::from_str(&text) {
                        Ok(value) => return Ok((value, registry.clone())),
                        Err(error) => tried.push(failed(registry, format!("{path} is not JSON: {error}"))),
                    },
                    Ok(_) => tried.push(failed(registry, format!("{path} is larger than {limit} bytes"))),
                    Err(error) => tried.push(failed(registry, format!("reading {path} failed: {error}"))),
                }
            }
            Ok(response) => tried.push(failed(registry, format!("{path} answered HTTP {}", response.status()))),
            Err(error) => tried.push(failed(registry, format!("cannot reach it: {error}"))),
        }
    }
    Err(format!("no registry answered {path} (tried {})", tried.join("; ")))
}

/// Downloads `package` at `version` to `to`: exactly `size` bytes whose integrity is `integrity`,
/// from the first registry that serves them; answers the registry. `progress` hears the bytes
/// so far as the download goes.
pub fn download(
    registries: &Registries,
    package: &str,
    version: &str,
    size: u64,
    integrity: &str,
    to: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<String, String> {
    fetch(registries, package, version, Bytes::Exactly(size), integrity, to, progress)
}

/// [`download`] of a package whose size is not known beforehand (the index's own), at most `limit` bytes.
pub fn download_bounded(registries: &Registries, package: &str, version: &str, limit: u64, integrity: &str, to: &Path) -> Result<String, String> {
    fetch(registries, package, version, Bytes::AtMost(limit), integrity, to, &mut |_| {})
}

/// How many bytes a download must have.
#[derive(Clone, Copy)]
enum Bytes {
    Exactly(u64),
    AtMost(u64),
}

fn fetch(
    registries: &Registries,
    package: &str,
    version: &str,
    bytes: Bytes,
    integrity: &str,
    to: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<String, String> {
    let path = tarball_path(package, version);
    let mut tried = Vec::new();
    for registry in &registries.0 {
        let address = format!("{registry}{path}");
        match download_from(&address, bytes, to, progress) {
            Ok(()) => {
                let digest = Sha512::digest(std::fs::read(to).map_err(|error| format!("cannot read {}: {error}", to.display()))?);
                let found = integrity_of(&digest);
                if found == integrity {
                    return Ok(registry.clone());
                }
                tried.push(failed(registry, format!("{path} has the integrity {found}, and the kit index gives {integrity}: refused")));
            }
            Err(why) => tried.push(failed(registry, why)),
        }
    }
    Err(format!("{package} {version} could not be downloaded (tried {})", tried.join("; ")))
}

/// One registry's try: the whole file, or, when the body breaks off, the rest from where it
/// stopped (a range), once.
fn download_from(address: &str, bytes: Bytes, to: &Path, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    let (size, exact) = match bytes {
        Bytes::Exactly(size) => (size, true),
        Bytes::AtMost(limit) => (limit, false),
    };
    let mut file = std::fs::File::create(to).map_err(|error| format!("cannot write {}: {error}", to.display()))?;
    let mut read: u64 = 0;
    let mut resumed = false;
    loop {
        let mut request = agent().get(address);
        if read > 0 {
            request = request.header("Range", &format!("bytes={read}-"));
        }
        let response = request.call().map_err(|error| format!("cannot reach it: {error}"))?;
        let status = response.status().as_u16();
        match (read, status) {
            (0, 200) | (1.., 206) => {}
            (1.., 200) => {
                // No range: the registry sends it whole again.
                file = std::fs::File::create(to).map_err(|error| format!("cannot write {}: {error}", to.display()))?;
                read = 0;
            }
            (_, status) => return Err(format!("{address} answered HTTP {status}")),
        }
        let mut reader = response.into_body().into_reader();
        let mut buffer = vec![0u8; 64 * 1024];
        let cut = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break None,
                Ok(n) => {
                    read += n as u64;
                    if read > size {
                        return Err(if exact {
                            format!("{address} is larger than the {size} bytes the kit index gives: refused")
                        } else {
                            format!("{address} is larger than {size} bytes: refused")
                        });
                    }
                    file.write_all(&buffer[..n]).map_err(|error| format!("cannot write {}: {error}", to.display()))?;
                    progress(read);
                }
                Err(error) => break Some(error),
            }
        };
        match cut {
            None if read == size || (!exact && read > 0) => break,
            None if resumed => return Err(format!("{address} ended after {read} of {size} bytes")),
            Some(error) if resumed => return Err(format!("downloading {address} failed after {read} of {size} bytes: {error}")),
            _ => resumed = true,
        }
    }
    file.sync_all().map_err(|error| format!("cannot write {}: {error}", to.display()))
}

/// The file `member` (`package/kits-index.json`) of the `.tar.gz` `archive`, as text, at most `limit` bytes.
pub fn read_member(archive: &Path, member: &str, limit: u64) -> Result<String, String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar.entries().map_err(|error| format!("not a .tar.gz archive: {error}"))? {
        let mut entry = entry.map_err(|error| format!("not a .tar.gz archive: {error}"))?;
        let path = entry.path().map_err(|error| error.to_string())?.into_owned();
        if path.to_string_lossy() == member {
            let mut text = String::new();
            (&mut entry).take(limit + 1).read_to_string(&mut text).map_err(|error| format!("{member}: {error}"))?;
            if text.len() as u64 > limit {
                return Err(format!("{member} is larger than {limit} bytes"));
            }
            return Ok(text);
        }
    }
    Err(format!("it holds no {member}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect();
        move |name: &str| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

    #[test]
    fn the_registries_go_from_the_variable_through_npms_setting_to_npmjs_and_its_mirror() {
        let none = Registries::from_settings(&env_of(&[]), "");
        assert_eq!(none.0, vec!["https://registry.npmjs.org/", "https://registry.npmmirror.com/"]);
        let mine = Registries::from_settings(&env_of(&[("KITION_NPM_REGISTRY", "http://127.0.0.1:1, https://mirror.example/npm")]), "");
        assert_eq!(mine.0[..2], ["http://127.0.0.1:1/", "https://mirror.example/npm/"]);
        assert_eq!(mine.0.len(), 4);
        // npm's own setting: the scope's registry first, the environment over the file.
        let npmrc = "; a comment\n# another\nregistry = \"https://file.example/\"\n@kition:registry=${MIRROR}/scoped\n//registry.npmjs.org/:_authToken=x\n";
        let both = Registries::from_settings(&env_of(&[("MIRROR", "https://m.example"), ("npm_config_registry", "https://env.example")]), npmrc);
        assert_eq!(both.0, vec!["https://m.example/scoped/", "https://env.example/", "https://registry.npmjs.org/", "https://registry.npmmirror.com/"]);
        // Without MIRROR the scoped setting is no address, and is left out; the file's registry stays.
        let file = Registries::from_settings(&env_of(&[]), npmrc);
        assert_eq!(file.0, vec!["https://file.example/", "https://registry.npmjs.org/", "https://registry.npmmirror.com/"]);
        // npmmirror named by the person is tried where they put it, and once.
        let mirror = Registries::from_settings(&env_of(&[("npm_config_registry", "https://registry.npmmirror.com")]), "");
        assert_eq!(mirror.0, vec!["https://registry.npmmirror.com/", "https://registry.npmjs.org/"]);
        // Not an address: left out.
        assert_eq!(Registries::from_settings(&env_of(&[("KITION_NPM_REGISTRY", "file:///x")]), "registry=ftp://x").0.len(), 2);
    }

    #[test]
    fn the_scope_comes_from_kition_npm_scope_and_chooses_the_layout() {
        // Unset or empty: @kition, by the legacy names, as kition always read them.
        for unset in [None, Some("")] {
            let scope = Scope::parse(unset).unwrap();
            assert_eq!((scope.name(), scope.layout()), ("@kition", Layout::Legacy));
            assert_eq!(scope.index_package(), "@kition/kits-index");
            assert_eq!(format!("npm:{}", scope.index_package()), crate::index::DEFAULT_INDEX);
            assert_eq!(scope.kit_package("note", "ui").as_deref(), Some("@kition/kit-note-ui"));
            assert_eq!(scope.kit_package("note", "darwin-arm64").as_deref(), Some("@kition/kit-note-darwin-arm64"));
            assert_eq!(scope.kit_package("cli", "ui").as_deref(), Some("@kition/kit-cli-ui"));
        }
        // Any other scope: layout 1, and no kit named like another package of the scope.
        let stage = Scope::parse(Some("@kitionstage")).unwrap();
        assert_eq!(stage.layout(), Layout::One);
        assert_eq!(stage.index_package(), "@kitionstage/kits");
        assert_eq!(stage.kit_package("note", "ui").as_deref(), Some("@kitionstage/note"));
        assert_eq!(stage.kit_package("note", "linux-x64").as_deref(), Some("@kitionstage/note-linux-x64"));
        for other in ["cli", "sdk", "kits", "tessera", "kit"] {
            assert_eq!(stage.kit_package(other, "ui"), None, "{other}");
            assert_eq!(stage.kit_package(other, "darwin-arm64"), None, "{other}");
        }
        assert!(stage.owns("@kitionstage/note") && !stage.owns("@kition/kit-note-ui") && !Scope::default().owns("@kitionstage/note"));
        // Anything else is refused, naming the variable.
        for bad in ["kition", "@Kition", "@-x", "@", "@kition/x", "@kit ion", " @kition"] {
            assert!(Scope::parse(Some(bad)).unwrap_err().contains("KITION_NPM_SCOPE is"), "{bad}");
        }
    }

    #[test]
    fn npms_scoped_registry_setting_follows_the_scope() {
        let npmrc = "@kition:registry=https://kition.example/\n@kitionstage:registry=https://stage.example/\n";
        assert_eq!(Registries::from_settings(&env_of(&[]), npmrc).0[0], "https://kition.example/");
        assert_eq!(Registries::from_settings(&env_of(&[("KITION_NPM_SCOPE", "@kitionstage")]), npmrc).0[0], "https://stage.example/");
        assert_eq!(Registries::from_settings(&env_of(&[("KITION_NPM_SCOPE", "bad")]), npmrc).0, DEFAULT_REGISTRIES);
    }

    #[test]
    fn npm_names_its_tarballs_and_integrity_this_way() {
        assert_eq!(tarball_path("@kition/kit-note-ui", "0.1.3"), "@kition/kit-note-ui/-/kit-note-ui-0.1.3.tgz");
        assert_eq!(metadata_path("@kition/kits-index", "latest"), "@kition%2fkits-index/latest");
        let kition = Scope::default();
        assert!(kition.owns("@kition/kit-note-darwin-arm64") && !kition.owns("left-pad") && !kition.owns("@kition/../x") && !kition.owns("@other/kit-note-ui"));
        // As Node's crypto and npm write it.
        assert_eq!(integrity_of(&Sha512::digest(b"kition")), "sha512-NH9AZJ/IRc/KrFvhVQk6Ekg1t67rcnKAvcDdYHrHt0B6uYe/ar1bRpjOM3pG7/cDKIbJnoP6OiP77h92OaGx7g==");
        assert!(integrity_form(&integrity_of(&Sha512::digest(b"x"))) && !integrity_form("sha256-abc") && !integrity_form("sha512-short"));
    }
}
