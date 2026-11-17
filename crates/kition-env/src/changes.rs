//! Change sets as the receipts of `<prefix>_run` and `<prefix>_batch` give them (`{ created,
//! changed, moved, deleted }`): turned into the batch operations that make them
//! ([`ops_for`]), and cut into the units a reward counts ([`units`]).

use icu_normalizer::ComposingNormalizerBorrowed;
use serde_json::{Map, Value, json};

use crate::snapshot::Snapshot;

/// The `<prefix>_batch` operations that make `changes` on the document `snapshot` shows: each
/// changed field set (`text.set` for a text field), each move a `list.move` in its list or a
/// `list.remove` and `list.insert` into another, each created object created where it was put
/// (with the values the object model writes), each deleted object deleted. A value shown as an
/// excerpt (a text longer than a change set shows) cannot be replayed.
pub fn ops_for(changes: &Value, snapshot: &Snapshot) -> Result<Vec<Value>, String> {
    replay_for(changes, snapshot).map(|(ops, _)| ops)
}

pub(crate) fn replay_for(changes: &Value, snapshot: &Snapshot) -> Result<(Vec<Value>, crate::replay::Bindings), String> {
    if let Some(primary) = crate::structural::primary(changes, snapshot) {
        return replay_for(&primary, snapshot);
    }
    let mut bindings = crate::replay::Bindings::new();
    if let Some(member) = map_membership(changes, snapshot) {
        let target = if member.parent == snapshot.root() { "root" } else { &member.parent };
        if !member.creating {
            return Ok((
                vec![json!({"op":"map.delete","target":target,"field":member.field,"key":member.key}), json!({"op":"delete","target":member.id})],
                bindings,
            ));
        }
        let created = &changes["created"][0];
        let (fields, mut before, after) = create_fields(
            created["type"].as_str().ok_or("created type missing")?,
            created["values"].as_object().ok_or("created values missing")?,
            snapshot,
            "$new",
        )?;
        let mut create = json!({"op":"create","type":created["type"],"ref":"$new","fields":fields});
        with_id(&mut create, created, snapshot);
        before.push(create);
        before.extend(after);
        let value = replace_reference(&member.value, &member.id, "$new");
        before.push(json!({"op":"map.set","target":target,"field":member.field,"key":member.key,"value":value}));
        bindings.insert(member.id, "$new".into());
        return Ok((before, bindings));
    }
    if let Some(root) = cascade_root(changes, snapshot) {
        return Ok((vec![json!({"op":"delete","target":root})], bindings));
    }
    let mut ops = Vec::new();
    let consequential_move = move_root(changes, snapshot).is_some();
    let target = |id: &str| if id == snapshot.root() { "root".to_owned() } else { id.to_owned() };
    for change in list(changes, "changed") {
        if consequential_move {
            continue;
        }
        let id = change["id"].as_str().unwrap_or_default();
        let ty = change["type"].as_str().unwrap_or_default();
        for edit in change["edits"].as_array().into_iter().flatten() {
            let field = edit["field"].as_str().unwrap_or_default();
            if field.starts_with('~') {
                continue;
            }
            if edit["span"]["complete"] == true {
                ops.extend(span_ops(edit, id, ty, snapshot)?);
                continue;
            }
            let after = replayable(&edit["after"])?;
            ops.push(if snapshot.kind(ty, field) == "text" {
                json!({ "op": "text.set", "target": target(id), "field": field, "text": crate::snapshot::text_of(&after) })
            } else {
                json!({ "op": "set", "target": target(id), "field": field, "value": after })
            });
        }
    }
    for moved in list(changes, "moved") {
        let (Some(from), Some(to)) = (moved["from"].as_object(), moved["to"].as_object()) else {
            return Err(format!("`{}` moved in or out of every list: no list operation makes that", moved["id"]));
        };
        let id = moved["id"].as_str().unwrap_or_default();
        let parent = to["parent"].as_str().unwrap_or_default();
        let field = to["field"].as_str().unwrap_or_default();
        if moved["type"].as_str().is_some_and(|ty| snapshot.type_def(ty)["projected"] == true) {
            ops.push(json!({"op":"list.move","target":id,"in":format!("{parent}.{field}"),"to":to["index"]}));
            continue;
        }
        if snapshot.tree_owner(parent, field).is_some() {
            ops.extend(snapshot.tree_move(id, parent, field, to["index"].as_u64().unwrap_or(0) as usize).ok_or("tree has no owner")?);
            continue;
        }
        if from.get("parent") == to.get("parent") && from.get("field") == to.get("field") {
            let start = from["index"].as_u64().ok_or("move source index missing")?;
            let end = to["index"].as_u64().ok_or("move destination index missing")?;
            let gap = if end > start { end.checked_add(1).ok_or("move destination overflows")? } else { end };
            ops.push(
                json!({ "op": "list.move", "target": target(from["parent"].as_str().unwrap_or_default()), "field": from["field"], "from": start, "to": gap }),
            );
        } else {
            ops.push(
                json!({ "op": "list.remove", "target": target(from["parent"].as_str().unwrap_or_default()), "field": from["field"], "index": from["index"] }),
            );
            ops.push(json!({ "op": "list.insert", "target": target(to["parent"].as_str().unwrap_or_default()), "field": to["field"], "item": id, "index": to["index"] }));
        }
    }
    for created in list(changes, "created") {
        let ty = created["type"].as_str().unwrap_or_default();
        let at = created["at"].as_object().ok_or_else(|| format!("the new `{ty}` is in no list: no batch puts it there"))?;
        let binding = format!("$created{}", ops.len());
        bindings.insert(created["id"].as_str().ok_or("created id missing")?.to_owned(), binding.clone());
        let create = json!({"op":"create","type":ty,"in":format!("{}.{}",target(at["parent"].as_str().unwrap_or_default()),at["field"].as_str().unwrap_or_default()),"at":at["index"],"ref":binding,"fields":created["values"]});
        if let Some(command) = creation_command(snapshot, ty, &create) {
            ops.push(command);
            continue;
        }
        let (fields, before, containers) = create_fields(ty, created["values"].as_object().ok_or("created values must be an object")?, snapshot, &binding)?;
        ops.extend(before);
        let parent = target(at["parent"].as_str().unwrap_or_default());
        let field = at["field"].as_str().unwrap_or_default();
        let parent_id = at["parent"].as_str().unwrap_or_default();
        if let Some(owner) = snapshot.tree_owner(parent_id, field) {
            let parent_node = if parent_id == owner { Value::Null } else { json!(parent_id) };
            let mut create =
                json!({ "op": "create", "type": ty, "in": format!("{}.{field}", target(&owner)), "parent": parent_node, "ref": binding, "fields": fields });
            with_id(&mut create, created, snapshot);
            ops.push(create);
            ops.extend(snapshot.tree_move(&binding, parent_id, field, at["index"].as_u64().unwrap_or(0) as usize).ok_or("tree has no owner")?);
            ops.extend(containers);
            continue;
        }
        let mut create = json!({ "op": "create", "type": ty, "in": format!("{parent}.{}", at["field"].as_str().unwrap_or_default()), "at": at["index"], "ref": binding, "fields": fields });
        with_id(&mut create, created, snapshot);
        ops.push(create);
        ops.extend(containers);
    }
    for deleted in list(changes, "deleted") {
        ops.push(json!({ "op": "delete", "target": target(deleted["id"].as_str().unwrap_or_default()) }));
    }
    Ok((ops, bindings))
}

