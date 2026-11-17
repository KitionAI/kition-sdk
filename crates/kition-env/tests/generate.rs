//! Task generation: a seeded sampler over the generic edit kinds the object model of the
//! mock kit's decks expresses, applied through the kit's own `<prefix>_batch` on a copy, with the
//! receipt as the ground truth; instructions name objects as a person would.
//!
//! Cases: `sdk.agent.kit-env/generate`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use std::collections::BTreeSet;

use common::Fixture;
use kition_env::{GenerateOptions, Task};
use serde_json::{Value, json};

fn options(seed: u64, count: usize, inverse_share: f64) -> GenerateOptions {
    GenerateOptions { seed, count, inverse_share, ..GenerateOptions::default() }
}

#[tokio::test]
async fn declared_creation_templates_commands_fixtures_and_exclusions_make_valid_tasks() {
    for mode in ["immutable", "template", "command", "excluded"] {
        let name = format!("envcreation{mode}");
        let file = if mode == "immutable" {
            json!({"items":[{"id":"A","name":"Original","kind":{"shape":"box","width":10}}],"other":[]})
        } else {
            json!({"items":[],"other":[]})
        }
        .to_string();
        let env = format!("KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_ORDER_NO_DETAILS=1 KITION_KIT_MOCK_BATCH=commands KITION_KIT_MOCK_CREATION={mode}");
        let path = format!("drawing.{name}");
        let f = Fixture::with_env(&name, &env, &[(&path, &file)]).expect("build mock");
        let generated =
            kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["create".into()]), ..options(7, 2, 0.0) }).await.unwrap();
        if mode == "excluded" {
            assert!(generated.tasks.is_empty());
            assert_eq!(generated.given_up[0]["reason"], "no-candidates");
            continue;
        }
        assert_eq!(generated.tasks.len(), 2, "{mode}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert!(task.resampled.is_empty(), "{mode}: {:?}", task.resampled);
            assert_eq!(task.ground_truth["created"][0]["values"]["kind"], json!({"shape":"box","width":10}));
            if mode == "command" {
                assert_eq!(task.solution[0]["params"]["fixture"]["data"], json!([137, 80, 78, 71]));
            }
            let mut oracle = kition_env::Oracle::new(&task, Default::default());
            assert!(kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap().verified(), "{mode}: {}", task.to_line());
        }
    }
}

#[tokio::test]
async fn declared_json_text_members_are_sampled_and_worded_as_text() {
    let file = json!({"items":[
        {"key":"A","name":"Record A","data":{"words":"First"},"extra":1},
        {"key":"B","name":"Record B","data":{"words":"Second"},"extra":2},
        {"key":"C","name":"Nontext","data":{"number":3},"extra":3}
    ],"other":[]})
    .to_string();
    let f = Fixture::with_env("envtextmember", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_TEXT=1", &[("drawing.envtextmember", &file)]).expect("build mock");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["replace-text".into()]), ..options(7, 12, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 12, "{:?}", generated.given_up);
    for task in generated.tasks {
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
        assert!(task.instruction.contains("the text") && task.instruction.contains("says"), "{}", task.instruction);
        assert!(task.solution.iter().any(|op| op["field"] == "data.words" && op["target"] != "C"), "{}", task.to_line());
        let mut oracle = kition_env::Oracle::new(&task, Default::default());
        assert!(kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap().verified());
    }
}

#[tokio::test]
async fn premise_only_facts_never_enter_environment_snapshots() {
    let file = json!({"nodes":[{"key":1,"name":"A","location":[0,0,0],"hidden":false}]}).to_string();
    let f = Fixture::with_env(
        "envprivate",
        "KITION_KIT_MOCK_PARTS=space KITION_KIT_MOCK_WORLD_DERIVED=1 KITION_KIT_MOCK_PRIVATE_DERIVED=1",
        &[("drawing.envprivate", &file)],
    )
    .expect("build mock");
    let snapshot = kition_env::read_snapshot(&f.kit, "drawing.envprivate", file.as_bytes()).await.unwrap();
    assert!(!snapshot.canonical().to_string().contains("worldLocation"));
    assert!(!snapshot.canonical().to_string().contains('~'));
}

#[tokio::test]
async fn conditional_member_limits_are_used_without_resampling() {
    let file = json!({"items":[
        {"key":"A","name":"Alpha","data":{"kind":"percent","v":0.5},"extra":1},
        {"key":"B","name":"Beta","data":{"kind":"count","v":5},"extra":2}
    ],"other":[]})
    .to_string();
    let f = Fixture::with_env("envconditional", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_CONDITIONAL_LIMITS=1", &[("drawing.envconditional", &file)])
        .expect("build mock");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["set-field".into()]), ..options(9, 48, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 48, "{:?}", generated.given_up);
    let mut seen = BTreeSet::new();
    for task in generated.tasks {
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
        for changed in task.ground_truth["changed"].as_array().unwrap() {
            for edit in changed["edits"].as_array().unwrap() {
                if edit["field"] != "data.v" {
                    continue;
                }
                let id = changed["id"].as_str().unwrap();
                let value = edit["after"].as_f64().unwrap();
                let (max, step) = if id == "A" { (1.0, 0.1) } else { (10.0, 1.0) };
                assert!((0.0..=max).contains(&value) && (value / step - (value / step).round()).abs() < 1e-9, "{id}: {value}");
                seen.insert(id.to_owned());
            }
        }
        let mut oracle = kition_env::Oracle::new(&task, Default::default());
        assert!(kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap().verified());
    }
    assert_eq!(seen, BTreeSet::from(["A".into(), "B".into()]));
}

#[tokio::test]
async fn owned_body_creations_and_composition_moves_replay() {
    let file = json!({"items":[{"id":1,"name":"Page","notes":"Notes","layers":[{"id":1,"name":"A"},{"id":2,"name":"B"},{"id":3,"name":"C"}]}]}).to_string();
    for kind in ["create", "move"] {
        let mut source: Value = serde_json::from_str(&file).unwrap();
        if kind == "create" {
            source["items"][0]["layers"] = json!([]);
        }
        let text = source.to_string();
        let f = Fixture::with_env("envownedreplay", "KITION_KIT_MOCK_ORDER=replay", &[("deck.envownedreplay", &text)]).expect("build mock");
        let generated =
            kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec![kind.into()]), ..options(7, 3, 0.0) }).await.unwrap();
        assert_eq!(generated.tasks.len(), 3, "{kind}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert!(task.resampled.is_empty(), "{kind}: {:?}", task.resampled);
            let mut oracle = kition_env::Oracle::new(&task, Default::default());
            let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
            assert!(trace.verified(), "{}", trace.to_line());
            if kind == "create" && task.ground_truth["created"][0]["type"] == "Item" {
                assert!(task.solution.iter().any(|op| op["op"] == "create" && op["type"] == "TextBody"), "{}", task.to_line());
                assert!(task.solution.iter().any(|op| op["op"] == "create" && op["type"] == "Paragraph"), "{}", task.to_line());
            }
        }
    }
}

