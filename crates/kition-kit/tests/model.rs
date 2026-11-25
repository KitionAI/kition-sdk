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
