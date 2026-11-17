/// <reference types="node" />
// Tool ids (KitObjectModel OM9; KHP A44, A46, A47, A48): the same fixtures as kition-kdm's
// `tests/tool_ids.rs`, messages included. Before, the object model answered and took only KDM
// object ids, so an agent met a kit's numbers in inspect, commands and diagnostics and UUIDs in
// query and batch.
import { describe, expect, it } from 'vitest'
import { BatchError, describeModel, diffStates, diffWithToolIds, parseSchema, Replica, runBatch, system, ToolIds, type BatchRequest, type BatchTarget, type ObjectId } from '../src/index'
import { crateFixture, numberToolIds } from './helpers'

type Step = { request: BatchRequest; result?: unknown; error?: { code: string; index: number | null; message: string }; diff?: unknown }
type Fixture = {
  schema: Record<string, unknown> & { types: Record<string, Record<string, unknown>> }
  steps: Step[]
  describe: { rootId: string; toolIds: Record<string, unknown> }
  schemaErrors: Array<{ type: string; toolId: unknown; message: string }>
}

const DOC_ID = '01920000-0000-7000-8000-0000000000cc'
const fixture = (): Fixture => JSON.parse(crateFixture('tool-ids.json')) as Fixture

function numbering(replica: Replica): BatchTarget {
  return {
    replica: () => replica,
    transact: (origin, write) => {
      replica.transact(origin, write)
      numberToolIds(replica)
    },
    command: (id, params) => {
      if (id === 'echo') return params
      throw new Error(`unknown command \`${id}\``)
    },
  }
}

describe('tool ids', () => {
  it('are what the object model answers and takes, as the Rust crate does', async () => {
    const data = fixture()
    const schema = parseSchema(data.schema)
    const replica = Replica.create(schema, DOC_ID, 1n)
    for (const [index, step] of data.steps.entries()) {
      const before = replica.stateJson()
      const answer = await runBatch(numbering(replica), step.request).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      if (step.error) {
        expect('error' in answer && answer.error, `step ${index}`).toBeInstanceOf(BatchError)
        const error = (answer as { error: BatchError }).error
        expect({ code: error.code, index: error.index, message: error.message }, `step ${index}`).toEqual(step.error)
        expect(replica.stateJson(), `step ${index} failed but changed the document`).toEqual(before)
      } else {
        expect(answer, `step ${index}`).toEqual({ result: step.result })
      }
      if (step.diff !== undefined) {
        const after = replica.stateJson()
        const diff = diffWithToolIds(diffStates(before, after), schema, ToolIds.ofState(schema, before), ToolIds.ofState(schema, after))
        expect(diff, `step ${index}: the comparison`).toEqual(step.diff)
      }
    }
    const described = describeModel(replica)
    expect(described.rootId).toBe(data.describe.rootId)
    for (const [ty, tool] of Object.entries(data.describe.toolIds)) expect(described.types[ty].toolId, ty).toEqual(tool)
    expect(described.types.Tag.toolId).toBeUndefined()
  })

  it('are checked in a schema', () => {
    const data = fixture()
    for (const entry of data.schemaErrors) {
      const schema = structuredClone(data.schema)
      schema.types[entry.type].toolId = entry.toolId
      expect(() => parseSchema(schema), JSON.stringify(entry)).toThrow(entry.message)
    }
  })

  it('leave a schema without them answering object ids', async () => {
    const schema = structuredClone(fixture().schema)
    for (const ty of ['Frame', 'Cell', 'Pin', 'Flag']) delete schema.types[ty].toolId
    const replica = Replica.create(parseSchema(schema), DOC_ID, 1n)
    const answer = await runBatch(numbering(replica), {
      ops: [
        { op: 'create', type: 'Doc', id: 'doc' },
        { op: 'create', type: 'Frame', id: 'f1', in: 'doc.frames', ref: '$f1' },
      ],
      load: [{ target: 'root' }],
    })
    expect(answer.results).toEqual(['doc', 'f1'])
    expect(answer.refs).toEqual({ $f1: 'f1' })
    expect(answer.loaded[0].fields.frames).toEqual(['f1'])
    const gone = await runBatch(numbering(replica), { ops: [{ op: 'delete', target: 'frame:9' }] }).catch((error: BatchError) => error)
    expect(gone).toBeInstanceOf(BatchError)
    expect(ToolIds.ofReplica(replica).isActive()).toBe(false)
  })
})