/// Gives a `create` the id of the object the receipt's `created` entry names when that is the
/// object's id, so a replay makes the same object rather than one with a new id: always for a
/// type that declares no tool id, and for one that does when the object has none (the receipt
/// then shows the id kition-kdm minted). A tool id is not an object id: an object named by one
/// still gets a new id. An id the document already holds fails the batch.
fn with_id(create: &mut Value, created: &Value, snapshot: &Snapshot) {
    let ty = created["type"].as_str().unwrap_or_default();
    let declares_tool_id = snapshot.type_def(ty)["toolId"].is_object();
    if let Some(id) = created["id"].as_str().filter(|id| !declares_tool_id || crate::snapshot::minted_form(id)) {
        create["id"] = json!(id);
    }
}

pub(crate) fn creation_command(snapshot: &Snapshot, ty: &str, create: &Value) -> Option<Value> {
    let creation = &snapshot.type_def(ty)["creation"];
    let mapping = &creation["command"];
    let command = mapping["command"].as_str()?;
    let mut source = create.clone();
    source["fixtures"] = creation["fixtures"].clone();
    let mut params = Map::new();
    for (parameter, path) in mapping["params"].as_object().into_iter().flatten() {
        if let Some(value) = path.as_str()?.split('.').try_fold(&source, |value, key| match value {
            Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
            _ => value.get(key),
        }) {
            params.insert(parameter.clone(), value.clone());
        }
    }
    Some(json!({"op":"command","id":command,"params":params,"ref":create["ref"]}))
}

