import { expect, it } from 'vitest'
import { diffStates, diffWithToolIds, parseSchema, ToolIds } from '../src/index'

it('names nested receipt references with tool ids, as Rust does', () => {
  const schema = parseSchema({ kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Root', types: {
    Root: { fields: { catalog: { kind: 'map', owns: true }, data: { kind: 'json' } } },
    Node: { fields: { key: { kind: 'string', readOnly: true } }, toolId: { field: 'key', prefix: 'node:' } },
  } })
  const before = { objects: { root: { $type: 'Root', catalog: {}, data: {} }, 'raw-node': { $type: 'Node', key: '7' } } }
  const after = structuredClone(before)
  after.objects.root.catalog = { direct: 'raw-node', wrapped: { body: 'raw-node', label: 'literal' } }
  after.objects.root.data = { deep: [{ target: 'raw-node' }], 'raw-node': 'raw-node', literal: 'text raw-node' }
  const names = ToolIds.ofState(schema, after)
  expect(names.showJson(after.objects.root.data)).toEqual({ deep: [{ target: 'node:7' }], 'node:7': 'node:7', literal: 'text raw-node' })
  const diff = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), names)
  expect(diff.changed[0].edits?.[0].after).toEqual({ direct: 'node:7', wrapped: { body: 'node:7', label: 'literal' } })
  expect(diff.changed[0].edits?.[1].after).toEqual(names.showJson(after.objects.root.data))
})
