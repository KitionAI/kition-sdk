//! The document in memory (plan 2026-11-24, plain model, section 1.1): objects by id, each with
//! its type and the fields it holds. A field it does not hold reads as empty; a container field
//! (text, list, map, tree) exists only while it holds something.
//!
//! Every change goes through [`Store::apply`], one operation at a time ([`op::Op`]): it checks
//! the operation's preconditions against the state (the object exists, the positions are in
//! range, the list item at a position is the one named), changes nothing when they fail
//! ([`KdmError::Stale`]), and answers the operation as applied, with what its inverse
//! ([`op::inverse`]) needs.

pub(crate) mod op;
pub(crate) mod text;
pub(crate) mod transform;
pub(crate) mod tree;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Map, Value};

use crate::content::{Content, ContentVersion, TYPE_KEY};
use crate::{DocId, Expand, FieldKind, KdmError, ObjectId, Result, Schema, TextRun};
use op::{Name, Op, TreePlace};
use text::Text;
use tree::Tree;

/// One field an object holds.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Field {
    /// A register: any field that is not a container, and any field the schema does not declare.
    Value(Value),
    Text(Box<Text>),
    List(Vec<ObjectId>),
    Map(BTreeMap<String, Value>),
    Tree(Box<Tree>),
}

impl Field {
    /// Whether the field holds nothing: a container field is then left out.
    fn is_empty(&self) -> bool {
        match self {
            Self::Value(value) => value.is_null(),
            Self::Text(text) => text.is_empty(),
            Self::List(items) => items.is_empty(),
            Self::Map(entries) => entries.is_empty(),
            Self::Tree(tree) => tree.is_empty(),
        }
    }

    /// The field in its content form (data model 7.4, rule C8); `None` when it is empty.
    /// `marked`: the schema declares marks for this text field.
    pub(crate) fn content(&self, marked: bool) -> Option<Value> {
        if self.is_empty() {
            return None;
        }
        Some(match self {
            Self::Value(value) => value.clone(),
            Self::Text(text) if marked || text.has_marks() => Value::Array(text.runs().iter().map(TextRun::to_json).collect()),
            Self::Text(text) => Value::String(text.string()),
            Self::List(items) => Value::Array(items.iter().map(|item| Value::String(item.to_string())).collect()),
            Self::Map(entries) => Value::Object(entries.iter().map(|(key, value)| (key.clone(), value.clone())).collect()),
            Self::Tree(tree) => tree.to_json(&|_| true),
        })
    }

    /// A field from its content form, as the schema declares it (`kind`; `None`: a register).
    fn from_content(value: &Value, kind: Option<FieldKind>) -> Result<Self> {
        let bad = |what: &str| KdmError::Encoding(format!("a {what} field holds {value}"));
        Ok(match kind {
            Some(FieldKind::Text) => match value {
                Value::String(text) => Self::Text(Box::new(Text::plain(text))),
                Value::Array(_) => {
                    let runs: Vec<TextRun> = serde_json::from_value(value.clone()).map_err(|_| bad("text"))?;
                    Self::Text(Box::new(Text::from_runs(&runs)))
                }
                _ => return Err(bad("text")),
            },
            Some(FieldKind::List) => Self::List(
                value
                    .as_array()
                    .ok_or_else(|| bad("list"))?
                    .iter()
                    .map(|item| item.as_str().map(ObjectId::from_string).ok_or_else(|| bad("list")))
                    .collect::<Result<Vec<_>>>()?,
            ),
            Some(FieldKind::Map) => Self::Map(value.as_object().ok_or_else(|| bad("map"))?.iter().map(|(key, value)| (key.clone(), value.clone())).collect()),
            Some(FieldKind::Tree) => Self::Tree(Box::new(Tree::from_json(value)?)),
            _ => Self::Value(value.clone()),
        })
    }
}

/// One object: its type and the fields it holds, sorted by name.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Object {
    pub(crate) ty: Name,
    fields: Vec<(Name, Field)>,
}

impl Object {
    pub(crate) fn new(ty: Name) -> Self {
        Self { ty, fields: Vec::new() }
    }

