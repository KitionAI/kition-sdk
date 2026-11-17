//! Scoring: a reward compares the document before and after an attempt, however it was
//! made, with the task's ground truth: `intended` (the ground truth's changes present with their
//! values), `preserved` (nothing else changed), `diagnostics` (no new error), and `reward`, their
//! product.
//!
//! Cases: `sdk.agent.kit-env/score`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::{Environment, GenerateOptions, Reward, ScoreOptions, Task};
use serde_json::{Value, json};

/// A forward task that replaces the text of `shape:1` (`"Q3 revenue"`), the first the seeds give.
async fn text_task(f: &Fixture) -> Task {
    for seed in 0..200 {
        let options = GenerateOptions { seed, count: 1, inverse_share: 0.0, kinds: Some(vec!["replace-text".to_owned()]), ..GenerateOptions::default() };
        let tasks = kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}")).tasks;
        if let Some(task) = tasks.into_iter().find(|task| task.ground_truth["changed"][0]["id"] == "shape:1") {
            return task;
        }
    }
    panic!("no seed edits shape:1")
}

fn after_text(task: &Task) -> String {
    task.ground_truth["changed"][0]["edits"][0]["after"].as_str().unwrap_or_default().to_owned()
}

fn set_text(id: &str, text: &str) -> Value {
    json!({ "op": "set", "target": id, "field": "text", "value": text })
}

/// Runs `ops` as one `<prefix>_batch` in a fresh episode of `task`; answers the reward.
async fn attempt(f: &Fixture, task: &Task, ops: Value) -> Reward {
    let mut env = Environment::new(f.kit.clone(), f.workspace.path());
    let observation = env.reset(task).await.unwrap_or_else(|error| panic!("{error}"));
    if ops.as_array().is_some_and(|ops| !ops.is_empty()) {
        let step = env.step(&f.tool("batch"), json!({ "path": observation.path, "ops": ops })).await.unwrap_or_else(|error| panic!("{error}"));
        assert!(step.result.get("error").is_none(), "{}", step.result);
    }
    env.score().await.unwrap_or_else(|error| panic!("{error}"))
}

#[tokio::test]
async fn the_ground_truth_itself_scores_one() {
    let Some(f) = Fixture::deck("envsc1") else { return };
    let task = text_task(&f).await;
    let reward = attempt(&f, &task, json!([set_text("shape:1", &after_text(&task))])).await;
    assert_eq!((reward.reward, reward.intended, reward.preserved, reward.diagnostics), (1.0, 1.0, 1.0, 1.0), "{reward:?}");
    assert!(reward.collateral.is_empty() && reward.missing.is_empty() && reward.new_errors.is_empty(), "{reward:?}");
}

#[tokio::test]
async fn an_edit_with_collateral_damage_keeps_intended_and_loses_preserved() {
    let Some(f) = Fixture::deck("envsc2") else { return };
    let task = text_task(&f).await;
    let reward =
        attempt(&f, &task, json!([set_text("shape:1", &after_text(&task)), { "op": "set", "target": "shape:4", "field": "color", "value": "red" }])).await;
    assert_eq!(reward.intended, 1.0, "{reward:?}");
    assert!(reward.preserved < 1.0 && reward.preserved > 0.0, "{reward:?}");
    assert_eq!(reward.reward, reward.intended * reward.preserved * reward.diagnostics);
    assert_eq!(reward.collateral.len(), 1, "{reward:?}");
    assert_eq!(reward.collateral[0]["id"], "shape:4", "{reward:?}");
    assert_eq!(reward.collateral[0]["field"], "color", "{reward:?}");
}

#[tokio::test]
async fn the_right_value_on_the_wrong_object_scores_nothing_intended() {
    let Some(f) = Fixture::deck("envsc3") else { return };
    let task = text_task(&f).await;
    let reward = attempt(&f, &task, json!([set_text("shape:2", &after_text(&task))])).await;
    assert_eq!(reward.intended, 0.0, "{reward:?}");
    assert!(reward.preserved < 1.0, "{reward:?}");
    assert_eq!(reward.reward, 0.0);
    assert_eq!(reward.collateral.iter().map(|change| change["id"].clone()).collect::<Vec<_>>(), vec![json!("shape:2")], "{reward:?}");
    assert_eq!(reward.missing.len(), 1, "{reward:?}");
}

