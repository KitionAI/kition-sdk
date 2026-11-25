# Undo across later changes

How `kition-kdm`'s `Replica` undoes and redoes (rules M12, M12a and M12b of
[`KitModel 1.1`](sets/model.md)) when other changes were made after the step:
another undo scope's transactions, changes imported from another replica of
the session (a page, a draft's merge, a file taken in as an `import` change),
and `system` changes. `@kition/kdm` only reads a document and keeps no undo history.

## Steps

A replica keeps one stack of undo steps and one of redo steps per undo scope
(`person`, `agent`; M12a). A step is one transaction, or the transactions of
one undo group (`begin_undo_group` to `end_undo_group`), each kept as a part:
its number in the replica's change log and its operations as applied, which
carry what their inverse needs (`was` values, deleted text runs, a deleted
object and its tree places; [data model](data-model.md)). An import, a
`system` change and the other scope's transactions are no part of any step
of the scope, so a group stays one step when they arrive while it is open,
also when they touch what the group changed (M12b). A scope keeps its last
100 steps; a new step clears the scope's redo stack.

## Taking a step back

Undo pops the scope's top step and applies, as one new change of the scope's
origin kind labelled `undo`, the inverses of its parts, last part first:

1. **Carried over later changes.** Each part's inverses were made for the
   state right after the part; the changes logged after it (other than the
   step's own later parts) may have moved the text and the list items they
   address. `store::transform::through` carries the inverses over those
   changes one at a time: text inserted before a position moves it on, text
   deleted around it takes it back, an undo's delete keeps text others
   inserted inside its range, and an undo's mark does not spread over it.
   The log is one line, so this is a transform of one sequence of operations
   against another, not a merge.
2. **Fitted to the state.** `Store::fit` fits each operation to the state
   now: an operation whose object is gone is skipped, and a position past
   the end of its text or list is brought within it.
3. **Later writes kept.** A register or a map key whose value is no longer
   the one the step wrote (another scope or an import wrote it since) keeps
   that value; the undo does not write it back (M12). The object is still
   reported as changed.

Redo does the same with the step the undo made, and pushes it back on the
undo stack.

A step that changes nothing this way (every object it wrote is gone, or its
own changes cancel out: Enter then Backspace in one group, a value written
and written back) is passed over: the same undo or redo takes back the step
below it, and what the passed steps replayed joins that one change.
`can_undo` counts such a step until an undo passes over it; an undo that
finds nothing to take back changes nothing and answers false.

When a step is one change, nothing moved it and nothing was kept, the undo
logs the same operations read backwards instead of copying them, so undoing
and redoing a bulk write holds no second copy of it.

## Limits

- The change log keeps at most 10,000 changes or 64 MB of operations
  ([data model](data-model.md)). Undo carries a step only over changes the
  log holds: when the log drops its oldest changes, the undo and redo steps
  older than them go too.
- Undo and redo answer the objects they change through `take_changed`, like
  any other change, and `undo_touches_in` and `redo_touches_in` answer the
  objects and fields the next step wrote, without changing anything.
- Kits whose engine keeps its own undo history group typing in their own
  code; the KDM history is what `@kition/kit-editor`'s worker and the
  KDM-based kits use.

Tests: `crates/kition-kdm/tests/undo_scopes.rs`, `register_undo.rs`,
`undo_nothing.rs`, and the transform tests in `src/store/tests.rs`.
