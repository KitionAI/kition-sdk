/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalText, formatNumber } from '../src/canonical'
import { KdmError } from '../src/errors'
import { newDocId, newObjectId, uuidFromBytes, uuidToBytes } from '../src/ids'
import { agent, decodeOrigin, encodeOrigin, person, system, type OriginKind } from '../src/origin'
import { checkValue, parseSchema } from '../src/schema'

const testSchema = () =>
  parseSchema(readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/test-schema.json', import.meta.url)), 'utf8'))

const reason = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    if (error instanceof KdmError) return error.reason
    throw error
  }
  return undefined
}

const withField = (def: string) => `{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"f":${def}}}}}`

describe('schema', () => {
  it('requires position paths for move consequences', () => {
    for (const [path, valid] of [['address.container',true],['address',true],['name',false],['missing',false],['address.',false]]) {
      const value = {kdm:1,kit:'k',schemaVersion:1,root:'A',types:{A:{fields:{address:{kind:'json',position:true},name:{kind:'string'}},moveConsequences:[path]}}}
      if (valid) expect(parseSchema(value).types.A.moveConsequences).toEqual([path])
      else expect(reason(() => parseSchema(value))).toBe('schema')
    }
  })
  it('requires privacy for on-demand derived facts', () => {
    for (const premiseOnly of [false,true]) {
      const value={kdm:1,kit:'k',schemaVersion:1,root:'A',types:{A:{fields:{},derived:{fact:{onDemand:true,premiseOnly}}}}}
      if(premiseOnly) expect(parseSchema(value).types.A.derived?.fact.onDemand).toBe(true)
      else expect(reason(()=>parseSchema(value))).toBe('schema')
    }
  })
  it('retains the opt-in for independent raw field writes', () => {
    const schema = parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: {}, batchIndependent: true } } })
    expect(schema.types.A.batchIndependent).toBe(true)
    expect(reason(() => parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: {}, batchIndependent: 'yes' } } }))).toBe('schema')
  })
  it('retains declared JSON text members', () => {
    const schema = parseSchema({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: { A: { fields: {kind:{kind:'json'}}, text:'kind.words' } } })
    expect(schema.types.A.text).toBe('kind.words')
  })
  it('retains premise-only derived declarations', () => {
    const schema = parseSchema(JSON.stringify({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: {
      A: { fields: {}, derived: { history: { premiseOnly: true }, visible: { description: 'public' } } },
    } }))
    expect(schema.types.A.derived).toEqual({ history: { premiseOnly: true }, visible: { description: 'public' } })
  })

  it('parses the test schema', () => {
    const schema = testSchema()
    expect(schema.root).toBe('Page')
    expect(Object.keys(schema.types)).toHaveLength(3)
  })

  it('rejects an unknown kdm version', () => {
    expect(() => parseSchema('{"kdm":2,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}}}}')).toThrow(/kdm 2/)
  })

  it('rejects an undeclared root and dangling types', () => {
    expect(reason(() => parseSchema('{"kdm":1,"kit":"k","schemaVersion":1,"root":"B","types":{"A":{"fields":{}}}}'))).toBe('schema')
    expect(() => parseSchema(withField('{"kind":"ref","of":"Z"}'))).toThrow(/undeclared/)
  })

  it('rejects reserved names and empty enums', () => {
    expect(() => parseSchema('{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"$type":{"kind":"string"}}}}}')).toThrow(/reserved/)
    expect(() => parseSchema('{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}},"$B":{"fields":{}}}}')).toThrow(/reserved/)
    expect(() => parseSchema(withField('{"kind":"enum"}'))).toThrow(/values/)
    expect(() => parseSchema(withField('{"kind":"enum","values":[]}'))).toThrow(/values/)
  })

  it('needs `of` on ref, list, and tree fields', () => {
    for (const kind of ['ref', 'list', 'tree']) expect(() => parseSchema(withField(`{"kind":"${kind}"}`))).toThrow(/needs `of`/)
  })

  it('rejects `of` and `values` on kinds that do not take them', () => {
    expect(() => parseSchema(withField('{"kind":"ref","of":"A"}'))).not.toThrow()
    expect(() => parseSchema(withField('{"kind":"enum","values":["x"]}'))).not.toThrow()
    for (const bad of [
      '{"kind":"string","of":"A"}',
      '{"kind":"map","of":"A"}',
      '{"kind":"text","of":"A"}',
      '{"kind":"string","values":["x"]}',
      '{"kind":"ref","of":"A","values":["x"]}',
    ]) {
      expect(reason(() => parseSchema(withField(bad))), bad).toBe('schema')
    }
  })

  it('rejects what the Rust deserializer rejects', () => {
    for (const bad of [
      'not json',
      '[]',
      '{"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}}}}',
      '{"kdm":1,"kit":"k","schemaVersion":-1,"root":"A","types":{"A":{"fields":{}}}}',
      '{"kdm":1,"kit":"k","schemaVersion":1.5,"root":"A","types":{"A":{"fields":{}}}}',
      '{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{}}}',
      '{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","extra":true,"types":{"A":{"fields":{}}}}',
      withField('{"kind":"string","extra":true}'),
      withField('{"kind":"colour"}'),
      withField('{"kind":"string","optional":"yes"}'),
    ]) {
      expect(reason(() => parseSchema(bad)), bad).toBe('schema')
    }
  })

  // The same text as kition-kdm's `an_enum_refusal_lists_the_values` (KHP A48).
  it('lists an enum field\'s values when it refuses one', () => {
    const schema = testSchema()
    const message = (run: () => unknown): string => {
      try {
        run()
      } catch (error) {
        return (error as Error).message
      }
      return ''
    }
    expect(message(() => checkValue(schema, 'Shape', 'kind', 3))).toBe('field `kind` of `Shape` takes one of `rect`, `ellipse`, not a number')
    const many = Array.from({ length: 23 }, (_, n) => `v${n + 1}`)
    const big = parseSchema(withField(JSON.stringify({ kind: 'enum', values: many })))
    const first = many.slice(0, 20).map((value) => `\`${value}\``).join(', ')
    expect(message(() => checkValue(big, 'A', 'f', 'v0'))).toBe(`field \`f\` of \`A\` takes one of ${first}, and 3 more (\`describe\` lists them all), not \`v0\``)
    const kinds = parseSchema('{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"i":{"kind":"integer"},"n":{"kind":"number"}}}}}')
    expect(message(() => checkValue(kinds, 'A', 'i', 'x'))).toBe('field `i` of `A` expects an integer value')
    expect(message(() => checkValue(kinds, 'A', 'n', 'x'))).toBe('field `n` of `A` expects a number value')
  })

  it('checks register values', () => {
    const schema = testSchema()
    expect(() => checkValue(schema, 'Shape', 'x', 1.5)).not.toThrow()
    expect(() => checkValue(schema, 'Shape', 'x', '1')).toThrow(KdmError)
    expect(() => checkValue(schema, 'Shape', 'x', Number.NaN)).toThrow(KdmError)
    expect(() => checkValue(schema, 'Shape', 'kind', 'ellipse')).not.toThrow()
    expect(() => checkValue(schema, 'Shape', 'kind', 'star')).toThrow('field `kind` of `Shape` takes one of `rect`, `ellipse`, not `star`')
    expect(() => checkValue(schema, 'Shape', 'fill', null)).not.toThrow()
    expect(() => checkValue(schema, 'Shape', 'x', null)).toThrow(/is required/)
    expect(() => checkValue(schema, 'Shape', 'image', { hash: 'ab', mime: 'image/png', size: 3 })).not.toThrow()
    expect(() => checkValue(schema, 'Shape', 'image', { hash: 'ab' })).toThrow(KdmError)
    expect(() => checkValue(schema, 'Shape', 'image', { hash: 'ab', mime: 'image/png', size: -1 })).toThrow(KdmError)
    expect(() => checkValue(schema, 'Shape', 'label', 'text')).toThrow(/container/)
    expect(reason(() => checkValue(schema, 'Shape', 'nope', 1))).toBe('unknown-field')
    expect(reason(() => checkValue(schema, 'Nope', 'x', 1))).toBe('unknown-type')
  })

  it('keeps integers exact in every implementation', () => {
    const schema = parseSchema(withField('{"kind":"integer"}'))
    const safe = 2 ** 53
    for (const ok of [0, safe, -safe, -1]) expect(() => checkValue(schema, 'A', 'f', ok), String(ok)).not.toThrow()
    for (const bad of [safe + 2, -safe - 2, Number.MAX_VALUE, 1.5, '1']) {
      expect(reason(() => checkValue(schema, 'A', 'f', bad)), String(bad)).toBe('invalid-value')
    }
  })
})

