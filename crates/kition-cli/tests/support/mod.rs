//! A kit index and the npm packages it lists made on the spot, served as an npm registry lays
//! them out (`<package>/-/<name>-<version>.tgz`) by a small HTTP server on loopback: no test
//! reaches the network.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256, Sha512};

/// A built workspace binary, from the test executable's target folder.
pub fn workspace_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok().and_then(|exe| {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        exe.parent()?.ancestors().map(|dir| dir.join(&name)).find(|path| path.is_file())
    });
    assert!(path.is_some() || std::env::var_os("CI").is_none(), "build {name} first (cargo build -p {name})");
    path
}

/// A kit.json for `kit.<name>` at `version` speaking `protocol`, editing `.<extension>`.
pub fn manifest(name: &str, version: &str, protocol: &str, extension: &str, executable: &str) -> Value {
    json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": name[..1].to_uppercase() + &name[1..], "version": version, "license": "Apache-2.0",
        "formats": [{ "id": name, "extensions": [extension], "role": "edit" }],
        "agent": { "prefix": name },
        "headless": { "executable": executable, "protocol": protocol }
    })
}

/// One entry of a hand-made archive.
pub enum Entry<'a> {
    File(&'a str, &'a [u8], u32),
    Symlink(&'a str, &'a str),
    /// A file whose path is written raw into the header (`../x`), as an attacker would.
    RawPath(&'a str, &'a [u8]),
}

/// A `.tar.gz` of `entries`.
pub fn archive(entries: &[Entry]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    for entry in entries {
        match entry {
            Entry::File(path, data, mode) => {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(*mode);
                header.set_cksum();
                builder.append_data(&mut header, path, *data).unwrap();
            }
            Entry::Symlink(path, target) => {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.set_mode(0o777);
                builder.append_link(&mut header, path, target).unwrap();
            }
            Entry::RawPath(path, data) => {
                let mut header = tar::Header::new_old();
                header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_entry_type(tar::EntryType::Regular);
                header.set_cksum();
                builder.append(&header, *data).unwrap();
            }
        }
    }
    builder.into_inner().unwrap().finish().unwrap()
}

/// The package.json npm writes into a package's tarball (`package/package.json`).
pub fn package_json(package: &str, version: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({ "name": package, "version": version, "kition": { "role": if package.ends_with("-ui") { "ui" } else { "headless" } } }))
        .unwrap()
}

/// An editor package of `kit.<name>` `version` as a kit's Package workflow publishes it, the npm
/// package `@kition/kit-<name>-ui`: `package/package.json` and one folder `package/<name>-ui/` with
/// `index.html`, the kit's kit.json, a script, an engine and a font.
pub fn editor_archive(name: &str, version: &str) -> Vec<u8> {
    let manifest = serde_json::to_vec_pretty(&manifest(name, version, "kition-kit/1", &format!("k{name}"), &format!("kition-{name}"))).unwrap();
    let top = format!("package/{name}-ui");
    let index = format!("<!doctype html><title>{name} {version}</title><script type=\"module\" src=\"./assets/main.js\"></script>");
    archive(&[
        Entry::File("package/package.json", &package_json(&format!("@kition/kit-{name}-ui"), version), 0o644),
        Entry::File(&format!("{top}/index.html"), index.as_bytes(), 0o644),
        Entry::File(&format!("{top}/kit.json"), &manifest, 0o644),
        Entry::File(&format!("{top}/assets/main.js"), b"export const kit = 1\n", 0o644),
        Entry::File(&format!("{top}/assets/kitEngine.worker-x.js"), b"self.onmessage = () => {}\n", 0o644),
        Entry::File(&format!("{top}/engine/kit_bg.wasm"), b"\0asm\x01\0\0\0", 0o644),
        Entry::File(&format!("{top}/fonts/inter/Inter.ttf"), b"font bytes 0123456789", 0o644),
    ])
}

