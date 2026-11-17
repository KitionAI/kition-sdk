import { describe, expect, it } from 'vitest'
import { agent, Network, person } from '../src/index'
import { boardSchema, BoardModel } from './board'

const alice = person('user:alice')
const bob = person('user:bob')
const rect = { kind: 'rect' as const, x: 0, y: 0, w: 100, h: 50 }

function twoBoards(seed = 1) {
  const net = new Network(boardSchema, 2, seed)
  const a = BoardModel.create(net.replicas[0], alice)
  net.syncAll()
  return { net, a, b: BoardModel.open(net.replicas[1]) }
}

describe('whiteboard on the KDM', () => {
  it('keeps a concurrent move and recolour of one element (whole-record diffs lose one)', () => {
    const { net, a, b } = twoBoards()
    const id = a.add(rect, alice)
    net.syncAll()
    a.update(id, { x: 300, y: 200 }, alice)
    b.update(id, { fill: '#5645d4' }, bob)
    net.syncAll()
    net.converged()
    expect(b.elements()[0]).toMatchObject({ x: 300, y: 200, fill: '#5645d4' })
  })

  it('gives elements created in the same millisecond on two replicas distinct ids', () => {
    const { net, a, b } = twoBoards(2)
    const first = a.add(rect, alice)
    const second = b.add({ ...rect, kind: 'ellipse' }, bob)
    expect(first).not.toBe(second)
    net.syncAll()
    net.converged()
    expect(a.elements().map((element) => element.id).sort()).toEqual([first, second].sort())
  })

  it('never duplicates elements when both people bring different ones to the front', () => {
    const { net, a, b } = twoBoards(3)
    const ids = [a.add(rect, alice), a.add(rect, alice), a.add(rect, alice)]
    net.syncAll()
    a.bringToFront(ids[0], alice)
    b.bringToFront(ids[1], bob)
    net.syncAll()
    net.converged()
    expect(a.elements().map((element) => element.id).sort()).toEqual([...ids].sort())
  })

  it('undoes my move without undoing a collaborator’s recolour', () => {
    const { net, a, b } = twoBoards(4)
    const id = a.add(rect, alice)
    net.syncAll()
    a.update(id, { x: 400 }, alice)
    net.syncAll()
    b.update(id, { fill: '#ff0000' }, bob)
    net.syncAll()
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    net.converged()
    expect(b.elements()[0]).toMatchObject({ x: 0, fill: '#ff0000' })
  })

  it('removes an element everywhere even if someone edits it meanwhile', () => {
    const { net, a, b } = twoBoards(5)
    const id = a.add(rect, alice)
    net.syncAll()
    a.remove(id, alice)
    b.update(id, { x: 10 }, bob)
    net.syncAll()
    net.converged()
    expect(b.elements()).toEqual([])
  })

  it('records agent edits through the same transactions', () => {
    const { net, a, b } = twoBoards(6)
    const id = a.add({ ...rect, kind: 'text' }, alice)
    net.syncAll()
    b.setText(id, 'Agenda 议程', agent('user:bob'))
    net.syncAll()
    net.converged()
    expect(a.elements()[0].text).toBe('Agenda 议程')
  })
})
