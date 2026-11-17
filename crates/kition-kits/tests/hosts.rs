//! The host examples in `examples/hosts/` (Python, Node, Go), each a host in its own language with
//! nothing but its standard library, run against `kition-kits serve`: each opens a workspace file
//! in its kit, edits it as the system, and saves it. A language whose runtime is not installed is
//! skipped with a note; the mock kit stands in for Kition Example, as in `serve.rs`.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

const SERVE: &str = env!("CARGO_BIN_EXE_kition-kits");

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

fn kits_dir(dir: &Path, mock: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let kit = dir.join("kits/example");
    std::fs::create_dir_all(&kit).unwrap();
    let manifest = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/example.json")).unwrap();
    std::fs::write(kit.join("kit.json"), &manifest).unwrap();
    // The mock reports the manifest's version, as the executable of the package it serves (H11).
    let version = serde_json::from_str::<serde_json::Value>(&manifest).unwrap()["version"].as_str().unwrap().to_owned();
    let executable = kit.join("kition-example");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example:example KITION_KIT_MOCK_VERSION={version} exec '{}' \"$@\"\n", mock.display()),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    dir.join("kits")
}

fn examples() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/hosts")
}

/// Whether `program` runs: `go version`, `node --version`, `python3 --version`.
fn installed(program: &str) -> bool {
    let probe = if program == "go" { "version" } else { "--version" };
    Command::new(program).arg(probe).output().is_ok_and(|output| output.status.success())
}

#[test]
fn every_language_example_edits_a_file_through_the_service() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let examples = examples();
    let runs: [(&str, &str, Vec<String>, PathBuf); 3] = [
        ("python", "python3", vec![examples.join("python/edit.py").display().to_string()], examples.clone()),
        ("node", "node", vec![examples.join("node/edit.mjs").display().to_string()], examples.clone()),
        ("go", "go", vec!["run".into(), ".".into()], examples.join("go")),
    ];
    let mut ran = 0;
    for (language, program, args, cwd) in runs {
        if !installed(program) {
            eprintln!("skipped {language}: no {program}");
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("work");
        std::fs::create_dir_all(workspace.join("art")).unwrap();
        std::fs::write(workspace.join("art/Note.example"), "hello").unwrap();
        let kits = kits_dir(dir.path(), &mock);
        let output = Command::new(program)
            .args(&args)
            .args([SERVE, &workspace.display().to_string(), &kits.display().to_string(), "art/Note.example", "text.append", r#"{"text":" from the host"}"#])
            .current_dir(&cwd)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{language}: {}\n{stdout}", String::from_utf8_lossy(&output.stderr));
        let answer: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|error| panic!("{language}: {error}: {stdout}"));
        assert_eq!(answer, json!({ "path": "art/Note.example", "dirty": false }), "{language}");
        assert_eq!(std::fs::read_to_string(workspace.join("art/Note.example")).unwrap(), "hello from the host", "{language}");
        ran += 1;
    }
    eprintln!("{ran} of 3 host examples ran");
}