#[tokio::test]
async fn map_owned_records_are_in_snapshots_and_sampled() {
    let file = json!({"items":[],"other":[],"catalog":{
        "standard":{"key":"style:Standard","name":"Standard","data":{},"extra":1},
        "wrapped":{"key":"style:Wrapped","name":"Wrapped","data":{},"extra":2}
    }})
    .to_string();
    let f = Fixture::with_env("envmaps", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1", &[("drawing.envmaps", &file)]).expect("build mock");
    let snapshot = kition_env::read_snapshot(&f.kit, "drawing.envmaps", file.as_bytes()).await.unwrap();
    assert_eq!(snapshot.stable_ids().len(), 2, "{:?}", snapshot.ids());
    assert!(snapshot.ids().contains(&"style:Standard".to_owned()));
    assert!(snapshot.ids().contains(&"style:Wrapped".to_owned()));
    assert_eq!(snapshot.canonical()["objects"]["matrix-root"]["catalog"]["standard"], "style:Standard");
    assert_eq!(snapshot.canonical()["objects"]["matrix-root"]["catalog"]["wrapped"]["body"], "style:Wrapped");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["set-field".into()]), ..options(7, 4, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 4, "{:?}", generated.given_up);
    assert!(generated.tasks.iter().all(|t| t.resampled.is_empty()), "{:?}", generated.tasks);
}

#[tokio::test]
async fn random_creation_ids_replay_as_the_same_task() {
    let file = json!({"items":[{"id":"A","name":"Page A"},{"id":"B","name":"Page B"}],"other":[]}).to_string();
    let f = Fixture::with_env("envrandomcreate", "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_ORDER_NO_DETAILS=1", &[("pages.envrandomcreate", &file)])
        .expect("build mock");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["create".into()]), ..options(7, 3, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 3, "{:?}", generated.given_up);
    for task in generated.tasks {
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
        assert_eq!(task.ground_truth["created"].as_array().unwrap().len(), 1);
        assert_eq!(task.ground_truth["created"][0]["type"], "Item");
        let mut oracle = kition_env::Oracle::new(&task, kition_env::OracleOptions::default());
        let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
        assert!(trace.verified(), "{}", trace.to_line());
    }
}

#[tokio::test]
async fn creation_only_kind_is_sampled_and_replayed_from_the_receipt() {
    let scene = json!({"nodes":[{"key":1,"name":"Panel","kind":"shape","location":[0,0,0],"hidden":false}]}).to_string();
    let f = Fixture::with_env("envcreationkind", "KITION_KIT_MOCK_PARTS=space KITION_KIT_MOCK_CREATION_KIND=1", &[("scene.envcreationkind", &scene)])
        .expect("build mock");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["create".into()]), ..options(7, 3, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 3, "{:?}", generated.given_up);
    for task in generated.tasks {
        assert_eq!(task.solution[0]["fields"]["kind"], "shape", "{}", task.to_line());
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
        let mut oracle = kition_env::Oracle::new(&task, kition_env::OracleOptions::default());
        let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
        assert!(trace.verified(), "{}", trace.to_line());
    }
}

