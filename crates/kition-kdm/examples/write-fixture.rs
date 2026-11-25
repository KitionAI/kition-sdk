//! Writes a document made by the Rust KDM, as its content and its canonical state, for another
//! implementation to prove it reads the same document (plan 2026-11-24, section 4: Rust writes,
//! TypeScript reads): `cargo run -p kition-kdm --example write-fixture -- <dir>` writes
//! `rust-page.content.json` and `rust-page.json` into `<dir>`.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args().nth(1).ok_or("usage: write-fixture <dir>")?;
    let schema = Arc::new(Schema::parse(include_str!("../tests/fixtures/test-schema.json"))?);
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
    std::fs::write(format!("{dir}/rust-page.content.json"), replica.content_snapshot()?)?;
    std::fs::write(format!("{dir}/rust-page.json"), replica.state_json()?.to_string())?;
    println!("{}", replica.state_hash()?);
    Ok(())
}
