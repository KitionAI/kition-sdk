// Whether a replica carries the document's whole history (`carriesWholeHistory`, data model "A copy
// is a new document", sync protocol S20): a full replica does, and so does a shallow one rooted at
// the document's birth (a copy made by `copyAsNewDocument` and every replica loaded from it). A
// replica truncated later does not. The birth is read from the replica's state at its root, so no
// change after the root can claim another one. The Rust crate's tests/whole_history.rs tests the same.
import { LoroDoc, VersionVector } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { newDocId, Replica, Version, type ObjectId } from '../src/index'
import { me, pageWithShape, testSchema } from './helpers'

const load = (bytes: Uint8Array, actor: bigint): Replica => Replica.load(testSchema(), bytes, actor)

/** A full document with a page and a shape, edited twice. */
function source(): { source: Replica; shape: ObjectId } {
  const source = Replica.create(testSchema(), newDocId(), 1n)
  const { shape } = pageWithShape(source)
  source.transact(me, (tx) => tx.set(shape, 'x', 11))
  return { source, shape }
}

/** The engine document inside a KDM export, with its envelope. */
function engine(bytes: Uint8Array): { header: Uint8Array; doc: LoroDoc } {
  const doc = new LoroDoc()
  doc.import(bytes.subarray(20))
  return { header: bytes.slice(0, 20), doc }
}

const wrap = (header: Uint8Array, bytes: Uint8Array): Uint8Array => new Uint8Array([...header, ...bytes])

/** A shallow snapshot of `doc` rooted at its current version. */
const shallowNow = (header: Uint8Array, doc: LoroDoc): Uint8Array => wrap(header, doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() }))

/** Writes `value` as the recorded birth in its own change, by `peer`, as a client that bypasses KDM would. */
function writeBirth(doc: LoroDoc, peer: bigint, value: VersionVector): void {
  doc.setPeerId(peer)
  doc.getMap('birth').set('root', value.encode())
  doc.commit()
}

