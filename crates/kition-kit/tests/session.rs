//! `KitSession` with a toy kit: a board of shapes (a list) and tiles (a map).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use kition_kit::kdm::testing::Rng;
use kition_kit::kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx, UndoScope};
use kition_kit::session::{BlobRef, BlobSink, BlobSource, Damage, IdMap, KitError, KitModel, KitSession, MemoryBlobs, history_scope};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.toy", "schemaVersion": 1, "root": "Board",
  "types": {
    "Board": { "fields": {
      "shapes": { "kind": "list", "of": "Shape" },
      "tiles": { "kind": "map" },
      "source": { "kind": "blob", "optional": true }
    } },
    "Shape": { "fields": {
      "x": { "kind": "number" }, "y": { "kind": "number" }, "color": { "kind": "string" }
    } }
  }
}"#;

const FILE: &str = r#"{"shapes":[{"x":1,"y":2,"color":"red"},{"x":30,"y":40,"color":"blue"}],"tiles":{"0,0":"grass"}}"#;

fn board() -> ObjectId {
    ObjectId::from_string("board")
}

#[derive(Clone, Debug, PartialEq)]
struct ShapeView {
    id: ObjectId,
    x: f64,
    y: f64,
    color: String,
}

#[derive(Debug, PartialEq)]
struct Toy {
    shapes: Vec<ShapeView>,
    tiles: BTreeMap<String, Value>,
}

fn read_shape(replica: &Replica, id: &ObjectId) -> Result<Option<ShapeView>, KitError> {
    if !replica.exists(id) {
        return Ok(None);
    }
    let number = |field| replica.get(id, field).map(|value| value.as_f64().unwrap_or_default());
    let color = replica.get(id, "color")?.as_str().unwrap_or_default().to_owned();
    Ok(Some(ShapeView { id: id.clone(), x: number("x")?, y: number("y")?, color }))
}

