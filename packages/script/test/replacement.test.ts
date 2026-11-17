import { parseSchema, person, Replica, Version } from '@kition/kdm'
import { expect, it } from 'vitest'
import { Exchange } from '../src/exchange'
import { ReplicaModel } from '../../kit-editor/src/engine/kitModelRunner'
import type { KitModuleDocument } from '../../kit-editor/src/engine/kitModule'

const schema = { kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Board', types: { Board: { fields: { title: { kind: 'string' } } } } }

it('both exchanges follow a new document and discard the old replica history', async () => {
  for (const editor of [false, true]) {
    let generation = 0
    const fresh = () => {
      generation += 1
      const doc = Replica.create(parseSchema(schema), `01920000-0000-7000-8000-${String(generation).padStart(12, '0')}`, BigInt(generation))
      doc.transact(person('mock'), (tx) => tx.create('Board', { title: 'New' }, { id: 'board' }))
      return doc
    }
    let current = fresh()
    const exportChanges = (since: Uint8Array) => current.exportChanges(since.byteLength ? Version.decode(since) : Version.empty())
    const importChanges = (bytes: Uint8Array) => { current.importChanges(bytes); return '{}' }
    const command = () => { current = fresh(); return {} }
    const runner = editor ? new ReplicaModel({ exportChanges, importChanges, commands: () => '[]', execute: () => JSON.stringify(command()) } as unknown as KitModuleDocument) : null
    const exchange = new Exchange({ kitId: 'kit.mock', exportChanges: async (since) => exportChanges(since), importChanges: async (bytes) => { importChanges(bytes) }, command: async () => command(), commands: async () => [] }, schema)
    const batch = (request: Parameters<Exchange['batch']>[0]) => runner ? runner.batch(request, schema, false) : exchange.batch(request)
    await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Old document' }] })
    const oldId = current.docId
    const result = await batch({ ops: [{ op: 'command', id: 'board.new' }, { op: 'set', target: 'root', field: 'title', value: 'Replacement' }], load: [{ target: 'root' }] })
    expect(current.docId).not.toBe(oldId)
    expect(result.loaded[0].fields.title).toBe('Replacement')
    expect(current.get('board', 'title')).toBe('Replacement')
    expect(current.canUndo()).toBe(true)
    // The old document's local script step cannot be undone in this document.
    if (runner) expect(runner.canUndo()).toBe(true)
  }
})

it('replacement planning reports public tool IDs and leaves old script history behind', async () => {
  const described = { kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Board', types: { Board: { fields: { key: { kind: 'string', readOnly: true }, title: { kind: 'string' } }, toolId: { field: 'key', prefix: 'board:' } } } }
  let generation = 0
  const fresh = () => {
    generation++
    const replica = Replica.create(parseSchema(described), `01920000-0000-7000-8000-${String(generation).padStart(12, '0')}`, BigInt(generation))
    replica.transact(person('mock'), tx => tx.create('Board', { key: String(generation), title: 'New' }, { id: `internal-${generation}` }))
    return replica
  }
  let current = fresh()
  const runner = new ReplicaModel({
    exportChanges: (since: Uint8Array) => current.exportChanges(since.byteLength ? Version.decode(since) : Version.empty()),
    importChanges: (bytes: Uint8Array) => { current.importChanges(bytes); return '{}' },
    commands: () => '[]', execute: () => { current = fresh(); return '{}' },
  } as unknown as KitModuleDocument)
  await runner.batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Old script' }] }, described, false)
  const checkpoint = runner.checkpointForPremises()
  await runner.batch({ ops: [{ op: 'command', id: 'board.new' }] }, described, false)
  const changes = runner.changesForPremises(checkpoint)
  expect(changes.created.map(item => item.id)).toEqual(['board:2'])
  expect(changes.deleted.map(item => item.id)).toEqual(['board:1'])
  expect(runner.canUndo()).toBe(false)
})