describe('ids', () => {
  it('makes unique UUID v7 object ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, newObjectId))
    expect(ids.size).toBe(1000)
    const first = [...ids][0]
    expect(first).toHaveLength(36)
    expect(first[14]).toBe('7')
  })

  it('round-trips document ids through their bytes, in the forms Rust parses', () => {
    const id = newDocId()
    expect(uuidFromBytes(uuidToBytes(id))).toBe(id)
    const plain = id.replaceAll('-', '')
    for (const form of [id.toUpperCase(), `{${id}}`, `urn:uuid:${id}`, plain]) expect(uuidFromBytes(uuidToBytes(form))).toBe(id)
    expect(reason(() => uuidToBytes('not a uuid'))).toBe('encoding')
  })
})

describe('origins', () => {
  it('encode like the Rust crate and round-trip', () => {
    const origin = agent('user:42', 'slide.duplicate')
    expect(encodeOrigin(origin)).toBe('["agent","user:42","slide.duplicate"]')
    expect(decodeOrigin(encodeOrigin(origin))).toEqual(origin)
    expect(encodeOrigin(person('user:1'))).toBe('["person","user:1",null]')
    expect(encodeOrigin(system('create'))).toBe('["system","kdm","create"]')
    expect(decodeOrigin('not json')).toBeNull()
    expect(decodeOrigin('["robot","x",null]')).toBeNull()
    for (const kind of ['person', 'agent', 'extension', 'import', 'system'] as OriginKind[]) {
      expect(decodeOrigin(encodeOrigin({ kind, principal: 'p' }))?.kind).toBe(kind)
    }
  })
})

