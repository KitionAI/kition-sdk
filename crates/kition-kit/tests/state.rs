//! `take_file` and `write_state`: a file's state written over the replica a host stored for the
//! same document, keyed by object id, when the file's history does not reach the replica's
//! (kition-sdk data model 7.3), and the file's changes when it does.

use std::sync::Arc;

use kition_kit::kdm::{ActorId, DocId, KdmError, ObjectId, Origin, OriginKind, Replica, Schema};
use kition_kit::session::{KitError, state, take_file};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.state", "schemaVersion": 1, "root": "Doc",
  "types": {
    "Doc": { "fields": {
      "title": { "kind": "string" },
      "items": { "kind": "list", "of": "Item" },
      "outline": { "kind": "tree", "of": "Item" },
      "cells": { "kind": "map" },
      "lead": { "kind": "ref", "of": "Item", "optional": true }
    } },
    "Item": { "fields": {
      "name": { "kind": "string" },
      "body": { "kind": "text", "marks": { "bold": { "expand": "after" } } },
      "size": { "kind": "number", "optional": true }
    } }
  }
}"#;

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(SCHEMA).unwrap())
}

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn doc() -> ObjectId {
    ObjectId::from_string("doc")
}

/// A document with three items in its list and its outline (`b` under `a`), a marked body, two
/// cells and a lead.
fn made() -> (Replica, Vec<ObjectId>) {
    let mut replica = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let items = replica
        .transact(&person(), |tx| {
            tx.create_with_id("Doc", &doc(), fields(json!({ "title": "First" })))?;
            let mut items = Vec::new();
            for (index, name) in ["a", "b", "c"].into_iter().enumerate() {
                let item = tx.create("Item", fields(json!({ "name": name })))?;
                tx.list_insert(&doc(), "items", index, &item)?;
                tx.text_insert(&item, "body", 0, &format!("body of {name}"))?;
                items.push(item);
            }
            tx.text_mark(&items[0], "body", 0, 4, "bold", json!(true))?;
            let a = tx.tree_create(&doc(), "outline", None, &items[0])?;
            tx.tree_create(&doc(), "outline", Some(&a), &items[1])?;
            tx.tree_create(&doc(), "outline", None, &items[2])?;
            tx.map_set(&doc(), "cells", "A1", json!(1))?;
            tx.map_set(&doc(), "cells", "B2", json!("two"))?;
            tx.set(&doc(), "lead", json!(items[0].to_string()))?;
            Ok(items)
        })
        .unwrap();
    (replica, items)
}

/// Edits of every kind: a new item (in the list, under `c` in the outline, with a marked body), `b`
/// deleted, `c` moved to the front of the list and made a root before `a`, `a`'s body retyped
/// and its bold moved, a cell removed and one added, the lead changed and the title retitled.
fn edit_everything(replica: &mut Replica, items: &[ObjectId]) -> ObjectId {
    let (a, b, c) = (&items[0], &items[1], &items[2]);
    replica
        .transact(&person(), |tx| {
            let d = tx.create("Item", fields(json!({ "name": "d", "size": 4 })))?;
            tx.list_insert(&doc(), "items", 3, &d)?;
            tx.text_insert(&d, "body", 0, "new body")?;
            tx.text_mark(&d, "body", 4, 8, "bold", json!(true))?;
            let tree = tx.tree(&doc(), "outline")?;
            let node = |object: &ObjectId| tree.iter().find(|entry| &entry.object == object).map(|entry| entry.node.clone()).unwrap();
            tx.tree_create(&doc(), "outline", Some(&node(c)), &d)?;
            let at = tx.list_items(&doc(), "items")?.iter().position(|item| item == b).unwrap();
            tx.list_remove(&doc(), "items", at)?;
            tx.tree_move(&doc(), "outline", &node(b), None)?;
            tx.delete(b)?;
            let at = tx.list_items(&doc(), "items")?.iter().position(|item| item == c).unwrap();
            tx.list_move(&doc(), "items", at, 0)?;
            tx.tree_move(&doc(), "outline", &node(a), None)?;
            tx.text_insert(a, "body", 0, "new ")?;
            tx.text_unmark(a, "body", 4, 8, "bold")?;
            tx.text_mark(a, "body", 0, 3, "bold", json!(true))?;
            tx.map_delete(&doc(), "cells", "A1")?;
            tx.map_set(&doc(), "cells", "C3", json!([3]))?;
            tx.set(&doc(), "lead", json!(c.to_string()))?;
            tx.set(&doc(), "title", json!("Second"))?;
            Ok(d)
        })
        .unwrap()
}