#[tokio::test]
async fn create_copies_required_json_and_replays_on_the_mock() {
    let frame = json!({ "transform": [1, 0, 0, 1, 0, 0], "kind": { "type": "frame" } });
    let scene = json!({ "nodes": [{ "key": 1, "name": "Panel", "location": [10, 20, 30], "frame": frame, "hidden": false }] }).to_string();
    let f = Fixture::with_env("envjsoncreate", "KITION_KIT_MOCK_PARTS=space", &[("scene.envjsoncreate", &scene)]).expect("build the mock kit first");
    let settings = GenerateOptions { kinds: Some(vec!["create".to_owned()]), ..options(7, 2, 0.0) };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &settings).await.unwrap();
    assert_eq!(generated.tasks.len(), 2, "{:?}", generated.given_up);
    for task in &generated.tasks {
        assert_eq!(task.solution[0]["fields"]["location"], json!([10, 20, 30]));
        assert_eq!(task.solution[0]["fields"]["frame"], frame);
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
    }
    assert_eq!(lines(&generated.tasks), lines(&generate(&f, &settings).await));
}

#[tokio::test]
async fn c8_env_skips_an_unreadable_file_and_keeps_generating() {
    let image = json!({ "name": "photo", "layers": [{ "id": 1, "name": "top", "opacity": 100 }] }).to_string();
    let Some(f) = Fixture::with_env("envskip", "KITION_KIT_MOCK_PARTS=stack", &[("a.envskip", "not JSON"), ("b.envskip", &image)]) else { return };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options(1, 3, 0.0)).await.unwrap();
    assert_eq!(generated.tasks.len(), 3);
    assert!(generated.tasks.iter().all(|task| task.file == "b.envskip"));
    assert_eq!(generated.skipped.len(), 1);
    assert_eq!(generated.skipped[0]["file"], "a.envskip");
    assert!(generated.skipped[0]["reason"].as_str().unwrap().contains("no JSON"));
}

#[tokio::test]
async fn c8_env_ordinals_count_from_the_kits_declared_end() {
    let image = json!({ "name": "photo", "layers": [
        { "id": 1, "name": "same", "opacity": 100 }, { "id": 2, "name": "same", "opacity": 100 }, { "id": 3, "name": "same", "opacity": 100 }
    ] })
    .to_string();
    let Some(f) = Fixture::with_env("envreverse", "KITION_KIT_MOCK_PARTS=stack", &[("image.envreverse", &image)]) else { return };
    let snapshot = kition_env::read_snapshot(&f.kit, "image.envreverse", image.as_bytes()).await.unwrap();
    assert_eq!(snapshot.reference("3").unwrap().phrase(), "the 1st layer, named \"same\"");
    assert_eq!(snapshot.reference("1").unwrap().phrase(), "the 3rd layer, named \"same\"");
    for id in ["1", "2", "3"] {
        assert_eq!(snapshot.resolve(&snapshot.reference(id).unwrap()), [id]);
    }
}

#[tokio::test]
async fn c8_env_reports_all_unreadable_sources_without_dividing_by_zero() {
    let Some(f) = Fixture::with_env("envallskip", "KITION_KIT_MOCK_PARTS=stack", &[("bad.envallskip", "not JSON")]) else { return };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options(1, 3, 0.0)).await.unwrap();
    assert!(generated.tasks.is_empty());
    assert_eq!(generated.skipped.len(), 1);
}

#[tokio::test]
async fn c8_env_boolean_instructions_name_the_state_deterministically() {
    let scene = json!({ "nodes": [{ "key": 1, "name": "Panel", "location": [0, 0, 0], "hidden": false }] }).to_string();
    let Some(f) = Fixture::with_env("envbool", "KITION_KIT_MOCK_PARTS=space", &[("scene.envbool", &scene)]) else { return };
    let settings = GenerateOptions { kinds: Some(vec!["set-field".to_owned()]), ..options(1, 1, 0.0) };
    let tasks = generate(&f, &settings).await;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].instruction, "Set the node named \"Panel\" to hidden.");
    assert_eq!(lines(&tasks), lines(&generate(&f, &settings).await));
}

async fn generate(f: &Fixture, options: &GenerateOptions) -> Vec<Task> {
    kition_env::generate(&f.kit, f.workspace.path(), options).await.unwrap_or_else(|error| panic!("{error}")).tasks
}

fn lines(tasks: &[Task]) -> Vec<String> {
    tasks.iter().map(Task::to_line).collect()
}

/// The ids a task's ground truth names (created objects by their parents).
fn targets(task: &Task) -> BTreeSet<String> {
    let truth = &task.ground_truth;
    let mut ids = BTreeSet::new();
    for list in ["changed", "deleted", "moved"] {
        for entry in truth[list].as_array().into_iter().flatten() {
            if list == "changed" && entry["edits"].as_array().is_some_and(Vec::is_empty) {
                continue;
            }
            ids.extend(entry["id"].as_str().map(str::to_owned));
        }
    }
    ids
}

