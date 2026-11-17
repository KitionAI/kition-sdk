import { expect, it } from 'vitest'
import { parseSchema, Replica, replicaTarget, runBatch } from '../src/index'

it('checks nested numeric members and permits container alternatives', async () => {
  const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Root', types: { Root: { fields: {
    data: { kind: 'json', minimum: 0, members: { 'motion.shutter': { minimum: 0, maximum: 1 }, 'weights[]': { minimum: 0 }, 'layers[].opacity': { minimum: 0, maximum: 1 } } },
  } } } }), '01920000-0000-7000-8000-0000000000bb', 1n)
  await runBatch(replicaTarget(replica), { ops: [{ op: 'create', type: 'Root', id: 'r', fields: { data: { motion: { shutter: 0.5 }, weights: [2, 2, 2], layers: [{ opacity: 0.5 }, { opacity: 1 }] } } }] })
  for (const [field, value] of [['data.motion.shutter', -1], ['data.weights.1', -1], ['data.layers.0.opacity', 2], ['data', { motion: { shutter: -1 } }], ['data', { weights: [2, -1, 2] }], ['data', { layers: [{ opacity: -1 }] }], ['data.motion.shutter', 'auto'], ['data.weights.1', null], ['data.layers.0.opacity', false]] as const) {
    const before = replica.stateText()
    await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field, value }] })).rejects.toMatchObject({ code: 'invalid-value' })
    expect(replica.stateText()).toBe(before)
  }
  for (const value of [[2, 2, 2], { motion: { shutter: {} } }, 'auto']) {
    await runBatch(replicaTarget(replica), { ops: [{ op: 'set', target: 'root', field: 'data', value }] })
  }
})
