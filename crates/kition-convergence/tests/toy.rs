//! The suite against a toy contract 2 kit (notes on a board, in a list and an outline tree, with
//! text and pictures), and against broken variants of it, which the suite must catch.
//!
//! Actors, the document id, and object ids are deterministic (counters that `create` restarts), so
//! the TypeScript runner (`packages/convergence`) can be checked against this one: its twin of the
//! toy must reach the same states, which `tests/fixtures/toy-cross-check.json` records.

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::sync::Arc;

use kition_convergence::perf::{self, PerfOptions};
use kition_convergence::{Blobs, KitAdapter, Options, Outcome, Rng, Script, wasm};
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
        if BROKEN_REPAIR.with(|broken| broken.get()) {
            return Ok(false);
        }
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
    /// The broken variant: the repair does nothing.
    static BROKEN_REPAIR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The last object id and actor handed out; `NotesKit::create` restarts both.
    static NEXT_OBJECT: Cell<u64> = const { Cell::new(0) };
    static NEXT_ACTOR: Cell<u64> = const { Cell::new(0) };
    /// The SHA-256 of every state the suite read, for the cross-check.
    static RECORDED: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
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

/// The adapter; `forget_undo` is a broken variant whose undo restores a snapshot of the whole
/// document (and so reverts others' later changes).
#[derive(Default)]
struct NotesKit {
    whole_document_undo: bool,
}

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
        let hash = doc.session.state_hash()?;
        RECORDED.with(|recorded| recorded.borrow_mut().push(hash));
        doc.session.replica().state_json().map_err(|error| error.to_string())
    }

    fn undo(&self, doc: &mut Doc) -> Result<bool, String> {
        if self.whole_document_undo {
            // Broken on purpose: puts every note's x back to its imported value.
            let ids = notes(doc);
            let done = doc.session.can_undo();
            self.run(doc, |_, tx| {
                for (index, id) in ids.iter().enumerate() {
                    tx.set(id, "x", json!(index + 1))?;
                    tx.set(id, "color", json!("reset"))?;
                }
                Ok(())
            })?;
            return Ok(done);
        }
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
                    // The list entry stays when the repair is broken: the delete relies on it.
                    if let Some(index) = index.filter(|_| !BROKEN_REPAIR.with(|broken| broken.get())) {
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
fn a_correct_kit_passes_every_scenario() {
    let report = kition_convergence::run(&NotesKit::default(), &Options::default());
    println!("{}", report.render());
    assert!(report.level6(), "{}", report.render());
    // The toy has no paragraphs: split and merge are skipped, which L6 allows.
    assert!(matches!(report.outcome("text-split"), Some(Outcome::Skipped(_))));
    let json = report.to_json();
    assert_eq!(json["level6"], json!(true));
    assert_eq!(json["kit"], json!("kit.notes"));
    assert!(json["checks"].as_array().unwrap().iter().any(|check| check["outcome"] == json!("skipped") && check["reason"].is_string()));
}

#[test]
fn a_missing_repair_is_caught() {
    BROKEN_REPAIR.with(|broken| broken.set(true));
    let report = kition_convergence::run_one(&NotesKit::default(), "delete-edit", &Options::default()).unwrap();
    BROKEN_REPAIR.with(|broken| broken.set(false));
    match report.outcome("delete-edit") {
        Some(Outcome::Failed(reason)) => assert!(reason.contains("does not exist"), "{reason}"),
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn an_undo_that_reverts_others_is_caught() {
    let kit = NotesKit { whole_document_undo: true };
    let report = kition_convergence::run_one(&kit, "undo", &Options::default()).unwrap();
    match report.outcome("undo") {
        Some(Outcome::Failed(reason)) => assert!(reason.contains("later change"), "{reason}"),
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn the_perf_mode_measures() {
    let report = perf::measure(&NotesKit::default(), &PerfOptions { edits: 50, remote_changes: 100, keystrokes: 20, ..PerfOptions::default() }).unwrap();
    println!("{}", report.render());
    assert_eq!(report.remote_changes, 100);
    assert!(report.objects >= 2);
}

#[test]
fn a_trace_replays_natively_to_one_state() {
    let kit = NotesKit::default();
    let trace = wasm::record(&kit, 3, 30).unwrap();
    assert!(!trace.changes.is_empty());
    let first = wasm::replay_native(&kit, &trace).unwrap();
    let mut reversed = trace.clone();
    reversed.changes.reverse();
    assert_eq!(first, wasm::replay_native(&kit, &reversed).unwrap());
}

/// What a runner reaches on the toy: the whole suite's report, and for each scenario run alone its
/// outcome, how many states it read, the SHA-256 of the last one, and the SHA-256 of all of their
/// hashes in order (`trace`). The TypeScript runner's twin of the toy must reach the same.
fn cross_check() -> Value {
    let kit = NotesKit::default();
    let options = Options::default();
    let report = kition_convergence::run(&kit, &options).to_json();
    let mut scenarios = Map::new();
    for (id, _) in kition_convergence::SCENARIOS {
        RECORDED.with(|recorded| recorded.borrow_mut().clear());
        let outcome = kition_convergence::run_one(&kit, id, &options).unwrap().to_json()["checks"][0]["outcome"].clone();
        let recorded = RECORDED.with(RefCell::take);
        let trace = sha256_hex(recorded.join(",").as_bytes());
        scenarios.insert((*id).to_owned(), json!({ "outcome": outcome, "states": recorded.len(), "last": recorded.last(), "trace": trace }));
    }
    json!({ "report": report, "scenarios": scenarios })
}

/// `KITION_UPDATE_FIXTURES=1` writes the fixture from this runner; the TypeScript runner's test
/// (`packages/convergence/test/cross-check.test.ts`) reads the same file.
#[test]
fn the_typescript_runner_reaches_the_same_states() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/toy-cross-check.json");
    let found = cross_check();
    if std::env::var_os("KITION_UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, format!("{found:#}\n")).unwrap();
    }
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        found, expected,
        "the toy no longer reaches the recorded states; if the suite changed on purpose, update the fixture and the TypeScript runner together"
    );
}

#[test]
fn heavier_runs_come_from_the_environment() {
    let vars =
        |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned());
    let defaults = Options::default();
    let none = Options::from_vars(vars(&[]));
    assert_eq!((none.seeds, none.steps), (defaults.seeds.clone(), defaults.steps));
    let heavy = Options::from_vars(vars(&[("KITION_CONVERGENCE_SEEDS", "5"), ("KITION_CONVERGENCE_STEPS", "300")]));
    assert_eq!((heavy.seeds, heavy.steps), (vec![1, 2, 3, 4, 5], 300));
    let range = Options::from_vars(vars(&[("KITION_CONVERGENCE_SEEDS", "3"), ("KITION_CONVERGENCE_SEED_BASE", "1000")]));
    assert_eq!(range.seeds, vec![1001, 1002, 1003]);
    assert_eq!(Options::from_vars(vars(&[("KITION_CONVERGENCE_SEED_BASE", "50")])).seeds, vec![51, 52, 53]);
}