    fn position(&self, name: &str) -> std::result::Result<usize, usize> {
        self.fields.binary_search_by(|(held, _)| (**held).cmp(name))
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Field> {
        self.position(name).ok().and_then(|at| self.fields.get(at)).map(|(_, field)| field)
    }

    fn get_mut(&mut self, name: &str) -> Option<&mut Field> {
        let at = self.position(name).ok()?;
        self.fields.get_mut(at).map(|(_, field)| field)
    }

    /// Sets a field; an empty one is removed.
    pub(crate) fn put(&mut self, name: Name, field: Field) {
        if field.is_empty() {
            self.take(&name);
            return;
        }
        match self.position(&name) {
            Ok(at) => {
                if let Some(slot) = self.fields.get_mut(at) {
                    slot.1 = field;
                }
            }
            Err(at) => self.fields.insert(at, (name, field)),
        }
    }

    fn take(&mut self, name: &str) -> Option<Field> {
        let at = self.position(name).ok()?;
        Some(self.fields.remove(at).1)
    }

    /// Removes the field when it became empty.
    fn settle(&mut self, name: &str) {
        if self.get(name).is_some_and(Field::is_empty) {
            self.take(name);
        }
    }

    /// The fields the object holds, by name.
    pub(crate) fn fields(&self) -> impl Iterator<Item = (&Name, &Field)> {
        self.fields.iter().map(|(name, field)| (name, field))
    }

    /// The object's content form: `$type` and every field it holds (data model 7.4).
    pub(crate) fn to_content(&self, schema: &Schema) -> Map<String, Value> {
        let def = schema.types.get(&*self.ty);
        let mut out = Map::new();
        out.insert(TYPE_KEY.to_owned(), Value::String(self.ty.to_string()));
        for (name, field) in &self.fields {
            let marked = def.and_then(|def| def.fields.get(&**name)).is_some_and(crate::FieldDef::has_marks);
            if let Some(value) = field.content(marked) {
                out.insert(name.to_string(), value);
            }
        }
        out
    }

    /// An object from its content form; each field as the schema declares it, a field it does not
    /// declare as a register.
    pub(crate) fn from_content(fields: &Map<String, Value>, schema: &Schema) -> Result<Self> {
        let ty = fields.get(TYPE_KEY).and_then(Value::as_str).ok_or_else(|| KdmError::Encoding("an object has no `$type`".into()))?;
        let def = schema.types.get(ty);
        let mut object = Self::new(Name::from(ty));
        for (name, value) in fields {
            if name == TYPE_KEY || value.is_null() {
                continue;
            }
            let kind = def.and_then(|def| def.fields.get(name)).map(|field| field.kind);
            object.put(Name::from(name.as_str()), Field::from_content(value, kind)?);
        }
        Ok(object)
    }
}

/// The trees holding an object as a node: each owner and tree field.
type Holders = Vec<(ObjectId, Name)>;

/// One document's state.
#[derive(Clone, Debug)]
pub(crate) struct Store {
    pub(crate) doc_id: DocId,
    pub(crate) kit: String,
    /// The minimum schema version (rule M20).
    pub(crate) schema_version: u64,
    objects: HashMap<ObjectId, Object>,
    /// For each object that is a node of a tree, the trees holding it.
    nodes: HashMap<ObjectId, Holders>,
    /// The type and field names in use, each held once.
    names: HashSet<Name>,
}

impl PartialEq for Store {
    fn eq(&self, other: &Self) -> bool {
        let sorted = |nodes: &HashMap<ObjectId, Holders>| -> BTreeMap<ObjectId, Vec<(ObjectId, String)>> {
            nodes
                .iter()
                .map(|(node, holders)| {
                    let mut holders: Vec<(ObjectId, String)> = holders.iter().map(|(owner, field)| (owner.clone(), field.to_string())).collect();
                    holders.sort();
                    (node.clone(), holders)
                })
                .collect()
        };
        self.doc_id == other.doc_id
            && self.kit == other.kit
            && self.schema_version == other.schema_version
            && self.objects == other.objects
            && sorted(&self.nodes) == sorted(&other.nodes)
    }
}

/// A precondition that does not hold.
fn stale(reason: impl Into<String>) -> KdmError {
    KdmError::Stale(reason.into())
}

/// `name` as held in `names`.
fn intern(names: &mut HashSet<Name>, name: &str) -> Name {
    if let Some(held) = names.get(name) {
        return held.clone();
    }
    let held = Name::from(name);
    names.insert(held.clone());
    held
}

/// The expand of mark `key` on field `field` of type `ty`.
fn expand_of(schema: &Schema, ty: &str, field: &str, key: &str) -> Option<Expand> {
    schema.types.get(ty)?.fields.get(field)?.marks.get(key).map(|mark| mark.expand)
}

impl Store {
    pub(crate) fn new(doc_id: DocId, kit: String, schema_version: u64) -> Self {
        Self { doc_id, kit, schema_version, objects: HashMap::new(), nodes: HashMap::new(), names: HashSet::new() }
    }

