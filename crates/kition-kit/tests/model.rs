// The object model over a contract 2 document: directly on a `KitSession`, and through an
// `Exchange` over the engine's change exchange.

use std::collections::BTreeSet;
use std::sync::Arc;

use kition_kit::kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx, UndoScope, Version};
use kition_kit::session::model::{self, Exchange, ModelErrorCode, ReplicaPort};
use kition_kit::session::{BlobSink, BlobSource, Damage, KitError, KitModel, KitSession, KitSessionDocument, MemoryBlobs};
use kition_kit::{KitCommand, KitDocument};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.notes", "schemaVersion": 1, "root": "Board",
  "types": {
    "Board": { "fields": { "title": { "kind": "string" }, "notes": { "kind": "list", "of": "Note" } } },
    "Note": { "fields": { "body": { "kind": "text" }, "done": { "kind": "boolean", "optional": true }, "opacity": { "kind": "number", "optional": true } } }
  }
}"#;

/// The one board title the kit refuses to repair (see [`Notes::validate`]).
pub const UNREPAIRABLE: &str = "unrepairable";

/// The view: the notes' bodies in order.
#[derive(Debug, PartialEq)]
pub struct Notes(Vec<String>);

fn board(replica: &Replica) -> ObjectId {
    replica.objects_of_type("Board").into_iter().next().unwrap_or_default()
}

impl KitModel for Notes {
    fn schema() -> Arc<Schema> {
        Arc::new(Schema::parse(SCHEMA).unwrap())
    }

    fn load(replica: &Replica, _blobs: &dyn BlobSource) -> Result<Self, KitError> {
        let mut bodies = Vec::new();
        for id in replica.list(&board(replica), "notes")? {
            if replica.exists(&id) {
                bodies.push(replica.text(&id, "body")?);
            }
        }
        Ok(Self(bodies))
    }

    fn apply(&mut self, replica: &Replica, _changed: &BTreeSet<ObjectId>, blobs: &dyn BlobSource) -> Result<Damage, KitError> {
        *self = Self::load(replica, blobs)?;
        Ok(Damage::Full)
    }

