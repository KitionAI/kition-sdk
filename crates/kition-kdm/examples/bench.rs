//! Phase 1 spike measurements (architecture section 6.6). Run in release:
//! `cargo run --release -p kition-kdm --example bench`. Prints one Markdown table row per case.

use std::sync::Arc;
use std::time::Instant;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

const SLIDES: &str = r#"{"kdm":1,"kit":"bench.slides","schemaVersion":1,"root":"Slides","types":{
  "Slides":{"fields":{"slides":{"kind":"list","of":"Slide"}}},
  "Slide":{"fields":{"hidden":{"kind":"boolean"},"shapes":{"kind":"list","of":"Shape"},"notes":{"kind":"text"}}},
  "Shape":{"fields":{"kind":{"kind":"enum","values":["rect","text","picture"]},"transform":{"kind":"json"},"fill":{"kind":"string"},"text":{"kind":"text"}}}}}"#;
const TABLE: &str = r#"{"kdm":1,"kit":"bench.table","schemaVersion":1,"root":"Table","types":{
  "Table":{"fields":{"name":{"kind":"string"},"records":{"kind":"map"}}},
  "Record":{"fields":{"name":{"kind":"string"},"email":{"kind":"string"},"stage":{"kind":"string"},"amount":{"kind":"string"},"owner":{"kind":"string"}}}}}"#;
const CAD: &str = r#"{"kdm":1,"kit":"bench.cad","schemaVersion":1,"root":"Drawing","types":{
  "Drawing":{"fields":{"entities":{"kind":"list","of":"Entity"}}},
  "Entity":{"fields":{"kind":{"kind":"enum","values":["line","circle","arc"]},"layer":{"kind":"string"},"geometry":{"kind":"json"}}}}}"#;
const DOC: &str = r#"{"kdm":1,"kit":"bench.doc","schemaVersion":1,"root":"Doc","types":{"Doc":{"fields":{"body":{"kind":"text"}}}}}"#;

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn origin() -> Origin {
    Origin::person("user:bench")
}

fn import() -> Origin {
    Origin::new(kition_kdm::OriginKind::Import, "user:bench")
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

struct Row {
    case: &'static str,
    build_ms: f64,
    snapshot_kb: usize,
    open_ms: f64,
    apply_1000_ms: f64,
}

/// Opens the snapshot on a second replica, makes 1000 single-field edits on the first, and
/// times applying them on the second one transaction at a time, as a live session would.
fn measure(case: &'static str, schema: Arc<Schema>, mut first: Replica, build_ms: f64, edit: impl Fn(&mut Replica, usize)) -> Row {
    let snapshot = first.snapshot().expect("snapshot");
    let start = Instant::now();
    let mut second = Replica::load(schema, &snapshot, ActorId::from_u64(2).expect("actor")).expect("load");
    let open_ms = ms(start);
    let mut batches = Vec::new();
    for index in 0..1000 {
        let since = first.version();
        edit(&mut first, index);
        batches.push(first.export_changes(&since).expect("export"));
    }
    let start = Instant::now();
    for batch in &batches {
        second.import_changes(batch).expect("import");
    }
    let apply_1000_ms = ms(start);
    assert_eq!(first.state_hash().expect("hash"), second.state_hash().expect("hash"));
    Row { case, build_ms, snapshot_kb: snapshot.len() / 1024, open_ms, apply_1000_ms }
}

fn slides() -> Row {
    let schema = Arc::new(Schema::parse(SLIDES).expect("slides schema"));
    let start = Instant::now();
    let mut shapes: Vec<ObjectId> = Vec::new();
    let (replica, ()) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).expect("actor"), &import(), |tx| {
        let slides = tx.create("Slides", Map::new())?;
        for s in 0..500 {
            let slide = tx.create("Slide", fields(json!({ "hidden": false })))?;
            tx.list_insert(&slides, "slides", s, &slide)?;
            for k in 0..20 {
                let shape =
                    tx.create("Shape", fields(json!({ "kind": "text", "transform": { "x": k * 10, "y": k * 5, "w": 200, "h": 40 }, "fill": "#ffffff" })))?;
                tx.text_insert(&shape, "text", 0, "Quarterly review 季度回顾")?;
                tx.list_insert(&slide, "shapes", k, &shape)?;
                shapes.push(shape);
            }
        }
        Ok(())
    })
    .expect("build slides");
    let build_ms = ms(start);
    measure("Slides: 500 slides × 20 shapes with text", schema, replica, build_ms, |replica, index| {
        let shape = shapes[index * 7 % shapes.len()].clone();
        replica.transact(&origin(), |tx| tx.set(&shape, "fill", json!(format!("#{index:06x}")))).expect("edit");
    })
}

