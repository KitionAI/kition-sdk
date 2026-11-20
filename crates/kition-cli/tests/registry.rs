//! Kits and the kit index from npm registries (`registry.rs`): the first registry that answers
//! serves, a dead one or one serving other bytes passes to the next, a download cut short is
//! taken up where it stopped, and the index comes from the npm package `@kition/kits-index`.
//! Every registry here is on loopback.

mod support;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use support::{Entry, IndexBuilder, Server, archive, integrity, kit_archive, kition, run};

const P: &str = "kition-kit/1";

fn index_with_fake(dir: &Path) -> String {
    IndexBuilder::new()
        .kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"the real one"))])
        .write(dir)
        .display()
        .to_string()
}

fn installed(home: &Path) -> Vec<u8> {
    std::fs::read(home.join("kits/fake/0.1.0").join(format!("kition-fake{}", std::env::consts::EXE_SUFFIX))).unwrap_or_default()
}

#[test]
fn a_dead_registry_or_one_serving_other_bytes_passes_to_the_next() {
    let dir = tempfile::tempdir().unwrap();
    let good = dir.path().join("good");
    std::fs::create_dir_all(&good).unwrap();
    let index = index_with_fake(&good);
    let good = Server::start(&good);
    // A mirror that serves other bytes, of the same size, under the same name and version.
    let bad_dir = dir.path().join("bad");
    let path = kition_cli::registry::tarball_path(&format!("@kition/kit-fake-{}", kition_cli::home::platform()), "0.1.0");
    let mut other = std::fs::read(dir.path().join("good").join(&path)).unwrap();
    let middle = other.len() / 2;
    other[middle] ^= 0xff;
    std::fs::create_dir_all(bad_dir.join(&path).parent().unwrap()).unwrap();
    std::fs::write(bad_dir.join(&path), other).unwrap();
    let bad = Server::start(&bad_dir);

    // Nothing listens on the first: the second serves.
    let home = dir.path().join("home-dead");
    let (ok, out, err) =
        run(kition(&home).env("KITION_NPM_REGISTRY", format!("http://127.0.0.1:9,{}", good.url(""))).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert_eq!(installed(&home), b"the real one");

    // The first serves other bytes: refused, whatever it is, and the next serves the right ones.
    let home = dir.path().join("home-substitute");
    let (ok, out, err) =
        run(kition(&home).env("KITION_NPM_REGISTRY", format!("{},{}", bad.url(""), good.url(""))).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert_eq!(installed(&home), b"the real one");
    assert!(bad.seen.lock().unwrap().iter().any(|path| path.contains("kit-fake-")), "the substitute was asked first");

    // Only wrong bytes anywhere: refused, naming every registry tried.
    let home = dir.path().join("home-refused");
    let (ok, _, err) =
        run(kition(&home).env("KITION_NPM_REGISTRY", format!("{},http://127.0.0.1:9", bad.url(""))).args(["kit", "install", "fake", "--index", &index]));
    assert!(!ok && err.contains("has the integrity") && err.contains(&bad.url("")) && err.contains("http://127.0.0.1:9/"), "{err}");
    assert!(!home.join("kits/fake").exists() && installed(&home).is_empty());
}

/// A registry serving one file that breaks its first answer off half-way; with `ranges` it takes
/// a `Range` request up where it stopped, without it every later answer is the whole file. It
/// records the `Range` headers it saw.
fn cutting_registry(path: String, bytes: Vec<u8>, ranges: bool, cuts: usize) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        let mut answered = 0;
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let mut range = None;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                    break;
                }
                if let Some(value) = header.to_ascii_lowercase().strip_prefix("range: bytes=") {
                    range = value.trim().trim_end_matches('-').parse::<usize>().ok();
                    log.lock().unwrap().push(header.trim().to_owned());
                }
            }
            let mut stream = stream;
            if !line.contains(&path) {
                let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            answered += 1;
            let (status, from) = match range {
                Some(from) if ranges => ("206 Partial Content", from),
                _ => ("200 OK", 0),
            };
            let body = &bytes[from..];
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            if answered <= cuts {
                let _ = stream.write_all(&body[..body.len() / 2]);
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            } else {
                let _ = stream.write_all(body);
            }
        }
    });
    (format!("http://127.0.0.1:{port}/"), seen)
}

