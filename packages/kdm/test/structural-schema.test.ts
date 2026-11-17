import { expect, it } from 'vitest'
import { parseSchema } from '../src/index'

it('checks structural consequence containers, actions and paths, as Rust does', () => {
  const schema = { kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Sheet', types: {
    Sheet: { fields: { cells: { kind: 'map', owns: true } } },
    Cell: { fields: { formula: { kind: 'string' }, address: { kind: 'json' } }, structuralConsequences: [
      { container: 'Sheet', on: ['create', 'delete', 'move', 'rename'], fields: ['formula', 'address.row'] },
    ] },
  } }
  expect(parseSchema(schema).types.Cell.structuralConsequences).toEqual(schema.types.Cell.structuralConsequences)
  for (const [key, value] of [['container', 'Missing'], ['on', ['set']], ['on', []], ['fields', ['missing']], ['fields', ['formula.part']], ['fields', []]] as const) {
    const invalid = structuredClone(schema)
    Object.assign(invalid.types.Cell.structuralConsequences[0], { [key]: value })
    expect(() => parseSchema(invalid)).toThrow('structuralConsequences')
  }
})
