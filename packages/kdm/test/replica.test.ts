import { LoroText } from 'loro-crdt'
import { canonical } from '../src/canonical'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, KdmError, newDocId, newObjectId, NodeRef, parseSchema, Replica, Rng, system, Version, type KdmErrorReason, type ObjectId, type Tx } from '../src/index'
import {
  envelope,
  me,
  pageWithACorruptList,
  pageWithAnObjectlessNode,
  pageWithShape,
  rawSnapshot,
  reasonOf,
  schemaV2,
  testSchema,
} from './helpers'

const replica = () => Replica.create(testSchema(), newDocId(), 1n)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Replica', () => {
  it('creates, reads, and updates objects', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    expect(doc.objectType(shape)).toBe('Shape')
    expect(doc.get(shape, 'x')).toBe(10)
    expect(doc.list(page, 'shapes')).toEqual([shape])
    doc.transact(me, (tx) => tx.set(shape, 'fill', '#5645d4'))
    expect(doc.get(shape, 'fill')).toBe('#5645d4')
    expect(doc.objectsOfType('Shape')).toEqual([shape])
  })

  it('lists the objects of a type in code point order, without deleted ones or other types', () => {
    const doc = replica()
    doc.transact(me, (tx) => {
      for (const id of ['b', 'B', 'a', 'gone']) tx.create('Shape', { kind: 'rect', x: 1, y: 2 }, { id })
      tx.create('Page', { title: 'One' }, { id: 'A' })
    })
    doc.transact(me, (tx) => tx.delete('gone'))
    expect(doc.objectsOfType('Shape')).toEqual(['B', 'a', 'b'])
    expect(doc.objectsOfType('Page')).toEqual(['A'])
    expect(doc.objectsOfType('Nope')).toEqual([])
  })

  it('rejects invalid values and missing required fields', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    expect(() => doc.transact(me, (tx) => tx.set(shape, 'kind', 'star'))).toThrow(/takes one of `rect`, `ellipse`, not `star`/)
    expect(() => doc.transact(me, (tx) => tx.create('Shape', { kind: 'rect', x: 1 }))).toThrow(/`y`.*required/)
    expect(reasonOf(() => doc.transact(me, (tx) => tx.create('Nope', {})))).toBe('unknown-type')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.set(shape, 'nope', 1)))).toBe('unknown-field')
  })

  it('leaves no trace of a failed transaction, and undo skips it', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const before = doc.stateText()
    expect(() =>
      doc.transact(me, (tx) => {
        tx.set(shape, 'x', 99)
        tx.textInsert(shape, 'label', 0, 'partial')
        tx.set(shape, 'kind', 'star')
      }),
    ).toThrow(KdmError)
    expect(doc.stateText()).toBe(before)
    expect(doc.undo()).toBe(true)
    expect(doc.exists(shape)).toBe(false)
  })

  it('edits text in UTF-16 code units', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, '季度😀回顾'))
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 4, '!'))
    expect(doc.text(shape, 'label')).toBe('季度😀!回顾')
    expect(doc.textLength(shape, 'label')).toBe(7)
    doc.transact(me, (tx) => tx.textDelete(shape, 'label', 2, 3))
    expect(doc.text(shape, 'label')).toBe('季度回顾')
    const error = (() => {
      try {
        doc.transact(me, (tx) => tx.textInsert(shape, 'label', 10, 'x'))
      } catch (caught) {
        return caught as KdmError
      }
    })()
    expect(error?.reason).toBe('out-of-range')
    expect(error?.message).toBe('index 10 is out of range (length 4)')
  })

  it('rejects a position inside a surrogate pair while validating, in committed and pending text', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'a😀b'))
    const insertSpy = vi.spyOn(LoroText.prototype, 'insert')
    doc.transact(me, (tx) => {
      // Each refusal comes from validation: the operation throws at once and the transaction goes on.
      expect(() => tx.textInsert(shape, 'label', 2, 'x')).toThrow(/splits a character/)
      expect(reasonOf(() => tx.textDelete(shape, 'label', 0, 2))).toBe('out-of-range')
      expect(reasonOf(() => tx.textDelete(shape, 'label', 2, 1))).toBe('out-of-range')
      expect(insertSpy).not.toHaveBeenCalled()
      tx.textInsert(shape, 'label', 1, '季😀')
      // `a季😀😀b`: positions 3 and 5 split a pair, pending or committed.
      expect(reasonOf(() => tx.textInsert(shape, 'label', 3, 'x'))).toBe('out-of-range')
      expect(reasonOf(() => tx.textInsert(shape, 'label', 5, 'x'))).toBe('out-of-range')
      tx.textInsert(shape, 'label', 4, '|')
      tx.textDelete(shape, 'label', 0, 1)
      expect(tx.text(shape, 'label')).toBe('季😀|😀b')
      expect(reasonOf(() => tx.textDelete(shape, 'label', 4, 1))).toBe('out-of-range')
    })
    expect(doc.text(shape, 'label')).toBe('季😀|😀b')
    // A new object's text is all pending.
    doc.transact(me, (tx) => {
      const fresh = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
      tx.textInsert(fresh, 'label', 0, '😀😀')
      expect(reasonOf(() => tx.textInsert(fresh, 'label', 1, 'x'))).toBe('out-of-range')
      expect(reasonOf(() => tx.textInsert(fresh, 'label', 3, 'x'))).toBe('out-of-range')
      tx.textInsert(fresh, 'label', 2, 'x')
      expect(tx.text(fresh, 'label')).toBe('😀x😀')
    })
  })

  it('validates thousands of edits of a large CJK and emoji text in one transaction quickly, refusing surrogate splits', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const line = 'Paragraph 😀 with 季度 words, 👍 and more words here.\n'
    const base = line.repeat(Math.ceil(1_000_000 / line.length))
    // Built from pieces of 64 lines (about 3.5 KB) inserted last first, which the engine keeps
    // apart: one insertion of it all makes each later engine edit scan the whole text, which is
    // not what this measures.
    const piece = 64 * line.length
    doc.transact(me, (tx) => {
      for (let end = base.length; end > 0; end -= piece) tx.textInsert(shape, 'label', 0, base.slice(Math.max(0, end - piece), end))
    })
    const isLow = (text: string, at: number) => at > 0 && at < text.length && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff
    // 5,000 edits in order, as a merge applies them: each replaces up to two code points (never half of one).
    const rng = new Rng(5)
    const edits: { from: number; to: number; insert: string }[] = []
    for (let at = rng.below(150); edits.length < 5_000 && at < base.length - 4; at += 2 + rng.below(380)) {
      const from = isLow(base, at) ? at + 1 : at
      let to = from
      for (let count = rng.below(3); count > 0; count -= 1) to += base.codePointAt(to)! > 0xffff ? 2 : 1
      edits.push({ from, to, insert: ['', 'Z', '季😀'][rng.below(3)] })
      at = to
    }
    let expected = ''
    let last = 0
    for (const edit of edits) {
      expected += base.slice(last, edit.from) + edit.insert
      last = edit.to
    }
    expected += base.slice(last)
    const started = performance.now()
    let validated = 0
    doc.transact(me, (tx) => {
      let shift = 0
      for (const edit of edits) {
        const at = edit.from + shift
        if (edit.to > edit.from) tx.textDelete(shape, 'label', at, edit.to - edit.from)
        if (edit.insert) tx.textInsert(shape, 'label', at, edit.insert)
        shift += edit.insert.length - (edit.to - edit.from)
      }
      // Positions inside a pair are refused, in pending and committed text, wherever they are.
      let refused = 0
      for (let probe = 0; probe < 2_000; probe += 1) {
        const at = rng.below(expected.length)
        if (isLow(expected, at)) {
          expect(reasonOf(() => tx.textInsert(shape, 'label', at, 'x'))).toBe('out-of-range')
          expect(reasonOf(() => tx.textDelete(shape, 'label', at - 1, 1))).toBe('out-of-range')
          refused += 1
        }
      }
      expect(refused).toBeGreaterThan(50)
      expect(tx.textLength(shape, 'label')).toBe(expected.length)
      validated = performance.now() - started
    })
    const elapsed = performance.now() - started
    console.info(
      `${edits.length} edits of a ${(base.length / 1e6).toFixed(2)} MB CJK and emoji text in one transaction: ${elapsed.toFixed(0)} ms (validating ${validated.toFixed(0)} ms, the engine applying them the rest)`,
    )
    expect(doc.text(shape, 'label') === expected).toBe(true)
    // Generous, so a loaded machine does not fail it: before, validating alone took about 40 s.
    expect(validated).toBeLessThan(5_000)
  }, 120_000)

  it('stores a lone surrogate as the engine does, so later positions stay valid', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => {
      tx.textInsert(shape, 'label', 0, '\ud83d')
      tx.textInsert(shape, 'label', 1, '\ude00')
      expect(tx.textLength(shape, 'label')).toBe(2)
    })
    expect(doc.text(shape, 'label')).toBe('\ufffd\ufffd')
  })

  it('moves and removes list items', () => {
    const doc = replica()
    const { page, shape: a } = pageWithShape(doc)
    const b = doc.transact(me, (tx) => {
      const b = tx.create('Shape', { kind: 'ellipse', x: 0, y: 0 })
      tx.listInsert(page, 'shapes', 1, b)
      tx.listMove(page, 'shapes', 1, 0)
      return b
    })
    expect(doc.list(page, 'shapes')).toEqual([b, a])
    doc.transact(me, (tx) => tx.listRemove(page, 'shapes', 0))
    expect(doc.list(page, 'shapes')).toEqual([a])
  })

  it('builds trees and refuses cycles', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const { parent, child } = doc.transact(me, (tx) => {
      const parent = tx.treeCreate(page, 'outline', null, shape)
      return { parent, child: tx.treeCreate(page, 'outline', parent, shape) }
    })
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeMove(page, 'outline', parent, child)))).toBe('cycle')
    const entries = doc.tree(page, 'outline')
    expect(entries).toHaveLength(2)
    expect(entries[0].parent).toBeNull()
    expect(entries[1].parent?.equals(parent)).toBe(true)
    expect(entries[1].node.equals(child)).toBe(true)
  })

  it('reloads a snapshot to the same state and refuses another kit', () => {
    const doc = replica()
    pageWithShape(doc)
    const reloaded = Replica.load(testSchema(), doc.snapshot(), 2n)
    expect(reloaded.stateText()).toBe(doc.stateText())
    expect(reloaded.docId).toBe(doc.docId)
    const other = parseSchema({ kdm: 1, kit: 'kit.other', schemaVersion: 1, root: 'A', types: { A: { fields: {} } } })
    expect(() => Replica.load(other, doc.snapshot(), 3n)).toThrow(/belongs to/)
    expect(reasonOf(() => Replica.load(other, doc.snapshot(), 3n))).toBe('schema')
  })

  it('refuses a bad document id or actor', () => {
    expect(reasonOf(() => Replica.create(testSchema(), 'not a uuid', 1n))).toBe('encoding')
    expect(reasonOf(() => Replica.create(testSchema(), newDocId(), (1n << 64n) - 1n))).toBe('encoding')
    const upper = newDocId().toUpperCase()
    expect(Replica.create(testSchema(), upper, 1n).docId).toBe(upper.toLowerCase())
  })

  it('deletes objects', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(agent('user:test'), (tx) => tx.delete(shape))
    expect(doc.exists(shape)).toBe(false)
    expect(reasonOf(() => doc.get(shape, 'x'))).toBe('not-found')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.delete(shape)))).toBe('not-found')
  })

  it('reports the objects a transaction changed, and none for a failed one', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    expect([...doc.takeChanged()]).toEqual([page, shape].sort())
    expect(() => doc.transact(me, (tx) => tx.set(shape, 'kind', 'star'))).toThrow()
    expect(doc.takeChanged().size).toBe(0)
  })

  it('writes bulk content at creation outside undo history', () => {
    const { replica: doc, result: page } = Replica.createWith(testSchema(), newDocId(), 1n, { kind: 'import', principal: 'user:test' }, (tx) =>
      tx.create('Page', { title: 'Imported' }),
    )
    expect(doc.get(page, 'title')).toBe('Imported')
    expect(doc.undo()).toBe(false)
    expect(doc.exists(page)).toBe(true)
  })

  it('stages creation too: a failed build writes nothing', () => {
    expect(
      reasonOf(() =>
        Replica.createWith(testSchema(), newDocId(), 1n, me, (tx) => {
          tx.create('Page', { title: 'x' })
          tx.create('Shape', { kind: 'star', x: 0, y: 0 })
        }),
      ),
    ).toBe('invalid-value')
  })

  it('changes neither the version nor the exports when a transaction fails', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const snapshot = doc.snapshot()
    const before = doc.version()
    const failing = () =>
      doc.transact(me, (tx) => {
        tx.set(shape, 'x', 99)
        tx.textInsert(shape, 'label', 0, 'partial')
        tx.listRemove(page, 'shapes', 0)
        tx.delete(shape)
        tx.set(page, 'title', 1)
      })
    expect(reasonOf(failing)).toBe('invalid-value')
    expect(doc.version().equals(before)).toBe(true)
    expect(doc.version()).toEqual(before)
    const bytes = doc.exportChanges(before)
    const fresh = Replica.load(testSchema(), snapshot, 2n)
    const freshState = fresh.stateText()
    expect(fresh.importChanges(bytes).size).toBe(0)
    expect(fresh.version().equals(before)).toBe(true)
    expect(fresh.stateText()).toBe(freshState)
  })

  it('lets reads inside a transaction see its pending effects', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    doc.transact(me, (tx) => {
      const created = tx.create('Shape', { kind: 'ellipse', x: 1, y: 2 })
      expect(tx.exists(created)).toBe(true)
      expect(tx.get(created, 'x')).toBe(1)
      expect(tx.get(created, 'fill')).toBeNull()
      expect(tx.textLength(created, 'label')).toBe(0)
      tx.listInsert(page, 'shapes', 0, created)
      expect(tx.listItems(page, 'shapes')).toEqual([created, shape])
      tx.listMove(page, 'shapes', 0, 1)
      expect(tx.list(page, 'shapes')).toEqual([shape, created])
      tx.listRemove(page, 'shapes', 0)
      expect(tx.list(page, 'shapes')).toEqual([created])
      tx.textInsert(shape, 'label', 0, '季度😀')
      expect(tx.textLength(shape, 'label')).toBe(4)
      tx.textDelete(shape, 'label', 0, 1)
      expect(tx.textLength(shape, 'label')).toBe(3)
      expect(tx.text(shape, 'label')).toBe('度😀')
      tx.set(shape, 'x', 42)
      expect(tx.get(shape, 'x')).toBe(42)
      tx.set(shape, 'transform', { b: 1, a: [2] })
      expect(tx.get(shape, 'transform')).toEqual({ a: [2], b: 1 })
      tx.delete(shape)
      expect(tx.exists(shape)).toBe(false)
      expect(reasonOf(() => tx.get(shape, 'x'))).toBe('not-found')
      // Nothing reaches the document while the transaction runs.
      expect(doc.exists(created)).toBe(false)
      expect(doc.get(shape, 'x')).toBe(10)
    })
    expect(doc.exists(shape)).toBe(false)
    expect(doc.list(page, 'shapes')).toHaveLength(1)
  })

  it('refuses a cycle formed only by moves inside one transaction and leaves nothing', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const [a, b] = doc.transact(me, (tx) => [tx.treeCreate(page, 'outline', null, shape), tx.treeCreate(page, 'outline', null, shape)])
    const before = doc.version()
    expect(
      reasonOf(() =>
        doc.transact(me, (tx) => {
          tx.treeMove(page, 'outline', a, b)
          tx.treeMove(page, 'outline', b, a)
        }),
      ),
    ).toBe('cycle')
    expect(doc.version().equals(before)).toBe(true)
    expect(
      reasonOf(() =>
        doc.transact(me, (tx) => {
          const c = tx.treeCreate(page, 'outline', null, shape)
          const d = tx.treeCreate(page, 'outline', c, shape)
          tx.treeMove(page, 'outline', c, d)
        }),
      ),
    ).toBe('cycle')
    expect(doc.version().equals(before)).toBe(true)
    expect(doc.tree(page, 'outline')).toHaveLength(2)
  })

  it('resolves node handles when their transaction commits', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const [a, b] = doc.transact(me, (tx) => {
      const a = tx.treeCreate(page, 'outline', null, shape)
      const b = tx.treeCreate(page, 'outline', null, shape)
      expect(a.equals(a)).toBe(true)
      expect(a.equals(b)).toBe(false)
      expect(a.id).toBeNull()
      tx.treeMove(page, 'outline', b, a)
      return [a, b]
    })
    expect(a.id).not.toBeNull()
    const nodes = doc.tree(page, 'outline')
    expect(nodes).toHaveLength(2)
    expect(nodes[0].node.equals(a)).toBe(true)
    expect(nodes[1].node.equals(b)).toBe(true)
    expect(nodes[1].parent?.equals(a)).toBe(true)
    expect(nodes[1].parent).toEqual(a)
  })

  it('refuses a node handle from a failed transaction', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    let leaked: NodeRef | undefined
    expect(
      reasonOf(() =>
        doc.transact(me, (tx) => {
          leaked = tx.treeCreate(page, 'outline', null, shape)
          tx.treeMove(page, 'outline', leaked, leaked)
        }),
      ),
    ).toBe('cycle')
    const node = leaked as NodeRef
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeMove(page, 'outline', node, null)))).toBe('not-found')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeCreate(page, 'outline', node, shape)))).toBe('not-found')
    expect(doc.tree(page, 'outline')).toEqual([])
  })

  it('lets a transaction continue after a failed operation, which changed nothing', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    doc.transact(me, (tx) => {
      expect(reasonOf(() => tx.listInsert(page, 'shapes', 5, shape))).toBe('out-of-range')
      expect(reasonOf(() => tx.textDelete(shape, 'label', 0, 1))).toBe('out-of-range')
      tx.textInsert(shape, 'label', 0, 'ok')
    })
    expect(doc.list(page, 'shapes')).toEqual([shape])
    expect(doc.text(shape, 'label')).toBe('ok')
  })

  it('refuses operations on a transaction that has ended, and nested transactions', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    let kept: Tx | undefined
    doc.transact(me, (tx) => {
      kept = tx
      expect(reasonOf(() => doc.transact(me, () => undefined))).toBe('engine')
    })
    expect(reasonOf(() => kept?.set(shape, 'x', 1))).toBe('engine')
  })

  it('reports what undo and redo change', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.set(shape, 'x', 55))
    doc.takeChanged()
    expect(doc.undo()).toBe(true)
    expect(doc.get(shape, 'x')).toBe(10)
    expect([...doc.takeChanged()]).toEqual([shape])
    expect(doc.redo()).toBe(true)
    expect(doc.get(shape, 'x')).toBe(55)
    expect([...doc.takeChanged()]).toEqual([shape])
  })

  it('lists tree nodes parent first, in sibling order, across two roots', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const [a, a1, b, b1] = doc.transact(me, (tx) => {
      const a = tx.treeCreate(page, 'outline', null, shape)
      const b = tx.treeCreate(page, 'outline', null, shape)
      const a1 = tx.treeCreate(page, 'outline', a, shape)
      const b1 = tx.treeCreate(page, 'outline', b, shape)
      return [a, a1, b, b1]
    })
    const entries = doc.tree(page, 'outline')
    expect(entries.map((entry) => entry.node)).toEqual([a, a1, b, b1])
    expect(entries.map((entry) => entry.parent)).toEqual([null, a, null, b])
    expect(entries.every((entry) => entry.object === shape)).toBe(true)
  })

  it('skips a tree node without an object, with its subtree', () => {
    const doc = Replica.load(testSchema(), pageWithAnObjectlessNode(), 2n)
    const entries = doc.tree('p', 'outline')
    expect(entries).toHaveLength(1)
    expect(entries[0].object).toBe('s')
    expect(entries[0].parent).toBeNull()
    expect((doc.stateJson() as { objects: Record<string, { outline: unknown }> }).objects.p.outline).toEqual([{ children: [], object: 's' }])
  })

  it('refuses a text deletion past the end', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'abc'))
    expect(reasonOf(() => doc.transact(me, (tx) => tx.textDelete(shape, 'label', 1, Number.MAX_SAFE_INTEGER)))).toBe('out-of-range')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.textDelete(shape, 'label', -1, 1)))).toBe('out-of-range')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0.5, 'x')))).toBe('out-of-range')
    expect(doc.text(shape, 'label')).toBe('abc')
  })

  it('gives the state with every key in canonical order, as deep copies', () => {
    const doc = replica()
    doc.transact(me, (tx) => {
      const page = tx.create('Page', { title: 'One' }, { id: 'p' })
      for (const id of ['b', 'B', '10', '9', 'a_1', 'a-1', 'a:1']) {
        tx.create('Shape', { kind: 'rect', x: 1, y: 2, transform: { z: 1, a: [{ y: 2, b: 1 }], M: null } }, { id })
        tx.listInsert(page, 'shapes', 0, id)
      }
      tx.treeCreate(page, 'outline', null, 'b')
      tx.textInsert('b', 'label', 0, 'Bee')
      const sheet = tx.create('Sheet', {}, { id: 'sheet' })
      tx.mapSet(sheet, 'cells', 'z', { q: 1, c: 2 })
      tx.mapSet(sheet, 'cells', 'A1', 3)
      tx.mapSet(sheet, 'cells', 'a\u{1f600}', 4)
      tx.mapSet(sheet, 'cells', 'a\uffff', 5)
    })
    const state = doc.stateJson()
    // `canonical` sorts every key; JSON text follows key order.
    expect(JSON.stringify(state)).toBe(JSON.stringify(canonical(state)))
    const { objects } = state as { objects: Record<string, { cells?: object }> }
    expect(Object.keys(objects)).toEqual(['9', '10', 'B', 'a-1', 'a:1', 'a_1', 'b', 'p', 'sheet'])
    expect(Object.keys(objects.sheet.cells ?? {})).toEqual(['A1', 'a\uffff', 'a\u{1f600}', 'z'])
    const again = doc.stateJson() as { objects: Record<string, { transform: { z: number } }> }
    again.objects.b.transform.z = 99
    expect((doc.stateJson() as typeof again).objects.b.transform.z).toBe(1)
  })

  it('records the KDM version next to the schema version', () => {
    const state = replica().stateJson() as { meta: Record<string, unknown> }
    expect(state.meta.kdm).toBe(1)
    expect(state.meta.schemaVersion).toBe(1)
  })

  it('refuses another KDM version and a newer schema', () => {
    expect(() => Replica.load(testSchema(), rawSnapshot(1, 1), 5n)).not.toThrow()
    expect(reasonOf(() => Replica.load(testSchema(), rawSnapshot(2, 1), 5n))).toBe('schema')
    const newer = Replica.create(schemaV2(), newDocId(), 1n)
    expect(() => Replica.load(testSchema(), newer.snapshot(), 5n)).toThrow(/schema version 2/)
    expect(reasonOf(() => Replica.load(testSchema(), newer.snapshot(), 5n))).toBe('newer-schema')
    expect(() => Replica.load(schemaV2(), replica().snapshot(), 5n)).not.toThrow()
  })

  it('reads types and fields from other schema versions', () => {
    const old = replica()
    const { shape } = pageWithShape(old)
    const next = Replica.load(schemaV2(), old.snapshot(), 2n)
    // An object written before `caption` existed reads it as empty; writing it is refused.
    expect(next.text(shape, 'caption')).toBe('')
    expect((next.stateJson() as { objects: Record<string, Record<string, unknown>> }).objects[shape].caption).toBe('')
    expect(reasonOf(() => next.transact(me, (tx) => tx.textInsert(shape, 'caption', 0, 'x')))).toBe('not-found')
    expect(next.transact(me, (tx) => tx.textLength(shape, 'caption'))).toBe(0)
    // A type the older schema does not declare reads as its type only.
    const note = next.transact(me, (tx) => tx.create('Note', { body: 'hi' }))
    old.importChanges(next.exportChanges(old.version()))
    expect((old.stateJson() as { objects: Record<string, unknown> }).objects[note]).toEqual({ $type: 'Note' })
    expect(old.objectType(note)).toBe('Note')
    expect(reasonOf(() => old.get(note, 'body'))).toBe('unknown-type')
  })

  it('reports malformed bytes as encoding errors', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const snapshot = doc.snapshot()
    expect([...snapshot.subarray(0, 4)]).toEqual([0x4b, 0x44, 0x4d, 0x01])
    const wrongMagic = snapshot.slice()
    wrongMagic[3] = 2
    for (const bytes of [new TextEncoder().encode('garbage'), new Uint8Array(), snapshot.slice(20), snapshot.slice(0, 10), wrongMagic]) {
      expect(reasonOf(() => Replica.load(testSchema(), bytes, 5n))).toBe('encoding')
      const before = doc.version()
      expect(reasonOf(() => doc.importChanges(bytes))).toBe('encoding')
      expect(doc.version().equals(before)).toBe(true)
    }
    expect(doc.exists(shape)).toBe(true)
  })

  it('refuses bytes labelled as another document', () => {
    const doc = replica()
    pageWithShape(doc)
    const engineBytes = doc.snapshot().slice(20)
    expect(() => Replica.load(testSchema(), envelope(newDocId(), engineBytes), 5n)).toThrow(/labelled as document/)
    expect(reasonOf(() => Replica.load(testSchema(), envelope(newDocId(), engineBytes), 5n))).toBe('encoding')
  })

  it('refuses another document’s changes and changes nothing', () => {
    const first = replica()
    pageWithShape(first)
    const second = replica()
    const { shape: otherShape } = pageWithShape(second)
    const before = [first.version(), first.stateText()] as const
    expect(reasonOf(() => first.importChanges(second.exportChanges(Version.empty())))).toBe('wrong-document')
    expect(first.version().equals(before[0])).toBe(true)
    expect(first.stateText()).toBe(before[1])
    expect(first.exists(otherShape)).toBe(false)
  })

  it('says a changes-only export is not a snapshot', () => {
    const doc = replica()
    const since = doc.version()
    pageWithShape(doc)
    expect(() => Replica.load(testSchema(), doc.exportChanges(since), 5n)).toThrow(/not a snapshot/)
    expect(reasonOf(() => Replica.load(testSchema(), doc.exportChanges(since), 5n))).toBe('encoding')
  })

  it('round-trips versions through their encoding', () => {
    const doc = replica()
    pageWithShape(doc)
    const version = doc.version()
    expect(Version.decode(version.encode()).equals(version)).toBe(true)
    expect(Version.empty().equals(version)).toBe(false)
    expect(reasonOf(() => Version.decode(new Uint8Array([9, 9, 9])))).toBe('encoding')
  })

  it('refuses an existing target of another type in references, lists, and trees', () => {
    const schema = parseSchema({
      kdm: 1,
      kit: 'kit.of',
      schemaVersion: 1,
      root: 'A',
      types: {
        A: { fields: { r: { kind: 'ref', of: 'B', optional: true }, l: { kind: 'list', of: 'B' }, t: { kind: 'tree', of: 'B' } } },
        B: { fields: {} },
      },
    })
    const doc = Replica.create(schema, newDocId(), 1n)
    const { a, b, other } = doc.transact(me, (tx) => {
      const b = tx.create('B', {})
      const other = tx.create('A', {})
      const a = tx.create('A', { r: b })
      return { a, b, other }
    })
    expect(reasonOf(() => doc.transact(me, (tx) => tx.set(a, 'r', other)))).toBe('invalid-value')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.create('A', { r: other })))).toBe('invalid-value')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.listInsert(a, 'l', 0, other)))).toBe('invalid-value')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeCreate(a, 't', null, other)))).toBe('invalid-value')
    // An object created earlier in the same transaction is checked too.
    expect(reasonOf(() => doc.transact(me, (tx) => tx.listInsert(a, 'l', 0, tx.create('A', {}))))).toBe('invalid-value')
    // Matching and missing targets are accepted: a dangling reference is a validation state.
    const missing = newObjectId()
    doc.transact(me, (tx) => {
      tx.set(a, 'r', missing)
      tx.listInsert(a, 'l', 0, b)
      tx.listInsert(a, 'l', 1, missing)
      tx.treeCreate(a, 't', null, b)
      tx.treeCreate(a, 't', null, missing)
    })
    expect(doc.list(a, 'l')).toEqual([b, missing])
  })

  it('reports a list item that is not an id, and keeps the engine’s indices', () => {
    const doc = Replica.load(testSchema(), pageWithACorruptList(), 2n)
    expect(reasonOf(() => doc.list('p', 'shapes'))).toBe('encoding')
    expect(reasonOf(() => doc.stateJson())).toBe('encoding')
    expect(() => doc.transact(me, (tx) => tx.listInsert('p', 'shapes', 3, 's'))).toThrow('index 3 is out of range (length 2)')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.listItems('p', 'shapes')))).toBe('encoding')
    // Validation counts the engine's items, so an index past the bad item lands where asked.
    doc.transact(me, (tx) => tx.listInsert('p', 'shapes', 2, 's'))
    doc.transact(me, (tx) => tx.listRemove('p', 'shapes', 1))
    expect(doc.list('p', 'shapes')).toEqual(['s', 's'])
  })

  for (const observe of [true, false]) {
    it(`ends list edits where a plain array model does (${observe ? 'read back mid-transaction' : 'never read back'})`, () => {
      for (let seed = 0; seed < 20; seed += 1) {
        const doc = replica()
        const { page } = pageWithShape(doc)
        const rng = new Rng(seed)
        const model = doc.transact(me, (tx) => {
          const model: ObjectId[] = tx.listItems(page, 'shapes')
          for (let step = 0; step < 60; step += 1) {
            const length = model.length
            const pick = rng.below(3)
            if (pick === 0) {
              const shape = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
              const at = rng.below(length + 1)
              tx.listInsert(page, 'shapes', at, shape)
              model.splice(at, 0, shape)
            } else if (pick === 1 && length > 0) {
              const from = rng.below(length)
              const to = rng.below(length)
              tx.listMove(page, 'shapes', from, to)
              model.splice(to, 0, ...model.splice(from, 1))
            } else if (length > 0) {
              const at = rng.below(length)
              tx.listRemove(page, 'shapes', at)
              model.splice(at, 1)
            }
            if (observe && rng.below(3) === 0) expect(tx.listItems(page, 'shapes'), `seed ${seed}`).toEqual(model)
            expect(() => tx.listInsert(page, 'shapes', model.length + 1, page)).toThrow(KdmError)
          }
          return model
        })
        expect(doc.list(page, 'shapes'), `seed ${seed}`).toEqual(model)
      }
    })
  }

  it('validates random text edits like a plain string model, in committed and pending text', () => {
    const pieces = ['a', '😀', '季', '\ud800', 'x😀y', '\udc00z', '😀😀', '']
    const wellFormed = (text: string): string => (text as unknown as { toWellFormed(): string }).toWellFormed()
    const splits = (text: string, at: number) => at > 0 && at < text.length && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff
    for (let seed = 0; seed < 30; seed += 1) {
      const doc = replica()
      const { shape } = pageWithShape(doc)
      const rng = new Rng(seed)
      let committed = ''
      for (let round = 0; round < 6; round += 1) {
        const fail = rng.below(4) === 0
        let model = committed
        const run = () =>
          doc.transact(me, (tx) => {
            for (let step = 0; step < 25; step += 1) {
              const length = model.length
              if (rng.below(3) > 0) {
                const at = rng.below(length + 3)
                const piece = pieces[rng.below(pieces.length)]
                if (at > length || splits(model, at)) {
                  expect(reasonOf(() => tx.textInsert(shape, 'label', at, piece)), `seed ${seed}`).toBe('out-of-range')
                } else {
                  tx.textInsert(shape, 'label', at, piece)
                  model = model.slice(0, at) + wellFormed(piece) + model.slice(at)
                }
              } else {
                const at = rng.below(length + 2)
                const count = rng.below(4)
                if (at + count > length || splits(model, at) || splits(model, at + count)) {
                  expect(reasonOf(() => tx.textDelete(shape, 'label', at, count)), `seed ${seed}`).toBe('out-of-range')
                } else {
                  tx.textDelete(shape, 'label', at, count)
                  model = model.slice(0, at) + model.slice(at + count)
                }
              }
              expect(tx.textLength(shape, 'label'), `seed ${seed}`).toBe(model.length)
              if (rng.below(4) === 0) expect(tx.text(shape, 'label'), `seed ${seed}`).toBe(model)
            }
            if (fail) tx.set(shape, 'kind', 'star')
          })
        if (fail) expect(reasonOf(run)).toBe('invalid-value')
        else {
          run()
          committed = model
        }
        expect(doc.text(shape, 'label'), `seed ${seed} round ${round}`).toBe(committed)
      }
    }
  })

  it('sees earlier moves of the same transaction when checking for cycles', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const [a, b, c] = doc.transact(me, (tx) => {
      const a = tx.treeCreate(page, 'outline', null, shape)
      const b = tx.treeCreate(page, 'outline', a, shape)
      return [a, b, tx.treeCreate(page, 'outline', b, shape)]
    })
    doc.transact(me, (tx) => {
      // In the committed tree `a` is an ancestor of `c`; after this move it no longer is.
      tx.treeMove(page, 'outline', c, null)
      tx.treeMove(page, 'outline', a, c)
      expect(reasonOf(() => tx.treeMove(page, 'outline', c, b))).toBe('cycle')
      const d = tx.treeCreate(page, 'outline', b, shape)
      expect(reasonOf(() => tx.treeMove(page, 'outline', c, d))).toBe('cycle')
      tx.treeMove(page, 'outline', d, null)
    })
    const entries = doc.tree(page, 'outline')
    const parentOf = (node: NodeRef) => entries.find((entry) => entry.node.equals(node))?.parent
    expect(parentOf(c)).toBeNull()
    expect(parentOf(a)?.equals(c)).toBe(true)
    expect(parentOf(b)?.equals(a)).toBe(true)
    expect(entries).toHaveLength(4)
  })

  it('refuses a node of another tree field', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const other = doc.transact(me, (tx) => tx.create('Page', { title: 'Two' }))
    const node = doc.transact(me, (tx) => tx.treeCreate(page, 'outline', null, shape))
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeMove(other, 'outline', node, null)))).toBe('not-found')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.treeCreate(other, 'outline', node, shape)))).toBe('not-found')
    expect(
      reasonOf(() =>
        doc.transact(me, (tx) => {
          const pending = tx.treeCreate(page, 'outline', null, shape)
          tx.treeCreate(other, 'outline', pending, shape)
        }),
      ),
    ).toBe('not-found')
  })

  it('tells text subscribers about local and imported changes as they happen', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const peer = Replica.load(testSchema(), doc.snapshot(), 2n)
    const seen: Array<[unknown, boolean]> = []
    const unsubscribe = doc.subscribeText(shape, 'label', (delta, local) => seen.push([delta, local]))
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'ab'))
    expect(seen).toEqual([[[{ insert: 'ab' }], true]])
    peer.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'X'))
    doc.importChanges(peer.exportChanges(doc.version()))
    expect(seen).toHaveLength(2)
    expect(seen[1][1]).toBe(false)
    expect(JSON.stringify(seen[1][0])).toContain('"insert":"X"')
    unsubscribe()
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'z'))
    expect(seen).toHaveLength(2)
  })

  it('reverts an engine failure while applying, out of undo history', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.takeChanged()
    vi.spyOn(LoroText.prototype, 'insert').mockImplementationOnce(() => {
      throw new Error('forced failure')
    })
    let error: unknown
    try {
      doc.transact(me, (tx) => {
        tx.set(shape, 'x', 99)
        tx.textInsert(shape, 'label', 0, 'partial')
        tx.set(shape, 'y', 5)
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(KdmError)
    expect((error as KdmError).reason).toBe('engine')
    expect((error as KdmError).message).toMatch(/forced failure/)
    expect(doc.get(shape, 'x')).toBe(10)
    expect(doc.get(shape, 'y')).toBe(20)
    expect(doc.text(shape, 'label')).toBe('')
    expect(doc.takeChanged().size).toBe(0)
    // The partial commit and its reversal are not undo steps: undo reverts the creation.
    expect(doc.undo()).toBe(true)
    expect(doc.exists(shape)).toBe(false)
  })

  it('refuses values that are not JSON before anything is staged', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const sheet = parseSchema({ kdm: 1, kit: 'kit.map', schemaVersion: 1, root: 'S', types: { S: { fields: { cells: { kind: 'map' } } } } })
    const cells = Replica.create(sheet, newDocId(), 1n)
    const row = cells.transact(me, (tx) => tx.create('S', {}))
    class Point {
      x = 1
    }
    const cycle: Record<string, unknown> = { a: 1 }
    cycle.self = cycle
    const notJson: unknown[] = [
      1n,
      { a: 1n },
      Number.NaN,
      [Number.POSITIVE_INFINITY],
      new Uint8Array([1]),
      new Date(0),
      new Map(),
      new Point(),
      () => 1,
      Symbol('s'),
      cycle,
      JSON.parse('{"__proto__": 1}'),
      [undefined],
      { a: undefined },
      // eslint-disable-next-line no-sparse-arrays
      [1, , 2],
    ]
    const before = doc.version()
    for (const value of notJson) {
      const label = String(typeof value === 'symbol' ? 'symbol' : value)
      expect(reasonOf(() => doc.transact(me, (tx) => tx.set(shape, 'transform', value))), label).toBe('invalid-value')
      expect(reasonOf(() => doc.transact(me, (tx) => tx.create('Shape', { kind: 'rect', x: 0, y: 0, transform: value }))), label).toBe('invalid-value')
      expect(reasonOf(() => doc.transact(me, (tx) => tx.set(shape, 'image', { hash: 'a', mime: 'b', size: 1, extra: value }))), label).toBe('invalid-value')
      expect(reasonOf(() => cells.transact(me, (tx) => tx.mapSet(row, 'cells', 'k', value))), label).toBe('invalid-value')
    }
    expect(reasonOf(() => doc.transact(me, (tx) => tx.set(shape, 'x', Number.NaN)))).toBe('invalid-value')
    expect(doc.version().equals(before)).toBe(true)
    expect(cells.mapGet(row, 'cells', 'k')).toBeNull()
    // Plain objects with a null prototype, and whole numbers beyond ±2^53 (doubles), are JSON.
    const bare = Object.assign(Object.create(null), { a: 1 })
    doc.transact(me, (tx) => tx.set(shape, 'transform', { bare, big: 1e16, list: [1, 'x', null, true] }))
    expect(doc.get(shape, 'transform')).toEqual({ bare: { a: 1 }, big: 1e16, list: [1, 'x', null, true] })
    expect(doc.list(page, 'shapes')).toEqual([shape])
  })

  it('copies values when staging them, so later mutation changes nothing', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const transform = { a: [1], b: { c: 'x' } }
    doc.transact(me, (tx) => {
      tx.set(shape, 'transform', transform)
      transform.a.push(2)
      transform.b.c = 'y'
      expect(tx.get(shape, 'transform')).toEqual({ a: [1], b: { c: 'x' } })
    })
    expect(doc.get(shape, 'transform')).toEqual({ a: [1], b: { c: 'x' } })
  })

  it('stores lone surrogates in values as the engine does, so pending and committed reads agree', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const pending = doc.transact(me, (tx) => {
      tx.set(shape, 'fill', 'a\ud800b')
      tx.set(shape, 'transform', { ['k\udc00']: ['\ud83d'] })
      return [tx.get(shape, 'fill'), tx.get(shape, 'transform')]
    })
    expect(pending).toEqual(['a\ufffdb', { 'k\ufffd': ['\ufffd'] }])
    expect([doc.get(shape, 'fill'), doc.get(shape, 'transform')]).toEqual(pending)
  })

  it('keeps types, fields, and map keys named __proto__', () => {
    const schema = parseSchema(
      '{"kdm":1,"kit":"kit.proto","schemaVersion":1,"root":"__proto__","types":{"__proto__":{"fields":{"__proto__":{"kind":"string"},"cells":{"kind":"map"}}}}}',
    )
    expect(Object.keys(schema.types)).toEqual(['__proto__'])
    expect(Object.keys(schema.types.__proto__.fields)).toEqual(['__proto__', 'cells'])
    const doc = Replica.create(schema, newDocId(), 1n)
    const id = doc.transact(me, (tx) => {
      const id = tx.create('__proto__', { ['__proto__']: 'x' })
      tx.mapSet(id, 'cells', '__proto__', { a: 1 })
      tx.mapSet(id, 'cells', 'b', 2)
      expect(tx.get(id, '__proto__')).toBe('x')
      return id
    })
    expect(doc.objectType(id)).toBe('__proto__')
    expect(doc.get(id, '__proto__')).toBe('x')
    expect(doc.mapGet(id, 'cells', '__proto__')).toEqual({ a: 1 })
    expect(doc.stateText()).toContain(`"${id}":{"$type":"__proto__","__proto__":"x","cells":{"__proto__":{"a":1},"b":2}}`)
    const state = doc.stateJson() as { objects: Record<string, Record<string, unknown>> }
    expect(Object.keys(state.objects[id])).toEqual(['$type', '__proto__', 'cells'])
    expect(Object.getPrototypeOf(state.objects[id])).toBe(Object.prototype)
    doc.transact(me, (tx) => tx.mapSet(id, 'cells', '__proto__', 3))
    expect(doc.stateText()).toContain('"cells":{"__proto__":3,"b":2}')
  })

  it('reports the first invalid field in code point order, as Rust does', () => {
    const schema = parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: { '\uffff': { kind: 'string' }, '😀': { kind: 'string' } } } } })
    const doc = Replica.create(schema, newDocId(), 1n)
    expect(() => doc.transact(me, (tx) => tx.create('A', { '😀': 1, '\uffff': 1 }))).toThrow('field `\uffff` of `A`')
    expect(() => doc.transact(me, (tx) => tx.create('A', {}))).toThrow('field `\uffff` of `A` is required')
    expect(() =>
      parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: { '😀': { kind: 'string', values: ['x'] }, '\uffff': { kind: 'string', of: 'A' } } } } }),
    ).toThrow('`A.\uffff`: only ref, list, and tree fields take `of`')
  })

  it('cannot be handed a forged or tampered node handle', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    const node = doc.transact(me, (tx) => tx.treeCreate(page, 'outline', null, shape))
    const real = doc.tree(page, 'outline')[0].node
    const Constructor = NodeRef as unknown as new (id: string) => NodeRef
    expect(() => new Constructor(real.id as string)).toThrow()
    const forged = [{ id: real.id }, Object.assign(Object.create(NodeRef.prototype), { id: real.id }), { id: '#0' }, { id: 'p:0' }] as NodeRef[]
    for (const fake of forged) {
      expect(reasonOf(() => doc.transact(me, (tx) => tx.treeMove(page, 'outline', fake, null)))).toBe('not-found')
      expect(reasonOf(() => doc.transact(me, (tx) => tx.treeCreate(page, 'outline', fake, shape)))).toBe('not-found')
    }
    expect(() => {
      ;(real as { id: string | null }).id = 'x'
    }).toThrow(TypeError)
    expect(real.id).toBe(node.id)
    expect('resolve' in node).toBe(false)
    doc.transact(me, (tx) => tx.treeMove(page, 'outline', real, null))
  })

  it('reads map fields and tolerates registers it never wrote', () => {
    const schema = parseSchema({
      kdm: 1,
      kit: 'kit.map',
      schemaVersion: 1,
      root: 'S',
      types: { S: { fields: { cells: { kind: 'map' }, note: { kind: 'string', optional: true } } } },
    })
    const doc = Replica.create(schema, newDocId(), 1n)
    const sheet = doc.transact(me, (tx) => {
      const sheet = tx.create('S', {})
      tx.mapSet(sheet, 'cells', 'a', { v: 1, f: '=1' })
      tx.mapSet(sheet, 'cells', 'b', 2)
      tx.mapDelete(sheet, 'cells', 'b')
      return sheet
    })
    expect(doc.mapGet(sheet, 'cells', 'a')).toEqual({ f: '=1', v: 1 })
    expect(doc.mapGet(sheet, 'cells', 'b')).toBeNull()
    expect(doc.get(sheet, 'note')).toBeNull()
    expect(reasonOf(() => doc.get(sheet, 'cells'))).toBe('invalid-value')
    expect(reasonOf(() => doc.text(sheet, 'cells'))).toBe('invalid-value')
    expect(doc.stateText()).toContain('"cells":{"a":{"f":"=1","v":1}},"note":null')
  })

  it('checks argument types at run time, before anything is staged', () => {
    const doc = replica()
    const { page, shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.treeCreate(page, 'outline', null, shape))
    const sheet = Replica.create(
      parseSchema({ kdm: 1, kit: 'kit.map', schemaVersion: 1, root: 'S', types: { S: { fields: { cells: { kind: 'map' } } } } }),
      newDocId(),
      1n,
    )
    const row = sheet.transact(me, (tx) => tx.create('S', {}))
    const untyped = (value: unknown) => value as never
    const node = doc.tree(page, 'outline')[0].node
    const cases: Array<[string, KdmErrorReason, Replica, (tx: Tx) => unknown]> = [
      ['list item', 'invalid-value', doc, (tx) => tx.listInsert(page, 'shapes', 0, untyped(5))],
      ['tree object', 'invalid-value', doc, (tx) => tx.treeCreate(page, 'outline', null, untyped(7))],
      ['text content', 'invalid-value', doc, (tx) => tx.textInsert(shape, 'label', 0, untyped(42))],
      ['map key', 'invalid-value', sheet, (tx) => tx.mapSet(row, 'cells', untyped(5), 1)],
      ['map key to delete', 'invalid-value', sheet, (tx) => tx.mapDelete(row, 'cells', untyped(5))],
      ['null fields', 'invalid-value', doc, (tx) => tx.create('Page', untyped(null))],
      ['array fields', 'invalid-value', doc, (tx) => tx.create('Page', untyped([]))],
      ['class fields', 'invalid-value', doc, (tx) => tx.create('Page', untyped(new Map([['title', 'x']])))],
      ['type name', 'invalid-value', doc, (tx) => tx.create(untyped(1), { title: 'x' })],
      ['object id', 'invalid-value', doc, (tx) => tx.set(untyped(1), 'x', 1)],
      ['field name', 'invalid-value', doc, (tx) => tx.set(shape, untyped(Symbol('x')), 1)],
      ['id to read', 'invalid-value', doc, (tx) => tx.get(untyped(null), 'x')],
      ['id to test', 'invalid-value', doc, (tx) => tx.exists(untyped({}))],
      ['id to delete', 'invalid-value', doc, (tx) => tx.delete(untyped(1))],
      ['list field', 'invalid-value', doc, (tx) => tx.listItems(page, untyped(0))],
      ['text field', 'invalid-value', doc, (tx) => tx.text(shape, untyped(undefined))],
      ['fractional index', 'out-of-range', doc, (tx) => tx.listInsert(page, 'shapes', 0.5, shape)],
      ['string index', 'out-of-range', doc, (tx) => tx.textInsert(shape, 'label', untyped('0'), 'a')],
      ['negative count', 'out-of-range', doc, (tx) => tx.textDelete(shape, 'label', 0, -1)],
      ['symbol index', 'out-of-range', doc, (tx) => tx.listMove(page, 'shapes', untyped(Symbol('i')), 0)],
      ['NaN index', 'out-of-range', doc, (tx) => tx.listRemove(page, 'shapes', Number.NaN)],
      ['bigint index', 'out-of-range', doc, (tx) => tx.listInsert(page, 'shapes', untyped(0n), shape)],
      ['falsy parent', 'not-found', doc, (tx) => tx.treeMove(page, 'outline', node, untyped(0))],
    ]
    for (const [label, reason, target, run] of cases) {
      const before = target.version()
      expect(reasonOf(() => target.transact(me, run)), label).toBe(reason)
      expect(target.version().equals(before), label).toBe(true)
    }
    const before = doc.version()
    const origins = [{ kind: 'robot', principal: 'x' }, { kind: 'person' }, { kind: 'person', principal: 1 }, { kind: 'person', principal: 'x', label: 5 }, null, 'person']
    for (const origin of origins) {
      expect(reasonOf(() => doc.transact(untyped(origin), (tx) => tx.set(shape, 'x', 2))), JSON.stringify(origin)).toBe('invalid-value')
      expect(reasonOf(() => Replica.createWith(testSchema(), newDocId(), 1n, untyped(origin), () => undefined))).toBe('invalid-value')
    }
    expect(reasonOf(() => doc.transact(me, untyped(null)))).toBe('invalid-value')
    expect(doc.version().equals(before)).toBe(true)
    expect(doc.get(shape, 'x')).toBe(10)
    // Replica reads check their arguments as well.
    expect(reasonOf(() => doc.exists(untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => doc.objectType(untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => doc.get(shape, untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => doc.text(untyped(1), 'label'))).toBe('invalid-value')
    expect(reasonOf(() => doc.textLength(shape, untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => doc.list(untyped(1), 'shapes'))).toBe('invalid-value')
    expect(reasonOf(() => doc.tree(page, untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => doc.objectsOfType(untyped(1)))).toBe('invalid-value')
    expect(reasonOf(() => sheet.mapGet(row, 'cells', untyped(5)))).toBe('invalid-value')
    expect(reasonOf(() => doc.subscribeText(shape, untyped(1), () => undefined))).toBe('invalid-value')
    expect(reasonOf(() => doc.exportChanges(untyped({})))).toBe('invalid-value')
    expect(reasonOf(() => doc.importChanges(untyped(null)))).toBe('encoding')
    expect(reasonOf(() => Replica.load(testSchema(), untyped('bytes'), 2n))).toBe('encoding')
    expect(reasonOf(() => Replica.create(testSchema(), untyped(5), 2n))).toBe('encoding')
    expect(reasonOf(() => Replica.create(testSchema(), newDocId(), untyped(2)))).toBe('encoding')
  })

  it('normalises lone surrogates in map keys it deletes, as in keys it sets', () => {
    const sheet = Replica.create(
      parseSchema({ kdm: 1, kit: 'kit.map', schemaVersion: 1, root: 'S', types: { S: { fields: { cells: { kind: 'map' } } } } }),
      newDocId(),
      1n,
    )
    const row = sheet.transact(me, (tx) => {
      const row = tx.create('S', {})
      tx.mapSet(row, 'cells', 'k\ud800', 1)
      return row
    })
    expect(sheet.mapGet(row, 'cells', 'k�')).toBe(1)
    sheet.transact(me, (tx) => tx.mapDelete(row, 'cells', 'k\ud800'))
    expect(sheet.mapGet(row, 'cells', 'k�')).toBeNull()
  })
})

describe('KDM additions for hosts', () => {
  it('creates an object under a caller id and refuses a taken or malformed one', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    const id = doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, { id: 'page:main' }))
    expect(id).toBe('page:main')
    expect(doc.get('page:main', 'title')).toBe('A')
    const before = doc.version()
    expect(() => doc.transact(me, (tx) => tx.create('Page', { title: 'B' }, { id: 'page:main' }))).toThrow(KdmError)
    expect(() => doc.transact(me, (tx) => tx.create('Page', { title: 'B' }, { id: 'bad id!' }))).toThrow(/invalid-value|object id/)
    expect(doc.version().equals(before)).toBe(true)
  })

  it('refuses the same caller id twice in one transaction', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    expect(() =>
      doc.transact(me, (tx) => {
        tx.create('Page', { title: 'A' }, { id: 'p1' })
        tx.create('Page', { title: 'B' }, { id: 'p1' })
      }),
    ).toThrow(KdmError)
    expect(doc.exists('p1')).toBe(false)
  })

  it('checks caller ids against the pattern and the transaction, with the same messages as Rust', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const create = (id: unknown) => () => doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, { id: id as string }))
    expect(create('bad id!')).toThrow('field `$id` of `Page` cannot be `bad id!`: an object id matches `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`')
    expect(create(shape)).toThrow(`field \`$id\` of \`Page\` cannot be \`${shape}\`: that object id is taken`)
    for (const bad of ['', '-a', ':a', 'a b', 'a/b', 'é', 'a'.repeat(129)]) expect(reasonOf(create(bad))).toBe('invalid-value')
    for (const good of ['a', '0', 'A:b_c-d', 'a'.repeat(128)]) expect(doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, { id: good }))).toBe(good)
    // An id deleted in the same transaction is still taken there.
    expect(reasonOf(() => doc.transact(me, (tx) => {
      tx.delete(shape)
      tx.create('Shape', { kind: 'rect', x: 1, y: 2 }, { id: shape })
    }))).toBe('invalid-value')
    expect(doc.get(shape, 'x')).toBe(10)
    expect(reasonOf(create(5))).toBe('invalid-value')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, 'p' as never)))).toBe('invalid-value')
    expect(reasonOf(() => doc.transact(me, (tx) => tx.create('Page', {}, { id: 'p2' })))).toBe('invalid-value')
    expect(doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, {}))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  })

  it('reports undo availability', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    expect(doc.canUndo()).toBe(false)
    pageWithShape(doc)
    expect(doc.canUndo()).toBe(true)
    doc.undo()
    expect(doc.canRedo()).toBe(true)
    doc.clearRedo()
    expect(doc.canRedo()).toBe(false)
  })

  it('does not make system transactions undo steps', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    const { shape } = pageWithShape(doc)
    doc.undo()
    expect(doc.canUndo()).toBe(false)
    const { shape: repaired } = doc.transact(system('repair'), (tx) => {
      const page = tx.create('Page', { title: 'Two' })
      const made = tx.create('Shape', { kind: 'rect', x: 1, y: 2 })
      tx.listInsert(page, 'shapes', 0, made)
      return { shape: made }
    })
    expect(doc.canUndo()).toBe(false)
    expect(doc.exists(shape)).toBe(false)

    doc.transact(me, (tx) => tx.set(repaired, 'x', 5))
    doc.transact(system('migrate'), (tx) => tx.set(repaired, 'y', 9))
    expect(doc.undo()).toBe(true)
    expect(doc.get(repaired, 'x')).toBe(1)
    expect(doc.get(repaired, 'y')).toBe(9)
    expect(doc.canUndo()).toBe(false)
  })

  it('does not make import transactions undo steps', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    const { shape } = pageWithShape(doc)
    const imported = { kind: 'import' as const, principal: 'file' }
    doc.transact(me, (tx) => tx.set(shape, 'x', 5))
    doc.transact(imported, (tx) => tx.set(shape, 'y', 9))
    expect(doc.undo()).toBe(true)
    expect(doc.get(shape, 'x')).toBe(10)
    expect(doc.get(shape, 'y')).toBe(9)
    // The only step left is the person's creation of the shape; the import is never one.
    expect(doc.undo()).toBe(true)
    expect(doc.exists(shape)).toBe(false)
    expect(doc.canUndo()).toBe(false)
  })

  it('undoes a group of transactions as one step', () => {
    const doc = Replica.create(testSchema(), newDocId(), 1n)
    const { shape } = pageWithShape(doc)
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    doc.transact(me, (tx) => tx.set(shape, 'y', 2))
    doc.endUndoGroup()
    expect(doc.undo()).toBe(true)
    expect(doc.get(shape, 'x')).toBe(10)
    expect(doc.get(shape, 'y')).toBe(20)
    expect(() => {
      doc.beginUndoGroup()
      doc.beginUndoGroup()
    }).toThrow(KdmError)
    doc.endUndoGroup()
  })

  it('undo while grouping ends the group and reverts it as one step', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    doc.transact(me, (tx) => tx.set(shape, 'y', 2))
    doc.transact(me, (tx) => tx.set(shape, 'fill', '#000'))
    expect(doc.undo()).toBe(true)
    expect([doc.get(shape, 'x'), doc.get(shape, 'y'), doc.get(shape, 'fill')]).toEqual([10, 20, null])
    doc.clearRedo()
    expect(() => doc.beginUndoGroup()).not.toThrow()
    doc.endUndoGroup()
    expect(doc.exists(shape)).toBe(true)
  })

  it('redo while grouping ends the group first', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    expect(doc.undo()).toBe(true)
    doc.beginUndoGroup()
    expect(doc.redo()).toBe(true)
    expect(doc.get(shape, 'x')).toBe(1)
    doc.transact(me, (tx) => tx.set(shape, 'y', 2))
    expect(doc.undo()).toBe(true)
    expect([doc.get(shape, 'x'), doc.get(shape, 'y')]).toEqual([1, 20])
    expect(() => doc.beginUndoGroup()).not.toThrow()
    doc.endUndoGroup()
  })

  it('an import that changes what the group changed keeps the group one undo step (M12b)', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const other = Replica.load(testSchema(), doc.snapshot(), 2n)
    const since = other.version()
    other.transact(me, (tx) => tx.set(shape, 'fill', '#111'))
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    doc.importChanges(other.exportChanges(since))
    doc.transact(me, (tx) => tx.set(shape, 'y', 2))
    doc.transact(me, (tx) => tx.set(shape, 'kind', 'ellipse'))
    doc.endUndoGroup()
    const state = () => [doc.get(shape, 'x'), doc.get(shape, 'y'), doc.get(shape, 'kind'), doc.get(shape, 'fill')]
    expect(doc.undo()).toBe(true)
    expect(state()).toEqual([10, 20, 'rect', '#111'])
    expect(doc.canUndo()).toBe(true)
    // Redo puts the whole group back as one step too, keeping the other replica's change.
    expect(doc.redo()).toBe(true)
    expect(state()).toEqual([1, 2, 'ellipse', '#111'])
    expect(doc.undo()).toBe(true)
    expect(state()).toEqual([10, 20, 'rect', '#111'])
    expect(() => doc.beginUndoGroup()).not.toThrow()
    doc.endUndoGroup()
  })

  it('a typing run with another replica`s edit of the same text inside undoes as one step (M12b)', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'Note: '))
    const other = Replica.load(testSchema(), doc.snapshot(), 2n)
    const since = other.version()
    other.transact(me, (tx) => tx.textInsert(shape, 'label', 0, '[them] '))
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', doc.textLength(shape, 'label'), 'h'))
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', doc.textLength(shape, 'label'), 'e'))
    doc.importChanges(other.exportChanges(since))
    doc.transact(me, (tx) => tx.textInsert(shape, 'label', doc.textLength(shape, 'label'), 'y'))
    doc.endUndoGroup()
    expect(doc.text(shape, 'label')).toBe('[them] Note: hey')
    expect(doc.undo()).toBe(true)
    expect(doc.text(shape, 'label')).toBe('[them] Note: ')
    expect(doc.redo()).toBe(true)
    expect(doc.text(shape, 'label')).toBe('[them] Note: hey')
  })

  it('two groups stay two undo steps, and an agent`s steps stay out of the person`s run (M12b)', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const other = Replica.load(testSchema(), doc.snapshot(), 2n)
    let since = other.version()
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    other.transact(me, (tx) => tx.set(shape, 'fill', '#222'))
    doc.importChanges(other.exportChanges(since))
    since = other.version()
    doc.transact(agent('user:test'), (tx) => tx.set(shape, 'kind', 'ellipse'))
    doc.transact(me, (tx) => tx.set(shape, 'x', 2))
    doc.endUndoGroup()
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'y', 5))
    doc.endUndoGroup()
    expect(doc.undo()).toBe(true)
    expect([doc.get(shape, 'x'), doc.get(shape, 'y')]).toEqual([2, 20])
    expect(doc.undo()).toBe(true)
    // The person's run is back; the agent's step and the other replica's change stay.
    expect([doc.get(shape, 'x'), doc.get(shape, 'y'), doc.get(shape, 'fill'), doc.get(shape, 'kind')]).toEqual([10, 20, '#222', 'ellipse'])
    expect(doc.undoIn('agent')).toBe(true)
    expect(doc.get(shape, 'kind')).toBe('rect')
  })

  it('an import that leaves the group alone keeps the group one undo step', () => {
    const doc = replica()
    const { shape } = pageWithShape(doc)
    const other = Replica.load(testSchema(), doc.snapshot(), 2n)
    const since = other.version()
    const page = other.transact(me, (tx) => tx.create('Page', { title: 'Theirs' }))
    doc.beginUndoGroup()
    doc.transact(me, (tx) => tx.set(shape, 'x', 1))
    doc.importChanges(other.exportChanges(since))
    doc.transact(me, (tx) => tx.set(shape, 'y', 2))
    doc.endUndoGroup()
    expect(doc.undo()).toBe(true)
    expect([doc.get(shape, 'x'), doc.get(shape, 'y'), doc.exists(page)]).toEqual([10, 20, true])
    expect(() => doc.beginUndoGroup()).not.toThrow()
    doc.endUndoGroup()
  })

  it('accepts only an id among the create options', () => {
    const doc = replica()
    expect(reasonOf(() => doc.transact(me, (tx) => tx.create('Page', { title: 'A' }, { id: 'p', parent: 'x' } as never)))).toBe('invalid-value')
    expect(doc.exists('p')).toBe(false)
  })

  it('refuses undo bookkeeping while a transaction runs', () => {
    const doc = replica()
    for (const call of [() => doc.canUndo(), () => doc.canRedo(), () => doc.beginUndoGroup(), () => doc.endUndoGroup(), () => doc.clearRedo()]) {
      expect(reasonOf(() => doc.transact(me, () => call()))).toBe('engine')
    }
  })
})
