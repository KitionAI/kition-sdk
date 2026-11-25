//! The write path of many small transactions, as a kit's import builds a sheet: each makes a cell
//! object and writes one key of one growing map. Run in release:
//! `cargo run --release -p kition-kdm --example write_path [cells]`. Prints one line per case.

use std::sync::Arc;
use std::time::Instant;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, json};

const SHEET: &str = r#"{"kdm":1,"kit":"bench.sheet","schemaVersion":1,"root":"Sheet","types":{
  "Sheet":{"fields":{"cells":{"kind":"map","of":"Cell","owns":true},"values":{"kind":"map"}}},
  "Cell":{"fields":{"value":{"kind":"string"},"row":{"kind":"integer"},"style":{"kind":"json","optional":true}}}}}"#;

fn sheet() -> (Replica, ObjectId) {
    let schema = Arc::new(Schema::parse(SHEET).expect("schema"));
    Replica::create_with(schema, DocId::new(), ActorId::from_u64(1).expect("actor"), &Origin::system("create"), |tx| tx.create("Sheet", Map::new()))
        .expect("sheet")
}

fn cell(at: usize) -> Map<String, serde_json::Value> {
    Map::from_iter([("value".to_owned(), json!(format!("v{at}"))), ("row".to_owned(), json!(at))])
}

/// `cells` transactions of `per` writes each; `what` says what one write is.
fn run(case: &str, cells: usize, per: usize, origin: &Origin, write: impl Fn(&mut kition_kdm::Tx<'_>, &ObjectId, usize) -> kition_kdm::Result<()>) {
    let (mut replica, sheet) = sheet();
    let start = Instant::now();
    let mut at = 0;
    let mut tenth = start.elapsed();
    while at < cells {
        replica
            .transact(origin, |tx| {
                for one in at..(at + per).min(cells) {
                    write(tx, &sheet, one)?;
                }
                Ok(())
            })
            .expect("transaction");
        at += per;
        if at == cells / 10 {
            tenth = start.elapsed();
        }
    }
    let took = start.elapsed();
    let last = took.saturating_sub(tenth).as_secs_f64() / 0.9;
    println!(
        "{case}: {cells} writes, {per} a transaction: {:.2} s, {:.0} ns a write; first tenth {:.0} ns a write, the rest {:.0} ns",
        took.as_secs_f64(),
        took.as_secs_f64() * 1e9 / cells as f64,
        tenth.as_secs_f64() * 1e9 / (cells as f64 / 10.0),
        last * 1e9 / cells as f64,
    );
}

/// `cells` transactions each making a cell with a style and its key, each followed by reads of
/// what it wrote, as a kit's view takes a change in.
fn read_back(cells: usize) {
    let (mut replica, sheet) = sheet();
    let import = Origin::new(kition_kdm::OriginKind::Import, "bench");
    let start = Instant::now();
    for at in 0..cells {
        let (made, key) = replica
            .transact(&import, |tx| {
                let mut fields = cell(at);
                fields.insert("style".to_owned(), json!({ "bold": at % 2 == 0, "fill": "#ffeecc", "border": [1, 0, 1, 0] }));
                let made = tx.create("Cell", fields)?;
                let key = format!("{made}:{made}");
                tx.map_set(&sheet, "cells", &key, json!(made.to_string()))?;
                Ok((made, key))
            })
            .expect("transaction");
        let held = replica.map_get(&sheet, "cells", &key).expect("key");
        let style = replica.get(&made, "style").expect("style");
        assert!(held.is_string() && style.is_object());
    }
    let took = start.elapsed();
    println!("cell, key and style, read back: {cells} writes: {:.2} s, {:.0} ns a write", took.as_secs_f64(), took.as_secs_f64() * 1e9 / cells as f64);
}

fn main() {
    let cells: usize = std::env::args().nth(1).and_then(|text| text.parse().ok()).unwrap_or(1_000_000);
    let import = Origin::new(kition_kdm::OriginKind::Import, "bench");
    let person = Origin::person("user:bench");
    run("cell and key (import)", cells, 1, &import, |tx, sheet, at| {
        let made = tx.create("Cell", cell(at))?;
        tx.map_set(sheet, "cells", &format!("{made}:{made}"), json!(made.to_string()))
    });
    run("cell and key (person)", cells, 1, &person, |tx, sheet, at| {
        let made = tx.create("Cell", cell(at))?;
        tx.map_set(sheet, "cells", &format!("{made}:{made}"), json!(made.to_string()))
    });
    run("cell only", cells, 1, &import, |tx, _, at| tx.create("Cell", cell(at)).map(drop));
    run("key only", cells, 1, &import, |tx, sheet, at| tx.map_set(sheet, "values", &format!("k{at}"), json!(at)));
    read_back(cells);
    run("cell and key, 1000 a transaction", cells, 1000, &import, |tx, sheet, at| {
        let made = tx.create("Cell", cell(at))?;
        tx.map_set(sheet, "cells", &format!("{made}:{made}"), json!(made.to_string()))
    });
}
