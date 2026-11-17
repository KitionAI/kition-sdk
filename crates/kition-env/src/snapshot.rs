//! A document's state as the agent-facing tools show it: the kit's object types (`<prefix>_query`
//! with `describe: "*"`) and every object reachable from the root through list, tree, map and ref
//! fields (`<prefix>_query` by ids), named by the ids the tools use (tool ids where the kit
//! declares them, which survive saving and reopening). Two snapshots compare with the SDK's own
//! change sets, their objects paired as two reads of a file are (`kition_kdm::reread::diff_paired`):
//! a kit may mint new object ids for the objects without tool ids on every read.
//!
//! A snapshot also names an object as a person would ([`Reference`]): its type, the text it shows
//! and where it is, never its id.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde_json::{Map, Value, json};

use crate::session::{Session, file_name};
use crate::{EnvError, EnvKit, error};

/// How many objects one query reads.
const QUERY_LIMIT: usize = 200;
/// The field names that hold what an object says, in order of preference, when its type has no
/// `text` field.
const LABEL_FIELDS: [&str; 6] = ["text", "name", "title", "label", "caption", "content"];

/// Where an object is: the object whose list field holds it, that field, and its index (from 0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Place {
    pub parent: String,
    pub field: String,
    pub index: usize,
}

/// A document's objects and its kit's object types.
#[derive(Clone, Debug)]
pub struct Snapshot {
    /// What the kit's `model.describe` answers (`root`, `types`).
    pub(crate) described: Value,
    pub(crate) root: String,
    /// Each object by id: `{ "$type": …, <field>: <value>, … }`, the canonical state's form.
    pub(crate) objects: BTreeMap<String, Value>,
    pub(crate) places: BTreeMap<String, Place>,
    /// The objects a ref declared `owns` holds, each with its holder (a sequence its project item,
    /// a comp its item): named through their holder.
    pub(crate) owned: BTreeMap<String, String>,
    /// The field of the owning ref each object of `owned` is held by.
    pub(crate) owned_by: BTreeMap<String, String>,
    /// The object model's schema, read from `described`: what two snapshots are paired by.
    pub(crate) schema: Option<kition_kdm::Schema>,
}

/// Reads the file `bytes` (named like `path`, for its kit) with `kit`, in a workspace of its own.
pub async fn read_snapshot(kit: &EnvKit, path: &str, bytes: &[u8]) -> Result<Snapshot, EnvError> {
    let session = Session::new(kit)?;
    let name = file_name(path).to_owned();
    let read = match session.write(&name, bytes) {
        Ok(()) => read(&session, &name).await,
        Err(failure) => Err(failure),
    };
    session.shutdown().await;
    read
}

fn failed(path: &str, failure: &Value) -> EnvError {
    error(format!("reading the objects of `{path}`: {}", failure["error"]["message"].as_str().unwrap_or("the kit refused")))
}

/// The ids a field's value names: a list's items, a tree's objects, a ref.
/// An id as the tools answer it: a string, or an integer tool id as its number, as text.
fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(id) => Some(id.clone()),
        Value::Number(number) if number.is_u64() => Some(number.to_string()),
        _ => None,
    }
}