#[test]
fn a_download_cut_short_is_taken_up_where_it_stopped_or_from_the_next_registry() {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let program = vec![7u8; 300_000];
    let bytes = kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", &program);
    let index = IndexBuilder::new().kit(&served, "fake", "kfake", &[("0.1.0", P, bytes.clone())]).write(&served).display().to_string();
    let path = format!("kit-fake-{}-0.1.0.tgz", kition_cli::home::platform());

    // Cut once, ranges taken: the rest is asked for from where it stopped.
    let (registry, seen) = cutting_registry(path.clone(), bytes.clone(), true, 1);
    let home = dir.path().join("home-range");
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", &registry).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert_eq!(installed(&home), program);
    let ranges = seen.lock().unwrap().clone();
    assert_eq!(ranges.len(), 1, "{ranges:?}");
    assert!(ranges[0].to_ascii_lowercase().starts_with("range: bytes=") && !ranges[0].ends_with("=0-"), "taken up past its start: {ranges:?}");

    // Cut once, no ranges: the whole file again.
    let (registry, _) = cutting_registry(path.clone(), bytes.clone(), false, 1);
    let home = dir.path().join("home-whole");
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", &registry).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert_eq!(installed(&home), program);

    // Cut every time: the next registry serves.
    let (cutting, _) = cutting_registry(path, bytes, true, usize::MAX);
    let good = Server::start(&served);
    let home = dir.path().join("home-next");
    let (ok, out, err) =
        run(kition(&home).env("KITION_NPM_REGISTRY", format!("{cutting},{}", good.url(""))).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert_eq!(installed(&home), program);
}

/// Publishes `index` as the npm package `@kition/kits-index` at `version` in `dir`, with its
/// `latest` metadata; `claimed`, when given, is the integrity the metadata gives instead.
fn publish_index(dir: &Path, index: &Value, version: &str, claimed: Option<String>) {
    let manifest = json!({ "name": "@kition/kits-index", "version": version });
    let bytes = archive(&[
        Entry::File("package/package.json", manifest.to_string().as_bytes(), 0o644),
        Entry::File("package/kits-index.json", index.to_string().as_bytes(), 0o644),
    ]);
    support::publish(dir, "@kition/kits-index", version, &bytes);
    let latest = json!({ "name": "@kition/kits-index", "version": version, "dist": { "integrity": claimed.unwrap_or_else(|| integrity(&bytes)) } });
    std::fs::create_dir_all(dir.join("@kition/kits-index")).unwrap();
    std::fs::write(dir.join("@kition/kits-index/latest"), latest.to_string()).unwrap();
}

#[test]
fn the_index_is_the_npm_package_kits_index_at_its_latest() {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let file = index_with_fake(&served);
    let index: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    publish_index(&served, &index, "0.1.7", None);
    let server = Server::start(&served);

    // No KITION_INDEX: the package, from the registries; its kits install from them too.
    let home = dir.path().join("home");
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", format!("http://127.0.0.1:9,{}", server.url(""))).args(["kit", "list", "--json"]));
    assert!(ok, "{err}");
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(listed["index"]["read"], true, "{listed}");
    assert_eq!(listed["index"]["location"], format!("npm:@kition/kits-index@0.1.7 from {}", server.url("")));
    assert_eq!(listed["kits"][0]["name"], "fake");
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", server.url("")).args(["kit", "install", "fake"]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    assert!(server.seen.lock().unwrap().iter().any(|path| path.contains("@kition/kits-index/latest")), "{:?}", server.seen.lock().unwrap());

    // A package whose bytes are not the ones the metadata gives is refused; the kept copy serves.
    let other = dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    publish_index(&other, &index, "0.1.8", Some(integrity(b"something else")));
    let tampered = Server::start(&other);
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", tampered.url("")).args(["kit", "list", "--json"]));
    assert!(ok, "{err}");
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(listed["index"]["stale"].as_str().map(|why| why.contains("has the integrity")), Some(true), "{listed}");
    let fresh = dir.path().join("fresh-home");
    let (ok, out, _) = run(kition(&fresh).env("KITION_NPM_REGISTRY", tampered.url("")).args(["kit", "list", "--json"]));
    let listed: Value = serde_json::from_str(&out).unwrap();
    assert!(ok && listed["index"]["read"] == false && listed["index"]["error"].as_str().unwrap_or_default().contains(&tampered.url("")), "{listed}");
}

#[test]
fn a_registry_or_mirror_named_by_npms_settings_is_tried_before_the_public_ones() {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let index = index_with_fake(&served);
    let server = Server::start(&served);
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("npmrc"), format!("# the person's npm settings\n@kition:registry={}\n", server.url(""))).unwrap();
    let (ok, out, err) = run(kition(&home).env("npm_config_userconfig", home.join("npmrc")).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok && out.contains("installed fake 0.1.0"), "{out}{err}");
    let (ok, out, _) = run(kition(&home).env("npm_config_userconfig", home.join("npmrc")).args(["doctor", "--json", "--index", &index]));
    let doctor: Value = serde_json::from_str(&out).unwrap();
    let line = doctor["checks"].as_array().unwrap().iter().find(|check| check["name"] == "registries").cloned().unwrap_or(Value::Null);
    assert!(ok || !out.is_empty(), "{out}");
    assert_eq!(line["detail"].as_str().map(|detail| detail.starts_with(&format!("kits and the index come from {}", server.url("")))), Some(true), "{line}");
}
