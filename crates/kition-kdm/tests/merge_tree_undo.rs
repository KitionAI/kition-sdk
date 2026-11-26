//! Undo around a draft's merge in a tree both sides changed (data model 6.6, D7 and D9): the
//! draft moves nodes (to the roots, under another node), makes and deletes its own, while the
//! person makes, moves and deletes other nodes, each deletion taking the object's node out. The
//! merge, with or without a repair that renumbers siblings inside its step, is one undo step of
//! the person when it changes something and none when it changes nothing; either way one Undo
//! gives back the exact state before the merge, one Redo the exact merged state, and each further
//! Undo the exact state before each of the person's own steps (the places their deletions took
//! the nodes from still hold after the merge moved others), Redo all the way back.
//!
//! Kition Photo's case: two layers at the roots, the agent's draft moves the second to the roots
//! (where it is already, last), the person deletes the first. The merged tree is the person's, so
//! the merge records nothing and the person's Undo takes back their delete.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{fields, person, schema};
use kition_kdm::{ActorId, DocId, DraftMerge, NodeRef, ObjectId, Origin, Replica, Tx, UndoScope};
use serde_json::json;

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).expect("actor")
}

fn agent() -> Origin {
    Origin::agent("agent:test")
}

/// A page whose outline holds one shape per entry of `parents`, each under the shape at that
/// index (`None`: a root), made without an undo step. A shape's `x` is its place among its
/// siblings, as the repair numbers it.
fn outline(parents: &[Option<usize>]) -> (Replica, ObjectId, Vec<ObjectId>) {
    let (replica, (page, shapes)) = Replica::create_with(schema(), DocId::new(), actor(1), &Origin::system("import"), |tx| {
        let page = tx.create("Page", fields(json!({ "title": "Outline" })))?;
        let mut shapes = Vec::new();
        let mut nodes: Vec<NodeRef> = Vec::new();
        let mut count: BTreeMap<Option<usize>, i64> = BTreeMap::new();
        for parent in parents {
            let at = count.entry(*parent).or_default();
            let made = tx.create("Shape", fields(json!({ "kind": "rect", "x": *at, "y": 0 })))?;
            *at += 1;
            let node = tx.tree_create(&page, "outline", parent.map(|parent| &nodes[parent]), &made)?;
            nodes.push(node);
            shapes.push(made);
        }
        Ok((page, shapes))
    })
    .expect("outline");
    (replica, page, shapes)
}

/// The kit's repair: each shape's `x` is its place among its siblings.
fn renumber(tx: &mut Tx<'_>, page: &ObjectId) -> kition_kdm::Result<()> {
    let mut next: BTreeMap<Option<ObjectId>, i64> = BTreeMap::new();
    for entry in tx.tree(page, "outline")? {
        let at = next.entry(entry.parent.map(|parent| parent.object().clone())).or_default();
        let place = *at;
        *at += 1;
        if tx.get(&entry.object, "x")?.as_f64() != Some(place as f64) {
            tx.set(&entry.object, "x", json!(place))?;
        }
    }
    Ok(())
}

fn node(replica: &Replica, page: &ObjectId, object: &ObjectId) -> NodeRef {
    replica.tree(page, "outline").expect("tree").into_iter().find(|entry| &entry.object == object).map(|entry| entry.node).expect("a node")
}

fn hash(replica: &Replica) -> String {
    replica.state_hash().expect("state hash")
}

/// Merges `draft`'s changes since `base` into `live` as the agent's, with the renumbering repair
/// when `repaired`.
fn merge(live: &mut Replica, draft: &Replica, base: &kition_kdm::Version, page: &ObjectId, repaired: bool) -> DraftMerge {
    let changes = draft.export_changes(base).expect("export");
    assert_eq!(live.merge_conflicts(&changes).expect("conflicts"), Vec::new(), "no collision");
    if repaired {
        live.merge_changes_repaired(&changes, &agent(), |tx, _| renumber(tx, page)).expect("merge")
    } else {
        live.merge_changes(&changes, &agent()).expect("merge")
    }
}

