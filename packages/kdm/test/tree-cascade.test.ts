import { expect, it } from 'vitest'
import { parseSchema, Replica, replicaTarget, runBatch } from '../src/index'

it('cascades tree descendants only when the tree opts in', async () => {
  for (const cascade of [false, true]) {
    const replica = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Root', types: {
      Root: { fields: { nodes: { kind: 'tree', of: 'Node', ...(cascade ? { cascade: true } : {}) } } }, Node: { fields: { name: { kind: 'string' } } },
    } }), '01920000-0000-7000-8000-0000000000bb', 1n)
    await runBatch(replicaTarget(replica), { ops: [
      { op: 'create', type: 'Root', id: 'r' },
      { op: 'create', type: 'Node', id: 'p', in: 'root.nodes', fields: { name: 'parent' } },
      { op: 'create', type: 'Node', id: 'c', in: 'root.nodes', parent: 'p', fields: { name: 'child' } },
      { op: 'create', type: 'Node', id: 'g', in: 'root.nodes', parent: 'c', fields: { name: 'grandchild' } },
    ] })
    const before = replica.stateText()
    if (!cascade) {
      await expect(runBatch(replicaTarget(replica), { ops: [{ op: 'delete', target: 'p' }] })).rejects.toMatchObject({ code: 'invalid-value' })
      expect(replica.stateText()).toBe(before)
    } else {
      await runBatch(replicaTarget(replica), { ops: [{ op: 'delete', target: 'p' }] })
      expect(replica.objectsOfType('Node')).toEqual([])
      expect(replica.undo()).toBe(true)
      expect(replica.stateText()).toBe(before)
    }
  }
})
