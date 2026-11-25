//! One document state written over another replica of the same document, keyed by object id:
//! what a kit does when a file and the replica a host stored for it disagree (data model 7.3,
//! "Opening a file with its stored replica"). [`take_file`] is the open path; [`write_state`] is
//! the write.

use std::collections::{BTreeSet, HashMap};

use kition_kdm::{FieldKind, NodeRef, ObjectId, Origin, Replica, Schema, TextRun, Tx};
use serde_json::{Map, Value};

use super::{KitError, Result, transact, write_rich_text, write_text};

/// A document's objects by id, each with its `$type` and fields: the `objects` of
/// [`Replica::state_json`].
pub type State = Map<String, Value>;

/// The objects of `replica`'s canonical state.
pub fn state(replica: &Replica) -> Result<State> {
    Ok(match replica.state_json()? {
        Value::Object(mut state) => match state.remove("objects") {
            Some(Value::Object(objects)) => objects,
            _ => Map::new(),
        },
        _ => Map::new(),
    })
}

/// Takes `file` (a replica opened from a file) into `ours` (the replica a host stored for the
/// same document) and answers whether `ours` changed: nothing when both hold the same state;
/// otherwise `file`'s state written over `ours`'s as one `system` transaction labelled `import`
/// ([`write_state`]), keyed by object id, so `ours` keeps its history, undo steps and object ids.
///
/// Refuses ([`kition_kdm::KdmError::WrongDocument`]) a file of another document.
pub fn take_file(ours: &mut Replica, file: &Replica) -> Result<bool> {
    if ours.doc_id() != file.doc_id() {
        return Err(kition_kdm::KdmError::WrongDocument { expected: ours.doc_id().to_string(), found: file.doc_id().to_string() }.into());
    }
    let (before, after) = (state(ours)?, state(file)?);
    if before == after {
        return Ok(false);
    }
    let schema = file.schema();
    transact(ours, &Origin::system("import"), |tx| write_state(tx, schema, &before, &after))?;
    Ok(true)
}

/// Writes the state `after` over a replica whose state is `before` ([`state`] of each), keyed by
/// object id: creates the objects only `after` has, under their ids; writes the fields that
/// differ (registers and refs as values, text by character with its marks, lists by item with
/// moves, maps by key, trees by node with moves); and deletes the objects only `before` has.
/// Objects of types `schema` does not declare are left as they are.
pub fn write_state(tx: &mut Tx<'_>, schema: &Schema, before: &State, after: &State) -> Result<()> {
    let def = |object: &Value| schema.type_def(type_of(object)).ok();
    // New objects first, with their registers and refs, so every ref and container can name them
    // and a required ref is there when its object is made. A ref may name an object made later in
    // this transaction (two objects that name each other): the transaction checks a ref's target
    // only when it exists.
    for (id, object) in after.iter().filter(|(id, _)| !before.contains_key(*id)) {
        let Some(def) = def(object) else { continue };
        let fields: Map<String, Value> = object
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(name, value)| !value.is_null() && def.fields.get(*name).is_some_and(|field| is_register(field.kind)))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        tx.create_with_id(type_of(object), &ObjectId::from_string(id.clone()), fields)?;
    }
    for (id, object) in after {
        let Some(def) = def(object) else { continue };
        let old = before.get(id);
        let target = ObjectId::from_string(id.clone());
        for (name, value) in object.as_object().into_iter().flatten() {
            let Some(field) = def.fields.get(name) else { continue };
            let was = old.and_then(|old| old.get(name));
            if was == Some(value) || (old.is_none() && is_register(field.kind)) {
                continue;
            }
            match field.kind {
                FieldKind::Text => write_text_field(tx, &target, name, was, value)?,
                FieldKind::List => write_list(tx, &target, name, value)?,
                FieldKind::Map => write_map(tx, &target, name, was, value)?,
                FieldKind::Tree => write_tree(tx, &target, name, value, after)?,
                _ => tx.set(&target, name, value.clone())?,
            }
        }
    }
    // Deletions last, each object after those its tree nodes hold (a delete refuses an object
    // whose node still holds live children).
    let mut gone: Vec<ObjectId> =
        before.keys().filter(|id| !after.contains_key(*id)).map(|id| ObjectId::from_string(id.clone())).filter(|id| tx.exists(id)).collect();
    while !gone.is_empty() {
        let mut left = Vec::new();
        let mut refused = None;
        for id in gone.iter().rev() {
            match tx.delete(id) {
                Ok(()) => {}
                Err(error) => {
                    refused = Some(error);
                    left.push(id.clone());
                }
            }
        }
        if left.len() == gone.len() {
            return Err(refused.map_or_else(|| KitError::new("write_state: an object could not be deleted"), KitError::from));
        }
        gone = left;
    }
    Ok(())
}

