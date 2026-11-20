//! The kit commands as a person runs them: several kits installed and removed at once (`--all`,
//! one failure not stopping the others), no progress output when stderr is not a terminal,
//! `kit info`, and `kit pack` on one home then `kit add` on another, with no index, as well as
//! `kit add` of a kit folder and of a kit executable inside its repository.

mod support;

use std::path::Path;

use serde_json::Value;
use support::{IndexBuilder, Server, kit_archive, kit_folder, kition, manifest, run};

const P: &str = "kition-kit/1";

fn exe(name: &str) -> String {
    format!("kition-{name}{}", std::env::consts::EXE_SUFFIX)
}

/// An index file in `dir` with `fake` (0.1.0 and 0.2.0), `desk` and `newer` (a protocol this
/// kition does not speak).
fn index(dir: &Path) -> (String, Server) {
    let index = IndexBuilder::new()
        .kit(
            dir,
            "fake",
            "kfake",
            &[
                ("0.1.0", P, kit_archive("fake", "0.1.0", P, "kfake", "kition-fake", b"fake one")),
                ("0.2.0", P, kit_archive("fake", "0.2.0", P, "kfake", "kition-fake", b"fake two")),
            ],
        )
        .kit(dir, "desk", "kdesk", &[("1.0.0", P, kit_archive("desk", "1.0.0", P, "kdesk", "kition-desk", b"desk"))])
        .kit(dir, "newer", "knewer", &[("1.0.0", "kition-kit/99", kit_archive("newer", "1.0.0", "kition-kit/99", "knewer", "kition-newer", b"x"))])
        .write(dir)
        .display()
        .to_string();
    (index, Server::start(dir))
}

#[test]
fn installs_and_removes_several_kits_and_one_failure_does_not_stop_the_others() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let (index, registry) = index(dir.path());

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "fake", "missing", "desk", "--index", &index]));
    assert!(!ok, "one kit failed: the exit status says so");
    assert!(out.contains("installed fake 0.2.0") && out.contains("installed desk 1.0.0"), "{out}");
    assert!(err.contains("no kit named `missing`") && err.contains("1 of 3 kits failed: missing"), "{err}");
    assert!(!err.contains('%') && !err.contains('\r'), "no progress when stderr is not a terminal: {err:?}");
    assert!(home.join("kits/fake/0.2.0").is_dir() && home.join("kits/desk/1.0.0").is_dir());

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "remove", "fake", "kit.desk"]));
    assert!(ok && out.contains("removed fake 0.2.0") && out.contains("removed desk 1.0.0"), "{out}{err}");

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "--all", "--index", &index]));
    assert!(ok, "{out}{err}");
    assert!(out.contains("installed desk 1.0.0") && out.contains("installed fake 0.2.0"), "{out}");
    assert!(err.contains("skipped newer") && err.contains("kition-kit/99"), "{err}");
    assert!(!home.join("kits/newer").exists());

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "remove", "nothing", "fake"]));
    assert!(!ok && out.contains("removed fake") && err.contains("nothing is not installed"), "{out}{err}");

    let (ok, _, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "--all", "fake", "--index", &index]));
    assert!(!ok && err.contains("name no kit with it"), "{err}");
    let (ok, _, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "--index", &index]));
    assert!(!ok && err.contains("--all"), "{err}");
}

