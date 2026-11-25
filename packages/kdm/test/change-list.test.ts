/**
 * readChangeList reads a change list as a kit engine exports it (`exportChanges`, the Rust
 * `Replica::export_changes`): who made each change, and its operations, without a kit test
 * parsing the JSON by hand.
 */
import { describe, expect, it } from 'vitest'
import { readChangeList } from '../src/index'
import { bytes, reasonOf } from './fixtures'

const DOC = '0193a5c4-0000-7000-8000-000000000005'
const LINE = '0193a5c4-0000-7000-8000-0000000000fd'
const ROOT = '0193a5c4-0000-7000-8000-0000000000d1'

const list = (changes: unknown[]) => bytes(JSON.stringify({ kdm: 1, docId: DOC, lineage: LINE, after: { seq: 3, actor: '0000000000000001' }, changes }))

describe('readChangeList', () => {
  it('reads each change with its origin, actor and operations', () => {
    const set = { op: 'set', id: ROOT, field: 'title', value: 'New', was: 'Old' }
    const read = readChangeList(
      list([
        { seq: 4, actor: '2', origin: ['agent', 'agent:writer', 'rename', 1], ops: [set] },
        { seq: 5, actor: '0000000000000001', origin: ['person', 'kdm', 'undo', 1], ops: [{ ...set, value: 'Old', was: 'New' }] },
      ]),
    )
    expect(read.docId).toBe(DOC)
    expect([read.lineage, read.after, read.afterActor]).toEqual([LINE, 3, '0000000000000001'])
    expect(read.changes.map((change) => [change.seq, change.actor, change.origin.kind, change.origin.principal, change.origin.label, change.schemaVersion])).toEqual([
      [4, '0000000000000002', 'agent', 'agent:writer', 'rename', 1],
      [5, '0000000000000001', 'person', 'kdm', 'undo', 1],
    ])
    expect(read.changes[0]?.ops).toEqual([set])
  })

  it('refuses a snapshot and what is not KDM changes', () => {
    const snapshot = bytes(`{"kdm":1,"kit":"kit.test","docId":"${DOC}","version":{"lineage":"${LINE}","seq":1},"schemaVersion":1,"objects":{}}`)
    expect(reasonOf(() => readChangeList(snapshot))).toBe('encoding')
    expect(reasonOf(() => readChangeList(list([{ seq: 4, actor: '2', origin: 'person', ops: [] }])))).toBe('encoding')
    expect(reasonOf(() => readChangeList(bytes('not json')))).toBe('encoding')
  })
})