fn rect(shape: &ShapeView) -> Damage {
    let (x, y) = (shape.x as i32, shape.y as i32);
    Damage::Rects(vec![[x, y, x + 10, y + 10]])
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

impl KitModel for Toy {
    fn schema() -> Arc<Schema> {
        Arc::new(Schema::parse(SCHEMA).unwrap())
    }

    fn load(replica: &Replica, _blobs: &dyn BlobSource) -> Result<Self, KitError> {
        let mut shapes = Vec::new();
        for id in replica.list(&board(), "shapes")? {
            // Dangling entries (deleted shapes) are not in the view.
            shapes.extend(read_shape(replica, &id)?);
        }
        let tiles = replica.map_entries(&board(), "tiles")?.into_iter().collect();
        Ok(Self { shapes, tiles })
    }

    fn apply(&mut self, replica: &Replica, changed: &BTreeSet<ObjectId>, blobs: &dyn BlobSource) -> Result<Damage, KitError> {
        // A shape can come back (an undone delete) under a list entry that never left.
        let returned = changed.iter().any(|id| replica.exists(id) && !self.shapes.iter().any(|shape| &shape.id == id));
        if changed.contains(&board()) || returned {
            *self = Self::load(replica, blobs)?;
            return Ok(Damage::Full);
        }
        let mut damage = Damage::None;
        for id in changed {
            let fresh = read_shape(replica, id)?;
            for shape in self.shapes.iter_mut().filter(|shape| &shape.id == id) {
                damage = damage.merge(rect(shape));
                if let Some(fresh) = &fresh {
                    damage = damage.merge(rect(fresh));
                    *shape = fresh.clone();
                }
            }
            if fresh.is_none() {
                self.shapes.retain(|shape| &shape.id != id);
            }
        }
        Ok(damage)
    }

    fn validate(tx: &mut Tx<'_>, _changed: &BTreeSet<ObjectId>) -> Result<bool, KitError> {
        let items = tx.list_items(&board(), "shapes")?;
        let mut wrote = false;
        for (index, id) in items.iter().enumerate().rev() {
            if !tx.exists(id) {
                tx.list_remove(&board(), "shapes", index)?;
                wrote = true;
            }
        }
        Ok(wrote)
    }

    fn import(_name: &str, bytes: &[u8], blobs: &mut dyn BlobSink, actor: ActorId) -> Result<Replica, KitError> {
        let file: Value = serde_json::from_slice(bytes).map_err(|error| KitError::new(error.to_string()))?;
        let source = blobs.put(bytes, "application/json");
        let (replica, ()) = Replica::create_with(Self::schema(), DocId::new(), actor, &Origin::system("import"), |tx| {
            tx.create_with_id("Board", &board(), fields(json!({ "source": source })))?;
            for (index, shape) in file["shapes"].as_array().into_iter().flatten().enumerate() {
                let id = tx.create("Shape", fields(shape.clone()))?;
                tx.list_insert(&board(), "shapes", index, &id)?;
            }
            for (key, value) in file["tiles"].as_object().into_iter().flatten() {
                tx.map_set(&board(), "tiles", key, value.clone())?;
            }
            Ok(())
        })?;
        Ok(replica)
    }

    fn export(&self, _replica: &Replica, _name: &str, _blobs: &dyn BlobSource) -> Result<Vec<u8>, KitError> {
        let shapes: Vec<Value> = self.shapes.iter().map(|shape| json!({ "x": shape.x, "y": shape.y, "color": shape.color })).collect();
        Ok(json!({ "shapes": shapes, "tiles": self.tiles }).to_string().into_bytes())
    }
}

// Commands.

fn add_shape(tx: &mut Tx<'_>, x: f64, color: &str) -> Result<ObjectId, KitError> {
    let id = tx.create("Shape", fields(json!({ "x": x, "y": 0, "color": color })))?;
    let len = tx.list_items(&board(), "shapes")?.len();
    tx.list_insert(&board(), "shapes", len, &id)?;
    Ok(id)
}

fn delete_shape(tx: &mut Tx<'_>, id: &ObjectId) -> Result<(), KitError> {
    let items = tx.list_items(&board(), "shapes")?;
    if let Some(index) = items.iter().position(|item| item == id) {
        tx.list_remove(&board(), "shapes", index)?;
    }
    tx.delete(id)?;
    Ok(())
}

// Helpers.

type Session = KitSession<Toy>;

fn person(name: &str) -> Origin {
    Origin::person(format!("user:{name}"))
}

fn actor(value: u64) -> ActorId {
    ActorId::from_u64(value).unwrap()
}

fn first() -> Session {
    KitSession::import("board.toy", FILE.as_bytes(), Box::new(MemoryBlobs::default()), actor(1)).unwrap()
}

fn peer(of: &Session, value: u64) -> Session {
    KitSession::open_snapshot(&of.snapshot().unwrap(), Box::new(MemoryBlobs::default()), actor(value)).unwrap()
}

fn sync(a: &mut Session, b: &mut Session) {
    for _ in 0..8 {
        a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
        b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
        if a.version() == b.version() {
            return;
        }
    }
    panic!("the sessions did not settle");
}

fn assert_view_follows_replica(session: &Session) {
    assert_eq!(session.model(), &Toy::load(session.replica(), session.blobs()).unwrap());
}

fn ids(session: &Session) -> Vec<ObjectId> {
    session.model().shapes.iter().map(|shape| shape.id.clone()).collect()
}

// Tests.

#[test]
fn two_sessions_exchanging_changes_converge() {
    let mut a = first();
    let mut b = peer(&a, 2);
    let shape = ids(&a)[0].clone();
    let (added, damage) = a.execute(&person("a"), |_, tx| add_shape(tx, 5.0, "green")).unwrap();
    assert_eq!(damage, Damage::Full);
    let (_, damage) = b
        .execute(&person("b"), |model, tx| {
            assert_eq!(model.shapes.len(), 2);
            Ok(tx.set(&shape, "color", json!("black"))?)
        })
        .unwrap();
    assert_eq!(damage, Damage::Rects(vec![[1, 2, 11, 12], [1, 2, 11, 12]]));
    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    assert_eq!(a.model(), b.model());
    assert_eq!(ids(&a)[2], added);
    assert_eq!(a.model().shapes[0].color, "black");
    assert_view_follows_replica(&a);
}

#[test]
fn each_tile_is_its_own_last_writer_wins_register() {
    let mut a = first();
    let mut b = peer(&a, 2);
    let set = |key: &'static str, value: &'static str| move |_: &Toy, tx: &mut Tx<'_>| Ok(tx.map_set(&board(), "tiles", key, json!(value))?);
    a.execute(&person("a"), set("1,1", "water")).unwrap();
    b.execute(&person("b"), set("1,1", "sand")).unwrap();
    b.execute(&person("b"), set("2,2", "rock")).unwrap();
    sync(&mut a, &mut b);
    assert_eq!(a.model(), b.model());
    let tiles = &a.model().tiles;
    assert!(tiles["1,1"] == json!("water") || tiles["1,1"] == json!("sand"));
    assert_eq!(tiles["2,2"], json!("rock"));
    assert_eq!(tiles["0,0"], json!("grass"));
}

#[test]
fn undo_reverts_only_local_person_transactions() {
    let mut a = first();
    let mut b = peer(&a, 2);
    let original = ids(&a)[0].clone();
    let (mine, _) = a.execute(&person("a"), |_, tx| add_shape(tx, 50.0, "pink")).unwrap();
    let (theirs, _) = b.execute(&person("b"), |_, tx| add_shape(tx, 60.0, "gray")).unwrap();
    // Deleting the object but not its list entry leaves the entry dangling: a's import repairs it.
    b.execute(&person("b"), |_, tx| Ok(tx.delete(&original)?)).unwrap();
    a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    assert!(!a.replica().list(&board(), "shapes").unwrap().contains(&original));

    let (done, damage) = a.undo().unwrap();
    assert!(done);
    assert_ne!(damage, Damage::None);
    let now = ids(&a);
    assert!(!now.contains(&mine), "the local transaction is undone");
    assert!(now.contains(&theirs), "the remote change stays");
    assert!(!a.replica().list(&board(), "shapes").unwrap().contains(&original), "the repair stays");
    assert!(!a.can_undo(), "imports, repairs, and the file import are not undo steps");
    assert_view_follows_replica(&a);

    assert!(a.can_redo());
    let (done, _) = a.redo().unwrap();
    assert!(done);
    assert!(ids(&a).contains(&mine));
    assert!(a.undo().unwrap().0);
    assert_eq!(a.undo().unwrap(), (false, Damage::None));
}

#[test]
fn the_persons_undo_and_the_agents_undo_take_back_only_their_own_steps() {
    let mut a = first();
    let agent = Origin::agent("user:a").with_label("ai/run");
    let (by_agent, _) = a.execute(&agent, |_, tx| add_shape(tx, 40.0, "teal")).unwrap();
    let (mine, _) = a.execute(&person("a"), |_, tx| add_shape(tx, 50.0, "pink")).unwrap();
    assert!(a.can_undo() && a.can_undo_in(UndoScope::Agent));

    // The agent's undo keeps the person's later shape; the person's keeps the agent's.
    let (done, damage) = a.undo_in(UndoScope::Agent).unwrap();
    assert!(done);
    assert_ne!(damage, Damage::None);
    assert!(!ids(&a).contains(&by_agent) && ids(&a).contains(&mine));
    assert!(a.can_redo_in(UndoScope::Agent));
    assert!(a.redo_in(UndoScope::Agent).unwrap().0);
    assert!(a.undo().unwrap().0);
    assert!(ids(&a).contains(&by_agent) && !ids(&a).contains(&mine));
    assert!(!a.can_undo(), "the agent's step is not the person's");
    assert_view_follows_replica(&a);
}

#[test]
fn history_scope_reads_the_scope_parameter_else_the_origin() {
    let agent = Origin::agent("user:a");
    assert_eq!(history_scope(&json!({}), &person("a")).unwrap(), UndoScope::Person);
    assert_eq!(history_scope(&json!({}), &agent).unwrap(), UndoScope::Agent);
    assert_eq!(history_scope(&json!({}), &Origin::new(kition_kit::kdm::OriginKind::Extension, "user:a")).unwrap(), UndoScope::Person);
    assert_eq!(history_scope(&json!({ "scope": "agent" }), &person("a")).unwrap(), UndoScope::Agent);
    assert_eq!(history_scope(&json!({ "scope": "person" }), &agent).unwrap(), UndoScope::Person);
    assert!(history_scope(&json!({ "scope": "robot" }), &agent).is_err());
    assert!(history_scope(&json!({ "scope": 2 }), &agent).is_err());
}

#[test]
fn import_changes_runs_validate_and_applies() {
    let mut a = first();
    let mut b = peer(&a, 2);
    let gone = ids(&a)[1].clone();
    b.execute(&person("b"), |_, tx| Ok(tx.delete(&gone)?)).unwrap();
    assert_eq!(b.replica().list(&board(), "shapes").unwrap().len(), 2, "b's own entry dangles");

    let damage = a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    assert_ne!(damage, Damage::None);
    assert_eq!(a.replica().list(&board(), "shapes").unwrap().len(), 1, "the repair removed the entry");
    assert!(!ids(&a).contains(&gone));
    assert_view_follows_replica(&a);
    assert!(!b.version().includes(&a.version()), "the repair is a change of a's own");

    b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());

    // A valid import writes no repair.
    b.execute(&person("b"), |_, tx| add_shape(tx, 7.0, "teal")).unwrap();
    a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    assert_eq!(a.version(), b.version());
}

