//! A native mock whose successful close destroys the model.
use super::*;
use kition_kit::session::model::ReplicaPort;

struct Closing(Option<notes::NotesDocument>);

impl KitDocument for Closing {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> {
        Ok(Self(Some(notes::NotesDocument::open(name, bytes)?)))
    }
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        Ok(Self(Some(notes::NotesDocument::create(name, width, height)?)))
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
    fn render(&self, _: f64, _: f64, _: f64, _: u32, _: u32) -> Result<Vec<u8>, String> {
        Ok(vec![])
    }
    fn render_area(&self, _: i32, _: i32, _: i32, _: i32, _: u32, _: u32) -> Result<Vec<u8>, String> {
        Ok(vec![])
    }
    fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
        assert!(self.0.is_some(), "command after close");
        match command {
            "close" => {
                self.0 = None;
                Ok(json!({"closed":true}))
            }
            "close.fail" => Err("close failed".into()),
            _ => Ok(json!({"closed":false})),
        }
    }
    fn editor_state(&self) -> Value {
        assert!(self.0.is_some(), "state after close");
        Value::Null
    }
    fn inspect(&self) -> Result<Value, String> {
        self.0.as_ref().ok_or("closed")?.inspect()
    }
    fn commands(&self) -> Vec<KitCommand> {
        vec![]
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        self.0.as_ref().ok_or("closed")?.save(name)
    }
    fn mark_saved(&mut self) {}
}

impl ReplicaPort for Closing {
    fn model_schema(&self) -> std::sync::Arc<kition_kit::kdm::Schema> {
        self.0.as_ref().expect("schema after close").model_schema()
    }
    fn model_export(&mut self, since: &[u8]) -> Result<Vec<u8>, String> {
        self.0.as_mut().ok_or("model after close")?.model_export(since)
    }
    fn model_import(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.as_mut().ok_or("model after close")?.model_import(bytes)
    }
    fn model_command(&mut self, command: &str, params: Value, _: &kition_kit::kdm::Origin) -> Result<Value, String> {
        self.execute(command, params)
    }
    fn model_commands(&self) -> Vec<KitCommand> {
        vec![]
    }
    fn model_open_replica(name: &str, snapshot: &[u8], blobs: &[u8]) -> Result<Self, String> {
        Ok(Self(Some(notes::NotesDocument::model_open_replica(name, snapshot, blobs)?)))
    }
}

#[test]
fn terminal_premise_plans_skip_closed_state_and_release_scratch() {
    let root = workspace("terminal-plan");
    std::fs::write(root.join("close.notes"), b"").unwrap();
    let mut kit = Headless::<Closing>::with_replica_port(notes_kit());
    let folder = serve(&mut kit, &root);
    let info = open(&mut kit, &folder, "close.notes");
    let params = |value: Value| value.as_object().unwrap().clone();
    for advance in [false, true] {
        let first = kit.context_plan(&info.id, &params(json!({"action":"begin","steps":[{"command":"close.cancel"},{"command":"before"}]}))).unwrap();
        assert_ne!(first["closed"], true, "{first}");
        if !advance {
            kit.context_plan(&info.id, &params(json!({"action":"end","token":first["token"]}))).unwrap();
        }
        let result = kit
            .context_plan(
                &info.id,
                &params(json!({"action":if advance {"advance"} else {"begin"},"token":first["token"],"steps":[{"command":"close"},{"command":"later"}]})),
            )
            .unwrap();
        assert_eq!(result, json!({"closed":true}));
        assert!(kit.plans.is_empty());
        assert!(kit.docs[0].doc.0.is_some(), "the live model must survive the scratch close");
    }
    let error = kit.context_plan(&info.id, &params(json!({"action":"begin","steps":[{"command":"close.fail"},{"command":"later"}]}))).unwrap_err();
    assert!(error.message.contains("close failed"), "{error:?}");
    assert!(kit.plans.is_empty());
    assert!(kit.docs[0].doc.0.is_some());
}
