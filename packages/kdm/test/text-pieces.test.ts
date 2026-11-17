/**
 * Long text inserts go to the engine in pieces (the engine scans a text element on every edit
 * inside it), and the result reads as one insert. The Rust twin is
 * `crates/kition-kdm/tests/text_pieces.rs`.
 */
import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, person, Replica, system, type ObjectId } from '../src/index'
import { TEXT_PIECE } from '../src/op'

const schema = parseSchema({ kdm: 1, kit: 'kit.test-note', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' } } } } })
const me = person('user:test')

/** Two CJK ideographs ("quarter") and an emoji (a surrogate pair). */
const QUARTER = String.fromCodePoint(0x5b63, 0x5ea6)
const EMOJI = String.fromCodePoint(0x1f642)
const LINE = `Goals for the quarter ${QUARTER} ${EMOJI}\n`

const mixed = (units: number): string => LINE.repeat(Math.ceil(units / LINE.length))

function note(text: string): { replica: Replica; id: ObjectId } {
  const { replica, result } = Replica.createWith(schema, newDocId(), 1n, system('import'), (tx) => {
    const id = tx.create('Note', {})
    tx.textInsert(id, 'body', 0, text)
    return id
  })
  return { replica, id: result }
}

/** Milliseconds for `edits` one-character replacements at line starts, last first, in one transaction; the fastest of three. */
function editsMs(text: string, edits: number): number {
  const step = Math.floor(text.length / LINE.length / (edits + 1)) * LINE.length
  let best = Infinity
  for (let run = 0; run < 3; run += 1) {
    const { replica, id } = note(text)
    const start = performance.now()
    replica.transact(system('import'), (tx) => {
      for (let k = edits; k >= 1; k -= 1) {
        tx.textDelete(id, 'body', k * step, 1)
        tx.textInsert(id, 'body', k * step, 'x')
      }
    })
    best = Math.min(best, performance.now() - start)
  }
  return best
}

describe('long text inserts', () => {
  it('read as inserted, with a surrogate pair across a piece boundary, in the replica, its snapshot, and a peer', () => {
    const long = 'a'.repeat(TEXT_PIECE - 1) + EMOJI + mixed(5_000)
    const { replica, id } = note('[]')
    replica.transact(me, (tx) => tx.textInsert(id, 'body', 1, long))
    const expected = `[${long}]`
    expect(replica.text(id, 'body')).toBe(expected)
    expect(Replica.load(schema, replica.snapshot(), 2n).text(id, 'body')).toBe(expected)
    const peer = Replica.load(schema, replica.snapshot(), 3n)
    peer.importChanges(replica.exportChanges(peer.version()))
    expect(peer.stateJson()).toEqual(replica.stateJson())
  })

  it('undo as one step', () => {
    const long = mixed(4_000)
    const { replica, id } = note('')
    replica.transact(me, (tx) => tx.textInsert(id, 'body', 0, long))
    expect(replica.undo()).toBe(true)
    expect(replica.text(id, 'body')).toBe('')
    expect(replica.redo()).toBe(true)
    expect(replica.text(id, 'body')).toBe(long)
  })

  it('keep the cost of an edit independent of the size of the text', () => {
    // With the text in one element, an edit on 512 KB cost about 16 times one on 32 KB.
    const large = editsMs(mixed(512_000), 2_900) / 2_900
    const small = editsMs(mixed(32_000), 181) / 181
    expect(large / small).toBeLessThan(4)
  }, 60_000)
})