/// A package `package` holding the editor of `kit.<name>` at `inner` (its kit.json's version), as
/// `version` of the package: what a registry could serve under a name and version that are not its own.
pub fn editor_archive_as(package: &str, name: &str, version: &str, inner: &str) -> Vec<u8> {
    let manifest = serde_json::to_vec_pretty(&manifest(name, inner, "kition-kit/1", &format!("k{name}"), &format!("kition-{name}"))).unwrap();
    let top = format!("package/{name}-ui");
    archive(&[
        Entry::File("package/package.json", &package_json(package, version), 0o644),
        Entry::File(&format!("{top}/index.html"), b"<!doctype html>", 0o644),
        Entry::File(&format!("{top}/kit.json"), &manifest, 0o644),
    ])
}

/// A good kit package for this machine, `@kition/kit-<name>-<platform>`: `package/package.json`,
/// and the kit's kit.json and `executable` with `program` as its content.
pub fn kit_archive(name: &str, version: &str, protocol: &str, extension: &str, executable: &str, program: &[u8]) -> Vec<u8> {
    let manifest = serde_json::to_vec_pretty(&manifest(name, version, protocol, extension, executable)).unwrap();
    let file = format!("package/{executable}{}", std::env::consts::EXE_SUFFIX);
    let package = format!("@kition/kit-{name}-{}", kition_cli::home::platform());
    archive(&[
        Entry::File("package/package.json", &package_json(&package, version), 0o644),
        Entry::File("package/kit.json", &manifest, 0o644),
        Entry::File(&file, program, 0o755),
    ])
}

/// The archive `kition kit pack` writes and `kition kit add` takes: kit.json and `executable` at its top.
pub fn local_archive(name: &str, version: &str, protocol: &str, extension: &str, executable: &str, program: &[u8]) -> Vec<u8> {
    let manifest = serde_json::to_vec_pretty(&manifest(name, version, protocol, extension, executable)).unwrap();
    let file = format!("{executable}{}", std::env::consts::EXE_SUFFIX);
    archive(&[Entry::File("kit.json", &manifest, 0o644), Entry::File(&file, program, 0o755)])
}

pub fn sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// npm's integrity of `data`: `sha512-<base64>`.
pub fn integrity(data: &[u8]) -> String {
    kition_cli::registry::integrity_of(&Sha512::digest(data))
}

/// Writes `bytes` where a registry serving `dir` serves `package` at `version`.
pub fn publish(dir: &Path, package: &str, version: &str, bytes: &[u8]) {
    let path = dir.join(kition_cli::registry::tarball_path(package, version));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// A folder served over HTTP on loopback, which also answers as a proxy (a request for a full
/// address is served from the folder by its path), and counts the requests it saw.
pub struct Server {
    pub dir: PathBuf,
    pub port: u16,
    pub seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    pub fn start(dir: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (folder, log) = (dir.to_path_buf(), Arc::clone(&seen));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (folder, log) = (folder.clone(), Arc::clone(&log));
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                            break;
                        }
                    }
                    let mut stream = stream;
                    if line.starts_with("CONNECT ") {
                        // A proxy's tunnel: the request inside it follows on the same stream.
                        log.lock().unwrap().push(line.split_whitespace().nth(1).unwrap_or_default().to_owned());
                        let _ = write!(stream, "HTTP/1.1 200 Connection established\r\n\r\n");
                        line.clear();
                        if reader.read_line(&mut line).is_err() {
                            return;
                        }
                        loop {
                            let mut header = String::new();
                            if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                                break;
                            }
                        }
                    }
                    let target = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let target = target.replace("%2f", "/").replace("%2F", "/");
                    log.lock().unwrap().push(target.clone());
                    let path = match target.strip_prefix("http://") {
                        Some(rest) => rest.find('/').map_or("/".to_owned(), |at| rest[at..].to_owned()),
                        None => target,
                    };
                    let file = folder.join(path.trim_start_matches('/'));
                    match std::fs::File::open(&file) {
                        Ok(mut file) => {
                            let mut body = Vec::new();
                            file.read_to_end(&mut body).unwrap();
                            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                            let _ = stream.write_all(&body);
                        }
                        Err(_) => {
                            let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        }
                    }
                });
            }
        });
        Self { dir: dir.to_path_buf(), port, seen }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/{path}", self.port)
    }
}