    /// Nothing needs repair, but a board titled exactly [`UNREPAIRABLE`] cannot be repaired: the
    /// import that brings that title fails (a server validating changes refuses it).
    fn validate(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> Result<bool, KitError> {
        for id in changed {
            if tx.exists(id) && tx.object_type(id)? == "Board" && tx.get(id, "title")? == json!(UNREPAIRABLE) {
                return Err(KitError::new("a board cannot be called that"));
            }
        }
        Ok(false)
    }

    fn import(_name: &str, _bytes: &[u8], _blobs: &mut dyn BlobSink, actor: ActorId) -> Result<Replica, KitError> {
        let (replica, ()) = Replica::create_with(Self::schema(), DocId::new(), actor, &Origin::system("import"), |tx| {
            tx.create("Board", Map::from_iter([("title".to_owned(), json!("Ideas"))]))?;
            Ok(())
        })?;
        Ok(replica)
    }

    fn export(&self, _replica: &Replica, _name: &str, _blobs: &dyn BlobSource) -> Result<Vec<u8>, KitError> {
        Ok(self.0.join("\n").into_bytes())
    }
}

pub struct NotesDocument(KitSession<Notes>, Vec<String>, Value);

#[test]
fn reread_keeps_agent_history_and_outside_register_values() {
    let mut document = open();
    let root = board(document.0.replica());
    document.0.execute(&Origin::agent("agent"), |_, tx| Ok(tx.set(&root, "title", json!("Mine"))?)).unwrap();
    document
        .0
        .reread(|_, tx| {
            let note = tx.create("Note", Map::new())?;
            tx.text_insert(&note, "body", 0, "Outside")?;
            tx.list_insert(&root, "notes", 0, &note)?;
            Ok(())
        })
        .unwrap();
    assert!(document.0.undo_in(UndoScope::Agent).unwrap().0);
    assert_eq!(document.0.replica().get(&root, "title").unwrap(), "Ideas");
    assert_eq!(document.0.model().0, vec!["Outside"]);
    document.0.redo_in(UndoScope::Agent).unwrap();
    document.0.reread(|_, tx| Ok(tx.set(&root, "title", json!("Outside wins"))?)).unwrap();
    assert!(document.0.undo_in(UndoScope::Agent).unwrap().0);
    assert_eq!(document.0.replica().get(&root, "title").unwrap(), "Outside wins");
}

fn open() -> NotesDocument {
    NotesDocument(KitSession::import("ideas.notes", b"", Box::new(MemoryBlobs::default()), ActorId::from_u64(1).unwrap()).unwrap(), Vec::new(), Value::Null)
}

impl KitDocument for NotesDocument {
    fn projected_objects(&self) -> Result<Vec<kition_kit::kdm::projection::ProjectedObject>, String> {
        let replica = self.0.replica();
        if !replica.schema().types.contains_key("Line") {
            return Ok(vec![]);
        }
        Ok(vec![serde_json::from_value(json!({"id":"projected-title","type":"Line","fields":{"text":replica.get(&board(replica),"title").unwrap()},"at":{"parent":board(replica).to_string(),"field":"lines","index":0}})).unwrap()])
    }
    fn editor_state(&self) -> Value {
        self.2.clone()
    }
    fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
        self.2 = saved.clone();
        Ok(())
    }
    fn set_context(&mut self, context: &kition_kit::CallContext) -> Result<(), String> {
        self.2 = serde_json::to_value(context).unwrap();
        if context.time == Some(-1.0) { Err("context unavailable".into()) } else { Ok(()) }
    }
    fn value_limits(&self) -> Option<kition_kit::ValueLimits> {
        Some(Box::new(|object, path| {
            (object["type"] == "Note" && path == "opacity")
                .then(|| serde_json::from_value(json!({"nullable":true,"minimum":0,"maximum":if object["fields"]["done"]==true {1} else {100}})).unwrap())
        }))
    }
    fn batch_applied(&mut self) {
        self.1 = self.0.model().0.clone();
    }
    fn batch_settler(&self) -> Option<kition_kit::BatchSettler> {
        Some(Box::new(|tx| {
            for id in tx.objects_of_type("Note") {
                if let Some(value) = tx.get(&id, "opacity").map_err(|error| error.to_string())?.as_f64() {
                    tx.set(&id, "opacity", json!((value * 255.0).round() / 255.0)).map_err(|error| error.to_string())?;
                }
            }
            Ok(())
        }))
    }
    fn open(_name: &str, _bytes: &[u8]) -> Result<Self, String> {
        Ok(open())
    }
    fn create(_name: &str, _width: u32, _height: u32) -> Result<Self, String> {
        Ok(open())
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
    fn render(&self, _x: f64, _y: f64, _scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn render_area(&self, _x0: i32, _y0: i32, _x1: i32, _y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.execute_as(command, params, &Origin::person("person:local"))
    }
    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({ "canUndo": self.0.can_undo(), "canRedo": self.0.can_redo(), "notes": self.0.model().0 }))
    }
    fn commands(&self) -> Vec<KitCommand> {
        vec![KitCommand { id: "note.clear".into(), title: "Clear notes".into(), mutates: true, enabled: true, ..Default::default() }]
    }
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String> {
        Ok(self.0.export(name.unwrap_or("ideas.notes"))?)
    }
    fn mark_saved(&mut self) {}
}

#[test]
fn conditional_limits_validate_live_metadata_and_reach_loads() {
    let mut doc = open();
    let created = model::session_batch(&mut doc, &json!({"ops":[{"op":"create","type":"Note","id":"n","fields":{"opacity":2}}]}), false).unwrap();
    assert!(created.is_object());
    let before = doc.0.replica().state_hash().unwrap();
    let error = model::session_batch(&mut doc, &json!({"ops":[{"op":"set","target":"n","field":"done","value":true}]}), false).unwrap_err();
    assert_eq!(error.code, ModelErrorCode::InvalidValue);
    assert_eq!(doc.0.replica().state_hash().unwrap(), before);
    model::session_batch(
        &mut doc,
        &json!({"ops":[{"op":"set","target":"n","field":"opacity","value":0.5},{"op":"set","target":"n","field":"done","value":true}]}),
        false,
    )
    .unwrap();
    let loaded = model::session_batch(&mut doc, &json!({"load":[{"target":"n"}]}), false).unwrap();
    assert_eq!(loaded["loaded"][0]["limits"]["opacity"]["maximum"], 1);
}