#[tokio::test]
async fn doing_nothing_scores_zero() {
    let Some(f) = Fixture::deck("envsc4") else { return };
    let task = text_task(&f).await;
    let reward = attempt(&f, &task, json!([])).await;
    assert_eq!((reward.reward, reward.intended, reward.preserved), (0.0, 0.0, 1.0), "{reward:?}");
}

#[tokio::test]
async fn a_new_error_diagnostic_zeroes_diagnostics() {
    let Some(f) = Fixture::deck("envsc5") else { return };
    let task = text_task(&f).await;
    let reward = attempt(&f, &task, json!([set_text("shape:1", &after_text(&task)), set_text("shape:3", "")])).await;
    assert_eq!(reward.intended, 1.0, "{reward:?}");
    assert_eq!(reward.diagnostics, 0.0, "{reward:?}");
    assert_eq!(reward.reward, 0.0, "{reward:?}");
    assert_eq!(reward.new_errors.len(), 1, "{reward:?}");
    assert_eq!(reward.new_errors[0]["code"], "mock.empty-shape", "{reward:?}");
}

/// The same edits written into the file by another program score as the tools' do: the scorer
/// compares the states, not how they were reached.
#[tokio::test]
async fn an_attempt_written_outside_the_tools_scores_as_one_made_through_them() {
    let Some(f) = Fixture::deck("envsc6") else { return };
    let task = text_task(&f).await;
    let after = after_text(&task);
    let before = f.read(&f.file());
    let options = ScoreOptions::default();
    for (ops, rewritten) in [
        (json!([set_text("shape:1", &after)]), common::DECK.replace("1=Q3 revenue#red", &format!("1={after}#red"))),
        (
            json!([set_text("shape:1", &after), { "op": "set", "target": "shape:4", "field": "color", "value": "red" }]),
            common::DECK.replace("1=Q3 revenue#red", &format!("1={after}#red")).replace("4=Agenda", "4=Agenda#red"),
        ),
    ] {
        let through_tools = attempt(&f, &task, ops).await;
        let outside = kition_env::score_files(&f.kit, &task, &before, rewritten.as_bytes(), &options).await.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(outside, through_tools, "{rewritten}");
    }
}

/// A receipt can be scored too, when the caller trusts it: the attempt's own change set and the
/// diagnostics it introduced.
#[tokio::test]
async fn a_receipt_scores_as_the_states_do_when_asked_to() {
    let Some(f) = Fixture::deck("envsc7") else { return };
    let task = text_task(&f).await;
    let mut env = Environment::new(f.kit.clone(), f.workspace.path());
    let observation = env.reset(&task).await.unwrap_or_else(|error| panic!("{error}"));
    let ops = json!([set_text("shape:1", &after_text(&task)), { "op": "set", "target": "shape:4", "field": "color", "value": "red" }]);
    let step = env.step(&f.tool("batch"), json!({ "path": observation.path, "ops": ops, "changes": "all" })).await.unwrap_or_else(|error| panic!("{error}"));
    let receipt = &step.result;
    let from_receipt = kition_env::score_changes(
        &task,
        &receipt["changes"],
        receipt["diagnostics"]["new"].as_array().map_or(&[][..], Vec::as_slice),
        &ScoreOptions::default(),
    );
    let from_states = env.score().await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(from_receipt, from_states);
}

/// Texts are compared after trimming and Unicode normalisation unless the exact comparison is asked for.
#[tokio::test]
async fn texts_compare_normalised_unless_exact() {
    let Some(f) = Fixture::deck("envsc8") else { return };
    let task = text_task(&f).await;
    let mut task = task;
    // A ground truth asking for "Café" (precomposed) answered with "Cafe\u{301}  " (decomposed, spaces).
    task.ground_truth["changed"][0]["edits"][0]["after"] = json!("Caf\u{e9}");
    let before = f.read(&f.file());
    let after = common::DECK.replace("1=Q3 revenue#red", "1=Cafe\u{301}  #red");
    let loose = kition_env::score_files(&f.kit, &task, &before, after.as_bytes(), &ScoreOptions::default()).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(loose.reward, 1.0, "{loose:?}");
    let exact =
        kition_env::score_files(&f.kit, &task, &before, after.as_bytes(), &ScoreOptions { exact_text: true }).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(exact.intended, 0.0, "{exact:?}");
}
