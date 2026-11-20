//! Editor packages (sdk.gateway.editor-packages): `kition kit install` and `upgrade` install a
//! kit's editor package beside it (`kits/<kit>/ui/<version>/`), checked against the size and
//! SHA-256 the index gives and refused on any difference or when it is not that kit's editor;
//! `kit list`, `kit info` and `doctor` say whether it is installed; and `kition gateway` serves it
//! at `/kits-ui/<kit>@<version>/` (types, immutable caching with an `ETag`, single ranges, no path
//! out of the package, the token or a signed URL), serves a development build named with
//! `--kit-ui` without long caching, lists the editors at `/api/v1/kits/editors`, and installs one
//! a page asks for (`POST /api/v1/kits/editors/install`), following its download.
#![cfg(unix)]

mod support;

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Entry, IndexBuilder, archive, editor_archive, kit_archive, kition, run, sha256};

const P: &str = "kition-kit/1";

/// An index made in a folder.
type IndexOf = dyn Fn(&Path) -> IndexBuilder;

/// An index in `dir` with `fake` 0.1.0 and 0.2.0, each with its editor package, and `bare` 1.0.0
/// without one.
fn index(dir: &Path) -> String {
    IndexBuilder::new()
        .kit(
            dir,
            "fake",
            "kfake",
            &[
                ("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"one")),
                ("0.2.0", P, kit_archive("fake", "0.2.0", P, "kfake", "kition-fake", b"two")),
            ],
        )
        .editor(dir, "fake", "0.1.0", &editor_archive("fake", "0.1.0"), None)
        .editor(dir, "fake", "0.2.0", &editor_archive("fake", "0.2.0"), None)
        .kit(dir, "bare", "kbare", &[("1.0.0", P, kit_archive("bare", "1.0.0", P, "kbare", "kition-bare", b"bare"))])
        .write(dir)
        .display()
        .to_string()
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("{err}: {text}"))
}

#[test]
fn install_and_upgrade_bring_the_editor_and_list_info_and_doctor_name_it() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let index = index(dir.path());

    let (ok, out, err) = run(kition(&home).args(["kit", "install", "fake@0.1.0", "bare", "--index", &index]));
    assert!(ok, "{out}{err}");
    assert!(out.contains("installed the editor of fake 0.1.0"), "{out}");
    assert!(out.contains("the kit index lists no editor package for bare 1.0.0"), "{out}");
    let editor = home.join("kits/fake/ui/0.1.0");
    for file in ["index.html", "kit.json", "assets/main.js", "engine/kit_bg.wasm", "fonts/inter/Inter.ttf"] {
        assert!(editor.join(file).is_file(), "{file}");
    }
    assert!(!home.join("kits/fake/ui/0.1.0/fake-ui").exists(), "the package's top folder is the version's folder");
    assert!(home.join("kits/fake/0.1.0/kit.json").is_file(), "the headless kit beside it");
    assert_eq!(std::fs::read_dir(home.join("tmp")).map(Iterator::count).unwrap_or(0), 0, "nothing left in tmp/");

    let (ok, out, _) = run(kition(&home).args(["kit", "list", "--json", "--index", &index]));
    assert!(ok);
    let listed = json_of(&out);
    let row = |name: &str| listed["kits"].as_array().unwrap().iter().find(|row| row["name"] == name).unwrap().clone();
    assert_eq!(row("fake")["editor"], json!({ "installed": ["0.1.0"], "inUse": true, "available": true }));
    assert_eq!(row("bare")["editor"], json!({ "installed": [], "inUse": false, "available": false }));
    let (_, out, _) = run(kition(&home).args(["kit", "list", "--index", &index]));
    let line = |name: &str| out.lines().find(|line| line.starts_with(name)).unwrap_or_default().to_owned();
    assert!(out.lines().next().unwrap_or_default().contains("EDITOR"), "{out}");
    assert!(line("fake").contains("installed") && line("bare").contains("none"), "{out}");

    let (_, out, _) = run(kition(&home).args(["kit", "info", "fake", "--index", &index]));
    assert!(out.contains("editor:      installed"), "{out}");

    let (_, out, _) = run(kition(&home).args(["doctor", "--json", "--index", &index]));
    let doctor = json_of(&out);
    let check = |name: &str| doctor["checks"].as_array().unwrap().iter().find(|check| check["name"] == name).cloned().unwrap_or(Value::Null);
    assert_eq!(check("editor fake")["status"], "ok", "{doctor}");
    assert_eq!(check("editor bare")["status"], "info", "{doctor}");
    assert_eq!(check("editor bare")["fix"], "kition kit install bare");

    // A removed editor is installed again with the kit (first use repairs it), then upgraded.
    std::fs::remove_dir_all(&editor).unwrap();
    let (_, out, _) = run(kition(&home).args(["kit", "list", "--index", &index]));
    assert!(out.lines().find(|line| line.starts_with("fake")).unwrap_or_default().contains("missing"), "{out}");
    let (ok, out, err) = run(kition(&home).args(["kit", "install", "fake@0.1.0", "--index", &index]));
    assert!(ok && out.contains("installed the editor of fake 0.1.0"), "{out}{err}");
    let (ok, out, err) = run(kition(&home).args(["kit", "upgrade", "fake", "--index", &index]));
    assert!(ok, "{out}{err}");
    assert!(out.contains("installed the editor of fake 0.2.0"), "{out}");
    assert!(home.join("kits/fake/ui/0.2.0/index.html").is_file());
    assert!(!home.join("kits/fake/ui/0.1.0").exists(), "the older editor goes with the older kit");

    let (ok, _, _) = run(kition(&home).args(["kit", "remove", "fake"]));
    assert!(ok && !home.join("kits/fake").exists(), "removing a kit removes its editors");
}

