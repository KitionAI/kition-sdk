//! A deck kit for the tests: the mock kit in deck mode (`KITION_KIT_MOCK_PARTS=deck`: slides and
//! shapes in an object model whose tool ids survive saves and reloads), as `kit.<name>` editing
//! `.<name>` files. Each test names its own kit: the tools find kits by prefix in one registry per
//! process.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use kition_env::EnvKit;
use kition_kits::KitDefinition;
use serde_json::json;

/// Three slides: a shape whose text is unique, and two on slide 2 with the same text; slide 3 is
/// empty.
pub const DECK: &str = "1:1=Q3 revenue#red|2=Body#blue|3=Footer\n2:4=Agenda|5=Same|6=Same#green\n3:";

pub fn definition(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document", "objectModel": true },
        "headless": { "executable": format!("kition-{name}-mock"), "protocol": "kition-kit/1" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

pub fn mock_binary() -> Option<PathBuf> {
    workspace_binary("kition-kit-mock")
}

/// Find a built workspace binary from any Cargo test executable layout.
pub fn workspace_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok().and_then(|exe| {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        exe.parent()?.ancestors().map(|dir| dir.join(&name)).find(|path| path.is_file())
    });
    assert!(path.is_some() || std::env::var_os("CI").is_none(), "build {name} first (cargo build -p {name})");
    path
}

/// A launcher that starts the mock kit as a deck kit `kit.<name>` for `.<name>` files.
pub fn launcher(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    launcher_with(dir, mock, name, "KITION_KIT_MOCK_PARTS=deck")
}

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files, with `env` set.
pub fn launcher_with(dir: &Path, mock: &Path, name: &str, env: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} {env} exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

pub struct Fixture {
    pub kit: EnvKit,
    pub name: String,
    pub workspace: tempfile::TempDir,
    pub bin: tempfile::TempDir,
}

impl Fixture {
    /// The deck kit `name` on a workspace holding `files` (`(<path>, <deck text>)`).
    pub fn new(name: &str, files: &[(&str, &str)]) -> Option<Self> {
        Self::with_env(name, "KITION_KIT_MOCK_PARTS=deck", files)
    }

    /// The mock kit `name`, started with `env`, on a workspace holding `files`.
    pub fn with_env(name: &str, env: &str, files: &[(&str, &str)]) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        for (path, text) in files {
            let path = workspace.path().join(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
            }
            std::fs::write(path, text).unwrap_or_else(|err| panic!("{err}"));
        }
        let kit = EnvKit::new(definition(name), Some(launcher_with(bin.path(), &mock, name, env)));
        Some(Self { kit, name: name.to_owned(), workspace, bin })
    }

    /// The deck kit `name` on a workspace holding [`DECK`] as `deck.<name>`.
    pub fn deck(name: &str) -> Option<Self> {
        Self::new(name, &[(&format!("deck.{name}"), DECK)])
    }

    pub fn file(&self) -> String {
        format!("deck.{}", self.name)
    }

    pub fn tool(&self, action: &str) -> String {
        format!("{}_{action}", self.name)
    }

    pub fn read(&self, path: &str) -> Vec<u8> {
        std::fs::read(self.workspace.path().join(path)).unwrap_or_else(|err| panic!("{err}"))
    }
}