/// A field written with the object it belongs to: a register, a ref included.
fn is_register(kind: FieldKind) -> bool {
    !matches!(kind, FieldKind::Text | FieldKind::List | FieldKind::Map | FieldKind::Tree)
}

fn type_of(object: &Value) -> &str {
    object.get("$type").and_then(Value::as_str).unwrap_or_default()
}

/// A text field: a string (no marks), or runs (marks).
fn write_text_field(tx: &mut Tx<'_>, id: &ObjectId, field: &str, was: Option<&Value>, value: &Value) -> Result<()> {
    match value {
        Value::String(new) => write_text(tx, id, field, was.and_then(Value::as_str).unwrap_or_default(), new).map(|_| ()),
        _ => {
            let runs = |value: Option<&Value>| -> Result<Vec<TextRun>> {
                value
                    .filter(|value| !value.is_null())
                    .map_or(Ok(Vec::new()), |value| serde_json::from_value(value.clone()).map_err(|error| KitError::new(format!("{field}: {error}"))))
            };
            write_rich_text(tx, id, field, &runs(was)?, &runs(Some(value))?)
        }
    }
}

/// A list field made to hold `value`'s items in order: items it should not hold removed, the
/// others moved into place, the missing ones inserted.
fn write_list(tx: &mut Tx<'_>, id: &ObjectId, field: &str, value: &Value) -> Result<()> {
    let want: Vec<ObjectId> = value.as_array().into_iter().flatten().filter_map(Value::as_str).map(ObjectId::from_string).collect();
    let mut items = tx.list_items(id, field)?;
    let mut seen = BTreeSet::new();
    let keep: Vec<bool> = items.iter().map(|item| want.contains(item) && seen.insert(item.clone())).collect();
    for (index, keep) in keep.iter().enumerate().rev() {
        if !keep {
            tx.list_remove(id, field, index)?;
            items.remove(index);
        }
    }
    for (index, item) in want.iter().enumerate() {
        match items.iter().position(|held| held == item) {
            Some(at) if at == index => {}
            Some(at) => {
                tx.list_move(id, field, at, index)?;
                let moved = items.remove(at);
                items.insert(index, moved);
            }
            None => {
                tx.list_insert(id, field, index, item)?;
                items.insert(index, item.clone());
            }
        }
    }
    Ok(())
}

/// A map field made to hold `value`'s entries.
fn write_map(tx: &mut Tx<'_>, id: &ObjectId, field: &str, was: Option<&Value>, value: &Value) -> Result<()> {
    let empty = Map::new();
    let (old, new) = (was.and_then(Value::as_object).unwrap_or(&empty), value.as_object().unwrap_or(&empty));
    for key in old.keys().filter(|key| !new.contains_key(*key)) {
        tx.map_delete(id, field, key)?;
    }
    for (key, value) in new.iter().filter(|(key, value)| old.get(*key) != Some(*value)) {
        tx.map_set(id, field, key, value.clone())?;
    }
    Ok(())
}

/// One node of a tree field's canonical form: the object it names and the object of its parent
/// node (`None`: a root), in pre-order.
fn wanted_nodes(value: &Value, parent: Option<&ObjectId>, out: &mut Vec<(ObjectId, Option<ObjectId>)>) {
    for node in value.as_array().into_iter().flatten() {
        let Some(object) = node.get("object").and_then(Value::as_str).map(ObjectId::from_string) else { continue };
        out.push((object.clone(), parent.cloned()));
        if let Some(children) = node.get("children") {
            wanted_nodes(children, Some(&object), out);
        }
    }
}