/// An object as `_query` answers it with its ids as text: its own, and those its ref, list and
/// tree fields hold (an integer tool id is a number in the answer), as the snapshot keeps them.
fn ids_as_text(kind: &dyn Fn(&str, &str) -> String, object: &mut Value) {
    if let Some(id) = id_text(&object["id"]) {
        object["id"] = Value::String(id);
    }
    let ty = object["type"].as_str().unwrap_or_default().to_owned();
    let Some(fields) = object.get_mut("fields").and_then(Value::as_object_mut) else { return };
    for (field, value) in fields.iter_mut() {
        let text = |value: &mut Value| {
            if let Some(id) = value.as_u64() {
                *value = Value::String(id.to_string());
            }
        };
        match kind(&ty, field).as_str() {
            "ref" => text(value),
            "list" => value.as_array_mut().into_iter().flatten().for_each(text),
            "tree" => {
                for entry in value.as_array_mut().into_iter().flatten() {
                    for key in ["object", "parent"] {
                        if let Some(slot) = entry.get_mut(key) {
                            text(slot);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn named_ids(kind: &str, value: &Value) -> Vec<String> {
    match (kind, value) {
        ("list", Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        ("tree", Value::Array(items)) => items.iter().filter_map(|item| item.get("object").and_then(Value::as_str)).map(str::to_owned).collect(),
        ("ref", Value::String(id)) if !id.is_empty() => vec![id.clone()],
        _ => Vec::new(),
    }
}

/// The snapshot of the workspace's file `path` as the session's kit reads it.
pub(crate) async fn read(session: &Session, path: &str) -> Result<Snapshot, EnvError> {
    let first = session.call("query", path, json!({ "describe": "*" })).await.map_err(|failure| failed(path, &failure))?;
    let mut described =
        first.get("describe").cloned().ok_or_else(|| error(format!("{} describes no object types for `{path}`", session.kit.definition.name)))?;
    let mut commands = Vec::new();
    let mut cursor = String::new();
    while let Ok(page) = session.call("commands", path, json!({ "detail": true, "limit": 100, "cursor": cursor })).await {
        commands.extend(page["commands"].as_array().into_iter().flatten().cloned());
        let Some(next) = page["next"].as_str().filter(|next| *next != cursor) else { break };
        cursor = next.to_owned();
    }
    described["commands"] = Value::Array(commands);
    let mut root = first["objects"][0].clone();
    let root_id = id_text(&root["id"]).ok_or_else(|| error(format!("`{path}` has no root object")))?;
    let schema = kition_kits::drafts::schema_of(&described).ok();
    let mut snapshot =
        Snapshot { described, root: root_id, objects: BTreeMap::new(), places: BTreeMap::new(), owned: BTreeMap::new(), owned_by: BTreeMap::new(), schema };
    let kind_of = |described: &Value| {
        let described = described.clone();
        move |ty: &str, field: &str| described["types"][ty]["fields"][field]["kind"].as_str().unwrap_or("json").to_owned()
    };
    let kind = kind_of(&snapshot.described);
    ids_as_text(&kind, &mut root);
    let mut queue: VecDeque<Value> = VecDeque::from([root]);
    let mut aliases = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::from([snapshot.root.clone()]);
    let mut candidates = Vec::new();
    let mut map_links: BTreeMap<String, (String, String, String, usize)> = BTreeMap::new();
    while !queue.is_empty() || !candidates.is_empty() {
        let mut wanted = Vec::new();
        while let Some(mut object) = queue.pop_front() {
            ids_as_text(&kind, &mut object);
            let id = object["id"].as_str().unwrap_or_default().to_owned();
            let ty = object["type"].as_str().unwrap_or_default().to_owned();
            let fields = object["fields"].as_object().cloned().unwrap_or_default();
            if let Some(limits) = object.get("limits") {
                snapshot.described["objectLimits"][&id] = limits.clone();
            }
            for (field, value) in &fields {
                let kind = snapshot.kind(&ty, field).to_owned();
                let kind = kind.as_str();
                // A tree's node sits among its siblings under its parent node's object (the
                // tree's owner for a root node), as change sets place it.
                let mut siblings: BTreeMap<String, usize> = BTreeMap::new();
                let tree_parents: Vec<String> = match (kind, value) {
                    ("tree", Value::Array(nodes)) => nodes.iter().map(|node| node.get("parent").and_then(Value::as_str).unwrap_or(&id).to_owned()).collect(),
                    _ => Vec::new(),
                };
                let owns = snapshot.type_def(&ty)["fields"][field.as_str()]["owns"] == true;
                if kind == "map" && owns {
                    for (index, (item, at)) in kition_kdm::FieldDef::map_held(value, |_| true).into_iter().enumerate() {
                        map_links.insert(item.clone(), (id.clone(), format!("{field}.{at}"), field.clone(), index));
                        if seen.insert(item.clone()) {
                            candidates.push(item);
                        }
                    }
                }
                for (index, item) in named_ids(kind, value).into_iter().enumerate() {
                    match kind {
                        "list" => {
                            snapshot.places.entry(item.clone()).or_insert(Place { parent: id.clone(), field: field.clone(), index });
                        }
                        "tree" => {
                            let parent = tree_parents.get(index).cloned().unwrap_or_else(|| id.clone());
                            let at = siblings.entry(parent.clone()).or_default();
                            snapshot.places.entry(item.clone()).or_insert(Place { parent, field: field.clone(), index: *at });
                            *at += 1;
                        }
                        "ref" if owns => {
                            snapshot.owned.entry(item.clone()).or_insert(id.clone());
                            snapshot.owned_by.entry(item.clone()).or_insert(field.clone());
                        }
                        _ => {}
                    }
                    if seen.insert(item.clone()) {
                        wanted.push(item);
                    }
                }
            }
            let mut stored: Map<String, Value> = fields;
            stored.insert("$type".into(), Value::String(ty));
            snapshot.objects.insert(id, Value::Object(stored));
        }
        for chunk in wanted.chunks(QUERY_LIMIT) {
            let read = session.call("query", path, json!({ "objects": chunk, "limit": QUERY_LIMIT })).await.map_err(|failure| failed(path, &failure))?;
            queue.extend(read["objects"].as_array().cloned().unwrap_or_default());
        }
        let maybe = std::mem::take(&mut candidates);
        for chunk in maybe.chunks(QUERY_LIMIT) {
            let read = session.call("query", path, json!({"objects":chunk,"limit":QUERY_LIMIT})).await;
            let mut loaded = Vec::new();
            match read {
                Ok(read) => loaded.extend(chunk.iter().cloned().zip(read["objects"].as_array().cloned().unwrap_or_default())),
                Err(_) => {
                    for item in chunk {
                        if let Ok(read) = session.call("query", path, json!({"objects":[item],"limit":1})).await {
                            loaded.extend(read["objects"].as_array().into_iter().flatten().cloned().map(|object| (item.clone(), object)));
                        }
                    }
                }
            }
            for (raw, object) in loaded {
                if let Some(id) = id_text(&object["id"]) {
                    if raw != id {
                        aliases.insert(raw.clone(), id.clone());
                    }
                    if let Some((owner, path, field, index)) = map_links.get(&raw) {
                        snapshot.places.entry(id.clone()).or_insert(Place { parent: owner.clone(), field: field.clone(), index: *index });
                        snapshot.owned.insert(id.clone(), owner.clone());
                        snapshot.owned_by.insert(id, path.clone());
                    }
                    queue.push_back(object);
                }
            }
        }
    }
    named_inside(session, path, &mut snapshot, aliases).await;
    for (child, parent) in &snapshot.owned {
        if snapshot.stable(child)
            && !snapshot.places.contains_key(child)
            && let Some(field) = snapshot.owned_by.get(child).filter(|field| !field.contains('.'))
        {
            snapshot.places.insert(child.clone(), Place { parent: parent.clone(), field: field.clone(), index: 0 });
        }
    }
    Ok(snapshot)
}

/// Whether `text` has the form of an object id kition-kdm mints (a UUID: 8-4-4-4-12 hex digits).
pub(crate) fn minted_form(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The strings in `value` and in its objects' keys (and their `:`-separated segments).
fn strings_in(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => {
            out.insert(text.clone());
        }
        Value::Array(items) => items.iter().for_each(|item| strings_in(item, out)),
        Value::Object(entries) => {
            for (key, item) in entries {
                out.insert(key.clone());
                out.extend(key.split(':').map(str::to_owned));
                strings_in(item, out);
            }
        }
        _ => {}
    }
}

/// `value` with each string, key and key segment `names` maps replaced.
fn renamed_inside(value: &Value, names: &BTreeMap<String, String>) -> Value {
    let key = |key: &str| match names.get(key) {
        Some(name) => name.clone(),
        None if key.contains(':') => key.split(':').map(|segment| names.get(segment).map_or(segment, String::as_str)).collect::<Vec<_>>().join(":"),
        None => key.to_owned(),
    };
    match value {
        Value::String(text) => Value::String(names.get(text).cloned().unwrap_or_else(|| text.clone())),
        Value::Array(items) => Value::Array(items.iter().map(|item| renamed_inside(item, names)).collect()),
        Value::Object(entries) => Value::Object(entries.iter().map(|(name, item)| (key(name), renamed_inside(item, names))).collect()),
        other => other.clone(),
    }
}

/// The tools answer the ids in refs, lists and trees by tool ids, but the ids inside json values
/// and maps as the kit stored them: an object with a tool id named there by its object id (a
/// connector's `look.kind.start`, a click action's slide), which a kit may mint again on every
/// read of the file, would read as changed across a reopen and discard every edit as
/// `receipt-differs`. Each string there of the form of a minted object id that names no object of
/// the snapshot is asked of the kit (a query of no fields answers the object's tool id) and
/// replaced by the id it answers, as the kits server does for changes made outside.
async fn named_inside(session: &Session, path: &str, snapshot: &mut Snapshot, mut names: BTreeMap<String, String>) {
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for object in snapshot.objects.values() {
        let ty = object["$type"].as_str().unwrap_or_default();
        for (field, value) in object.as_object().into_iter().flatten() {
            if matches!(snapshot.kind(ty, field), "json" | "map") {
                strings_in(value, &mut wanted);
            }
        }
    }
    wanted.retain(|text| minted_form(text) && !snapshot.objects.contains_key(text) && !names.contains_key(text));
    let asked: Vec<String> = wanted.into_iter().collect();
    for chunk in asked.chunks(QUERY_LIMIT) {
        let learn = |ids: &[String], answer: &Value, names: &mut BTreeMap<String, String>| {
            for (raw, loaded) in ids.iter().zip(answer["objects"].as_array().into_iter().flatten()) {
                if let Some(id) = id_text(&loaded["id"]).filter(|id| id != raw) {
                    names.insert(raw.clone(), id);
                }
            }
        };
        match session.call("query", path, json!({ "objects": chunk, "fields": [], "limit": QUERY_LIMIT })).await {
            Ok(answer) => learn(chunk, &answer, &mut names),
            Err(_) => {
                for one in chunk.chunks(1) {
                    if let Ok(answer) = session.call("query", path, json!({ "objects": one, "fields": [], "limit": 1 })).await {
                        learn(one, &answer, &mut names);
                    }
                }
            }
        }
    }
    if names.is_empty() {
        return;
    }
    let kinds: BTreeMap<String, Vec<String>> = snapshot
        .objects
        .values()
        .filter_map(|object| object["$type"].as_str())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|ty| {
            (
                ty.to_owned(),
                snapshot.fields(ty).into_iter().filter(|(_, def)| matches!(def["kind"].as_str(), Some("json" | "map"))).map(|(name, _)| name).collect(),
            )
        })
        .collect();
    for object in snapshot.objects.values_mut() {
        let ty = object["$type"].as_str().unwrap_or_default().to_owned();
        let Some(fields) = object.as_object_mut() else { continue };
        for field in kinds.get(&ty).into_iter().flatten() {
            if let Some(value) = fields.get_mut(field) {
                *value = renamed_inside(value, &names);
            }
        }
    }
}

impl Snapshot {
    /// The canonical state (`{ objects }`) the SDK's change sets compare.
    pub fn canonical(&self) -> Value {
        fn nodes(snapshot: &Snapshot, parent: &str, field: &str, depth: usize) -> Value {
            if depth >= 64 {
                return json!([]);
            }
            Value::Array(
                snapshot.items(parent, field).into_iter().map(|id| json!({ "object": id, "children": nodes(snapshot, &id, field, depth + 1) })).collect(),
            )
        }
        let mut objects = self.objects.clone();
        for (id, object) in &mut objects {
            if let Some(ty) = self.type_of(id) {
                for (field, def) in self.fields(ty) {
                    if def["kind"] == "tree" {
                        object[&field] = nodes(self, id, &field, 0);
                    }
                }
            }
        }
        json!({ "objects": objects })
    }

    /// The ids of the document's objects, the root among them.
    pub fn ids(&self) -> Vec<String> {
        self.objects.keys().cloned().collect()
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    /// Whether the kit names objects of some type by tool ids (KitObjectModel OM9).
    pub(crate) fn uses_tool_ids(&self) -> bool {
        self.described["types"].as_object().is_some_and(|types| types.values().any(|def| def["toolId"].is_object()))
    }

    /// Whether `id` is a name that survives saving and reopening the file: the root (tasks name it
    /// `root`), an object that has a tool id (its type declares one and the object has a value in
    /// its field: a shape on a layout may have none), or any object of a kit that declares none
    /// (whose object ids must survive instead).
    pub(crate) fn stable(&self, id: &str) -> bool {
        if id == self.root || !self.uses_tool_ids() {
            return true;
        }
        let Some(ty) = self.type_of(id) else { return false };
        let field = self.type_def(ty)["toolId"]["field"].as_str();
        field.is_some_and(|field| !self.value(id, field).is_null())
    }

    /// The ids tasks and receipts name objects by, which must survive a reopen: the tool ids of a
    /// kit that declares them (the root is named `root`), else every object id, the root's too.
    pub fn stable_ids(&self) -> Vec<String> {
        if !self.uses_tool_ids() {
            return self.ids();
        }
        self.objects.keys().filter(|id| *id != &self.root && self.stable(id)).cloned().collect()
    }

    /// Whether this and `other` hold the same document, their objects paired as two reads of a
    /// file are ([`crate::score::diff`] is empty).
    pub(crate) fn same(&self, other: &Self) -> bool {
        let changes = crate::score::diff(self, other);
        ["created", "changed", "moved", "deleted"].iter().all(|list| changes[*list].as_array().is_none_or(Vec::is_empty))
    }

    /// Only ids first allocated in these receipts may differ. Match them by their final place,
    /// following created parents too, then rename all references with the reread's schema rules.
    pub(crate) fn same_created(&self, other: &Self, ours: &BTreeSet<String>, theirs: &BTreeSet<String>) -> bool {
        if ours.len() != theirs.len() {
            return false;
        }
        let mut names = BTreeMap::new();
        let mut remaining = ours.clone();
        while !remaining.is_empty() {
            let count = remaining.len();
            for id in remaining.clone() {
                let Some(at) = self.places.get(&id) else { continue };
                let parent = if ours.contains(&at.parent) {
                    let Some(parent) = names.get(&at.parent) else { continue };
                    parent
                } else {
                    &at.parent
                };
                let matching: Vec<_> = theirs
                    .iter()
                    .filter(|candidate| {
                        !names.values().any(|used| used == *candidate)
                            && self.type_of(&id) == other.type_of(candidate)
                            && other.places.get(*candidate).is_some_and(|place| place.parent == *parent && place.field == at.field && place.index == at.index)
                    })
                    .collect();
                if let [candidate] = matching.as_slice() {
                    names.insert(id.clone(), (*candidate).clone());
                    remaining.remove(&id);
                }
            }
            if remaining.len() == count {
                return false;
            }
        }
        let Some(schema) = self.schema.as_ref() else { return ours.is_empty() && self.same(other) };
        let pairing = kition_kdm::reread::Pairing::from_ids(names);
        let mut renamed = pairing.renamed(schema, &self.canonical());
        for id in theirs {
            let Some(ty) = other.type_of(id) else { return false };
            if let Some(field) = self.type_def(ty)["toolId"]["field"].as_str()
                && let Some(object) = renamed["objects"].get_mut(id)
            {
                object[field] = other.value(id, field);
            }
        }
        let changes = kition_kdm::reread::diff_paired(schema, &renamed, &other.canonical()).to_json();
        ["created", "changed", "moved", "deleted"].iter().all(|list| changes[*list].as_array().is_none_or(Vec::is_empty))
    }

    pub(crate) fn type_of(&self, id: &str) -> Option<&str> {
        self.objects.get(id)?.get("$type")?.as_str()
    }

    pub(crate) fn value(&self, id: &str, field: &str) -> Value {
        self.objects.get(id).and_then(|object| object.get(field)).cloned().unwrap_or(Value::Null)
    }

    /// The value at `path` of `id`: a field, or a member inside a json field (`props.name`).
    pub(crate) fn value_at(&self, id: &str, path: &str) -> Value {
        let mut segments = path.split('.');
        let mut value = self.value(id, segments.next().unwrap_or_default());
        for segment in segments {
            value = match segment.parse::<usize>() {
                Ok(index) if value.is_array() => value.get(index).cloned().unwrap_or(Value::Null),
                _ => value.get(segment).cloned().unwrap_or(Value::Null),
            };
        }
        value
    }

    /// For an object without a tool id that one with a tool id holds (through lists and owning
    /// refs): that holder and the path from it (`body.paragraphs.0`), as a batch's path target
    /// takes it. None for an object with a tool id, or held by none.
    pub(crate) fn held_path(&self, id: &str) -> Option<(String, String)> {
        if self.stable(id) {
            return None;
        }
        let mut path: Vec<String> = Vec::new();
        let mut at = id.to_owned();
        for _ in 0..64 {
            if self.stable(&at) {
                path.reverse();
                return (!path.is_empty()).then(|| (at, path.join(".")));
            }
            if let Some(holder) = self.owned.get(&at).filter(|_| self.owned_by.get(&at).is_some_and(|path| path.contains('.'))) {
                path.push(self.owned_by.get(&at)?.clone());
                at = holder.clone();
            } else if let Some(place) = self.places.get(&at) {
                path.push(format!("{}.{}", place.field, place.index));
                at = place.parent.clone();
            } else {
                let holder = self.owned.get(&at)?.clone();
                path.push(self.owned_by.get(&at)?.clone());
                at = holder;
            }
        }
        None
    }

    /// The object `path` (`body.paragraphs.0`) reaches from `id` through refs and lists.
    pub(crate) fn object_at(&self, id: &str, path: &str) -> Option<String> {
        let mut at = id.to_owned();
        let segments: Vec<&str> = path.split('.').filter(|segment| !segment.is_empty()).collect();
        let mut index = 0;
        while let Some(segment) = segments.get(index) {
            let ty = self.type_of(&at)?.to_owned();
            at = match self.kind(&ty, segment) {
                "ref" => self.value(&at, segment).as_str()?.to_owned(),
                "list" => {
                    index += 1;
                    let item: usize = segments.get(index)?.parse().ok()?;
                    self.items(&at, segment).get(item)?.clone()
                }
                _ => return None,
            };
            index += 1;
        }
        Some(at)
    }

    /// How a person reads the value of `ty.field` (its declared `display`): a tick count
    /// as a timecode (`00:00:05:00`) or a clock time; None when the field declares none.
    pub(crate) fn displayed(&self, ty: &str, field: &str, value: &Value) -> Option<String> {
        let display = &self.type_def(ty)["fields"][field]["display"];
        if display["kind"] != "time" {
            return None;
        }
        let per_second = display["perSecond"].as_f64().filter(|units| *units > 0.0)?;
        let units = value.as_f64().or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
        let seconds = units / per_second;
        let sign = if seconds < 0.0 { "-" } else { "" };
        let whole = seconds.abs();
        let (h, m) = ((whole / 3600.0).floor(), ((whole % 3600.0) / 60.0).floor());
        let s = whole % 60.0;
        Some(match display["fps"].as_f64().filter(|fps| *fps > 0.0) {
            Some(fps) => {
                let frames = ((s.fract()) * fps).round().min(fps.ceil() - 1.0);
                format!("{sign}{h:02}:{m:02}:{:02}:{frames:02}", s.floor())
            }
            None => format!("{sign}{h:02}:{m:02}:{s:06.3}"),
        })
    }

    pub(crate) fn place(&self, id: &str) -> Option<&Place> {
        self.places.get(id)
    }

    /// A stored index as a kit with reversed index spelling shows it. Any command declaring
    /// reversed indexes for this type establishes that convention for generated instructions.
    pub(crate) fn spelled_index(&self, parent: &str, field: &str, index: usize, inserted: bool) -> usize {
        fn reversed(value: &Value, ty: &str) -> bool {
            match value {
                Value::Object(object) => {
                    let types = object.get("x-khp-types").and_then(Value::as_array);
                    (object.get("x-khp-index-order").and_then(Value::as_str) == Some("reversed")
                        && types.is_none_or(|types| types.iter().any(|entry| entry.as_str() == Some(ty))))
                        || object.values().any(|value| reversed(value, ty))
                }
                Value::Array(values) => values.iter().any(|value| reversed(value, ty)),
                _ => false,
            }
        }
        let owner = self.tree_owner(parent, field).unwrap_or_else(|| parent.to_owned());
        let ty = self.type_of(&owner).and_then(|ty| self.type_def(ty)["fields"][field]["of"].as_str()).unwrap_or_default();
        if reversed(&self.described["commands"], ty) { (self.items(parent, field).len() + usize::from(inserted)).saturating_sub(index + 1) } else { index }
    }

    /// The place of the object holding `at` in a list or tree, `at` itself or, for an object a
    /// ref declared `owns` holds (a sequence its item), the object holding that ref: what a
    /// reference names it through.
    fn place_up(&self, at: &str) -> Option<&Place> {
        let mut at = at;
        for _ in 0..64 {
            if let Some(place) = self.places.get(at) {
                return Some(place);
            }
            at = self.owned.get(at)?;
        }
        None
    }

    /// `at`, or the object whose owning ref holds it, until one a list or tree holds (or the root).
    fn listed_up<'a>(&'a self, at: &'a str) -> &'a str {
        let mut at = at;
        for _ in 0..64 {
            if at == self.root || self.places.contains_key(at) {
                return at;
            }
            match self.owned.get(at) {
                Some(holder) => at = holder,
                None => return at,
            }
        }
        at
    }

    /// The kit's description of the type `ty`.
    pub(crate) fn type_def(&self, ty: &str) -> &Value {
        &self.described["types"][ty]
    }

    /// The field definitions of `ty`, by name.
    pub(crate) fn fields(&self, ty: &str) -> Vec<(String, Value)> {
        self.type_def(ty)["fields"].as_object().map(|fields| fields.iter().map(|(name, def)| (name.clone(), def.clone())).collect()).unwrap_or_default()
    }

    pub(crate) fn kind(&self, ty: &str, field: &str) -> &str {
        self.type_def(ty)["fields"][field]["kind"].as_str().unwrap_or("json")
    }

    /// Whether the object model never writes `field` of `ty`: a read-only field (OM8), the field
    /// holding the type's tool id (OM9), or the enum that makes an object read-only.
    pub(crate) fn kept(&self, ty: &str, field: &str) -> bool {
        let def = self.type_def(ty);
        def["fields"][field]["readOnly"] == true || def["toolId"]["field"] == field || def["readOnlyWhen"]["field"] == field
    }

    /// Tool identities are allocated by the kit; immutable content can be supplied at creation.
    pub(crate) fn creation_kept(&self, ty: &str, field: &str) -> bool {
        self.type_def(ty)["toolId"]["field"] == field
    }

    /// Whether the object model writes no object of `ty`, or not `id` (`readOnlyWhen`).
    pub(crate) fn read_only(&self, ty: &str, id: Option<&str>) -> bool {
        let def = self.type_def(ty);
        if def["readOnly"] == true {
            return true;
        }
        match (def.get("readOnlyWhen"), id) {
            (Some(when), Some(id)) => {
                let value = self.value(id, when["field"].as_str().unwrap_or_default());
                when["values"].as_array().is_some_and(|values| values.contains(&value))
            }
            _ => false,
        }
    }

    /// The field whose text says what an object of `ty` is: its `text` field, else the first of
    /// [`LABEL_FIELDS`] that is a string; none when the type has neither.
    pub(crate) fn label_field(&self, ty: &str) -> Option<String> {
        // The type's own word for it: a field or a member of a json field.
        if let Some(path) = self.type_def(ty)["label"].as_str() {
            return Some(path.to_owned());
        }
        if let Some(path) = self.type_def(ty)["text"].as_str() {
            return Some(path.to_owned());
        }
        let fields = self.fields(ty);
        let usable = |name: &str, def: &Value| !self.kept(ty, name) || def["kind"] == "text" && def["readOnly"] != true;
        if let Some((name, _)) = fields.iter().find(|(name, def)| def["kind"] == "text" && usable(name, def)) {
            return Some(name.clone());
        }
        LABEL_FIELDS
            .iter()
            .find(|name| fields.iter().any(|(field, def)| field == *name && def["kind"] == "string" && usable(field, def)))
            .map(|name| (*name).to_owned())
    }

    pub(crate) fn text_field(&self, ty: &str) -> Option<String> {
        self.type_def(ty)["text"].as_str().map(str::to_owned).or_else(|| self.label_field(ty))
    }

    fn quoting(&self, ty: &str, path: &str) -> Quoting {
        if self.type_def(ty)["text"] == path {
            Quoting::Says
        } else {
            Quoting::of(path.rsplit('.').next().unwrap_or(path), self.kind(ty, path.split('.').next().unwrap_or(path)))
        }
    }

    /// What `id` says: its label field's text, trimmed; empty when it says nothing.
    pub(crate) fn label(&self, id: &str) -> Option<String> {
        let ty = self.type_of(id)?;
        let field = self.label_field(ty)?;
        Some(text_of(&self.value_at(id, &field)).trim().to_owned())
    }

    /// The objects held by the list field `field` of `parent`, in order.
    pub(crate) fn items(&self, parent: &str, field: &str) -> Vec<String> {
        let mut items: Vec<_> = self.places.iter().filter(|(_, place)| place.parent == parent && place.field == field).collect();
        items.sort_by_key(|(_, place)| place.index);
        items.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// The owner of the tree containing this sibling group (whose parent may be a node).
    pub(crate) fn tree_owner(&self, parent: &str, field: &str) -> Option<String> {
        let mut at = parent;
        for _ in 0..64 {
            if self.type_of(at).is_some_and(|ty| self.kind(ty, field) == "tree") {
                return Some(at.to_owned());
            }
            let place = self.place(at)?;
            if place.field != field {
                return None;
            }
            at = &place.parent;
        }
        None
    }

    pub(crate) fn tree_move(&self, id: &str, parent: &str, field: &str, at: usize) -> Option<Vec<Value>> {
        let owner = self.tree_owner(parent, field)?;
        let target = if owner == self.root { "root" } else { &owner };
        let parent = if parent == owner { Value::Null } else { json!(parent) };
        let mut ops = vec![json!({ "op": "tree.move", "target": target, "field": field, "item": id, "parent": parent })];
        let siblings = self.items(parent.as_str().unwrap_or(&owner), field);
        let siblings: Vec<_> = siblings.into_iter().filter(|sibling| sibling != id).collect();
        for later in siblings.iter().skip(at) {
            ops.push(json!({ "op": "tree.move", "target": target, "field": field, "item": later, "parent": parent }));
        }
        Some(ops)
    }

    /// Whether the type of `parent` has another list field holding objects of `of` than `field`.
    fn shares_item_type(&self, parent: &str, field: &str) -> bool {
        let Some(ty) = self.type_of(parent) else { return false };
        let of = &self.type_def(ty)["fields"][field]["of"];
        self.fields(ty).iter().any(|(name, def)| name != field && def["kind"] == "list" && def["of"] == *of)
    }

    /// How a person names `id`, from what the tools show of it and of the objects around it; none
    /// for the root and for an object no list holds.
    pub fn reference(&self, id: &str) -> Option<Reference> {
        let place = self.place(id)?;
        let ty = self.type_of(id)?.to_owned();
        let mut chain = Vec::new();
        let mut at = self.listed_up(&place.parent).to_owned();
        let mut depth = 0;
        while at != self.root {
            depth += 1;
            if depth > 64 {
                return None;
            }
            let up = self.place_up(&at)?;
            chain.push(Step {
                ty: self.type_of(&at)?.to_owned(),
                index: self.spelled_index(&up.parent, &up.field, up.index, false),
                field: self.shares_item_type(&up.parent, &up.field).then(|| up.field.clone()),
                label: self.unique_label(&at, up),
            });
            at = self.listed_up(&up.parent).to_owned();
        }
        let field = self.shares_item_type(&place.parent, &place.field).then(|| place.field.clone());
        let quoting = self.label_field(&ty).map_or(Quoting::Says, |label| self.quoting(&ty, &label));
        let naming = match self.label_field(&ty) {
            None => Naming::Position,
            Some(_) => {
                let label = self.label(id).unwrap_or_default();
                let twins = self.items(&place.parent, &place.field).iter().filter(|other| self.label(other).as_deref() == Some(label.as_str())).count();
                if !label.is_empty() && twins == 1 { Naming::Says(label) } else { Naming::Ordinal(if label.is_empty() { None } else { Some(label) }) }
            }
        };
        Some(Reference { ty, index: self.spelled_index(&place.parent, &place.field, place.index, false), field, naming, quoting, chain })
    }

    /// The objects `reference` names in this snapshot: exactly one when it was made here.
    pub fn resolve(&self, reference: &Reference) -> Vec<String> {
        self.objects
            .keys()
            .filter(|id| {
                let Some(place) = self.place(id) else { return false };
                if self.type_of(id) != Some(reference.ty.as_str()) || reference.field.as_ref().is_some_and(|field| *field != place.field) {
                    return false;
                }
                let named = match &reference.naming {
                    Naming::Position | Naming::Ordinal(_) => self.spelled_index(&place.parent, &place.field, place.index, false) == reference.index,
                    Naming::Says(label) => self.label(id).as_deref() == Some(label.as_str()),
                };
                named && self.chain_matches(&place.parent, &reference.chain)
            })
            .cloned()
            .collect()
    }

    /// A holder's label when its type has one ([`Snapshot::label_field`]) and no sibling says the
    /// same: it is then named by it (`the item named "Sequence 01"`).
    fn unique_label(&self, at: &str, place: &Place) -> Option<(Quoting, String)> {
        let ty = self.type_of(at)?;
        let path = self.label_field(ty)?;
        let path = path.as_str();
        let label = self.label(at).filter(|label| !label.is_empty())?;
        // Its siblings: what the same list or tree holds under the same parent.
        let twins = self
            .places
            .iter()
            .filter(|(other, at)| at.parent == place.parent && at.field == place.field && self.label(other).as_deref() == Some(label.as_str()))
            .count();
        (twins == 1).then(|| (self.quoting(ty, path), label))
    }

    fn chain_matches(&self, parent: &str, chain: &[Step]) -> bool {
        let mut at = self.listed_up(parent).to_owned();
        for step in chain {
            let (Some(place), Some(ty)) = (self.place_up(&at), self.type_of(&at)) else { return false };
            if ty != step.ty
                || self.spelled_index(&place.parent, &place.field, place.index, false) != step.index
                || step.field.as_ref().is_some_and(|field| *field != place.field)
            {
                return false;
            }
            at = self.listed_up(&place.parent).to_owned();
        }
        at == self.root
    }
}

/// A field's text: a string, or a marked text's runs joined.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(runs) => runs.iter().filter_map(|run| run.get("insert").and_then(Value::as_str)).collect(),
        _ => String::new(),
    }
}

/// One object around the one named: its type and index among its siblings, and the field holding
/// it when its parent has two holding that type.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Step {
    ty: String,
    index: usize,
    field: Option<String>,
    /// Its label, when its type declares one and it is the only one of its siblings saying it.
    label: Option<(Quoting, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Naming {
    /// "the shape that says "Q3 revenue"": the only one of its siblings that says it.
    Says(String),
    /// "the 2nd shape", and what it says when it says something: its siblings say the same, or
    /// it says nothing.
    Ordinal(Option<String>),
    /// "slide 3": its type says nothing about it.
    Position,
}

/// How an instruction quotes an object's label: what the object says (its text content: a `text`
/// field, or one named `text` or `content`), or what it is named, titled, labelled or captioned
/// (the field of that name). The words say truthfully which field the quoted value is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Quoting {
    Says,
    Named,
    Titled,
    Labelled,
    Captioned,
}

impl Quoting {
    fn of(field: &str, kind: &str) -> Self {
        match field {
            _ if kind == "text" => Self::Says,
            "name" => Self::Named,
            "title" => Self::Titled,
            "label" => Self::Labelled,
            "caption" => Self::Captioned,
            _ => Self::Says,
        }
    }

    /// After the object, restricting it: `that says`, `named`.
    fn restricting(self) -> &'static str {
        match self {
            Self::Says => "that says",
            Self::Named => "named",
            Self::Titled => "titled",
            Self::Labelled => "labelled",
            Self::Captioned => "captioned",
        }
    }

    /// In an aside: `which says`, `named`.
    fn aside(self) -> &'static str {
        match self {
            Self::Says => "which says",
            other => other.restricting(),
        }
    }
}

/// An object as a person names it: by what it says (or is named), or by its place among its
/// siblings, and where it is ("on slide 3"). Never by its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    ty: String,
    index: usize,
    field: Option<String>,
    naming: Naming,
    quoting: Quoting,
    /// The objects holding it, the nearest first, up to (not including) the root.
    chain: Vec<Step>,
}

impl Reference {
    /// The object itself, ending a clause: `the shape that says "Q3 revenue"`, `the 2nd shape,
    /// which says "Same"`, `slide 3`.
    pub fn phrase(&self) -> String {
        self.named("", false)
    }

    /// [`Self::phrase`] followed by more of its sentence: an aside is closed with a comma.
    pub fn phrase_within(&self) -> String {
        self.named("", true)
    }

    /// The object and where it is: `the shape on slide 1 that says "Body"`, `the 3rd shape on
    /// slide 2, which says "Same"`.
    pub fn located(&self) -> String {
        self.named(&self.whereabouts(), false)
    }

    /// [`Self::located`] followed by more of its sentence.
    pub fn located_within(&self) -> String {
        self.named(&self.whereabouts(), true)
    }

    fn named(&self, place: &str, within: bool) -> String {
        let ty = words(&self.ty);
        let held = self.field.as_ref().map(|field| format!(" in {}", words(field))).unwrap_or_default();
        let place = if place.is_empty() { String::new() } else { format!(" {place}") };
        let close = if within { "," } else { "" };
        match &self.naming {
            Naming::Says(label) => format!("the {ty}{held}{place} {} {}", self.quoting.restricting(), quoted(label)),
            Naming::Ordinal(Some(label)) => format!("the {} {ty}{held}{place}, {} {}{close}", ordinal(self.index + 1), self.quoting.aside(), quoted(label)),
            Naming::Ordinal(None) => format!("the {} {ty}{held}{place}", ordinal(self.index + 1)),
            Naming::Position => format!("{ty} {}{held}{place}", self.index + 1),
        }
    }

    /// Where it is, to start a sentence: `On slide 1`, `In group 2 on slide 1`; empty for an
    /// object the document itself holds.
    pub fn place(&self) -> String {
        let mut parts = self.chain.iter().map(|step| {
            let held = step.field.as_ref().map(|field| format!(" in {}", words(field))).unwrap_or_default();
            match &step.label {
                Some((quoting, label)) => format!("the {}{held} {} {}", words(&step.ty), quoting.restricting(), quoted(label)),
                None => format!("{} {}{held}", words(&step.ty), step.index + 1),
            }
        });
        match parts.next() {
            None => String::new(),
            Some(first) => {
                let rest: Vec<String> = parts.collect();
                if rest.is_empty() { format!("On {first}") } else { format!("In {first} on {}", rest.join(" on ")) }
            }
        }
    }

    /// [`Self::place`] inside a sentence: `on slide 1`, `in group 2 on slide 1`.
    fn whereabouts(&self) -> String {
        let place = self.place();
        match place.split_once(' ') {
            Some((first, rest)) => format!("{} {rest}", first.to_lowercase()),
            None => place,
        }
    }
}

/// `TextBox` and `text_box` as `text box`.
pub(crate) fn words(name: &str) -> String {
    let mut out = String::new();
    for (at, c) in name.chars().enumerate() {
        if c == '_' || c == '-' {
            out.push(' ');
        } else if c.is_uppercase() {
            if at > 0 && !out.ends_with(' ') {
                out.push(' ');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// `1st`, `2nd`, `3rd`, `11th`, …
pub(crate) fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// A text in double quotes.
pub(crate) fn quoted(text: &str) -> String {
    format!("\"{text}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creation_graph(prefix: &str) -> Snapshot {
        let described = json!({"root":"Root","types":{
            "Root":{"fields":{"items":{"kind":"list","of":"Item"}}},
            "Item":{"fields":{"name":{"kind":"string"},"children":{"kind":"list","of":"Item"},"peer":{"kind":"ref","of":"Item","optional":true},"data":{"kind":"json","optional":true}}}
        }});
        let schema =
            kition_kdm::Schema::parse(&json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":described["root"],"types":described["types"]}).to_string())
                .unwrap();
        let (parent, child) = (format!("{prefix}-parent"), format!("{prefix}-child"));
        let mut objects = BTreeMap::new();
        let mut places = BTreeMap::new();
        objects.insert("root".into(), json!({"$type":"Root","items":["old0","old1","old2","old3",parent]}));
        for i in 0..4 {
            let id = format!("old{i}");
            objects.insert(id.clone(),json!({"$type":"Item","name":id,"children":[],"peer":if i==0 {child.clone()} else {String::new()},"data":if i==0 {json!({"ref":child,format!("{parent}:{child}"):parent})} else {Value::Null}}));
            places.insert(id, Place { parent: "root".into(), field: "items".into(), index: i });
        }
        objects.insert(parent.clone(), json!({"$type":"Item","name":"Parent","children":[child],"peer":"old1","data":null}));
        objects.insert(child.clone(), json!({"$type":"Item","name":"Child","children":[],"peer":parent,"data":{"self":child}}));
        places.insert(parent.clone(), Place { parent: "root".into(), field: "items".into(), index: 4 });
        places.insert(child, Place { parent, field: "children".into(), index: 0 });
        Snapshot { described, root: "root".into(), objects, places, owned: BTreeMap::new(), owned_by: BTreeMap::new(), schema: Some(schema) }
    }

    #[test]
    fn created_id_equivalence_is_consistent_and_scoped_to_receipts() {
        let a = creation_graph("a");
        let b = creation_graph("b");
        let allocated = |prefix: &str| BTreeSet::from([format!("{prefix}-parent"), format!("{prefix}-child")]);
        assert!(!a.same(&b));
        assert!(a.same_created(&b, &allocated("a"), &allocated("b")));
        for field in ["name", "peer", "data"] {
            let mut wrong = b.clone();
            wrong.objects.get_mut("b-child").unwrap()[field] = json!(if field == "peer" { "old2" } else { "Different" });
            assert!(!a.same_created(&wrong, &allocated("a"), &allocated("b")), "{field}");
        }
        let mut crossed = b.clone();
        crossed.objects.get_mut("old0").unwrap()["peer"] = json!("b-parent");
        assert!(!a.same_created(&crossed, &allocated("a"), &allocated("b")));
        let mut replaced = b.clone();
        let object = replaced.objects.remove("old1").unwrap();
        replaced.objects.insert("replacement".into(), object);
        replaced.objects.get_mut("root").unwrap()["items"][1] = json!("replacement");
        replaced.objects.get_mut("b-parent").unwrap()["peer"] = json!("replacement");
        assert!(!a.same_created(&replaced, &allocated("a"), &allocated("b")));
        assert!(!a.same_created(&b, &BTreeSet::new(), &BTreeSet::new()));
        assert!(!a.same_created(&b, &allocated("a"), &BTreeSet::from(["b-parent".into()])));
        let mut literal = b.clone();
        literal.objects.get_mut("b-child").unwrap()["name"] = json!("b-child");
        let mut original_literal = a.clone();
        original_literal.objects.get_mut("a-child").unwrap()["name"] = json!("a-child");
        assert!(!original_literal.same_created(&literal, &allocated("a"), &allocated("b")));
        let mut a_tree = a.clone();
        let mut b_tree = b.clone();
        for snapshot in [&mut a_tree, &mut b_tree] {
            snapshot.described["types"]["Root"]["fields"]["items"]["kind"] = json!("tree");
            snapshot.described["types"]["Item"]["fields"]["children"]["kind"] = json!("tree");
            snapshot.schema = Some(
                kition_kdm::Schema::parse(
                    &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":snapshot.described["root"],"types":snapshot.described["types"]}).to_string(),
                )
                .unwrap(),
            );
        }
        assert!(a_tree.same_created(&b_tree, &allocated("a"), &allocated("b")));
    }

    /// A snapshot of one slide holding `shapes` of a type whose label is `field` (of `kind`).
    fn slide_of(field: &str, kind: &str, shapes: &[&str]) -> Snapshot {
        let described = json!({ "root": "Deck", "types": {
            "Deck": { "fields": { "slides": { "kind": "list", "of": "Slide" } } },
            "Slide": { "fields": { "shapes": { "kind": "list", "of": "Shape" } } },
            "Shape": { "fields": { field: { "kind": kind } } }
        } });
        let mut objects = BTreeMap::new();
        let mut places = BTreeMap::new();
        objects.insert("deck".to_owned(), json!({ "$type": "Deck", "slides": ["s1"] }));
        objects.insert("s1".to_owned(), json!({ "$type": "Slide", "shapes": shapes.iter().enumerate().map(|(at, _)| format!("p{at}")).collect::<Vec<_>>() }));
        places.insert("s1".to_owned(), Place { parent: "deck".to_owned(), field: "slides".to_owned(), index: 0 });
        for (at, label) in shapes.iter().enumerate() {
            objects.insert(format!("p{at}"), json!({ "$type": "Shape", field: label }));
            places.insert(format!("p{at}"), Place { parent: "s1".to_owned(), field: "shapes".to_owned(), index: at });
        }
        Snapshot { described, root: "deck".to_owned(), objects, places, owned: BTreeMap::new(), owned_by: BTreeMap::new(), schema: None }
    }

    /// A clip a list holds in a track of a sequence that a project item holds through a ref
    /// declared `owns`, the item in a bin of a tree (a video kit's project): it is named through
    /// the item, the sequence skipped, and resolves back to itself.
    #[test]
    fn an_object_under_an_owned_ref_and_a_tree_is_named_through_its_holder() {
        let described = json!({ "root": "Project", "types": {
            "Project": { "fields": { "bins": { "kind": "tree", "of": "Bin" } } },
            "Bin": { "fields": { "entries": { "kind": "list", "of": "Item" } } },
            "Item": { "fields": { "name": { "kind": "string" }, "sequence": { "kind": "ref", "of": "Sequence", "owns": true } } },
            "Sequence": { "fields": { "videoTracks": { "kind": "list", "of": "Track" }, "audioTracks": { "kind": "list", "of": "Track" } } },
            "Track": { "fields": { "clips": { "kind": "list", "of": "Clip" } } },
            "Clip": { "fields": { "start": { "kind": "string" } } }
        } });
        let mut objects = BTreeMap::new();
        objects.insert("p".to_owned(), json!({ "$type": "Project", "bins": [{ "object": "b" }] }));
        objects.insert("b".to_owned(), json!({ "$type": "Bin", "entries": ["i1", "i2"] }));
        objects.insert("i1".to_owned(), json!({ "$type": "Item", "name": "Footage" }));
        objects.insert("i2".to_owned(), json!({ "$type": "Item", "name": "Cut", "sequence": "s" }));
        objects.insert("s".to_owned(), json!({ "$type": "Sequence", "videoTracks": ["t1"], "audioTracks": [] }));
        objects.insert("t1".to_owned(), json!({ "$type": "Track", "clips": ["c1", "c2"] }));
        objects.insert("c1".to_owned(), json!({ "$type": "Clip", "start": "0" }));
        objects.insert("c2".to_owned(), json!({ "$type": "Clip", "start": "1" }));
        let place = |parent: &str, field: &str, index: usize| Place { parent: parent.to_owned(), field: field.to_owned(), index };
        let places = BTreeMap::from([
            ("b".to_owned(), place("p", "bins", 0)),
            ("i1".to_owned(), place("b", "entries", 0)),
            ("i2".to_owned(), place("b", "entries", 1)),
            ("t1".to_owned(), place("s", "videoTracks", 0)),
            ("c1".to_owned(), place("t1", "clips", 0)),
            ("c2".to_owned(), place("t1", "clips", 1)),
        ]);
        let owned = BTreeMap::from([("s".to_owned(), "i2".to_owned())]);
        let snapshot = Snapshot { described, root: "p".to_owned(), objects, places, owned, owned_by: BTreeMap::new(), schema: None };
        let reference = snapshot.reference("c2").unwrap_or_else(|| panic!("the clip is describable"));
        assert_eq!(snapshot.resolve(&reference), ["c2"]);
        // a holder with a label no sibling shares is named by it (was `on item 2`).
        assert_eq!(reference.place(), "In track 1 in video tracks on the item named \"Cut\" on bin 1");
    }

    /// An instruction quoting a shape's name says it is named so; only text content "says"
    /// (regressions/issue-kit-env-quoting).
    #[test]
    fn a_quoted_label_names_the_field_it_is() {
        let named = slide_of("name", "string", &["TextBox 1", "Same", "Same"]);
        assert_eq!(named.reference("p0").map(|reference| reference.located()), Some("the shape on slide 1 named \"TextBox 1\"".to_owned()));
        assert_eq!(named.reference("p2").map(|reference| reference.phrase_within()), Some("the 3rd shape, named \"Same\",".to_owned()));
        let titled = slide_of("title", "string", &["Intro"]);
        assert_eq!(titled.reference("p0").map(|reference| reference.phrase()), Some("the shape titled \"Intro\"".to_owned()));
        let says = slide_of("text", "string", &["Q3 revenue", "Same", "Same"]);
        assert_eq!(says.reference("p0").map(|reference| reference.phrase()), Some("the shape that says \"Q3 revenue\"".to_owned()));
        assert_eq!(says.reference("p1").map(|reference| reference.phrase_within()), Some("the 2nd shape, which says \"Same\",".to_owned()));
        let content = slide_of("body", "text", &["Hello"]);
        assert_eq!(content.reference("p0").map(|reference| reference.phrase()), Some("the shape that says \"Hello\"".to_owned()));
    }

    #[test]
    fn c8_boolean_words_use_field_labels_for_both_states_and_inverse() {
        let mut start = slide_of("name", "string", &["Panel"]);
        start.described["types"]["Shape"]["fields"]["isClipped"] = json!({ "kind": "boolean", "label": "clipped" });
        for (state, words) in [(true, "clipped"), (false, "not clipped")] {
            let truth = json!({ "changed": [{ "id": "p0", "type": "Shape", "edits": [{ "field": "isClipped", "before": !state, "after": state }] }] });
            assert_eq!(
                crate::instruction::instruction("set-field", &truth, &start, false).unwrap(),
                format!("Set the shape on slide 1 named \"Panel\" to {words}.")
            );
            assert_eq!(
                crate::instruction::instruction("set-field", &truth, &start, true).unwrap(),
                format!("Set the shape on slide 1 named \"Panel\" back to {words}.")
            );
        }
    }
}
