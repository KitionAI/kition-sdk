//! A draft's merge (or a restore) that, with the kit's repair, leaves the document as it was
//! records nothing: no change, no undo step, the version stays (data model 6.6, D9). Kition
//! Scene's case reduced: an agent's draft only parents a cube to a light the person deleted
//! meanwhile; the repair clears the dangling parent. Before, the merge was an undo step that
//! changed nothing: `undo_depth` went up, the kits that push a "Merge Draft" label when a step is
//! recorded showed it, and the person's Undo passed over it and took back their earlier step in
//! the same call (case regressions/issue-merge-changing-nothing).
//!
//! And writes a kit computes from its own view after a merge join the merge's undo step
//! (`Replica::transact_in_step`): one Undo gives back the exact state before the merge, one Redo
//! the merge with them (case regressions/issue-merge-follow-up-in-step).

mod common;

use std::collections::BTreeSet;

use common::{fields, person, schema};
use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica, Tx, UndoScope};
use serde_json::json;

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).expect("actor")
}

fn agent() -> Origin {
    Origin::agent("agent:test").with_label("Merged the agent's draft")
}

/// A page with a cube and a light. A shape's `fill` names its parent here (`""`: none), as a
/// Kition Scene node's parent does.
fn scene() -> (Replica, ObjectId, ObjectId, ObjectId) {
    let (replica, (page, cube, light)) = Replica::create_with(schema(), DocId::new(), actor(1), &Origin::system("import"), |tx| {
        let page = tx.create("Page", fields(json!({ "title": "Scene" })))?;
        let cube = tx.create("Shape", fields(json!({ "kind": "rect", "x": 10, "y": 20, "fill": "" })))?;
        let light = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 0, "y": 0, "fill": "" })))?;
        tx.list_insert(&page, "shapes", 0, &cube)?;
        tx.list_insert(&page, "shapes", 1, &light)?;
        Ok((page, cube, light))
    })
    .expect("scene");
    (replica, page, cube, light)
}

