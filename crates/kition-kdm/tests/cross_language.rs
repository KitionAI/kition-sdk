//! Rust writes, other implementations read (plan 2026-11-24, section 4): the canonical content
//! fixtures under `fixtures/content/`, which the TypeScript reader checks, are what this crate's
//! replicas write. The board fixture is built here with transactions, as a kit builds a document,
//! and its content is the fixture's bytes exactly.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/content/schema.json")).expect("content schema parses"))
}

fn id(suffix: &str) -> ObjectId {
    ObjectId::from_string(format!("0193a5c4-0000-7000-8000-0000000000{suffix}"))
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[test]
fn a_document_built_by_transactions_writes_the_board_fixture_exactly() {
    let doc = DocId::parse("0193a5c4-0000-7000-8000-000000000001").unwrap();
    let mut replica = Replica::create(schema(), doc, ActorId::from_u64(1).unwrap()).unwrap();
    let person = Origin::person("user:test");
    let (board, p1, p2, p3) = (id("a1"), id("b1"), id("b2"), id("b3"));
    let image = json!({ "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "mime": "image/png", "size": 5120 });
    replica
        .transact(&person, |tx| {
            tx.create_with_id("Board", &board, fields(json!({ "title": "Q4" })))?;
            tx.create_with_id("Page", &p2, fields(json!({ "name": "" })))?;
            tx.create_with_id(
                "Page",
                &p1,
                fields(json!({ "name": "Page 1", "kind": "sticky", "count": 3, "done": false, "scale": 0.5, "box": [0, 0, 200, 120], "image": image, "next": p2.as_str() })),
            )?;
            tx.create_with_id("Page", &p3, fields(json!({ "name": "Page 3", "kind": "frame", "count": 0, "done": true, "scale": -2.25, "box": {} })))?;
            for (index, page) in [&p1, &p2, &p3].into_iter().enumerate() {
                tx.list_insert(&board, "pages", index, page)?;
            }
            let first = tx.tree_create(&board, "outline", None, &p1)?;
            tx.tree_create(&board, "outline", None, &p3)?;
            tx.tree_create(&board, "outline", Some(&first), &p2)?;
            tx.map_set(&board, "vars", "zoom", json!(1.5))?;
            tx.map_set(&board, "vars", "gap", json!(8))?;
            tx.text_insert(&p1, "body", 0, "Ship it")?;
            tx.text_mark(&p1, "body", 5, 7, "bold", json!(true))?;
            tx.text_insert(&p3, "body", 0, "site")?;
            tx.text_mark(&p3, "body", 0, 4, "link", json!("https://kition.ai"))?;
            // Typed and deleted: an empty text is left out.
            tx.text_insert(&board, "notes", 0, "draft")?;
            tx.text_delete(&board, "notes", 0, 5)
        })
        .unwrap();
    let written = String::from_utf8(replica.content_snapshot().unwrap()).unwrap();
    assert_eq!(written, include_str!("fixtures/content/board.content.json"));
    // Read back, it is the same document and writes the same bytes.
    let read = Replica::load(schema(), written.as_bytes(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(read.state_json().unwrap(), replica.state_json().unwrap());
    assert_eq!(String::from_utf8(read.content_snapshot().unwrap()).unwrap(), written);
}