#[test]
fn a_file_saved_from_changes_the_store_lacks_is_written_over_it_by_object_id() {
    let (mut source, items) = made();
    // The store kept the document before the edits; the file was saved after them elsewhere.
    let mut ours = Replica::load(schema(), &source.snapshot().unwrap(), actor(2)).unwrap();
    let d = edit_everything(&mut source, &items);
    let file = Replica::load(schema(), &source.content_snapshot().unwrap(), actor(3)).unwrap();
    assert!(!ours.version().includes(&file.shallow_root().unwrap()), "the file's history does not reach the store's");
    let before = ours.version();
    let held = Replica::snapshot_origins(&ours.snapshot().unwrap()).unwrap().len();
    assert!(take_file(&mut ours, &file).unwrap());
    assert_eq!(state(&ours).unwrap(), state(&file).unwrap());
    assert_eq!(ours.get(&doc(), "lead").unwrap(), json!(items[2].to_string()));
    assert!(ours.exists(&d) && !ours.exists(&items[1]));
    let outline: Vec<(ObjectId, Option<ObjectId>)> = {
        let tree = ours.tree(&doc(), "outline").unwrap();
        tree.iter()
            .map(|entry| (entry.object.clone(), entry.parent.as_ref().and_then(|parent| tree.iter().find(|e| &e.node == parent)).map(|e| e.object.clone())))
            .collect()
    };
    assert_eq!(outline, vec![(items[2].clone(), None), (d.clone(), Some(items[2].clone())), (items[0].clone(), None)]);
    // One system transaction labelled import, which is no undo step.
    let origins = Replica::snapshot_origins(&ours.snapshot().unwrap()).unwrap();
    assert_eq!(origins.len(), held + 1, "{origins:?}");
    assert_eq!(origins.iter().filter(|origin| **origin == Some(Origin::system("import"))).count(), 1);
    assert!(origins.iter().flatten().any(|origin| origin.kind == OriginKind::System));
    assert!(ours.version().includes(&before));
    assert!(!ours.can_undo());
    // A state that already agrees writes nothing.
    let version = ours.version();
    let again = Replica::load(schema(), &file.snapshot().unwrap(), actor(4)).unwrap();
    assert!(!take_file(&mut ours, &again).unwrap());
    assert_eq!(ours.version(), version);
}

/// The nodes of `outline` in a canonical state, as `(object, parent object)`, dead ones included.
fn outline_nodes(state: &kition_kit::session::State) -> Vec<(String, Option<String>)> {
    fn walk(nodes: &Value, parent: Option<&str>, out: &mut Vec<(String, Option<String>)>) {
        for node in nodes.as_array().into_iter().flatten() {
            let object = node["object"].as_str().unwrap().to_owned();
            out.push((object.clone(), parent.map(str::to_owned)));
            walk(&node["children"], Some(&object), out);
        }
    }
    let mut out = Vec::new();
    walk(&state["doc"]["outline"], None, &mut out);
    out
}

/// A deleted item keeps its tree node (an undo of the delete brings the item back into it), and
/// the file's state names it. Written over a store that holds the same dead node, the state adds
/// no node of its own for the deleted item (kition-layout's file taken in by state).
#[test]
fn a_file_taken_in_by_state_adds_no_node_for_a_deleted_item() {
    let (mut source, items) = made();
    source.transact(&person(), |tx| tx.delete(&items[1])).unwrap();
    // The store kept the document after the delete; the file was saved after one more edit,
    // which changes the outline too (a new root item), so the outline is written.
    let mut ours = Replica::load(schema(), &source.snapshot().unwrap(), actor(2)).unwrap();
    source
        .transact(&person(), |tx| {
            let e = tx.create("Item", fields(json!({ "name": "e" })))?;
            tx.tree_create(&doc(), "outline", None, &e)?;
            tx.set(&doc(), "title", json!("Second"))
        })
        .unwrap();
    let file = Replica::load(schema(), &source.content_snapshot().unwrap(), actor(3)).unwrap();
    assert!(!ours.version().includes(&file.shallow_root().unwrap()), "the file's history does not reach the store's");
    let dead = items[1].to_string();
    assert!(outline_nodes(&state(&file).unwrap()).iter().any(|(object, _)| *object == dead), "the file's outline names the deleted item");
    assert!(take_file(&mut ours, &file).unwrap());
    assert_eq!(state(&ours).unwrap(), state(&file).unwrap());
    assert_eq!(outline_nodes(&state(&ours).unwrap()).iter().filter(|(object, _)| *object == dead).count(), 1, "one node for the deleted item");
    assert!(!ours.exists(&items[1]));
}

#[test]
fn a_file_whose_history_reaches_the_store_brings_its_changes() {
    let (mut source, items) = made();
    let content = source.content_snapshot().unwrap();
    // The store has the seal; the file was opened, edited and saved again.
    let mut ours = Replica::load(schema(), &source.snapshot().unwrap(), actor(2)).unwrap();
    let mut file = Replica::load(schema(), &content, actor(3)).unwrap();
    file.transact(&person(), |tx| tx.set(&items[0], "name", json!("renamed"))).unwrap();
    assert!(take_file(&mut ours, &file).unwrap());
    assert!(ours.version().includes(&file.version()));
    assert_eq!(ours.get(&items[0], "name").unwrap(), json!("renamed"));
    // Nothing more to take.
    assert!(!take_file(&mut ours, &file).unwrap());
}

#[test]
fn a_file_of_another_document_is_refused() {
    let (mut ours, _) = made();
    let (other, _) = made();
    let refused = take_file(&mut ours, &other).unwrap_err();
    assert!(matches!(refused, KitError::Kdm(KdmError::WrongDocument { .. })), "{refused:?}");
}
