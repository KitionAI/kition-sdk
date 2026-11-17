/**
 * Marks on text (rule M19); the twin of the crate's `tests/marks.rs`. The canonical texts asserted
 * here are asserted there too, so both implementations write the same state for the same marks.
 * Positions here are UTF-16 code units (rule M18).
 */
import { describe, expect, it } from 'vitest'
import { KdmError, parseSchema, Replica, type Schema, type TextRun, type Tx } from '../src/index'
import { crateFixture, me, reasonOf } from './helpers'

const marksSchema = (): Schema => parseSchema(crateFixture('marks-schema.json'))

const DOC = '01920000-0000-7000-8000-0000000000bb'

const replica = (actor: bigint) => Replica.create(marksSchema(), DOC, actor)

/** A replica holding paragraph `p1` with `text` in its marked field. */
function paragraph(actor: bigint, text: string): Replica {
  const doc = replica(actor)
  doc.transact(me, (tx) => {
    const para = tx.create('Para', {}, { id: 'p1' })
    tx.textInsert(para, 'text', 0, text)
  })
  return doc
}

/** A second replica of `doc`'s document, loaded from its snapshot. */
const peer = (doc: Replica, actor: bigint) => Replica.load(marksSchema(), doc.snapshot(), actor)

function sync(a: Replica, b: Replica): void {
  const toB = a.exportChanges(b.version())
  const toA = b.exportChanges(a.version())
  b.importChanges(toB)
  a.importChanges(toA)
  expect(a.stateText()).toBe(b.stateText())
}

const delta = (doc: Replica): TextRun[] => doc.textDelta('p1', 'text')

/** Code points to text, so these sources stay ASCII and English-only for the hosts that carry the KDM. */
const fromCodePoints = (...points: number[]) => String.fromCodePoint(...points)
const GRIN = 0x1f600
/** Two CJK ideographs ("quarter"). */
const QUARTER = [0x5b63, 0x5ea6]

/** The same text as the crate's `MARKED_PARAGRAPH`. */
const MARKED_PARAGRAPH =
  '"p1":{"$type":"Para","plain":"","text":[{"attributes":{"bold":true},"insert":"Hel"},{"attributes":{"bold":true,"italic":true},"insert":"lo"},{"attributes":{"italic":true},"insert":" "},{"attributes":{"italic":true,"link":"https://x"},"insert":"wo"},{"attributes":{"link":"https://x"},"insert":"rld"}]}'