    /// The state that content holds (data model 7.4), its fields read as `schema` declares them.
    pub(crate) fn from_content(content: &Content, schema: &Schema) -> Result<Self> {
        let mut store = Self::new(content.doc_id, content.kit.clone(), content.schema_version);
        store.objects.reserve(content.objects.len());
        for (id, fields) in &content.objects {
            let mut object = Object::from_content(fields, schema)?;
            store.intern_object(&mut object);
            let id = ObjectId::from_string(id.clone());
            store.index_trees(&id, &object, true);
            store.objects.insert(id, object);
        }
        Ok(store)
    }

    /// The state as content (with `version`, a snapshot's).
    pub(crate) fn to_content(&self, schema: &Schema, version: Option<ContentVersion>) -> Content {
        Content {
            kit: self.kit.clone(),
            doc_id: self.doc_id,
            schema_version: self.schema_version,
            version,
            objects: self.objects.iter().map(|(id, object)| (id.to_string(), object.to_content(schema))).collect(),
        }
    }

    pub(crate) fn object(&self, id: &ObjectId) -> Option<&Object> {
        self.objects.get(id)
    }

    pub(crate) fn contains(&self, id: &ObjectId) -> bool {
        self.objects.contains_key(id)
    }

    pub(crate) fn objects(&self) -> impl Iterator<Item = (&ObjectId, &Object)> {
        self.objects.iter()
    }

    /// The trees (owner and field) holding `id` as a node.
    pub(crate) fn holders(&self, id: &ObjectId) -> &[(ObjectId, Name)] {
        self.nodes.get(id).map(Vec::as_slice).unwrap_or_default()
    }

    /// A field of an object, or `None` when the object does not exist or holds no such field.
    pub(crate) fn field(&self, id: &ObjectId, name: &str) -> Option<&Field> {
        self.objects.get(id)?.get(name)
    }

    /// Holds the object's type and field names once.
    fn intern_object(&mut self, object: &mut Object) {
        object.ty = intern(&mut self.names, &object.ty);
        for (name, _) in &mut object.fields {
            *name = intern(&mut self.names, name);
        }
    }

    /// Adds (or removes) the nodes of `object`'s own tree fields to the index of tree members.
    fn index_trees(&mut self, owner: &ObjectId, object: &Object, add: bool) {
        for (field, held) in &object.fields {
            let Field::Tree(tree) = held else { continue };
            for (node, _) in tree.nodes() {
                if add {
                    self.nodes.entry(node.clone()).or_default().push((owner.clone(), field.clone()));
                } else {
                    self.unindex(node, owner, field);
                }
            }
        }
    }

    fn unindex(&mut self, node: &ObjectId, owner: &ObjectId, field: &str) {
        if let Some(holders) = self.nodes.get_mut(node) {
            holders.retain(|(held, name)| !(held == owner && &**name == field));
            if holders.is_empty() {
                self.nodes.remove(node);
            }
        }
    }