/// Replay only a complete span whose removed text and context match the actual basis.
pub(crate) fn span_ops(edit: &Value, id: &str, ty: &str, snapshot: &Snapshot) -> Result<Vec<Value>, String> {
    let invalid = || "text span is incomplete or does not match its basis".to_owned();
    let span = &edit["span"];
    if span["complete"] != true || edit["spansTruncated"] == true || edit.get("spans").is_some() {
        return Err(invalid());
    }
    let field = edit["field"].as_str().ok_or_else(invalid)?;
    let offset = span["offset"].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(invalid)?;
    let removed = span["removed"].as_str().ok_or_else(invalid)?;
    let inserted = span["inserted"].as_str().ok_or_else(invalid)?;
    let count = removed.chars().count();
    if span["removedLength"].as_u64() != Some(count as u64) || span["insertedLength"].as_u64() != Some(inserted.chars().count() as u64) {
        return Err(invalid());
    }
    let value = snapshot.value_at(id, field);
    if !value.is_string() && snapshot.kind(ty, field) != "text" {
        return Err(invalid());
    }
    let before = crate::snapshot::text_of(&value);
    let mut chars: Vec<_> = before.chars().collect();
    let end = offset.checked_add(count).filter(|end| *end <= chars.len()).ok_or_else(invalid)?;
    if chars[offset..end].iter().collect::<String>() != removed {
        return Err(invalid());
    }
    chars.splice(offset..end, inserted.chars());
    let after: String = chars.into_iter().collect();
    if kition_kdm::diff::text_span(&before, &after).as_ref() != Some(span) {
        return Err(invalid());
    }
    let target = if id == snapshot.root() { "root" } else { id };
    if snapshot.kind(ty, field) == "text" {
        let mut ops = Vec::new();
        if count > 0 {
            ops.push(json!({"op":"text.delete","target":target,"field":field,"index":offset,"count":count}));
        }
        if !inserted.is_empty() {
            ops.push(json!({"op":"text.insert","target":target,"field":field,"index":offset,"text":inserted}));
        }
        Ok(ops)
    } else {
        Ok(vec![json!({"op":"set","target":target,"field":field,"value":after})])
    }
}

/// A creation's registers and the container edits applied to its bound id afterwards.
type CreationParts = (Map<String, Value>, Vec<Value>, Vec<Value>);
pub(crate) fn create_fields(ty: &str, values: &Map<String, Value>, snapshot: &Snapshot, binding: &str) -> Result<CreationParts, String> {
    create_parts(ty, values, snapshot, binding, 0)
}

fn create_parts(ty: &str, values: &Map<String, Value>, snapshot: &Snapshot, binding: &str, depth: usize) -> Result<CreationParts, String> {
    if depth > 64 {
        return Err("owned creation exceeds the ownership depth limit".into());
    }
    let mut expanded = values.clone();
    for (field, def) in snapshot.fields(ty) {
        if expanded.contains_key(&field) {
            continue;
        }
        let prefix = format!("{field}.");
        let descendants: Vec<_> = values.keys().filter_map(|key| key.strip_prefix(&prefix)).collect();
        if descendants.is_empty() {
            continue;
        }
        if def["kind"] == "list" {
            let count = descendants.iter().filter_map(|key| key.split('.').next()?.parse::<usize>().ok()).max().map_or(0, |at| at + 1);
            expanded.insert(field, json!(vec![Value::Null; count]));
        } else if def["kind"] == "ref" && def["owns"] == true {
            expanded.insert(field, json!(""));
        }
    }
    let values = &expanded;
    let mut fields = Map::new();
    let mut before = Vec::new();
    let mut ops = Vec::new();
    for (field, value) in values {
        if field.starts_with('~') || field.contains('.') || snapshot.creation_kept(ty, field) {
            continue;
        }
        let value = replayable(value)?;
        let def = &snapshot.type_def(ty)["fields"][field];
        let mut child = |value: &Value, path: &str, child_binding: &str| -> Result<(), String> {
            let of = def["of"].as_str().ok_or("owned field has no object type")?;
            let mut child_values = value.as_str().and_then(|id| snapshot.objects.get(id)).and_then(Value::as_object).cloned().unwrap_or_default();
            child_values.remove("$type");
            let prefix = format!("{path}.");
            child_values.extend(values.iter().filter_map(|(key, value)| key.strip_prefix(&prefix).map(|key| (key.to_owned(), value.clone()))));
            let (registers, earlier, later) = create_parts(of, &child_values, snapshot, child_binding, depth + 1)?;
            before.extend(earlier);
            before.push(json!({"op":"create","type":of,"ref":child_binding,"fields":registers}));
            before.extend(later);
            Ok(())
        };
        match snapshot.kind(ty, field) {
            "ref" if def["owns"] == true && !value.is_null() => {
                let child_binding = format!("{binding}_{field}");
                child(&value, field, &child_binding)?;
                fields.insert(field.clone(), json!(child_binding));
            }
            "text" => {
                ops.push(json!({"op":"text.set","target":binding,"field":field,"text":crate::snapshot::text_of(&value)}));
                let mut start = 0;
                for run in value.as_array().into_iter().flatten() {
                    let end = start + run["insert"].as_str().unwrap_or_default().chars().count();
                    for (key, value) in run["attributes"].as_object().into_iter().flatten() {
                        ops.push(json!({"op":"text.mark","target":binding,"field":field,"start":start,"end":end,"key":key,"value":value}));
                    }
                    start = end;
                }
            }
            "map" => {
                for (key, value) in value.as_object().ok_or("map creation value must be an object")? {
                    ops.push(json!({"op":"map.set","target":binding,"field":field,"key":key,"value":value}));
                }
            }
            "list" => {
                for (index, item) in value.as_array().ok_or("list creation value must be an array")?.iter().enumerate() {
                    let child_binding = format!("{binding}_{field}_{index}");
                    child(item, &format!("{field}.{index}"), &child_binding)?;
                    ops.push(json!({"op":"list.insert","target":binding,"field":field,"index":index,"item":child_binding}));
                }
            }
            "tree" => {
                for entry in value.as_array().ok_or("tree creation value must be an array")? {
                    ops.push(json!({"op":"tree.insert","target":binding,"field":field,"item":entry["object"],"parent":entry["parent"]}));
                }
            }
            _ => {
                fields.insert(field.clone(), value);
            }
        }
    }
    Ok((fields, before, ops))
}

