//! Which commands an agent is offered take a path in a plain string (KHP A28), as
//! `kition_kit::testing::check_file_parameters` finds them.
//!
//! `cargo run -p kition-kit --example file-params-report -- commands.json [kit.json]` reads a JSON
//! list of `{ "id", "schema" }` (a kit's `commands()`) and the kit's manifest (for
//! `agent.include` and `agent.exclude`), and prints each flagged parameter, one per line.
use kition_kit::KitCommand;
use serde_json::Value;

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or("usage: file-params-report <commands.json> [kit.json]")?;
    let read = |path: &str| std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"));
    let manifest = match args.next() {
        Some(manifest) => read(&manifest)?,
        None => "{}".to_owned(),
    };
    let listed: Vec<Value> = serde_json::from_str(&read(&path)?).map_err(|error| format!("{path}: {error}"))?;
    let commands: Vec<KitCommand> = listed
        .iter()
        .map(|command| KitCommand {
            id: command["id"].as_str().unwrap_or_default().to_owned(),
            schema: command.get("schema").filter(|schema| schema.is_object()).cloned(),
            mutates: command["mutates"] == true,
            ..Default::default()
        })
        .collect();
    let problems = kition_kit::testing::check_file_parameters(&commands, &manifest, &[]).err().unwrap_or_default();
    let offending: std::collections::BTreeSet<&str> = problems.iter().filter_map(|problem| problem.split(':').next()).collect();
    println!("{path}: {} commands, {} offering a path in a plain string, {} parameters", commands.len(), offending.len(), problems.len());
    for problem in &problems {
        println!("  {problem}");
    }
    Ok(())
}