#[tokio::test]
async fn the_same_file_and_seed_give_byte_identical_tasks_and_another_seed_others() {
    let Some(f) = Fixture::deck("envdet") else { return };
    let first = lines(&generate(&f, &options(7, 12, 0.3)).await);
    let again = lines(&generate(&f, &options(7, 12, 0.3)).await);
    assert_eq!(first.len(), 12, "{first:#?}");
    assert_eq!(first, again, "the same seed gives the same lines");
    let other = lines(&generate(&f, &options(8, 12, 0.3)).await);
    assert_ne!(first, other, "another seed gives other tasks");
    assert_eq!(f.read(&f.file()), common::DECK.as_bytes(), "the workspace's file is never edited");
}

#[tokio::test]
async fn a_task_record_has_its_fields_and_a_stable_id() {
    let Some(f) = Fixture::deck("envrec") else { return };
    let tasks = generate(&f, &options(3, 10, 0.5)).await;
    let mut ids = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for task in &tasks {
        let line: Value = serde_json::from_str(&task.to_line()).unwrap_or_else(|error| panic!("{error}"));
        for field in ["id", "kit", "file", "seed", "index", "kind", "instruction", "groundTruth", "inverse", "resampled"] {
            assert!(line.get(field).is_some(), "`{field}` in {line}");
        }
        assert_eq!(line["kit"], "kit.envrec");
        assert_eq!(line["file"], f.file());
        assert_eq!(line["seed"], 3);
        assert_eq!(line["inverse"].as_bool(), Some(line.get("setup").is_some()), "an inverse task says how its file was edited: {line}");
        for list in ["created", "changed", "moved", "deleted"] {
            assert!(line["groundTruth"][list].is_array(), "{line}");
        }
        assert_eq!(Task::from_json(&line).map(|task| task.to_line()).ok(), Some(task.to_line()), "a line reads back as the same task");
        ids.insert(task.id.clone());
        kinds.insert((task.kind.clone(), task.inverse));
    }
    assert_eq!(ids.len(), tasks.len(), "task ids are unique");
    assert!(kinds.iter().any(|(_, inverse)| *inverse) && kinds.iter().any(|(_, inverse)| !*inverse), "both directions: {kinds:?}");
}

#[tokio::test]
async fn every_generic_edit_kind_is_generated_from_the_deck() {
    let Some(f) = Fixture::deck("envkinds") else { return };
    let tasks = generate(&f, &options(11, 40, 0.0)).await;
    let kinds: BTreeSet<&str> = tasks.iter().map(|task| task.kind.as_str()).collect();
    assert_eq!(kinds, BTreeSet::from(["create", "delete", "move", "replace-text", "set-field"]), "{kinds:?}");
    for task in &tasks {
        let truth = &task.ground_truth;
        let count = |list: &str| truth[list].as_array().map_or(0, Vec::len);
        match task.kind.as_str() {
            "create" => assert_eq!(count("created"), 1, "{truth}"),
            "delete" => assert_eq!(count("deleted"), 1, "{truth}"),
            "move" => assert_eq!(count("moved"), 1, "{truth}"),
            _ => assert_eq!(targets(task).len(), 1, "{truth}"),
        }
        if task.kind == "set-field" {
            let edit = &truth["changed"][0]["edits"][0];
            assert_eq!(edit["field"], "color", "the only settable field that is not the shape's text: {truth}");
            let used: BTreeSet<&str> = BTreeSet::from(["red", "blue", "green"]);
            assert!(edit["after"].as_str().is_some_and(|after| used.contains(after)), "a colour the deck uses: {truth}");
        }
        if task.kind == "delete" {
            let deleted = &truth["deleted"][0];
            assert!(deleted["type"] == "Shape" || deleted["id"] == "slide:3", "only objects that hold no others: {truth}");
        }
    }
}

#[tokio::test]
async fn instructions_name_objects_as_a_person_would_never_by_id() {
    let Some(f) = Fixture::deck("envwords") else { return };
    let tasks = generate(&f, &options(5, 40, 0.3)).await;
    for task in &tasks {
        for id in ["shape:", "slide:", "shape-", "slide-", "deck"] {
            assert!(!task.instruction.contains(id), "`{id}` in {:?}", task.instruction);
        }
        assert!(task.instruction.ends_with('.'), "{:?}", task.instruction);
    }
    let text = tasks.iter().find(|task| task.kind == "replace-text" && !task.inverse && targets(task).contains("shape:1"));
    if let Some(task) = text {
        let after = task.ground_truth["changed"][0]["edits"][0]["after"].as_str().unwrap_or_default();
        assert_eq!(task.instruction, format!("On slide 1, change the text of the shape that says \"Q3 revenue\" to \"{after}\"."));
    }
    // Shapes 5 and 6 on slide 2 both say "Same": never named by that text alone.
    let same: Vec<&Task> = tasks.iter().filter(|task| !task.inverse && targets(task).iter().any(|id| id == "shape:5" || id == "shape:6")).collect();
    assert!(!same.is_empty(), "the seed picks one of the twins: {:#?}", tasks.iter().map(|task| &task.instruction).collect::<Vec<_>>());
    for task in same {
        assert!(!task.instruction.contains("the shape that says \"Same\""), "{:?}", task.instruction);
        let ordinal = if targets(task).contains("shape:5") { "the 2nd shape" } else { "the 3rd shape" };
        assert!(task.instruction.contains(ordinal), "{ordinal} in {:?}", task.instruction);
    }
}

