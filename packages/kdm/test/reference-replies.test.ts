import { expect, it } from 'vitest'
import { parseSchema, Replica, runBatch, system } from '../src/index'

it('translates owning maps and nested JSON references in loads', async () => {
  const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Root', types: {
    Root: { fields: { children: { kind: 'map', owns: true }, data: { kind: 'json' }, text: { kind: 'string' } } },
    Child: { toolId: { field: 'key', prefix: 'child:' }, fields: { key: { kind: 'integer', readOnly: true } } },
  } }), '01920000-0000-7000-8000-0000000000cc', 1n)
  replica.transact(system('open'), tx => {
    const root = tx.create('Root', { data: {}, text: '' }, { id: 'raw-root' })
    const child = tx.create('Child', { key: 7 }, { id: 'raw-child' })
    tx.mapSet(root, 'children', 'raw-child', { nested: [child] })
    tx.set(root, 'data', { 'raw-child': { ref: child } })
    tx.set(root, 'text', 'literal raw-child text')
  })
  const answer = await runBatch({ replica: () => replica, transact: (origin, write) => replica.transact(origin, write), command: () => null }, {
    origin: { kind: 'agent', principal: 'test' }, ops: [], load: [{ target: 'root' }],
  })
  expect(answer.loaded[0].fields).toEqual({ children: { 'child:7': { nested: ['child:7'] } }, data: { 'child:7': { ref: 'child:7' } }, text: 'literal raw-child text' })
})
