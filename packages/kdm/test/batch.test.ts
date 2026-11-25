/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { BatchError, describeModel, parseSchema, Replica, replicaTarget, runBatch, type BatchRequest, type BatchTarget, type Schema } from '../src/index'
import { crateFixture, me, testSchema } from './helpers'

type Step = { request: BatchRequest; result?: unknown; error?: { code: string; index: number | null } }

const DOC_ID = '01920000-0000-7000-8000-0000000000bb'

describe('object-model batches', () => {
  it('moves to every pre-removal gap including the end', async () => {
    for (let from = 0; from < 4; from++) for (let to = 0; to <= 5; to++) {
      const replica = Replica.create(testSchema(), DOC_ID, 1n)
      await runBatch(replicaTarget(replica), { ops: [
        { op: 'create', type: 'Page', id: 'page', fields: { title: 'One' } },
        ...['a', 'b', 'c', 'd'].map(id => ({ op: 'create', type: 'Shape', id, in: 'root.shapes', fields: { kind: 'rect', x: 0, y: 0 } })),
      ] })
      const before = replica.stateText()
      const result = runBatch(replicaTarget(replica), { ops: [{ op: 'list.move', target: 'root', field: 'shapes', from, to }] })
      if (to > 4) {
        await expect(result).rejects.toMatchObject({ code: 'invalid-value' })
        expect(replica.stateText()).toBe(before)
      } else {
        await result
        const order = ['a', 'b', 'c', 'd']
        const [item] = order.splice(from, 1)
        order.splice(to > from ? to - 1 : to, 0, item!)
        expect(replica.list('page', 'shapes')).toEqual(order)
      }
    }
  })
  it('describes creation seeds and binds an object returned by a creation command', async () => {
    const schema=parseSchema({kdm:1,kit:'kit.create',schemaVersion:1,root:'Item',types:{Item:{fields:{name:{kind:'string'}},creation:{fields:{name:'Seed'},fixtures:{image:{data:[137,80,78,71]}},command:{command:'item.create',params:{name:'fields.name',data:'fixtures.image.data'}}}}}})
    const replica=Replica.create(schema,DOC_ID,1n)
    const target:BatchTarget={...replicaTarget(replica),command:(_id,params,origin)=>replica.transact(origin,tx=>({id:tx.create('Item',{name:(params as {name:string}).name},{id:'created'})}))}
    const answer=await runBatch(target,{ops:[{op:'command',id:'item.create',params:{name:'New'},ref:'$new'},{op:'set',target:'$new',field:'name',value:'Changed'}]})
    expect(answer.refs.$new).toBe('created')
    expect(replica.get('created','name')).toBe('Changed')
    expect(describeModel(replica).types.Item.creation).toEqual(schema.types.Item.creation)
  })
  it('refuses explicit command context when the adapter cannot apply it', async () => {
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    const target = { ...replicaTarget(replica), command: () => 'wrong context' }
    await expect(runBatch(target, { ops: [{ op: 'command', id: 'test', at: { time: 2.5 } }] })).rejects.toMatchObject({ code: 'command-failed' })
  })
  it('passes selection, part and time to a context-aware command adapter', async () => {
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    const contexts: unknown[] = []
    const target: BatchTarget = { ...replicaTarget(replica), commandAt: (_id, _params, context) => { contexts.push(context); return context } }
    const answer = await runBatch(target, { ops: [{ op: 'command', id: 'test', on: ['key'], at: { part: { track: 'V1' }, time: 2.5 } }] })
    expect(contexts).toEqual([{ on: ['key'], part: { track: 'V1' }, time: 2.5 }])
    expect(answer.results).toEqual(contexts)
  })
  it('accepts creation-only fields and keeps subsequent writes atomic and read-only', async () => {
    const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Item', types: {
      Item: { fields: { kind: { kind: 'enum', values: ['shape', 'frame'], readOnly: true }, name: { kind: 'string' } } },
    } }), DOC_ID, 1n)
    for (const fields of [{ name: 'New' }, { kind: 'invalid', name: 'New' }]) {
      await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Item', id: 'item', fields }] })).rejects.toMatchObject({ code: 'invalid-value' })
      expect(replica.exists('item')).toBe(false)
    }
    await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Item', id: 'item', fields: { kind: 'shape', name: 'New' } }] })
    const before = replica.stateText()
    await expect(runBatch(replicaTarget(replica), { ops: [
      { op: 'set', target: 'item', field: 'name', value: 'Changed' },
      { op: 'set', target: 'item', field: 'kind', value: 'frame' },
    ] })).rejects.toMatchObject({ code: 'read-only' })
    expect(replica.stateText()).toBe(before)
  })
  it('enforces JSON member limits for leaf and whole-value batches', async () => {
    const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.limits', schemaVersion: 1, root: 'Image', types: { Image: { fields: {
      data: { kind: 'json', members: { roughness: { minimum: 0, maximum: 1, multipleOf: 0.1 } } },
    } } } }), DOC_ID, 1n)
    await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Image', id: 'image', fields: { data: { roughness: 0.5 } } }] })
    expect(describeModel(replica).types.Image.fields.data.members).toEqual({ roughness: { minimum: 0, maximum: 1, multipleOf: 0.1 } })
    for (const [field, value] of [['data.roughness', 2], ['data.roughness', 0.15], ['data', { roughness: -1 }], ['data', { roughness: 'bad' }]] as const) {
      const before = replica.stateText()
      await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field, value }] })).rejects.toMatchObject({ code: 'invalid-value' })
      expect(replica.stateText()).toBe(before)
    }
  })
  it('describes boolean field labels (shared boolean-labels.json)', () => {
    const replica = Replica.create(parseSchema(crateFixture('boolean-labels.json')), DOC_ID, 1n)
    expect(describeModel(replica).types.Image.fields.isClipped.label).toBe('clipped')
  })
  it('enforces numeric limits and describes them (shared numeric-limits.json)', async () => {
    const fixture = JSON.parse(crateFixture('numeric-limits.json')) as { schema: object; valid: number[]; invalid: number[]; integers: number[]; invalidIntegers: number[] }
    const replica = Replica.create(parseSchema(JSON.stringify(fixture.schema)), DOC_ID, 1n)
    await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Image', id: 'image', fields: { opacity: 0, level: 0 } }] })
    expect(describeModel(replica).types.Image.fields.opacity).toEqual({ kind: 'number', minimum: 0, maximum: 1, multipleOf: 0.1 })
    for (const [field, valid, invalid] of [['opacity', fixture.valid, fixture.invalid], ['level', fixture.integers, fixture.invalidIntegers]] as const) {
      for (const value of valid) await runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field, value }] })
      for (const value of invalid) {
        const before = replica.stateText()
        await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field: 'level', value: 0 }, { op: 'set', target: 'root', field, value }] })).rejects.toMatchObject({ code: 'invalid-value' })
        expect(replica.stateText()).toBe(before)
      }
    }
  })
  it('cascades deletion through owning refs, lists and maps (shared delete-owned.json)', async () => {
    const fixture = JSON.parse(crateFixture('delete-owned.json')) as { schema: object; setup: BatchRequest; edit: BatchRequest; deleted: string[]; remaining: string[] }
    const replica = Replica.create(parseSchema(JSON.stringify(fixture.schema)), DOC_ID, 1n)
    await runBatch(replicaTarget(replica), fixture.setup)
    const version = replica.version()
    await runBatch(replicaTarget(replica), fixture.edit)
    expect(replica.changesSince(version).deleted.map((item) => item.id)).toEqual(fixture.deleted)
    expect(Object.keys((replica.stateJson() as { objects: Record<string, unknown> }).objects)).toEqual(fixture.remaining)
    expect(replica.undo()).toBe(true)
    expect(replica.exists('prop')).toBe(true)
  })
  it('answer the shared fixtures as the Rust crate does', async () => {
    const fixture = JSON.parse(crateFixture('batch.json')) as { steps: Step[] }
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    for (const [index, step] of fixture.steps.entries()) {
      const before = replica.stateText()
      if (step.error) {
        const error = await runBatch(replicaTarget(replica), step.request).then(
          () => null,
          (failed: unknown) => failed,
        )
        expect(error, `step ${index}`).toBeInstanceOf(BatchError)
        expect({ code: (error as BatchError).code, index: (error as BatchError).index }, `step ${index}`).toEqual(step.error)
        expect(replica.stateText(), `step ${index} failed but changed the document`).toBe(before)
      } else {
        expect(await runBatch(replicaTarget(replica), step.request), `step ${index}`).toEqual(step.result)
      }
    }
    expect(withoutDeadNodes(replica.stateJson())).toEqual(JSON.parse(crateFixture('batch-state.json')))
  })

  it('counts text positions in Unicode scalar values', async () => {
    const replica = Replica.create(parseSchema(crateFixture('marks-schema.json')), DOC_ID, 1n)
    // Two characters outside the Basic Multilingual Plane: two UTF-16 units each.
    const wide = String.fromCodePoint(0x1f600, 0x1f601)
    const answer = await runBatch(replicaTarget(replica), {
      ops: [
        { op: 'create', type: 'Doc', id: 'd' },
        { op: 'create', type: 'Para', in: 'root.paras', ref: '$t' },
        { op: 'text.insert', target: '$t', field: 'text', index: 0, text: `${wide}ok` },
        { op: 'text.mark', target: '$t', field: 'text', start: 0, end: 2, key: 'bold', value: true },
        { op: 'text.delete', target: '$t', field: 'text', index: 2, count: 1 },
      ],
      load: [{ target: '$t', fields: ['text'] }],
    })
    expect(answer.loaded[0].fields.text).toEqual([{ insert: wide, attributes: { bold: true } }, { insert: 'k' }])
  })

  it('runs commands between transactions with references resolved, and stops at a failing one', async () => {
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    const ran: Array<[string, unknown]> = []
    const target: BatchTarget = {
      ...replicaTarget(replica),
      command: (id, params) => {
        ran.push([id, params])
        if (id === 'fail') throw new Error('it failed')
        return { ran: id }
      },
    }
    const failed = await runBatch(target, {
      ops: [
        { op: 'create', type: 'Page', ref: '$p', id: 'p', fields: { title: 'A' } },
        { op: 'command', id: 'page.tidy', params: { page: '$p' } },
        { op: 'set', target: '$p', field: 'title', value: 'B' },
        { op: 'command', id: 'fail' },
        { op: 'set', target: '$p', field: 'title', value: 'C' },
      ],
    }).catch((error: BatchError) => error)
    expect(failed).toMatchObject({ code: 'command-failed', index: 3 })
    expect(ran[0]).toEqual(['page.tidy', { page: 'p' }])
    expect(replica.get('p', 'title')).toBe('B')
  })

  // The same fixtures as kition-kdm's `references_name_objects_that_exist`, messages included.
  it('refuses a reference to an object that does not exist', async () => {
    type RefStep = { request: BatchRequest; result?: unknown; error?: { code: string; index: number | null; message: string } }
    const fixture = JSON.parse(crateFixture('refs.json')) as { schema: object; steps: RefStep[] }
    const replica = Replica.create(parseSchema(JSON.stringify(fixture.schema)), DOC_ID, 1n)
    for (const [index, step] of fixture.steps.entries()) {
      const before = replica.stateText()
      const answer = await runBatch(replicaTarget(replica), step.request).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      if (step.error) {
        expect('error' in answer && answer.error, `step ${index}`).toBeInstanceOf(BatchError)
        const error = (answer as { error: BatchError }).error
        expect({ code: error.code, index: error.index, message: error.message }, `step ${index}`).toEqual(step.error)
        expect(replica.stateText(), `step ${index} failed but changed the document`).toBe(before)
      } else {
        expect(answer, `step ${index}`).toEqual({ result: step.result })
      }
    }
  })

  it('refuses writes to a read-only document', async () => {
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    const target: BatchTarget = { ...replicaTarget(replica), readOnly: () => true }
    await expect(runBatch(target, { ops: [{ op: 'create', type: 'Page', fields: { title: 'A' } }] })).rejects.toMatchObject({ code: 'read-only' })
  })

  it('describes the schema and the root', async () => {
    const replica = Replica.create(testSchema(), DOC_ID, 1n)
    await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Page', id: 'p', fields: { title: 'A' } }] })
    const described = describeModel(replica)
    expect(described).toMatchObject({ capability: 'KitObjectModel 1.0', kit: 'kit.test', root: 'Page', rootId: 'p' })
    expect(described.types.Page.fields.shapes).toEqual({ kind: 'list', of: 'Shape' })
    expect(described.types.Shape.fields.kind).toEqual({ kind: 'enum', values: ['rect', 'ellipse'] })
  })

  it('describes derived values and refuses bad ones, as the Rust crate does (fixtures/derived.json)', () => {
    const fixture = JSON.parse(crateFixture('derived.json')) as { docId: string; schema: object; described: object; refused: Array<{ why: string; types: object }> }
    const replica = Replica.create(parseSchema(JSON.stringify(fixture.schema)), fixture.docId, 1n)
    const described = describeModel(replica)
    expect(described.types.Node.derived).toEqual(fixture.described)
    expect(described.types.Scene.derived).toBeUndefined()
    for (const refused of fixture.refused) {
      expect(() => parseSchema(JSON.stringify({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'A', types: refused.types })), refused.why).toThrow()
    }
  })

  it('describes labels, displays and samples and refuses bad ones, as the Rust crate does (fixtures/words-schema.json)', () => {
    const fixture = JSON.parse(crateFixture('words-schema.json')) as { docId: string; schema: object; described: { Clip: object }; refused: Array<{ why: string; types: object }> }
    const replica = Replica.create(parseSchema(JSON.stringify(fixture.schema)), fixture.docId, 1n)
    expect(describeModel(replica).types.Clip).toEqual(fixture.described.Clip)
    for (const refused of fixture.refused) {
      expect(() => parseSchema(JSON.stringify({ kdm: 1, kit: 'k', schemaVersion: 1, root: 'Doc', types: refused.types })), refused.why).toThrow()
    }
  })

  describe('read-only content (rule OM8)', () => {
    type Seed = { type?: string; id?: string; in?: string; fields?: Record<string, unknown>; text?: string; map?: string; key?: string; value?: unknown }
    type ReadOnlyFixture = { docId: string; seed: Seed[]; steps: Step[]; invalidSchemas: Array<{ why: string; schema: object }> }
    const fixture = (): ReadOnlyFixture => JSON.parse(crateFixture('read-only.json')) as ReadOnlyFixture
    const marked = (): Schema => parseSchema(crateFixture('read-only-schema.json'))

    /** The fixture's `seed`, written with the KDM's own transactions as a kit's import does. */
    function seeded(schema: Schema, seed: Seed[], docId: string): Replica {
      const replica = Replica.create(schema, docId, 1n)
      replica.transact(me, (tx) => {
        const split = (path: string): [string, string] => [path.slice(0, path.indexOf('.')), path.slice(path.indexOf('.') + 1)]
        for (const entry of seed) {
          if (entry.text !== undefined) tx.textInsert(...split(entry.text), 0, entry.value as string)
          else if (entry.map !== undefined) tx.mapSet(...split(entry.map), entry.key!, entry.value)
          else {
            const id = tx.create(entry.type!, entry.fields ?? {}, { id: entry.id })
            if (entry.in !== undefined) {
              const [owner, field] = split(entry.in)
              tx.listInsert(owner, field, tx.listItems(owner, field).length, id)
            }
          }
        }
      })
      return replica
    }

    it('answers the shared fixtures as the Rust crate does', async () => {
      const { docId, seed, steps } = fixture()
      const replica = seeded(marked(), seed, docId)
      for (const [index, step] of steps.entries()) {
        const before = replica.stateText()
        if (step.error) {
          const error = await runBatch(replicaTarget(replica), step.request).then(
            () => null,
            (failed: unknown) => failed,
          )
          expect(error, `step ${index}`).toBeInstanceOf(BatchError)
          expect({ code: (error as BatchError).code, index: (error as BatchError).index }, `step ${index}`).toEqual(step.error)
          expect(replica.stateText(), `step ${index} failed but changed the document`).toBe(before)
        } else {
          expect(await runBatch(replicaTarget(replica), step.request), `step ${index}`).toEqual(step.result)
        }
      }
    })

    it('refuses the schemas the Rust crate refuses', () => {
      for (const { why, schema } of fixture().invalidSchemas) expect(() => parseSchema(schema), why).toThrow()
    })

    it('describes read-only types and fields', () => {
      const types = describeModel(Replica.create(marked(), fixture().docId, 1n)).types
      expect(types.Kept.readOnly).toBe(true)
      expect(types.Item.readOnlyWhen).toEqual({ field: 'kind', values: ['opaque'] })
      expect(types.Item.readOnly).toBeUndefined()
      expect(types.SlideFile.fields.raw).toEqual({ kind: 'json', optional: true, readOnly: true })
      expect(types.SlideFile.fields.title.readOnly).toBeUndefined()
    })

    it('leaves documents readable with or without the marks', () => {
      const plain = JSON.parse(crateFixture('read-only-schema.json'))
      for (const def of Object.values(plain.types) as Array<Record<string, any>>) {
        delete def.readOnly
        delete def.readOnlyWhen
        for (const field of Object.values(def.fields) as Array<Record<string, unknown>>) delete field.readOnly
      }
      const { docId, seed } = fixture()
      const replica = seeded(marked(), seed, docId)
      const reloaded = Replica.load(parseSchema(plain), replica.snapshot(), 2n)
      expect(reloaded.stateJson()).toEqual(replica.stateJson())
      expect(Replica.load(marked(), reloaded.snapshot(), 3n).stateJson()).toEqual(replica.stateJson())
    })
  })
})

/**
 * A canonical state without the tree nodes that name no object of it. The Rust KDM takes a
 * deleted object's node out of its trees (plain model, kition-plan plans/2026-11-24-plain-model-design.md
 * section 1.1) and the shared state fixture says so; this TypeScript KDM keeps the node until its
 * read-only rewrite (step S4) reads states the same way.
 */
function withoutDeadNodes(state: unknown): unknown {
  const objects = (state as { objects: Record<string, Record<string, unknown>> }).objects
  const live = (nodes: unknown): unknown =>
    Array.isArray(nodes)
      ? nodes
          .filter((node: { object?: string }) => typeof node.object === 'string' && node.object in objects)
          .map((node: { object: string; children: unknown }) => ({ ...node, children: live(node.children) }))
      : nodes
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, object] of Object.entries(objects)) {
    out[id] = Object.fromEntries(
      Object.entries(object).map(([field, value]) =>
        Array.isArray(value) && value.every((node) => typeof node === 'object' && node !== null && 'object' in node && 'children' in node) && value.length > 0
          ? [field, live(value)]
          : [field, value],
      ),
    )
  }
  return { ...(state as object), objects: out }
}