/// Twins are told apart by their place among their siblings, and a reference finds exactly the
/// object it was made from.
#[tokio::test]
async fn references_are_unambiguous_by_position_among_siblings() {
    let Some(f) = Fixture::deck("envref") else { return };
    let snapshot = kition_env::read_snapshot(&f.kit, &f.file(), &f.read(&f.file())).await.unwrap_or_else(|error| panic!("{error}"));
    let five = snapshot.reference("shape:5").unwrap_or_else(|| panic!("shape:5 is describable"));
    let six = snapshot.reference("shape:6").unwrap_or_else(|| panic!("shape:6 is describable"));
    let one = snapshot.reference("shape:1").unwrap_or_else(|| panic!("shape:1 is describable"));
    assert_eq!(one.phrase(), "the shape that says \"Q3 revenue\"");
    assert_eq!(one.place(), "On slide 1");
    assert_eq!(five.phrase(), "the 2nd shape, which says \"Same\"");
    assert_eq!(six.phrase(), "the 3rd shape, which says \"Same\"");
    assert_eq!(snapshot.reference("slide:3").map(|slide| slide.phrase()), Some("slide 3".to_owned()));
    for id in ["shape:1", "shape:2", "shape:3", "shape:4", "shape:5", "shape:6", "slide:1", "slide:2", "slide:3"] {
        let reference = snapshot.reference(id).unwrap_or_else(|| panic!("{id} is describable"));
        assert_eq!(snapshot.resolve(&reference), vec![id.to_owned()], "{id}: {}", reference.phrase());
    }
    assert!(snapshot.reference("deck").is_none(), "the document itself is no object to edit");
}

/// The mock's decks refuse a text holding `|` or `#` (their file's separators) and report an
/// empty shape as an error: a sampled edit the kit refuses, or that brings a new error, is
/// discarded and sampled again, and the task says why.
#[tokio::test]
async fn refused_edits_and_new_errors_are_resampled_with_the_reason_counted() {
    let Some(f) = Fixture::deck("envresample") else { return };
    let vocabulary = vec!["Left|Right".to_owned(), String::new(), "Fine words".to_owned()];
    let options = GenerateOptions {
        seed: 2,
        count: 8,
        inverse_share: 0.0,
        vocabulary: Some(vocabulary),
        kinds: Some(vec!["replace-text".to_owned()]),
        ..GenerateOptions::default()
    };
    let tasks = generate(&f, &options).await;
    assert!(!tasks.is_empty());
    for task in &tasks {
        assert_eq!(task.kind, "replace-text");
        assert_eq!(task.ground_truth["changed"][0]["edits"][0]["after"], "Fine words", "only an accepted edit is a task: {}", task.to_line());
    }
    let stats = kition_env::stats(&tasks);
    assert_eq!(stats["tasks"], json!(tasks.len()), "{stats}");
    assert_eq!(stats["kinds"]["replace-text"], json!(tasks.len()), "{stats}");
    assert!(stats["resampled"]["refused"].as_u64().is_some_and(|n| n > 0), "the kit refused `Left|Right`: {stats}");
    assert!(stats["resampled"]["new-error"].as_u64().is_some_and(|n| n > 0), "an empty shape is an error: {stats}");
}

#[tokio::test]
async fn tasks_spread_over_the_workspaces_files_by_relative_path() {
    let Some(f) = Fixture::new("envfiles", &[("b/two.envfiles", "1:1=Alpha#red|2=Beta#blue"), ("a.envfiles", common::DECK), ("notes.txt", "not a deck")])
    else {
        return;
    };
    let tasks = generate(&f, &options(1, 6, 0.0)).await;
    let files: BTreeSet<&str> = tasks.iter().map(|task| task.file.as_str()).collect();
    assert_eq!(files, BTreeSet::from(["a.envfiles", "b/two.envfiles"]), "{files:?}");
}

/// The generator and the scorer compare objects by the ids the tools answer: a kit whose ids
/// change each time the file is opened (the mock's notes: object ids made at random, no tool
/// ids) is refused at once, saying why, instead of failing every edit.
#[tokio::test]
async fn a_kit_whose_ids_do_not_survive_reopening_is_refused_saying_why() {
    let Some(f) = Fixture::with_env("envunstable", "", &[("a.envunstable", "Hello")]) else { return };
    let refused = kition_env::generate(&f.kit, f.workspace.path(), &options(1, 3, 0.0)).await;
    let error = refused.err().unwrap_or_else(|| panic!("generation was expected to be refused"));
    assert!(error.0.contains("a.envunstable") && error.0.contains("reopen") && error.0.contains("tool ids"), "{error}");
}

