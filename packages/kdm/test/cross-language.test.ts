/**
 * Rust writes, TypeScript reads (plan 2026-11-24, sections 4 and 9.2): the content fixtures and
 * the change-list fixture under `crates/kition-kdm/tests/fixtures/content/`, which
 * `crates/kition-kdm/tests/cross_language.rs` and `tests/content.rs` check are what the Rust KDM
 * writes, read here to the same canonical state.
 */
import { describe, expect, it } from 'vitest'
import { canonicalText, Replica, Version } from '../src/index'
import { bytes, contentFixture, contentSchema, contentText, reasonOf } from './fixtures'

/** A state fixture in canonical text, as the Rust `state_json().to_string()` writes it. */
const stateText = (name: string) => canonicalText(JSON.parse(contentText(name)))

const START = 'changes-start.content.json'
const start = () => Replica.load(contentSchema(), contentFixture(START))

/** The change-list fixture as JSON, to vary for the refusals. */
const changeList = () => JSON.parse(contentText('changes.json'))
const encode = (value: unknown) => bytes(JSON.stringify(value))

describe('content the Rust KDM writes', () => {
  for (const name of ['empty', 'board', 'numbers', 'keys', 'snapshot']) {
    it(`reads ${name} to its canonical state`, () => {
      const replica = Replica.load(contentSchema(), contentFixture(`${name}.content.json`))
      expect(replica.stateText()).toBe(stateText(`${name}.state.json`))
    })
  }

  it('reads a snapshot with its version, and content with none', () => {
    const snapshot = Replica.load(contentSchema(), contentFixture('snapshot.content.json'))
    expect(snapshot.version().lineage).toBe('0193a5c4-0000-7000-8000-0000000000ff')
    expect(snapshot.version().seq).toBe(42)
    expect(Replica.load(contentSchema(), contentFixture('empty.content.json')).version().equals(Version.empty())).toBe(true)
  })

  it('reads text positions as UTF-16 where it answers them', () => {
    const replica = Replica.load(contentSchema(), contentFixture('keys.content.json'))
    expect(replica.textDelta('Z9', 'body')).toEqual([{ insert: '😀 ' }, { insert: 'bold 𝄞', attributes: { bold: true } }])
    expect(replica.textLength('Z9', 'body')).toBe('😀 bold 𝄞'.length)
    expect(replica.mapEntries('a0', 'vars').map(([key]) => key)).toEqual(['B', '_', 'a', 'é', 'ｚ', '😀'])
  })
})