/// Builds an index in `dir` (`kits-index.json`) whose packages are published in `dir`, laid out
/// as a registry serves them (a [`Server`] on `dir` is the registry): each kit by name, with its
/// id, display name, extensions, and versions `(version, protocol, package bytes)`.
pub struct IndexBuilder {
    kits: BTreeMap<String, Value>,
}

impl IndexBuilder {
    pub fn new() -> Self {
        Self { kits: BTreeMap::new() }
    }

    pub fn kit(mut self, dir: &Path, name: &str, extension: &str, versions: &[(&str, &str, Vec<u8>)]) -> Self {
        let platform = kition_cli::home::platform();
        let mut listed = serde_json::Map::new();
        for (version, protocol, bytes) in versions {
            let package = format!("@kition/kit-{name}-{platform}");
            publish(dir, &package, version, bytes);
            listed.insert(
                (*version).to_owned(),
                json!({ "protocol": protocol, "platforms": { platform.clone(): { "package": package, "size": bytes.len(), "integrity": integrity(bytes) } } }),
            );
        }
        let display = name[..1].to_uppercase() + &name[1..];
        self.kits.insert(name.to_owned(), json!({ "id": format!("kit.{name}"), "name": display, "extensions": [extension], "versions": listed }));
        self
    }

    /// Publishes `bytes` in `dir` as the editor package (`ui`) of `name` `version`, already added
    /// with [`IndexBuilder::kit`]; `integrity_claimed`, when given, is what the index claims instead.
    pub fn editor(mut self, dir: &Path, name: &str, version: &str, bytes: &[u8], integrity_claimed: Option<&str>) -> Self {
        let package = format!("@kition/kit-{name}-ui");
        publish(dir, &package, version, bytes);
        let entry = self.kits.get_mut(name).and_then(|kit| kit["versions"].get_mut(version)).unwrap_or_else(|| panic!("{name} {version} is not listed"));
        entry["ui"] = json!({ "package": package, "size": bytes.len(), "integrity": integrity_claimed.map_or_else(|| integrity(bytes), str::to_owned) });
        self
    }

    pub fn write(self, dir: &Path) -> PathBuf {
        let path = dir.join("kits-index.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&json!({ "schemaVersion": 2, "kits": self.kits })).unwrap()).unwrap();
        path
    }
}

/// The environment of a `kition` under test: no index or registry of the person's, none of their
/// npm settings, and the public registries (tried after any named) behind a proxy that answers
/// nothing, so no test reaches the network; loopback goes direct.
pub fn isolate(command: &mut std::process::Command, home: &Path) {
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy().into_owned();
        if key.starts_with("KITION_KIT_") || key.to_ascii_lowercase().ends_with("_proxy") || key.to_ascii_lowercase().starts_with("npm_config_") {
            command.env_remove(key);
        }
    }
    command
        .env_remove("KITION_INDEX")
        .env_remove("KITION_NPM_REGISTRY")
        .env("npm_config_userconfig", home.join("no-npmrc"))
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("NO_PROXY", "127.0.0.1,localhost");
}

/// `kition` with its home at `home`, isolated ([`isolate`]), without the launcher's variable.
pub fn kition(home: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_kition"));
    command.env("KITION_HOME", home).env_remove("KITION_LAUNCHER");
    isolate(&mut command, home);
    command
}

/// Runs `command`: whether it succeeded, its stdout and its stderr.
pub fn run(command: &mut std::process::Command) -> (bool, String, String) {
    let output = command.stdin(std::process::Stdio::null()).output().unwrap();
    (output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
}

/// A kit folder in `dir/<folder>`: its kit.json and its executable `program`.
pub fn kit_folder(dir: &Path, folder: &str, manifest: &Value, program: &[u8]) -> PathBuf {
    let path = dir.join(folder);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("kit.json"), serde_json::to_vec_pretty(manifest).unwrap()).unwrap();
    let executable = path.join(format!("{}{}", manifest["headless"]["executable"].as_str().unwrap(), std::env::consts::EXE_SUFFIX));
    std::fs::write(&executable, program).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}