#[test]
fn info_states_versions_folder_protocol_and_agent_tools() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let (index, registry) = index(dir.path());
    let (ok, _, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "fake@0.1.0", "--index", &index]));
    assert!(ok, "{err}");

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "info", "kit.fake", "--json", "--index", &index]));
    assert!(ok, "{err}");
    let info: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(info["id"], "kit.fake");
    assert_eq!(info["displayName"], "Fake");
    assert_eq!(info["extensions"], serde_json::json!(["kfake"]));
    assert_eq!(info["installed"], serde_json::json!(["0.1.0"]));
    assert_eq!(info["inUse"], "0.1.0");
    assert_eq!(info["pinned"], "0.1.0");
    assert_eq!(info["latest"], "0.2.0");
    assert_eq!(info["available"].as_array().unwrap().len(), 2);
    assert_eq!(info["protocol"], P);
    assert!(info["executable"].as_str().unwrap().ends_with(&exe("fake")), "{info}");
    assert!(Path::new(info["folder"].as_str().unwrap()).ends_with("kits/fake/0.1.0"), "{info}");
    assert_eq!(info["agent"]["prefix"], "fake");
    let tools: Vec<&str> = info["agent"]["tools"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(tools.contains(&"fake_inspect") && tools.contains(&"fake_run") && !tools.contains(&"fake_export"), "{tools:?}");

    let (ok, out, _) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "info", "fake", "--index", &index]));
    assert!(ok && out.contains("fake (kit.fake): Fake") && out.contains("0.1.0 (in use, pinned)") && out.contains("fake_inspect"), "{out}");
    let (ok, out, _) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "info", "desk", "--index", &index]));
    assert!(ok && out.contains("installed:   -") && out.contains("kition kit install desk"), "{out}");
    let (ok, _, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "info", "nothing", "--index", &index]));
    assert!(!ok && err.contains("no kit named `nothing`") && err.contains("desk, fake, newer"), "{err}");
}

#[test]
fn pack_on_one_home_and_add_on_another_moves_a_kit_without_a_network() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    let offline = dir.path().join("no-index.json").display().to_string();
    let (index, registry) = index(dir.path());
    let (ok, _, err) = run(kition(&first).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok, "{err}");

    let out_dir = dir.path().join("moved");
    let (ok, out, err) = run(kition(&first).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "pack", "fake", "--out"]).arg(&out_dir));
    assert!(ok, "{err}");
    let archive = out_dir.join(format!("kition-fake-0.2.0-{}.tar.gz", kition_cli::home::platform()));
    assert!(archive.is_file() && out.contains("wrote") && out.contains("kition kit add"), "{out}");
    let names: Vec<String> = std::fs::read_dir(&out_dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names.len(), 1, "no scratch file is left: {names:?}");

    let (ok, out, err) = run(kition(&second).env("KITION_NPM_REGISTRY", registry.url("")).env("KITION_INDEX", &offline).args(["kit", "add"]).arg(&archive));
    assert!(ok && out.contains("added fake 0.2.0"), "{out}{err}");
    assert_eq!(std::fs::read(second.join("kits/fake/0.2.0").join(exe("fake"))).unwrap(), b"fake two");
    let (ok, out, _) = run(kition(&second).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "add"]).arg(&archive));
    assert!(ok && out.contains("fake 0.2.0 is installed already"), "{out}");
    let (ok, out, _) = run(kition(&second).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "list", "--json", "--index", &offline]));
    assert!(ok && serde_json::from_str::<Value>(&out).unwrap()["kits"][0]["inUse"] == "0.2.0", "{out}");
    let tmp: Vec<_> = std::fs::read_dir(second.join("tmp")).unwrap().collect();
    assert!(tmp.is_empty(), "nothing is left in tmp/");
}

