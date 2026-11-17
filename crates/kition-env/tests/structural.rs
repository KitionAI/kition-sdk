#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::GenerateOptions;
use serde_json::json;

fn file() -> String {
    json!({"sheets":(1..=2).map(|sheet|json!({"id":sheet,"name":format!("Sheet {sheet}"),
        "rows":(1..=3).map(|at|json!({"id":(sheet-1)*3+at,"name":format!("Row {at}")})).collect::<Vec<_>>(),
        "cells":(1..=3).map(|at|json!({"id":(sheet-1)*3+at,"row":(sheet-1)*3+at,"value":at})).collect::<Vec<_>>()
    })).collect::<Vec<_>>()})
    .to_string()
}

#[tokio::test]
async fn structural_consequences_replay_the_user_edit_with_complete_rewards() {
    let file = file();
    let fixture = Fixture::with_env("envstructural", "KITION_KIT_MOCK_ORDER=structure", &[("book.envstructural", &file)]).expect("build mock");
    for kind in ["create", "delete", "move", "replace-text"] {
        for inverse_share in [0.0, 1.0] {
            if kind == "delete" && inverse_share == 1.0 {
                continue;
            }
            let options = GenerateOptions { seed: 7, count: 4, inverse_share, kinds: Some(vec![kind.into()]), ..Default::default() };
            let generated = kition_env::generate(&fixture.kit, fixture.workspace.path(), &options).await.unwrap();
            assert_eq!(generated.tasks.len(), 4, "{kind}/{inverse_share}: {:?}", generated.given_up);
            let mut dependent = 0;
            for task in generated.tasks {
                let cells = task.ground_truth["changed"].as_array().unwrap().iter().any(|change| change["type"] == "Cell");
                if !cells {
                    continue;
                }
                dependent += 1;
                assert!(
                    task.solution.iter().all(|op| !matches!(op["field"].as_str(), Some("formula" | "label" | "address" | "address.row" | "cells"))),
                    "{}",
                    task.to_line()
                );
                assert!(
                    !task.instruction.contains("formula") && !task.instruction.contains("address") && !task.instruction.contains("label"),
                    "{}",
                    task.instruction
                );
                let mut oracle = kition_env::Oracle::new(&task, Default::default());
                let trace = kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut oracle).await.unwrap();
                assert!(trace.verified(), "{}", trace.to_line());
                assert!(trace.steps.iter().all(|step| step.result.get("error").is_none()), "{}", trace.to_line());
            }
            assert!(dependent > 0, "no consequential {kind}/{inverse_share} tasks");
        }
    }
}

#[tokio::test]
async fn structural_consequences_do_not_admit_an_undeclared_stored_effect() {
    let file = file();
    let fixture =
        Fixture::with_env("envstructuralbad", "KITION_KIT_MOCK_ORDER=structure KITION_KIT_MOCK_STRUCTURE_UNRELATED=1", &[("book.envstructuralbad", &file)])
            .expect("build mock");
    let options = GenerateOptions { seed: 7, count: 4, inverse_share: 0.0, attempts: 1, kinds: Some(vec!["delete".into()]), ..Default::default() };
    let generated = kition_env::generate(&fixture.kit, fixture.workspace.path(), &options).await.unwrap();
    assert!(generated.tasks.is_empty(), "{:?}", generated.tasks);
    assert_eq!(generated.given_up.len(), 4);
    assert!(generated.given_up.iter().all(|failure| failure["resampled"][0]["reason"] == "instruction-incomplete"), "{:?}", generated.given_up);
}