describe('changes the Rust KDM exports', () => {
  it('start from the snapshot the Rust test starts from', () => {
    expect(start().stateText()).toBe(stateText('changes-start.state.json'))
  })

  it('apply every kind of operation to the state Rust reaches', () => {
    const replica = start()
    expect(replica.importChanges(contentFixture('changes.json'))).toEqual([
      '0193a5c4-0000-7000-8000-0000000000a1',
      '0193a5c4-0000-7000-8000-0000000000b1',
      '0193a5c4-0000-7000-8000-0000000000b2',
      '0193a5c4-0000-7000-8000-0000000000c1',
    ])
    expect(replica.stateText()).toBe(stateText('changes.state.json'))
    expect(replica.version().seq).toBe(10)
    // The deleted node is gone from the tree, and the reads agree with the state.
    const board = '0193a5c4-0000-7000-8000-0000000000a1'
    expect(replica.tree(board, 'outline').map((entry) => [entry.object, entry.parent?.id ?? null])).toEqual([['0193a5c4-0000-7000-8000-0000000000b1', null]])
    expect(replica.exists('0193a5c4-0000-7000-8000-0000000000c1')).toBe(false)
    expect(replica.text('0193a5c4-0000-7000-8000-0000000000b1', 'body')).toBe('😀there!')
    expect(replica.text(board, 'notes')).toBe('abc')
  })

  it('skip the changes a replica has, so importing twice is harmless', () => {
    const replica = start()
    replica.importChanges(contentFixture('changes.json'))
    expect(replica.importChanges(contentFixture('changes.json'))).toEqual([])
    expect(replica.stateText()).toBe(stateText('changes.state.json'))
  })

  it('apply in parts, each following the last', () => {
    const replica = start()
    const list = changeList()
    const first = { ...list, changes: list.changes.slice(0, 1) }
    const rest = { ...list, after: { seq: 8, actor: '0000000000000007' }, changes: list.changes.slice(1) }
    replica.importChanges(encode(first))
    expect(replica.version().seq).toBe(8)
    replica.importChanges(encode(rest))
    expect(replica.stateText()).toBe(stateText('changes.state.json'))
  })

  it('are refused, changing nothing, when they follow a version the replica has not reached', () => {
    const replica = start()
    const list = changeList()
    const ahead = { ...list, after: { seq: 8, actor: null }, changes: list.changes.slice(1) }
    expect(reasonOf(() => replica.importChanges(encode(ahead)))).toBe('stale')
    const gap = { ...list, changes: list.changes.slice(1) }
    expect(reasonOf(() => replica.importChanges(encode(gap)))).toBe('stale')
    expect(replica.stateText()).toBe(stateText('changes-start.state.json'))
    expect(replica.version().seq).toBe(7)
  })

  it('are refused whole, changing nothing, when a precondition fails part way', () => {
    const replica = start()
    const list = changeList()
    // The last change removes an item that is not the one at its index.
    list.changes[2].ops[1].item = '0193a5c4-0000-7000-8000-0000000000b2'
    expect(() => replica.importChanges(encode(list))).toThrow(/^stale: item 1 of .* is `0193a5c4-0000-7000-8000-0000000000c1`, not the one named$/)
    expect(replica.stateText()).toBe(stateText('changes-start.state.json'))
    expect(replica.version().seq).toBe(7)
    // The same replica then takes the changes as they are.
    replica.importChanges(contentFixture('changes.json'))
    expect(replica.stateText()).toBe(stateText('changes.state.json'))
  })

  it('are refused whole on every precondition the Rust store checks, with its words', () => {
    // [change, operation, what is changed in it, the refusal]
    const cases: Array<[number, number, Record<string, unknown>, RegExp]> = [
      [0, 1, { index: 9 }, /^stale: index 9 is beyond \S+\.pages's 2 items$/],
      [0, 5, { id: '0193a5c4-0000-7000-8000-0000000000ee' }, /^stale: object `0193a5c4-0000-7000-8000-0000000000ee` does not exist$/],
      [0, 4, { parent: '0193a5c4-0000-7000-8000-0000000000ee' }, /^stale: no parent node in \S+\.outline$/],
      [1, 0, { index: 9 }, /^stale: index 9 is beyond \S+\.body's 8 characters$/],
      [1, 2, { count: 10 }, /^stale: 1\+10 is beyond \S+\.body's 10 characters$/],
      [1, 3, { end: 9 }, /^stale: 0\.\.9 is not within \S+\.body's 7 characters$/],
      [2, 0, { to: 3 }, /^stale: index 3 is beyond \S+\.pages's 3 items$/],
      [2, 2, { parent: '0193a5c4-0000-7000-8000-0000000000c1' }, /^moving that node would create a cycle$/],
      [2, 2, { op: 'treeDelete', node: '0193a5c4-0000-7000-8000-0000000000b1' }, /^stale: `0193a5c4-0000-7000-8000-0000000000b1` has children in \S+\.outline$/],
    ]
    for (const [change, op, patch, message] of cases) {
      const replica = start()
      const list = changeList()
      Object.assign(list.changes[change].ops[op], patch)
      expect(() => replica.importChanges(encode(list)), message.source).toThrow(message)
      expect(replica.stateText()).toBe(stateText('changes-start.state.json'))
    }
  })

  it('are refused when they belong to another document or another line', () => {
    const replica = start()
    expect(reasonOf(() => replica.importChanges(encode({ ...changeList(), docId: '0193a5c4-0000-7000-8000-000000000009' })))).toBe('wrong-document')
    expect(reasonOf(() => replica.importChanges(encode({ ...changeList(), lineage: '0193a5c4-0000-7000-8000-0000000000aa' })))).toBe('stale')
    expect(reasonOf(() => replica.importChanges(encode({ ...changeList(), changes: [{ ...changeList().changes[0], actor: 'ffffffffffffffff' }] })))).toBe('encoding')
    expect(reasonOf(() => replica.importChanges(encode({ ...changeList(), changes: [{ ...changeList().changes[0], ops: [{ op: 'paint' }] }] })))).toBe('encoding')
    expect(replica.stateText()).toBe(stateText('changes-start.state.json'))
  })

  it('are refused after a change of the same number that went another way', () => {
    const replica = start()
    replica.importChanges(contentFixture('changes.json'))
    const other = changeList()
    other.changes[2].actor = '0000000000000008'
    expect(reasonOf(() => replica.importChanges(encode(other)))).toBe('stale')
  })

  it('are refused on content, which continues no line, until a snapshot comes', () => {
    const replica = Replica.load(contentSchema(), bytes(contentText(START).replace(/"version":\{[^}]*\},/, '')))
    expect(replica.version().isEmpty()).toBe(true)
    expect(reasonOf(() => replica.importChanges(contentFixture('changes.json')))).toBe('stale')
    expect(replica.importChanges(contentFixture(START))).toEqual([])
    expect(replica.version().seq).toBe(7)
    replica.importChanges(contentFixture('changes.json'))
    expect(replica.stateText()).toBe(stateText('changes.state.json'))
  })
})
