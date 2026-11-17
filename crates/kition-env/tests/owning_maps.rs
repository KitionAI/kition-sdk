#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::GenerateOptions;
use serde_json::json;

#[tokio::test]
async fn owning_map_children_support_every_applicable_edit_kind() {
    let file = json!({"items":[],"other":[],"catalog":{
        "standard":{"key":"style:Standard","name":"Standard","data":{},"extra":1},
        "wrapped":{"key":"style:Wrapped","name":"Wrapped","data":{},"extra":2}
    }})
    .to_string();
    let fixture =
        Fixture::with_env("envmapedits", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1 KITION_KIT_MOCK_MAP_EDITS=1", &[("drawing.envmapedits", &file)])
            .expect("build kition-kit-mock first");
    for kind in ["set-field", "replace-text", "create", "delete"] {
        let options = GenerateOptions { seed: 7, count: 4, inverse_share: 0.0, kinds: Some(vec![kind.into()]), ..Default::default() };
        let generated = kition_env::generate(&fixture.kit, fixture.workspace.path(), &options).await.unwrap();
        assert_eq!(generated.tasks.len(), 4, "{kind}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert!(task.resampled.is_empty(), "{kind}: {:?}", task.resampled);
            assert_eq!(task.kind, kind);
            if kind == "create" {
                assert!(task.solution.iter().any(|op| op["op"] == "map.set" && op["field"] == "catalog"), "{}", task.to_line());
            }
            let mut oracle = kition_env::Oracle::new(&task, Default::default());
            let trace = kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut oracle).await.unwrap();
            assert!(trace.verified(), "{}", trace.to_line());
        }
    }
}

#[tokio::test]
async fn owning_single_children_with_tool_ids_are_field_and_text_candidates() {
    let file = json!({"items":[],"other":[],"catalog":{},"single":{"key":"only","name":"Single","data":{},"extra":1}}).to_string();
    let fixture = Fixture::with_env(
        "envsingleedits",
        "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1 KITION_KIT_MOCK_MAP_EDITS=1",
        &[("drawing.envsingleedits", &file)],
    )
    .expect("build kition-kit-mock first");
    for kind in ["set-field", "replace-text"] {
        let options = GenerateOptions { seed: 7, count: 2, inverse_share: 0.0, kinds: Some(vec![kind.into()]), ..Default::default() };
        let generated = kition_env::generate(&fixture.kit, fixture.workspace.path(), &options).await.unwrap();
        assert_eq!(generated.tasks.len(), 2, "{kind}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert_eq!(task.solution[0]["target"], "only");
            let mut oracle = kition_env::Oracle::new(&task, Default::default());
            assert!(kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut oracle).await.unwrap().verified());
        }
    }
}
