//! A tree field: its nodes are object ids, one node per object, each under a parent (`None`: a
//! root) at a place among its siblings.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::{KdmError, ObjectId, Result};

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Tree {
    parent: HashMap<ObjectId, Option<ObjectId>>,
    /// Each parent's children in order; a parent without children has no entry.
    children: HashMap<Option<ObjectId>, Vec<ObjectId>>,
}

impl Tree {
    pub(crate) fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.parent.len()
    }

    pub(crate) fn contains(&self, node: &ObjectId) -> bool {
        self.parent.contains_key(node)
    }

    /// The node's parent (`Some(None)`: a root), or `None` when the tree has no such node.
    pub(crate) fn parent(&self, node: &ObjectId) -> Option<Option<&ObjectId>> {
        self.parent.get(node).map(Option::as_ref)
    }

    /// The children of `parent` (`None`: the roots), in order.
    pub(crate) fn children(&self, parent: Option<&ObjectId>) -> &[ObjectId] {
        self.children.get(&parent.cloned()).map(Vec::as_slice).unwrap_or_default()
    }

    /// Every node, each with its parent.
    pub(crate) fn nodes(&self) -> impl Iterator<Item = (&ObjectId, Option<&ObjectId>)> {
        self.parent.iter().map(|(node, parent)| (node, parent.as_ref()))
    }

    /// The node's parent and its place among its siblings.
    pub(crate) fn place(&self, node: &ObjectId) -> Option<(Option<ObjectId>, usize)> {
        let parent = self.parent.get(node)?.clone();
        let index = self.children(parent.as_ref()).iter().position(|child| child == node)?;
        Some((parent, index))
    }

    /// Whether putting `node` under `parent` would make it its own ancestor.
    pub(crate) fn would_cycle(&self, node: &ObjectId, parent: &ObjectId) -> bool {
        let mut at = Some(parent);
        let mut steps = 0;
        while let Some(current) = at {
            if current == node || steps > self.parent.len() {
                return true;
            }
            steps += 1;
            at = self.parent.get(current).and_then(Option::as_ref);
        }
        false
    }

    /// Adds `node` under `parent` at `index` (at most the number of its children). The caller
    /// checked that the node is not in the tree and the parent is.
    pub(crate) fn insert(&mut self, node: ObjectId, parent: Option<ObjectId>, index: usize) {
        let siblings = self.children.entry(parent.clone()).or_default();
        siblings.insert(index.min(siblings.len()), node.clone());
        self.parent.insert(node, parent);
    }

    /// Takes `node` out of its parent's children (its own children stay under it); answers its
    /// parent and place.
    pub(crate) fn detach(&mut self, node: &ObjectId) -> Option<(Option<ObjectId>, usize)> {
        let (parent, index) = self.place(node)?;
        if let Some(siblings) = self.children.get_mut(&parent) {
            siblings.remove(index);
            if siblings.is_empty() {
                self.children.remove(&parent);
            }
        }
        self.parent.remove(node);
        Some((parent, index))
    }

    /// The nodes in pre-order (each parent before its children, siblings in order), each with its
    /// parent.
    pub(crate) fn preorder(&self) -> Vec<(ObjectId, Option<ObjectId>)> {
        let mut out = Vec::with_capacity(self.parent.len());
        let mut stack: Vec<(&ObjectId, Option<&ObjectId>)> = self.children(None).iter().rev().map(|node| (node, None)).collect();
        while let Some((node, parent)) = stack.pop() {
            out.push((node.clone(), parent.cloned()));
            stack.extend(self.children(Some(node)).iter().rev().map(|child| (child, Some(node))));
        }
        out
    }

    /// The tree's JSON: `[{"children":[...],"object":"<id>"}]`, siblings in order. `keep` decides
    /// which nodes are written; a node left out is left out with its subtree.
    pub(crate) fn to_json(&self, keep: &dyn Fn(&ObjectId) -> bool) -> Value {
        self.json_under(None, keep, 0)
    }

    fn json_under(&self, parent: Option<&ObjectId>, keep: &dyn Fn(&ObjectId) -> bool, depth: usize) -> Value {
        if depth > self.parent.len() {
            return Value::Array(Vec::new());
        }
        Value::Array(
            self.children(parent)
                .iter()
                .filter(|node| keep(node))
                .map(|node| {
                    let mut entry = Map::new();
                    entry.insert("children".into(), self.json_under(Some(node), keep, depth + 1));
                    entry.insert("object".into(), Value::String(node.to_string()));
                    Value::Object(entry)
                })
                .collect(),
        )
    }

    /// A tree from its JSON ([`Tree::to_json`]). Refuses ([`KdmError::Encoding`]) a node that is
    /// not `{children, object}` and an object named twice.
    pub(crate) fn from_json(value: &Value) -> Result<Self> {
        let mut tree = Self::default();
        let mut stack: Vec<(Option<ObjectId>, &Value)> = vec![(None, value)];
        while let Some((parent, nodes)) = stack.pop() {
            let nodes = nodes.as_array().ok_or_else(|| KdmError::Encoding("a tree is an array of nodes".into()))?;
            for node in nodes {
                let object = node.get("object").and_then(Value::as_str).ok_or_else(|| KdmError::Encoding("a tree node names no object".into()))?;
                let object = ObjectId::from_string(object);
                if tree.contains(&object) {
                    return Err(KdmError::Encoding(format!("the tree names `{object}` twice")));
                }
                let index = tree.children(parent.as_ref()).len();
                tree.insert(object.clone(), parent.clone(), index);
                if let Some(children) = node.get("children") {
                    stack.push((Some(object), children));
                }
            }
        }
        Ok(tree)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(name: &str) -> ObjectId {
        ObjectId::from_string(name)
    }

    #[test]
    fn nodes_keep_their_places_and_read_in_pre_order() {
        let mut tree = Tree::default();
        tree.insert(id("a"), None, 0);
        tree.insert(id("b"), None, 1);
        tree.insert(id("c"), Some(id("a")), 0);
        tree.insert(id("d"), Some(id("a")), 0);
        assert_eq!(tree.preorder(), vec![(id("a"), None), (id("d"), Some(id("a"))), (id("c"), Some(id("a"))), (id("b"), None)]);
        assert!(tree.would_cycle(&id("a"), &id("c")));
        assert!(!tree.would_cycle(&id("b"), &id("c")));
        let json = tree.to_json(&|_| true);
        assert_eq!(
            json,
            json!([{ "children": [{ "children": [], "object": "d" }, { "children": [], "object": "c" }], "object": "a" }, { "children": [], "object": "b" }])
        );
        assert_eq!(Tree::from_json(&json).unwrap(), tree);
        assert_eq!(tree.detach(&id("d")), Some((Some(id("a")), 0)));
        assert_eq!(tree.place(&id("c")), Some((Some(id("a")), 0)));
        assert!(Tree::from_json(&json!([{ "children": [], "object": "a" }, { "children": [], "object": "a" }])).is_err());
    }
}