/// The kit's repair: a changed shape whose parent is gone has none.
fn clear_dangling_parents(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> kition_kdm::Result<()> {
    for id in changed {
        if tx.exists(id) && tx.object_type(id)? == "Shape" {
            let parent = tx.get(id, "fill")?;
            if let Some(parent) = parent.as_str().filter(|parent| !parent.is_empty())
                && !tx.exists(&ObjectId::from_string(parent.to_owned()))
            {
                tx.set(id, "fill", json!(""))?;
            }
        }
    }
    Ok(())
}

/// The person moves the cube (their earlier step) and deletes the light (their last step) while
/// the agent's draft parents the cube to the light. Answers the replica and the draft's changes.
fn deleted_meanwhile() -> (Replica, ObjectId, ObjectId, Vec<u8>) {
    let (mut live, page, cube, light) = scene();
    let mut draft = live.fork(actor(2)).expect("fork");
    let base = draft.version();
    draft.transact(&agent(), |tx| tx.set(&cube, "fill", json!(light.to_string()))).expect("parent");
    live.transact(&person(), |tx| tx.set(&cube, "x", json!(50))).expect("move");
    live.transact(&person(), |tx| {
        tx.list_remove(&page, "shapes", 1)?;
        tx.delete(&light)
    })
    .expect("delete the light");
    let changes = draft.export_changes(&base).expect("export");
    (live, cube, light, changes)
}

#[test]
fn a_merge_its_repair_takes_back_entirely_records_no_change_and_no_step() {
    for origin in [agent(), person()] {
        let (mut live, cube, light, changes) = deleted_meanwhile();
        live.take_changed();
        let (hash, version, depth) = (live.state_hash().unwrap(), live.version(), live.undo_depth(UndoScope::Person));
        let deleting = live.undo_touches_in(UndoScope::Person);
        assert_eq!(depth, 2);

        let merged = live.merge_changes_repaired(&changes, &origin, clear_dangling_parents).expect("merge");
        assert_eq!(merged.scope, None, "{origin:?}: no step was recorded");
        assert!(merged.objects.is_empty(), "{origin:?}: nothing changed");
        assert_eq!(live.state_hash().unwrap(), hash, "{origin:?}");
        assert_eq!(live.version(), version, "{origin:?}: no change is logged, the version stays");
        assert_eq!(live.undo_depth(UndoScope::Person), depth, "{origin:?}");
        assert_eq!(live.undo_depth(UndoScope::Agent), 0, "{origin:?}");
        assert_eq!(live.undo_touches_in(UndoScope::Person), deleting, "{origin:?}: the person's last step is still on top");
        assert!(live.take_changed().is_empty(), "{origin:?}");
        assert!(live.changes_since(&version).unwrap().is_empty(), "{origin:?}");

        // The person's Undo takes back their own last step, exactly, and nothing more.
        let undone = live.undo().unwrap();
        assert!(undone.passed.is_empty(), "{origin:?}: no step passed over");
        assert_eq!(undone.taken, Some(deleting.clone()), "{origin:?}");
        assert!(live.exists(&light), "{origin:?}: the light is back");
        assert_eq!(live.get(&cube, "x").unwrap(), json!(50), "{origin:?}: the move before it stays");
        assert_eq!(live.get(&cube, "fill").unwrap(), json!(""), "{origin:?}");
        assert_eq!(live.undo_depth(UndoScope::Person), 1, "{origin:?}");
        assert!(live.undo().unwrap().is_done());
        assert_eq!(live.get(&cube, "x").unwrap(), json!(10), "{origin:?}");
        assert!(!live.can_undo(), "{origin:?}");
    }
}

/// The preview of such a draft is what accepting it gives: nothing.
#[test]
fn the_preview_of_a_merge_its_repair_takes_back_is_empty() {
    let (live, _, _, changes) = deleted_meanwhile();
    assert!(live.compare_changes_repaired(&changes, clear_dangling_parents).unwrap().is_empty());
    assert_eq!(live.merged_state_repaired(&changes, clear_dangling_parents).unwrap(), live.state_json().unwrap());
    // Without the repair the draft changes the cube.
    assert!(!live.compare_changes(&changes).unwrap().is_empty());
}

/// A merge the repair changes only in part is still one change and one step, as before.
#[test]
fn a_merge_its_repair_keeps_something_of_is_one_step() {
    let (mut live, cube, light, _) = deleted_meanwhile();
    let mut draft = live.fork(actor(3)).unwrap();
    let base = draft.version();
    draft
        .transact(&agent(), |tx| {
            tx.set(&cube, "fill", json!(light.to_string()))?;
            tx.set(&cube, "y", json!(99))
        })
        .unwrap();
    let before = live.state_hash().unwrap();
    let merged = live.merge_changes_repaired(&draft.export_changes(&base).unwrap(), &agent(), clear_dangling_parents).unwrap();
    assert_eq!(merged.scope, Some(UndoScope::Person));
    assert_eq!((live.get(&cube, "y").unwrap(), live.get(&cube, "fill").unwrap()), (json!(99), json!("")));
    assert_eq!(live.undo_depth(UndoScope::Person), 3);
    assert!(live.undo().unwrap().is_done());
    assert_eq!(live.state_hash().unwrap(), before);
}

/// `transact_unless_unchanged` (a restore and its repair): writes that cancel out apply nothing,
/// the version stays and no step is recorded; writes that change something are one step.
#[test]
fn a_transaction_unless_unchanged_records_nothing_when_its_writes_cancel_out() {
    let (mut live, _, cube, _) = scene();
    live.transact(&person(), |tx| tx.set(&cube, "x", json!(50))).unwrap();
    let (hash, version) = (live.state_hash().unwrap(), live.version());
    let ((), changed) = live
        .transact_unless_unchanged(&person(), |tx| {
            tx.set(&cube, "fill", json!("gone"))?;
            tx.set(&cube, "x", json!(99))?;
            tx.set(&cube, "fill", json!(""))?;
            tx.set(&cube, "x", json!(50))
        })
        .unwrap();
    assert!(!changed);
    assert_eq!((live.state_hash().unwrap(), live.version(), live.undo_depth(UndoScope::Person)), (hash.clone(), version, 1));
    let ((), changed) = live.transact_unless_unchanged(&person(), |tx| tx.set(&cube, "y", json!(1))).unwrap();
    assert!(changed);
    assert_eq!(live.undo_depth(UndoScope::Person), 2);
    assert!(live.undo().unwrap().is_done());
    assert_eq!(live.state_hash().unwrap(), hash);
}

/// Writes computed after the merge (a kit's view repair, here a system one) join the merge's step:
/// one Undo gives back the exact state before the merge, one Redo the merge with them.
#[test]
fn writes_after_a_merge_join_its_undo_step() {
    let (mut live, page, cube, _) = scene();
    live.transact(&person(), |tx| tx.set(&page, "title", json!("Mine"))).unwrap();
    let mut draft = live.fork(actor(2)).unwrap();
    let base = draft.version();
    draft.transact(&agent(), |tx| tx.set(&cube, "x", json!(500))).unwrap();
    let (before, depth) = (live.state_hash().unwrap(), live.undo_depth(UndoScope::Person));

    let merged = live.merge_changes(&draft.export_changes(&base).unwrap(), &agent()).unwrap();
    let scope = merged.scope.expect("a step");
    let ((), kept) = live.transact_in_step(scope, &Origin::system("view repair"), |tx| tx.set(&cube, "y", json!(7))).unwrap();
    assert_eq!(kept, Some(UndoScope::Person));
    let ((), kept) = live.transact_in_step(scope, &Origin::system("view repair"), |tx| tx.set(&page, "title", json!("Mine, merged"))).unwrap();
    assert_eq!(kept, Some(UndoScope::Person), "several writes may join, one after another");
    assert_eq!(live.undo_depth(UndoScope::Person), depth + 1, "one step for the merge and its follow-ups");
    let after = live.state_hash().unwrap();

    assert!(live.undo().unwrap().is_done());
    assert_eq!(live.state_hash().unwrap(), before, "one undo: the exact state before the merge");
    assert!(live.redo().unwrap().is_done());
    assert_eq!(live.state_hash().unwrap(), after, "one redo: the merge with its follow-ups");
    assert!(live.undo().unwrap().is_done());
    assert!(live.undo().unwrap().is_done());
    assert_eq!(live.get(&page, "title").unwrap(), json!("Scene"));
}

/// Only the step holding the replica's newest change can be joined: after another write, an
/// import or a system change, and in a scope with no such step, the join is refused and changes
/// nothing.
#[test]
fn a_write_joins_only_the_step_of_the_newest_change() {
    let (mut live, page, cube, _) = scene();
    let refused = live.transact_in_step(UndoScope::Person, &Origin::system("view repair"), |tx| tx.set(&cube, "y", json!(7)));
    assert!(matches!(refused, Err(KdmError::InvalidValue { .. })), "no step at all");
    live.transact(&person(), |tx| tx.set(&cube, "x", json!(1))).unwrap();
    assert!(live.transact_in_step(UndoScope::Agent, &Origin::system("view repair"), |tx| tx.set(&cube, "y", json!(7))).is_err(), "no step of that scope");
    live.transact(&Origin::system("other"), |tx| tx.set(&page, "title", json!("System"))).unwrap();
    let version = live.version();
    let refused = live.transact_in_step(UndoScope::Person, &Origin::system("view repair"), |tx| tx.set(&cube, "y", json!(7)));
    assert!(matches!(refused, Err(KdmError::InvalidValue { .. })), "a newer change is no step's");
    assert_eq!((live.version(), live.get(&cube, "y").unwrap()), (version, json!(20)));
}

/// Writes after a merge that take back all it did leave a step that changes nothing: it is dropped,
/// `undo_depth` is what it was before the merge, and the person's Undo takes back their own step.
#[test]
fn writes_that_take_back_the_whole_merge_drop_its_step() {
    let (mut live, page, cube, _) = scene();
    live.transact(&person(), |tx| tx.set(&page, "title", json!("Mine"))).unwrap();
    let mut draft = live.fork(actor(2)).unwrap();
    let base = draft.version();
    draft.transact(&agent(), |tx| tx.set(&cube, "x", json!(500))).unwrap();
    let (before, depth) = (live.state_hash().unwrap(), live.undo_depth(UndoScope::Person));
    let touches = live.undo_touches_in(UndoScope::Person);
    let merged = live.merge_changes(&draft.export_changes(&base).unwrap(), &agent()).unwrap();
    let ((), kept) = live.transact_in_step(merged.scope.unwrap(), &Origin::system("view repair"), |tx| tx.set(&cube, "x", json!(10))).unwrap();
    assert_eq!(kept, None);
    assert_eq!((live.state_hash().unwrap(), live.undo_depth(UndoScope::Person)), (before, depth));
    assert_eq!(live.undo_touches_in(UndoScope::Person), touches);
    let undone = live.undo().unwrap();
    assert!(undone.passed.is_empty());
    assert_eq!(live.get(&page, "title").unwrap(), json!("Scene"));
}