/// Every instruction template describes exactly one stored edit, move, creation or deletion.
pub(crate) fn instruction_complete(changes: &Value, snapshot: &Snapshot) -> bool {
    let fields: usize = list(changes, "changed").map(|change| change["edits"].as_array().map_or(0, Vec::len)).sum();
    fields + ["created", "moved", "deleted"].iter().map(|name| list(changes, name).count()).sum::<usize>() == 1
        || move_root(changes, snapshot).is_some()
        || map_membership(changes, snapshot).is_some()
        || crate::structural::primary(changes, snapshot).is_some()
}

pub(crate) struct MapMembership {
    pub id: String,
    pub parent: String,
    pub field: String,
    pub key: String,
    pub value: Value,
    pub creating: bool,
}

fn replace_reference(value: &Value, old: &str, new: &str) -> Value {
    match value {
        Value::String(id) if id == old => json!(new),
        Value::Object(members) => Value::Object(members.iter().map(|(key, value)| (key.clone(), replace_reference(value, old, new))).collect()),
        other => other.clone(),
    }
}

/// A single map membership change and its object are one user edit. Every other effect fails.
pub(crate) fn map_membership(changes: &Value, snapshot: &Snapshot) -> Option<MapMembership> {
    if list(changes, "moved").next().is_some() {
        return None;
    }
    let created: Vec<_> = list(changes, "created").collect();
    let deleted: Vec<_> = list(changes, "deleted").collect();
    let (object, creating) = match (created.as_slice(), deleted.as_slice()) {
        ([object], []) => (*object, true),
        ([], [object]) => (*object, false),
        _ => return None,
    };
    let id = object["id"].as_str()?;
    let changed: Vec<_> = list(changes, "changed").collect();
    let [changed] = changed.as_slice() else { return None };
    let parent = changed["id"].as_str()?;
    let edits = changed["edits"].as_array()?;
    let [edit] = edits.as_slice() else { return None };
    let field = edit["field"].as_str()?;
    let ty = snapshot.type_of(parent)?;
    let def = &snapshot.type_def(ty)["fields"][field];
    if def["kind"] != "map" || def["owns"] != true {
        return None;
    }
    let (small, big) = if creating { (&edit["before"], &edit["after"]) } else { (&edit["after"], &edit["before"]) };
    let (small, big) = (small.as_object()?, big.as_object()?);
    if big.len() != small.len() + 1 || small.iter().any(|(key, value)| big.get(key) != Some(value)) {
        return None;
    }
    let (key, value) = big.iter().find(|(key, _)| !small.contains_key(*key))?;
    let held = kition_kdm::FieldDef::map_held(&json!({"entry":value}), |candidate| candidate == id || snapshot.objects.contains_key(candidate));
    if held.len() != 1 || held[0].0 != id {
        return None;
    }
    Some(MapMembership { id: id.into(), parent: parent.into(), field: field.into(), key: key.clone(), value: value.clone(), creating })
}

/// One structural move with only opted-in position edits on its owned subtree.
pub(crate) fn move_root(changes: &Value, snapshot: &Snapshot) -> Option<String> {
    let moved: Vec<_> = list(changes, "moved").collect();
    let [moved] = moved.as_slice() else { return None };
    if list(changes, "created").next().is_some() || list(changes, "deleted").next().is_some() {
        return None;
    }
    let root = moved["id"].as_str()?;
    let mut descendants = std::collections::BTreeSet::from([root.to_owned()]);
    loop {
        let before = descendants.len();
        for (id, place) in &snapshot.places {
            if descendants.contains(&place.parent) {
                descendants.insert(id.clone());
            }
        }
        for (id, parent) in &snapshot.owned {
            if descendants.contains(parent) {
                descendants.insert(id.clone());
            }
        }
        if descendants.len() == before {
            break;
        }
    }
    for changed in list(changes, "changed") {
        let id = changed["id"].as_str()?;
        if !descendants.contains(id) {
            return None;
        }
        let ty = snapshot.type_of(id)?;
        let def = snapshot.type_def(ty);
        for edit in changed["edits"].as_array()? {
            let field = edit["field"].as_str()?;
            if !def["moveConsequences"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|path| field == path || field.starts_with(&format!("{path}.")))
            {
                return None;
            }
        }
    }
    Some(root.to_owned())
}