/// A kit version installed here that is newer than every version the index lists (the index went
/// back to an older number, or the kit came by `kit add`): no command downloads the older one in
/// its place, says it upgraded to it, or downgrades without being asked by number.
#[test]
fn an_installed_version_newer_than_the_index_stays_in_use() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    // `index` lists fake 0.1.0 and 0.2.0; the store holds 0.3.0, added from a folder.
    let (index, registry) = index(dir.path());
    let folder = kit_folder(dir.path(), "fake-build", &manifest("fake", "0.3.0", P, "kfake", "kition-fake"), b"fake three");
    let (ok, _, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "add"]).arg(&folder));
    assert!(ok, "{err}");

    for args in [&["kit", "upgrade", "--index", &index][..], &["kit", "upgrade", "fake", "--index", &index][..]] {
        let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(args));
        assert!(ok, "{out}{err}");
        assert!(out.contains("fake 0.3.0 is newer than the kit index's newest, 0.2.0: left as it is"), "{out}");
        assert!(!out.contains("upgraded") && !out.contains("removed"), "{out}");
        assert!(!home.join("kits/fake/0.2.0").exists(), "nothing older is downloaded");
    }

    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "fake", "--index", &index]));
    assert!(ok, "{out}{err}");
    assert!(out.contains("fake 0.3.0 is installed, newer than the kit index's newest, 0.2.0") && out.contains("kition kit install fake@0.2.0"), "{out}");
    assert!(!home.join("kits/fake/0.2.0").exists());

    let (ok, out, _) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "list", "--json", "--index", &index]));
    let fake = serde_json::from_str::<Value>(&out).unwrap()["kits"].as_array().unwrap().iter().find(|kit| kit["name"] == "fake").cloned().unwrap();
    assert!(ok && fake["inUse"] == "0.3.0" && fake["latest"] == "0.2.0" && fake["upgrade"] == false, "{fake}");
    let (ok, out, _) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "list", "--index", &index]));
    let row = out.lines().find(|line| line.starts_with("fake ")).unwrap_or_default();
    assert!(ok && row.contains("0.3.0 (newer than the index)") && row.contains("0.2.0"), "{out}");

    // Asked for by number, the older version is installed and used.
    let (ok, out, err) = run(kition(&home).env("KITION_NPM_REGISTRY", registry.url("")).args(["kit", "install", "fake@0.2.0", "--index", &index]));
    assert!(ok && out.contains("fake 0.2.0 is in use (pinned)"), "{out}{err}");
}

#[test]
fn add_takes_a_kit_folder_or_a_kit_executable_and_refuses_what_an_install_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");

    let folder = kit_folder(dir.path(), "desk-build", &manifest("desk", "1.2.0", P, "kdesk", "kition-desk"), b"desk");
    let (ok, out, err) = run(kition(&home).args(["kit", "add"]).arg(&folder));
    assert!(ok && out.contains("added desk 1.2.0") && out.contains("desk 1.2.0 is in use"), "{out}{err}");

    // A kit repository: kit.json at its top, the executable built below it.
    let repo = dir.path().join("kition-board");
    std::fs::create_dir_all(repo.join("target/release")).unwrap();
    std::fs::write(repo.join("kit.json"), manifest("board", "0.4.0", P, "kboard", "kition-board").to_string()).unwrap();
    let built = repo.join("target/release").join(exe("board"));
    std::fs::write(&built, b"board").unwrap();
    let (ok, out, err) = run(kition(&home).args(["kit", "add"]).arg(&built));
    assert!(ok && out.contains("added board 0.4.0"), "{out}{err}");
    assert_eq!(std::fs::read(home.join("kits/board/0.4.0").join(exe("board"))).unwrap(), b"board");

    let newer = kit_folder(dir.path(), "newer-build", &manifest("newer", "1.0.0", "kition-kit/99", "knewer", "kition-newer"), b"x");
    let (ok, _, err) = run(kition(&home).args(["kit", "add"]).arg(&newer));
    assert!(!ok && err.contains("newer 1.0.0 cannot be installed: it speaks kition-kit/99") && err.contains("upgrade kition"), "{err}");
    assert!(!home.join("kits/newer").exists());

    let empty = dir.path().join("no-executable");
    std::fs::create_dir_all(&empty).unwrap();
    std::fs::write(empty.join("kit.json"), manifest("lone", "1.0.0", P, "klone", "kition-lone").to_string()).unwrap();
    let (ok, _, err) = run(kition(&home).args(["kit", "add"]).arg(&empty));
    assert!(!ok && err.contains(&format!("no {} beside its kit.json", exe("lone"))), "{err}");

    let stray = dir.path().join("stray");
    std::fs::write(&stray, b"not a kit").unwrap();
    let (ok, _, err) = run(kition(&home).args(["kit", "add"]).arg(&stray));
    assert!(!ok && err.contains("no kit.json above it names it"), "{err}");
    assert!(!home.join("kits/lone").exists() && std::fs::read_dir(home.join("tmp")).unwrap().next().is_none());
}
