//! Lists the parameters that fell back to `json`, grouped by their notation: `schema-loose commands.json`.
use std::collections::BTreeMap;
fn main() {
    let path = std::env::args().nth(1).unwrap_or_default();
    let commands: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_default()).unwrap_or_default();
    let mut groups: BTreeMap<String, usize> = BTreeMap::new();
    for command in &commands {
        let Ok(converted) = kition_kit::schema::from_kit_params(command["params"].as_str().unwrap_or("")) else { continue };
        for (key, node) in converted.schema.as_object().into_iter().flatten() {
            if node["type"] == "json" {
                let text = node["description"].as_str().unwrap_or("").replace(&format!("{key} "), "");
                let shape: String = text.chars().take(40).collect();
                *groups.entry(shape).or_default() += 1;
            }
        }
    }
    let mut sorted: Vec<_> = groups.into_iter().collect();
    sorted.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    for (shape, count) in sorted.iter().take(40) {
        println!("{count:4}  {shape}");
    }
}
