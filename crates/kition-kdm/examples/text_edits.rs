//! The cost of scattered text edits in one transaction on a large text: the replica transaction
//! of an external merge into a 1 MB note (kition-note `docs/performance.md`, budget 100 ms for the
//! whole merge). Run in release:
//!
//! `cargo run --release -p kition-kdm --example text_edits [-- --check] [--runs <n>]`
//!
//! The text is imported in one insert, as a kit imports a file. `--check` exits 1 when the 1 MB
//! transaction takes more than its budget, or when an edit on 1 MB costs more than four times an
//! edit on 64 KB (the cost of an edit must not grow with the document).

use std::sync::Arc;
use std::time::Instant;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};

const DOC: &str = r#"{"kdm":1,"kit":"bench.note","schemaVersion":1,"root":"Note","types":{"Note":{"fields":{"body":{"kind":"text"}}}}}"#;

/// The replica transaction's share of the 100 ms merge budget (the diff takes about 25 ms).
const BUDGET_MS: f64 = 50.0;

/// About `chars` characters of prose with CJK and emoji: no engine fast path for ASCII applies.
fn text_of(chars: usize) -> String {
    let line: String = "Goals for the quarter, with a table and a list. "
        .chars()
        .chain([0x5B63, 0x5EA6, 0x20, 0x1F642, 0x0A].iter().filter_map(|&point| char::from_u32(point)))
        .collect();
    line.repeat(chars / line.chars().count() + 1)
}

/// Milliseconds for one `system` transaction of `edits` scattered edits (delete one character,
/// insert one), last first, as a merge applies them; the median of `runs`.
fn measure(text: &str, edits: usize, runs: usize) -> f64 {
    let schema = Arc::new(Schema::parse(DOC).expect("schema"));
    let len = text.chars().count();
    let step = len / (edits + 1);
    let mut samples: Vec<f64> = (0..runs)
        .map(|_| {
            let (mut replica, id) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::random(), &Origin::system("import"), |tx| {
                let id: ObjectId = tx.create("Note", Default::default())?;
                tx.text_insert(&id, "body", 0, text)?;
                Ok(id)
            })
            .expect("import");
            let start = Instant::now();
            replica
                .transact(&Origin::system("import"), |tx| {
                    for k in (1..=edits).rev() {
                        tx.text_delete(&id, "body", k * step, 1)?;
                        tx.text_insert(&id, "body", k * step, "x")?;
                    }
                    Ok(())
                })
                .expect("edits");
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let check = args.iter().any(|arg| arg == "--check");
    let runs = args.iter().position(|arg| arg == "--runs").and_then(|at| args.get(at + 1)).and_then(|runs| runs.parse().ok()).unwrap_or(7);
    // Spread edits through the sample text.
    let large = measure(&text_of(1_000_000), 5_817, runs);
    let small = measure(&text_of(64_000), 372, runs);
    let ratio = (large / 5_817.0) / (small / 372.0);
    println!("| Case | Median (ms) |");
    println!("|---|---|");
    println!("| 5,817 scattered edits on 1 MB, one transaction | {large:.1} |");
    println!("| 372 scattered edits on 64 KB, one transaction | {small:.1} |");
    println!("\nCost of an edit on 1 MB against one on 64 KB: {ratio:.2}x. Budget on 1 MB: {BUDGET_MS} ms.");
    if check && (large > BUDGET_MS || ratio > 4.0) {
        eprintln!("text_edits: over budget");
        std::process::exit(1);
    }
}
