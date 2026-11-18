/**
 * Undo scopes (rule M12a): on one replica, the person's undo and an agent's undo each take back
 * only their own steps and keep the other's. The Rust twin is `crates/kition-kdm/tests/undo_scopes.rs`.
 */
import { describe, expect, it } from 'vitest'
import { agent, newDocId, Replica, system, type ObjectId, type Origin } from '../src/index'
import { me, pageWithShape, testSchema } from './helpers'

const theAgent = agent('user:test', 'ai/run')
const script: Origin = { kind: 'extension', principal: 'user:test' }

function fresh() {
  const replica = Replica.create(testSchema(), newDocId(), 1n)
  const { page, shape } = pageWithShape(replica)
  return { replica, page, shape }
}

const append = (replica: Replica, origin: Origin, shape: ObjectId, text: string) =>
  replica.transact(origin, (tx) => tx.textInsert(shape, 'label', tx.text(shape, 'label').length, text))

const setTitle = (replica: Replica, origin: Origin, page: ObjectId, title: string) => replica.transact(origin, (tx) => tx.set(page, 'title', title))

describe('undo scopes', () => {
  it('tracks list members through earlier edits and newly created owners', () => {
    const { replica, page, shape } = fresh()
    const [second, third] = replica.transact(system('fixture'), (tx) => {
      const b = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
      const c = tx.create('Shape', { kind: 'rect', x: 0, y: 0 })
      tx.listInsert(page, 'shapes', 1, b)
      tx.listInsert(page, 'shapes', 2, c)
      return [b, c]
    })
    replica.transact(theAgent, (tx) => {
      tx.listRemove(page, 'shapes', 0)
      tx.listMove(page, 'shapes', 0, 1)
    })
    const touches = replica.undoTouchesIn('agent')
    expect(touches).toContainEqual({ id: shape, fields: [] })
    expect(touches).toContainEqual({ id: second, fields: [] })
    expect(touches.some(({ id }) => id === third)).toBe(false)
    replica.transact(theAgent, (tx) => {
      const owner = tx.create('Page', { title: 'New' })
      tx.listInsert(owner, 'shapes', 0, shape)
      tx.listMove(owner, 'shapes', 0, 0)
      tx.listRemove(owner, 'shapes', 0)
    })
    expect(replica.undoTouchesIn('agent')).toContainEqual({ id: shape, fields: [] })
  })
  it('exposes the next grouped step fields without changing either history', () => {
    const { replica, page, shape } = fresh()
    expect(replica.undoTouchesIn('agent')).toEqual([])
    replica.beginUndoGroup()
    append(replica, theAgent, shape, 'Agent')
    setTitle(replica, theAgent, page, 'Title')
    replica.endUndoGroup()
    append(replica, me, shape, ' Person')
    const touches = replica.undoTouchesIn('agent')
    expect(touches).toHaveLength(2)
    expect(touches).toContainEqual({ id: shape, fields: ['label'] })
    expect(touches).toContainEqual({ id: page, fields: ['title'] })
    expect(replica.undoTouchesIn('agent')).toEqual(touches)
    expect(replica.undoIn('agent')).toBe(true)
    expect(replica.undoTouchesIn('agent')).toEqual([])
    expect(replica.redoTouchesIn('agent')).toEqual(touches)
    expect(replica.redoIn('agent')).toBe(true)
    expect(replica.undoTouchesIn('agent')).toEqual(touches)
  })
  it('the person’s undo skips the agent’s steps and keeps their text', () => {
    const { replica, shape } = fresh()
    append(replica, me, shape, 'Mine.')
    append(replica, theAgent, shape, ' Agent.')
    expect(replica.canUndoIn('agent')).toBe(true)
    expect(replica.undo()).toBe(true)
    expect(replica.text(shape, 'label')).toBe(' Agent.')
    expect(replica.redo()).toBe(true)
    expect(replica.text(shape, 'label')).toBe('Mine. Agent.')
  })

  it('the agent’s undo takes back only its step and keeps the person’s later typing', () => {
    const { replica, shape } = fresh()
    append(replica, theAgent, shape, 'Agent.')
    append(replica, me, shape, ' Mine.')
    expect(replica.undoIn('agent')).toBe(true)
    expect(replica.text(shape, 'label')).toBe(' Mine.')
    expect(replica.canUndoIn('agent')).toBe(false)
    expect(replica.canRedoIn('agent')).toBe(true)
    expect(replica.redoIn('agent')).toBe(true)
    expect(replica.text(shape, 'label')).toBe('Agent. Mine.')
  })

  it('an undo keeps a register the other scope wrote later', () => {
    const first = fresh()
    setTitle(first.replica, me, first.page, 'Mine')
    setTitle(first.replica, theAgent, first.page, 'Agent')
    expect(first.replica.undo()).toBe(true)
    expect(first.replica.get(first.page, 'title')).toBe('Agent')

    const second = fresh()
    setTitle(second.replica, theAgent, second.page, 'Agent')
    setTitle(second.replica, me, second.page, 'Mine')
    expect(second.replica.undoIn('agent')).toBe(true)
    expect(second.replica.get(second.page, 'title')).toBe('Mine')
    expect(second.replica.undo()).toBe(true)
    expect(second.replica.get(second.page, 'title')).not.toBe('Mine')
  })

  it('an undo group makes one step in each scope', () => {
    const { replica, shape } = fresh()
    replica.beginUndoGroup()
    append(replica, theAgent, shape, 'One.')
    append(replica, theAgent, shape, ' Two.')
    replica.endUndoGroup()
    append(replica, me, shape, ' Mine.')
    expect(replica.undoIn('agent')).toBe(true)
    expect(replica.text(shape, 'label')).toBe(' Mine.')
    expect(replica.canUndoIn('agent')).toBe(false)
  })

  it('scripts are the person’s steps and repairs are nobody’s', () => {
    const { replica, shape } = fresh()
    append(replica, script, shape, 'Script.')
    append(replica, system('repair'), shape, ' Repair.')
    expect(replica.canUndoIn('agent')).toBe(false)
    expect(replica.undo()).toBe(true)
    expect(replica.text(shape, 'label')).toBe(' Repair.')
  })

  it('a draft the agent made merges as the person’s step', () => {
    const { replica, shape } = fresh()
    const draft = replica.fork(9n)
    append(draft, theAgent, shape, 'Drafted.')
    replica.mergeChanges(draft.exportChanges(replica.version()), theAgent)
    expect(replica.text(shape, 'label')).toBe('Drafted.')
    expect(replica.canUndoIn('agent')).toBe(false)
    expect(replica.undo()).toBe(true)
    expect(replica.text(shape, 'label')).toBe('')
  })

  // The Rust twin is `replica::tests::a_transaction_keeps_no_notes_of_the_objects_it_creates`.
  it('keeps no notes of the registers of objects a transaction creates', () => {
    const replica = Replica.create(testSchema(), newDocId(), 1n)
    const notes = () => {
      const held = replica as unknown as { ownRegisters: Map<string, unknown>; localWrites: Map<string, unknown> }
      return [held.ownRegisters.size, held.localWrites.size]
    }
    const sheet = replica.transact(me, (tx) => {
      const id = tx.create('Sheet', {})
      for (let cell = 0; cell < 100; cell += 1) tx.mapSet(id, 'cells', `c${cell}`, cell)
      return id
    })
    expect(notes()).toEqual([0, 0])
    // A later write to one of them is noted, and an agent's later write survives the person's
    // undo of it, as before.
    replica.transact(me, (tx) => tx.mapSet(sheet, 'cells', 'c1', 'person'))
    expect(notes()).toEqual([1, 1])
    replica.transact(theAgent, (tx) => tx.mapSet(sheet, 'cells', 'c1', 'agent'))
    expect(replica.undo()).toBe(true)
    expect(replica.mapGet(sheet, 'cells', 'c1')).toBe('agent')
    expect(replica.undo()).toBe(true)
    expect(replica.exists(sheet)).toBe(false)
  })

  // The Rust twin is `replica::tests::an_import_before_any_undo_step_keeps_no_notes`.
  it('keeps no notes of an import made before any undo step', () => {
    const theirs = Replica.create(testSchema(), newDocId(), 1n)
    const sheet = theirs.transact(system('fixture'), (tx) => tx.create('Sheet', {}))
    const mine = Replica.load(testSchema(), theirs.snapshot(), 2n)
    const imported = () => (mine as unknown as { importedRegisters: Set<string> }).importedRegisters.size
    theirs.transact(me, (tx) => {
      for (let cell = 0; cell < 100; cell += 1) tx.mapSet(sheet, 'cells', `c${cell}`, cell)
    })
    mine.importChanges(theirs.exportChanges(mine.version()))
    expect(imported()).toBe(0)
    // After a step of its own, an import is noted, and the person's undo keeps the other
    // replica's later write, as before.
    mine.transact(me, (tx) => tx.mapSet(sheet, 'cells', 'c1', 'mine'))
    theirs.importChanges(mine.exportChanges(theirs.version()))
    theirs.transact(me, (tx) => tx.mapSet(sheet, 'cells', 'c1', 'theirs'))
    mine.importChanges(theirs.exportChanges(mine.version()))
    expect(imported()).toBe(1)
    expect(mine.undo()).toBe(true)
    expect(mine.mapGet(sheet, 'cells', 'c1')).toBe('theirs')
  })

  it('refuses an unknown scope', () => {
    const { replica } = fresh()
    expect(() => replica.undoIn('robot' as 'agent')).toThrow(/undo scope/)
  })
})