/// A tree field made to hold `value`'s nodes (its canonical form, `[{ "object", "children" }]`):
/// each object's node kept (the first, when several name it) and moved under its parent's node,
/// the missing nodes created, the nodes of objects `value` does not hold deleted, and each
/// parent's children put in order.
///
/// A node of an object `live` does not hold is moved when the tree here still shows it (its
/// object is deleted later in the same write) and otherwise left alone with its subtree: no node
/// is made for an object that is gone.
fn write_tree(tx: &mut Tx<'_>, id: &ObjectId, field: &str, value: &Value, live: &State) -> Result<()> {
    let mut want = Vec::new();
    wanted_nodes(value, None, &mut want);
    let entries = tx.tree(id, field)?;
    let mut node_of: HashMap<ObjectId, NodeRef> = HashMap::new();
    let mut extra: Vec<NodeRef> = Vec::new();
    for entry in &entries {
        if node_of.contains_key(&entry.object) {
            extra.push(entry.node.clone());
        } else {
            node_of.insert(entry.object.clone(), entry.node.clone());
        }
    }
    // Where each kept node is now: under the kept node of another object, or a root. A node under
    // a node that is not kept (a second node of an object) is not in place.
    let mut parent_of: HashMap<ObjectId, Option<ObjectId>> = HashMap::new();
    for entry in &entries {
        if node_of.get(&entry.object) != Some(&entry.node) {
            continue;
        }
        match &entry.parent {
            None => {
                parent_of.insert(entry.object.clone(), None);
            }
            Some(parent) => {
                if let Some((object, _)) = node_of.iter().find(|(_, node)| *node == parent) {
                    parent_of.insert(entry.object.clone(), Some(object.clone()));
                }
            }
        }
    }
    let wanted: BTreeSet<&ObjectId> = want.iter().map(|(object, _)| object).collect();
    // Pre-order: a parent's node exists (or was created, or was skipped) before its children's.
    let mut skipped: BTreeSet<ObjectId> = BTreeSet::new();
    for (object, parent) in &want {
        // A node names a live object: one the state does not hold, or did not make (of a type the
        // schema does not declare), gets none.
        let gone = !node_of.contains_key(object) && (!live.contains_key(object.as_str()) || !tx.exists(object));
        if gone || parent.as_ref().is_some_and(|parent| skipped.contains(parent)) {
            skipped.insert(object.clone());
            continue;
        }
        let parent_node = match parent {
            Some(parent) => Some(node_of.get(parent).cloned().ok_or_else(|| KitError::new(format!("{id}.{field}: no node for {parent}")))?),
            None => None,
        };
        match node_of.get(object).cloned() {
            Some(node) => {
                if parent_of.get(object) != Some(parent) {
                    tx.tree_move(id, field, &node, parent_node.as_ref())?;
                }
            }
            None => {
                let node = tx.tree_create(id, field, parent_node.as_ref(), object)?;
                node_of.insert(object.clone(), node);
            }
        }
    }
    // Every child the tree should keep is under its parent now: the rest can go with their nodes.
    for (object, node) in &node_of {
        if !wanted.contains(object) {
            extra.push(node.clone());
        }
    }
    for node in extra {
        if tx.tree(id, field)?.iter().any(|entry| entry.node == node) {
            tx.tree_delete(id, field, &node)?;
        }
    }
    // Order: each parent whose children are out of order gets them moved, in order, to its end.
    let mut children: HashMap<Option<ObjectId>, Vec<ObjectId>> = HashMap::new();
    for (object, parent) in want.iter().filter(|(object, _)| !skipped.contains(object)) {
        children.entry(parent.clone()).or_default().push(object.clone());
    }
    for (parent, order) in children {
        let parent_node = parent.as_ref().and_then(|parent| node_of.get(parent));
        let held: Vec<ObjectId> = tx.tree(id, field)?.into_iter().filter(|entry| entry.parent.as_ref() == parent_node).map(|entry| entry.object).collect();
        if held != order {
            for object in &order {
                tx.tree_move(id, field, &node_of[object], parent_node)?;
            }
        }
    }
    Ok(())
}
