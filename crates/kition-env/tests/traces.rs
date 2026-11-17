//! Traces: a solver's tool calls and their results on a task, as an agent makes them. The
//! built-in oracle replays the ground truth through the agent-facing tools (inspect, batch,
//! check); a trace is emitted only when its reward is 1, with images replaced by their hashes.
//!
//! Cases: `sdk.agent.kit-env/traces`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use common::Fixture;
use kition_env::{GenerateOptions, Observation, Oracle, OracleOptions, Solver, Task, TraceStep};
use serde_json::{Value, json};

async fn tasks(f: &Fixture, seed: u64, count: usize, inverse_share: f64) -> Vec<Task> {
    let options = GenerateOptions { seed, count, inverse_share, ..GenerateOptions::default() };
    kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}")).tasks
}

#[tokio::test]
async fn every_generated_task_replays_to_reward_one_with_the_oracle() {
    let Some(f) = Fixture::deck("envoracle") else { return };
    let tasks = tasks(&f, 21, 16, 0.3).await;
    assert_eq!(tasks.len(), 16);
    for task in &tasks {
        let trace = kition_env::trace(&f.kit, f.workspace.path(), task, &mut Oracle::new(task, OracleOptions::default()))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(trace.reward.reward, 1.0, "{} gives {:?}", task.to_line(), trace.reward);
        let tools: Vec<&str> = trace.steps.iter().map(|step| step.tool.as_str()).collect();
        assert_eq!(tools, vec![f.tool("inspect"), f.tool("batch"), f.tool("check")], "{tools:?}");
        assert!(trace.verified());
    }
}

/// The ids a step's arguments name: op targets, items and the objects created in.
fn named_ids(arguments: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for op in arguments["ops"].as_array().into_iter().flatten() {
        for key in ["target", "item"] {
            ids.extend(op[key].as_str().map(str::to_owned));
        }
        if let Some((owner, _)) = op["in"].as_str().and_then(|place| place.rsplit_once('.')) {
            ids.push(owner.to_owned());
        }
    }
    ids
}

/// With `find`, the oracle reads where its targets are before it names them: every id its batch
/// uses was answered by an earlier step, so the trace shows how the target was found.
#[tokio::test]
async fn the_oracle_can_show_how_it_found_its_targets() {
    let Some(f) = Fixture::deck("envfind") else { return };
    for task in &tasks(&f, 13, 10, 0.3).await {
        let trace = kition_env::trace(&f.kit, f.workspace.path(), task, &mut Oracle::new(task, OracleOptions { find: true }))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(trace.reward.reward, 1.0, "{}", task.to_line());
        let batch = trace.steps.iter().position(|step| step.tool == f.tool("batch")).unwrap_or_else(|| panic!("a batch"));
        assert!(trace.steps[..batch].iter().any(|step| step.tool == f.tool("query")), "it read the object model first");
        let seen: String = trace.steps[..batch].iter().map(|step| step.result.to_string()).collect();
        for id in named_ids(&trace.steps[batch].arguments) {
            if id != "root" {
                assert!(seen.contains(&format!("\"{id}\"")), "`{id}` was found before it was named: {}", task.instruction);
            }
        }
    }
}

/// A solver that gives up at once: its trace scores 0 and is never emitted.
struct Idle;

impl Solver for Idle {
    fn next(&mut self, _observation: &Observation, _steps: &[TraceStep]) -> Option<(String, Value)> {
        None
    }
}

#[tokio::test]
async fn traces_are_json_lines_with_images_replaced_and_reward_one_only() {
    let Some(f) = Fixture::deck("envtrace") else { return };
    let tasks = tasks(&f, 17, 4, 0.0).await;
    let idle = kition_env::trace(&f.kit, f.workspace.path(), &tasks[0], &mut Idle).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(idle.reward.reward, 0.0);
    assert!(!idle.verified());
    let lines = kition_env::verified_traces(&f.kit, f.workspace.path(), &tasks, OracleOptions::default()).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(lines.len(), tasks.len());
    for line in &lines {
        assert!(!line.contains('\n'));
        let trace: Value = serde_json::from_str(line).unwrap_or_else(|error| panic!("{error}: {line}"));
        assert_eq!(trace["reward"]["reward"], 1.0, "{trace}");
        assert!(trace["task"]["instruction"].is_string(), "{trace}");
        for step in trace["steps"].as_array().into_iter().flatten() {
            assert!(step["tool"].is_string() && step["arguments"].is_object() && !step["result"].is_null(), "{step}");
        }
        assert!(!line.contains("iVBORw0KGgo"), "no PNG in a trace");
        let inspect = &trace["steps"][0]["result"];
        let previews = inspect["previews"].as_array().unwrap_or_else(|| panic!("the inspect asked for a preview: {inspect}"));
        assert!(!previews.is_empty(), "{inspect}");
        for preview in previews {
            assert!(preview["png"].as_str().is_some_and(|png| png.starts_with("sha256:") && png.len() == 7 + 64), "{preview}");
        }
    }
}

/// Images inside a result are replaced wherever they are: a PNG as base64 becomes its hash.
#[test]
fn images_in_results_are_replaced_by_their_hashes() {
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";
    let result = kition_env::without_images(&json!({ "image": png, "nested": [{ "data": format!("data:image/png;base64,{png}") }], "text": "plain" }));
    assert!(result["image"].as_str().is_some_and(|value| value.starts_with("sha256:")), "{result}");
    assert!(result["nested"][0]["data"].as_str().is_some_and(|value| value.starts_with("sha256:")), "{result}");
    assert_eq!(result["text"], "plain");
}
