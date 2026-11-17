use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::changes::list;
use crate::snapshot::Snapshot;

struct Edit<'a> {
    action: &'static str,
    id: &'a str,
    ty: &'a str,
    value: &'a Value,
    field: Option<&'a str>,
}

fn containers(snapshot: &Snapshot, start: &str, ty: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut at = start;
    for _ in 0..64 {
        if !visited.insert(at.to_owned()) {
            break;
        }
        if snapshot.type_of(at) == Some(ty) {
            found.insert(at.to_owned());
        }
        let Some(parent) = snapshot.owned.get(at).map(String::as_str).or_else(|| snapshot.place(at).map(|place| place.parent.as_str())) else { break };
        at = parent;
    }
    found
}

fn allowed(snapshot: &Snapshot, edit: &Edit<'_>, id: &str, field: &str) -> bool {
    let Some(ty) = snapshot.type_of(id) else { return false };
    snapshot.type_def(ty)["structuralConsequences"].as_array().into_iter().flatten().any(|rule| {
        let Some(container) = rule["container"].as_str() else { return false };
        if !rule["on"].as_array().is_some_and(|actions| actions.iter().any(|action| action == edit.action))
            || !rule["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|path| field == path || field.starts_with(&format!("{path}.")))
        {
            return false;
        }
        let mut scopes = containers(snapshot, edit.id, container);
        if edit.ty == container {
            scopes.insert(edit.id.to_owned());
        }
        for side in ["at", "from", "to"] {
            if let Some(parent) = edit.value[side]["parent"].as_str() {
                scopes.extend(containers(snapshot, parent, container));
            }
        }
        !scopes.is_disjoint(&containers(snapshot, id, container))
    })
}

/// Reduce a receipt only when one primary edit explains every remaining stored field.
pub(crate) fn primary(changes: &Value, snapshot: &Snapshot) -> Option<Value> {
    let mut candidates = Vec::new();
    for (key, action) in [("created", "create"), ("deleted", "delete"), ("moved", "move")] {
        for value in list(changes, key) {
            candidates.push(Edit { action, id: value["id"].as_str()?, ty: value["type"].as_str()?, value, field: None });
        }
    }
    if candidates.len() > 1 {
        return None;
    }
    if candidates.is_empty() {
        for changed in list(changes, "changed") {
            let (id, ty) = (changed["id"].as_str()?, changed["type"].as_str()?);
            let label = snapshot.label_field(ty);
            for value in changed["edits"].as_array().into_iter().flatten() {
                let renamed = value["field"].as_str() == label.as_deref();
                if renamed || snapshot.type_def(ty)["projected"] == true {
                    candidates.push(Edit { action: if renamed { "rename" } else { "set" }, id, ty, value, field: value["field"].as_str() });
                }
            }
        }
    }
    let mut explanations = Vec::new();
    for edit in candidates {
        let mut removed = 0;
        let complete = list(changes, "changed").all(|changed| {
            let Some(id) = changed["id"].as_str() else { return false };
            changed["edits"].as_array().into_iter().flatten().all(|value| {
                let Some(field) = value["field"].as_str() else { return false };
                if matches!(edit.action, "rename" | "set") && id == edit.id && Some(field) == edit.field {
                    return true;
                }
                if allowed(snapshot, &edit, id, field) {
                    removed += 1;
                    true
                } else {
                    false
                }
            })
        });
        if !complete || removed == 0 {
            continue;
        }
        let mut primary = json!({"created":[],"changed":[],"moved":[],"deleted":[]});
        let key = match edit.action {
            "create" => "created",
            "delete" => "deleted",
            "move" => "moved",
            _ => "changed",
        };
        primary[key] = if matches!(edit.action, "rename" | "set") {
            json!([{"id":edit.id,"type":edit.ty,"fields":[edit.field],"edits":[edit.value]}])
        } else {
            json!([edit.value])
        };
        explanations.push(primary);
    }
    (explanations.len() == 1).then(|| explanations.remove(0))
}