#[test]
fn undo_and_redo_run_validate() {
    let mut a = first();
    let (mine, _) = a.execute(&person("a"), |_, tx| add_shape(tx, 50.0, "pink")).unwrap();
    let mut b = peer(&a, 2);
    // b lists a's shape a second time; undoing its creation on a leaves that entry dangling.
    b.execute(&person("b"), |_, tx| Ok(tx.list_insert(&board(), "shapes", 0, &mine)?)).unwrap();
    a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    let entries = |session: &Session| session.replica().list(&board(), "shapes").unwrap();
    assert_eq!(entries(&a).iter().filter(|id| **id == mine).count(), 2);

    let (done, damage) = a.undo().unwrap();
    assert!(done);
    assert_eq!(damage, Damage::Full);
    assert!(!a.replica().exists(&mine));
    assert!(!entries(&a).contains(&mine), "the repair removed b's entry");
    assert_view_follows_replica(&a);

    let (done, _) = a.redo().unwrap();
    assert!(done);
    assert!(a.replica().exists(&mine));
    assert!(entries(&a).iter().all(|id| a.replica().exists(id)));
    assert_view_follows_replica(&a);
    sync(&mut a, &mut b);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
}

#[test]
fn execute_keeps_the_view_equal_to_a_fresh_load() {
    for seed in 1..=6 {
        let mut rng = Rng::new(seed);
        let a = first();
        let b = peer(&a, 2);
        let mut sessions = [a, b];
        for _ in 0..80 {
            let which = rng.below(2);
            let shapes = ids(&sessions[which]);
            let pick = (!shapes.is_empty()).then(|| shapes[rng.below(shapes.len())].clone());
            let value = rng.below(100) as f64;
            let origin = person(if which == 0 { "a" } else { "b" });
            let session = &mut sessions[which];
            match (rng.below(10), pick) {
                (0, _) => drop(session.execute(&origin, |_, tx| add_shape(tx, value, "red")).unwrap()),
                (1, Some(id)) => drop(session.execute(&origin, |_, tx| Ok(tx.set(&id, "x", json!(value))?)).unwrap()),
                (2, Some(id)) => drop(session.execute(&origin, |_, tx| Ok(tx.set(&id, "color", json!(format!("c{value}")))?)).unwrap()),
                (3, Some(id)) => drop(session.execute(&origin, |_, tx| delete_shape(tx, &id)).unwrap()),
                (4, Some(id)) => drop(session.execute(&origin, |_, tx| Ok(tx.delete(&id)?)).unwrap()),
                (5, Some(_)) => {
                    let len = shapes.len();
                    let (from, to) = (rng.below(len), rng.below(len));
                    drop(session.execute(&origin, |_, tx| Ok(tx.list_move(&board(), "shapes", from, to)?)).unwrap());
                }
                (6, _) => drop(session.execute(&origin, |_, tx| Ok(tx.map_set(&board(), "tiles", &format!("{}", value as u32 % 4), json!(value))?)).unwrap()),
                (7, _) => drop(session.undo().unwrap()),
                (8, _) => drop(session.redo().unwrap()),
                _ => {
                    let [a, b] = &mut sessions;
                    let (to, from) = if which == 0 { (a, b) } else { (b, a) };
                    to.import_changes(&from.export_changes(&to.version()).unwrap()).unwrap();
                }
            }
            assert_view_follows_replica(&sessions[which]);
        }
        let [a, b] = &mut sessions;
        sync(a, b);
        assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap(), "seed {seed}");
        assert_eq!(a.model(), b.model(), "seed {seed}");
        assert_view_follows_replica(a);
        assert_view_follows_replica(b);
    }
}