/// A single opted-in tree cascade, with exactly its owned descendants and no other effects.
pub(crate) fn cascade_root(changes: &Value, snapshot: &Snapshot) -> Option<String> {
    if list(changes, "created").next().is_some()
        || list(changes, "moved").next().is_some()
        || list(changes, "changed").any(|c| c["edits"].as_array().is_some_and(|edits| !edits.is_empty()))
    {
        return None;
    }
    let deleted: std::collections::BTreeSet<String> = list(changes, "deleted").filter_map(|v| v["id"].as_str().map(str::to_owned)).collect();
    let roots: Vec<_> = deleted
        .iter()
        .filter(|id| {
            snapshot.place(id).is_none_or(|place| !deleted.contains(&place.parent)) && snapshot.owned.get(*id).is_none_or(|parent| !deleted.contains(parent))
        })
        .collect();
    let [root] = roots.as_slice() else { return None };
    let place = snapshot.place(root)?;
    let owner = snapshot.tree_owner(&place.parent, &place.field)?;
    let ty = snapshot.type_of(&owner)?;
    if snapshot.type_def(ty)["fields"][&place.field]["cascade"] != true {
        return None;
    }
    let mut expected = std::collections::BTreeSet::from([(*root).clone()]);
    loop {
        let before = expected.len();
        for (id, place) in &snapshot.places {
            if expected.contains(&place.parent) {
                expected.insert(id.clone());
            }
        }
        for (id, parent) in &snapshot.owned {
            if expected.contains(parent) {
                expected.insert(id.clone());
            }
        }
        if expected.len() == before {
            break;
        }
    }
    (expected == deleted).then(|| (*root).clone())
}

/// Receipts abbreviate rich text to its characters. Retain saved runs for creation replay,
/// instructions and scoring, so formatting is neither lost nor silently rewarded.
pub(crate) fn creation_values(mut changes: Value, after: &Snapshot) -> Value {
    for created in changes["created"].as_array_mut().into_iter().flatten() {
        let id = created["id"].as_str().unwrap_or_default().to_owned();
        let ty = created["type"].as_str().unwrap_or_default().to_owned();
        // Public receipts omit empty values; required registers still need their saved value
        // when creating the object again (notably an empty JSON object or array).
        for (field, def) in after.fields(&ty) {
            if def["optional"] != true
                && !matches!(def["kind"].as_str(), Some("list" | "tree" | "map"))
                && !created["values"].as_object().is_some_and(|values| values.contains_key(&field))
            {
                let value = after.value(&id, &field);
                if !value.is_null() {
                    created["values"][&field] = value;
                    let fields = created["fields"].as_array_mut().expect("created fields");
                    fields.push(json!(field));
                    fields.sort_by_key(Value::to_string);
                }
            }
        }
        for (field, value) in created["values"].as_object_mut().into_iter().flatten() {
            if (after.kind(&ty, field) == "text" || after.kind(&ty, field) == "blob" && after.type_def(&ty)["creation"]["command"].is_object())
                && after.type_of(&id) == Some(ty.as_str())
            {
                *value = after.value(&id, field);
            }
        }
    }
    changes
}

/// A value a batch can write again: anything but an excerpt (`{ excerpt, length }`) or a blob's size.
fn replayable(value: &Value) -> Result<Value, String> {
    if value.get("excerpt").is_some() || value.get("size").is_some() && value.as_object().is_some_and(|object| object.len() == 1) {
        return Err("a value the change set shows only in part (a long text or a blob)".to_owned());
    }
    Ok(value.clone())
}

/// Whether a change set holds a value it shows only in part.
pub(crate) fn has_excerpt(changes: &Value) -> bool {
    let partial = |value: &Value| replayable(value).is_err();
    list(changes, "changed").any(|change| {
        change["edits"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|edit| (partial(&edit["before"]) || partial(&edit["after"])) && (edit["span"]["complete"] != true || edit["spansTruncated"] == true))
    }) || list(changes, "created").any(|created| created["values"].as_object().into_iter().flatten().any(|(_, value)| partial(value)))
}

pub(crate) fn list<'a>(changes: &'a Value, name: &str) -> impl Iterator<Item = &'a Value> {
    changes[name].as_array().into_iter().flatten()
}

