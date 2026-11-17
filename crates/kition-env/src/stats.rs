//! What a file of tasks holds: tasks per kind and direction, and the edits sampled and
//! discarded before them, by reason.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::Task;

/// `{ tasks, forward, inverse, kinds: { <kind>: n }, resampled: { <reason>: n }, resampledKinds:
/// { <kind>: { <reason>: n } } }`.
pub fn stats(tasks: &[Task]) -> Value {
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for task in tasks {
        *kinds.entry(task.kind.as_str()).or_default() += 1;
        for discarded in &task.resampled {
            let reason = discarded["reason"].as_str().unwrap_or("unknown").to_owned();
            let kind = discarded["kind"].as_str().unwrap_or("unknown").to_owned();
            *reasons.entry(reason.clone()).or_default() += 1;
            *by_kind.entry(kind).or_default().entry(reason).or_default() += 1;
        }
    }
    let inverse = tasks.iter().filter(|task| task.inverse).count();
    json!({
        "tasks": tasks.len(),
        "forward": tasks.len() - inverse,
        "inverse": inverse,
        "kinds": kinds,
        "resampled": reasons,
        "resampledKinds": by_kind,
    })
}
