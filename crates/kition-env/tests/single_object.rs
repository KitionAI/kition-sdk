//! root fields and bounded edits inside a document-sized text.
mod common;

use std::collections::BTreeSet;

use common::Fixture;
use kition_env::{GenerateOptions, Oracle, OracleOptions};
use serde_json::json;

async fn single_object(kind: &str, inverse: bool) {
    let body = (0..100).map(|i| format!("Line {i}: Review the quarterly report and record the result.\n")).collect::<String>();
    assert!(body.chars().count() >= 5_000);
    let data = json!({"body":body,"starred":false}).to_string();
    let name = format!("envsingle{kind}{}", u8::from(inverse));
    let f = Fixture::with_env(&name, &format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_ROOT_TEXT={kind}"), &[("note.mock", &data)]).expect("build mock");
    std::fs::rename(f.workspace.path().join("note.mock"), f.workspace.path().join(format!("note.{name}"))).unwrap();
    let inverse_share = if inverse { 1.0 } else { 0.0 };
    let options = GenerateOptions { count: 24, seed: 20, inverse_share, kinds: Some(vec!["replace-text".into()]), ..Default::default() };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap();
    assert!(generated.skipped.is_empty(), "{kind}: {:?}", generated.skipped);
    assert_eq!(generated.tasks.len(), 24, "{kind}: {:?}", generated.given_up);
    let distinct: BTreeSet<_> = generated.tasks.iter().map(|task| task.ground_truth.to_string()).collect();
    assert!(distinct.len() >= 20, "{kind}: {} distinct tasks", distinct.len());
    for task in &generated.tasks {
        let span = &task.ground_truth["changed"][0]["edits"][0]["span"];
        assert_eq!(span["complete"], true);
        assert!(task.instruction.contains("context"), "{}", task.instruction);
        assert!(task.instruction.len() < 600);
        assert!(task.ground_truth.to_string().len() < 2_048);
        let mut oracle = Oracle::new(task, OracleOptions::default());
        let trace = kition_env::trace(&f.kit, f.workspace.path(), task, &mut oracle).await.unwrap();
        assert_eq!(trace.reward.reward, 1.0, "{}", trace.to_line());
        let mut wrong = task.ground_truth.clone();
        wrong["changed"][0]["edits"][0]["span"]["offset"] = json!(span["offset"].as_u64().unwrap() + 1);
        assert_eq!(kition_env::score_changes(task, &wrong, &[], &Default::default()).reward, 0.0);
    }
    let fields = kition_env::generate(
        &f.kit,
        f.workspace.path(),
        &GenerateOptions { count: 1, inverse_share: 0.0, kinds: Some(vec!["set-field".into()]), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(fields.tasks.len(), 1, "{:?}", fields.given_up);
    assert!(fields.tasks[0].instruction.contains("document"));
}

#[tokio::test]
async fn single_object_string_forward() {
    single_object("string", false).await;
}

#[tokio::test]
async fn single_object_string_inverse() {
    single_object("string", true).await;
}

#[tokio::test]
async fn single_object_text_forward() {
    single_object("text", false).await;
}

#[tokio::test]
async fn single_object_text_inverse() {
    single_object("text", true).await;
}