describe('carriesWholeHistory', () => {
  it('holds for a full replica', () => {
    const { source: from } = source()
    expect(from.isShallow()).toBe(false)
    expect(from.carriesWholeHistory()).toBe(true)
    expect(load(from.snapshot(), 2n).carriesWholeHistory()).toBe(true)
    expect(load(from.exportChanges(Version.empty()), 2n).carriesWholeHistory()).toBe(true)
  })

  it('does not hold for a shallow replica of a created document', () => {
    const { source: from } = source()
    const shallow = load(from.shallowSnapshot(from.version()), 2n)
    expect(shallow.isShallow()).toBe(true)
    expect(shallow.carriesWholeHistory()).toBe(false)
    expect(load(shallow.snapshot(), 3n).carriesWholeHistory()).toBe(false)
  })

  it('holds for a copy, rooted at its birth, and every replica loaded from it', () => {
    const { source: from, shape } = source()
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    expect(copy.isShallow()).toBe(true)
    expect(copy.carriesWholeHistory()).toBe(true)
    const other = load(copy.snapshot(), 6n)
    expect(other.carriesWholeHistory()).toBe(true)
    other.transact(me, (tx) => tx.set(shape, 'y', 3))
    const edited = load(other.snapshot(), 7n)
    expect(edited.carriesWholeHistory()).toBe(true)
    expect(edited.shallowRoot()!.equals(copy.shallowRoot()!)).toBe(true)
    expect(load(other.exportChanges(Version.empty()), 8n).carriesWholeHistory()).toBe(true)
    expect(other.fork(9n).carriesWholeHistory()).toBe(true)
    expect(load(other.shallowSnapshot(Version.empty()), 10n).carriesWholeHistory()).toBe(true)
    expect(load(other.shallowSnapshot(copy.version()), 10n).carriesWholeHistory()).toBe(true)
  })

  it('does not hold for a copy truncated after more edits', () => {
    const { source: from, shape } = source()
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    copy.transact(me, (tx) => tx.set(shape, 'x', 12))
    const truncated = load(copy.shallowSnapshot(copy.version()), 6n)
    expect(truncated.isShallow()).toBe(true)
    expect(truncated.shallowRoot()!.equals(copy.shallowRoot()!)).toBe(false)
    expect(truncated.carriesWholeHistory()).toBe(false)
    expect(load(truncated.snapshot(), 7n).carriesWholeHistory()).toBe(false)
    expect(copy.carriesWholeHistory()).toBe(true)
  })

  it('holds for a copy of a copy and a copy of a truncated replica, each with its own birth', () => {
    const { source: from, shape } = source()
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    copy.transact(me, (tx) => tx.set(shape, 'x', 12))
    const again = copy.copyAsNewDocument(newDocId(), 5n)
    expect(again.carriesWholeHistory()).toBe(true)
    expect(again.shallowRoot()!.equals(copy.shallowRoot()!)).toBe(false)
    expect(load(again.snapshot(), 6n).carriesWholeHistory()).toBe(true)
    const truncated = load(copy.shallowSnapshot(copy.version()), 7n)
    expect(truncated.copyAsNewDocument(newDocId(), 7n).carriesWholeHistory()).toBe(true)
    const busy = Replica.create(testSchema(), newDocId(), 1n)
    pageWithShape(busy)
    expect(busy.copyAsNewDocument(newDocId(), 1n).carriesWholeHistory()).toBe(true)
  })

  it('does not honour a later change claiming another birth', () => {
    const { source: from, shape } = source()
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    copy.transact(me, (tx) => tx.set(shape, 'x', 12))
    {
      const { header, doc } = engine(copy.snapshot())
      // Claims the current version as the birth, edits on, then truncates there.
      const claimed = doc.oplogVersion()
      writeBirth(doc, 40n, claimed)
      doc.getMap('objects').set('tamper', 1)
      doc.commit()
      const afterClaim = load(shallowNow(header, doc), 41n)
      expect(afterClaim.isShallow()).toBe(true)
      expect(afterClaim.carriesWholeHistory()).toBe(false)
      // Truncates at the claimed version: the state there holds the copy's birth, not the claim.
      const atClaim = wrap(header, doc.export({ mode: 'shallow-snapshot', frontiers: doc.vvToFrontiers(claimed) }))
      expect(load(atClaim, 42n).carriesWholeHistory()).toBe(false)
    }
    {
      // An honestly truncated replica whose later change claims its root.
      const { header, doc } = engine(copy.shallowSnapshot(copy.version()))
      writeBirth(doc, 43n, doc.shallowSinceVV())
      const claimedRoot = load(wrap(header, doc.export({ mode: 'snapshot' })), 44n)
      expect(claimedRoot.isShallow()).toBe(true)
      expect(claimedRoot.carriesWholeHistory()).toBe(false)
    }
  })

  it('takes a change recording its own root for a birth, as a copy is', () => {
    const { source: from } = source()
    const { header, doc } = engine(from.snapshot())
    const root = new Map(doc.oplogVersion().toJSON())
    root.set('60', 0)
    writeBirth(doc, 60n, VersionVector.parseJSON(root))
    const declared = load(shallowNow(header, doc), 61n)
    expect(declared.isShallow()).toBe(true)
    expect(declared.carriesWholeHistory()).toBe(true)
  })

  it('keeps holding for a copy whose birth a later change rewrites', () => {
    const { source: from } = source()
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    const { header, doc } = engine(copy.snapshot())
    writeBirth(doc, 40n, new VersionVector(null))
    expect(load(wrap(header, doc.export({ mode: 'snapshot' })), 41n).carriesWholeHistory()).toBe(true)
  })

  it('does not hold for a shallow document that records no birth', () => {
    // Copies made before the birth was recorded (board 0.1.4-dev builds only) carry none.
    const { source: from } = source()
    const { doc } = engine(from.snapshot())
    const id = newDocId()
    doc.setPeerId(50n)
    doc.getMap('meta').set('docId', id)
    doc.commit()
    const header = from.snapshot().slice(0, 20)
    const idBytes = Uint8Array.from(id.replace(/-/g, '').match(/../g)!.map((pair) => parseInt(pair, 16)))
    header.set(idBytes, 4)
    const old = load(shallowNow(header, doc), 51n)
    expect(old.isShallow()).toBe(true)
    expect(old.carriesWholeHistory()).toBe(false)
  })
})

describe('Replica.snapshotCarriesWholeHistory', () => {
  it('tells the same from bytes, without a schema', () => {
    const { source: from, shape } = source()
    const full = (bytes: Uint8Array) => Replica.snapshotCarriesWholeHistory(bytes)
    expect(full(from.snapshot())).toBe(true)
    expect(full(from.exportChanges(Version.empty()))).toBe(true)
    expect(full(from.shallowSnapshot(from.version()))).toBe(false)
    const copy = from.copyAsNewDocument(newDocId(), 5n)
    expect(full(copy.snapshot())).toBe(true)
    copy.transact(me, (tx) => tx.set(shape, 'x', 12))
    expect(full(copy.snapshot())).toBe(true)
    expect(full(copy.exportChanges(Version.empty()))).toBe(true)
    expect(full(copy.shallowSnapshot(copy.version()))).toBe(false)
    expect(() => full(new TextEncoder().encode('not a KDM export'))).toThrow(/encoding/)
  })
})