#[test]
fn an_editor_package_that_is_not_the_one_the_index_gives_is_refused() {
    let cases: [(&str, Box<IndexOf>, &str); 5] = [
        (
            "another SHA-256",
            Box::new(|dir| {
                IndexBuilder::new().kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))]).editor(
                    dir,
                    "fake",
                    "0.1.0",
                    &editor_archive("fake", "0.1.0"),
                    Some(&"a".repeat(64)),
                )
            }),
            "SHA-256",
        ),
        (
            "another kit's editor",
            Box::new(|dir| {
                IndexBuilder::new().kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))]).editor(
                    dir,
                    "fake",
                    "0.1.0",
                    &editor_archive("other", "0.1.0"),
                    None,
                )
            }),
            "it is not the editor of fake 0.1.0",
        ),
        (
            "another version's editor",
            Box::new(|dir| {
                IndexBuilder::new().kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))]).editor(
                    dir,
                    "fake",
                    "0.1.0",
                    &editor_archive("fake", "0.0.9"),
                    None,
                )
            }),
            "it is not the editor of fake 0.1.0",
        ),
        (
            "an entry outside its folder",
            Box::new(|dir| {
                IndexBuilder::new().kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))]).editor(
                    dir,
                    "fake",
                    "0.1.0",
                    &archive(&[Entry::File("fake-ui/index.html", b"x", 0o644), Entry::RawPath("../escaped.js", b"x")]),
                    None,
                )
            }),
            "outside",
        ),
        (
            "no editor in it",
            Box::new(|dir| {
                IndexBuilder::new().kit(dir, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))]).editor(
                    dir,
                    "fake",
                    "0.1.0",
                    &archive(&[Entry::File("readme.txt", b"x", 0o644)]),
                    None,
                )
            }),
            "it holds no editor",
        ),
    ];
    for (what, build, reason) in cases {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let index = build(dir.path()).write(dir.path()).display().to_string();
        let (ok, out, err) = run(kition(&home).args(["kit", "install", "fake", "--index", &index]));
        assert!(!ok, "{what}: refused: {out}");
        assert!(err.contains(reason) && err.contains("the editor of fake 0.1.0"), "{what}: {err}");
        assert!(!home.join("kits/fake/ui/0.1.0").exists(), "{what}: nothing installed");
        assert!(!dir.path().join("escaped.js").exists() && !home.join("kits/fake/escaped.js").exists() && !home.join("escaped.js").exists(), "{what}");
    }
    // A package of another size than the index gives stops the download.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let bytes = editor_archive("fake", "0.1.0");
    let index_file = IndexBuilder::new()
        .kit(dir.path(), "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x"))])
        .editor(dir.path(), "fake", "0.1.0", &bytes, None)
        .write(dir.path());
    let mut value: Value = json_of(&std::fs::read_to_string(&index_file).unwrap());
    value["kits"]["fake"]["versions"]["0.1.0"]["ui"]["size"] = json!(bytes.len() - 1);
    std::fs::write(&index_file, value.to_string()).unwrap();
    let (ok, _, err) = run(kition(&home).args(["kit", "install", "fake", "--index", &index_file.display().to_string()]));
    assert!(!ok && err.contains("larger than"), "{err}");
    assert!(!home.join("kits/fake/ui/0.1.0").exists());
}