/// A kit whose object ids are minted again on every read, as a real slide kit's are, but whose
/// tasks and receipts name objects by tool ids (the mock's nested decks: slides and shapes with
/// tool ids, text bodies and paragraphs without, a root whose id is constant): the ids tasks use
/// survive a reopen, so it qualifies and gives tasks; objects without a tool id are skipped and
/// counted (regressions/issue-kit-env-tool-ids).
#[tokio::test]
async fn a_kit_that_mints_object_ids_but_keeps_tool_ids_gives_tasks() {
    let deck = "layout Title=big\nmedia logo=PNG1\n1@Title:1=Q3 revenue#red|2=Body#blue|3=Logo^logo\n2:4=Agenda|5=Same|6=Same#green\n3:";
    let Some(f) = Fixture::with_env("envminted", "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_DECK=nested", &[("deck.envminted", deck)]) else { return };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options(1, 12, 0.3)).await.unwrap_or_else(|error| panic!("{error}"));
    assert!(generated.tasks.len() >= 6, "tasks: {}, given up: {:?}", generated.tasks.len(), generated.given_up);
    assert!(generated.excluded.get("no-tool-id").is_some_and(|count| *count > 0), "{:?}", generated.excluded);
    for task in &generated.tasks {
        assert!(!task.instruction.contains("01"), "no object id in an instruction: {}", task.instruction);
    }
}

/// A value inside json that names an object with a tool id by its object id (a connector's
/// `look.kind.start`, as a real slide kit's connectors do) names it by its tool id in a snapshot,
/// so a file read again, whose object ids were minted anew, does not read as changed there: edits
/// are not discarded as `receipt-differs`.
#[tokio::test]
async fn ids_inside_json_values_survive_a_reopen() {
    let deck = "layout Title=big\n1@Title:1=Start#red|2=End#blue|6>1,2#red|3=Body#green\n2:4=Agenda#red|5=Notes#blue|7>4,5#green";
    let Some(f) = Fixture::with_env("envjsonids", "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_DECK=nested", &[("deck.envjsonids", deck)]) else { return };
    // Colours only: the mock's file cannot hold a connector whose shape was deleted or moved away.
    let options = GenerateOptions { kinds: Some(vec!["set-field".to_owned()]), ..options(1, 8, 0.0) };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}"));
    let differs: usize = generated.tasks.iter().flat_map(|task| task.resampled.iter()).filter(|resampled| resampled["reason"] == "receipt-differs").count();
    assert_eq!(differs, 0, "tasks: {}, given up: {:?}", generated.tasks.len(), generated.given_up);
    assert!(generated.tasks.len() >= 6, "tasks: {}, given up: {:?}", generated.tasks.len(), generated.given_up);
}

/// A kit whose tool ids are integers (clips `1`, `2` on tracks): a batch's receipt names them as
/// numbers, a change set computed from two reads as text; they are one form when compared, so no
/// edit is discarded as `receipt-differs`.
#[tokio::test]
async fn a_kit_with_integer_tool_ids_gives_tasks() {
    let timeline = "V1[label=\"Intro\"]:1=0+1@50|2=1+1|3=2+1{blur:5}\nV2[label=\"Music\"]:4=0+3";
    let Some(f) = Fixture::with_env("envints", "KITION_KIT_MOCK_PARTS=tracks", &[("cut.envints", timeline)]) else { return };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options(1, 8, 0.0)).await.unwrap_or_else(|error| panic!("{error}"));
    let differs: usize = generated.tasks.iter().flat_map(|task| task.resampled.iter()).filter(|resampled| resampled["reason"] == "receipt-differs").count();
    let given_up_differs = generated.given_up.iter().filter(|given| given.to_string().contains("receipt-differs")).count();
    assert_eq!((differs, given_up_differs), (0, 0), "tasks: {}, given up: {:?}", generated.tasks.len(), generated.given_up);
    assert!(generated.tasks.len() >= 4, "tasks: {}, given up: {:?}", generated.tasks.len(), generated.given_up);
}

/// d: a paragraph of a shape's text body has no tool id; its text is written
/// through the shape at a path (`{ op: "set", target: <shape>, field: "body.paragraphs.0.text" }`,
/// which batches now take), so set-field tasks edit it, named through the shape ("the text of the
/// 1st paragraph of the shape …"), and the oracle's solution replays it.
#[tokio::test]
async fn a_held_objects_field_is_edited_through_its_holder() {
    let deck = "1:1=Q3 revenue~Second line#red|2=Body~More#blue\n2:4=Agenda~Items|5=Same~Other#green";
    let Some(f) = Fixture::with_env("envheld", "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_DECK=nested", &[("deck.envheld", deck)]) else { return };
    let options = GenerateOptions { kinds: Some(vec!["set-field".to_owned()]), ..options(3, 16, 0.0) };
    let generated = kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}"));
    let held: Vec<&Task> = generated
        .tasks
        .iter()
        .filter(|task| task.solution.iter().any(|op| op["field"].as_str().is_some_and(|field| field.starts_with("body.paragraphs."))))
        .collect();
    assert!(!held.is_empty(), "tasks: {:?}, given up: {:?}", generated.tasks.iter().map(|task| &task.instruction).collect::<Vec<_>>(), generated.given_up);
    for task in &held {
        assert!(task.instruction.contains("of the 1st paragraph") || task.instruction.contains("of the 2nd paragraph"), "{}", task.instruction);
    }
}

