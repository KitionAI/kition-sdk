//! Writes a snapshot made by the Rust KDM and its canonical state, for the TypeScript
//! implementation to prove it reads the same document:
//! `cargo run -p kition-kdm --example write-fixture -- <dir>` writes `rust-page.bin` and
//! `rust-page.json` into `<dir>`; `... -- <dir> shallow` writes only `rust-shallow.bin` and
//! `rust-shallow.json`, a shallow snapshot (standard 2.0 rule M16a) of the same kind of document
//! with more edits after its root; `... -- <dir> new-document` writes only
//! `rust-new-document.bin` and `rust-new-document.json`, the committed `<dir>/rust-page.bin` copied
//! as a new document (`Replica::copy_as_new_document`) under docId
//! `01920000-0000-7000-8000-000000000002`; `... -- <dir> shallow-export` writes only
//! `rust-shallow-export.bin` and `rust-shallow-export.json`, the committed
//! `<dir>/rust-new-document.bin` (a shallow replica) with its page retitled, as it answers every
//! change (`export_changes(&Version::empty())`); `... -- <dir> birth` writes only `rust-birth.bin`
//! and `rust-birth-truncated.bin`, the committed `<dir>/rust-page.bin` copied as a new document under
//! docId `01920000-0000-7000-8000-000000000003` with its page retitled, as its snapshot (rooted at
//! its birth: it carries the whole history) and as a shallow snapshot at its last version (it does
//! not).

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, Origin, Replica, Schema, Version};
use serde_json::{Map, Value, json};

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args().nth(1).ok_or("usage: write-fixture <dir>")?;
    let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json"))?);
    if std::env::args().nth(2).as_deref() == Some("new-document") {
        let page = Replica::load(schema, &std::fs::read(format!("{dir}/rust-page.bin"))?, ActorId::from_u64(7)?)?;
        let copy = page.copy_as_new_document(DocId::parse("01920000-0000-7000-8000-000000000002")?, ActorId::from_u64(8)?)?;
        std::fs::write(format!("{dir}/rust-new-document.bin"), copy.snapshot()?)?;
        std::fs::write(format!("{dir}/rust-new-document.json"), copy.state_json()?.to_string())?;
        println!("{}", copy.state_hash()?);
        return Ok(());
    }
    if std::env::args().nth(2).as_deref() == Some("birth") {
        let page = Replica::load(schema, &std::fs::read(format!("{dir}/rust-page.bin"))?, ActorId::from_u64(7)?)?;
        let mut copy = page.copy_as_new_document(DocId::parse("01920000-0000-7000-8000-000000000003")?, ActorId::from_u64(10)?)?;
        let title = copy.objects_of_type("Page").into_iter().next().ok_or("no page")?;
        copy.transact(&Origin::person("user:fixture"), |tx| tx.set(&title, "title", json!("Born page")))?;
        std::fs::write(format!("{dir}/rust-birth.bin"), copy.snapshot()?)?;
        std::fs::write(format!("{dir}/rust-birth-truncated.bin"), copy.shallow_snapshot(&copy.version())?)?;
        return Ok(());
    }
    if std::env::args().nth(2).as_deref() == Some("shallow-export") {
        let mut copy = Replica::load(schema, &std::fs::read(format!("{dir}/rust-new-document.bin"))?, ActorId::from_u64(9)?)?;
        let page = copy.objects_of_type("Page").into_iter().next().ok_or("no page")?;
        copy.transact(&Origin::person("user:fixture"), |tx| tx.set(&page, "title", json!("Forked page")))?;
        std::fs::write(format!("{dir}/rust-shallow-export.bin"), copy.export_changes(&Version::empty())?)?;
        std::fs::write(format!("{dir}/rust-shallow-export.json"), copy.state_json()?.to_string())?;
        println!("{}", copy.state_hash()?);
        return Ok(());
    }
    let mut replica = Replica::create(schema, DocId::parse("01920000-0000-7000-8000-000000000001")?, ActorId::from_u64(7)?)?;
    replica.transact(&Origin::person("user:fixture"), |tx| {
        let page = tx.create("Page", fields(json!({ "title": "Fixture 页面" })))?;
        let a = tx.create("Shape", fields(json!({ "kind": "rect", "x": 12.5, "y": 40, "fill": "#5645d4" })))?;
        let b = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 3, "y": 4, "transform": { "rotate": 90, "scale": [1, 2] } })))?;
        // Awkward values: the integer limits, whole doubles on both sides of 2^53, negative zero,
        // the smallest subnormal, and control characters (NUL included) in strings and text.
        let c = tx.create(
            "Shape",
            fields(json!({
                "kind": "rect",
                "x": 9_007_199_254_740_992_i64,
                "y": -9_007_199_254_740_992_i64,
                "fill": "nul\u{0}ctl\u{1}\u{1f}\u{7f}",
                "transform": { "big": 1e16, "mid": 9.1e15, "negzero": -0.0, "tiny": 5e-324, "limits": [9_007_199_254_740_992_i64, -9_007_199_254_740_992_i64] },
            })),
        )?;
        tx.list_insert(&page, "shapes", 0, &a)?;
        tx.list_insert(&page, "shapes", 1, &b)?;
        // A moved item: `c` is inserted first and moved to the end, after `a` and `b`.
        tx.list_insert(&page, "shapes", 0, &c)?;
        tx.list_move(&page, "shapes", 0, 2)?;
        tx.text_insert(&a, "label", 0, "季度😀回顾")?;
        tx.text_insert(&c, "label", 0, "\u{0}tab\there\nline\u{1}\u{1b}[0m\"\\")?;
        let root = tx.tree_create(&page, "outline", None, &a)?;
        tx.tree_create(&page, "outline", Some(&root), &b)?;
        // Map keys that sort differently by UTF-16 code unit and by code point.
        let sheet = tx.create("Sheet", Map::new())?;
        tx.map_set(&sheet, "cells", "\u{ffff}", json!(1))?;
        tx.map_set(&sheet, "cells", "😀", json!({ "v": -0.0, "s": "\u{0}" }))?;
        tx.map_set(&sheet, "cells", "a", json!([1e16, 9.1e15, 5e-324]))?;
        Ok(())
    })?;
    if std::env::args().nth(2).as_deref() == Some("shallow") {
        let root = replica.version();
        let shapes = replica.objects_of_type("Shape");
        let page = replica.objects_of_type("Page").into_iter().next().ok_or("no page")?;
        for (step, shape) in shapes.iter().enumerate() {
            replica.transact(&Origin::person("user:fixture"), |tx| {
                tx.text_insert(shape, "label", 0, &format!("after root {step} "))?;
                tx.set(shape, "x", json!(step))
            })?;
        }
        replica.transact(&Origin::person("user:fixture"), |tx| tx.set(&page, "title", json!("Shallow page")))?;
        std::fs::write(format!("{dir}/rust-shallow.bin"), replica.shallow_snapshot(&root)?)?;
        std::fs::write(format!("{dir}/rust-shallow.json"), replica.state_json()?.to_string())?;
        println!("{}", replica.state_hash()?);
        return Ok(());
    }
    std::fs::write(format!("{dir}/rust-page.bin"), replica.snapshot()?)?;
    std::fs::write(format!("{dir}/rust-page.json"), replica.state_json()?.to_string())?;
    println!("{}", replica.state_hash()?);
    Ok(())
}
