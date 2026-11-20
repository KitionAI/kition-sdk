// regressions/issue-kdm-shallow-export: a shallow replica (rule M16a) answers every change it has in
// bytes `Replica.load` opens. Asked for its changes since a version that does not reach its root
// (the empty version above all: "every change"), it answers its shallow snapshot. Before, it
// answered only the changes after its root, which `load` refused ("meta.kit is missing"): a file
// forked as a new document failed the object model over the change exchange and agent drafts. The
// Rust crate's tests/shallow_export.rs tests the same.
import { describe, expect, it } from 'vitest'
import { newDocId, Replica, Version, type ObjectId } from '../src/index'
import { me, pageWithShape, testSchema } from './helpers'

/** A document with history, copied as a new document and edited once: answers the copy and its shape. */
function editedCopy(): { copy: Replica; shape: ObjectId } {
  const source = Replica.create(testSchema(), newDocId(), 1n)
  const { shape } = pageWithShape(source)
  for (let x = 0; x < 5; x++) source.transact(me, (tx) => tx.set(shape, 'x', x))
  const copy = source.copyAsNewDocument(newDocId(), 2n)
  copy.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'forked'))
  return { copy, shape }
}

/** `bytes` load as `replica`'s document: the same id, state, version and root. */
function loadsAs(replica: Replica, bytes: Uint8Array, by: bigint): Replica {
  const loaded = Replica.load(testSchema(), bytes, by)
  expect(loaded.docId).toBe(replica.docId)
  expect(loaded.stateText()).toBe(replica.stateText())
  expect(loaded.version().equals(replica.version())).toBe(true)
  const [root, got] = [replica.shallowRoot(), loaded.shallowRoot()]
  expect(got === null).toBe(root === null)
  if (root !== null && got !== null) expect(got.equals(root)).toBe(true)
  return loaded
}

describe("a shallow replica's export of every change", () => {
  it('loads for a fresh copy as a new document', () => {
    const source = Replica.create(testSchema(), newDocId(), 1n)
    pageWithShape(source)
    const copy = source.copyAsNewDocument(newDocId(), 2n)
    expect(copy.isShallow()).toBe(true)
    expect(loadsAs(copy, copy.exportChanges(Version.empty()), 3n).isShallow()).toBe(true)
    // The default `since` is every change too.
    loadsAs(copy, copy.exportChanges(), 4n)
  })

  it('loads for an edited copy, and the two keep syncing', () => {
    const { copy, shape } = editedCopy()
    const other = loadsAs(copy, copy.exportChanges(), 3n)
    other.transact(me, (tx) => tx.set(shape, 'y', 42))
    copy.transact(me, (tx) => tx.set(shape, 'x', 7))
    copy.importChanges(other.exportChanges(copy.version()))
    other.importChanges(copy.exportChanges(other.version()))
    expect(copy.stateText()).toBe(other.stateText())
    expect(copy.get(shape, 'y')).toBe(42)
    expect(other.get(shape, 'x')).toBe(7)
    loadsAs(other, other.exportChanges(), 4n)
  })

  it('loads for a replica opened from a shallow snapshot, and imports into a full replica', () => {
    const full = Replica.create(testSchema(), newDocId(), 1n)
    const { shape } = pageWithShape(full)
    for (let x = 0; x < 10; x++) full.transact(me, (tx) => tx.set(shape, 'x', x))
    const middle = full.version()
    full.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'after'))
    const shallow = Replica.load(testSchema(), full.shallowSnapshot(middle), 2n)
    shallow.transact(me, (tx) => tx.set(shape, 'y', 5))
    const all = shallow.exportChanges()
    loadsAs(shallow, all, 3n)
    full.importChanges(all)
    expect(full.stateText()).toBe(shallow.stateText())
    expect(full.isShallow()).toBe(false)
    const since = shallow.version()
    shallow.transact(me, (tx) => tx.set(shape, 'y', 6))
    full.importChanges(shallow.exportChanges(since))
    expect(full.get(shape, 'y')).toBe(6)
  })

  it('stays the change export on a full replica', () => {
    const full = Replica.create(testSchema(), newDocId(), 1n)
    pageWithShape(full)
    const all = full.exportChanges()
    expect(loadsAs(full, all, 2n).isShallow()).toBe(false)
    expect(Buffer.from(all).equals(Buffer.from(full.snapshot()))).toBe(false)
  })

  it("opens a draft of a fork that merges back, and the fork's undo takes the merge back", () => {
    const { copy, shape } = editedCopy()
    const draft = loadsAs(copy, copy.exportChanges(), 5n)
    const base = draft.version()
    draft.transact(me, (tx) => tx.set(shape, 'fill', '#123456'))
    loadsAs(draft, draft.exportChanges(), 6n)
    const before = copy.get(shape, 'fill')
    expect(copy.mergeChanges(draft.exportChanges(base), me).has(shape)).toBe(true)
    expect(copy.get(shape, 'fill')).toBe('#123456')
    expect(copy.undo()).toBe(true)
    expect(copy.get(shape, 'fill')).toEqual(before)
  })

  it('lets two replicas of a fork undo, fork, rebase and merge', () => {
    const { copy, shape } = editedCopy()
    const a = loadsAs(copy, copy.snapshot(), 10n)
    const b = loadsAs(copy, copy.exportChanges(), 11n)
    expect(a.canUndo() || b.canUndo()).toBe(false)
    a.transact(me, (tx) => tx.set(shape, 'x', 100))
    expect(a.undo()).toBe(true)
    expect(a.get(shape, 'x')).toBe(copy.get(shape, 'x'))
    expect(a.redo()).toBe(true)
    b.transact(me, (tx) => tx.set(shape, 'y', 200))
    b.rebase(a.snapshot())
    expect(b.get(shape, 'x')).toBe(100)
    expect(b.get(shape, 'y')).toBe(200)
    const draft = b.fork(12n)
    const base = draft.version()
    draft.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'draft '))
    a.importChanges(b.exportChanges(a.version()))
    a.mergeChanges(draft.exportChanges(base), me)
    b.importChanges(a.exportChanges(b.version()))
    expect(a.stateText()).toBe(b.stateText())
    expect(a.text(shape, 'label')).toBe('draft forked')
  })
})
