//! Schema-driven reads of a canonical KDM state (`Replica::state_json`): reference checks,
//! register diffs, and a description of the first difference between two states.
//!
//! The canonical state is `{ "meta": {...}, "objects": { "<id>": { "$type": "T", "<field>": ... } } }`:
//! registers as their values, text as a string (or runs `{ insert, attributes? }` with marks),
//! lists as id arrays, trees as nested `{ object, children }`, maps as objects.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::Result;

/// A field's kind, as the schema names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldInfo {
    pub kind: String,
    /// The type a `ref`, `list`, or `tree` names.
    pub of: Option<String>,
}

impl FieldInfo {
    /// A register: one value, last writer wins.
    pub fn is_register(&self) -> bool {
        !matches!(self.kind.as_str(), "text" | "list" | "tree" | "map")
    }
}

/// The parts of a KDM schema the suite reads: each type's fields and their kinds.
#[derive(Clone, Debug, Default)]
pub struct SchemaInfo {
    pub kit: String,
    pub root: String,
    pub types: BTreeMap<String, BTreeMap<String, FieldInfo>>,
}

impl SchemaInfo {
    /// Reads `model/schema.json`.
    pub fn parse(text: &str) -> Result<Self> {
        let schema: Value = serde_json::from_str(text).map_err(|error| format!("the schema is not JSON: {error}"))?;
        let mut types = BTreeMap::new();
        for (name, def) in schema["types"].as_object().ok_or("the schema has no types")? {
            let mut fields = BTreeMap::new();
            for (field, def) in def["fields"].as_object().into_iter().flatten() {
                let kind = def["kind"].as_str().ok_or_else(|| format!("{name}.{field} has no kind"))?.to_owned();
                fields.insert(field.clone(), FieldInfo { kind, of: def["of"].as_str().map(str::to_owned) });
            }
            types.insert(name.clone(), fields);
        }
        Ok(Self { kit: schema["kit"].as_str().unwrap_or_default().to_owned(), root: schema["root"].as_str().unwrap_or_default().to_owned(), types })
    }

    /// Whether any type has a field of `kind`.
    pub fn has_kind(&self, kind: &str) -> bool {
        self.types.values().any(|fields| fields.values().any(|field| field.kind == kind))
    }

    fn field(&self, ty: &str, field: &str) -> Option<&FieldInfo> {
        self.types.get(ty)?.get(field)
    }
}

/// The objects of a state, by id.
pub fn objects(state: &Value) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    state["objects"].as_object().unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

