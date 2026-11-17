#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::{GenerateOptions, Observation, Solver, Task, TraceStep};
use serde_json::{Value, json};

fn fixture(name: &str) -> Fixture {
    let file = json!({"items":[{"id":"A","name":"Original"}],"other":[]}).to_string();
    Fixture::with_env(name, "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_ORDER_NO_DETAILS=1", &[(&format!("pages.{name}"), &file)])
        .expect("build kition-kit-mock first")
}

#[tokio::test]
async fn replayed_forward_moves_reach_the_end_gap() {
    let name = "envmovegap";
    let start = json!({"items":[{"id":"A","name":"Alpha"},{"id":"B","name":"Beta"},{"id":"C","name":"Gamma"}],"other":[]}).to_string();
    let file = format!("pages.{name}");
    let f = Fixture::with_env(name, "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_ORDER_NO_DETAILS=1", &[(&file, &start)]).expect("build mock");
    let snapshot = kition_env::read_snapshot(&f.kit, &file, start.as_bytes()).await.unwrap();
    let receipt = json!({"created":[],"changed":[],"deleted":[],"moved":[{"id":"A","type":"Item","from":{"parent":"root-order","field":"items","index":0},"to":{"parent":"root-order","field":"items","index":2}}]});
    let ops = kition_env::ops_for(&receipt, &snapshot).unwrap();
    let task = Task::from_json(&json!({"id":"move-gap","kit":f.kit.definition.id,"file":file,"seed":7,"index":0,"kind":"move","instruction":"Move Alpha to the end.","inverse":false,"resampled":[],"groundTruth":receipt,"solution":ops})).unwrap();
    let mut oracle = kition_env::Oracle::new(&task, Default::default());
    let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
    assert!(trace.verified(), "{}", trace.to_line());
    assert_eq!(ops[0]["to"], 3);
}

#[tokio::test]
async fn generated_moves_never_resample_an_adjacent_noop() {
    let start = json!({"items":[{"id":"A","name":"Alpha"},{"id":"B","name":"Beta"},{"id":"C","name":"Gamma"}],"other":[]}).to_string();
    let f = Fixture::with_env("envsamplegap", "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_ORDER_NO_DETAILS=1", &[("pages.envsamplegap", &start)])
        .expect("build mock");
    let generated = kition_env::generate(
        &f.kit,
        f.workspace.path(),
        &GenerateOptions { seed: 7, count: 12, inverse_share: 0.0, kinds: Some(vec!["move".into()]), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(generated.tasks.len(), 12, "{:?}", generated.given_up);
    for task in generated.tasks {
        assert!(task.resampled.is_empty(), "{}", task.to_line());
        let mut oracle = kition_env::Oracle::new(&task, Default::default());
        assert!(kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap().verified());
    }
}

#[tokio::test]
async fn fresh_creation_ids_support_forward_and_inverse_traces() {
    let fixture = fixture("envfreshinverse");
    for inverse_share in [0.0, 1.0] {
        let options = GenerateOptions { seed: 7, count: 3, inverse_share, kinds: Some(vec!["create".into()]), ..Default::default() };
        let generated = kition_env::generate(&fixture.kit, fixture.workspace.path(), &options).await.unwrap();
        assert_eq!(generated.tasks.len(), 3, "inverse={inverse_share}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert!(task.resampled.is_empty(), "{:?}", task.resampled);
            for find in [false, true] {
                let mut oracle = kition_env::Oracle::new(&task, kition_env::OracleOptions { find });
                let trace = kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut oracle).await.unwrap();
                assert!(trace.verified(), "{}", trace.to_line());
                assert!(trace.steps.iter().all(|step| step.result.get("error").is_none()), "{}", trace.to_line());
                assert_eq!(trace.id_map.len(), 1);
            }
        }
    }
}

struct SeparateBatches(Vec<Value>);

impl Solver for SeparateBatches {
    fn next(&mut self, observation: &Observation, steps: &[TraceStep]) -> Option<(String, Value)> {
        let op = self.0.get(steps.len())?;
        let tool = observation.tools.iter().find(|tool| tool.ends_with("_batch"))?.clone();
        Some((tool, json!({"ops":[op],"changes":"all"})))
    }
}

#[tokio::test]
async fn a_trace_edits_and_deletes_the_id_allocated_by_an_earlier_call() {
    let fixture = fixture("envfreshsteps");
    let task = Task::from_json(&json!({
        "id":"fresh-steps","kit":fixture.kit.definition.id,"file":"pages.envfreshsteps","seed":7,"index":0,"kind":"create",
        "instruction":"Create a temporary item, rename it, then delete it.","inverse":false,"resampled":[],
        "groundTruth":{"created":[],"changed":[],"moved":[],"deleted":[]},
        "bindings":{"recorded-new":"$new"},
        "solution":[
            {"op":"create","type":"Item","in":"root.items","ref":"$new","fields":{"name":"Temporary"}},
            {"op":"set","target":"recorded-new","field":"name","value":"Edited"},
            {"op":"delete","target":"recorded-new"}
        ]
    }))
    .unwrap();
    let trace = kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut SeparateBatches(task.solution.clone())).await.unwrap();
    assert_eq!(trace.steps.len(), 3);
    for step in &trace.steps {
        assert!(step.result.get("error").is_none(), "{}", trace.to_line());
    }
    let actual = &trace.steps[0].result["refs"]["$new"];
    assert_ne!(actual, "recorded-new");
    assert_eq!(&trace.steps[1].result["changes"]["changed"][0]["id"], actual);
    assert_eq!(trace.steps[1].result["changes"]["changed"][0]["edits"][0]["after"], "Edited");
    assert_eq!(&trace.steps[2].result["changes"]["deleted"][0]["id"], actual);
    assert_eq!(&trace.steps[1].arguments["ops"][0]["target"], actual);
    assert_eq!(&trace.to_line().parse::<Value>().unwrap()["idMap"]["recorded-new"], actual);
    assert!(trace.verified(), "{}", trace.to_line());
    let mut oracle = kition_env::Oracle::new(&task, Default::default());
    let batch = kition_env::trace(&fixture.kit, fixture.workspace.path(), &task, &mut oracle).await.unwrap();
    assert!(batch.steps.iter().all(|step| step.result.get("error").is_none()), "{}", batch.to_line());
    assert!(batch.verified(), "{}", batch.to_line());
}

