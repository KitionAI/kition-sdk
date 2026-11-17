import { expect, it } from 'vitest'
import { parseSchema, Replica, replicaTarget, runBatch } from '../src/index'

it('checks nullable nested integer members and map keys/wildcard entries', async () => {
  const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Root', types: { Root: { fields: {
    data: { kind: 'json', members: { 'doc.revision': { minimum: 0, multipleOf: 1, nullable: true } } },
    parts: { kind: 'map', members: { style: { minimum: 0, multipleOf: 1 }, '*.count': { minimum: 0, multipleOf: 1, nullable: true } } },
  } } } }), '01920000-0000-7000-8000-0000000000bb', 1n)
  await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Root', id: 'r', fields: { data: { doc: { revision: null } } } }] })
  for (const [key, value, valid] of [['style', 2, true], ['style', 0.5, false], ['style', null, false], ['other', { count: null }, true], ['other', { count: 1.5 }, false]] as const) {
    const before = replica.stateText()
    const result = runBatch(replicaTarget(replica), { ops: [{ op: 'map.set', target: 'root', field: 'parts', key, value }] })
    if (valid) await result
    else {
      await expect(result).rejects.toMatchObject({ code: 'invalid-value' })
      expect(replica.stateText()).toBe(before)
    }
  }
  await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field: 'data.doc.revision', value: 0.5 }] })).rejects.toMatchObject({ code: 'invalid-value' })
})
