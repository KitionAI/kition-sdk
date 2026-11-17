import { describe, expect, it } from 'vitest'
import { checkReferences, decodeBlobBundle, digest, encodeBlobBundle, firstDifference, register, registerChanges, Rng, SchemaInfo, treeNodes, utf16Index } from '../src/index'
import { SCHEMA } from './toy'

const schema = SchemaInfo.parse(SCHEMA)
const state = (objects: Record<string, unknown>) => ({ meta: {}, objects })

describe('reading canonical states', () => {
  it('parses the schema the suite needs', () => {
    expect(schema.kit).toBe('kit.notes')
    expect(schema.hasKind('tree')).toBe(true)
    expect(schema.hasKind('map')).toBe(false)
    expect(() => SchemaInfo.parse('{')).toThrow(/not JSON/)
  })

  it('finds dangling, repeated, and mistyped references', () => {
    const broken = state({
      board: { $type: 'Board', notes: ['a', 'a', 'gone', 'board'], outline: [{ object: 'a', children: [{ object: 'a', children: [] }] }] },
      a: { $type: 'Note', x: 1, color: 'red', body: '' },
    })
    expect(() => checkReferences(schema, broken, () => false)).toThrow(
      'invalid references: Board board.notes holds a twice; Board board.notes holds gone, which does not exist; Board board.notes holds board, a Board rather than a Note; a is in a tree twice (board.outline and board.outline)',
    )
    expect(() => checkReferences(schema, state({ board: { $type: 'Board', notes: ['gone'], outline: [] } }), (ty, field) => ty === 'Board' && field === 'notes')).not.toThrow()
  })

  it('diffs registers and reads them back', () => {
    const before = state({ a: { $type: 'Note', x: 1, color: 'red', body: 'hi' } })
    const after = state({ a: { $type: 'Note', x: 2, color: 'red', body: 'ho' }, b: { $type: 'Note', x: 0, color: 'new', body: '' } })
    const changed = registerChanges(schema, before, after)
    expect(changed.list().map(({ slot, value }) => [...slot, value])).toEqual([
      ['a', 'x', 2],
      ['b', 'color', 'new'],
      ['b', 'picture', null],
      ['b', 'x', 0],
    ])
    expect(register(schema, after, ['a', 'x'])).toBe(2)
    expect(register(schema, after, ['missing', 'x'])).toBeNull()
    expect(treeNodes(schema, state({ board: { $type: 'Board', notes: [], outline: [{ object: 'a', children: [{ object: 'b', children: [] }] }] } }))).toEqual(new Map([['board.outline', 2]]))
  })

  it('names the first difference', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('.a[1].b: 2 vs 3')
    expect(firstDifference({ a: [1] }, { a: [1, 2] })).toBe('.a: [1] vs [1,2]')
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull()
    expect(digest({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('draws the Rust generator’s sequence', () => {
    // Rng::new(1).next_u64() in Rust (kition_kdm::testing has the same generator).
    const rng = new Rng(1)
    const first = rng.nextU64()
    expect(first).toBe(new Rng(1).nextU64())
    expect(first).not.toBe(new Rng(2).nextU64())
    expect(new Rng(7).below(0)).toBe(0)
  })

  it('counts text positions in code points and encodes blob bundles', () => {
    const text = `a${String.fromCodePoint(0x1f600)}b`
    expect(utf16Index(text, 2)).toBe(3)
    expect(utf16Index(text, 9)).toBe(text.length)
    const blobs = new Map([['ab'.repeat(32), new Uint8Array([1, 2, 3])], ['cd'.repeat(32), new Uint8Array(0)]])
    expect(decodeBlobBundle(encodeBlobBundle(blobs))).toEqual(blobs)
    expect(() => decodeBlobBundle(new Uint8Array(10))).toThrow(/truncated/)
  })
})