/// A running `kition gateway` on `workspace` with `home`: the process, its address and token.
struct Gateway {
    child: Child,
    url: String,
    token: String,
    stderr: std::sync::Arc<std::sync::Mutex<String>>,
}

impl Gateway {
    fn start(home: &Path, workspace: &Path, extra: &[&str]) -> Self {
        let mut child = kition(home)
            .args(["gateway", "--workspace"])
            .arg(workspace)
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let ready = json_of(&line);
        let stderr = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let mut lines = BufReader::new(child.stderr.take().unwrap());
        let kept = std::sync::Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut line = String::new();
            while lines.read_line(&mut line).unwrap_or(0) > 0 {
                kept.lock().unwrap().push_str(&line);
                line.clear();
            }
        });
        let lock = json_of(&std::fs::read_to_string(ready["lockfile"].as_str().unwrap()).unwrap());
        Self { child, url: ready["url"].as_str().unwrap().to_owned(), token: lock["token"].as_str().unwrap().to_owned(), stderr }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

fn http(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&Value>) -> Answer {
    let agent = ureq::Agent::config_builder().proxy(None).http_status_as_error(false).build().new_agent();
    let mut response = if method == "POST" {
        let mut request = agent.post(url).header("Content-Type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.send(body.map(Value::to_string).unwrap_or_default().as_bytes())
    } else {
        let mut request = if method == "HEAD" { agent.head(url) } else { agent.get(url) };
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.call()
    }
    .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().iter().map(|(name, value)| (name.to_string(), value.to_str().unwrap_or_default().to_owned())).collect();
    let body = response.body_mut().read_to_vec().unwrap_or_default();
    Answer { status, headers, body }
}

/// A kit repository checkout of `fake` 0.3.0 with its editor built in `web/dist/`.
fn repository(dir: &Path) -> PathBuf {
    let repo = dir.join("kition-fake");
    std::fs::create_dir_all(repo.join("web/dist/assets")).unwrap();
    std::fs::write(repo.join("kit.json"), support::manifest("fake", "0.3.0", P, "kfake", "kition-fake").to_string()).unwrap();
    std::fs::write(repo.join("web/dist/index.html"), "<!doctype html><title>dev build</title>").unwrap();
    std::fs::write(repo.join("web/dist/assets/main.js"), "export {}\n").unwrap();
    repo
}

#[test]
fn the_gateway_serves_installed_editors_and_development_builds_and_installs_on_first_use() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, workspace) = (base.join("home"), base.join("workspace"));
    std::fs::create_dir_all(&workspace).unwrap();
    let index = index(&base);
    let (ok, _, err) = run(kition(&home).args(["kit", "install", "fake@0.1.0", "bare", "--index", &index]));
    assert!(ok, "{err}");
    std::fs::write(base.join("outside.js"), "secret").unwrap();
    std::os::unix::fs::symlink(base.join("outside.js"), home.join("kits/fake/ui/0.1.0/assets/link.js")).unwrap();
    let gateway = Gateway::start(&home, &workspace, &["--index", &index]);
    let token = gateway.token.as_str();
    let at = |path: &str| format!("{}{path}", gateway.url);

    // The package's files, by type, immutable, with an ETag.
    let page = http("GET", &at("/kits-ui/fake@0.1.0/"), &[("Kition-Token", token)], None);
    assert_eq!(page.status, 200);
    assert_eq!(page.header("content-type"), Some("text/html; charset=utf-8"));
    assert!(String::from_utf8_lossy(&page.body).contains("fake 0.1.0"));
    assert_eq!(page.header("cache-control"), Some("public, max-age=31536000, immutable"));
    assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(page.header("content-security-policy"), Some("frame-ancestors 'self'"));
    assert!(page.header("content-encoding").is_none(), "never compressed here");
    let etag = page.header("etag").unwrap().to_owned();
    assert_eq!(http("GET", &at("/kits-ui/fake@0.1.0/index.html"), &[("Kition-Token", token), ("If-None-Match", &etag)], None).status, 304);
    for (file, mime) in [
        ("engine/kit_bg.wasm", "application/wasm"),
        ("assets/main.js", "text/javascript; charset=utf-8"),
        ("assets/kitEngine.worker-x.js", "text/javascript; charset=utf-8"),
        ("fonts/inter/Inter.ttf", "font/ttf"),
        ("kit.json", "application/json"),
    ] {
        let answer = http("GET", &at(&format!("/kits-ui/fake@0.1.0/{file}")), &[("Kition-Token", token)], None);
        assert_eq!((answer.status, answer.header("content-type")), (200, Some(mime)), "{file}");
    }
    let range = http("GET", &at("/kits-ui/fake@0.1.0/fonts/inter/Inter.ttf"), &[("Kition-Token", token), ("Range", "bytes=5-9")], None);
    assert_eq!((range.status, range.body.as_slice(), range.header("content-range")), (206, &b"bytes"[..], Some("bytes 5-9/21")));

    // Nothing out of the package, nothing of a version not installed, nothing without the token.
    for path in [
        "/kits-ui/fake@0.1.0/../../0.1.0/kit.json",
        "/kits-ui/fake@0.1.0/%2e%2e/%2e%2e/0.1.0/kit.json",
        "/kits-ui/fake@0.1.0/assets/link.js",
        "/kits-ui/fake@0.1.0/.hidden",
        "/kits-ui/fake@0.2.0/index.html",
        "/kits-ui/fake@..%2f..%2fbare/index.html",
        "/kits-ui/missing@1.0.0/index.html",
    ] {
        let answer = http("GET", &at(path), &[("Kition-Token", token)], None);
        assert!(answer.status == 404 || answer.status == 400, "{path}: {}", answer.status);
        assert!(!String::from_utf8_lossy(&answer.body).contains("secret"), "{path}");
    }
    assert_eq!(http("GET", &at("/kits-ui/fake@0.1.0/index.html"), &[], None).status, 401);
    assert_eq!(http("GET", &at("/kits-ui/fake@0.1.0/index.html"), &[("Kition-Token", "wrong")], None).status, 401);
    // A signed folder: every file below it, as a frame loads it.
    let signed = http("POST", &at("/api/v1/gateway/sign"), &[("Kition-Token", token)], Some(&json!({ "path": "/kits-ui/fake@0.1.0/" }))).json();
    let signed = signed["data"]["path"].as_str().unwrap().to_owned();
    assert_eq!(http("GET", &at(&format!("{signed}engine/kit_bg.wasm")), &[], None).status, 200);
    assert_eq!(http("GET", &at(&signed.replace("fake@0.1.0", "bare@1.0.0")), &[], None).status, 401, "for its folder only");
    let refused = http("POST", &at("/api/v1/gateway/sign"), &[("Kition-Token", token)], Some(&json!({ "path": "/api/v1/kits" })));
    assert_eq!(refused.status, 400, "only editor packages and kit files are signed for pages");

    // The listing: installed, where from; bare has no editor package anywhere.
    let editors = http("GET", &at("/api/v1/kits/editors"), &[("Kition-Token", token)], None).json();
    assert_eq!(editors["data"]["editors"]["kit.fake"]["installed"], true, "{editors}");
    assert_eq!(editors["data"]["editors"]["kit.fake"]["version"], "0.1.0");
    assert_eq!(editors["data"]["editors"]["kit.fake"]["base"], "kits-ui/fake@0.1.0/");
    assert_eq!(editors["data"]["editors"]["kit.bare"]["available"], false);
    let refused = http("POST", &at("/api/v1/kits/editors/install"), &[("Kition-Token", token)], Some(&json!({ "kit": "bare" })));
    assert_eq!((refused.status, refused.json()["data"]["reason"].clone()), (409, json!("unavailable")));

    // First use: the editor removed, a page asks for it, the download is followed to the end.
    drop(gateway);
    std::fs::remove_dir_all(home.join("kits/fake/ui")).unwrap();
    let gateway = Gateway::start(&home, &workspace, &["--index", &index]);
    let (token, at) = (gateway.token.clone(), |path: &str| format!("{}{path}", gateway.url));
    let editors = http("GET", &at("/api/v1/kits/editors"), &[("Kition-Token", &token)], None).json();
    assert_eq!(
        (editors["data"]["editors"]["kit.fake"]["installed"].clone(), editors["data"]["editors"]["kit.fake"]["available"].clone()),
        (json!(false), json!(true))
    );
    let started = http("POST", &at("/api/v1/kits/editors/install"), &[("Kition-Token", &token)], Some(&json!({ "kit": "kit.fake" })));
    assert_eq!((started.status, started.json()["data"]["started"].clone()), (202, json!(true)), "{:?}", started.json());
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = http("GET", &at("/api/v1/kits/editors"), &[("Kition-Token", &token)], None).json();
        if listed["data"]["editors"]["kit.fake"]["installed"] == true {
            assert_eq!(listed["data"]["editors"]["kit.fake"]["base"], "kits-ui/fake@0.1.0/");
            break;
        }
        assert!(listed["data"]["editors"]["kit.fake"]["failed"].is_null(), "{listed}");
        assert!(Instant::now() < deadline, "the editor was not installed in time: {listed}");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(http("GET", &at("/kits-ui/fake@0.1.0/engine/kit_bg.wasm"), &[("Kition-Token", &token)], None).status, 200);
    assert_eq!(sha256(&std::fs::read(home.join("kits/fake/ui/0.1.0/assets/main.js")).unwrap()), sha256(b"export const kit = 1\n"));
    drop(gateway);

    // A development build: the repository's web/dist with its kit.json, served without long caching.
    let repo = repository(&base);
    let gateway = Gateway::start(&home, &workspace, &["--index", &index, "--kit-ui", &repo.display().to_string()]);
    let (token, at) = (gateway.token.clone(), |path: &str| format!("{}{path}", gateway.url));
    let editors = http("GET", &at("/api/v1/kits/editors"), &[("Kition-Token", &token)], None).json();
    assert_eq!(editors["data"]["editors"]["kit.fake"]["version"], "0.3.0", "{editors}");
    assert_eq!(editors["data"]["editors"]["kit.fake"]["local"], true);
    let page = http("GET", &at("/kits-ui/fake@0.3.0/"), &[("Kition-Token", &token)], None);
    assert_eq!((page.status, page.header("cache-control")), (200, Some("no-cache")));
    assert!(String::from_utf8_lossy(&page.body).contains("dev build"));
    let manifest = http("GET", &at("/kits-ui/fake@0.3.0/kit.json"), &[("Kition-Token", &token)], None).json();
    assert_eq!(manifest["version"], "0.3.0", "kit.json is the repository's");
    assert!(gateway.stderr.lock().unwrap().contains("the development build"), "{}", gateway.stderr.lock().unwrap());
}