/// After a merge (`merged`, its answer): the person's history is `states` (the state at the
/// draft's base, then after each of the person's steps since, none a step that changed nothing)
/// and, when the merge changed something, the merge's step on top. Undo walks it down exactly,
/// Redo back up exactly.
fn undo_and_redo_all(live: &mut Replica, states: &[String], merged: &DraftMerge, label: &str) {
    let after = hash(live);
    let before = states.last().expect("a state");
    if merged.scope.is_some() {
        assert_ne!(&after, before, "{label}: a merge recorded as a step changed something");
        assert!(live.undo().expect("undo").is_done(), "{label}: undo the merge");
        assert_eq!(&hash(live), before, "{label}: one undo gives back the exact state before the merge");
        assert!(live.redo().expect("redo").is_done(), "{label}: redo the merge");
        assert_eq!(hash(live), after, "{label}: one redo gives back the exact merged state");
        assert!(live.undo().expect("undo").is_done(), "{label}: undo the merge again");
        assert_eq!(&hash(live), before, "{label}: the second undo of the merge too");
    } else {
        assert!(merged.objects.is_empty(), "{label}: a merge that recorded nothing names no object");
        assert_eq!(&after, before, "{label}: a merge that recorded nothing changed nothing");
    }
    for step in (1..states.len()).rev() {
        assert!(live.undo().expect("undo").is_done(), "{label}: undo the person's step {step}");
        assert_eq!(hash(live), states[step - 1], "{label}: undo gives back the exact state before the person's step {step}");
    }
    assert!(!live.can_undo(), "{label}: nothing more to undo");
    for (step, state) in states.iter().enumerate().skip(1) {
        assert!(live.redo().expect("redo").is_done(), "{label}: redo the person's step {step}");
        assert_eq!(hash(live), *state, "{label}: redo gives back the exact state after the person's step {step}");
    }
    if merged.scope.is_some() {
        assert!(live.redo().expect("redo").is_done(), "{label}: redo the merge last");
        assert_eq!(hash(live), after, "{label}: the merged state again");
    }
    assert!(!live.can_redo(), "{label}: nothing more to redo");
}

/// Kition Photo's shape: two roots; the draft moves the second to the roots, where it already is
/// last; the person deletes the first (and renumbers, as the kit does in the person's step). The
/// merged tree is the person's: the merge records nothing and one Undo takes back the delete.
#[test]
fn a_draft_moving_a_root_to_the_roots_while_the_person_deletes_the_other_records_nothing() {
    for repaired in [false, true] {
        let (mut live, page, shapes) = outline(&[None, None]);
        let (first, second) = (shapes[0].clone(), shapes[1].clone());
        let base = live.version();
        let mut draft = live.fork(actor(2)).expect("fork");
        let moved = node(&draft, &page, &second);
        draft.transact(&agent(), |tx| tx.tree_move(&page, "outline", &moved, None)).expect("draft");
        let at_base = hash(&live);
        live.transact(&person(), |tx| {
            tx.delete(&first)?;
            renumber(tx, &page)
        })
        .expect("delete");
        let (deleted, version, depth) = (hash(&live), live.version(), live.undo_depth(UndoScope::Person));

        let merged = merge(&mut live, &draft, &base, &page, repaired);
        let label = format!("photo's shape, repaired {repaired}");
        assert_eq!(merged.scope, None, "{label}: the merge changes nothing");
        assert_eq!((hash(&live), live.version(), live.undo_depth(UndoScope::Person)), (deleted.clone(), version, depth), "{label}: nothing recorded");
        undo_and_redo_all(&mut live, &[at_base, deleted], &merged, &label);
    }
}

/// The draft moves one child of a root to the roots while the person deletes the other child
/// (either one first, the repair renumbering or not): the merge is one step; one Undo gives
/// back the state after the delete exactly, the next the state before it.
#[test]
fn a_draft_moving_a_child_to_the_roots_while_the_person_deletes_its_sibling_undoes_exactly() {
    for repaired in [false, true] {
        for moved_first in [true, false] {
            // A root, its two children, and a root after it.
            let (mut live, page, shapes) = outline(&[None, Some(0), Some(0), None]);
            let (moved, deleted) = if moved_first { (shapes[1].clone(), shapes[2].clone()) } else { (shapes[2].clone(), shapes[1].clone()) };
            let base = live.version();
            let mut draft = live.fork(actor(2)).expect("fork");
            let moved_node = node(&draft, &page, &moved);
            draft.transact(&agent(), |tx| tx.tree_move(&page, "outline", &moved_node, None)).expect("draft");
            let at_base = hash(&live);
            live.transact(&person(), |tx| tx.delete(&deleted)).expect("delete");
            let after_delete = hash(&live);

            let merged = merge(&mut live, &draft, &base, &page, repaired);
            let label = format!("repaired {repaired}, moved first {moved_first}");
            assert_eq!(merged.scope, Some(UndoScope::Person), "{label}: the merge is the person's step");
            let roots: Vec<ObjectId> =
                live.tree(&page, "outline").expect("tree").into_iter().filter(|entry| entry.parent.is_none()).map(|entry| entry.object).collect();
            assert_eq!(roots, vec![shapes[0].clone(), shapes[3].clone(), moved.clone()], "{label}: moved to the roots, last");
            assert!(!live.exists(&deleted), "{label}: the delete stays");
            undo_and_redo_all(&mut live, &[at_base, after_delete], &merged, &label);
        }
    }
}

// ---- Seeded property tests ----

/// A small seeded generator (xorshift64*), so every run tests the same cases.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let next = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D);
        usize::try_from(next >> 33).unwrap_or_default() % n.max(1)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() { None } else { items.get(self.below(items.len())) }
    }
}

