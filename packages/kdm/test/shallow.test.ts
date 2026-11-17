// Shallow replicas (standard 2.0 rule M16a): a device holds a large document's current state with
// only recent history, and merges with full replicas like a full replica does. The Rust crate's
// tests/shallow.rs tests the same.
import { describe, expect, it } from 'vitest'
import { newDocId, Replica, Rng, system, Version, type ObjectId } from '../src/index'
import { me, pageWithShape, reasonOf, schemaV2, testSchema } from './helpers'

/** A full replica with some history: a page, a shape, and a few edits to both. */
function fullWithHistory(): { full: Replica; page: ObjectId; shape: ObjectId } {
  const full = Replica.create(testSchema(), newDocId(), 1n)
  const { page, shape } = pageWithShape(full)
  for (let x = 0; x < 20; x++) full.transact(me, (tx) => tx.set(shape, 'x', x))
  full.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'history'))
  return { full, page, shape }
}

const shallowOf = (replica: Replica, actor: bigint, at: Version = replica.version()) => Replica.load(testSchema(), replica.shallowSnapshot(at), actor)

/** Exchanges changes both ways until both replicas have the same version. */
function sync(a: Replica, b: Replica): void {
  b.importChanges(a.exportChanges(b.version()))
  a.importChanges(b.exportChanges(a.version()))
  expect(a.version().equals(b.version())).toBe(true)
}

