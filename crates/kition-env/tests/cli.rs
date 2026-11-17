//! The `kit-env` command line: `generate`, `stats`, `trace` and `score` over a workspace of
//! deck files, the kit found from a kits folder (its `kit.json` and its executable beside it).
//!
//! Cases: `sdk.agent.kit-env/cli`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use std::path::Path;
use std::process::{Command, Output};

use common::Fixture;
use serde_json::{Value, json};

/// A kits folder holding the deck kit `name`: its manifest and the launcher beside it.
fn kits_dir(f: &Fixture) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kit = dir.path().join(&f.name);
    std::fs::create_dir_all(&kit).unwrap_or_else(|err| panic!("{err}"));
    let name = &f.name;
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document", "objectModel": true },
        "headless": { "executable": format!("kition-{name}-mock"), "protocol": "kition-kit/2" }
    });
    std::fs::write(kit.join("kit.json"), manifest.to_string()).unwrap_or_else(|err| panic!("{err}"));
    let mock = common::mock_binary().unwrap_or_else(|| panic!("the mock is built"));
    common::launcher(&kit, &mock, name);
    dir
}

fn kit_env(args: &[&str], stdin: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kit-env"));
    command.args(args);
    if let Some(path) = stdin {
        command.stdin(std::fs::File::open(path).unwrap_or_else(|err| panic!("{err}")));
    }
    command.output().unwrap_or_else(|err| panic!("{err}"))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn generate_stats_trace_and_score_from_the_command_line() {
    let Some(f) = Fixture::deck("envcli") else { return };
    let kits = kits_dir(&f);
    let workspace = f.workspace.path().to_string_lossy().into_owned();
    let kits_arg = kits.path().to_string_lossy().into_owned();
    let common_args = ["--kits-dir", kits_arg.as_str()];

    let generated = kit_env(
        &[&["generate", "--workspace", &workspace, "--kit", "envcli", "--seed", "4", "--count", "6", "--inverse-share", "0.5"][..], &common_args].concat(),
        None,
    );
    assert!(generated.status.success(), "{}", text(&generated.stderr));
    let lines: Vec<String> = text(&generated.stdout).lines().map(str::to_owned).collect();
    assert_eq!(lines.len(), 6, "{}", text(&generated.stdout));
    let again = kit_env(
        &[&["generate", "--workspace", &workspace, "--kit", "kit.envcli", "--seed", "4", "--count", "6", "--inverse-share", "0.5"][..], &common_args].concat(),
        None,
    );
    assert_eq!(text(&again.stdout), text(&generated.stdout), "the kit by id or by extension, the same tasks");
    let out = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let tasks_file = out.path().join("tasks.jsonl");
    std::fs::write(&tasks_file, text(&generated.stdout)).unwrap_or_else(|err| panic!("{err}"));
    let tasks_arg = tasks_file.to_string_lossy().into_owned();

    let stats = kit_env(&["stats", "--tasks", &tasks_arg], None);
    assert!(stats.status.success(), "{}", text(&stats.stderr));
    let stats: Value = serde_json::from_slice(&stats.stdout).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(stats["tasks"], 6, "{stats}");
    assert_eq!(stats["kinds"].as_object().map(|kinds| kinds.values().filter_map(Value::as_u64).sum::<u64>()), Some(6), "{stats}");

    let traced = kit_env(&[&["trace", "--tasks", &tasks_arg, "--workspace", &workspace][..], &common_args].concat(), None);
    assert!(traced.status.success(), "{}", text(&traced.stderr));
    let traces: Vec<Value> = text(&traced.stdout).lines().map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{error}"))).collect();
    assert_eq!(traces.len(), 6);
    assert!(traces.iter().all(|trace| trace["reward"]["reward"] == 1.0));

    // Score one forward task: the file unchanged scores 0, from a task given on stdin too.
    let forward = lines.iter().find(|line| line.contains("\"inverse\":false")).unwrap_or_else(|| panic!("a forward task"));
    let task_file = out.path().join("task.json");
    std::fs::write(&task_file, forward).unwrap_or_else(|err| panic!("{err}"));
    let deck = f.workspace.path().join(f.file()).to_string_lossy().into_owned();
    let scored = kit_env(&[&["score", "--task", "-", "--before", &deck, "--after", &deck][..], &common_args].concat(), Some(&task_file));
    assert!(scored.status.success(), "{}", text(&scored.stderr));
    let reward: Value = serde_json::from_slice(&scored.stdout).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!((reward["reward"].clone(), reward["intended"].clone(), reward["preserved"].clone()), (json!(0.0), json!(0.0), json!(1.0)), "{reward}");
}

#[test]
fn usage_errors_exit_2_and_say_what_is_wrong() {
    let help = kit_env(&["--help"], None);
    assert!(help.status.success());
    assert!(text(&help.stdout).contains("kit-env generate"), "{}", text(&help.stdout));
    for (args, says) in [
        (vec!["frobnicate"], "unknown command frobnicate"),
        (vec!["generate", "--seed", "1"], "--workspace"),
        (vec!["generate", "--workspace", ".", "--kit", "nothing-here", "--count", "1"], "no kit"),
        (vec!["stats"], "--tasks"),
        (vec!["generate", "--workspace", ".", "--kit", "x", "--count", "many"], "--count"),
    ] {
        let output = kit_env(&args, None);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {}", text(&output.stderr));
        assert!(text(&output.stderr).starts_with("kit-env: "), "{}", text(&output.stderr));
        assert!(text(&output.stderr).contains(says), "{says} in {}", text(&output.stderr));
    }
}