describe('canonical text', () => {
  it('sorts keys by code point and writes numbers as serde_json does', () => {
    expect(canonicalText({ b: 1, a: [true, null, 'x'], '😀': 0, '￿': 0 })).toBe('{"a":[true,null,"x"],"b":1,"￿":0,"😀":0}')
    // The texts `serde_json` 1.0.151 writes for these doubles.
    const cases: Array<[number, string]> = [
      [1e16, '1e+16'],
      [9.1e15, '9100000000000000.0'],
      [18014398509481984, '1.8014398509481984e+16'],
      [1e21, '1e+21'],
      [1.5e300, '1.5e+300'],
      [1e-7, '1e-7'],
      [0.000001, '1e-6'],
      [0.00001, '0.00001'],
      [1.5e-10, '1.5e-10'],
      [123456.789, '123456.789'],
      [-1e16, '-1e+16'],
      [5e-324, '5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [0.1 + 0.2, '0.30000000000000004'],
      [1e20, '1e+20'],
      [123e18, '1.23e+20'],
      [1.25e-5, '0.0000125'],
      [12.5, '12.5'],
      [-0, '0'],
      [2 ** 53, '9007199254740992'],
      [-(2 ** 53), '-9007199254740992'],
    ]
    for (const [value, text] of cases) expect(formatNumber(value), String(value)).toBe(text)
  })
})
