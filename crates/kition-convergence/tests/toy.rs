//! The performance mode against a toy contract 2 kit (notes on a board, in a list and an outline
//! tree, with text and pictures). Actors, the document id, and object ids are deterministic
//! (counters that `create` restarts).

use std::cell::Cell;
use std::collections::BTreeSet;
use std::sync::Arc;

use kition_convergence::perf::{self, PerfOptions};
use kition_convergence::{Blobs, KitAdapter, Rng, Script};
use kition_kit::kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx, Version};
use kition_kit::session::{BlobSink, BlobSource, Damage, KitError, KitModel, KitSession, MemoryBlobs, sha256_hex};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.notes", "schemaVersion": 1, "root": "Board",
  "types": {
    "Board": { "fields": {
      "notes": { "kind": "list", "of": "Note" },
      "outline": { "kind": "tree", "of": "Note" }
    } },
    "Note": { "fields": {
      "x": { "kind": "number" },
      "color": { "kind": "string" },
      "body": { "kind": "text" },
      "picture": { "kind": "blob", "optional": true }
    } }
  }
}"#;

fn board() -> ObjectId {
    ObjectId::from_string("board")
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The view: the notes in list order, with their bodies.
#[derive(Debug, PartialEq)]
struct Notes {
    notes: Vec<(ObjectId, String)>,
}

impl KitModel for Notes {
    fn schema() -> Arc<Schema> {
        Arc::new(Schema::parse(SCHEMA).unwrap())
    }

    fn load(replica: &Replica, _blobs: &dyn BlobSource) -> Result<Self, KitError> {
        let mut notes = Vec::new();
        for id in replica.list(&board(), "notes")? {
            if replica.exists(&id) {
                notes.push((id.clone(), replica.text(&id, "body")?));
            }
        }
        Ok(Self { notes })
    }

    fn apply(&mut self, replica: &Replica, _changed: &BTreeSet<ObjectId>, blobs: &dyn BlobSource) -> Result<Damage, KitError> {
        *self = Self::load(replica, blobs)?;
        Ok(Damage::Full)
    }

    fn validate(tx: &mut Tx<'_>, _changed: &BTreeSet<ObjectId>) -> Result<bool, KitError> {
        let mut wrote = false;
        let items = tx.list_items(&board(), "notes")?;
        for (index, id) in items.iter().enumerate().rev() {
            if !tx.exists(id) || items.iter().take(index).any(|earlier| earlier == id) {
                tx.list_remove(&board(), "notes", index)?;
                wrote = true;
            }
        }
        Ok(wrote)
    }

    fn import(_name: &str, _bytes: &[u8], _blobs: &mut dyn BlobSink, actor: ActorId) -> Result<Replica, KitError> {
        let (replica, ()) = Replica::create_with(Self::schema(), DocId::parse(DOC_ID)?, actor, &Origin::system("create"), |tx| {
            tx.create_with_id("Board", &board(), Map::new())?;
            for (index, (x, color, body)) in [(1, "red", "hello"), (2, "blue", "world"), (3, "green", "notes")].into_iter().enumerate() {
                let id = tx.create_with_id("Note", &next_id(), fields(json!({ "x": x, "color": color })))?;
                tx.text_insert(&id, "body", 0, body)?;
                tx.list_insert(&board(), "notes", index, &id)?;
                tx.tree_create(&board(), "outline", None, &id)?;
            }
            Ok(())
        })?;
        Ok(replica)
    }

    fn export(&self, _replica: &Replica, _name: &str, _blobs: &dyn BlobSource) -> Result<Vec<u8>, KitError> {
        Ok(json!(self.notes.iter().map(|(_, body)| body).collect::<Vec<_>>()).to_string().into_bytes())
    }
}

thread_local! {
    /// The last object id and actor handed out; `NotesKit::create` restarts both.
    static NEXT_OBJECT: Cell<u64> = const { Cell::new(0) };
    static NEXT_ACTOR: Cell<u64> = const { Cell::new(0) };
}

/// Every toy document has this id, so both runners' states match.
const DOC_ID: &str = "0190f5c2-0000-7000-8000-000000000001";

fn next_id() -> ObjectId {
    NEXT_OBJECT.with(|next| next.set(next.get() + 1));
    ObjectId::from_string(format!("note-{}", NEXT_OBJECT.with(Cell::get)))
}

fn next_actor() -> ActorId {
    NEXT_ACTOR.with(|next| next.set(next.get() + 1));
    ActorId::from_u64(NEXT_ACTOR.with(Cell::get)).unwrap()
}

struct Doc {
    session: KitSession<Notes>,
    blobs: Blobs,
}

/// The adapter.
struct NotesKit;

fn person() -> Origin {
    Origin::person("alice")
}

fn notes(doc: &Doc) -> Vec<ObjectId> {
    doc.session.model().notes.iter().map(|(id, _)| id.clone()).collect()
}

impl NotesKit {
    fn run(&self, doc: &mut Doc, f: impl FnOnce(&Notes, &mut Tx<'_>) -> Result<(), KitError>) -> Result<(), String> {
        doc.session.execute(&person(), f).map(|_| ()).map_err(|error| error.to_string())
    }

    fn probe(&self, doc: &Doc) -> Result<ObjectId, String> {
        notes(doc).first().cloned().ok_or_else(|| "no note".to_owned())
    }
}

impl KitAdapter for NotesKit {
    type Doc = Doc;

    fn name(&self) -> &str {
        "kit.notes"
    }

    fn schema(&self) -> &str {
        SCHEMA
    }

    fn create(&self) -> Result<Doc, String> {
        NEXT_OBJECT.with(|next| next.set(0));
        NEXT_ACTOR.with(|next| next.set(0));
        let session = KitSession::<Notes>::import("board.notes", b"", Box::new(MemoryBlobs::default()), next_actor())?;
        Ok(Doc { session, blobs: Blobs::new() })
    }

    fn join(&self, snapshot: &[u8], blobs: &Blobs) -> Result<Doc, String> {
        let mut memory = MemoryBlobs::default();
        for (hash, bytes) in blobs {
            memory.0.insert(hash.clone(), Arc::from(bytes.as_slice()));
        }
        let session = KitSession::<Notes>::open_snapshot(snapshot, Box::new(memory), next_actor())?;
        Ok(Doc { session, blobs: blobs.clone() })
    }

    fn version(&self, doc: &mut Doc) -> Result<Vec<u8>, String> {
        Ok(doc.session.version().encode())
    }

    fn export_changes(&self, doc: &mut Doc, since: &[u8]) -> Result<Vec<u8>, String> {
        let since = if since.is_empty() { Version::empty() } else { Version::decode(since).map_err(|error| error.to_string())? };
        Ok(doc.session.export_changes(&since)?)
    }

    fn import_changes(&self, doc: &mut Doc, bytes: &[u8]) -> Result<(), String> {
        doc.session.import_changes(bytes).map(|_| ()).map_err(|error| error.to_string())
    }

    fn snapshot(&self, doc: &mut Doc) -> Result<Vec<u8>, String> {
        Ok(doc.session.snapshot()?)
    }

    fn state(&self, doc: &mut Doc) -> Result<Value, String> {
        doc.session.replica().state_json().map_err(|error| error.to_string())
    }

    fn undo(&self, doc: &mut Doc) -> Result<bool, String> {
        Ok(doc.session.undo()?.0)
    }

    fn redo(&self, doc: &mut Doc) -> Result<bool, String> {
        Ok(doc.session.redo()?.0)
    }

    fn random_edit(&self, doc: &mut Doc, rng: &mut Rng) -> Result<Option<String>, String> {
        let ids = notes(doc);
        let Some(target) = rng.pick(&ids).cloned() else {
            self.script(doc, &Script::Create)?;
            return Ok(Some("create".into()));
        };
        let value = rng.below(1000);
        let step = match rng.below(7) {
            0 => Script::Create,
            1 if ids.len() > 1 => Script::Delete,
            2 => Script::Reorder { which: rng.below(2) as u8 },
            3 => Script::InsertBlob { seed: value as u32 },
            4 => {
                let len = doc.session.model().notes.first().map_or(0, |(_, body)| body.chars().count());
                Script::InsertText { at: rng.below(len + 1), text: format!("t{value}") }
            }
            _ => {
                let field = if rng.chance(50) { "x" } else { "color" };
                self.run(doc, |_, tx| tx.set(&target, field, if field == "x" { json!(value) } else { json!(format!("c{value}")) }).map_err(Into::into))?;
                return Ok(Some(format!("set {field}")));
            }
        };
        let label = format!("{step:?}");
        Ok(self.script(doc, &step)?.then_some(label))
    }

    fn script(&self, doc: &mut Doc, step: &Script) -> Result<bool, String> {
        let ids = notes(doc);
        match step {
            Script::SetField { slot, value } => {
                let probe = self.probe(doc)?;
                let (field, value) = if *slot == 0 { ("x", json!(*value)) } else { ("color", json!(format!("c{value}"))) };
                self.run(doc, |_, tx| tx.set(&probe, field, value).map_err(Into::into))?;
            }
            Script::Create => self.run(doc, |model, tx| {
                let id = tx.create_with_id("Note", &next_id(), fields(json!({ "x": 0, "color": "new" })))?;
                tx.list_insert(&board(), "notes", model.notes.len(), &id)?;
                tx.tree_create(&board(), "outline", None, &id)?;
                Ok(())
            })?,
            Script::Delete => {
                let probe = self.probe(doc)?;
                self.run(doc, |_, tx| {
                    let index = tx.list_items(&board(), "notes")?.iter().position(|id| id == &probe);
                    tx.delete(&probe)?;
                    if let Some(index) = index {
                        tx.list_remove(&board(), "notes", index)?;
                    }
                    Ok(())
                })?;
            }
            Script::Duplicate => {
                let probe = self.probe(doc)?;
                self.run(doc, |_, tx| {
                    let x = tx.get(&probe, "x")?;
                    let color = tx.get(&probe, "color")?;
                    let id = tx.create_with_id("Note", &next_id(), fields(json!({ "x": x, "color": color })))?;
                    tx.list_insert(&board(), "notes", 0, &id)?;
                    Ok(())
                })?;
            }
            Script::Reorder { which } => {
                if ids.len() < 2 {
                    return Ok(true);
                }
                let from = usize::from(*which) % ids.len();
                self.run(doc, |_, tx| {
                    let len = tx.list_items(&board(), "notes")?.len();
                    tx.list_move(&board(), "notes", from, len - 1).map_err(Into::into)
                })?;
            }
            Script::Reparent { which } => {
                let (a, b) = match (ids.first(), ids.get(1)) {
                    (Some(a), Some(b)) => (a.clone(), b.clone()),
                    _ => return Ok(true),
                };
                let (child, parent) = if *which == 0 { (a, b) } else { (b, a) };
                self.run(doc, |_, tx| {
                    let tree = tx.tree(&board(), "outline")?;
                    let node = |id: &ObjectId| tree.iter().find(|entry| &entry.object == id).map(|entry| entry.node.clone());
                    if let (Some(child), Some(parent)) = (node(&child), node(&parent)) {
                        tx.tree_move(&board(), "outline", &child, Some(&parent))?;
                    }
                    Ok(())
                })?;
            }
            Script::InsertText { at, text } => {
                let probe = self.probe(doc)?;
                self.run(doc, |_, tx| tx.text_insert(&probe, "body", *at, text).map_err(Into::into))?;
            }
            Script::DeleteText { at, len } => {
                let probe = self.probe(doc)?;
                self.run(doc, |_, tx| tx.text_delete(&probe, "body", *at, *len).map_err(Into::into))?;
            }
            Script::InsertBlob { seed } => {
                let probe = self.probe(doc)?;
                let bytes = format!("picture {seed}").into_bytes();
                let blob = doc.session.blobs_mut().put(&bytes, "image/png");
                doc.blobs.insert(sha256_hex(&bytes), bytes);
                self.run(doc, |_, tx| tx.set(&probe, "picture", json!(blob)).map_err(Into::into))?;
            }
            Script::SplitParagraph { .. } | Script::MergeParagraph { .. } => return Ok(false),
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn text(&self, doc: &mut Doc) -> Result<Option<String>, String> {
        Ok(Some(doc.session.model().notes.first().map(|(_, body)| body.clone()).unwrap_or_default()))
    }

    fn check_view(&self, doc: &mut Doc) -> Result<(), String> {
        let fresh = Notes::load(doc.session.replica(), doc.session.blobs())?;
        if &fresh == doc.session.model() { Ok(()) } else { Err("the view differs from the replica".into()) }
    }

    fn blobs(&self, doc: &mut Doc) -> Result<Blobs, String> {
        Ok(doc.blobs.clone())
    }

    fn add_blobs(&self, doc: &mut Doc, blobs: &Blobs) -> Result<(), String> {
        for (hash, bytes) in blobs {
            doc.session.blobs_mut().put(bytes, "application/octet-stream");
            doc.blobs.insert(hash.clone(), bytes.clone());
        }
        Ok(())
    }

    fn export_file(&self, doc: &mut Doc) -> Result<Option<Vec<u8>>, String> {
        Ok(Some(doc.session.export("board.notes")?))
    }
}

#[test]
fn the_perf_mode_measures() {
    let report = perf::measure(&NotesKit, &PerfOptions { edits: 50, remote_changes: 100, keystrokes: 20, ..PerfOptions::default() }).unwrap();
    println!("{}", report.render());
    assert_eq!(report.remote_changes, 100);
    assert!(report.objects >= 2);
}