#[test]
fn a_kit_ui_folder_must_be_an_editor() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("w");
    std::fs::create_dir_all(&workspace).unwrap();
    let (ok, _, err) = run(kition(&dir.path().join("home")).args(["gateway", "--workspace"]).arg(&workspace).args(["--kit-ui"]).arg(dir.path()));
    assert!(!ok && err.contains("neither an editor package"), "{err}");
}

#[test]
fn with_nothing_installed_the_gateway_lists_the_index_kits_and_installs_an_editor_alone() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let (home, workspace) = (base.join("home"), base.join("workspace"));
    std::fs::create_dir_all(&workspace).unwrap();
    let index = index(&base);
    let gateway = Gateway::start(&home, &workspace, &["--index", &index]);
    let (token, at) = (gateway.token.clone(), |path: &str| format!("{}{path}", gateway.url));
    let kits = http("GET", &at("/api/v1/kits"), &[("Kition-Token", &token)], None).json();
    let fake = kits["data"]["kits"].as_array().unwrap().iter().find(|kit| kit["id"] == "kit.fake").cloned().unwrap_or(Value::Null);
    assert_eq!((fake["installed"].clone(), fake["extensions"].clone()), (json!(false), json!(["kfake"])), "{kits}");
    let editors = http("GET", &at("/api/v1/kits/editors"), &[("Kition-Token", &token)], None).json();
    assert_eq!(editors["data"]["editors"]["kit.fake"]["version"], "0.2.0", "the newest the index offers: {editors}");
    assert_eq!(editors["data"]["editors"]["kit.fake"]["installed"], false);
    assert_eq!(http("POST", &at("/api/v1/kits/editors/install"), &[("Kition-Token", &token)], Some(&json!({ "kit": "fake" }))).status, 202);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !home.join("kits/fake/ui/0.2.0/index.html").is_file() {
        assert!(Instant::now() < deadline, "the editor was not installed in time");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!home.join("kits/fake/0.2.0").exists(), "the editor alone: the headless kit comes when the agent needs it");
}
