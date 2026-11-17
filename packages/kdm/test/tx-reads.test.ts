/** Reads of map fields and of the objects of a type, on `Replica` and inside a transaction; the twin of the crate's `tests/tx_reads.rs`. */
import { describe, expect, it } from 'vitest'
import { KdmError, newDocId, parseSchema, Replica, type ObjectId, type Tx } from '../src/index'
import { crateFixture, me, pageWithShape, reasonOf, testSchema } from './helpers'

const replica = () => Replica.create(testSchema(), newDocId(), 1n)

/** A sheet whose `cells` hold `a: 1`, `b: {"v": 2}`, `c: "x"`. */
function sheetOf(doc: Replica): ObjectId {
  return doc.transact(me, (tx) => {
    const sheet = tx.create('Sheet', {})
    tx.mapSet(sheet, 'cells', 'b', { v: 2.0 })
    tx.mapSet(sheet, 'cells', 'a', 1)
    tx.mapSet(sheet, 'cells', 'c', 'x')
    return sheet
  })
}

/** The `KdmError` that `run` throws, as reason and message. */
function errorOf(run: () => unknown): { reason: string; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof KdmError) return { reason: error.reason, message: error.message }
    throw error
  }
  expect.fail('expected a KdmError')
}

describe('transaction reads', () => {
  it('lists a map field’s entries on the replica, sorted by key in code point order', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    expect(doc.mapEntries(sheet, 'cells')).toEqual([
      ['a', 1],
      ['b', { v: 2 }],
      ['c', 'x'],
    ])
    doc.transact(me, (tx) => {
      tx.mapSet(sheet, 'cells', '😀', true)
      tx.mapSet(sheet, 'cells', '\uffff', null)
      tx.mapDelete(sheet, 'cells', 'a')
    })
    expect(doc.mapEntries(sheet, 'cells').map(([key]) => key)).toEqual(['b', 'c', '\uffff', '😀'])
  })

  it('reads committed and pending map keys in a transaction', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    doc.transact(me, (tx) => {
      expect(tx.mapGet(sheet, 'cells', 'a')).toBe(1)
      expect(tx.mapGet(sheet, 'cells', 'b')).toEqual({ v: 2 })
      expect(tx.mapGet(sheet, 'cells', 'missing')).toBeNull()
      tx.mapSet(sheet, 'cells', 'a', { w: 3.0, f: '=1' })
      expect(Object.keys(tx.mapGet(sheet, 'cells', 'a') as object)).toEqual(['f', 'w'])
      expect(tx.mapGet(sheet, 'cells', 'a')).toEqual({ f: '=1', w: 3 })
      tx.mapSet(sheet, 'cells', 'd', [1.0, 2.5])
      expect(tx.mapGet(sheet, 'cells', 'd')).toEqual([1, 2.5])
      tx.mapDelete(sheet, 'cells', 'b')
      expect(tx.mapGet(sheet, 'cells', 'b')).toBeNull()
      tx.mapDelete(sheet, 'cells', 'd')
      expect(tx.mapGet(sheet, 'cells', 'd')).toBeNull()
      tx.mapSet(sheet, 'cells', 'b', 'back')
      expect(tx.mapGet(sheet, 'cells', 'b')).toBe('back')
      expect(tx.mapEntries(sheet, 'cells')).toEqual([
        ['a', { f: '=1', w: 3 }],
        ['b', 'back'],
        ['c', 'x'],
      ])
    })
    expect(doc.mapEntries(sheet, 'cells')).toEqual([
      ['a', { f: '=1', w: 3 }],
      ['b', 'back'],
      ['c', 'x'],
    ])
  })

  it('merges committed and pending writes in map entries', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    const expected = [
      ['0', 0],
      ['a', 1],
      ['b', 20],
      ['z', null],
    ]
    doc.transact(me, (tx) => {
      expect(tx.mapEntries(sheet, 'cells')).toEqual([
        ['a', 1],
        ['b', { v: 2 }],
        ['c', 'x'],
      ])
      tx.mapSet(sheet, 'cells', '0', 0)
      tx.mapSet(sheet, 'cells', 'b', 20)
      tx.mapDelete(sheet, 'cells', 'c')
      tx.mapDelete(sheet, 'cells', 'never')
      tx.mapSet(sheet, 'cells', 'z', null)
      expect(tx.mapEntries(sheet, 'cells')).toEqual(expected)
    })
    expect(doc.mapEntries(sheet, 'cells')).toEqual(expected)
  })

  it('reads the map of an object created in the transaction', () => {
    const doc = replica()
    doc.transact(me, (tx) => {
      const sheet = tx.create('Sheet', {})
      expect(tx.mapGet(sheet, 'cells', 'a')).toBeNull()
      expect(tx.mapEntries(sheet, 'cells')).toEqual([])
      tx.mapSet(sheet, 'cells', 'a', 1)
      tx.mapSet(sheet, 'cells', 'b', 2)
      tx.mapDelete(sheet, 'cells', 'a')
      expect(tx.mapGet(sheet, 'cells', 'b')).toBe(2)
      expect(tx.mapEntries(sheet, 'cells')).toEqual([['b', 2]])
      tx.delete(sheet)
      expect(reasonOf(() => tx.mapGet(sheet, 'cells', 'b'))).toBe('not-found')
      expect(reasonOf(() => tx.mapEntries(sheet, 'cells'))).toBe('not-found')
    })
  })

  it('fails map reads of a deleted object or another field as the other accessors do', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    const { page, shape } = pageWithShape(doc)
    const cases: Array<[ObjectId, string]> = [
      [page, 'shapes'],
      [shape, 'x'],
      [shape, 'label'],
      [sheet, 'nope'],
    ]
    const expected = cases.map(([id, field]) => errorOf(() => doc.mapGet(id, field, 'k')))
    expect(expected[0]).toEqual({ reason: 'invalid-value', message: 'field `shapes` of `Page` is not a map field' })
    expect(expected[3].reason).toBe('unknown-field')
    cases.forEach(([id, field], index) => expect(errorOf(() => doc.mapEntries(id, field))).toEqual(expected[index]))
    expect(reasonOf(() => doc.mapEntries('nope', 'cells'))).toBe('not-found')
    doc.transact(me, (tx) => {
      cases.forEach(([id, field], index) => {
        expect(errorOf(() => tx.mapGet(id, field, 'k'))).toEqual(expected[index])
        expect(errorOf(() => tx.mapEntries(id, field))).toEqual(expected[index])
      })
      expect(reasonOf(() => tx.mapGet('nope', 'cells', 'k'))).toBe('not-found')
      expect(reasonOf(() => tx.mapEntries('nope', 'cells'))).toBe('not-found')
      tx.delete(sheet)
      expect(reasonOf(() => tx.mapGet(sheet, 'cells', 'a'))).toBe('not-found')
      expect(reasonOf(() => tx.mapEntries(sheet, 'cells'))).toBe('not-found')
    })
  })

  it('lists the objects of a type with the transaction’s creations and deletions', () => {
    const doc = replica()
    const shape = (tx: Tx, id: string) => tx.create('Shape', { kind: 'rect', x: 1, y: 2 }, { id })
    doc.transact(me, (tx) => {
      shape(tx, 'b')
      shape(tx, 'd')
      tx.create('Page', { title: 'One' }, { id: 'P' })
    })
    doc.transact(me, (tx) => {
      expect(tx.objectsOfType('Shape')).toEqual(['b', 'd'])
      shape(tx, 'c')
      shape(tx, 'a')
      shape(tx, 'B')
      expect(tx.objectsOfType('Shape')).toEqual(['B', 'a', 'b', 'c', 'd'])
      tx.delete('d')
      tx.delete('a')
      expect(tx.objectsOfType('Shape')).toEqual(['B', 'b', 'c'])
      expect(tx.objectsOfType('Page')).toEqual(['P'])
      expect(tx.objectsOfType('Nope')).toEqual([])
    })
    expect(doc.objectsOfType('Shape')).toEqual(['B', 'b', 'c'])
  })

  it('leaves nothing of a failed transaction that read its own writes', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    const before = doc.stateText()
    const version = doc.version()
    const reason = reasonOf(() =>
      doc.transact(me, (tx) => {
        tx.mapSet(sheet, 'cells', 'a', 99)
        tx.mapDelete(sheet, 'cells', 'b')
        const created = tx.create('Sheet', {})
        expect(tx.mapGet(sheet, 'cells', 'a')).toBe(99)
        expect(tx.objectsOfType('Sheet')).toHaveLength(2)
        tx.mapSet(created, 'cells', 'k', 1)
        tx.mapSet(sheet, 'cells', 'bad', 1n)
      }),
    )
    expect(reason).toBe('invalid-value')
    expect(doc.stateText()).toBe(before)
    expect(doc.version().equals(version)).toBe(true)
    expect(doc.objectsOfType('Sheet')).toEqual([sheet])
    doc.transact(me, (tx) => {
      expect(tx.mapGet(sheet, 'cells', 'a')).toBe(1)
      expect(tx.objectsOfType('Sheet')).toEqual([sheet])
    })
  })

  it('does not see a refused map write', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    doc.transact(me, (tx) => {
      expect(reasonOf(() => tx.mapSet(sheet, 'cells', 'a', 1n))).toBe('invalid-value')
      expect(tx.mapGet(sheet, 'cells', 'a')).toBe(1)
    })
  })

  it('copies pending map values it hands out, and reads keys as they are stored', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    doc.transact(me, (tx) => {
      tx.mapSet(sheet, 'cells', 'o', { list: [1] })
      ;((tx.mapGet(sheet, 'cells', 'o') as { list: number[] }).list).push(2)
      expect(tx.mapGet(sheet, 'cells', 'o')).toEqual({ list: [1] })
      tx.mapSet(sheet, 'cells', 'k\ud800', 1)
      expect(tx.mapGet(sheet, 'cells', 'k\ud800')).toBe(1)
      expect(tx.mapGet(sheet, 'cells', 'k\ufffd')).toBe(1)
      tx.mapSet(sheet, 'cells', '__proto__', { a: 1 })
      expect(tx.mapGet(sheet, 'cells', '__proto__')).toEqual({ a: 1 })
    })
    expect(doc.mapGet(sheet, 'cells', 'k\ufffd')).toBe(1)
    expect(doc.mapEntries(sheet, 'cells').map(([key]) => key)).toEqual(['__proto__', 'a', 'b', 'c', 'k\ufffd', 'o'])
    doc.transact(me, (tx) => {
      expect(tx.mapGet(sheet, 'cells', 'k\ud800')).toBe(1)
      expect(tx.mapEntries(sheet, 'cells')).toEqual(doc.mapEntries(sheet, 'cells'))
    })
  })

  it('does not list a refused create among the objects of its type', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => {
      expect(errorOf(() => tx.create('Shape', { kind: 'rect', x: 1 })).message).toBe('field `y` of `Shape` is required')
      expect(reasonOf(() => tx.create('Shape', { kind: 'rect', x: 1, y: 2 }, { id: shape }))).toBe('invalid-value')
      expect(tx.objectsOfType('Shape')).toEqual([shape])
    })
    expect(doc.objectsOfType('Shape')).toEqual([shape])
  })

  it('reads a map field the stored object lacks as empty', () => {
    const old = replica()
    const { shape } = pageWithShape(old)
    const json = JSON.parse(crateFixture('test-schema.json'))
    json.schemaVersion = 2
    json.types.Shape.fields.meta = { kind: 'map' }
    const doc = Replica.load(parseSchema(json), old.snapshot(), 2n)
    expect(doc.mapGet(shape, 'meta', 'k')).toBeNull()
    expect(doc.mapEntries(shape, 'meta')).toEqual([])
    doc.transact(me, (tx) => {
      expect(tx.mapGet(shape, 'meta', 'k')).toBeNull()
      expect(tx.mapEntries(shape, 'meta')).toEqual([])
      expect(reasonOf(() => tx.mapSet(shape, 'meta', 'k', 1))).toBe('not-found')
      expect(tx.mapGet(shape, 'meta', 'k')).toBeNull()
    })
  })

  it('checks the arguments of the new reads', () => {
    const doc = replica()
    const sheet = sheetOf(doc)
    const untyped = (value: unknown) => value as never
    expect(reasonOf(() => doc.mapEntries(untyped(1), 'cells'))).toBe('invalid-value')
    expect(reasonOf(() => doc.mapEntries(sheet, untyped(1)))).toBe('invalid-value')
    doc.transact(me, (tx) => {
      expect(reasonOf(() => tx.mapGet(sheet, 'cells', untyped(5)))).toBe('invalid-value')
      expect(reasonOf(() => tx.mapGet(untyped(null), 'cells', 'a'))).toBe('invalid-value')
      expect(reasonOf(() => tx.mapEntries(sheet, untyped(0)))).toBe('invalid-value')
      expect(reasonOf(() => tx.objectsOfType(untyped(1)))).toBe('invalid-value')
    })
    let ended: Tx | undefined
    doc.transact(me, (tx) => {
      ended = tx
    })
    expect(reasonOf(() => ended!.mapGet(sheet, 'cells', 'a'))).toBe('engine')
    expect(reasonOf(() => ended!.mapEntries(sheet, 'cells'))).toBe('engine')
    expect(reasonOf(() => ended!.objectsOfType('Sheet'))).toBe('engine')
  })

  it('reads object types, including objects the transaction created or deleted', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const sheet = doc.transact(me, (tx) => {
      expect(tx.objectType(page)).toBe('Page')
      const created = tx.create('Sheet', {})
      expect(tx.objectType(created)).toBe('Sheet')
      tx.delete(shape)
      expect(errorOf(() => tx.objectType(shape)).reason).toBe('not-found')
      expect(errorOf(() => tx.objectType('missing')).reason).toBe('not-found')
      return created
    })
    expect(doc.objectType(sheet)).toBe('Sheet')
  })
})