#[test]
fn snapshots_and_exports_round_trip() {
    let mut a = first();
    a.execute(&person("a"), |_, tx| add_shape(tx, 9.0, "olive")).unwrap();
    let b = peer(&a, 2);
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    assert_eq!(a.model(), b.model());
    assert_eq!(a.export("board.toy").unwrap(), b.export("board.toy").unwrap());
    let again = KitSession::<Toy>::import("board.toy", &a.export("board.toy").unwrap(), Box::new(MemoryBlobs::default()), actor(3)).unwrap();
    assert_eq!(again.model().shapes.len(), 3);
    assert_eq!(again.model().tiles, a.model().tiles);
}

#[test]
fn blob_refs_round_trip_through_memory_blobs() {
    let mut blobs = MemoryBlobs::default();
    let blob = blobs.put(b"abc", "text/plain");
    assert_eq!(blob, BlobRef { hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(), mime: "text/plain".into(), size: 3 });
    assert_eq!(blobs.put(b"abc", "text/plain"), blob);
    assert_eq!(blobs.get(&blob.hash).as_deref(), Some(b"abc".as_slice()));
    assert!(blobs.get("missing").is_none());
    assert_eq!(serde_json::to_value(&blob).unwrap(), json!({ "hash": blob.hash, "mime": "text/plain", "size": 3 }));

    let session = first();
    let stored: BlobRef = serde_json::from_value(session.replica().get(&board(), "source").unwrap()).unwrap();
    assert_eq!(stored.size, FILE.len() as u64);
    assert_eq!(session.blobs().get(&stored.hash).as_deref(), Some(FILE.as_bytes()));
}

