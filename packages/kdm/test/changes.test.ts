/// <reference types="node" />
// Change sets: the same fixtures as kition-kdm's `tests/changes.rs`. Each case's
// expected change set is both the comparison of the whole states (`diffStates`, the reference)
// and the receipt `changesSince` reads from the objects the edit touched (the cheap path).
import { describe, expect, it } from 'vitest'
import { diffIsEmpty, diffStates, diffWithToolIds, KdmError, withFootprint, withTextBasis, parseSchema, Replica, replicaTarget, runBatch, ToolIds, newDocId, system, type BatchRequest } from '../src/index'
import { crateFixture, numberToolIds } from './helpers'

type Fixture = { docId: string; schema: object; setup: BatchRequest; cases: Array<{ name: string; edit: BatchRequest; expected: unknown }> }

it('compacts identical assignments with every id and full value', () => {
  const values = JSON.parse(crateFixture('assignment-values.json')) as unknown[]
  for (const after of values) {
    const input = { created: [], moved: [], deleted: [], changed: Array.from({length:4}, (_, i) => ({id:`r${i}`,type:'Record',fields:['value'],edits:[{field:'value',before:`Before ${i}`,after}]})) }
    const output = withFootprint(input, () => null)
    expect(output.changed).toEqual([])
    expect(output.footprint).toEqual([{ids:['r0','r1','r2','r3'],edits:[{field:'value',after}]}])
    const incomplete = JSON.parse(JSON.stringify(input))
    delete incomplete.changed[0].edits[0].after
    expect(withFootprint(incomplete, () => null)).toEqual(incomplete)
  }
})

const fixture = (): Fixture => JSON.parse(crateFixture('changes.json')) as Fixture

it('retains deleted JSON predicate inputs only in private recorded differences', async () => {
  const { withDeletedBasis } = await import('../src/index')
  const schema = parseSchema({kdm:1,kit:'kit.mock',schemaVersion:1,root:'Item',types:{Item:{fields:{data:{kind:'json'}}}}})
  const before = {objects:{item:{$type:'Item',data:{owner:'selected',bytes:'observed'}}}}
  const diff = diffStates(before,{objects:{}})
  expect(withDeletedBasis(diff,schema).deleted[0].$was?.data).toEqual(before.objects.item.data)
  expect(diff.deleted[0]).not.toHaveProperty('$was')
})