/// Records as objects (the KDM rule for large collections), not 500,000 values in one map.
fn table() -> Row {
    let schema = Arc::new(Schema::parse(TABLE).expect("table schema"));
    let start = Instant::now();
    let (replica, records) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).expect("actor"), &import(), |tx| {
        tx.create("Table", fields(json!({ "name": "Leads" })))?;
        let mut records = Vec::new();
        for row in 0..100_000 {
            let mut values = Map::new();
            for field in ["name", "email", "stage", "amount", "owner"] {
                values.insert(field.to_owned(), json!(format!("{field} {row}")));
            }
            records.push(tx.create("Record", values)?);
        }
        Ok(records)
    })
    .expect("build table");
    let build_ms = ms(start);
    measure("Table: 100,000 records × 5 fields (one object per record)", schema, replica, build_ms, move |replica, index| {
        let record = records[index * 97 % records.len()].clone();
        replica.transact(&origin(), |tx| tx.set(&record, "stage", json!("won"))).expect("edit");
    })
}

/// The layout the rule forbids, kept to show why: 500,000 plain values in one map.
fn flat_map() -> Row {
    let schema = Arc::new(Schema::parse(TABLE).expect("table schema"));
    let start = Instant::now();
    let (replica, table) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).expect("actor"), &import(), |tx| {
        let table = tx.create("Table", fields(json!({ "name": "Leads" })))?;
        for key in 0..500_000 {
            tx.map_set(&table, "records", &format!("k{key}"), json!(format!("value {key}")))?;
        }
        Ok(table)
    })
    .expect("build map");
    let build_ms = ms(start);
    measure("Anti-pattern: one map with 500,000 plain values", schema, replica, build_ms, move |replica, index| {
        let key = format!("k{}", index * 97 % 500_000);
        replica.transact(&origin(), |tx| tx.map_set(&table, "records", &key, json!("won"))).expect("edit");
    })
}

fn cad() -> Row {
    let schema = Arc::new(Schema::parse(CAD).expect("cad schema"));
    let start = Instant::now();
    let mut entities = Vec::new();
    let (replica, ()) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).expect("actor"), &import(), |tx| {
        let drawing = tx.create("Drawing", Map::new())?;
        for index in 0..10_000 {
            let entity = tx.create("Entity", fields(json!({ "kind": "line", "layer": "0", "geometry": { "from": [index, 0], "to": [index, 100] } })))?;
            tx.list_insert(&drawing, "entities", index, &entity)?;
            entities.push(entity);
        }
        Ok(())
    })
    .expect("build drawing");
    let build_ms = ms(start);
    measure("CAD: 10,000 entities", schema, replica, build_ms, |replica, index| {
        let entity = entities[index * 13 % entities.len()].clone();
        replica.transact(&origin(), |tx| tx.set(&entity, "geometry", json!({ "from": [index, 1], "to": [index, 99] }))).expect("edit");
    })
}

fn document() -> Row {
    let schema = Arc::new(Schema::parse(DOC).expect("doc schema"));
    let start = Instant::now();
    let mut replica = Replica::create(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1).expect("actor")).expect("create");
    let doc = replica.transact(&origin(), |tx| tx.create("Doc", Map::new())).expect("doc");
    for paragraph in 0..2_000 {
        replica
            .transact(&origin(), |tx| {
                let at = tx.text_len(&doc, "body")?;
                tx.text_insert(&doc, "body", at, &format!("Paragraph {paragraph}: 中文混排 text with emoji 😀 and more words.\n"))
            })
            .expect("type");
    }
    let build_ms = ms(start);
    measure("Text: 2,000 paragraphs typed one transaction each", schema, replica, build_ms, move |replica, index| {
        replica.transact(&origin(), |tx| tx.text_insert(&doc, "body", index * 31 % 1000, "x")).expect("keystroke");
    })
}

fn main() {
    println!("| Case | Build (ms) | Snapshot (KB) | Open snapshot (ms) | Apply 1,000 remote edits (ms) |");
    println!("| --- | ---: | ---: | ---: | ---: |");
    for row in [slides(), table(), cad(), document(), flat_map()] {
        println!("| {} | {:.0} | {} | {:.1} | {:.1} |", row.case, row.build_ms, row.snapshot_kb, row.open_ms, row.apply_1000_ms);
    }
}