/// Each node's parent.
type Parents = BTreeMap<ObjectId, Option<ObjectId>>;
/// Each parent's children, in order.
type Children = BTreeMap<Option<ObjectId>, Vec<ObjectId>>;

/// Each node's parent and each parent's children in order.
fn shape_of(replica: &Replica, page: &ObjectId) -> (Parents, Children) {
    let (mut parents, mut children) = (Parents::new(), Children::new());
    for entry in replica.tree(page, "outline").expect("tree") {
        let parent = entry.parent.map(|parent| parent.object().clone());
        children.entry(parent.clone()).or_default().push(entry.object.clone());
        parents.insert(entry.object, parent);
    }
    (parents, children)
}

/// One side's random edits of the outline: new nodes under a shared root, one of its own nodes or
/// at the roots; moves of its own nodes there; deletions of its own leaves (the object with its
/// node). Answers the state hash after each step that changed something; a move that would change
/// nothing (to where the node is, last) or make a cycle is not made.
fn tree_edits(replica: &mut Replica, origin: &Origin, page: &ObjectId, shared: &[ObjectId], owned: &[ObjectId], rng: &mut Rng) -> Vec<String> {
    let mut owned: Vec<ObjectId> = owned.to_vec();
    let mut states = Vec::new();
    for _ in 0..1 + rng.below(6) {
        let mut parents: Vec<Option<ObjectId>> = vec![None];
        parents.extend(shared.iter().cloned().map(Some));
        parents.extend(owned.iter().cloned().map(Some));
        let parent = rng.pick(&parents).cloned().flatten();
        let parent_node = parent.as_ref().map(|parent| node(replica, page, parent));
        let (now_parents, children) = shape_of(replica, page);
        match rng.below(3) {
            0 => {
                let new = replica
                    .transact(origin, |tx| {
                        let new = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 1 })))?;
                        tx.tree_create(page, "outline", parent_node.as_ref(), &new)?;
                        Ok(new)
                    })
                    .expect("create");
                owned.push(new);
            }
            1 => {
                let Some(moved) = rng.pick(&owned).cloned() else { continue };
                let in_place = now_parents.get(&moved) == Some(&parent) && children.get(&parent).and_then(|kids| kids.last()) == Some(&moved);
                if in_place {
                    continue;
                }
                let moved_node = node(replica, page, &moved);
                // A move under its own subtree is refused as a cycle and changes nothing.
                if replica.transact(origin, |tx| tx.tree_move(page, "outline", &moved_node, parent_node.as_ref())).is_err() {
                    continue;
                }
            }
            _ => {
                let leaves: Vec<ObjectId> = owned.iter().filter(|held| !children.contains_key(&Some((*held).clone()))).cloned().collect();
                let Some(leaf) = rng.pick(&leaves).cloned() else { continue };
                replica.transact(origin, |tx| tx.delete(&leaf)).expect("delete");
                owned.retain(|held| *held != leaf);
            }
        }
        states.push(hash(replica));
    }
    states
}

/// Random edits of one tree by the person and by a draft (each making, moving to the roots or
/// under a node, and deleting its own nodes), merged with and without the renumbering repair:
/// one Undo gives back the exact state before the merge and one Redo the exact merged state (or
/// the merge records nothing and changed nothing), and each further Undo the exact state before
/// each of the person's steps, back to the draft's base; Redo all the way gives the merged state.
#[test]
fn property_undo_around_a_tree_merge_gives_back_each_state_exactly() {
    for seed in 0..300 {
        for repaired in [false, true] {
            let mut rng = Rng::new(seed);
            // Three shared roots, each with two children: the person's and the draft's.
            let (mut live, page, shapes) = outline(&[None, None, None, Some(0), Some(0), Some(1), Some(1), Some(2), Some(2)]);
            let shared: Vec<ObjectId> = shapes[..3].to_vec();
            let mine: Vec<ObjectId> = shapes[3..].iter().step_by(2).cloned().collect();
            let theirs: Vec<ObjectId> = shapes[4..].iter().step_by(2).cloned().collect();
            let base = live.version();
            let mut draft = live.fork(actor(9)).expect("fork");
            tree_edits(&mut draft, &agent(), &page, &shared, &theirs, &mut rng);
            let mut states = vec![hash(&live)];
            states.extend(tree_edits(&mut live, &person(), &page, &shared, &mine, &mut rng));
            let merged = merge(&mut live, &draft, &base, &page, repaired);
            let ids: BTreeSet<ObjectId> = shape_of(&live, &page).0.into_keys().collect();
            assert!(ids.iter().all(|id| live.exists(id)), "seed {seed}: every node names an object");
            undo_and_redo_all(&mut live, &states, &merged, &format!("seed {seed}, repaired {repaired}"));
        }
    }
}