/// Checks the schema's references in `state`. `dangling(ty, field)` says which fields may name
/// deleted objects.
pub fn check_references(schema: &SchemaInfo, state: &Value, dangling: &dyn Fn(&str, &str) -> bool) -> Result<()> {
    let objects = objects(state);
    let type_of = |id: &str| objects.get(id).and_then(|object| object["$type"].as_str()).map(str::to_owned);
    let mut problems = Vec::new();
    // Each object is in at most one tree position overall.
    let mut in_trees: BTreeMap<String, String> = BTreeMap::new();
    for (id, object) in objects {
        let Some(ty) = object["$type"].as_str() else {
            problems.push(format!("{id} has no $type"));
            continue;
        };
        let Some(fields) = schema.types.get(ty) else { continue };
        for (name, field) in fields {
            let value = &object[name.as_str()];
            let check_target = |target: &str, what: &str, problems: &mut Vec<String>| match type_of(target) {
                None if !dangling(ty, name) => problems.push(format!("{ty} {id}.{name} {what} {target}, which does not exist")),
                Some(found) if field.of.as_deref().is_some_and(|of| of != found) => {
                    problems.push(format!("{ty} {id}.{name} {what} {target}, a {found} rather than a {}", field.of.as_deref().unwrap_or("?")))
                }
                _ => {}
            };
            match field.kind.as_str() {
                "ref" => {
                    if let Some(target) = value.as_str() {
                        check_target(target, "names", &mut problems);
                    }
                }
                "list" => {
                    let mut seen = BTreeSet::new();
                    for item in value.as_array().into_iter().flatten().filter_map(Value::as_str) {
                        if !seen.insert(item) {
                            problems.push(format!("{ty} {id}.{name} holds {item} twice"));
                        }
                        check_target(item, "holds", &mut problems);
                    }
                }
                "tree" => {
                    let mut stack: Vec<&Value> = value.as_array().into_iter().flatten().collect();
                    while let Some(node) = stack.pop() {
                        if let Some(object) = node["object"].as_str() {
                            let place = format!("{id}.{name}");
                            if let Some(other) = in_trees.insert(object.to_owned(), place.clone()) {
                                problems.push(format!("{object} is in a tree twice ({other} and {place})"));
                            }
                            // A tree keeps a deleted object's node (standard 2.0 OM2a); readers skip it.
                            if type_of(object).is_some() {
                                check_target(object, "has a node for", &mut problems);
                            }
                        }
                        stack.extend(node["children"].as_array().into_iter().flatten());
                    }
                }
                _ => {}
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        let more = if problems.len() > 5 { format!(" (and {} more)", problems.len() - 5) } else { String::new() };
        Err(format!("invalid references: {}{more}", problems.iter().take(5).cloned().collect::<Vec<_>>().join("; ")))
    }
}

/// A register a state holds: an object's register field, or one key of a map field
/// (`field/key`).
pub type Slot = (String, String);

/// The registers that differ from `before` in `after` (new objects' registers included), with
/// their values in `after`.
pub fn register_changes(schema: &SchemaInfo, before: &Value, after: &Value) -> BTreeMap<Slot, Value> {
    let (old, new) = (objects(before), objects(after));
    let mut out = BTreeMap::new();
    for (id, object) in new {
        let ty = object["$type"].as_str().unwrap_or_default();
        let Some(fields) = schema.types.get(ty) else { continue };
        let previous = old.get(id);
        for (name, field) in fields {
            let value = &object[name.as_str()];
            let was = previous.map(|object| &object[name.as_str()]);
            if field.is_register() {
                if was != Some(value) {
                    out.insert((id.clone(), name.clone()), value.clone());
                }
            } else if field.kind == "map" {
                for (key, item) in value.as_object().into_iter().flatten() {
                    if was.map(|was| &was[key.as_str()]) != Some(item) {
                        out.insert((id.clone(), format!("{name}/{key}")), item.clone());
                    }
                }
            }
        }
    }
    out
}

/// A register's value in `state` (see [`register_changes`]), `Null` when absent.
pub fn register(schema: &SchemaInfo, state: &Value, slot: &Slot) -> Value {
    let object = &objects(state).get(&slot.0).cloned().unwrap_or(Value::Null);
    let ty = object["$type"].as_str().unwrap_or_default();
    if schema.field(ty, &slot.1).is_some() {
        return object[slot.1.as_str()].clone();
    }
    match slot.1.split_once('/') {
        Some((field, key)) => object[field][key].clone(),
        None => Value::Null,
    }
}

/// Ids in `after` that are not in `before`.
pub fn created(before: &Value, after: &Value) -> BTreeSet<String> {
    let old = objects(before);
    objects(after).keys().filter(|id| !old.contains_key(*id)).cloned().collect()
}

/// Ids in `before` that are not in `after`.
pub fn deleted(before: &Value, after: &Value) -> BTreeSet<String> {
    created(after, before)
}

/// Every list field's items as a set, by `id.field`.
pub fn list_sets(schema: &SchemaInfo, state: &Value) -> BTreeMap<String, BTreeSet<String>> {
    let mut out = BTreeMap::new();
    for (id, object) in objects(state) {
        let ty = object["$type"].as_str().unwrap_or_default();
        for (name, field) in schema.types.get(ty).into_iter().flatten() {
            if field.kind == "list" {
                let items = object[name.as_str()].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                out.insert(format!("{id}.{name}"), items);
            }
        }
    }
    out
}

/// Every object a tree names, with its count of nodes, by `id.field`.
pub fn tree_nodes(schema: &SchemaInfo, state: &Value) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for (id, object) in objects(state) {
        let ty = object["$type"].as_str().unwrap_or_default();
        for (name, field) in schema.types.get(ty).into_iter().flatten() {
            if field.kind == "tree" {
                let mut count = 0;
                let mut stack: Vec<&Value> = object[name.as_str()].as_array().into_iter().flatten().collect();
                while let Some(node) = stack.pop() {
                    count += 1;
                    stack.extend(node["children"].as_array().into_iter().flatten());
                }
                out.insert(format!("{id}.{name}"), count);
            }
        }
    }
    out
}

/// The first place where `a` and `b` differ, as a JSON path with both values (abbreviated).
pub fn first_difference(a: &Value, b: &Value) -> Option<String> {
    fn walk(a: &Value, b: &Value, path: &mut String) -> Option<String> {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
                for key in keys {
                    let (left, right) = (x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null));
                    if left != right {
                        let len = path.len();
                        path.push('.');
                        path.push_str(key);
                        let found = walk(left, right, path);
                        path.truncate(len);
                        return found;
                    }
                }
                None
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                for (index, (left, right)) in x.iter().zip(y).enumerate() {
                    if left != right {
                        let len = path.len();
                        path.push_str(&format!("[{index}]"));
                        let found = walk(left, right, path);
                        path.truncate(len);
                        return found;
                    }
                }
                None
            }
            _ if a == b => None,
            _ => Some(format!("{}: {} vs {}", if path.is_empty() { "(root)" } else { path.as_str() }, abbreviate(a), abbreviate(b))),
        }
    }
    walk(a, b, &mut String::new())
}

fn abbreviate(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 160 { format!("{}...", text.chars().take(160).collect::<String>()) } else { text }
}

/// The hex SHA-256 is the KDM's state hash; the suite compares states directly, so a hash here is
/// only for reports: a short FNV-1a digest of the canonical text.
pub fn digest(state: &Value) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in state.to_string().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}