/// A change set without what only describes it (`texts`, `truncated`, `footprint`, a deleted
/// object's `$was`): its four lists, every id as text. Receipts name an integer tool id and a
/// position's parent of such a type as a number (the form the kit's commands take); a change set
/// computed from two snapshots names them as the snapshots keep them, as text.
pub(crate) fn core(changes: &Value) -> Value {
    let mut set = json!({ "created": changes["created"], "changed": changes["changed"], "moved": changes["moved"], "deleted": changes["deleted"] });
    let text = |value: &mut Value| {
        if let Value::Number(number) = value {
            *value = Value::String(number.to_string());
        }
    };
    for name in ["created", "changed", "moved", "deleted"] {
        for item in set[name].as_array_mut().into_iter().flatten() {
            text(&mut item["id"]);
            for side in ["at", "from", "to"] {
                if let Some(position) = item.get_mut(side).filter(|position| position.is_object()) {
                    text(&mut position["parent"]);
                }
            }
            if let Some(item) = item.as_object_mut() {
                item.remove("$was");
            }
        }
    }
    // Snapshots read stored fields. Derived receipts describe consequences of those same edits.
    for created in set["created"].as_array_mut().into_iter().flatten() {
        if let Some(fields) = created["fields"].as_array_mut() {
            fields.retain(|field| !field.as_str().is_some_and(|name| name.starts_with('~')));
        }
        if let Some(values) = created["values"].as_object_mut() {
            values.retain(|field, _| !field.starts_with('~'));
        }
    }
    if let Some(changed) = set["changed"].as_array_mut() {
        for item in changed.iter_mut() {
            for (key, member) in [("fields", None), ("edits", Some("field"))] {
                if let Some(values) = item[key].as_array_mut() {
                    values.retain(|value| !member.map_or(value, |member| &value[member]).as_str().is_some_and(|name| name.starts_with('~')));
                }
            }
        }
        changed.retain(|item| item["fields"].as_array().is_none_or(|fields| !fields.is_empty()));
    }
    set
}

/// Whether a change set changes nothing.
pub(crate) fn is_empty(changes: &Value) -> bool {
    units(changes).is_empty()
}

/// One thing a change set says happened, as a reward counts it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Unit {
    /// A field of an existing object took a value.
    Field {
        id: String,
        ty: String,
        field: String,
        before: Value,
        after: Value,
        span: Value,
    },
    /// An object was created in a list (its id is the kit's to give).
    Created {
        ty: String,
        parent: String,
        field: String,
        index: Value,
        values: Map<String, Value>,
    },
    Moved {
        id: String,
        ty: String,
        from: Value,
        to: Value,
    },
    Deleted {
        id: String,
        ty: String,
        at: Value,
    },
}

impl Unit {
    /// What two units must share to be the same change: the object and field, or for a created
    /// object its type and the list it was put in.
    pub(crate) fn key(&self) -> String {
        match self {
            Self::Field { id, field, .. } => format!("field {id} {field}"),
            Self::Created { ty, parent, field, .. } => format!("created {ty} {parent}.{field}"),
            Self::Moved { id, .. } => format!("moved {id}"),
            Self::Deleted { id, .. } => format!("deleted {id}"),
        }
    }

    /// The object it concerns, for counting the objects an attempt touched.
    pub(crate) fn object(&self) -> String {
        match self {
            Self::Field { id, .. } | Self::Moved { id, .. } | Self::Deleted { id, .. } => id.clone(),
            Self::Created { ty, parent, field, index, .. } => format!("a new {ty} in {parent}.{field} at {index}"),
        }
    }

    /// Whether `other` is this change with the same values: texts trimmed and in Unicode
    /// normalisation form C unless `exact`.
    pub(crate) fn same(&self, other: &Self, exact: bool) -> bool {
        let eq = |a: &Value, b: &Value| normalised(a, exact) == normalised(b, exact);
        self.key() == other.key()
            && match (self, other) {
                (Self::Field { after: a, span: sa, .. }, Self::Field { after: b, span: sb, .. }) => eq(a, b) && eq(sa, sb),
                (Self::Created { index: i, values: a, .. }, Self::Created { index: j, values: b, .. }) => {
                    i == j && eq(&Value::Object(a.clone()), &Value::Object(b.clone()))
                }
                (Self::Moved { to: a, .. }, Self::Moved { to: b, .. }) => a == b,
                (Self::Deleted { .. }, Self::Deleted { .. }) => true,
                _ => false,
            }
    }

    /// As a reward lists it: `{ change, id?, type, field?, before?, after?, at?, from?, to?, values? }`.
    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Field { id, ty, field, before, after, span } => {
                let mut value = json!({ "change": "changed", "id": id, "type": ty, "field": field, "before": before, "after": after });
                if !span.is_null() {
                    value["span"] = span.clone();
                }
                value
            }
            Self::Created { ty, parent, field, index, values } => {
                json!({ "change": "created", "type": ty, "at": { "parent": parent, "field": field, "index": index }, "values": values })
            }
            Self::Moved { id, ty, from, to } => json!({ "change": "moved", "id": id, "type": ty, "from": from, "to": to }),
            Self::Deleted { id, ty, at } => json!({ "change": "deleted", "id": id, "type": ty, "at": at }),
        }
    }
}

