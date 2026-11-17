//! What the mock kit's decks add for the environment: a shape's text or colour holding `|`,
//! `#` or a line break (the separators of the deck's file) is refused, by a batch and by the
//! deck's commands, and leaves the file as it was; a shape without text is an error diagnostic of
//! `document.check`, which goes when it has text again.
//!
//! Cases: `sdk.agent.kit-env/mock-deck`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

mod common;

use common::Fixture;
use kition_kits::{KitManager, tools};
use serde_json::{Value, json};

async fn call(kits: &KitManager, f: &Fixture, action: &str, mut input: Value) -> Result<Value, Value> {
    input["path"] = json!(f.file());
    match tools::call(kits, &f.tool(action), &input).await {
        Some(Ok(output)) => Ok(output.output),
        Some(Err(error)) => Err(error.structured()),
        None => panic!("{action} is not a kit tool"),
    }
}

fn manager(f: &Fixture) -> KitManager {
    KitManager::new(Some(f.workspace.path().to_path_buf()), vec![(f.kit.definition, f.kit.executable.clone())])
}

#[tokio::test]
async fn a_text_holding_the_files_separators_is_refused() {
    let Some(f) = Fixture::deck("envmockrefuse") else { return };
    let kits = manager(&f);
    for (field, value) in [("text", "Left|Right"), ("text", "Sharp#"), ("text", "Two\nlines"), ("color", "re|d")] {
        let refused = call(&kits, &f, "batch", json!({ "ops": [{ "op": "set", "target": "shape:2", "field": field, "value": value }] })).await;
        let error = refused.err().unwrap_or_else(|| panic!("{field} = {value:?} was expected to be refused"));
        assert!(error["error"]["message"].as_str().is_some_and(|message| message.contains("separat")), "{error}");
    }
    let command = call(&kits, &f, "run", json!({ "steps": [{ "command": "shape.text", "params": { "id": "shape:2", "text": "A|B" } }] })).await;
    assert!(command.is_err(), "the command refuses it too");
    assert_eq!(f.read(&f.file()), common::DECK.as_bytes(), "nothing was written");
    let accepted = call(&kits, &f, "batch", json!({ "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "Plain words" }] })).await;
    assert!(accepted.is_ok(), "{accepted:?}");
    kits.shutdown().await;
}

#[tokio::test]
async fn a_shape_without_text_is_an_error_diagnostic() {
    let Some(f) = Fixture::deck("envmockcheck") else { return };
    let kits = manager(&f);
    assert_eq!(call(&kits, &f, "check", json!({})).await.ok(), Some(json!({ "diagnostics": [] })));
    let emptied = call(&kits, &f, "batch", json!({ "ops": [{ "op": "set", "target": "shape:3", "field": "text", "value": "" }] })).await;
    let emptied = emptied.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(emptied["diagnostics"]["new"][0]["code"], "mock.empty-shape", "{emptied}");
    let checked = call(&kits, &f, "check", json!({})).await.unwrap_or_else(|error| panic!("{error}"));
    let diagnostics = checked["diagnostics"].as_array().cloned().unwrap_or_default();
    assert_eq!(diagnostics.len(), 1, "{checked}");
    assert_eq!((&diagnostics[0]["severity"], &diagnostics[0]["target"]), (&json!("error"), &json!({ "id": "shape:3" })), "{checked}");
    let filled = call(&kits, &f, "batch", json!({ "ops": [{ "op": "set", "target": "shape:3", "field": "text", "value": "Back" }] })).await;
    assert_eq!(filled.unwrap_or_else(|error| panic!("{error}"))["diagnostics"]["resolved"][0]["code"], "mock.empty-shape");
    kits.shutdown().await;
}
