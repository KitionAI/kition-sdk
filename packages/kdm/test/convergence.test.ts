import { describe, expect, it } from 'vitest'
import { Network, Rng, system, type Tx } from '../src/index'
import { me, pageWithShape, reasonOf, testSchema } from './helpers'

const network = (count: number, seed: number) => new Network(testSchema(), count, seed)

/** A failing transaction on replica 0 that first runs `edit`. */
function failOnFirst(net: Network, edit: (tx: Tx) => void): void {
  expect(
    reasonOf(() =>
      net.replicas[0].transact(me, (tx) => {
        edit(tx)
        tx.create('Shape', { kind: 'star', x: 0, y: 0 })
      }),
    ),
  ).toBe('invalid-value')
}

describe('convergence', () => {
  it('keeps edits to different fields of one object', () => {
    const net = network(2, 1)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'x', 111))
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'fill', '#000000'))
    net.syncAll()
    net.converged()
    expect(net.replicas[1].get(shape, 'x')).toBe(111)
    expect(net.replicas[0].get(shape, 'fill')).toBe('#000000')
  })

  it('resolves one field to one value everywhere', () => {
    const net = network(3, 2)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas.forEach((replica, index) => replica.transact(me, (tx) => tx.set(shape, 'x', index + 1)))
    net.syncAll()
    net.converged()
  })

  it('gives concurrent creations distinct ids', () => {
    const net = network(2, 3)
    const { page } = pageWithShape(net.replicas[0])
    net.syncAll()
    const created = net.replicas.map((replica) =>
      replica.transact(me, (tx) => {
        const shape = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
        tx.listInsert(page, 'shapes', 0, shape)
        return shape
      }),
    )
    expect(created[0]).not.toBe(created[1])
    net.syncAll()
    net.converged()
    expect(net.replicas[0].list(page, 'shapes')).toHaveLength(3)
  })

  it('keeps both concurrent insertions at one text position', () => {
    const net = network(2, 4)
    const { shape } = pageWithShape(net.replicas[0])
    net.replicas[0].transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'ab'))
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.textInsert(shape, 'label', 1, '季度😀'))
    net.replicas[1].transact(me, (tx) => tx.textInsert(shape, 'label', 1, 'XY'))
    net.syncAll()
    net.converged()
    const text = net.replicas[0].text(shape, 'label')
    expect(text).toMatch(/^a.*b$/u)
    expect(text).toContain('季度😀')
    expect(text).toContain('XY')
  })

  it('never duplicates items under concurrent reorders', () => {
    const net = network(2, 5)
    const { page } = pageWithShape(net.replicas[0])
    net.replicas[0].transact(me, (tx) => {
      for (let index = 1; index < 4; index += 1) tx.listInsert(page, 'shapes', index, tx.create('Shape', { kind: 'rect', x: index, y: 0 }))
    })
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.listMove(page, 'shapes', 0, 3))
    net.replicas[1].transact(me, (tx) => tx.listMove(page, 'shapes', 0, 1))
    net.syncAll()
    net.converged()
    expect(new Set(net.replicas[0].list(page, 'shapes')).size).toBe(4)
  })

  it('converges concurrent moves that would form a cycle to a tree', () => {
    const net = network(2, 6)
    const { page, shape } = pageWithShape(net.replicas[0])
    const [a, b] = net.replicas[0].transact(me, (tx) => [tx.treeCreate(page, 'outline', null, shape), tx.treeCreate(page, 'outline', null, shape)])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.treeMove(page, 'outline', a, b))
    net.replicas[1].transact(me, (tx) => tx.treeMove(page, 'outline', b, a))
    net.syncAll()
    net.converged()
    const nodes = net.replicas[0].tree(page, 'outline')
    expect(nodes).toHaveLength(2)
    expect(nodes.filter((entry) => entry.parent === null)).toHaveLength(1)
  })

  it('names a redone object once after the repair when a concurrent move kept its old node (M10b)', () => {
    const net = network(2, 9)
    const { page, shape } = pageWithShape(net.replicas[0])
    const nodeOf = (tx: Tx, object: string) => {
      const entry = tx.tree(page, 'outline').find((e) => e.object === object)
      if (!entry) throw new Error(`${object} has no node`)
      return entry.node
    }
    const namedTwice = (replica: (typeof net.replicas)[number]) => {
      const counts = new Map<string, number>()
      for (const entry of replica.tree(page, 'outline')) counts.set(entry.object, (counts.get(entry.object) ?? 0) + 1)
      return [...counts].filter(([, count]) => count > 1)
    }
    const { frame, child } = net.replicas[0].transact(me, (tx) => {
      const frame = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
      const child = tx.create('Shape', { kind: 'ellipse', x: 1, y: 1 })
      const node = tx.treeCreate(page, 'outline', null, frame)
      tx.treeCreate(page, 'outline', null, shape)
      tx.treeCreate(page, 'outline', node, child)
      return { frame, child }
    })
    const added = net.replicas[0].transact(me, (tx) => {
      const added = tx.create('Shape', { kind: 'rect', x: 2, y: 2 })
      const node = tx.treeCreate(page, 'outline', null, added)
      tx.treeMove(page, 'outline', nodeOf(tx, child), node)
      return added
    })
    net.syncAll()
    expect(net.replicas[0].undo()).toBe(true)
    for (let x = 0; x < 4; x++) net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', x))
    net.replicas[1].transact(me, (tx) => tx.treeMove(page, 'outline', nodeOf(tx, added), nodeOf(tx, frame)))
    expect(net.replicas[0].redo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(namedTwice(net.replicas[0])).toEqual([[added, 2]])

    for (const replica of net.replicas) expect(replica.transact(system('repair'), (tx) => tx.treeDedupe(page, 'outline'))).toBe(1)
    net.syncAll()
    net.converged()
    for (const replica of net.replicas) {
      expect(namedTwice(replica)).toEqual([])
      const entries = replica.tree(page, 'outline')
      const kept = entries.find((e) => e.object === added)?.node
      expect(entries.find((e) => e.object === child)?.parent?.id).toBe(kept?.id)
      expect(entries).toHaveLength(4)
    }
    expect(net.replicas[0].transact(system('repair'), (tx) => tx.treeDedupe(page, 'outline'))).toBe(0)
  })

  it('lets a delete win over a concurrent edit', () => {
    const net = network(2, 7)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.delete(shape))
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', 5))
    net.syncAll()
    net.converged()
    expect(net.replicas[1].exists(shape)).toBe(false)
  })

  it('keeps a collaborator’s later change when undoing', () => {
    const net = network(2, 8)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'x', 50))
    net.syncAll()
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'y', 70))
    net.syncAll()
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(net.replicas[1].get(shape, 'x')).toBe(10)
    expect(net.replicas[1].get(shape, 'y')).toBe(70)
  })

  it('keeps a collaborator’s later write to the same field through undo and redo', () => {
    const net = network(2, 8)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'x', 50))
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'y', 60))
    net.syncAll()
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', 70))
    net.syncAll()
    // Undoing y reverts y alone; undoing x keeps the collaborator's later 70.
    expect(net.replicas[0].undo()).toBe(true)
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(net.replicas[1].get(shape, 'x')).toBe(70)
    expect(net.replicas[1].get(shape, 'y')).toBe(20)
    // Redo restores the person's y, and still keeps the collaborator's x.
    expect(net.replicas[0].redo()).toBe(true)
    expect(net.replicas[0].redo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(net.replicas[0].get(shape, 'x')).toBe(70)
    expect(net.replicas[0].get(shape, 'y')).toBe(60)
    // The kept value is not an undo step of its own.
    expect(net.replicas[0].undo()).toBe(true)
    expect(net.replicas[0].get(shape, 'y')).toBe(20)
  })

  it('undoes a field another replica put back to this replica’s value', () => {
    const net = network(2, 8)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'x', 50))
    net.syncAll()
    // Replica 1 writes x and takes it back: the value is replica 0's own again.
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', 70))
    expect(net.replicas[1].undo()).toBe(true)
    net.syncAll()
    expect(net.replicas[0].get(shape, 'x')).toBe(50)
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(net.replicas[1].get(shape, 'x')).toBe(10)
  })

  it('still undoes a field nobody else wrote later', () => {
    const net = network(2, 8)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', 70))
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.set(shape, 'x', 80))
    expect(net.replicas[0].undo()).toBe(true)
    expect(net.replicas[0].get(shape, 'x')).toBe(70)
  })

  it('reports the objects an import changed', () => {
    const net = network(2, 9)
    const { page, shape } = pageWithShape(net.replicas[0])
    net.replicas[0].takeChanged()
    const changed = net.replicas[1].importChanges(net.replicas[0].exportChanges(net.replicas[1].version()))
    expect(changed.has(page) && changed.has(shape)).toBe(true)
    net.syncAll()
    net.replicas[0].transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'x'))
    expect([...net.replicas[0].takeChanged()]).toEqual([shape])
    expect([...net.replicas[1].importChanges(net.replicas[0].exportChanges(net.replicas[1].version()))]).toEqual([shape])
  })

  it('converges random edits in any delivery order', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const net = network(3, seed)
      const { page } = pageWithShape(net.replicas[0])
      net.syncAll()
      const rng = new Rng(seed + 1000)
      for (let round = 0; round < 8; round += 1) {
        for (const replica of net.replicas) {
          const shapes = replica.list(page, 'shapes')
          const pick = rng.below(4)
          const n = rng.below(1000)
          const target = shapes[rng.below(shapes.length)]
          const at = rng.below(shapes.length)
          replica.transact(me, (tx) => {
            if (pick === 0) tx.listInsert(page, 'shapes', at, tx.create('Shape', { kind: 'rect', x: n, y: 0 }))
            else if (pick === 1) tx.set(target, 'x', n)
            else if (pick === 2) tx.textInsert(target, 'label', 0, `${n}字`)
            else tx.listMove(page, 'shapes', at, 0)
          })
        }
        const from = rng.below(3)
        net.deliver(from, (from + 1 + rng.below(2)) % 3)
      }
      net.syncAll()
      expect(() => net.converged(), `seed ${seed}`).not.toThrow()
    }
  })

  it('does not let a failed transaction overwrite a concurrent register write', () => {
    const net = network(2, 10)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[1].transact(me, (tx) => tx.set(shape, 'x', 50))
    failOnFirst(net, (tx) => tx.set(shape, 'x', 99))
    net.syncAll()
    net.converged()
    expect(net.replicas[0].get(shape, 'x')).toBe(50)
  })

  it('keeps a collaborator’s edits to an object whose deletion failed', () => {
    const net = network(2, 11)
    const { shape } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[1].transact(me, (tx) => {
      tx.textInsert(shape, 'label', 0, 'kept')
      tx.set(shape, 'y', 77)
    })
    failOnFirst(net, (tx) => tx.delete(shape))
    net.syncAll()
    net.converged()
    expect(net.replicas[0].text(shape, 'label')).toBe('kept')
    expect(net.replicas[0].get(shape, 'y')).toBe(77)
  })

  it('does not resurrect a concurrently removed item when a list removal fails', () => {
    const net = network(2, 12)
    const { page } = pageWithShape(net.replicas[0])
    net.syncAll()
    net.replicas[1].transact(me, (tx) => tx.listRemove(page, 'shapes', 0))
    failOnFirst(net, (tx) => tx.listRemove(page, 'shapes', 0))
    net.syncAll()
    net.converged()
    expect(net.replicas[0].list(page, 'shapes')).toEqual([])
  })

  it('reports bad input to the test network as errors', () => {
    expect(reasonOf(() => new Network(testSchema(), 0, 1))).toBe('out-of-range')
    const net = network(2, 13)
    expect(reasonOf(() => net.deliver(0, 2))).toBe('out-of-range')
    expect(reasonOf(() => net.deliver(5, 0))).toBe('out-of-range')
    expect(reasonOf(() => net.deliver(-1, 0))).toBe('out-of-range')
    net.replicas.length = 0
    expect(() => net.converged()).toThrow()
    expect(() => net.syncAll()).not.toThrow()
    expect(new Rng(1).below(0)).toBe(0)
  })

  it('draws the same numbers as the Rust generator', () => {
    // `kition_kdm::testing::Rng::new(1000)`: three `next_u64` calls, then `below(7)`.
    const rng = new Rng(1000)
    expect([rng.nextU64(), rng.nextU64(), rng.nextU64()]).toEqual([13276342107030193692n, 16188565656725893089n, 8469224432189660779n])
    expect(rng.below(7)).toBe(6)
  })
})
