//! The editor-state hooks as the page calls them (C3b): `editorState()`, `restoreEditorState(state)`
//! and `setContext(context)` on the class `export_kit_document!` makes, JSON text in and out, so
//! an editor runs an agent's step in an editor state of the agent's own, as the headless host
//! does through `context.get`, `context.restore` and `context.set`.

use kition_kit::{__editor_state, __restore_editor_state, __set_context, CallContext, KitCommand, KitDocument};
use serde_json::{Value, json};

/// A deck with a current slide and a selection, its editor state.
#[derive(Default)]
struct Deck {
    slide: u64,
    selection: Vec<Value>,
    time: Option<f64>,
}

impl KitDocument for Deck {
    fn open(_: &str, _: &[u8]) -> Result<Self, String> {
        Ok(Self::default())
    }
    fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
        Ok(Self::default())
    }
    fn width(&self) -> u32 {
        1
    }
    fn height(&self) -> u32 {
        1
    }
    fn revision(&self) -> u64 {
        0
    }
    fn dirty(&self) -> bool {
        false
    }
    fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
        Err(format!("unknown command {command}"))
    }
    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({ "canUndo": false, "canRedo": false }))
    }
    fn commands(&self) -> Vec<KitCommand> {
        Vec::new()
    }
    fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    fn mark_saved(&mut self) {}
    fn editor_state(&self) -> Value {
        json!({ "slide": self.slide, "selection": self.selection })
    }
    fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
        self.slide = saved["slide"].as_u64().ok_or("not a saved state")?;
        self.selection = saved["selection"].as_array().cloned().unwrap_or_default();
        Ok(())
    }
    fn set_context(&mut self, context: &CallContext) -> Result<(), String> {
        if let Some(part) = &context.part {
            self.slide = part["slide"].as_u64().ok_or("no such slide")?;
        }
        if !context.on.is_empty() {
            self.selection = context.on.clone();
        }
        self.time = context.time;
        Ok(())
    }
    fn under(&self, command: &str, _: &Value) -> Result<Option<kition_kit::Under>, String> {
        if command == "none" {
            return Ok(None);
        }
        Ok(Some(kition_kit::Under { objects: self.selection.clone(), ..Default::default() }))
    }
    fn content_at(&self, ask: &kition_kit::ContentAsk, history: &dyn kition_kit::HistoricalBlobs) -> Result<Option<bool>, String> {
        if ask.premise.field == "blob" {
            return Ok(history.read("hash", 0, 1).ok().map(|bytes| bytes != [1]));
        }
        Ok(Some(ask.before != json!("basis")))
    }
}

#[test]
fn the_page_reads_puts_back_and_sets_the_editor_state_as_json_text() {
    let mut deck = Deck { slide: 1, selection: vec![json!("p")], time: None };
    let person = __editor_state(&deck);
    assert_eq!(serde_json::from_str::<Value>(&person).ok(), Some(json!({ "slide": 1, "selection": ["p"] })));
    __set_context(&mut deck, r#"{"part":{"slide":2},"on":["s2"],"time":1.5}"#).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!((deck.slide, deck.selection.clone(), deck.time), (2, vec![json!("s2")], Some(1.5)));
    __restore_editor_state(&mut deck, &person).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!((deck.slide, deck.selection.clone()), (1, vec![json!("p")]));
}

#[test]
fn text_that_is_not_a_state_or_a_context_is_refused_and_the_kit_s_refusal_kept() {
    let mut deck = Deck::default();
    assert!(__restore_editor_state(&mut deck, "{").is_err_and(|error| error.contains("not JSON")));
    assert!(__set_context(&mut deck, r#"{"time":"soon"}"#).is_err_and(|error| error.contains("call context")));
    assert_eq!(__set_context(&mut deck, r#"{"part":{"page":2}}"#), Err("no such slide".to_owned()));
}

#[test]
fn the_editor_premise_export_dispatches_existing_kit_callbacks_and_fails_closed_without_blob_history() {
    let deck = Deck { slide: 2, selection: vec![json!("s2")], time: None };
    let read = |method, params| kition_kit::premise::read(&deck, method, &params).unwrap();
    assert_eq!(read("under", json!({"command":"write","params":{}}))["objects"], json!(["s2"]));
    assert_eq!(read("under", json!({"command":"none","params":{}})), Value::Null);
    assert_eq!(read("content", json!({"id":"s2","field":"text","region":null,"before":"basis"})), json!({"changed":false}));
    assert_eq!(read("content", json!({"id":"s2","field":"text","region":null,"before":"different"})), json!({"changed":true}));
    assert_eq!(read("content", json!({"id":"s2","field":"blob","region":null,"before":{}})), json!({"changed":null}));
    assert_eq!(read("identity", json!({"objects":["s2"]})), json!({"unproven":[]}));
    assert_eq!(read("inputs", json!({})), json!({"inputs":[]}));
    assert_eq!(read("derived", json!({})), json!({"objects":[]}));
    assert!(kition_kit::premise::read(&deck, "write", &json!({})).is_err());
    assert_eq!(deck.selection, vec![json!("s2")]);
}

#[test]
fn editor_content_reads_only_the_supplied_basis_blob_bytes() {
    let deck = Deck::default();
    let ask = json!({"id":"s2","field":"blob","region":null,"before":{},"history":{"hash":[1]}});
    assert_eq!(kition_kit::premise::read(&deck, "content", &ask).unwrap(), json!({"changed":false}));
    let mut changed = ask.clone();
    changed["history"]["hash"] = json!([2]);
    assert_eq!(kition_kit::premise::read(&deck, "content", &changed).unwrap(), json!({"changed":true}));
    changed["history"] = json!({"other":[1]});
    assert_eq!(kition_kit::premise::read(&deck, "content", &changed).unwrap(), json!({"changed":null}));
}
