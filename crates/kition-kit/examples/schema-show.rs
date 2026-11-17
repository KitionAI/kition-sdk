//! Prints the converted schema of chosen commands: `schema-show commands.json id…`.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let commands: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap_or_default()).unwrap_or_default();
    for id in &args[2..] {
        if let Some(command) = commands.iter().find(|command| command["id"] == id.as_str()) {
            let params = command["params"].as_str().unwrap_or("");
            println!(
                "== {id}\n  {}\n  {}",
                params.chars().take(220).collect::<String>(),
                kition_kit::schema::from_kit_params(params).map(|c| c.schema.to_string()).unwrap_or_else(|e| e).chars().take(900).collect::<String>()
            );
        }
    }
}