impl KitSessionDocument for NotesDocument {
    type Model = Notes;

    fn session(&self) -> &KitSession<Notes> {
        &self.0
    }

    fn session_mut(&mut self) -> &mut KitSession<Notes> {
        &mut self.0
    }

    /// `note.clear {except?: id}`: deletes every note but `except`.
    fn execute_as(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        if command == "board.new" {
            if params["named"] == true {
                let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
                schema["types"]["Board"]["fields"]["key"] = json!({"kind":"string","readOnly":true});
                schema["types"]["Board"]["toolId"] = json!({"field":"key","prefix":"board:"});
                let (replica, _) = Replica::create_with(Arc::new(Schema::parse(&schema.to_string()).unwrap()), DocId::new(), ActorId::random(), origin, |tx| {
                    tx.create("Board", json!({"key":"replacement","title":"Ideas"}).as_object().unwrap().clone())
                })
                .unwrap();
                self.0 = KitSession::from_replica(replica, Box::new(MemoryBlobs::default())).unwrap();
                return Ok(json!({"created":true}));
            }
            *self = open();
            return Ok(json!({"created":true}));
        }
        if command == "projection.rename" {
            self.0
                .execute(origin, |_, tx| {
                    let root = tx.objects_of_type("Board").into_iter().next().ok_or("no board")?;
                    tx.set(&root, "title", params["text"].clone())?;
                    Ok(())
                })
                .map_err(|error| error.to_string())?;
            return Ok(json!({"id":"projected-title"}));
        }
        if command == "context.echo" {
            return if params["fail"] == true { Err("command failed".into()) } else { Ok(self.2.clone()) };
        }
        if command != "note.clear" {
            return Err(format!("unknown command `{command}`"));
        }
        let keep = params["except"].as_str().map(ObjectId::from_string);
        let (removed, _) = self.0.execute(origin, |_, tx| {
            let owner = tx.objects_of_type("Board").into_iter().next().ok_or("no board")?;
            let mut removed = 0;
            for (index, id) in tx.list_items(&owner, "notes")?.into_iter().enumerate().rev() {
                if Some(&id) != keep.as_ref() {
                    tx.list_remove(&owner, "notes", index)?;
                    tx.delete(&id)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })?;
        Ok(json!({ "removed": removed }))
    }
}

impl ReplicaPort for NotesDocument {
    fn model_schema(&self) -> Arc<Schema> {
        Arc::new(self.0.replica().schema().clone())
    }
    fn model_export(&mut self, since: &[u8]) -> Result<Vec<u8>, String> {
        let since = if since.is_empty() { Version::empty() } else { Version::decode(since).map_err(|error| error.to_string())? };
        Ok(self.0.export_changes(&since)?)
    }
    fn model_import(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.import_changes(bytes).map(|_| ()).map_err(String::from)
    }
    fn model_command(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        KitSessionDocument::execute_as(self, command, params, origin)
    }
    fn model_commands(&self) -> Vec<KitCommand> {
        KitDocument::commands(self)
    }
    fn model_open_replica(_name: &str, snapshot: &[u8], _blobs: &[u8]) -> Result<Self, String> {
        Ok(Self(KitSession::open_snapshot(snapshot, Box::new(MemoryBlobs::default()), ActorId::random())?, Vec::new(), Value::Null))
    }
}

#[test]
fn both_model_adapters_read_and_edit_computed_objects_without_storing_them() {
    for exchange in [false, true] {
        let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
        schema["types"]["Board"]["fields"]["lines"] = json!({"kind":"list","of":"Line"});
        schema["types"]["Line"] =
            json!({"projected":true,"fields":{"text":{"kind":"string"}},"projectedOps":{"set.text":{"command":"projection.rename","params":{"text":"value"}}}});
        let mut replica = Replica::create(Arc::new(Schema::parse(&schema.to_string()).unwrap()), DocId::new(), ActorId::random()).unwrap();
        replica.transact(&Origin::system("test"), |tx| tx.create("Board", json!({"title":"Before"}).as_object().unwrap().clone()).map(|_| ())).unwrap();
        let mut document = NotesDocument(KitSession::from_replica(replica, Box::new(MemoryBlobs::default())).unwrap(), vec![], Value::Null);
        let request = json!({"ops":[{"op":"set","target":"projected-title","field":"text","value":"After"}],"objects":true,"load":[{"target":"root"},{"target":"projected-title"}]});
        let answer =
            if exchange { Exchange::new().batch(&mut document, &request, false) } else { model::session_batch(&mut document, &request, false) }.unwrap();
        assert_eq!(answer["loaded"][0]["fields"]["lines"], json!(["projected-title"]));
        assert_eq!(answer["loaded"][1]["fields"]["text"], "After");
        assert!(document.0.replica().objects_of_type("Line").is_empty());
        assert_eq!(kition_kit::premise::read(&document, "projected", &json!({})).unwrap()[0]["fields"]["text"], "After");
    }
}

#[test]
fn batch_command_context_is_applied_and_restored_by_both_adapters() {
    for exchange in [false, true] {
        for failure in ["none", "command", "context"] {
            let mut document = open();
            let saved = json!({"time":9,"on":["person"]});
            document.2 = saved.clone();
            let time = if failure == "context" { -1.0 } else { 2.5 };
            let request = json!({"ops":[{"op":"command","id":"context.echo","params":{"fail":failure=="command"},"on":["agent"],"at":{"part":{"track":"V1"},"time":time}}]});
            let answer = if exchange { Exchange::new().batch(&mut document, &request, false) } else { model::session_batch(&mut document, &request, false) };
            if failure == "none" {
                assert_eq!(answer.unwrap()["results"][0], json!({"on":["agent"],"part":{"track":"V1"},"time":2.5}));
            } else {
                assert_eq!(answer.unwrap_err().code, ModelErrorCode::CommandFailed);
            }
            assert_eq!(document.editor_state(), saved, "exchange={exchange}, failure={failure}");
        }
    }
}

pub fn add_notes() -> Value {
    json!({ "origin": { "kind": "agent", "principal": "agent:test" }, "ops": [
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$a" },
        { "op": "text.insert", "target": "$a", "field": "body", "index": 0, "text": "first" },
        { "op": "create", "type": "Note", "in": "root.notes", "ref": "$b" },
        { "op": "text.set", "target": "$b", "field": "body", "text": "second" },
        { "op": "command", "id": "note.clear", "params": { "except": "$b" } },
        { "op": "set", "target": "$b", "field": "done", "value": true },
    ], "load": [{ "target": "root" }, { "target": "$b", "fields": ["body", "done"] }] })
}

#[test]
fn a_session_batch_edits_the_view_and_undoes_as_one_step() {
    let mut document = open();
    let answer = model::session_batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!(answer["results"][4], json!({ "removed": 1 }));
    assert_eq!(answer["loaded"][0]["fields"]["title"], "Ideas");
    assert_eq!(answer["loaded"][1]["fields"], json!({ "body": "second", "done": true }));
    assert_eq!(document.0.model().0, vec!["second".to_owned()]);
    // The batch ran as the agent: the person's undo does not take it back (KitModel M12a).
    assert!(!document.0.can_undo());
    assert!(document.0.undo_in(UndoScope::Agent).unwrap().0);
    assert!(document.0.model().0.is_empty(), "the whole batch is one undo step");
    assert!(!document.0.can_undo_in(UndoScope::Agent));
}

/// A kit that keeps an undo label of its own per step keeps as many as the session's
/// `undo_depth`: a batch, the commands in it included, is one step.
#[test]
fn a_session_batch_is_one_step_of_the_undo_depth() {
    let mut document = open();
    assert_eq!(document.0.undo_depth(UndoScope::Agent), 0);
    model::session_batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!((document.0.undo_depth(UndoScope::Agent), document.0.undo_depth(UndoScope::Person)), (1, 0));
    assert!(!document.0.in_undo_group());
    model::session_batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!(document.0.undo_depth(UndoScope::Agent), 2);
    assert!(document.0.undo_in(UndoScope::Agent).unwrap().0);
    assert_eq!((document.0.undo_depth(UndoScope::Agent), document.0.redo_depth(UndoScope::Agent)), (1, 1));
}

#[test]
fn a_session_batch_refuses_writes_when_read_only_and_describes_commands() {
    let mut document = open();
    let error = model::session_batch(&mut document, &add_notes(), true).unwrap_err();
    assert_eq!(error.code, ModelErrorCode::ReadOnly);
    let described = model::session_describe(&document);
    assert_eq!(described["kit"], "kit.notes");
    assert_eq!(described["commands"][0]["id"], "note.clear");
    assert_eq!(described["types"]["Note"]["fields"]["body"], json!({ "kind": "text" }));
}

#[test]
fn direct_and_exchange_batches_refresh_the_kits_cached_state() {
    for direct in [true, false] {
        let mut document = open();
        let request =
            json!({"ops":[{"op":"create","type":"Note","in":"root.notes","ref":"$n"},{"op":"text.set","target":"$n","field":"body","text":"cached"}]});
        let mut exchange = Exchange::new();
        if direct {
            model::session_batch(&mut document, &request, false).unwrap();
        } else {
            exchange.batch(&mut document, &request, false).unwrap();
        }
        assert_eq!(document.1, vec!["cached"], "kit cache must follow the model on direct={direct}");
        let note = document.0.replica().list(&board(document.0.replica()), "notes").unwrap()[0].clone();
        let delete = json!({"ops":[{"op":"delete","target":note.as_str()}]});
        if direct {
            model::session_batch(&mut document, &delete, false).unwrap();
        } else {
            exchange.batch(&mut document, &delete, false).unwrap();
        }
        assert!(document.1.is_empty());
        let prefix = json!({"ops":[{"op":"create","type":"Note","in":"root.notes","ref":"$prefix"},{"op":"text.set","target":"$prefix","field":"body","text":"committed prefix"},{"op":"command","id":"missing"}]});
        let refused = if direct { model::session_batch(&mut document, &prefix, false) } else { exchange.batch(&mut document, &prefix, false) };
        assert!(refused.is_err());
        assert_eq!(document.1, vec!["committed prefix"], "the callback must precede the failed command");
        document.1.clear();
        let read = json!({"load":[{"target":"root"}]});
        if direct {
            model::session_batch(&mut document, &read, true).unwrap();
        } else {
            exchange.batch(&mut document, &read, true).unwrap();
        }
        assert!(document.1.is_empty(), "reads must not notify");
    }
}

/// A batch the engine refuses is taken back in the exchange's scratch replica, which keeps its
/// log and then follows the engine: what changed since a version before it is still told
/// (`model.changes`), where a replica loaded again from the engine's snapshot holds no history
/// before its load.
#[test]
fn an_exchange_keeps_what_changed_since_a_version_across_a_refused_batch() {
    let mut document = open();
    let mut exchange = Exchange::new();
    let before = exchange.replica(&mut document).unwrap().version();
    exchange.batch(&mut document, &json!({"ops":[{"op":"set","target":"root","field":"title","value":"Kept"}]}), false).unwrap();
    let error = exchange.batch(&mut document, &json!({"ops":[{"op":"set","target":"root","field":"title","value":UNREPAIRABLE}]}), false).unwrap_err();
    assert!(error.message.contains("refused"), "{error}");
    let replica = exchange.replica(&mut document).unwrap();
    assert_eq!(replica.version(), document.0.replica().version());
    let changes = replica.changes_since(&before).unwrap();
    assert_eq!(changes.changed.len(), 1);
    // This engine keeps an import its repair refuses: the scratch replica follows it.
    let engine = document.0.replica();
    assert_eq!(replica.get(&board(replica), "title").unwrap(), engine.get(&board(engine), "title").unwrap());
}

#[test]
fn exchange_follows_a_replacement_document_without_importing_old_edits() {
    let mut document = open();
    let mut exchange = Exchange::new();
    exchange.batch(&mut document, &json!({"ops":[{"op":"set","target":"root","field":"title","value":"Old document"}]}), false).unwrap();
    let old_id = document.0.replica().doc_id().to_string();
    let answer = exchange
        .batch(
            &mut document,
            &json!({"ops":[{"op":"command","id":"board.new"},{"op":"set","target":"root","field":"title","value":"Replacement"}],"load":[{"target":"root"}]}),
            false,
        )
        .unwrap();
    assert_ne!(document.0.replica().doc_id().to_string(), old_id);
    assert_eq!(answer["loaded"][0]["fields"]["title"], "Replacement");
    assert_eq!(document.0.replica().get(&board(document.0.replica()), "title").unwrap(), "Replacement");
}

#[test]
fn an_exchange_edits_the_engine_through_its_changes() {
    let mut document = open();
    let mut exchange = Exchange::new();
    let answer = exchange.batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!(answer["loaded"][1]["fields"], json!({ "body": "second", "done": true }));
    // The engine's own view follows: it took the changes as a collaborator's.
    assert_eq!(document.0.model().0, vec!["second".to_owned()]);
    // An edit the engine makes itself reaches the next batch.
    document
        .0
        .execute(&Origin::person("user:a"), |_, tx| {
            let note = tx.objects_of_type("Note").into_iter().next().ok_or("no note")?;
            tx.text_insert(&note, "body", 0, "the ")?;
            Ok(())
        })
        .unwrap();
    let read = exchange.batch(&mut document, &json!({ "load": [{ "target": "root", "fields": ["notes"] }] }), false).unwrap();
    let note = read["loaded"][0]["fields"]["notes"][0].as_str().unwrap().to_owned();
    let read = exchange
        .batch(
            &mut document,
            &json!({ "ops": [{ "op": "text.insert", "target": note, "field": "body", "index": 10, "text": "!" }], "load": [{ "target": note }] }),
            false,
        )
        .unwrap();
    assert_eq!(read["loaded"][0]["fields"]["body"], "the second!");
    assert_eq!(document.0.model().0, vec!["the second!".to_owned()]);
    let described = exchange.describe(&mut document).unwrap();
    assert_eq!(described["rootId"], json!(board(document.0.replica()).to_string()));
}

/// regressions/issue-kdm-shallow-export: a document forked as a new document
/// (`copy_as_new_document`, what `document.fork` writes into a file) is a shallow replica. The
/// object model over the change exchange loads the engine's "every change" export, and an agent's
/// draft opens from it; both work on a fork as on any document, and the draft merges back.
#[test]
fn an_exchange_and_a_draft_work_on_a_document_forked_as_a_new_document() {
    let source = open();
    let fork = source.0.replica().copy_as_new_document(DocId::new(), ActorId::from_u64(2).unwrap()).unwrap();
    let mut document = NotesDocument(KitSession::from_replica(fork, Box::new(MemoryBlobs::default())).unwrap(), Vec::new(), Value::Null);
    let mut exchange = Exchange::new();
    let described = exchange.describe(&mut document).unwrap();
    assert_eq!(described["rootId"], json!(board(document.0.replica()).to_string()));
    let answer = exchange.batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!(answer["loaded"][1]["fields"], json!({ "body": "second", "done": true }));
    assert_eq!(document.0.model().0, vec!["second".to_owned()]);
    // An agent's draft: every change, opened as a replica of its own, edited, and merged back.
    let all = document.model_export(&[]).unwrap();
    let mut draft = NotesDocument::model_open_replica("ideas.notes", &all, &[]).unwrap();
    assert_eq!(draft.0.replica().doc_id(), document.0.replica().doc_id());
    let base = draft.0.version();
    let mut draft_exchange = Exchange::new();
    draft_exchange.batch(&mut draft, &json!({ "ops": [{ "op": "set", "target": "root", "field": "title", "value": "Drafted" }] }), false).unwrap();
    let changes = draft.model_export(&base.encode()).unwrap();
    document.model_import(&changes).unwrap();
    let read = exchange.batch(&mut document, &json!({ "load": [{ "target": "root", "fields": ["title"] }] }), false).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["title"], "Drafted");
}

#[test]
fn a_replica_opens_without_a_file_and_refuses_what_validate_cannot_repair() {
    let mut first = open();
    let snapshot = first.0.snapshot().unwrap();
    let mut second = NotesDocument::model_open_replica("ideas.notes", &snapshot, &[]).unwrap();
    assert_eq!(second.0.replica().doc_id(), first.0.replica().doc_id());
    let write = |document: &mut NotesDocument, title: &'static str| {
        let before = document.0.version();
        document
            .0
            .execute(&Origin::person("user:a"), |_, tx| {
                let owner = tx.objects_of_type("Board").into_iter().next().ok_or("no board")?;
                tx.set(&owner, "title", json!(title))?;
                Ok(())
            })
            .unwrap();
        document.0.export_changes(&before).unwrap()
    };
    let fine = write(&mut first, "fine");
    second.model_import(&fine).unwrap();
    assert_eq!(second.0.replica().get(&board(second.0.replica()), "title").unwrap(), json!("fine"));
    let refused = write(&mut first, UNREPAIRABLE);
    assert!(second.model_import(&refused).is_err());
}

