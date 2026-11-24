/**
 * Equal versions encode to equal bytes (case regressions/issue-kdm-version-bytes); the twin of the
 * crate's `tests/version_bytes.rs`, reading the same `fixtures/version-bytes.json`.
 */
import { VersionVector, type PeerID } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { newDocId, Replica, Version } from '../src/index'
import { crateFixture, me, pageWithShape, testSchema } from './helpers'

type Case = { versions: string; entries: Array<[string, number]>; engineOrder: string; canonical: string }

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

describe('version bytes', () => {
  const cases = JSON.parse(crateFixture('version-bytes.json')) as Case[]

  it.each(cases)('encodes $versions with its entries sorted by actor id', ({ entries, engineOrder, canonical }) => {
    const read = Version.decode(hex(engineOrder))
    expect(toHex(read.encode())).toBe(canonical)
    expect(Version.decode(hex(canonical)).equals(read)).toBe(true)
    // The engine reads the canonical bytes as the same entries.
    expect(new Map(VersionVector.decode(hex(canonical)).toJSON())).toEqual(new Map(entries))
    // Built from the entries, the same bytes.
    expect(toHex(Version.fromEngine(VersionVector.parseJSON(new Map(entries) as Map<PeerID, number>)).encode())).toBe(canonical)
  })

  it('writes the format the engine writes', () => {
    // With one entry the engine's order is the only one.
    const one = new Map([['7', 3]]) as Map<PeerID, number>
    expect(toHex(VersionVector.parseJSON(one).encode())).toBe(cases[1].canonical)
  })

  it('answers the same bytes for replicas at the same version whatever order they imported in', () => {
    const origin = Replica.create(testSchema(), newDocId(), 1n)
    pageWithShape(origin)
    const start = origin.snapshot()
    const base = origin.version()
    const exports = Array.from({ length: 40 }, (_, writer) => {
      const replica = Replica.load(testSchema(), start, 1_000n + BigInt(writer) * 7_919n)
      replica.transact(me, (tx) => tx.create('Page', { title: `page ${writer}` }))
      return replica.exportChanges(base)
    })
    const forward = Replica.load(testSchema(), start, 2n)
    const backward = Replica.load(testSchema(), start, 3n)
    for (const changes of exports) forward.importChanges(changes)
    for (const changes of [...exports].reverse()) backward.importChanges(changes)
    expect(forward.version().equals(backward.version())).toBe(true)
    expect(toHex(forward.version().encode())).toBe(toHex(backward.version().encode()))
  })
})
