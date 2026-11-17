/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree } from 'loro-crdt'
import { expect } from 'vitest'
import { KdmError, newDocId, parseSchema, person, Replica, system, uuidToBytes, type KdmErrorReason, type ObjectId, type Schema } from '../src/index'

/** The Rust crate's test files, shared so both implementations test one document shape. */
export const crateFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../crates/kition-kdm/tests/fixtures/${name}`, import.meta.url)), 'utf8')

export const testSchema = (): Schema => parseSchema(crateFixture('test-schema.json'))

/** The test schema's next version: a new `Note` type and a new `caption` text on `Shape`. */
export function schemaV2(): Schema {
  const json = JSON.parse(crateFixture('test-schema.json'))
  json.schemaVersion = 2
  json.types.Shape.fields.caption = { kind: 'text' }
  json.types.Note = { fields: { body: { kind: 'string' } } }
  return parseSchema(json)
}

export const me = person('user:test')

/** Creates a page and one shape in it. */
export function pageWithShape(replica: Replica): { page: ObjectId; shape: ObjectId } {
  return replica.transact(me, (tx) => {
    const page = tx.create('Page', { title: 'One' })
    const shape = tx.create('Shape', { kind: 'rect', x: 10, y: 20 })
    tx.listInsert(page, 'shapes', 0, shape)
    return { page, shape }
  })
}

/** The reason of the `KdmError` that `run` throws; fails the test if it throws nothing or something else. */
export function reasonOf(run: () => unknown): KdmErrorReason {
  try {
    run()
  } catch (error) {
    if (error instanceof KdmError) return error.reason
    throw error
  }
  expect.fail('expected a KdmError')
}

/** Wraps engine bytes the way the KDM exports them: magic, document UUID, engine bytes. */
export function envelope(docId: string, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + bytes.length)
  out.set([0x4b, 0x44, 0x4d, 0x01])
  out.set(uuidToBytes(docId), 4)
  out.set(bytes, 20)
  return out
}

/** An engine document with the `meta` of an empty `kit.test` document. */
function rawDoc(kdm: number, schemaVersion: number): { doc: LoroDoc; docId: string } {
  const doc = new LoroDoc()
  const docId = newDocId()
  const meta = doc.getMap('meta')
  meta.set('docId', docId)
  meta.set('kit', 'kit.test')
  meta.set('schemaVersion', schemaVersion)
  meta.set('kdm', kdm)
  return { doc, docId }
}

const snapshotOf = (doc: LoroDoc, docId: string) => {
  doc.commit()
  return envelope(docId, doc.export({ mode: 'snapshot' }))
}

/** A snapshot of an empty `kit.test` document written directly with the engine. */
export function rawSnapshot(kdm: number, schemaVersion: number): Uint8Array {
  const { doc, docId } = rawDoc(kdm, schemaVersion)
  return snapshotOf(doc, docId)
}

/** A shape `s` and a page `p` written with the engine; `shapes` gets the given items. */
function rawPage(shapes: unknown[]): { doc: LoroDoc; docId: string; page: LoroMap } {
  const { doc, docId } = rawDoc(1, 1)
  const objects = doc.getMap('objects')
  const shape = objects.setContainer('s', new LoroMap())
  shape.set('$type', 'Shape')
  shape.set('kind', 'rect')
  shape.set('x', 1)
  shape.set('y', 2)
  shape.setContainer('label', new LoroText())
  const page = objects.setContainer('p', new LoroMap())
  page.set('$type', 'Page')
  page.set('title', 'T')
  const list = page.setContainer('shapes', new LoroMovableList())
  shapes.forEach((item, index) => list.insert(index, item as string))
  return { doc, docId, page }
}

/**
 * A page whose outline holds a node without an object (with a child) next to a normal node:
 * written directly with the engine, as no KDM operation can produce it.
 */
export function pageWithAnObjectlessNode(): Uint8Array {
  const { doc, docId, page } = rawPage([])
  const tree = page.setContainer('outline', new LoroTree())
  const bare = tree.createNode()
  bare.createNode().data.set('object', 's')
  tree.createNode().data.set('object', 's')
  return snapshotOf(doc, docId)
}

/** A page whose `shapes` list holds the shape id and a number. */
export function pageWithACorruptList(): Uint8Array {
  const { doc, docId, page } = rawPage(['s', 5])
  page.setContainer('outline', new LoroTree())
  return snapshotOf(doc, docId)
}

/**
 * The document of the TypeScript-made fixture `crates/kition-kdm/tests/fixtures/ts-page.{bin,json}`:
 * awkward numbers, non-ASCII and astral keys, emoji text, a lone surrogate, and moved tree nodes.
 */
export function tsPage(): Replica {
  const doc = Replica.create(testSchema(), '01920000-0000-7000-8000-0000000000aa', 3n)
  doc.transact(me, (tx) => {
    const page = tx.create('Page', { title: 'TS 页面 "quoted"\n\u0001 a\ud800' })
    const a = tx.create('Shape', {
      kind: 'rect',
      x: 1e16,
      y: 9.1e15,
      fill: '#fff',
      transform: { z: 0.000001, a: [1.5e300, -0, 0.1 + 0.2, 1e-7, 123456.789, 2 ** 53, -(2 ** 53)], n: null, '😀': 1, '￿': 2, 键: '値' },
    })
    const b = tx.create('Shape', { kind: 'ellipse', x: -0, y: 0.00001, image: { hash: 'ab', mime: 'image/png', size: 3 } })
    tx.listInsert(page, 'shapes', 0, a)
    tx.listInsert(page, 'shapes', 0, b)
    tx.listMove(page, 'shapes', 0, 1)
    tx.textInsert(a, 'label', 0, 'a😀b季')
    tx.textDelete(a, 'label', 0, 1)
    const first = tx.treeCreate(page, 'outline', null, a)
    const second = tx.treeCreate(page, 'outline', null, b)
    const child = tx.treeCreate(page, 'outline', first, b)
    tx.treeCreate(page, 'outline', first, a)
    tx.treeMove(page, 'outline', second, child)
    tx.treeMove(page, 'outline', child, null)
  })
  return doc
}

/**
 * A shallow snapshot (standard 2.0 rule M16a) of `tsPage` with more edits after its root, as the
 * Rust crate reads it in `tests/cross_language.rs`.
 */
export function tsShallow(): { replica: Replica; bytes: Uint8Array } {
  const doc = tsPage()
  const root = doc.version()
  doc.objectsOfType('Shape').forEach((shape, step) => {
    doc.transact(me, (tx) => {
      tx.textInsert(shape, 'label', 0, `after root ${step} `)
      tx.set(shape, 'x', step)
    })
  })
  const [page] = doc.objectsOfType('Page')
  doc.transact(me, (tx) => tx.set(page, 'title', 'Shallow page'))
  return { replica: doc, bytes: doc.shallowSnapshot(root) }
}

/** The holder of `id` among the objects of `parent`: the first whose list or ref field of `ty` holds it. */
function holder(replica: Replica, parent: string, ty: string, id: ObjectId): ObjectId | null {
  const fields = replica.schema.types[parent].fields
  for (const owner of replica.objectsOfType(parent)) {
    for (const field of Object.keys(fields).sort()) {
      if (fields[field].of !== ty) continue
      const held = fields[field].kind === 'list' ? replica.list(owner, field) : []
      if (held.includes(id) || (fields[field].kind === 'ref' && replica.get(owner, field) === id)) return owner
    }
  }
  return null
}

/** As the Rust `testing::number_tool_ids`: a kit numbering what has no number, per type and holder. */
export function numberToolIds(replica: Replica): void {
  const numbered = new Map<ObjectId, number>()
  for (const ty of Object.keys(replica.schema.types).sort()) {
    const tool = replica.schema.types[ty].toolId
    if (!tool) continue
    const objects = replica.objectsOfType(ty)
    const scope = (id: ObjectId) => (tool.parent === undefined ? null : holder(replica, tool.parent, ty, id))
    const mine: Array<[ObjectId, number]> = []
    for (const id of objects) {
      if (replica.get(id, tool.field) !== null || numbered.has(id)) continue
      const at = scope(id)
      let highest = 0
      for (const other of objects) {
        if (scope(other) !== at) continue
        const value = replica.get(other, tool.field)
        const n = typeof value === 'number' ? value : numbered.get(other)
        if (n !== undefined && n > highest) highest = n
      }
      numbered.set(id, highest + 1)
      mine.push([id, highest + 1])
    }
    if (mine.length > 0) replica.transact(system('number'), (tx) => mine.forEach(([id, n]) => tx.set(id, tool.field, n)))
  }
}