describe('shallow replicas', () => {
  it('load a shallow snapshot to the same state without the history', () => {
    const { full } = fullWithHistory()
    const bytes = full.shallowSnapshot(full.version())
    const shallow = Replica.load(testSchema(), bytes, 2n)
    expect(shallow.isShallow()).toBe(true)
    expect(full.isShallow()).toBe(false)
    expect(full.shallowRoot()).toBeNull()
    expect(shallow.stateText()).toBe(full.stateText())
    expect(shallow.version().equals(full.version())).toBe(true)
    expect(shallow.version().includes(shallow.shallowRoot()!)).toBe(true)
    expect(bytes.length).toBeLessThan(full.snapshot().length)
  })

  it('converge with full replicas both ways', () => {
    const { full, page, shape } = fullWithHistory()
    const shallow = shallowOf(full, 2n)
    shallow.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'S:'))
    shallow.transact(me, (tx) => {
      const made = tx.create('Shape', { kind: 'ellipse', x: 1, y: 2 })
      tx.listInsert(page, 'shapes', 1, made)
    })
    full.transact(me, (tx) => tx.set(shape, 'fill', '#5645d4'))
    full.transact(me, (tx) => tx.textInsert(shape, 'label', 7, ':F'))
    sync(full, shallow)
    expect(shallow.stateText()).toBe(full.stateText())
    expect(full.text(shape, 'label')).toBe('S:history:F')
    expect(full.list(page, 'shapes')).toHaveLength(2)
    const other = Replica.load(testSchema(), full.snapshot(), 3n)
    shallow.transact(me, (tx) => tx.set(shape, 'y', 99))
    sync(shallow, other)
    sync(other, full)
    expect(other.stateText()).toBe(shallow.stateText())
    expect(full.stateText()).toBe(shallow.stateText())
  })

  it('keep the history after their root, and fork only at their current version', () => {
    const { full, shape } = fullWithHistory()
    const middle = full.version()
    full.transact(me, (tx) => tx.set(shape, 'x', 500))
    full.transact(me, (tx) => tx.set(shape, 'x', 600))
    const shallow = shallowOf(full, 2n, middle)
    expect(shallow.isShallow()).toBe(true)
    expect(shallow.version().includes(middle)).toBe(true)
    const draft = shallow.forkAt(shallow.version(), 4n)
    expect(draft.isShallow()).toBe(true)
    expect(draft.get(shape, 'x')).toBe(600)
    for (const version of [middle, Version.empty()]) expect(reasonOf(() => shallow.forkAt(version, 5n))).toBe('history-missing')
    const again = Replica.load(testSchema(), shallow.snapshot(), 6n)
    expect(again.shallowRoot()!.equals(shallow.shallowRoot()!)).toBe(true)
    const clamped = Replica.load(testSchema(), shallow.shallowSnapshot(Version.empty()), 7n)
    expect(clamped.shallowRoot()!.equals(shallow.shallowRoot()!)).toBe(true)
    expect(clamped.stateText()).toBe(full.stateText())
  })

  it('keep the whole history for an empty root, and refuse a root they lack', () => {
    const { full, shape } = fullWithHistory()
    const whole = shallowOf(full, 2n, Version.empty())
    expect(whole.isShallow()).toBe(false)
    expect(whole.stateText()).toBe(full.stateText())
    const ahead = full.fork(9n)
    ahead.transact(me, (tx) => tx.set(shape, 'x', 1))
    expect(reasonOf(() => full.shallowSnapshot(ahead.version()))).toBe('invalid-value')
  })

  it('undo their own changes after the root', () => {
    const { full, shape } = fullWithHistory()
    const shallow = shallowOf(full, 2n)
    expect(shallow.canUndo()).toBe(false)
    shallow.transact(me, (tx) => tx.set(shape, 'x', 77))
    shallow.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'new '))
    expect(shallow.undo()).toBe(true)
    expect(shallow.undo()).toBe(true)
    expect(shallow.canUndo()).toBe(false)
    expect(shallow.get(shape, 'x')).toBe(19)
    expect(shallow.text(shape, 'label')).toBe('history')
    expect(shallow.redo()).toBe(true)
    expect(shallow.get(shape, 'x')).toBe(77)
  })

  it('merge a draft back', () => {
    const { full, shape } = fullWithHistory()
    const shallow = shallowOf(full, 2n)
    const draft = shallow.fork(8n)
    draft.transact(me, (tx) => tx.set(shape, 'x', 5))
    expect(shallow.mergeChanges(draft.exportChanges(shallow.version()), me).has(shape)).toBe(true)
    expect(shallow.get(shape, 'x')).toBe(5)
  })

  it('refuse changes from before their root, and a rebase takes them', () => {
    const { full: server, shape } = fullWithHistory()
    const offline = Replica.load(testSchema(), server.snapshot(), 3n)
    offline.transact(me, (tx) => tx.set(shape, 'fill', '#000000'))
    server.transact(me, (tx) => tx.set(shape, 'y', 3))
    const shallow = shallowOf(server, 2n)
    shallow.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'mine '))
    shallow.takeChanged()
    const before = { version: shallow.version(), state: shallow.stateText() }
    const late = offline.exportChanges()
    expect(reasonOf(() => shallow.importChanges(late))).toBe('history-missing')
    expect(shallow.version().equals(before.version)).toBe(true)
    expect(shallow.stateText()).toBe(before.state)
    expect(shallow.takeChanged().size).toBe(0)

    server.importChanges(late)
    server.importChanges(shallow.exportChanges(server.version()))
    shallow.transact(me, (tx) => tx.set(shape, 'x', 42))
    const changed = shallow.rebase(server.shallowSnapshot(server.version()))
    expect(changed.has(shape)).toBe(true)
    expect(shallow.isShallow()).toBe(true)
    expect(shallow.canUndo()).toBe(false)
    expect(shallow.get(shape, 'fill')).toBe('#000000')
    expect(shallow.get(shape, 'x')).toBe(42)
    expect(shallow.text(shape, 'label')).toBe('mine history')
    sync(shallow, server)
    expect(shallow.stateText()).toBe(server.stateText())
    shallow.importChanges(offline.exportChanges())
  })

  it('refuse to rebase on another document or a snapshot older than the root', () => {
    const { full: server, shape } = fullWithHistory()
    const old = server.snapshot()
    server.transact(me, (tx) => tx.set(shape, 'x', 1))
    server.transact(me, (tx) => tx.set(shape, 'x', 2))
    const shallow = shallowOf(server, 2n)
    const state = shallow.stateText()
    expect(reasonOf(() => shallow.rebase(old))).toBe('history-missing')
    const other = Replica.create(testSchema(), newDocId(), 4n)
    expect(reasonOf(() => shallow.rebase(other.snapshot()))).toBe('wrong-document')
    expect(shallow.stateText()).toBe(state)
    shallow.transact(me, (tx) => tx.set(shape, 'y', 8))
    shallow.rebase(server.snapshot())
    expect(shallow.isShallow()).toBe(false)
    expect(shallow.get(shape, 'y')).toBe(8)
  })

  it('converge with full replicas in any delivery order', () => {
    const { full, page } = fullWithHistory()
    const snapshot = full.snapshot()
    const shallow = full.shallowSnapshot(full.version())
    for (let seed = 0; seed < 6; seed++) {
      const replicas = [0, 1, 2, 3].map((index) => Replica.load(testSchema(), index % 2 === 0 ? shallow : snapshot, BigInt(10 + index)))
      const log: Uint8Array[] = []
      replicas.forEach((replica, index) => {
        const before = replica.version()
        replica.transact(me, (tx) => {
          const made = tx.create('Shape', { kind: 'rect', x: index, y: seed })
          tx.listInsert(page, 'shapes', 0, made)
          tx.set(page, 'title', `by ${index}`)
        })
        log.push(replica.exportChanges(before))
      })
      const rng = new Rng(BigInt(seed))
      for (const replica of replicas) {
        const order = [...log.keys(), ...log.keys()]
        rng.shuffle(order)
        for (const index of order) replica.importChanges(log[index])
      }
      for (const replica of replicas) expect(replica.stateText()).toBe(replicas[0].stateText())
      expect(replicas[0].list(page, 'shapes')).toHaveLength(5)
    }
  })

  it('close on an import that raises the schema past theirs, which the engine cannot take back', () => {
    const { full, page, shape } = fullWithHistory()
    const newer = Replica.load(schemaV2(), full.snapshot(), 3n)
    const base = newer.version()
    const shallow = shallowOf(full, 2n)
    shallow.transact(me, (tx) => tx.set(shape, 'x', 5))
    newer.transact(system('migrate'), (tx) => {
      tx.set(page, 'title', 'Migrated')
      tx.raiseSchemaVersion(2)
    })
    const changes = newer.exportChanges(base)
    expect(reasonOf(() => shallow.importChanges(changes))).toBe('newer-schema')
    for (const call of [
      () => shallow.transact(me, (tx) => tx.set(shape, 'x', 6)),
      () => shallow.importChanges(changes),
      () => shallow.exportChanges(),
      () => shallow.snapshot(),
      () => shallow.shallowSnapshot(Version.empty()),
      () => shallow.fork(9n),
      () => shallow.undo(),
    ]) {
      expect(reasonOf(call)).toBe('newer-schema')
    }
    // A full replica takes the import back and goes on (rule M20).
    expect(reasonOf(() => full.importChanges(changes))).toBe('newer-schema')
    expect(full.minSchemaVersion()).toBe(1)
  })
})