#[tokio::test]
async fn tree_children_generate_delete_move_and_create_tasks() {
    let image = json!({ "name": "photo", "layers": [
        { "id": 1, "name": "bottom", "opacity": 100 },
        { "id": 2, "name": "group", "opacity": 100, "layers": [
            { "id": 3, "name": "a", "opacity": 100 }, { "id": 4, "name": "b", "opacity": 100 }
        ] }, { "id": 5, "name": "top", "opacity": 100 }
    ] })
    .to_string();
    let Some(f) = Fixture::with_env("envtrees", "KITION_KIT_MOCK_PARTS=stack", &[("image.envtrees", &image)]) else { return };
    for kind in ["delete", "move", "create"] {
        let options = GenerateOptions { kinds: Some(vec![kind.to_owned()]), ..options(17, 6, 0.0) };
        let generated = kition_env::generate(&f.kit, f.workspace.path(), &options).await.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(generated.tasks.len(), 6, "{kind}: {:?}", generated.given_up);
        assert!(generated.tasks.iter().all(|task| task.resampled.is_empty()), "{kind}: {:?}", generated.tasks);
    }
}

#[tokio::test]
async fn group_moves_with_consequential_addresses_are_one_replayed_task() {
    let image = json!({"name":"deck","layers":[
        {"id":1,"name":"Group","opacity":100,"address":{"container":"image"},"layers":[
            {"id":2,"name":"Child","opacity":100,"address":{"container":1},"layers":[
                {"id":3,"name":"Grandchild","opacity":100,"address":{"container":1}}]}]},
        {"id":4,"name":"Destination","opacity":100,"address":{"container":"image"}}
    ]})
    .to_string();
    let f = Fixture::with_env("envmoveaddresses", "KITION_KIT_MOCK_PARTS=stack KITION_KIT_MOCK_MOVE_ADDRESSES=1", &[("deck.envmoveaddresses", &image)])
        .expect("build mock");
    for inverse_share in [0.0, 1.0] {
        let generated =
            kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["move".into()]), ..options(17, 24, inverse_share) })
                .await
                .unwrap();
        let mut groups = 0;
        for task in generated.tasks {
            let moved = &task.ground_truth["moved"][0];
            if moved["id"] != "1" || moved["from"]["parent"] == moved["to"]["parent"] {
                continue;
            }
            groups += 1;
            assert_eq!(task.ground_truth["moved"].as_array().unwrap().len(), 1);
            assert_eq!(task.ground_truth["changed"].as_array().unwrap().len(), 3, "{}", task.to_line());
            assert!(task.instruction.to_lowercase().contains("move"), "{}", task.instruction);
            assert!(!task.solution.iter().any(|op| op["field"] == "address.container"), "{}", task.to_line());
            let mut oracle = kition_env::Oracle::new(&task, Default::default());
            assert!(kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap().verified());
        }
        assert!(groups > 0, "no group cross-container moves, inverse={inverse_share}: {:?}", generated.given_up);
    }
}

#[tokio::test]
async fn cascade_group_deletes_are_sampled_with_complete_replayed_receipts() {
    let image=json!({"name":"photo","layers":[{"id":1,"name":"group","opacity":100,"layers":[{"id":2,"name":"child","opacity":100,"layers":[{"id":3,"name":"grandchild","opacity":100}]}]},{"id":4,"name":"sibling","opacity":100}]}).to_string();
    let f =
        Fixture::with_env("envcascade", "KITION_KIT_MOCK_PARTS=stack KITION_KIT_MOCK_CASCADE=1", &[("image.envcascade", &image)]).expect("build mock first");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["delete".into()]), ..options(17, 12, 0.0) }).await.unwrap();
    let mut group = 0;
    for task in generated.tasks {
        if task.solution[0]["target"] == "1" || task.solution[0]["target"] == 1 {
            assert_eq!(task.ground_truth["deleted"].as_array().unwrap().len(), 3, "{:?}", task.ground_truth);
            assert!(task.resampled.is_empty(), "{:?}", task.resampled);
            let mut oracle = kition_env::Oracle::new(&task, kition_env::OracleOptions::default());
            let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
            assert!(trace.verified(), "{}", trace.to_line());
            group += 1;
        }
    }
    assert!(group > 0, "cascade group was never sampled: {:?}", generated.given_up);
}

#[tokio::test]
async fn numeric_sampling_stays_inside_declared_bounds_and_steps() {
    let image = json!({ "name": "photo", "layers": [{ "id": 1, "name": "top", "opacity": 100 }] }).to_string();
    let Some(f) = Fixture::with_env("envlimits", "KITION_KIT_MOCK_PARTS=stack", &[("image.envlimits", &image)]) else { return };
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["set-field".to_owned()]), ..options(9, 16, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 16, "{:?}", generated.given_up);
    for task in generated.tasks {
        let value = task.ground_truth["changed"][0]["edits"][0]["after"].as_f64().unwrap();
        assert!((0.0..=100.0).contains(&value) && value.fract() == 0.0, "{value}");
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
    }
}