    /// The tree field `field` of `id`: `Ok(None)` when the object holds none.
    fn tree(&self, id: &ObjectId, field: &str) -> Result<Option<&Tree>> {
        let object = self.objects.get(id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
        match object.get(field) {
            None => Ok(None),
            Some(Field::Tree(tree)) => Ok(Some(tree)),
            Some(_) => Err(stale(format!("{id}.{field} is not a tree"))),
        }
    }

    /// Checks that `node` can go to `place`.
    fn check_place(&self, place: &TreePlace, node: &ObjectId) -> Result<()> {
        let tree = self.tree(&place.owner, &place.field)?;
        let siblings = match (tree, &place.parent) {
            (Some(tree), _) if tree.contains(node) => return Err(stale(format!("`{node}` is in {}.{} already", place.owner, place.field))),
            (Some(tree), Some(parent)) if !tree.contains(parent) => return Err(stale(format!("no node `{parent}` in {}.{}", place.owner, place.field))),
            (Some(tree), parent) => tree.children(parent.as_ref()).len(),
            (None, None) => 0,
            (None, Some(parent)) => return Err(stale(format!("no node `{parent}` in {}.{}", place.owner, place.field))),
        };
        if place.index > siblings {
            return Err(stale(format!("index {} is beyond {siblings} siblings", place.index)));
        }
        Ok(())
    }

    /// Puts `node` at `place` (checked).
    fn attach(&mut self, place: &TreePlace, node: &ObjectId) {
        let field = intern(&mut self.names, &place.field);
        let Some(object) = self.objects.get_mut(&place.owner) else { return };
        // An empty tree is not kept (`put` drops it), so a first node makes its field here.
        if let Err(at) = object.position(&field) {
            object.fields.insert(at, (field.clone(), Field::Tree(Box::default())));
        }
        if let Some(Field::Tree(tree)) = object.get_mut(&field) {
            tree.insert(node.clone(), place.parent.clone(), place.index);
        }
        self.nodes.entry(node.clone()).or_default().push((place.owner.clone(), field));
    }

    /// Applies one operation, or changes nothing and answers [`KdmError::Stale`] when its
    /// preconditions do not hold. Answers the operation as applied.
    pub(crate) fn apply(&mut self, op: Op, schema: &Schema) -> Result<Op> {
        match op {
            Op::Create { id, object, trees } => {
                if self.objects.contains_key(&id) {
                    return Err(stale(format!("object `{id}` exists already")));
                }
                let mut stored = (*object).clone();
                self.intern_object(&mut stored);
                self.index_trees(&id, &stored, true);
                self.objects.insert(id.clone(), stored);
                if let Some(error) = trees.iter().find_map(|place| self.check_place(place, &id).err()) {
                    if let Some(stored) = self.objects.remove(&id) {
                        self.index_trees(&id, &stored, false);
                    }
                    return Err(error);
                }
                for place in &trees {
                    self.attach(place, &id);
                }
                Ok(Op::Create { id, object, trees })
            }
            Op::Delete { id, .. } => {
                if !self.objects.contains_key(&id) {
                    return Err(stale(format!("object `{id}` does not exist")));
                }
                let holders = self.nodes.get(&id).cloned().unwrap_or_default();
                for (owner, field) in &holders {
                    if self.tree(owner, field)?.is_some_and(|tree| !tree.children(Some(&id)).is_empty()) {
                        return Err(stale(format!("`{id}` has children in {owner}.{field}")));
                    }
                }
                let mut trees = Vec::with_capacity(holders.len());
                for (owner, field) in holders {
                    let Some(object) = self.objects.get_mut(&owner) else { continue };
                    let Some(Field::Tree(tree)) = object.get_mut(&field) else { continue };
                    if let Some((parent, index)) = tree.detach(&id) {
                        trees.push(TreePlace { owner: owner.clone(), field: field.clone(), parent, index });
                    }
                    object.settle(&field);
                }
                self.nodes.remove(&id);
                let Some(object) = self.objects.remove(&id) else { return Err(stale(format!("object `{id}` does not exist"))) };
                self.index_trees(&id, &object, false);
                Ok(Op::Delete { id, was: Some(Box::new(object)), trees })
            }
            Op::Set { id, field, value, .. } => {
                let name = intern(&mut self.names, &field);
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let was = match object.get(&field) {
                    None => Value::Null,
                    Some(Field::Value(value)) => value.clone(),
                    Some(_) => return Err(stale(format!("{id}.{field} is a container"))),
                };
                object.put(name, Field::Value(value.clone()));
                Ok(Op::Set { id, field, value, was })
            }
            Op::TextInsert { id, field, index, text, marks } => {
                let name = intern(&mut self.names, &field);
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let ty = object.ty.clone();
                let held = match object.get(&field) {
                    None => None,
                    Some(Field::Text(text)) => Some(text),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                let len = held.map_or(0, |text| text.len());
                if index > len {
                    return Err(stale(format!("index {index} is beyond {id}.{field}'s {len} characters")));
                }
                let marks = match marks {
                    Some(marks) => marks,
                    None => held.map(|text| text.inserted_marks(index, |key| expand_of(schema, &ty, &field, key))).unwrap_or_default(),
                };
                if !text.is_empty() {
                    match object.get_mut(&field) {
                        Some(Field::Text(held)) => held.insert(index, &text, marks.clone()),
                        _ => {
                            let mut made = Text::default();
                            made.insert(0, &text, marks.clone());
                            object.put(name, Field::Text(Box::new(made)));
                        }
                    }
                }
                Ok(Op::TextInsert { id, field, index, text, marks: Some(marks) })
            }
            Op::TextDelete { id, field, index, count, .. } => {
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::Text(text)) => text.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                if index.checked_add(count).is_none_or(|end| end > len) {
                    return Err(stale(format!("{index}+{count} is beyond {id}.{field}'s {len} characters")));
                }
                let was = match object.get_mut(&field) {
                    Some(Field::Text(text)) if count > 0 => text.delete(index, count),
                    _ => Vec::new(),
                };
                object.settle(&field);
                Ok(Op::TextDelete { id, field, index, count, was })
            }
            Op::TextMark { id, field, start, end, key, value, .. } => {
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::Text(text)) => text.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                if start > end || end > len {
                    return Err(stale(format!("{start}..{end} is not within {id}.{field}'s {len} characters")));
                }
                let was = match object.get_mut(&field) {
                    Some(Field::Text(text)) if start < end => text.mark(start, end, &key, &value),
                    _ => Vec::new(),
                };
                Ok(Op::TextMark { id, field, start, end, key, value, was })
            }
            Op::ListInsert { id, field, index, item } => {
                let name = intern(&mut self.names, &field);
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::List(items)) => items.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a list"))),
                };
                if index > len {
                    return Err(stale(format!("index {index} is beyond {id}.{field}'s {len} items")));
                }
                match object.get_mut(&field) {
                    Some(Field::List(items)) => items.insert(index, item.clone()),
                    _ => object.put(name, Field::List(vec![item.clone()])),
                }
                Ok(Op::ListInsert { id, field, index, item })
            }
            Op::ListRemove { id, field, index, item } => {
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let Some(Field::List(items)) = object.get_mut(&field) else { return Err(stale(format!("{id}.{field} holds no item {index}"))) };
                match items.get(index) {
                    None => return Err(stale(format!("{id}.{field} holds no item {index}"))),
                    Some(found) if item.as_ref().is_some_and(|item| item != found) => {
                        return Err(stale(format!("item {index} of {id}.{field} is `{found}`, not the one named")));
                    }
                    Some(_) => {}
                }
                let removed = items.remove(index);
                object.settle(&field);
                Ok(Op::ListRemove { id, field, index, item: Some(removed) })
            }
            Op::ListMove { id, field, from, to, item } => {
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let Some(Field::List(items)) = object.get_mut(&field) else { return Err(stale(format!("{id}.{field} holds no item {from}"))) };
                let len = items.len();
                match items.get(from) {
                    _ if to >= len => return Err(stale(format!("index {to} is beyond {id}.{field}'s {len} items"))),
                    None => return Err(stale(format!("{id}.{field} holds no item {from}"))),
                    Some(found) if item.as_ref().is_some_and(|item| item != found) => {
                        return Err(stale(format!("item {from} of {id}.{field} is `{found}`, not the one named")));
                    }
                    Some(_) => {}
                }
                let moved = items.remove(from);
                items.insert(to, moved.clone());
                Ok(Op::ListMove { id, field, from, to, item: Some(moved) })
            }
            Op::MapSet { id, field, key, value, .. } => {
                let name = intern(&mut self.names, &field);
                let object = self.objects.get_mut(&id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let was = match object.get_mut(&field) {
                    None => None,
                    Some(Field::Map(entries)) => match &value {
                        Some(value) => entries.insert(key.clone(), value.clone()),
                        None => entries.remove(&key),
                    },
                    Some(_) => return Err(stale(format!("{id}.{field} is not a map"))),
                };
                if object.get(&field).is_none()
                    && let Some(value) = &value
                {
                    object.put(name, Field::Map([(key.clone(), value.clone())].into_iter().collect()));
                }
                object.settle(&field);
                Ok(Op::MapSet { id, field, key, value, was })
            }
            Op::TreeCreate { id, field, node, parent, index } => {
                let siblings = match self.tree(&id, &field)? {
                    Some(tree) if tree.contains(&node) => return Err(stale(format!("`{node}` is in {id}.{field} already"))),
                    Some(tree) if parent.as_ref().is_some_and(|parent| !tree.contains(parent)) => return Err(stale(format!("no parent node in {id}.{field}"))),
                    Some(tree) => tree.children(parent.as_ref()).len(),
                    None if parent.is_some() => return Err(stale(format!("no parent node in {id}.{field}"))),
                    None => 0,
                };
                let index = index.unwrap_or(siblings);
                if index > siblings {
                    return Err(stale(format!("index {index} is beyond {siblings} siblings")));
                }
                self.attach(&TreePlace { owner: id.clone(), field: field.clone(), parent: parent.clone(), index }, &node);
                Ok(Op::TreeCreate { id, field, node, parent, index: Some(index) })
            }
            Op::TreeMove { id, field, node, parent, index, .. } => {
                let tree = self.tree(&id, &field)?.ok_or_else(|| stale(format!("no node `{node}` in {id}.{field}")))?;
                let Some((was_parent, was_index)) = tree.place(&node) else { return Err(stale(format!("no node `{node}` in {id}.{field}"))) };
                if let Some(parent) = &parent {
                    if !tree.contains(parent) {
                        return Err(stale(format!("no parent node `{parent}` in {id}.{field}")));
                    }
                    if tree.would_cycle(&node, parent) {
                        return Err(KdmError::Cycle);
                    }
                }
                let siblings = tree.children(parent.as_ref()).len() - usize::from(was_parent == parent);
                let index = index.unwrap_or(siblings);
                if index > siblings {
                    return Err(stale(format!("index {index} is beyond {siblings} siblings")));
                }
                if let Some(Field::Tree(tree)) = self.objects.get_mut(&id).and_then(|object| object.get_mut(&field)) {
                    tree.detach(&node);
                    tree.insert(node.clone(), parent.clone(), index);
                }
                Ok(Op::TreeMove { id, field, node, parent, index: Some(index), was: Some((was_parent, was_index)) })
            }
            Op::TreeDelete { id, field, node, .. } => {
                let tree = self.tree(&id, &field)?.ok_or_else(|| stale(format!("no node `{node}` in {id}.{field}")))?;
                if !tree.contains(&node) {
                    return Err(stale(format!("no node `{node}` in {id}.{field}")));
                }
                if !tree.children(Some(&node)).is_empty() {
                    return Err(stale(format!("`{node}` has children in {id}.{field}")));
                }
                let mut was = None;
                if let Some(object) = self.objects.get_mut(&id) {
                    if let Some(Field::Tree(tree)) = object.get_mut(&field) {
                        was = tree.detach(&node);
                    }
                    object.settle(&field);
                }
                self.unindex(&node, &id, &field);
                Ok(Op::TreeDelete { id, field, node, was })
            }
            Op::SchemaVersion { version, .. } => {
                let was = self.schema_version;
                self.schema_version = version;
                Ok(Op::SchemaVersion { version, was })
            }
        }
    }