describe('marks on text', () => {
  it("put a marked field's runs and a plain field's string in the canonical state", () => {
    const doc = paragraph(1n, 'Hello world')
    doc.transact(me, (tx) => {
      tx.textMark('p1', 'text', 0, 5, 'bold', true)
      tx.textMark('p1', 'text', 3, 8, 'italic', true)
      tx.textMark('p1', 'text', 6, 11, 'link', 'https://x')
    })
    expect(doc.stateText()).toContain(MARKED_PARAGRAPH)
    expect(doc.text('p1', 'text')).toBe('Hello world')
    expect(delta(doc)).toEqual([
      { insert: 'Hel', attributes: { bold: true } },
      { insert: 'lo', attributes: { bold: true, italic: true } },
      { insert: ' ', attributes: { italic: true } },
      { insert: 'wo', attributes: { italic: true, link: 'https://x' } },
      { insert: 'rld', attributes: { link: 'https://x' } },
    ])
    expect(peer(doc, 2n).stateText()).toBe(doc.stateText())
  })

  it('count positions in UTF-16 code units and write the state the crate writes', () => {
    const text = `a${fromCodePoints(GRIN)}${fromCodePoints(...QUARTER)}b`
    const doc = paragraph(1n, text)
    // The face (two code units) and the first ideograph: scalars 1..3 in Rust.
    doc.transact(me, (tx) => tx.textMark('p1', 'text', 1, 4, 'bold', 1.0))
    const marked = fromCodePoints(GRIN, QUARTER[0])
    const rest = `${fromCodePoints(QUARTER[1])}b`
    expect(delta(doc)).toEqual([{ insert: 'a' }, { insert: marked, attributes: { bold: 1 } }, { insert: rest }])
    expect(doc.stateText()).toContain(`"text":[{"insert":"a"},{"attributes":{"bold":1},"insert":"${marked}"},{"insert":"${rest}"}]`)
    // A position inside the face's surrogate pair is out of range.
    expect(reasonOf(() => doc.transact(me, (tx) => tx.textMark('p1', 'text', 2, 4, 'italic', true)))).toBe('out-of-range')
  })

  it('read a field without marks as one run and an empty text as none', () => {
    const doc = paragraph(1n, '')
    expect(delta(doc)).toEqual([])
    doc.transact(me, (tx) => tx.textInsert('p1', 'plain', 0, 'just text'))
    expect(doc.textDelta('p1', 'plain')).toEqual([{ insert: 'just text' }])
    const state = doc.stateJson() as { objects: Record<string, Record<string, unknown>> }
    expect(state.objects.p1.plain).toBe('just text')
    expect(state.objects.p1.text).toEqual([])
  })

  it('keep both concurrent insertions at one position of a marked text', () => {
    const a = paragraph(1n, 'ab')
    a.transact(me, (tx) => tx.textMark('p1', 'text', 0, 2, 'bold', true))
    const b = peer(a, 2n)
    a.transact(me, (tx) => tx.textInsert('p1', 'text', 1, 'X'))
    b.transact(me, (tx) => tx.textInsert('p1', 'text', 1, 'Y'))
    sync(a, b)
    const text = a.text('p1', 'text')
    expect(['aXYb', 'aYXb']).toContain(text)
    expect(delta(a)).toEqual([{ insert: text, attributes: { bold: true } }])
  })

  it('apply concurrent bold and italic over overlapping ranges both', () => {
    const a = paragraph(1n, 'Hello world')
    const b = peer(a, 2n)
    a.transact(me, (tx) => tx.textMark('p1', 'text', 0, 5, 'bold', true))
    b.transact(me, (tx) => tx.textMark('p1', 'text', 3, 8, 'italic', true))
    sync(a, b)
    expect(delta(a)).toEqual([
      { insert: 'Hel', attributes: { bold: true } },
      { insert: 'lo', attributes: { bold: true, italic: true } },
      { insert: ' wo', attributes: { italic: true } },
      { insert: 'rld' },
    ])
  })

  it('extend a mark to text typed at its ends as its expand says', () => {
    const doc = paragraph(1n, 'aaa bbb ccc ddd')
    doc.transact(me, (tx) => {
      tx.textMark('p1', 'text', 0, 3, 'bold', true) // after
      tx.textMark('p1', 'text', 4, 7, 'link', 'u') // none
      tx.textMark('p1', 'text', 8, 11, 'lead', true) // before
      tx.textMark('p1', 'text', 12, 15, 'wide', true) // both
    })
    for (const [start, end] of [
      [12, 15],
      [8, 11],
      [4, 7],
      [0, 3],
    ]) {
      doc.transact(me, (tx) => {
        tx.textInsert('p1', 'text', end, ']')
        tx.textInsert('p1', 'text', start, '[')
      })
    }
    expect(doc.text('p1', 'text')).toBe('[aaa] [bbb] [ccc] [ddd]')
    expect(delta(doc)).toEqual([
      { insert: '[' },
      { insert: 'aaa]', attributes: { bold: true } },
      { insert: ' [' },
      { insert: 'bbb', attributes: { link: 'u' } },
      { insert: '] ' },
      { insert: '[ccc', attributes: { lead: true } },
      { insert: '] ' },
      { insert: '[ddd]', attributes: { wide: true } },
    ])
  })

  it('extend a received mark on the remote replica', () => {
    const a = paragraph(1n, 'bold')
    a.transact(me, (tx) => tx.textMark('p1', 'text', 0, 4, 'bold', true))
    const b = peer(a, 2n)
    b.transact(me, (tx) => tx.textInsert('p1', 'text', 4, 'er'))
    sync(a, b)
    expect(delta(a)).toEqual([{ insert: 'bolder', attributes: { bold: true } }])
  })

  it('unmark part of a range', () => {
    const doc = paragraph(1n, 'Hello world')
    doc.transact(me, (tx) => tx.textMark('p1', 'text', 0, 11, 'bold', true))
    doc.transact(me, (tx) => tx.textUnmark('p1', 'text', 3, 8, 'bold'))
    expect(delta(doc)).toEqual([{ insert: 'Hel', attributes: { bold: true } }, { insert: 'lo wo' }, { insert: 'rld', attributes: { bold: true } }])
    doc.transact(me, (tx) => tx.textUnmark('p1', 'text', 3, 8, 'italic'))
    expect(delta(doc)).toHaveLength(3)
  })

  it('converge after a concurrent unmark and insertion', () => {
    const a = paragraph(1n, 'Hello')
    a.transact(me, (tx) => tx.textMark('p1', 'text', 0, 5, 'bold', true))
    const b = peer(a, 2n)
    a.transact(me, (tx) => tx.textUnmark('p1', 'text', 0, 5, 'bold'))
    b.transact(me, (tx) => tx.textInsert('p1', 'text', 2, 'XY'))
    sync(a, b)
    expect(a.text('p1', 'text')).toBe('HeXYllo')
  })

  it('undo and redo a mark', () => {
    const doc = paragraph(1n, 'Hello')
    doc.transact(me, (tx) => tx.textMark('p1', 'text', 0, 5, 'bold', true))
    expect(doc.undo()).toBe(true)
    expect(delta(doc)).toEqual([{ insert: 'Hello' }])
    expect(doc.redo()).toBe(true)
    expect(delta(doc)).toEqual([{ insert: 'Hello', attributes: { bold: true } }])
  })

  it('check a mark in the transaction that typed the text against the pending length', () => {
    const doc = replica(1n)
    doc.transact(me, (tx) => {
      const para = tx.create('Para', {}, { id: 'p1' })
      tx.textInsert(para, 'text', 0, 'new')
      tx.textMark(para, 'text', 0, 3, 'italic', true)
      expect(reasonOf(() => tx.textMark(para, 'text', 0, 4, 'italic', true))).toBe('out-of-range')
    })
    expect(delta(doc)).toEqual([{ insert: 'new', attributes: { italic: true } }])
  })

  it('refuse undeclared keys, bad values, and bad ranges', () => {
    const doc = paragraph(1n, 'Hello')
    const before = doc.version()
    const refused = (f: (tx: Tx) => void) => reasonOf(() => doc.transact(me, f))
    expect(refused((tx) => tx.textMark('p1', 'text', 0, 2, 'color', 'red'))).toBe('invalid-value')
    expect(refused((tx) => tx.textMark('p1', 'plain', 0, 0, 'bold', true))).toBe('invalid-value')
    expect(refused((tx) => tx.textUnmark('p1', 'text', 0, 2, 'color'))).toBe('invalid-value')
    expect(refused((tx) => tx.textMark('p1', 'text', 0, 2, 'bold', null))).toBe('invalid-value')
    // JavaScript has no integers past 2^53 (2 ** 60 is a float, which Rust takes too); a __proto__ key is what both refuse.
    expect(refused((tx) => tx.textMark('p1', 'text', 0, 2, 'bold', JSON.parse('{"n": {"__proto__": 1}}')))).toBe('invalid-value')
    expect(refused((tx) => tx.textMark('p1', 'text', 0, 6, 'bold', true))).toBe('out-of-range')
    expect(refused((tx) => tx.textMark('p1', 'text', 4, 2, 'bold', true))).toBe('out-of-range')
    expect(refused((tx) => tx.textMark('p1', 'nope', 0, 2, 'bold', true))).toBe('unknown-field')
    try {
      doc.transact(me, (tx) => tx.textMark('p1', 'text', 0, 2, 'color', 'red'))
    } catch (error) {
      expect(error).toBeInstanceOf(KdmError)
      expect((error as KdmError).message).toContain('declares no mark `color`')
    }
    doc.transact(me, (tx) => tx.textMark('p1', 'text', 2, 2, 'bold', true))
    expect(doc.version().equals(before)).toBe(true)
  })

  it("leave a mark key only a newer schema declares out of an older reader's state", () => {
    const json = JSON.parse(crateFixture('marks-schema.json'))
    json.schemaVersion = 2
    json.types.Para.fields.text.marks.color = { expand: 'after' }
    const old = paragraph(1n, 'Hello')
    const newer = Replica.load(parseSchema(json), old.snapshot(), 2n)
    newer.transact(me, (tx) => tx.textMark('p1', 'text', 0, 5, 'color', 'red'))
    expect(newer.textDelta('p1', 'text')).toEqual([{ insert: 'Hello', attributes: { color: 'red' } }])
    old.importChanges(newer.exportChanges(old.version()))
    expect(delta(old)).toEqual([{ insert: 'Hello' }])
  })
})