#[tokio::test]
async fn json_member_sampling_uses_the_members_limits() {
    let image = json!({"name":"photo","layers":[{"id":1,"name":"top","opacity":100,"data":{"roughness":1}}]}).to_string();
    let f = Fixture::with_env("envjsonlimits", "KITION_KIT_MOCK_PARTS=stack", &[("image.envjsonlimits", &image)]).expect("build mock first");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["set-field".into()]), ..options(9, 16, 0.0) }).await.unwrap();
    let mut json_edits = 0;
    for task in generated.tasks {
        for edit in task.ground_truth["changed"][0]["edits"].as_array().unwrap() {
            if edit["field"] == "data.roughness" {
                let value = edit["after"].as_f64().unwrap();
                assert!((0.0..=1.0).contains(&value) && (value * 10.0 - (value * 10.0).round()).abs() < 1e-9);
                json_edits += 1;
            }
        }
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
    }
    assert!(json_edits > 0, "JSON members must be sampled");
}

#[tokio::test]
async fn nested_json_member_sampling_obeys_array_and_nested_limits() {
    let image =
        json!({"name":"photo","layers":[{"id":1,"name":"top","opacity":100,"data":{"motion":{"shutter":1},"weights":[1,1,1],"layers":[{"opacity":1}]}}]})
            .to_string();
    let f = Fixture::with_env("envnestedlimits", "KITION_KIT_MOCK_PARTS=stack KITION_KIT_MOCK_NESTED_LIMITS=1", &[("image.envnestedlimits", &image)])
        .expect("build mock first");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["set-field".into()]), ..options(9, 32, 0.0) }).await.unwrap();
    let mut paths = std::collections::BTreeSet::new();
    for task in generated.tasks {
        for edit in task.ground_truth["changed"][0]["edits"].as_array().unwrap() {
            let path = edit["field"].as_str().unwrap();
            if path.starts_with("data.") {
                let value = edit["after"].as_f64().unwrap();
                assert!((0.0..=1.0).contains(&value));
                assert!((value * 10.0 - (value * 10.0).round()).abs() < 1e-9);
                paths.insert(path.to_owned());
            }
        }
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
    }
    assert!(paths.contains("data.motion.shutter"), "{paths:?}");
    assert!(paths.iter().any(|p| p.starts_with("data.weights.")), "{paths:?}");
    assert!(paths.contains("data.layers.0.opacity"), "{paths:?}");
}

#[tokio::test]
async fn incomplete_instruction_side_effect_on_sample_false_is_discarded() {
    let image =
        json!({"name":"photo","layers":[{"id":1,"name":"one","opacity":100,"fillOpacity":1},{"id":2,"name":"two","opacity":100,"fillOpacity":1}]}).to_string();
    let f = Fixture::with_env("envincomplete", "KITION_KIT_MOCK_PARTS=stack KITION_KIT_MOCK_DELETE_SIDE_EFFECT=1", &[("image.envincomplete", &image)])
        .expect("build mock first");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["delete".into()]), ..options(1, 1, 0.0) }).await.unwrap();
    assert!(generated.tasks.is_empty(), "instructions omit the deletion: {:?}", generated.tasks);
    assert!(generated.given_up[0]["resampled"].as_array().unwrap().iter().all(|entry| entry["reason"] == "instruction-incomplete"), "{:?}", generated.given_up);
}

#[tokio::test]
async fn create_replays_container_fields_and_skips_derived_values() {
    let image =
        json!({"name":"photo","layers":[{"id":1,"name":"one","opacity":100,"look":{"fill":"ink"},"caption":[{"insert":"Hi","attributes":{"bold":true}}]}]})
            .to_string();
    let f = Fixture::with_env("envcontainers", "KITION_KIT_MOCK_PARTS=stack KITION_KIT_MOCK_CONTAINERS=1", &[("image.envcontainers", &image)])
        .expect("build mock first");
    let generated =
        kition_env::generate(&f.kit, f.workspace.path(), &GenerateOptions { kinds: Some(vec!["create".into()]), ..options(1, 3, 0.0) }).await.unwrap();
    assert_eq!(generated.tasks.len(), 3, "{:?}", generated.given_up);
    for task in generated.tasks {
        assert!(task.resampled.is_empty(), "{:?}", task.resampled);
        for op in &task.solution {
            if op["op"] == "create" {
                assert!(op["fields"].get("look").is_none() && op["fields"].get("caption").is_none() && op["fields"].get("~nameLength").is_none());
            }
        }
        assert!(task.solution.iter().any(|op| op["op"] == "text.mark"));
        assert!(task.solution.iter().any(|op| op["op"] == "map.set"));
        assert!(task.instruction.contains("bold"), "formatting must be described: {}", task.instruction);
        let trace =
            kition_env::trace(&f.kit, f.workspace.path(), &task, &mut kition_env::Oracle::new(&task, kition_env::OracleOptions::default())).await.unwrap();
        assert_eq!(trace.reward.reward, 1.0, "creation must score from the saved file");
        let mut unmarked = task.ground_truth.clone();
        unmarked["created"][0]["values"]["caption"][0].as_object_mut().unwrap().remove("attributes");
        assert!(kition_env::score_changes(&task, &unmarked, &[], &Default::default()).reward < 1.0, "missing formatting must not receive full reward");
    }
}