/// Replaying a creation's receipt (`ops_for`) on a copy of the start file makes the object the
/// receipt names, with its id, not a new one: the forward and the replayed file are the same,
/// ids included. For an object a list holds and one a tree holds.
#[tokio::test]
async fn a_replayed_creation_keeps_the_receipts_id() {
    for (name, order) in [("envreplaylist", "list"), ("envreplaytree", "tree")] {
        let start = json!({"items":[{"id":"A","name":"Original"}],"other":[]}).to_string();
        let file = format!("pages.{name}");
        let fixture = Fixture::with_env(name, &format!("KITION_KIT_MOCK_ORDER={order} KITION_KIT_MOCK_ORDER_NO_DETAILS=1"), &[(&file, &start)])
            .expect("build kition-kit-mock first");
        let task = Task::from_json(&json!({
            "id":format!("replay-{order}"),"kit":fixture.kit.definition.id,"file":file,"seed":7,"index":0,"kind":"create",
            "instruction":"Create an item.","inverse":false,"resampled":[],
            "groundTruth":{"created":[],"changed":[],"moved":[],"deleted":[]},"bindings":{},"solution":[]
        }))
        .unwrap();
        let mut env = kition_env::Environment::new(fixture.kit.clone(), fixture.workspace.path());
        let seen = env.reset(&task).await.unwrap();
        // In a tree the file keeps the items under the group node `group-order`.
        let mut create = json!({"op":"create","type":"Item","in":"root.items","ref":"$new","fields":{"name":"New"}});
        if order == "tree" {
            create["parent"] = json!("group-order");
        }
        let created = env.step(&fixture.kit.tool("batch"), json!({"path":seen.path,"ops":[create],"changes":"all"})).await.unwrap();
        assert!(created.result.get("error").is_none(), "{order}: {}", created.result);
        let id = created.result["refs"]["$new"].as_str().unwrap_or_else(|| panic!("{order}: {}", created.result)).to_owned();
        let forward = std::fs::read_to_string(env.file()).unwrap();
        let snapshot = kition_env::read_snapshot(&fixture.kit, &file, start.as_bytes()).await.unwrap();
        let ops = kition_env::ops_for(&created.result["changes"], &snapshot).unwrap_or_else(|error| panic!("{order}: {error}"));
        let seen = env.reset(&task).await.unwrap();
        let replayed = env.step(&fixture.kit.tool("batch"), json!({"path":seen.path,"ops":ops})).await.unwrap();
        assert!(replayed.result.get("error").is_none(), "{order}: {}", replayed.result);
        let replayed = std::fs::read_to_string(env.file()).unwrap();
        assert!(replayed.contains(&format!("\"{id}\"")), "{order}: the replayed object has the receipt's id `{id}`: {replayed}");
        assert_eq!(replayed, forward, "{order}");
        // Replayed onto the file that already holds the object, the creation fails loudly.
        let again = env.step(&fixture.kit.tool("batch"), json!({"path":seen.path,"ops":ops})).await.unwrap();
        assert!(again.result.get("error").is_some(), "{order}: {}", again.result);
    }
}