describe('mark declarations', () => {
  const withField = (field: unknown) => parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: { f: field } } } })

  it('are taken by text fields with valid keys and one expand each', () => {
    const schema = withField({ kind: 'text', marks: { bold: { expand: 'after' }, link: { expand: 'none' } } })
    expect(schema.types.A.fields.f.marks?.link.expand).toBe('none')
    for (const bad of [
      { kind: 'string', marks: { bold: { expand: 'after' } } },
      { kind: 'text', marks: { 'a:b': { expand: 'after' } } },
      { kind: 'text', marks: { $bold: { expand: 'after' } } },
      { kind: 'text', marks: { '': { expand: 'after' } } },
      { kind: 'text', marks: JSON.parse('{"__proto__":{"expand":"after"}}') },
      { kind: 'text', marks: { bold: { expand: 'sideways' } } },
      { kind: 'text', marks: { bold: {} } },
      { kind: 'text', marks: { bold: { expand: 'after', color: 1 } } },
      { kind: 'text', marks: ['bold'] },
    ]) {
      expect(reasonOf(() => withField(bad))).toBe('schema')
    }
    const conflicting = {
      kdm: 1,
      kit: 'k',
      schemaVersion: 1,
      root: 'A',
      types: {
        A: { fields: { f: { kind: 'text', marks: { bold: { expand: 'after' } } } } },
        B: { fields: { g: { kind: 'text', marks: { bold: { expand: 'none' } } } } },
      },
    }
    expect(() => parseSchema(conflicting)).toThrow(/one expand/)
  })
})