#[test]
fn a_session_answers_the_schema_it_reads_and_its_newest_author_schema() {
    let mut document = open();
    assert_eq!(kition_kit::session::__schema_version(&document), 1);
    model::session_batch(&mut document, &add_notes(), false).unwrap();
    assert_eq!(kition_kit::session::__author_schema_version(&document), Some(1));
}

fn set_title(session: &mut KitSession<Notes>, origin: &Origin, title: &'static str) {
    let root = board(session.replica());
    session.execute(origin, |_, tx| Ok(tx.set(&root, "title", json!(title))?)).unwrap();
}

fn title(document: &NotesDocument) -> Value {
    document.0.replica().get(&board(document.0.replica()), "title").unwrap()
}

/// The engine members a draft's review uses: `compareChanges` changes nothing, `mergeChanges` takes
/// the draft in as one undo step of the person and answers the damage, what changed and the undo
/// scope of its step, and a
/// merge the KDM refuses fails and changes nothing.
#[test]
fn a_draft_is_compared_and_merged_through_the_engine_members() {
    let mut document = open();
    let mut draft = document.0.fork(ActorId::from_u64(2).unwrap(), Box::new(MemoryBlobs::default())).unwrap();
    let base = draft.version();
    set_title(&mut draft, &Origin::agent("agent:test"), "Drafted");
    let changes = draft.export_changes(&base).unwrap();

    let compared: Value = serde_json::from_str(&kition_kit::session::__compare_changes(&document, &changes).unwrap()).unwrap();
    let root = board(document.0.replica()).to_string();
    assert_eq!(compared["changed"][0]["id"], json!(root));
    assert_eq!(compared["changed"][0]["edits"][0]["after"], "Drafted");
    assert_eq!(title(&document), "Ideas", "a comparison changes nothing");

    let merged: Value =
        serde_json::from_str(&kition_kit::session::__merge_changes(&mut document, &changes, r#"["agent","agent:test",null]"#).unwrap()).unwrap();
    assert_eq!(merged["damage"], json!({ "kind": "full" }));
    assert_eq!(merged["summary"]["changed"][0]["id"], json!(root));
    // Recorded with the agent's origin, the step is the person's, and the answer says so (M12a).
    assert_eq!(merged["scope"], json!("person"));
    assert_eq!(title(&document), "Drafted");
    // The person approved the draft: their Undo takes the whole merge back.
    assert!(document.0.can_undo());
    assert!(document.0.undo().unwrap().0);
    assert_eq!(title(&document), "Ideas");

    // The document and the draft both changed the title since the fork: refused, nothing changes.
    let mut other = document.0.fork(ActorId::from_u64(3).unwrap(), Box::new(MemoryBlobs::default())).unwrap();
    let base = other.version();
    set_title(&mut other, &Origin::agent("agent:test"), "Other");
    let changes = other.export_changes(&base).unwrap();
    set_title(&mut document.0, &Origin::person("user:a"), "Mine");
    assert!(kition_kit::session::__compare_changes(&document, &changes).is_err());
    assert!(kition_kit::session::__merge_changes(&mut document, &changes, r#"["agent","agent:test",null]"#).is_err());
    assert_eq!(title(&document), "Mine");
    assert!(kition_kit::session::__merge_changes(&mut document, &changes, "not an origin").is_err());
}

/// `restoreState` writes a stored state (a snapshot, or content) over the document as one undo step
/// of the person, keeping the object ids, and refuses another document's.
#[test]
fn restore_state_writes_a_stored_state_as_one_undo_step() {
    let mut document = open();
    model::session_batch(&mut document, &add_notes(), false).unwrap();
    let snapshot = document.0.snapshot().unwrap();
    let content = document.0.content_snapshot().unwrap();
    let notes = document.0.replica().objects_of_type("Note");
    set_title(&mut document.0, &Origin::person("user:a"), "Changed");
    document
        .0
        .execute(&Origin::person("user:a"), |_, tx| {
            let owner = tx.objects_of_type("Board").into_iter().next().ok_or("no board")?;
            tx.list_remove(&owner, "notes", 0)?;
            Ok(())
        })
        .unwrap();
    assert!(document.0.model().0.is_empty());

    let person = r#"["person","user:a",null]"#;
    let damage: Value = serde_json::from_str(&kition_kit::session::__restore_state(&mut document, &snapshot, person).unwrap()).unwrap();
    assert_eq!(damage, json!({ "kind": "full" }));
    assert_eq!(title(&document), "Ideas");
    assert_eq!(document.0.model().0, vec!["second".to_owned()]);
    assert_eq!(document.0.replica().objects_of_type("Note"), notes, "the restored objects keep their ids");
    // One step: Undo brings back the state before the restore.
    assert!(document.0.undo().unwrap().0);
    assert_eq!(title(&document), "Changed");
    assert!(document.0.model().0.is_empty());

    // Content (no version) restores the same; a state equal to the document's changes nothing.
    kition_kit::session::__restore_state(&mut document, &content, person).unwrap();
    assert_eq!(title(&document), "Ideas");
    let version = document.0.version();
    let damage: Value = serde_json::from_str(&kition_kit::session::__restore_state(&mut document, &content, person).unwrap()).unwrap();
    assert_eq!(damage, json!({ "kind": "none" }));
    assert_eq!(document.0.version(), version);

    // Another document's snapshot is refused and changes nothing.
    let stranger = open().0.snapshot().unwrap();
    assert!(kition_kit::session::__restore_state(&mut document, &stranger, person).is_err());
    assert_eq!(document.0.version(), version);
}

/// `changesSince` answers a receipt for a version the replica's log holds, and no change set (with
/// why) for one it does not.
#[test]
fn changes_since_answers_a_receipt_or_why_there_is_none() {
    let mut document = open();
    let since = document.0.version().encode();
    model::session_batch(&mut document, &add_notes(), false).unwrap();
    let answer: Value = serde_json::from_str(&kition_kit::session::__changes_since(&document, &since)).unwrap();
    assert_eq!(answer["changes"]["created"].as_array().map(Vec::len), Some(1));
    assert_eq!(answer["changes"]["created"][0]["type"], "Note");

    let now: Value = serde_json::from_str(&kition_kit::session::__changes_since(&document, &document.0.version().encode())).unwrap();
    assert_eq!(now["changes"]["created"], json!([]));

    let stranger = open().0.version().encode();
    let missing: Value = serde_json::from_str(&kition_kit::session::__changes_since(&document, &stranger)).unwrap();
    assert_eq!(missing["changes"], Value::Null);
    assert!(missing["unavailable"].as_str().is_some_and(|why| !why.is_empty()));
    let garbled: Value = serde_json::from_str(&kition_kit::session::__changes_since(&document, &[1, 2, 3])).unwrap();
    assert_eq!(garbled["changes"], Value::Null);
}

/// `modelReply` names an agent's reply's objects by their tool ids (keys and values, nested), keeps
/// text that merely contains an id, leaves a reply as it is without tool ids, and never changes
/// the document's own ids.
#[test]
fn model_reply_names_objects_by_their_tool_ids_and_leaves_the_document_alone() {
    let mut document = open();
    let plain = json!({ "target": board(document.0.replica()).to_string() });
    let answered: Value = serde_json::from_str(&kition_kit::session::__model_reply(&document, &plain.to_string()).unwrap()).unwrap();
    assert_eq!(answered, plain, "a schema without tool ids leaves the reply as it is");

    KitSessionDocument::execute_as(&mut document, "board.new", json!({ "named": true }), &Origin::person("user:a")).unwrap();
    let root = board(document.0.replica()).to_string();
    let mut details = Map::new();
    details.insert(root.clone(), json!([root.clone()]));
    let reply = json!({ "details": details, "diagnostics": [{ "target": { "object": root.clone() } }], "literal": format!("text {root}") });
    let shown: Value = serde_json::from_str(&kition_kit::session::__model_reply(&document, &reply.to_string()).unwrap()).unwrap();
    assert_eq!(
        shown,
        json!({ "details": { "board:replacement": ["board:replacement"] }, "diagnostics": [{ "target": { "object": "board:replacement" } }], "literal": format!("text {root}") })
    );
    assert_eq!(board(document.0.replica()).to_string(), root, "the document keeps its own ids");
    assert!(kition_kit::session::__model_reply(&document, "not json").is_err());
}
