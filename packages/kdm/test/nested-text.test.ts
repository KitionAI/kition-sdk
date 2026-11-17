import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, Replica, replicaTarget, runBatch, type BatchOp, type BatchRequest } from '../src/index'

const fixture = JSON.parse(readFileSync(new URL('../../../cases/regressions/issue-29-nested-text/input/model.json', import.meta.url), 'utf8')) as { schema: object; setup: BatchRequest }
async function document() {
  const replica = Replica.create(parseSchema(fixture.schema), newDocId(), 1n)
  await runBatch(replicaTarget(replica), fixture.setup)
  return replica
}

describe('nested text operations', () => {
  it('follows owned fields and Unicode character indexes', async () => {
    for (const [field, id] of [['body.paragraphs.0.text', 'p'], ['body.captions.main.text', 'caption']]) {
      for (const [op, expected] of [
        [{ op: 'text.insert', index: 2, text: '文' }, 'A🙂文éZ'],
        [{ op: 'text.delete', index: 1, count: 3 }, 'AZ'],
        [{ op: 'text.set', text: 'New🙂' }, 'New🙂'],
      ] as [BatchOp, string][]) {
        const replica = await document()
        await runBatch(replicaTarget(replica), { ops: [{ ...op, target: 'shape', field }] })
        expect(replica.text(id, 'text')).toBe(expected)
      }
    }
  })

  it('enforces boundaries atomically', async () => {
    for (const field of ['linked.paragraphs.0.text', 'body.paragraphs.1.text', 'body.paragraphs.0.protected', 'body.data.text', 'body.paragraphs.99.text']) {
      for (const op of ['text.insert', 'text.delete', 'text.set']) {
        const replica = await document()
        const before = replica.stateText()
        await expect(runBatch(replicaTarget(replica), { ops: [
          { op: 'text.set', target: 'p', field: 'text', text: 'Temporary' },
          { op, target: 'shape', field, text: 'New', index: 0, count: 1 },
        ] })).rejects.toMatchObject({ index: 1, code: field.endsWith('protected') ? 'read-only' : 'invalid-op' })
        expect(replica.stateText()).toBe(before)
      }
    }
  })
})