#[test]
fn record_writes_without_reapplying() {
    let mut session = first();
    session.record(&person("a"), |tx| Ok(tx.map_set(&board(), "tiles", "9,9", json!("lava"))?)).unwrap();
    assert!(!session.model().tiles.contains_key("9,9"), "the bridge already changed its own view");
    assert_eq!(session.replica().map_get(&board(), "tiles", "9,9").unwrap(), json!("lava"));
    session.model_mut().tiles.insert("9,9".into(), json!("lava"));
    assert_view_follows_replica(&session);
    // Undoing it patches the view from the replica.
    session.undo().unwrap();
    assert!(!session.model().tiles.contains_key("9,9"));
}

#[test]
fn a_failed_command_changes_nothing() {
    let mut session = first();
    let before = session.version();
    let error = session.execute(&person("a"), |_, tx| -> Result<(), KitError> {
        add_shape(tx, 1.0, "red")?;
        Err(KitError::new("refused"))
    });
    assert_eq!(error.unwrap_err().to_string(), "refused");
    assert_eq!(session.version(), before);
}

#[test]
fn id_maps_and_damage() {
    let mut map = IdMap::default();
    let (one, two) = (ObjectId::from_string("one"), ObjectId::from_string("two"));
    map.insert(one.clone(), 1_u32);
    map.insert(two.clone(), 2);
    assert_eq!(map.local(&one), Some(1));
    assert_eq!(map.object(2), Some(&two));
    map.insert(one.clone(), 3);
    assert_eq!(map.object(1), None, "re-mapping drops the old local id");
    assert_eq!(map.remove(&one), Some(3));
    assert_eq!((map.local(&one), map.len()), (None, 1));

    let rects = Damage::Rects(vec![[0, 0, 1, 1]]);
    assert_eq!(Damage::None.merge(rects.clone()), rects);
    assert_eq!(rects.clone().merge(Damage::Rects(vec![[2, 2, 3, 3]])), Damage::Rects(vec![[0, 0, 1, 1], [2, 2, 3, 3]]));
    assert_eq!(rects.merge(Damage::Full), Damage::Full);
    assert_eq!(serde_json::to_value(Damage::Rects(vec![[0, 0, 1, 1]])).unwrap(), json!({ "kind": "rects", "rects": [[0, 0, 1, 1]] }));
    assert_eq!(serde_json::to_value(Damage::None).unwrap(), json!({ "kind": "none" }));
}

/// Engines run sessions on worker threads (headless kits, MCP servers), so a session must be `Send`.
#[test]
fn a_session_can_move_to_another_thread() {
    fn assert_send<T: Send>() {}
    assert_send::<kition_kit::session::KitSession<Toy>>();
}

#[test]
fn a_draft_merges_as_one_undo_step_and_keeps_edits_made_meanwhile() {
    let mut live = first();
    let base = live.version();
    let before = ids(&live);
    let mut draft = live.fork(actor(9), Box::new(MemoryBlobs::default())).unwrap();
    let agent = Origin::agent("user:a").with_label("Merged the agent's draft");
    let (drafted, _) = draft.execute(&Origin::agent("user:a"), |_, tx| add_shape(tx, 30.0, "blue")).unwrap();
    assert_eq!(ids(&live), before, "the live document is untouched");
    let (mine, _) = live.execute(&person("a"), |_, tx| add_shape(tx, 50.0, "red")).unwrap();
    let damage = live.merge_changes(&draft.export_changes(&base).unwrap(), &agent).unwrap();
    assert_ne!(damage, Damage::None);
    assert!(ids(&live).contains(&drafted) && ids(&live).contains(&mine));
    assert_view_follows_replica(&live);
    assert!(live.undo().unwrap().0);
    assert!(!ids(&live).contains(&drafted) && ids(&live).contains(&mine));
    assert_view_follows_replica(&live);
}
