//! The kit store against a kit index served on loopback: installs check the size, the SHA-256
//! and the unpacked kit.json, refuse archives that write outside the kit's folder or hold links,
//! leave nothing behind when they fail, survive two processes installing at once, refuse kits of
//! another protocol, and see kits another program put in place.

mod support;

use std::path::Path;

use kition_cli::home::Home;
use kition_cli::index::{self, Freshness, Loaded, Source};
use kition_cli::store::{Outcome, Store};
use semver::Version;
use support::{Entry, IndexBuilder, Server, archive, kit_archive, manifest};

const P: &str = "kition-kit/1";

fn load(home: &Home, location: String) -> Loaded {
    index::load(home, &Source { location }, Freshness::Now).unwrap()
}

/// The names in `kits/<kit>/` and in `tmp/`, so a test sees exactly what an install left.
fn contents(path: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(path).into_iter().flatten().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn installs_upgrades_and_removes_over_http() {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    IndexBuilder::new().kit(&served, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"one"))]).write(&served);
    let server = Server::start(&served);
    let home = Home::at(dir.path().join("home"));
    let store = Store::new(home.clone());
    let loaded = load(&home, server.url("kits-index.json"));

    let (name, outcome) = store.install(&loaded, "fake", None).unwrap();
    assert_eq!((name.as_str(), outcome), ("fake", Outcome::Installed(Version::new(0, 1, 0))));
    let kit = store.kit("fake").unwrap();
    let in_use = kit.in_use().unwrap();
    assert_eq!(std::fs::read(&in_use.executable).unwrap(), b"one");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&in_use.executable).unwrap().permissions().mode() & 0o111, 0o111, "the executable runs");
    }
    assert_eq!(store.install(&loaded, "kit.fake", None).unwrap().1, Outcome::Present(Version::new(0, 1, 0)));

    IndexBuilder::new()
        .kit(
            &served,
            "fake",
            "kfake",
            &[
                ("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"one")),
                ("0.2.0", P, kit_archive("fake", "0.2.0", P, "kfake", "kition-fake", b"two")),
            ],
        )
        .write(&served);
    let loaded = load(&home, server.url("kits-index.json"));
    assert_eq!(store.install(&loaded, "fake", None).unwrap().1, Outcome::Installed(Version::new(0, 2, 0)));
    assert_eq!(store.kit("fake").unwrap().in_use().unwrap().version, Version::new(0, 2, 0), "the newest is in use");
    store.pin("fake", Some(&Version::new(0, 1, 0))).unwrap();
    assert_eq!(store.kit("fake").unwrap().in_use().unwrap().version, Version::new(0, 1, 0), "a pinned version is in use");
    store.pin("fake", None).unwrap();
    assert_eq!(store.prune("fake"), vec![Version::new(0, 1, 0)]);
    assert_eq!(contents(&home.kits().join("fake")), vec!["0.2.0"]);

    assert_eq!(store.remove("fake").unwrap(), vec![Version::new(0, 2, 0)]);
    assert!(store.kit("fake").is_none() && contents(&home.kits()).is_empty());
    assert!(contents(&home.tmp()).is_empty(), "nothing is left in tmp/: {:?}", contents(&home.tmp()));
    assert!(store.remove("fake").unwrap_err().contains("not installed"));
}

/// Each bad archive is refused, and leaves no version in `kits/` and nothing in `tmp/`.
#[test]
fn refuses_bad_archives_and_leaves_nothing_behind() {
    let good = || kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"x");
    let json = |name: &str, version: &str| serde_json::to_vec(&manifest(name, version, P, "kfake", "kition-fake")).unwrap();
    let exe = format!("kition-fake{}", std::env::consts::EXE_SUFFIX);
    // Each case: its name, the archive, the size and SHA-256 the index gives instead of the
    // archive's own, and what the refusal says.
    type Case<'a> = (&'a str, Vec<u8>, Option<(u64, String)>, &'a str);
    let cases: Vec<Case> = vec![
        ("hash", good(), Some((good().len() as u64, "0".repeat(64))), "SHA-256"),
        ("size", good(), Some((good().len() as u64 - 1, support::sha256(&good()))), "larger than"),
        ("escape", archive(&[Entry::File("kit.json", &json("fake", "0.1.0"), 0o644), Entry::RawPath("../escaped", b"x")]), None, "outside"),
        ("link", archive(&[Entry::File("kit.json", &json("fake", "0.1.0"), 0o644), Entry::Symlink(&exe, "/bin/sh")]), None, "not a file or folder"),
        ("id", archive(&[Entry::File("kit.json", &json("other", "0.1.0"), 0o644), Entry::File(&exe, b"x", 0o755)]), None, "kit.other"),
        ("version", archive(&[Entry::File("kit.json", &json("fake", "9.9.9"), 0o644), Entry::File(&exe, b"x", 0o755)]), None, "version 9.9.9"),
        ("executable", archive(&[Entry::File("kit.json", &json("fake", "0.1.0"), 0o644)]), None, "no kition-fake"),
        ("gzip", b"not an archive at all".to_vec(), None, "archive"),
    ];
    for (case, bytes, listed, expected) in cases {
        let dir = tempfile::tempdir().unwrap();
        let served = dir.path().join("served");
        std::fs::create_dir_all(&served).unwrap();
        let index = IndexBuilder::new().kit(&served, "fake", "kfake", &[("0.1.0", P, bytes)]).write(&served);
        if let Some((size, sha256)) = listed {
            let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&index).unwrap()).unwrap();
            let archive = &mut value["kits"]["fake"]["versions"]["0.1.0"]["platforms"][kition_cli::home::platform()];
            archive["size"] = size.into();
            archive["sha256"] = sha256.into();
            std::fs::write(&index, value.to_string()).unwrap();
        }
        let home = Home::at(dir.path().join("home"));
        let store = Store::new(home.clone());
        let error = store.install(&load(&home, index.display().to_string()), "fake", None).unwrap_err();
        assert!(error.contains(expected), "{case}: {error}");
        assert!(store.kit("fake").is_none(), "{case}");
        assert!(contents(&home.kits().join("fake")).is_empty(), "{case}: {:?}", contents(&home.kits().join("fake")));
        assert!(contents(&home.tmp()).is_empty(), "{case}: {:?}", contents(&home.tmp()));
        assert!(!dir.path().join("escaped").exists() && !home.root().join("escaped").exists(), "{case}");
    }
}

