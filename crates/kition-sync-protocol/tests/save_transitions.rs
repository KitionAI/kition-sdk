//! The save state machine against the shared transitions (`save-transitions.json`), which
//! `@kition/sync`'s `saveTransition` is held to too.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kition_sync_protocol::save::{SaveEvent, SaveRefusal, SaveState, transition};
use serde_json::Value;

#[test]
fn follows_the_shared_transitions() {
    let table: Value = serde_json::from_str(include_str!("save-transitions.json")).unwrap();
    for scenario in table["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let mut state = SaveState::new(Some("v1".into()));
        for (index, step) in scenario["events"].as_array().unwrap().iter().enumerate() {
            let event: SaveEvent = serde_json::from_value(step["event"].clone()).unwrap_or_else(|error| panic!("{name} {index}: {error}"));
            let refused: Option<SaveRefusal> = step.get("refused").map(|value| serde_json::from_value(value.clone()).unwrap());
            let result = transition(&state, &event);
            assert_eq!(result.as_ref().err().copied(), refused, "{name}, event {index}");
            if let Ok(next) = result {
                state = next;
            }
            if let Some(expected) = step.get("state").and_then(Value::as_object) {
                let actual = serde_json::to_value(&state).unwrap();
                for (key, value) in expected {
                    assert_eq!(&actual[key], value, "{name}, event {index}, field {key}");
                }
            }
        }
    }
}
