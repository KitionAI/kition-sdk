/** Incomplete imports and the partial order of versions; the twin of the crate's `tests/versions.rs`. */
import { describe, expect, it } from 'vitest'
import { newDocId, Replica, Version } from '../src/index'
import { me, pageWithShape, reasonOf, testSchema } from './helpers'

function pair(): { a: Replica; b: Replica } {
  const a = Replica.create(testSchema(), newDocId(), 1n)
  pageWithShape(a)
  return { a, b: Replica.load(testSchema(), a.snapshot(), 2n) }
}

/** Makes one change on `replica`; answers its export. */
function change(replica: Replica, title: string): Uint8Array {
  const since = replica.version()
  replica.transact(me, (tx) => tx.create('Page', { title }))
  return replica.exportChanges(since)
}

describe('pending changes', () => {
  it('keeps a change imported before its predecessor pending until the predecessor arrives', () => {
    const { a, b } = pair()
    expect(b.hasPendingChanges()).toBe(false)
    const first = change(a, 'first')
    const second = change(a, 'second')
    const before = b.stateText()
    b.importChanges(second)
    expect(b.hasPendingChanges()).toBe(true)
    expect(b.stateText()).toBe(before)
    expect(b.version().includes(a.version())).toBe(false)
    b.importChanges(first)
    expect(b.hasPendingChanges()).toBe(false)
    expect(b.stateText()).toBe(a.stateText())
    expect(b.version().includes(a.version())).toBe(true)
  })

  it('leaves a gap pending through a complete import from another replica', () => {
    const { a, b } = pair()
    const c = Replica.load(testSchema(), a.snapshot(), 3n)
    const first = change(a, 'first')
    const second = change(a, 'second')
    b.importChanges(second)
    b.importChanges(change(c, 'other'))
    expect(b.hasPendingChanges()).toBe(true)
    b.importChanges(first)
    expect(b.hasPendingChanges()).toBe(false)
  })

  it('never has pending changes in an in-order sync', () => {
    const { a, b } = pair()
    for (const title of ['one', 'two', 'three']) {
      b.importChanges(change(a, title))
      expect(b.hasPendingChanges()).toBe(false)
      a.importChanges(change(b, title))
      expect(a.hasPendingChanges()).toBe(false)
    }
    expect(a.stateText()).toBe(b.stateText())
    b.importChanges(a.exportChanges(Version.empty()))
    expect(b.hasPendingChanges()).toBe(false)
  })

  it('loads a snapshot of a replica with pending changes without them', () => {
    const { a, b } = pair()
    const first = change(a, 'first')
    const second = change(a, 'second')
    b.importChanges(second)
    expect(b.hasPendingChanges()).toBe(true)
    const loaded = Replica.load(testSchema(), b.snapshot(), 4n)
    expect(loaded.hasPendingChanges()).toBe(false)
    expect(loaded.stateText()).toBe(b.stateText())
    expect(loaded.version().equals(b.version())).toBe(true)
    loaded.importChanges(first)
    expect(loaded.hasPendingChanges()).toBe(false)
    expect(loaded.version().includes(a.version())).toBe(false)
    loaded.importChanges(second)
    expect(loaded.stateText()).toBe(a.stateText())
  })
})

describe('versions', () => {
  it('include each other by the partial order of changes', () => {
    const { a, b } = pair()
    const empty = Version.empty()
    expect(a.version().includes(b.version())).toBe(true)
    expect(b.version().includes(a.version())).toBe(true)
    expect(a.version().includes(empty)).toBe(true)
    expect(empty.includes(empty)).toBe(true)
    expect(empty.includes(a.version())).toBe(false)
    const bytes = change(a, 'ahead')
    expect(a.version().includes(b.version())).toBe(true)
    expect(b.version().includes(a.version())).toBe(false)
    change(b, 'concurrent')
    expect(a.version().includes(b.version())).toBe(false)
    expect(b.version().includes(a.version())).toBe(false)
    b.importChanges(bytes)
    expect(b.version().includes(a.version())).toBe(true)
    expect(a.version().includes(b.version())).toBe(false)
    const decoded = Version.decode(b.version().encode())
    expect(decoded.includes(b.version()) && b.version().includes(decoded)).toBe(true)
    expect(reasonOf(() => a.version().includes({} as never))).toBe('invalid-value')
  })
})