    /// Applies `ops` in order as one change: all of them, or (when one fails) none, the error
    /// answered. Answers the operations as applied.
    pub(crate) fn apply_all(&mut self, ops: Vec<Op>, schema: &Schema) -> Result<Vec<Op>> {
        let mut applied = Vec::with_capacity(ops.len());
        for op in ops {
            match self.apply(op, schema) {
                Ok(done) => applied.push(done),
                Err(error) => {
                    self.revert(&applied, schema);
                    return Err(error);
                }
            }
        }
        Ok(applied)
    }

    /// Undoes applied operations, last first.
    pub(crate) fn revert(&mut self, applied: &[Op], schema: &Schema) {
        for op in op::inverse_all(applied.iter()) {
            // The inverse of an operation applied just now always applies.
            let _ = self.apply(op, schema);
        }
    }

    /// `op` fitted to the current state, for an undo that keeps later changes: positions clamped
    /// to the field, a list item found where it is now, and `None` for an operation that has
    /// nothing left to act on (its object, node or item gone).
    pub(crate) fn fit(&self, op: Op) -> Option<Op> {
        match op {
            Op::Create { ref id, .. } => (!self.contains(id)).then_some(op),
            Op::Delete { ref id, .. } => {
                let free = self
                    .holders(id)
                    .iter()
                    .all(|(owner, field)| matches!(self.field(owner, field), Some(Field::Tree(tree)) if tree.children(Some(id)).is_empty()));
                (self.contains(id) && free).then_some(op)
            }
            Op::Set { ref id, .. } | Op::MapSet { ref id, .. } => self.object(id).is_some().then_some(op),
            Op::TextInsert { id, field, index, text, marks } => {
                let len = match self.object(&id)?.get(&field) {
                    None => 0,
                    Some(Field::Text(held)) => held.len(),
                    Some(_) => return None,
                };
                Some(Op::TextInsert { id, field, index: index.min(len), text, marks })
            }
            Op::TextDelete { id, field, index, count, was } => {
                let Some(Field::Text(held)) = self.object(&id)?.get(&field) else { return None };
                let end = index.saturating_add(count).min(held.len());
                (index < end).then(|| Op::TextDelete { id, field, index, count: end - index, was })
            }
            Op::TextMark { id, field, start, end, key, value, was } => {
                let Some(Field::Text(held)) = self.object(&id)?.get(&field) else { return None };
                let end = end.min(held.len());
                (start < end).then_some(Op::TextMark { id, field, start, end, key, value, was })
            }
            Op::ListInsert { id, field, index, item } => {
                let len = match self.object(&id)?.get(&field) {
                    None => 0,
                    Some(Field::List(items)) => items.len(),
                    Some(_) => return None,
                };
                Some(Op::ListInsert { id, field, index: index.min(len), item })
            }
            Op::ListRemove { id, field, index, item } => {
                let Some(Field::List(items)) = self.object(&id)?.get(&field) else { return None };
                let index = match &item {
                    Some(item) if items.get(index) != Some(item) => items.iter().position(|found| found == item)?,
                    _ if index < items.len() => index,
                    _ => return None,
                };
                Some(Op::ListRemove { id, field, index, item })
            }
            Op::ListMove { id, field, from, to, item } => {
                let Some(Field::List(items)) = self.object(&id)?.get(&field) else { return None };
                let from = match &item {
                    Some(item) if items.get(from) != Some(item) => items.iter().position(|found| found == item)?,
                    _ if from < items.len() => from,
                    _ => return None,
                };
                Some(Op::ListMove { id, field, from, to: to.min(items.len().saturating_sub(1)), item })
            }
            Op::TreeCreate { id, field, node, parent, index } => {
                let tree = self.tree(&id, &field).ok()?;
                if tree.is_some_and(|tree| tree.contains(&node)) {
                    return None;
                }
                let parent = parent.filter(|parent| tree.is_some_and(|tree| tree.contains(parent)));
                let siblings = tree.map_or(0, |tree| tree.children(parent.as_ref()).len());
                Some(Op::TreeCreate { id, field, node, parent, index: index.map(|index| index.min(siblings)) })
            }
            Op::TreeMove { id, field, node, parent, index, was } => {
                let tree = self.tree(&id, &field).ok()??;
                let (now, _) = tree.place(&node)?;
                let parent = parent.filter(|parent| tree.contains(parent));
                if parent.as_ref().is_some_and(|parent| tree.would_cycle(&node, parent)) {
                    return None;
                }
                let siblings = tree.children(parent.as_ref()).len() - usize::from(now == parent);
                Some(Op::TreeMove { id, field, node, parent, index: index.map(|index| index.min(siblings)), was })
            }
            Op::TreeDelete { ref id, ref field, ref node, .. } => {
                let tree = self.tree(id, field).ok()??;
                (tree.contains(node) && tree.children(Some(node)).is_empty()).then_some(op)
            }
            Op::SchemaVersion { .. } => Some(op),
        }
    }
}