it('retains deleted owned values when adding located receipt or basis metadata', async () => {
  const data = JSON.parse(crateFixture('attribution.json')) as Attribution
  const schema = parseSchema(data.schema)
  for (const entry of data.cases) {
    const replica = Replica.create(schema, data.docId, 1n)
    await runBatch(replicaTarget(replica), data.setup)
    numberToolIds(replica)
    const version = replica.version(), before = replica.stateJson()
    await runBatch(replicaTarget(replica), entry.edit)
    numberToolIds(replica)
    const after = replica.stateJson()
    expect(replica.changesSince(version, { textSpans: true }), entry.name).toEqual(entry.expected)
    const recorded = withTextBasis(diffStates(before, after), schema, before, after)
    const { texts: _texts, ...shown } = diffWithToolIds(recorded, schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
    expect(shown, entry.name).toEqual(entry.expected)
  }
})

it('opts replica receipts into located spans without changing the comparison format', async () => {
  const replica = await setUp(fixture())
  const before = '\u{1f600}'.repeat(100) + 'target' + 'z'.repeat(100)
  const after = before.replace('target', 'updated')
  await runBatch(replicaTarget(replica), { ops: [
    { op: 'set', target: 'doc', field: 'title', value: before },
    { op: 'text.set', target: 'p1', field: 'body', text: before },
  ] })
  const version = replica.version()
  await runBatch(replicaTarget(replica), { ops: [
    { op: 'set', target: 'doc', field: 'title', value: after },
    { op: 'text.set', target: 'p1', field: 'body', text: after },
  ] })
  const located = replica.changesSince(version, { textSpans: true })
  const edits = located.changed.flatMap(object => object.edits ?? [])
  expect(edits).toHaveLength(2)
  for (const edit of edits) expect(edit.span).toMatchObject({ offset: 100, removed: 'target', inserted: 'updated', complete: true })
  expect(replica.changesSince(version).changed.flatMap(object => object.edits ?? []).every(edit => edit.span === undefined)).toBe(true)
})

it('locates long text with Unicode offsets and bounded replacement metadata',async()=>{
  const {diffStates,withTextSpans,textSpan}=await import('../src/index')
  const before='\u{1f600}'.repeat(100)+'erase'+'z'.repeat(100),after='\u{1f600}'.repeat(100)+'z'.repeat(100)
  const a={objects:{root:{$type:'Doc',body:before}}},b={objects:{root:{$type:'Doc',body:after}}}
  const located=withTextSpans(diffStates(a,b),a,b)
  expect(located.changed[0].edits?.[0].span).toMatchObject({offset:100,removed:'erase',inserted:'',complete:true})
  expect(JSON.stringify(located).length).toBeLessThan(3_000)
  const span=textSpan('\u0000'.repeat(10_000),'\u0001'.repeat(10_000))!
  expect(span).toMatchObject({removedLength:10_000,insertedLength:10_000,complete:false})
  expect(new TextEncoder().encode(JSON.stringify(span)).length).toBeLessThan(2_048)
  const fields=Object.fromEntries(Array.from({length:500},(_,i)=>[`f${i}`,'x'.repeat(1000)]))
  const next=Object.fromEntries(Object.keys(fields).map(key=>[key,'y'.repeat(1000)]))
  const old={objects:{root:{$type:'Doc',...fields}}},now={objects:{root:{$type:'Doc',...next}}}
  const edits=withTextSpans(diffStates(old,now),old,now).changed[0].edits!
  expect(edits.some(edit=>edit.spansTruncated)).toBe(true)
  expect(edits.reduce((bytes,edit)=>bytes+(edit.span?new TextEncoder().encode(JSON.stringify(edit.span)).length:0),0)).toBeLessThanOrEqual(65_536)
})

it('compacts map member offsets and preserves exact keys',()=>{
  const array={changed:[{id:'clip',fields:['effects'],edits:Array.from({length:5},(_,i)=>({field:`effects.${i}.amount`,before:i,after:i+1}))}]}
  expect(withFootprint(array,()=>null)).toEqual(array)
  const before=Object.fromEntries(Array.from({length:200},(_,i)=>[`entry-${i}`,{offset:i,label:'same'}]))
  const after=Object.fromEntries(Array.from({length:200},(_,i)=>[`entry-${i}`,{offset:i+3,label:'same'}]))
  const changes={created:[],changed:[{id:'root',type:'Doc',fields:['overlay'],edits:[{field:'overlay',before,after}]}],deleted:[],moved:[]}
  const compact=withFootprint(changes,()=>null)
  const edits=(compact.changed as Array<{edits:Array<{field:string;keys:string[];shift:{by:number}}>}>)[0].edits
  expect(edits[0]).toMatchObject({field:'overlay.*.offset',count:200,shift:{by:3}})
  expect(edits[0].keys).toHaveLength(200)
  expect(JSON.stringify(compact).length).toBeLessThan(4_096)
  after['entry-0'].label='changed'
  expect(withFootprint(changes,()=>null)).toEqual(changes)
  const keyed={changed:[{id:'root',fields:['overlay'],edits:[{field:'overlay',
    before:{'0':{x:1},'1':{x:2},'2':{x:3},'3':{x:4}},after:{'0':{x:2},'1':{x:3},'2':{x:4},'3':{x:5}}}]}]}
  expect((withFootprint(keyed,()=>null).changed as any[])[0].edits[0].keys).toEqual(['0','1','2','3'])
})

it('enumerates detached objects without writing', async () => {
  const replica = await setUp(fixture())
  const created = await runBatch(replicaTarget(replica), {ops:[{op:'create',type:'Shape',ref:'$detached',fields:{label:'detached',x:0}}]})
  const version = replica.version()
  const inventory = await runBatch(replicaTarget(replica), {ops:[],objects:true})
  expect(inventory.objects).toContainEqual({id:created.refs.$detached,type:'Shape'})
  expect(replica.version()).toEqual(version)
})

it('treats derived reference arrays as facts rather than owning list placements', () => {
  const before = { objects: { root: { $type: 'Root', '~items': ['child'] }, child: { $type: 'Item', name: 'Child' } } }
  const after = { objects: { root: { $type: 'Root', '~items': [] }, child: { $type: 'Item', name: 'Child' } } }
  const diff = diffStates(before, after)
  expect(diff.moved).toEqual([])
  expect(diff.changed).toEqual([{ id: 'root', type: 'Root', fields: ['~items'], edits: [{ field: '~items', before: ['child'], after: [] }] }])
})

it('keeps public and private coverage before values on one holder through named differences', async () => {
  const { withDeletedBasis } = await import('../src/index')
  const schema = parseSchema({ kdm: 1, kit: 'kit.mock', schemaVersion: 1, root: 'Node', types: {
    Node: { fields: { key: { kind: 'string', readOnly: true }, mesh: { kind: 'json' } }, toolId: { field: 'key' }, derived: { bounds: { premiseOnly: true } } },
  } })
  const before = { objects: { node: { $type: 'Node', key: 'picked', mesh: { right: 0.5 }, '~bounds': [[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]] } } }
  const after = { objects: { node: { $type: 'Node', key: 'picked', mesh: { right: -0.3 }, '~bounds': [[-0.5, -0.5, -0.5], [-0.3, 0.5, 0.5]] } } }
  const diff = diffWithToolIds(withTextBasis(diffStates(before, after), schema, before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
  const recorded = withDeletedBasis(diff, schema)
  expect(recorded.changed).toHaveLength(1)
  expect(recorded.changed[0].id).toBe('picked')
  expect(recorded.changed[0].fields).toEqual(['mesh', '~bounds'])
  expect(recorded.changed[0].edits).toEqual([
    { field: 'mesh', before: before.objects.node.mesh, after: after.objects.node.mesh },
    { field: '~bounds', before: before.objects.node['~bounds'], after: after.objects.node['~bounds'] },
  ])
})

it('names inline references in real text loads and retained marks without rewriting typed ids', async () => {
  const schema = parseSchema({ kdm: 1, kit: 'kit.inline', schemaVersion: 1, root: 'Root', types: {
    Root: { fields: { text: { kind: 'text', marks: { object: { expand: 'none' }, bold: { expand: 'after' } } } } },
    Inline: { fields: { key: { kind: 'string', readOnly: true } }, toolId: { field: 'key', prefix: 'inline:' } },
  } })
  const replica = Replica.createWith(schema, newDocId(), 1n, system('open'), tx => {
    const root = tx.create('Root', {})
    const inline = tx.create('Inline', { key: '1' })
    tx.textInsert(root, 'text', 0, inline)
    tx.textMark(root, 'text', 0, inline.length, 'object', inline)
  }).replica
  const root = replica.objectsOfType('Root')[0], inline = replica.objectsOfType('Inline')[0]
  const before = replica.stateJson()
  const loaded = await runBatch(replicaTarget(replica), { ops: [], load: [{ target: root }] })
  expect(loaded.loaded[0].fields.text).toEqual([{ insert: inline, attributes: { object: 'inline:1' } }])
  replica.transact(system('format'), tx => tx.textMark(root, 'text', 0, inline.length, 'bold', true))
  const after = replica.stateJson()
  expect(withTextBasis(diffStates(before, after), schema, before, after).$text?.[root].text)
    .toEqual([{ insert: inline, attributes: { object: 'inline:1' } }])
})

it('keeps bounded full text and marks only in recorded guard history', () => {
  const schema=parseSchema({kdm:1,kit:'kit.mock',schemaVersion:1,root:'Doc',types:{Doc:{fields:{text:{kind:'text'}}}}})
  const text='x'.repeat(10_000)
  for (const before of [text,[{insert:text,attributes:{bold:true}}]]) {
    const a={objects:{story:{$type:'Doc',text:before}}}, b={objects:{story:{$type:'Doc',text:[{insert:text,attributes:{italic:true}}]}}}
    const diff=diffStates(a,b)
    expect(withTextBasis(diff,schema,a,b).$text?.story.text).toEqual(before)
    expect('$text' in diff).toBe(false)
    expect(diff.changed[0].edits?.[0].before).toMatchObject({length:10_000})
  }
  const a={objects:{story:{$type:'Doc',text:'x'.repeat(1_048_577)}}}, b={objects:{story:{$type:'Doc',text:'short'}}}
  expect(withTextBasis(diffStates(a,b),schema,a,b).$text).toBeUndefined()
})

async function setUp(data: Fixture): Promise<Replica> {
  const replica = Replica.create(parseSchema(data.schema), data.docId, 1n)
  await runBatch(replicaTarget(replica), data.setup)
  return replica
}

describe('change sets', () => {
  it('keeps blob basis references for changed and deleted objects (shared blob-basis.json)', async () => {
    const data = JSON.parse(crateFixture('blob-basis.json')) as Fixture & { before: unknown; after: unknown; edit: BatchRequest }
    const replica = await setUp(data)
    numberToolIds(replica)
    const version = replica.version()
    await runBatch(replicaTarget(replica), data.edit)
    expect(replica.changesSince(version).changed[0].edits?.[0].before).toEqual(data.before)
    const deletedAt = replica.version()
    await runBatch(replicaTarget(replica), { ops: [{ op: 'delete', target: 'image' }] })
    expect(replica.changesSince(deletedAt).changed[0].edits?.[0].before).toMatchObject({ mask: data.after })
  })
  it('describe every kind of change alike by both paths, as the Rust crate does', async () => {
    const data = fixture()
    for (const entry of data.cases) {
      const replica = await setUp(data)
      const [version, before] = [replica.version(), replica.stateJson()]
      await runBatch(replicaTarget(replica), entry.edit)
      const { texts, ...reference } = diffStates(before, replica.stateJson())
      expect(texts, `${entry.name}: a comparison has its texts`).toBeInstanceOf(Array)
      expect(reference, `${entry.name}: the comparison of the whole states`).toEqual(entry.expected)
      const receipt = replica.changesSince(version)
      expect(receipt, `${entry.name}: the receipt`).toEqual(entry.expected)
      expect('texts' in receipt, entry.name).toBe(false)
      expect(diffIsEmpty(receipt), entry.name).toBe(entry.name === 'no-effect')
      expect(JSON.stringify(receipt)).toBe(JSON.stringify(replica.changesSince(version)))
    }
  })

  it('tell a map or json change where it changed, as the Rust crate does (fixtures/leaf-edits.json)', async () => {
    const data = JSON.parse(crateFixture('leaf-edits.json')) as Fixture
    for (const entry of data.cases) {
      const replica = await setUp(data)
      const version = replica.version()
      await runBatch(replicaTarget(replica), entry.edit)
      expect(replica.changesSince(version), `${entry.name}: the receipt`).toEqual(entry.expected)
    }
  })

  it('name an edit inside named objects in the kit\'s words, as the Rust crate does (fixtures/path-names.json)', async () => {
    const data = JSON.parse(crateFixture('path-names.json')) as Fixture
    for (const entry of data.cases) {
      const replica = await setUp(data)
      numberToolIds(replica)
      const version = replica.version()
      await runBatch(replicaTarget(replica), entry.edit)
      expect(replica.changesSince(version), `${entry.name}: the receipt`).toEqual(entry.expected)
    }
  })

  it('take a set to a held object\'s field by a path, as the Rust crate does (fixtures/batch-paths.json)', async () => {
    const data = JSON.parse(crateFixture('batch-paths.json')) as Fixture & { cases: Array<{ name: string; edit: BatchRequest; expected?: unknown; error?: { code: string; message: string } }> }
    for (const entry of data.cases) {
      const replica = await setUp(data)
      numberToolIds(replica)
      const version = replica.version()
      if (entry.error) {
        await expect(runBatch(replicaTarget(replica), entry.edit), entry.name).rejects.toMatchObject({ code: entry.error.code, message: entry.error.message })
      } else {
        await runBatch(replicaTarget(replica), entry.edit)
        expect(replica.changesSince(version), `${entry.name}: the receipt`).toEqual(entry.expected)
      }
    }
  })

  it('need a version the replica holds', async () => {
    const data = fixture()
    const replica = await setUp(data)
    const edited = await setUp(data)
    await runBatch(replicaTarget(edited), data.cases[1].edit)
    expect(() => replica.changesSince(edited.version())).toThrow(KdmError)
    expect(() => replica.changesSince(edited.version())).toThrow(/history missing/)
    expect(diffIsEmpty(replica.changesSince(replica.version()))).toBe(true)
  })
})

type Attribution = {
  docId: string
  schema: { types: Record<string, { fields: Record<string, unknown> }> }
  setup: BatchRequest
  cases: Array<{ name: string; edit: BatchRequest; expected: unknown; texts?: unknown }>
  schemaErrors: Array<{ type: string; field: string; def: unknown; message: string }>
}

describe('change sets inside objects', () => {
  it('tell a change of an object without a tool id as a change of its nearest holder with one, as the Rust crate does', async () => {
    const data = JSON.parse(crateFixture('attribution.json')) as Attribution
    const schema = parseSchema(data.schema)
    for (const entry of data.cases) {
      const replica = Replica.create(schema, data.docId, 1n)
      await runBatch(replicaTarget(replica), data.setup)
      numberToolIds(replica)
      const [version, before] = [replica.version(), replica.stateJson()]
      await runBatch(replicaTarget(replica), entry.edit)
      numberToolIds(replica)
      const after = replica.stateJson()
      const receipt = replica.changesSince(version)
      expect(receipt, `${entry.name}: the receipt`).toEqual(entry.expected)
      const { texts, ...reference } = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
      expect(reference, `${entry.name}: the comparison of the whole states`).toEqual(entry.expected)
      if (entry.texts !== undefined) expect(texts, `${entry.name}: the comparison's texts`).toEqual(entry.texts)
    }
  })

  it('hold through a map declared `owns` the objects its values name, at their keys, as the Rust crate does', async () => {
    const data = JSON.parse(crateFixture('map-ownership.json')) as Attribution
    const schema = parseSchema(data.schema)
    const prepared = async () => {
      const replica = Replica.create(schema, data.docId, 1n)
      await runBatch(replicaTarget(replica), data.setup)
      numberToolIds(replica)
      return replica
    }
    for (const entry of data.cases) {
      const replica = await prepared()
      const [version, before] = [replica.version(), replica.stateJson()]
      await runBatch(replicaTarget(replica), entry.edit)
      numberToolIds(replica)
      const after = replica.stateJson()
      expect(replica.changesSince(version), `${entry.name}: the receipt`).toEqual(entry.expected)
      const { texts: _texts, ...reference } = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
      expect(reference, `${entry.name}: the comparison of the whole states`).toEqual(entry.expected)
    }
    const replica = await prepared()
    const version = replica.version()
    await runBatch(replicaTarget(replica), { ops: [{ op: 'text.set', target: 'p3', field: 'text', text: 'Still loose' }] })
    expect(replica.changesSince(version).changed[0].id, 'a map without `owns` holds nothing').toBe('p3')
    for (const error of data.schemaErrors) {
      const changed = structuredClone(data.schema)
      changed.types[error.type].fields[error.field] = error.def
      expect(() => parseSchema(changed)).toThrow(error.message)
    }
  })

  it('name a cell by its row and column indexes and an unnamed ref by its type, as the Rust crate does', async () => {
    const data = JSON.parse(crateFixture('usable-ids.json')) as Fixture
    const schema = parseSchema(data.schema)
    for (const entry of data.cases) {
      const replica = Replica.create(schema, data.docId, 1n)
      await runBatch(replicaTarget(replica), data.setup)
      numberToolIds(replica)
      const [version, before] = [replica.version(), replica.stateJson()]
      await runBatch(replicaTarget(replica), entry.edit)
      numberToolIds(replica)
      const after = replica.stateJson()
      expect(replica.changesSince(version), `${entry.name}: the receipt`).toEqual(entry.expected)
      const { texts: _texts, ...reference } = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
      expect(reference, `${entry.name}: the comparison of the whole states`).toEqual(entry.expected)
    }
  })

  it('take `owns` on a ref field only, as the Rust crate does', () => {
    const data = JSON.parse(crateFixture('attribution.json')) as Attribution
    for (const error of data.schemaErrors) {
      const schema = structuredClone(data.schema)
      schema.types[error.type].fields[error.field] = error.def
      expect(() => parseSchema(schema)).toThrow(error.message)
    }
  })
})

describe('footprint', () => {
  it('states a shift of many objects once, as the Rust crate does (fixtures/footprint.json)', () => {
    type Case = { name: string; changes: Record<string, unknown>; lists: Record<string, string[]>; expected: unknown }
    const { cases } = JSON.parse(crateFixture('footprint.json')) as { cases: Case[] }
    for (const entry of cases) {
      const compact = withFootprint(entry.changes, (parent, field) => entry.lists[`${parent}/${field}`] ?? null)
      expect(compact, entry.name).toEqual(entry.expected)
    }
  })
})
