// Drafts (standard 2.0 A12 to A15): a fork edited apart from the live replica, compared, and
// merged back as one undo step, or discarded. The Rust crate's tests/draft.rs tests the same.
import { describe, expect, it } from 'vitest'
import { agent, diffIsEmpty, diffStates, newDocId, Replica, Version } from '../src/index'
import { me, pageWithShape, reasonOf, testSchema } from './helpers'

const byAgent = agent('user:test')
const merging = agent('user:test', "Merged the agent's draft")
const live = () => Replica.create(testSchema(), newDocId(), 1n)

describe('drafts', () => {
  it('holds the document in a fork and keeps its edits apart', () => {
    const replica = live()
    const { page, shape } = pageWithShape(replica)
    const draft = replica.fork(9n)
    expect(draft.stateText()).toBe(replica.stateText())
    expect(draft.actor).toBe(9n)
    expect(draft.canUndo()).toBe(false)
    draft.transact(byAgent, (tx) => tx.set(shape, 'x', 99))
    draft.transact(byAgent, (tx) => tx.set(page, 'title', 'Draft'))
    expect(replica.get(shape, 'x')).toBe(10)
    expect(draft.get(shape, 'x')).toBe(99)
  })

  it('forks at an earlier version and refuses one it has not reached', () => {
    const replica = live()
    const { page } = pageWithShape(replica)
    const base = replica.version()
    replica.transact(me, (tx) => tx.set(page, 'title', 'Later'))
    expect(replica.forkAt(base, 9n).get(page, 'title')).toBe('One')
    const moved = replica.fork(10n)
    moved.transact(me, (tx) => tx.set(page, 'title', 'Elsewhere'))
    expect(reasonOf(() => replica.forkAt(moved.version(), 11n))).toBe('invalid-value')
  })

  it('merges a draft as one undo step', () => {
    const replica = live()
    const { page, shape } = pageWithShape(replica)
    const base = replica.version()
    const draft = replica.fork(9n)
    const added = draft.transact(byAgent, (tx) => {
      const id = tx.create('Shape', { kind: 'ellipse', x: 1, y: 2 })
      tx.listInsert(page, 'shapes', 1, id)
      tx.textInsert(id, 'label', 0, 'Hello')
      return id
    })
    draft.transact(byAgent, (tx) => tx.set(shape, 'x', 42))
    draft.transact(byAgent, (tx) => tx.set(page, 'title', 'Drafted'))
    const changes = draft.exportChanges(base)

    const follower = replica.fork(4n)
    const before = replica.stateText()
    const preview = JSON.stringify(replica.mergedState(changes))
    expect(replica.stateText()).toBe(before)
    replica.takeChanged()
    const changed = replica.mergeChanges(changes, merging)
    expect([...changed]).toEqual(expect.arrayContaining([added, shape, page]))
    expect(replica.stateText()).toBe(preview)
    expect(replica.stateText()).toBe(draft.stateText())
    expect(replica.text(added, 'label')).toBe('Hello')

    expect(replica.undo()).toBe(true)
    expect(replica.stateText()).toBe(before)
    expect(replica.redo()).toBe(true)
    expect(replica.stateText()).toBe(preview)

    // A replica that syncs with this one gets the merge as ordinary changes. (Never the draft's
    // own changes as well: a replica holding both would show the draft's effects twice.)
    follower.importChanges(replica.exportChanges(follower.version()))
    expect(follower.stateText()).toBe(replica.stateText())
  })

  it('leaves the live document untouched when a draft is discarded', () => {
    const replica = live()
    const { shape } = pageWithShape(replica)
    const before = [replica.version(), replica.stateText(), replica.canUndo()]
    const draft = replica.fork(9n)
    draft.transact(byAgent, (tx) => tx.delete(shape))
    expect([replica.version(), replica.stateText(), replica.canUndo()]).toEqual(before)
    expect(replica.exists(shape)).toBe(true)
  })

  it('keeps live edits made during a draft through its merge and its undo', () => {
    const replica = live()
    const { page, shape } = pageWithShape(replica)
    replica.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'ab'))
    const base = replica.version()
    const draft = replica.fork(9n)
    draft.transact(byAgent, (tx) => tx.textInsert(shape, 'label', 2, 'Z'))
    draft.transact(byAgent, (tx) => tx.set(shape, 'x', 42))

    replica.transact(me, (tx) => tx.textInsert(shape, 'label', 0, '12'))
    replica.transact(me, (tx) => tx.set(shape, 'y', 7))
    const collaborator = Replica.load(testSchema(), replica.snapshot(), 5n)
    collaborator.transact(me, (tx) => tx.set(page, 'title', 'Theirs'))
    replica.importChanges(collaborator.exportChanges(replica.version()))

    replica.mergeChanges(draft.exportChanges(base), merging)
    expect(replica.text(shape, 'label')).toBe('12abZ')
    expect(replica.get(shape, 'x')).toBe(42)
    expect(replica.get(shape, 'y')).toBe(7)
    expect(replica.get(page, 'title')).toBe('Theirs')

    const crdt = Replica.load(testSchema(), collaborator.snapshot(), 7n)
    crdt.importChanges(replica.exportChanges(base))
    expect(crdt.stateText()).toBe(replica.stateText())

    const later = Replica.load(testSchema(), replica.snapshot(), 8n)
    later.transact(me, (tx) => tx.set(shape, 'fill', 'red'))
    replica.importChanges(later.exportChanges(replica.version()))
    expect(replica.undo()).toBe(true)
    expect(replica.text(shape, 'label')).toBe('12ab')
    expect(replica.get(shape, 'x')).toBe(10)
    expect(replica.get(shape, 'y')).toBe(7)
    expect(replica.get(shape, 'fill')).toBe('red')
    expect(replica.get(page, 'title')).toBe('Theirs')
  })

  it('refuses changes it cannot take and changes nothing', () => {
    const replica = live()
    const { page } = pageWithShape(replica)
    const before = [replica.version(), replica.stateText()]
    const other = Replica.create(testSchema(), newDocId(), 2n)
    expect(reasonOf(() => replica.mergeChanges(other.exportChanges(Version.empty()), merging))).toBe('wrong-document')
    const ahead = replica.fork(9n)
    ahead.transact(me, (tx) => tx.set(page, 'title', 'A'))
    const gap = ahead.version()
    ahead.transact(me, (tx) => tx.set(page, 'title', 'B'))
    expect(reasonOf(() => replica.mergeChanges(ahead.exportChanges(gap), merging))).toBe('invalid-value')
    expect(() => replica.mergeChanges(new Uint8Array([1, 2, 3]), merging)).toThrow()
    expect([replica.version(), replica.stateText()]).toEqual(before)
    expect(replica.mergeChanges(replica.fork(10n).exportChanges(replica.version()), merging).size).toBe(0)
    expect(replica.version()).toEqual(before[0])
  })

  it('compares states by created, changed, and deleted objects and texts', () => {
    const replica = live()
    const { page, shape } = pageWithShape(replica)
    const other = replica.transact(me, (tx) => {
      const id = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
      tx.listInsert(page, 'shapes', 1, id)
      tx.textInsert(shape, 'label', 0, 'Old')
      return id
    })
    const base = replica.version()
    const draft = replica.fork(9n)
    const added = draft.transact(byAgent, (tx) => {
      const id = tx.create('Shape', { kind: 'ellipse', x: 5, y: 6 })
      tx.listInsert(page, 'shapes', 0, id)
      tx.textInsert(id, 'label', 0, 'New')
      tx.textDelete(shape, 'label', 0, 3)
      tx.textInsert(shape, 'label', 0, 'Renamed')
      tx.set(shape, 'x', 11)
      tx.listRemove(page, 'shapes', 2)
      tx.delete(other)
      return id
    })
    const summary = diffStates(replica.stateJson(), replica.mergedState(draft.exportChanges(base)))
    expect(summary.created).toEqual([
      { id: added, type: 'Shape', fields: ['kind', 'label', 'x', 'y'], values: { kind: 'ellipse', label: 'New', x: 5, y: 6 }, at: { parent: page, field: 'shapes', index: 0 } },
    ])
    expect(summary.deleted).toEqual([{ id: other, type: 'Shape', fields: [], at: { parent: page, field: 'shapes', index: 1 } }])
    expect(summary.changed).toEqual(
      expect.arrayContaining([
        { id: page, type: 'Page', fields: ['shapes'], edits: [] },
        {
          id: shape,
          type: 'Shape',
          fields: ['label', 'x'],
          edits: [
            { field: 'label', before: 'Old', after: 'Renamed' },
            { field: 'x', before: 10, after: 11 },
          ],
        },
      ]),
    )
    expect(summary.texts).toEqual(
      expect.arrayContaining([
        { id: shape, field: 'label', before: 'Old', after: 'Renamed' },
        { id: added, field: 'label', before: '', after: 'New' },
      ]),
    )
    expect(diffIsEmpty(summary)).toBe(false)
    expect(diffIsEmpty(diffStates(replica.stateJson(), replica.stateJson()))).toBe(true)
  })
})
