// A copy as a new document (`copyAsNewDocument`): the same content under a new permanent `docId`,
// with no history, for a template instantiated twice, a copied file, or the same bytes uploaded
// twice. The Rust crate's tests/new_document.rs tests the same.
import { describe, expect, it } from 'vitest'
import { newDocId, person, Replica, Version, type ObjectId } from '../src/index'
import { me, pageWithShape, reasonOf, testSchema } from './helpers'

/** Deleted text a copy must not carry: unique, with no repeated run, so the engine's compression keeps it as plain bytes. */
const DELETED_TEXT = 'zq7Wv-DELETED-k3Rx9-MARKER-p2Jm'
/** Text of an object deleted before the copy. */
const DELETED_OBJECT = 'hT4uB-GONE-OBJECT-n8Ls1-yC6e'

const contains = (haystack: Uint8Array, needle: string): boolean => Buffer.from(haystack).includes(Buffer.from(needle, 'utf8'))

/** The document's objects: its canonical state without `meta`, which names the document. */
const content = (replica: Replica): unknown => (replica.stateJson() as { objects: unknown }).objects

/** A document with history: a page, a shape with a blob and a label, a tree, deleted text and a deleted object. */
function source(): { source: Replica; page: ObjectId; shape: ObjectId } {
  const source = Replica.create(testSchema(), newDocId(), 1n)
  const { page, shape } = pageWithShape(source)
  source.transact(me, (tx) => {
    tx.set(shape, 'image', { hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', mime: 'image/png', size: 4 })
    tx.textInsert(shape, 'label', 0, 'kept label')
    tx.treeCreate(page, 'outline', null, shape)
  })
  source.transact(me, (tx) => tx.textInsert(shape, 'label', 4, DELETED_TEXT))
  const gone = source.transact(me, (tx) => {
    const gone = tx.create('Shape', { kind: 'ellipse', x: 1, y: 2 })
    tx.textInsert(gone, 'label', 0, DELETED_OBJECT)
    tx.listInsert(page, 'shapes', 1, gone)
    tx.treeCreate(page, 'outline', null, gone)
    return gone
  })
  source.transact(me, (tx) => tx.delete(gone))
  // The last change deletes the text, by the same actor the copy is made with below.
  source.transact(me, (tx) => tx.textDelete(shape, 'label', 4, DELETED_TEXT.length))
  expect(source.text(shape, 'label')).toBe('kept label')
  return { source, page, shape }
}

describe('a copy as a new document', () => {
  it('has a new docId and the same objects and content', () => {
    const { source: from, page, shape } = source()
    const id = newDocId()
    const copy = from.copyAsNewDocument(id, 1n)
    expect(copy.docId).toBe(id)
    expect(copy.docId).not.toBe(from.docId)
    expect(copy.actor).toBe(1n)
    expect(content(copy)).toEqual(content(from))
    const meta = { ...(from.stateJson() as { meta: Record<string, unknown> }).meta, docId: id }
    expect((copy.stateJson() as { meta: unknown }).meta).toEqual(meta)
    expect(copy.list(page, 'shapes')).toEqual(from.list(page, 'shapes'))
    expect(copy.get(shape, 'image')).toEqual(from.get(shape, 'image'))
    expect(copy.tree(page, 'outline').map((entry) => entry.node.id)).toEqual(from.tree(page, 'outline').map((entry) => entry.node.id))
    const loaded = Replica.load(testSchema(), copy.snapshot(), 5n)
    expect(loaded.docId).toBe(id)
    expect(loaded.stateText()).toBe(copy.stateText())
  })

  it('carries no history and no deleted content', () => {
    const { source: from } = source()
    const full = from.snapshot()
    expect(contains(full, DELETED_TEXT)).toBe(true)
    expect(contains(full, DELETED_OBJECT)).toBe(true)
    const copy = from.copyAsNewDocument(newDocId(), 1n)
    expect(copy.isShallow()).toBe(true)
    for (const bytes of [copy.snapshot(), copy.exportChanges(Version.empty())]) {
      expect(contains(bytes, DELETED_TEXT)).toBe(false)
      expect(contains(bytes, DELETED_OBJECT)).toBe(false)
      expect(contains(bytes, from.docId)).toBe(false)
    }
    expect(copy.version().includes(from.version())).toBe(true)
    expect(reasonOf(() => copy.forkAt(from.version(), 2n))).toBe('history-missing')
    expect(reasonOf(() => copy.changesSince(from.version()))).toBe('history-missing')
    expect(copy.fork(2n).docId).toBe(copy.docId)
  })

  it('starts with empty undo history', () => {
    const { source: from } = source()
    expect(from.canUndo()).toBe(true)
    const copy = from.copyAsNewDocument(newDocId(), 1n)
    expect(copy.canUndo() || copy.canRedo()).toBe(false)
    expect(copy.undo()).toBe(false)
    expect(content(copy)).toEqual(content(from))
  })

  it('and its source never take each other’s changes', () => {
    const { source: from, page, shape } = source()
    const copy = from.copyAsNewDocument(newDocId(), 2n)
    const base = copy.version()
    copy.transact(me, (tx) => tx.set(shape, 'x', 99))
    from.transact(me, (tx) => tx.set(page, 'title', 'source only'))
    const [fromText, copyText] = [from.stateText(), copy.stateText()]
    expect(reasonOf(() => from.importChanges(copy.exportChanges(base)))).toBe('wrong-document')
    expect(reasonOf(() => from.mergeChanges(copy.exportChanges(base), me))).toBe('wrong-document')
    expect(reasonOf(() => from.rebase(copy.snapshot()))).toBe('wrong-document')
    expect(reasonOf(() => copy.importChanges(from.exportChanges(Version.empty())))).toBe('wrong-document')
    expect(reasonOf(() => copy.mergeChanges(from.exportChanges(Version.empty()), me))).toBe('wrong-document')
    expect(reasonOf(() => copy.rebase(from.snapshot()))).toBe('wrong-document')
    const draft = from.fork(3n)
    expect(reasonOf(() => copy.mergeChanges(draft.exportChanges(Version.empty()), me))).toBe('wrong-document')
    expect([from.stateText(), copy.stateText()]).toEqual([fromText, copyText])
    expect(from.get(shape, 'x')).toBe(10)
    expect(copy.get(page, 'title')).toBe('One')
  })

  it('made twice from one source gives two documents that each co-edit', () => {
    const { source: from, shape } = source()
    const first = from.copyAsNewDocument(newDocId(), 1n)
    const second = from.copyAsNewDocument(newDocId(), 1n)
    expect(first.docId).not.toBe(second.docId)
    const a = Replica.load(testSchema(), first.snapshot(), 10n)
    const b = Replica.load(testSchema(), first.snapshot(), 11n)
    const other = Replica.load(testSchema(), second.snapshot(), 12n)
    a.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'A:'))
    b.transact(me, (tx) => tx.set(shape, 'y', 7))
    other.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'OTHER:'))
    b.importChanges(a.exportChanges(b.version()))
    a.importChanges(b.exportChanges(a.version()))
    expect(a.stateText()).toBe(b.stateText())
    expect(a.text(shape, 'label')).toBe('A:kept label')
    expect(reasonOf(() => other.importChanges(a.exportChanges(other.version())))).toBe('wrong-document')
    expect(other.text(shape, 'label')).toBe('OTHER:kept label')
    expect(other.get(shape, 'y')).toBe(20)
  })

  it('of a shallow replica, or of a copy, is a new document too', () => {
    const { source: from } = source()
    const shallow = Replica.load(testSchema(), from.shallowSnapshot(from.version()), 4n)
    const copy = shallow.copyAsNewDocument(newDocId(), 4n)
    const again = copy.copyAsNewDocument(newDocId(), 6n)
    expect(content(again)).toEqual(content(from))
    expect(again.docId).not.toBe(copy.docId)
    expect(Replica.load(testSchema(), again.snapshot(), 7n).docId).toBe(again.docId)
  })

  it('under the same docId is refused', () => {
    const { source: from } = source()
    expect(reasonOf(() => from.copyAsNewDocument(from.docId, 1n))).toBe('invalid-value')
  })

  it('records the writer’s schema version and takes new undo steps', () => {
    const { source: from } = source()
    const copy = from.copyAsNewDocument(newDocId(), 1n)
    expect(copy.authorSchemaVersion()).toBe(1)
    expect(copy.takeChanged().size).toBe(0)
    copy.transact(person('user:other'), (tx) => tx.create('Page', { title: 'new' }))
    expect(copy.canUndo()).toBe(true)
  })
})