#[test]
fn refuses_kits_of_another_protocol_and_says_what_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let index = IndexBuilder::new()
        .kit(dir.path(), "newer", "knewer", &[("1.0.0", "kition-kit/99", kit_archive("newer", "1.0.0", "kition-kit/99", "knewer", "kition-newer", b"x"))])
        .kit(
            dir.path(),
            "mixed",
            "kmixed",
            &[
                ("1.0.0", P, kit_archive("mixed", "1.0.0", P, "kmixed", "kition-mixed", b"x")),
                ("2.0.0", "kition-kit/99", kit_archive("mixed", "2.0.0", "kition-kit/99", "kmixed", "kition-mixed", b"x")),
                ("0.1.0", "kition-kit/0", kit_archive("mixed", "0.1.0", "kition-kit/0", "kmixed", "kition-mixed", b"x")),
            ],
        )
        .write(dir.path());
    let home = Home::at(dir.path().join("home"));
    let store = Store::new(home.clone());
    let loaded = load(&home, index.display().to_string());
    let error = store.install(&loaded, "newer", None).unwrap_err();
    assert!(error.contains("kition-kit/99") && error.contains("upgrade kition"), "{error}");
    assert_eq!(store.install(&loaded, "mixed", None).unwrap().1, Outcome::Installed(Version::new(1, 0, 0)), "the newest it can run");
    let error = store.install(&loaded, "mixed", Some(&Version::new(2, 0, 0))).unwrap_err();
    assert!(error.contains("upgrade kition"), "{error}");
    let error = store.install(&loaded, "mixed", Some(&Version::new(0, 1, 0))).unwrap_err();
    assert!(error.contains("install a newer version of the kit"), "{error}");
    let error = store.install(&loaded, "missing", None).unwrap_err();
    assert!(error.contains("mixed, newer"), "{error}");
}

/// Several processes (here threads, each with its own store value) install the same version at
/// once: each succeeds, and one complete folder is installed.
#[test]
fn concurrent_installs_of_one_version_end_with_one_folder() {
    let dir = tempfile::tempdir().unwrap();
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let big: Vec<u8> = (0..4_000_000u32).map(|n| (n % 251) as u8).collect();
    IndexBuilder::new().kit(&served, "fake", "kfake", &[("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", &big))]).write(&served);
    let server = Server::start(&served);
    let home = Home::at(dir.path().join("home"));
    let loaded = load(&home, server.url("kits-index.json"));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let (home, loaded) = (home.clone(), loaded.clone());
            std::thread::spawn(move || Store::new(home).install(&loaded, "fake", None).map(|(_, outcome)| outcome))
        })
        .collect();
    for thread in threads {
        assert_eq!(thread.join().unwrap().unwrap().version(), &Version::new(0, 1, 0));
    }
    let store = Store::new(home.clone());
    assert_eq!(contents(&home.kits().join("fake")), vec!["0.1.0"]);
    assert_eq!(std::fs::read(&store.kit("fake").unwrap().in_use().unwrap().executable).unwrap(), big);
    assert!(contents(&home.tmp()).is_empty(), "{:?}", contents(&home.tmp()));
}

/// Another program (Kition's desktop app) adds a kit by renaming a complete folder into
/// `kits/<kit>/<version>/`; an incomplete one is not a kit.
#[test]
fn sees_a_kit_another_program_put_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let home = Home::at(dir.path().join("home"));
    let store = Store::new(home.clone());
    let staged = dir.path().join("staged");
    std::fs::create_dir_all(&staged).unwrap();
    std::fs::write(staged.join("kit.json"), manifest("desk", "1.2.0", P, "kdesk", "kition-desk").to_string()).unwrap();
    std::fs::create_dir_all(home.kits().join("desk")).unwrap();
    std::fs::create_dir_all(home.kits().join("desk").join("1.3.0")).unwrap();
    assert!(store.kit("desk").is_none(), "a folder without its kit.json and executable is no kit");
    std::fs::write(staged.join(format!("kition-desk{}", std::env::consts::EXE_SUFFIX)), b"x").unwrap();
    std::fs::rename(&staged, home.kits().join("desk").join("1.2.0")).unwrap();
    let listed = store.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].in_use().unwrap().version, Version::new(1, 2, 0));
}
