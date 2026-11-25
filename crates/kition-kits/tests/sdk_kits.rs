//! The kits built on the Kition SDK, through the runtime's kit manager as the agent uses them:
//! open a real file, find commands, run one, save, and render a preview, each over the Kit
//! Protocol to the kit's own headless executable (`kition-<kit>`, from `kition-headless`).
//!
//! Each kit is tested when its executable is found: `KITION_KIT_<KIT>_BINARY`, or a debug build
//! in the sibling kit checkout (`../kition-<kit>/target/debug/kition-<kit>`). Otherwise it is skipped,
//! and so is a sibling build older than its fixture: the fixture changed with the kit Kition pins,
//! and a build from before may not read it.

use std::path::{Path, PathBuf};

use kition_kits::{Caller, KitDefinition, KitManager};
use serde_json::{Map, Value, json};

struct Case {
    kit: &'static str,
    fixture: &'static str,
    command: &'static str,
    params: fn() -> Value,
    /// A command that names a file, which the agent must not be able to run.
    file_command: (&'static str, fn() -> Value),
}

const CASES: &[Case] = &[Case {
    kit: "kit.note",
    fixture: "Notes.md",
    command: "text.insert",
    params: || json!({ "at": 0, "text": "# Agenda\n\n" }),
    file_command: ("file.save", || json!({ "path": "elsewhere.md" })),
}];

/// A kit's executable to test, or why there is none.
enum Executable {
    Found(PathBuf),
    Missing,
    /// A sibling debug build made before its fixture last changed.
    Stale(PathBuf),
}

/// `KITION_KIT_<NAME>_BINARY` for `kit.<name>`.
fn variable(id: &str) -> String {
    let (prefix, suffix) = kition_kits::definitions::EXECUTABLE_VARIABLE;
    format!("{prefix}{}{suffix}", id.trim_start_matches("kit.").to_ascii_uppercase())
}

fn binary(id: &str, fixture: &Path) -> Executable {
    if let Some(path) = std::env::var_os(variable(id)).filter(|value| !value.is_empty()) {
        return Executable::Found(PathBuf::from(path));
    }
    let name = id.trim_start_matches("kit.");
    let sibling =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(format!("kition-{name}/target/debug/kition-{name}{}", std::env::consts::EXE_SUFFIX));
    if !sibling.is_file() {
        Executable::Missing
    } else if older(&sibling, fixture) {
        Executable::Stale(sibling)
    } else {
        Executable::Found(sibling)
    }
}

/// The kit an executable was built from: the manifest beside it (`definitions::manifest_beside`).
fn definition(executable: &Path, id: &str) -> &'static KitDefinition {
    let Some(manifest) = kition_kits::definitions::manifest_beside(executable) else { panic!("{}: no kit.json above it names it", executable.display()) };
    let kit = KitDefinition::from_manifest_text(&manifest).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(kit.id, id, "{} is {id}'s executable", executable.display());
    kition_kits::definitions::register([&kit]);
    kit
}

/// Whether `executable` was built before `fixture` last changed in this checkout.
fn older(executable: &Path, fixture: &Path) -> bool {
    let modified = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified());
    matches!((modified(executable), modified(fixture)), (Ok(built), Ok(changed)) if built < changed)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[tokio::test]
async fn the_agent_edits_files_of_every_sdk_kit_through_its_headless_executable() {
    let mut tested = Vec::new();
    for case in CASES {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(case.fixture);
        let executable = match binary(case.kit, &fixture) {
            Executable::Found(executable) => executable,
            Executable::Missing => {
                eprintln!(
                    "skipped {}: build it (cargo build -p kition-{} in its repository) or set {}",
                    case.kit,
                    case.kit.trim_start_matches("kit."),
                    variable(case.kit)
                );
                continue;
            }
            Executable::Stale(executable) => {
                eprintln!(
                    "skipped {}: {} is older than its fixture; rebuild it (cargo build -p kition-{}) or set {}",
                    case.kit,
                    executable.display(),
                    case.kit.trim_start_matches("kit."),
                    variable(case.kit)
                );
                continue;
            }
        };
        let kit = definition(&executable, case.kit);
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(dir.path().join("work")).unwrap_or_else(|err| panic!("{err}"));
        let original = std::fs::read(&fixture).unwrap_or_else(|err| panic!("{}: {err}", fixture.display()));
        std::fs::write(dir.path().join("work").join(case.fixture), &original).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(executable))]);
        let path = format!("work/{}", case.fixture);

        let opened = kits.open(Caller::Agent, &path).await.unwrap_or_else(|err| panic!("{}: open: {err}", kit.id));
        assert_eq!(opened.kit_id, kit.id);
        assert!(!opened.dirty);

        let found = kits
            .commands(Caller::Agent, kit.id, Some(&opened.document_id), Some(case.command))
            .await
            .unwrap_or_else(|err| panic!("{}: commands: {err}", kit.id));
        assert!(found.iter().any(|command| command.id == case.command), "{}: {} is listed", kit.id, case.command);
        let (file_command, file_params) = case.file_command;
        let listed = kits.commands(Caller::Agent, kit.id, Some(&opened.document_id), None).await.unwrap_or_else(|err| panic!("{err}"));
        assert!(!listed.iter().any(|command| command.id == file_command), "{}: {file_command} names a file and is not offered", kit.id);
        assert!(
            kits.execute(Caller::Agent, kit.id, &opened.document_id, file_command, object(file_params())).await.is_err(),
            "{}: {file_command} is refused",
            kit.id
        );

        let executed = kits
            .execute(Caller::Agent, kit.id, &opened.document_id, case.command, object((case.params)()))
            .await
            .unwrap_or_else(|err| panic!("{}: execute: {err}", kit.id));
        assert!(executed.changed && executed.document.as_ref().unwrap().dirty, "{}: the edit changed the document", kit.id);

        let saved = kits.save(Caller::Agent, kit.id, &opened.document_id).await.unwrap_or_else(|err| panic!("{}: save: {err}", kit.id));
        assert!(!saved.dirty);
        let written = std::fs::read(dir.path().join(&path)).unwrap_or_else(|err| panic!("{err}"));
        assert_ne!(written, original, "{}: the file on disk changed", kit.id);
        assert!(!dir.path().join("work").join(format!("elsewhere.{}", kit.extensions[0])).exists());

        let png = kits.preview(kit.id, &saved.document_id, 256).await.unwrap_or_else(|err| panic!("{}: preview: {err}", kit.id));
        assert_eq!(&png[1..4], b"PNG", "{}", kit.id);
        kits.shutdown().await;
        tested.push(kit.id);
    }
    eprintln!("tested: {tested:?}");
}
