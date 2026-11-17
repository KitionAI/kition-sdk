//! The environment API: `reset(task)` gives a fresh workspace with the task's file and its
//! instruction, `step(tool, arguments)` passes a call through to the kit's tools on that
//! workspace, and `score()` answers what the standalone scorer answers. Inverse tasks start from
//! the edited file, and their ground truth restores the original.
//!
//! Cases: `sdk.agent.kit-env/environment`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::{Environment, GenerateOptions, ScoreOptions, Task};
use serde_json::json;

async fn tasks(f: &Fixture, seed: u64, count: usize, inverse_share: f64) -> Vec<Task> {
    let options = GenerateOptions { seed, count, inverse_share, ..GenerateOptions::default() };
    kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}")).tasks
}

fn read(env: &Environment) -> Vec<u8> {
    std::fs::read(env.file()).unwrap_or_else(|err| panic!("{err}"))
}

#[tokio::test]
async fn reset_gives_a_fresh_copy_each_time() {
    let Some(f) = Fixture::deck("envreset") else { return };
    let task = tasks(&f, 4, 1, 0.0).await.remove(0);
    let mut env = Environment::new(f.kit.clone(), f.workspace.path());
    let first = env.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(first.instruction, task.instruction);
    assert_eq!(first.path, task.file);
    assert!(first.tools.contains(&f.tool("batch")) && first.tools.contains(&f.tool("inspect")), "{:?}", first.tools);
    let first_dir = first.workspace.clone();
    let step =
        env.step(&f.tool("batch"), json!({ "path": first.path, "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "Changed" }] })).await;
    assert!(step.unwrap_or_else(|error| panic!("{error}")).result.get("error").is_none());
    assert_ne!(read(&env), common::DECK.as_bytes());
    let second = env.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    assert_ne!(second.workspace, first_dir, "a new workspace");
    assert!(!first_dir.exists(), "the last episode's workspace is gone");
    assert_eq!(read(&env), common::DECK.as_bytes(), "the task's file as it was");
    assert_eq!(f.read(&f.file()), common::DECK.as_bytes(), "the source workspace is never edited");
}

#[tokio::test]
async fn steps_on_one_episode_never_touch_anothers_files() {
    let Some(f) = Fixture::deck("envisol") else { return };
    let task = tasks(&f, 4, 1, 0.0).await.remove(0);
    let mut one = Environment::new(f.kit.clone(), f.workspace.path());
    let mut two = Environment::new(f.kit.clone(), f.workspace.path());
    let seen = one.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    two.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    one.step(&f.tool("batch"), json!({ "path": seen.path, "ops": [{ "op": "delete", "target": "shape:3" }] })).await.unwrap_or_else(|error| panic!("{error}"));
    assert_ne!(read(&one), common::DECK.as_bytes());
    assert_eq!(read(&two), common::DECK.as_bytes(), "the other episode's file is untouched");
    // A path outside the episode's workspace is refused, never resolved elsewhere.
    let outside = f.workspace.path().join(f.file());
    let refused = one.step(&f.tool("batch"), json!({ "path": outside.to_string_lossy(), "ops": [{ "op": "delete", "target": "shape:1" }] })).await;
    assert!(refused.unwrap_or_else(|error| panic!("{error}")).result.get("error").is_some());
    assert_eq!(f.read(&f.file()), common::DECK.as_bytes());
    let unknown = one.step("other_batch", json!({})).await;
    assert!(unknown.is_err(), "only the kit's own tools");
}

#[tokio::test]
async fn score_matches_the_standalone_scorer() {
    let Some(f) = Fixture::deck("envscore") else { return };
    let task = tasks(&f, 9, 1, 0.0).await.remove(0);
    let mut env = Environment::new(f.kit.clone(), f.workspace.path());
    let seen = env.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    let before = read(&env);
    env.step(&f.tool("batch"), json!({ "path": seen.path, "ops": [{ "op": "set", "target": "shape:4", "field": "text", "value": "Other" }] }))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let reward = env.score().await.unwrap_or_else(|error| panic!("{error}"));
    let standalone = kition_env::score_files(&f.kit, &task, &before, &read(&env), &ScoreOptions::default()).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reward, standalone);
}

#[tokio::test]
async fn a_step_says_done_once_the_budget_is_spent() {
    let Some(f) = Fixture::deck("envdone") else { return };
    let task = tasks(&f, 4, 1, 0.0).await.remove(0);
    let mut env = Environment::new(f.kit.clone(), f.workspace.path()).with_max_steps(2);
    let seen = env.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    let first = env.step(&f.tool("inspect"), json!({ "path": seen.path })).await.unwrap_or_else(|error| panic!("{error}"));
    assert!(!first.done);
    let second = env.step(&f.tool("check"), json!({ "path": seen.path })).await.unwrap_or_else(|error| panic!("{error}"));
    assert!(second.done);
    assert!(second.result["diagnostics"].is_array(), "{}", second.result);
}

/// An inverse task starts from the edited file; replaying its ground truth there restores the
/// original document's state.
#[tokio::test]
async fn inverse_ground_truth_restores_the_original_document() {
    let Some(f) = Fixture::deck("envinverse") else { return };
    let original = kition_env::read_snapshot(&f.kit, &f.file(), common::DECK.as_bytes()).await.unwrap_or_else(|error| panic!("{error}"));
    let tasks = tasks(&f, 6, 10, 1.0).await;
    assert!(tasks.iter().all(|task| task.inverse), "inverse share 1");
    assert!(tasks.iter().all(|task| task.kind != "delete"), "a deleted object cannot be restored with its id: never an inverse task");
    for task in &tasks {
        let mut env = Environment::new(f.kit.clone(), f.workspace.path());
        let seen = env.reset(task).await.unwrap_or_else(|error| panic!("{error}"));
        let edited = kition_env::read_snapshot(&f.kit, &f.file(), &read(&env)).await.unwrap_or_else(|error| panic!("{error}"));
        assert_ne!(edited.canonical(), original.canonical(), "an inverse task starts from the edited file: {}", task.to_line());
        let ops = kition_env::ops_for(&task.ground_truth, &edited).unwrap_or_else(|error| panic!("{error}"));
        let step = env.step(&f.tool("batch"), json!({ "path": seen.path, "ops": ops })).await.unwrap_or_else(|error| panic!("{error}"));
        assert!(step.result.get("error").is_none(), "{}", step.result);
        let restored = kition_env::read_snapshot(&f.kit, &f.file(), &read(&env)).await.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(restored.canonical(), original.canonical(), "{}", task.to_line());
        assert_eq!(env.score().await.unwrap_or_else(|error| panic!("{error}")).reward, 1.0);
    }
}
