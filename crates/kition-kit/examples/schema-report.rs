//! How well a kit's command parameters convert to agent schemas (standard E7, A5).
//!
//! `cargo run -p kition-kit --example schema-report -- commands.json` reads a JSON list of
//! `{ "id", "params" }` (a kit's `commands()`), converts every `params` with
//! `kition_kit::schema::from_kit_params`, validates the result, and prints the coverage and the
//! commands that need attention.
use kition_kit::schema::{from_kit_params, validate};
use serde_json::Value;

fn main() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("usage: schema-report <commands.json>")?;
    let text = std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
    let commands: Vec<Value> = serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))?;
    let (mut converted, mut failed, mut properties, mut precise, mut invalid) = (0usize, Vec::new(), 0usize, 0usize, Vec::new());
    let mut loose = Vec::new();
    for command in &commands {
        let id = command["id"].as_str().unwrap_or("?");
        let params = command["params"].as_str().unwrap_or("");
        match from_kit_params(params) {
            Ok(result) => {
                if let Err(error) = validate(&result.schema) {
                    invalid.push(format!("{id}: {error}"));
                    continue;
                }
                converted += 1;
                properties += result.properties;
                precise += result.precise;
                if result.precise < result.properties {
                    loose.push((result.properties - result.precise, id.to_owned()));
                }
            }
            Err(error) => failed.push(format!("{id}: {error} — {}", params.chars().take(90).collect::<String>())),
        }
    }
    println!("{path}: {} commands", commands.len());
    println!(
        "  converted {converted} ({:.1}%), not an object {} , invalid {}",
        100.0 * converted as f64 / commands.len().max(1) as f64,
        failed.len(),
        invalid.len()
    );
    println!("  parameters {properties}, typed precisely {precise} ({:.1}%)", 100.0 * precise as f64 / properties.max(1) as f64);
    for line in failed.iter().take(8) {
        println!("  not converted: {line}");
    }
    for line in invalid.iter().take(8) {
        println!("  INVALID: {line}");
    }
    loose.sort_by_key(|entry| std::cmp::Reverse(entry.clone()));
    for (count, id) in loose.iter().take(6) {
        println!("  loosest: {id} ({count} untyped)");
    }
    if invalid.is_empty() { Ok(()) } else { Err(format!("{} invalid schemas", invalid.len())) }
}
