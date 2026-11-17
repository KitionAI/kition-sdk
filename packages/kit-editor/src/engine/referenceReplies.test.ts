import { expect, it } from 'vitest'
import { describeModel, parseSchema, Replica, system, Version } from '@kition/kdm'
import { ReplicaModel } from './kitModelRunner'
import type { KitModuleDocument } from './kitModule'

it('translates only agent replies and keeps the editor replica in native ids', () => {
  const schema = { kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Item', types: {
    Item: { toolId: { field: 'key', prefix: 'item:' }, fields: { key: { kind: 'integer', readOnly: true } } },
  } }
  const replica = Replica.create(parseSchema(schema), '01920000-0000-7000-8000-0000000000cc', 1n)
  replica.transact(system('open'), tx => tx.create('Item', { key: 7 }, { id: 'raw-item' }))
  const doc = { commands: () => '[]', exportChanges: (since: Uint8Array) => replica.exportChanges(since.length ? Version.decode(since) : undefined) } as unknown as KitModuleDocument
  const model = new ReplicaModel(doc)
  model.describe(schema)
  const value = { details: { 'raw-item': ['raw-item'] }, diagnostics: [{ target: { object: 'raw-item' } }], literal: 'text raw-item' }
  expect(model.reply(value)).toEqual({ details: { 'item:7': ['item:7'] }, diagnostics: [{ target: { object: 'item:7' } }], literal: 'text raw-item' })
  expect(replica.objectsOfType('Item')).toEqual(['raw-item'])
})

it('translates the first agent reply using the native model description', () => {
  const schema = { kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Item', types: {
    Item: { toolId: { field: 'key', prefix: 'item:' }, fields: { key: { kind: 'integer', readOnly: true } } },
  } }
  const replica = Replica.create(parseSchema(schema), '01920000-0000-7000-8000-0000000000cc', 1n)
  replica.transact(system('open'), tx => tx.create('Item', { key: 7 }, { id: 'raw-item' }))
  const doc = {
    modelDescribe: () => JSON.stringify(describeModel(replica)),
    exportChanges: (since: Uint8Array) => replica.exportChanges(since.length ? Version.decode(since) : undefined),
  } as unknown as KitModuleDocument
  expect(new ReplicaModel(doc).reply({ target: 'raw-item' })).toEqual({ target: 'item:7' })
})
