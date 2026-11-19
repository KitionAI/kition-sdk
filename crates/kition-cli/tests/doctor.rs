//! `kition doctor`: each check, and the command that fixes a failed one. A kit that answers
//! `kit.initialize` is the mock kit (`kition-kit-mock`, built with the workspace; when it is
//! missing locally that part says so and passes, CI requires it); a kit that does not start is a
//! shell script that exits at once.

mod support;

use std::path::Path;

use serde_json::Value;
use support::{kit_folder, kition, manifest, run, workspace_binary};

fn check<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["checks"].as_array().unwrap().iter().find(|check| check["name"] == name).unwrap_or_else(|| panic!("no check {name}: {report}"))
}

fn doctor(home: &Path, person: &Path, path: &str, index: &str) -> (bool, Value, String) {
    let (ok, out, err) = run(kition(home).args(["doctor", "--json"]).env("PATH", path).env("HOME", person).env("KITION_INDEX", index).current_dir(person));
    (ok, serde_json::from_str(&out).unwrap_or_else(|_| panic!("{out}{err}")), err)
}

#[test]
fn doctor_reports_each_check_and_how_to_fix_a_failed_one() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let person = dir.path().join("person");
    std::fs::create_dir_all(&person).unwrap();
    let missing = dir.path().join("no-index.json").display().to_string();
    let bare = std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap().to_string_lossy().into_owned();

    let (ok, report, _) = doctor(&home, &person, &bare, &missing);
    assert!(!ok, "{report}");
    assert_eq!(report["ok"], false);
    assert_eq!(report["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(report["protocol"], "kition-kit/2");
    assert_eq!(check(&report, "home")["status"], "ok", "a home not made yet can be: {report}");
    assert!(!home.exists(), "the doctor makes nothing");
    let path = check(&report, "PATH");
    assert_eq!(path["status"], "fail");
    assert!(path["fix"].as_str().unwrap().contains("PATH"), "{path}");
    let index = check(&report, "index");
    assert_eq!(index["status"], "fail");
    assert!(index["fix"].as_str().unwrap().contains("KITION_INDEX"), "{index}");
    assert_eq!(check(&report, "kits")["status"], "info");
    assert_eq!(check(&report, "agent claude")["status"], "info");
    assert_eq!(check(&report, "agent cursor")["status"], "info");

    // A readable index, this kition's folder on the PATH, and kits installed.
    let served = dir.path().join("served");
    std::fs::create_dir_all(&served).unwrap();
    let index = support::IndexBuilder::new().write(&served).display().to_string();
    let kition_dir = Path::new(env!("CARGO_BIN_EXE_kition")).parent().unwrap().to_path_buf();
    let path = std::env::join_paths([kition_dir.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap().to_string_lossy().into_owned();
    let mock = workspace_binary("kition-kit-mock");
    if let Some(mock) = &mock {
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../kition-kit-mock/kit.json")).unwrap()).unwrap();
        let folder = kit_folder(dir.path(), "mock-build", &manifest, &std::fs::read(mock).unwrap());
        let (ok, _, err) = run(kition(&home).args(["kit", "add"]).arg(&folder));
        assert!(ok, "{err}");
    } else {
        eprintln!("kition-kit-mock is not built: the kit that starts is skipped");
    }
    #[cfg(unix)]
    {
        let folder = kit_folder(dir.path(), "broken-build", &manifest("broken", "1.0.0", "kition-kit/2", "kbroken", "kition-broken"), b"#!/bin/sh\nexit 3\n");
        let (ok, _, err) = run(kition(&home).args(["kit", "add"]).arg(&folder));
        assert!(ok, "{err}");
        let (ok, report, _) = doctor(&home, &person, &path, &index);
        assert!(!ok, "{report}");
        let broken = check(&report, "kit broken");
        assert_eq!(broken["status"], "fail", "{broken}");
        assert!(broken["detail"].as_str().unwrap().contains("did not start"), "{broken}");
        assert!(broken["fix"].as_str().unwrap().contains("kition kit remove broken"), "{broken}");
        let (ok, _, err) = run(kition(&home).args(["kit", "remove", "broken"]));
        assert!(ok, "{err}");
    }

    let (ok, report, err) = doctor(&home, &person, &path, &index);
    assert!(ok, "{report}{err}");
    assert_eq!(check(&report, "PATH")["status"], "ok");
    assert_eq!(check(&report, "index")["status"], "ok");
    if mock.is_some() {
        let mock = check(&report, "kit mock");
        assert_eq!(mock["status"], "ok", "{mock}");
        assert!(mock["detail"].as_str().unwrap().contains("0.0.0 answers kit.initialize"), "{mock}");
    }

    // The index read before, unreachable now: a warning with its age, not a failure.
    std::fs::remove_file(served.join("kits-index.json")).unwrap();
    let (ok, report, _) = doctor(&home, &person, &path, &index);
    assert!(ok, "{report}");
    let stale = check(&report, "index");
    assert_eq!(stale["status"], "warn");
    assert!(stale["detail"].as_str().unwrap().contains("using the copy read"), "{stale}");

    let (ok, out, _) = run(kition(&home).arg("doctor").env("PATH", &bare).env("HOME", &person).env("KITION_INDEX", &missing));
    assert!(!ok && out.contains("fail") && out.contains("fix: ") && out.contains("checks failed"), "{out}");
}
