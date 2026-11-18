# Undo groups across remote edits

`@kition/kdm` and `kition-kdm` implement undo groups under rule M12b of
`KitModel 1.1`. Editor typing-group integration remains incomplete.

## Problem

A person types a word while a co-editor edits the same paragraph. Their typing
run should undo as one step. Today it undoes as two or more: the co-editor's
change splits it.

## Where it happens

- `@kition/kdm` `Replica.beginUndoGroup` / `endUndoGroup` open a Loro
  `UndoManager` group in each undo scope (person, agent). Both managers run
  with `mergeInterval: 0`, so a typing run is one step only because its
  editor opens a group around it.
- When `importChanges` takes a remote change that touches what the open group
  changed, Loro ends the group. `reopenUndoGroup` starts a new one, so the run
  becomes two steps: before and after the import. That is documented in
  `beginUndoGroup`'s comment and pinned by `packages/kdm/test/replica.test.ts`
  "an import that changes what the group changed splits the group into two
  undo steps".
- The Rust twin `kition-kdm` keeps its undo steps itself (see "The Rust
  replica's steps" below), so an import never splits its groups.
- Kits whose engine keeps its own undo history (Rust engines that call
  `edit.undo` themselves) group typing in their own code; this design covers
  the KDM history only, which `@kition/kit-editor`'s worker and the KDM-based
  kits use.

## Design

For `@kition/kdm`: keep Loro's per-step undo items as they are, and make the
KDM group a chain:

1. `Replica` keeps a run id while a group is open. Each Loro group started for
   the open KDM group (the first, and every one `reopenUndoGroup` starts after
   an import) is recorded on the manager's undo stack with that run id, in the
   item's local meta (Loro `UndoManager` lets the caller attach a value to each
   item: `setOnPush` / `on_push`).
2. `undo()` pops the top item and, while the next item carries the same run id,
   pops it too, in one `history()` call: one person Undo reverts the whole run.
   `redo()` does the same in reverse. The remote change stays applied: each
   item's undo already transforms over later remote changes (M12), so undoing
   two items is the same as undoing a run that never split.
3. `canUndo` and the reported undo depth count runs, not items.
4. A group closed by `endUndoGroup`, by an undo or redo, or by the person's
   next separate gesture ends the run; an agent's steps keep their own scope
   (M12a) and never join a person's run.
5. Typing runs: `@kition/kit-editor`'s text input opens a group on the first
   key of a run and closes it after 1 s idle, a caret move the person made, a
   selection change, or a command; remote edits never close it.

Rule change (`KitModel 1.1` M12b, new): "A person's undo group stays one undo
step when other replicas' changes arrive while it is open, also when they touch
what the group changed."

## The Rust replica's steps

`kition-kdm`'s `Replica` keeps one stack of undo steps and one of redo steps
per scope. A step is one transaction, or the transactions of one undo group
(M12b: an import never splits it, as the replica, not the engine, decides
what a step holds), each kept as one of two kinds of part:

1. **Register writes.** A transaction whose every operation writes a register
   field or a key of a map field of an object that existed before it (a
   table's column cleared, pasted, or filled) notes, when it commits, each
   register it changes and the value it held before. Undo writes those values
   back, every one, in one commit, and notes the values it replaced for redo,
   which does the same the other way. Nothing of the document's history is
   read: Loro's undo looks up each overwritten key's previous value in the
   history (`MapHistoryCache`) and keeps every part of the history it parsed,
   which ran a page out of memory after a 100,000-record column write.
   These transactions commit with an origin the engine's undo managers
   exclude, so for the engine they are changes made since, like another
   replica's.
2. **Engine steps.** Any other transaction is a step of the scope's Loro
   `UndoManager`, which the part names by a serial the replica gives each of
   its items. Undo and redo call the manager once per part, so a group's
   parts replay in reverse order of their transactions and redo in order.

Both kinds follow M12 and M12a the same way: undo writes back every register
of the step, then puts back the value of each register another replica or
another scope wrote later, in a `system` commit (`keep-later-changes`).
`crates/kition-kdm/tests/register_undo.rs` runs the same random scripts on
three replicas with register steps and with engine steps and requires the
same states and undo answers (every step the replica keeps is in the engine's
history too), and that replicas converge with partial delivery. A step with nothing left to replay (another replica deleted
everything it wrote) is dropped, and the same undo or redo replays the step
before it, as Loro does with its own items.

A scope keeps its last 100 steps (Loro's default before). `@kition/kdm` keeps
the chain design above.

## Why it stops here

- It replaces documented and tested behaviour: the "splits the group" cases
  in `packages/kdm/test/replica.test.ts` and in `crates/kition-kdm` become
  "keeps one step". Changing an existing test's expected result needs a
  maintainer's approval (AGENTS.md).
- It needs both KDM implementations changed together (TypeScript and Rust)
  and the convergence suite re-run, since undo is replicated as changes.
- Point 5 touches kit-editor's text input, which other sessions are editing.

## What to approve

1. Rule M12b and the replaced expectation in both KDM suites.
2. Then: TypeScript and Rust KDM chains (points 1 to 4) with new cases
   (typing run with a remote edit inside, on the same and on other objects;
   undo then redo; agent scope apart), then kit-editor's typing groups
   (point 5).