/// The units of a change set, in its order: changed fields, created, moved and deleted objects.
/// A change of a list field is no unit of its own: the objects created, moved and deleted in it
/// are. A created object's values leave out the fields `kept` says the kit keeps (its tool id).
pub(crate) fn units_with(changes: &Value, kept: &dyn Fn(&str, &str) -> bool) -> Vec<Unit> {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let mut units = Vec::new();
    for change in list(changes, "changed") {
        for edit in change["edits"].as_array().into_iter().flatten() {
            units.push(Unit::Field {
                id: text(&change["id"]),
                ty: text(&change["type"]),
                field: text(&edit["field"]),
                before: edit["before"].clone(),
                after: edit["after"].clone(),
                span: edit["span"].clone(),
            });
        }
    }
    for created in list(changes, "created") {
        let ty = text(&created["type"]);
        let values = created["values"]
            .as_object()
            .map(|values| values.iter().filter(|(field, _)| !kept(&ty, field)).map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let at = &created["at"];
        units.push(Unit::Created { parent: text(&at["parent"]), field: text(&at["field"]), index: at["index"].clone(), ty, values });
    }
    for moved in list(changes, "moved") {
        units.push(Unit::Moved { id: text(&moved["id"]), ty: text(&moved["type"]), from: moved["from"].clone(), to: moved["to"].clone() });
    }
    for deleted in list(changes, "deleted") {
        units.push(Unit::Deleted { id: text(&deleted["id"]), ty: text(&deleted["type"]), at: deleted["at"].clone() });
    }
    units
}

pub(crate) fn units(changes: &Value) -> Vec<Unit> {
    units_with(changes, &|_, _| false)
}

/// `value` with every text trimmed and composed (NFC), unless `exact`.
fn normalised(value: &Value, exact: bool) -> Value {
    if exact {
        return value.clone();
    }
    match value {
        Value::String(text) => Value::String(ComposingNormalizerBorrowed::new_nfc().normalize(text.trim()).into_owned()),
        Value::Array(items) => Value::Array(items.iter().map(|item| normalised(item, exact)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), normalised(item, exact))).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn located_replay_requires_complete_matching_basis_and_context() {
        let body = format!("{}target{}", "\u{1f600}".repeat(100), "z".repeat(100));
        let after = body.replace("target", "updated");
        let snapshot = Snapshot {
            described: json!({"types":{"Root":{"fields":{"body":{"kind":"string"}}}}}),
            root: "root".into(),
            objects: [("root".into(), json!({"$type":"Root","body":body}))].into(),
            places: Default::default(),
            owned: Default::default(),
            owned_by: Default::default(),
            schema: None,
        };
        let edit = json!({"field":"body","span":kition_kdm::diff::text_span(&body,&after).unwrap()});
        let ops = span_ops(&edit, "root", "Root", &snapshot).unwrap();
        assert_eq!(ops[0]["value"], after);
        for (key, value) in
            [("offset", json!(u64::MAX)), ("removed", json!("wrong")), ("before", json!("wrong")), ("removedLength", json!(1)), ("complete", json!(false))]
        {
            let mut bad = edit.clone();
            bad["span"][key] = value;
            assert!(span_ops(&bad, "root", "Root", &snapshot).is_err(), "{bad}");
        }
        let mut truncated = edit;
        truncated["spansTruncated"] = json!(true);
        assert!(span_ops(&truncated, "root", "Root", &snapshot).is_err());
    }

    #[test]
    fn structural_consequences_are_one_task_for_a_sheet_container() {
        let snapshot = Snapshot {
            described: json!({"types":{
                "Sheet":{"fields":{"name":{"kind":"string"},"rows":{"kind":"list","of":"Row"}}},
                "Row":{"fields":{"name":{"kind":"string"}}},
                "Cell":{"fields":{"label":{"kind":"string"}},"structuralConsequences":[{"container":"Sheet","on":["create","delete","move","rename"],"fields":["label"]}]}
            }}),
            root: "root".into(),
            objects: [
                ("sheet".into(), json!({"$type":"Sheet","name":"Sheet A"})),
                ("row".into(), json!({"$type":"Row"})),
                ("cell".into(), json!({"$type":"Cell"})),
            ]
            .into(),
            places: [
                ("row".into(), crate::snapshot::Place { parent: "sheet".into(), field: "rows".into(), index: 0 }),
                ("cell".into(), crate::snapshot::Place { parent: "sheet".into(), field: "cells".into(), index: 0 }),
            ]
            .into(),
            owned: Default::default(),
            owned_by: Default::default(),
            schema: None,
        };
        for event in ["create", "delete", "move", "rename"] {
            let mut changes = json!({"created":[],"deleted":[],"moved":[],"changed":[{"id":"cell","type":"Cell","fields":["label"],"edits":[{"field":"label","before":"Sheet A!A1","after":"Sheet B!A2"}]}]});
            match event {
                "create" => {
                    changes["created"] =
                        json!([{"id":"new","type":"Row","at":{"parent":"sheet","field":"rows","index":0},"fields":["name"],"values":{"name":"New"}}])
                }
                "delete" => changes["deleted"] = json!([{"id":"row","type":"Row","at":{"parent":"sheet","field":"rows","index":0}}]),
                "move" => {
                    changes["moved"] =
                        json!([{"id":"row","type":"Row","from":{"parent":"sheet","field":"rows","index":0},"to":{"parent":"sheet","field":"rows","index":1}}])
                }
                _ => changes["changed"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":"sheet","type":"Sheet","fields":["name"],"edits":[{"field":"name","before":"Sheet A","after":"Sheet B"}]})),
            }
            assert!(instruction_complete(&changes, &snapshot), "{event}: {changes}");
            let mut unrelated = snapshot.clone();
            unrelated.objects.insert("other-sheet".into(), json!({"$type":"Sheet"}));
            unrelated.places.get_mut("cell").unwrap().parent = "other-sheet".into();
            assert!(!instruction_complete(&changes, &unrelated), "another container: {event}");
            let mut wrong_action = snapshot.clone();
            wrong_action.described["types"]["Cell"]["structuralConsequences"][0]["on"] = json!(["different"]);
            assert!(!instruction_complete(&changes, &wrong_action), "undeclared action: {event}");
            let mut extra = changes.clone();
            extra["moved"].as_array_mut().unwrap().push(json!({"id":"unrelated","type":"Row","from":{},"to":{}}));
            assert!(!instruction_complete(&extra, &snapshot), "second operation: {event}");
            let mut whole_parent = changes.clone();
            whole_parent["changed"][0]["edits"][0]["field"] = json!("address");
            let mut member_only = snapshot.clone();
            member_only.described["types"]["Cell"]["structuralConsequences"][0]["fields"] = json!(["address.row"]);
            assert!(!instruction_complete(&whole_parent, &member_only), "whole parent: {event}");
        }
    }

    #[test]
    fn map_membership_tasks_reject_unrelated_effects() {
        let snapshot = Snapshot {
            described: json!({"types":{"Root":{"fields":{"catalog":{"kind":"map","owns":true}}}}}),
            root: "root".into(),
            objects: [("root".into(), json!({"$type":"Root"})), ("old".into(), json!({"$type":"Item"}))].into(),
            places: Default::default(),
            owned: Default::default(),
            owned_by: Default::default(),
            schema: None,
        };
        for wrapped in [false, true] {
            let value = if wrapped { json!({"body":"new","note":"literal"}) } else { json!("new") };
            let base = json!({"created":[{"id":"new","type":"Item","fields":["name"],"values":{"name":"New"}}],"deleted":[],"moved":[],
                "changed":[{"id":"root","type":"Root","fields":["catalog"],"edits":[{"field":"catalog","before":{"old":"old"},"after":{"old":"old","new":value}}]}]});
            assert!(instruction_complete(&base, &snapshot));
            for extra in ["edit", "reference", "create"] {
                let mut changes = base.clone();
                match extra {
                    "edit" => changes["changed"][0]["edits"].as_array_mut().unwrap().push(json!({"field":"other","before":0,"after":1})),
                    "reference" => changes["changed"][0]["edits"][0]["after"]["old"] = json!("different"),
                    _ => changes["created"].as_array_mut().unwrap().push(json!({"id":"extra","type":"Item","values":{}})),
                }
                assert!(!instruction_complete(&changes, &snapshot), "{extra}: {changes}");
            }
        }
    }
    use crate::snapshot::Place;

    #[test]
    fn move_consequences_cannot_hide_unrelated_changes() {
        let snapshot = Snapshot {
            described: json!({"types":{"Layer":{"fields":{"address":{"kind":"json","position":true}},"moveConsequences":["address.container"]}}}),
            root: "root".into(),
            objects: ["group", "child", "other"].into_iter().map(|id| (id.into(), json!({"$type":"Layer"}))).collect(),
            places: [("group", "root"), ("child", "group"), ("other", "root")]
                .into_iter()
                .map(|(id, parent)| (id.into(), Place { parent: parent.into(), field: "layers".into(), index: 0 }))
                .collect(),
            owned: Default::default(),
            owned_by: Default::default(),
            schema: None,
        };
        let base = json!({"created":[],"deleted":[],"moved":[{"id":"group","from":{"parent":"root"},"to":{"parent":"other"}}],
            "changed":[{"id":"child","type":"Layer","fields":["address.container"],"edits":[{"field":"address.container","before":"group","after":"other"}]}]});
        assert!(instruction_complete(&base, &snapshot));
        for (id, field) in [("other", "address.container"), ("child", "address.label"), ("child", "address")] {
            let mut changed = base.clone();
            changed["changed"][0]["id"] = json!(id);
            changed["changed"][0]["edits"][0]["field"] = json!(field);
            assert!(!instruction_complete(&changed, &snapshot), "{id}/{field}");
        }
        let mut changed = base.clone();
        changed["moved"].as_array_mut().unwrap().push(json!({"id":"other"}));
        assert!(!instruction_complete(&changed, &snapshot));
        let mut undeclared = snapshot.clone();
        undeclared.described["types"]["Layer"]["moveConsequences"] = json!([]);
        assert!(!instruction_complete(&base, &undeclared));
    }
}
