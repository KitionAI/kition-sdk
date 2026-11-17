// @vitest-environment jsdom
/**
 * The worker's own replica helpers, tested directly against fake `KitModuleDocument`-shaped objects
 * (no real wasm engine, no real worker thread): `replicaDocId` reads the SDK's optional `docId`
 * getter, and `replicaBlobsSince` prefers the SDK's optional `blobsSince(since)` over its whole
 * `blobs()` bundle when the SDK offers it (protocol minor version 1.3).
 */
import { describe, expect, it } from 'vitest'
import type { KitModuleDocument } from './kitModule'
import { premisePlan, replicaBlobsSince, replicaDocId } from './kitEngine.worker'
import { newDocId, parseSchema, Replica, system } from '@kition/kdm'
import { kitEngineClass, type KitModel } from '@kition/kit-engine'

function fakeDoc(overrides: Partial<KitModuleDocument> = {}): KitModuleDocument {
  return {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: () => '{}',
    inspect: () => '{}',
    commands: () => '[]',
    save: () => new Uint8Array(),
    markSaved: () => undefined,
    free: () => undefined,
    ...overrides,
  }
}

describe('replicaDocId', () => {
  it('stops terminal premise plans before reading a closed engine', async () => {
    const raw = { kdm: 1, kit: 'kit.plan', schemaVersion: 1, root: 'Root', types: { Root: { fields: { value: { kind: 'integer' } } } } }
    const schema = parseSchema(raw)
    const model: KitModel<null> = {
      schema, load: () => null, apply: () => ({ kind: 'none' }), commands: () => [],
      import: (_name, _bytes, actor) => Replica.createWith(schema, newDocId(), actor, system('open'), tx => tx.create('Root', { value: 0 })).replica,
      export: () => new Uint8Array(),
      command: () => { throw new Error('unexpected model command') },
    }
    const Document = kitEngineClass(model)
    for (const action of ['begin', 'advance']) {
      const doc = Document.open('test', new Uint8Array()) as KitModuleDocument
      const fork = doc.forkForPremises!.bind(doc)
      let released = 0
      let closed = false
      const executed: string[] = []
      doc.forkForPremises = () => {
        const scratch = fork()
        const state = scratch.editorState!.bind(scratch)
        const changes = scratch.exportChanges!.bind(scratch)
        const free = scratch.free.bind(scratch)
        scratch.executeAs = (command) => {
          if (closed) throw new Error('executing after close')
          executed.push(command)
          if (command === 'close.fail') throw new Error('close failed')
          closed = command === 'close'
          return JSON.stringify({ closed })
        }
        scratch.editorState = () => { if (closed) throw new Error('state after close'); return state() }
        scratch.exportChanges = (since) => { if (closed) throw new Error('model after close'); return changes(since) }
        scratch.free = () => { released++; free() }
        return scratch
      }
      try {
        await expect(premisePlan({ action: 'begin', steps: [{ command: 'close.fail' }, { command: 'later' }] }, doc, raw)).rejects.toThrow('close failed')
        expect(closed).toBe(false)
        expect(released).toBe(1)
        executed.length = 0
        const first = await premisePlan({ action: 'begin', steps: [{ command: 'close.cancel' }, { command: 'before' }] }, doc, raw) as { token: string; closed?: boolean }
        expect(first.closed).not.toBe(true)
        expect(executed).toEqual(['close.cancel', 'before'])
        if (action === 'begin') await premisePlan({ action: 'end', token: first.token })
        const terminal = await premisePlan({ action, token: first.token, steps: [{ command: 'close' }, { command: 'later' }] }, doc, raw)
        expect(terminal).toEqual({ closed: true })
        expect(executed).toEqual(['close.cancel', 'before', 'close'])
        expect(released).toBe(action === 'begin' ? 3 : 2)
        await expect(premisePlan({ action: 'read', token: first.token, method: 'under' })).rejects.toThrow('unavailable')
      } finally {
        doc.free()
      }
    }
  })
  it('advances a cached premise plan once per step with cumulative changes', async () => {
    const raw = { kdm: 1, kit: 'kit.plan', schemaVersion: 1, root: 'Root', types: { Root: { fields: { value: { kind: 'integer' } } } } }
    const schema = parseSchema(raw)
    let executions = 0
    const model: KitModel<null> = {
      schema, load: () => null, apply: () => ({ kind: 'none' }), commands: () => [],
      import: (_name, _bytes, actor) => Replica.createWith(schema, newDocId(), actor, system('open'), tx => tx.create('Root', { value: 0 })).replica,
      export: () => new Uint8Array(),
      command: (_view, replica, _command, _params, origin) => {
        executions++
        const root = replica.objectsOfType('Root')[0]
        return replica.transact(origin, tx => tx.set(root, 'value', Number(replica.get(root, 'value')) + 1))
      },
      premise: (_view, replica, _method, params) => ({ ...params, value: replica.get(replica.objectsOfType('Root')[0], 'value') }),
    }
    const Document = kitEngineClass(model)
    const doc = Document.open('test', new Uint8Array()) as KitModuleDocument
    const first = await premisePlan({ action: 'begin', steps: [{ command: 'increment' }], step: 1 }, doc, raw) as { token: string }
    try {
      const next = await premisePlan({ action: 'advance', token: first.token, steps: [{ command: 'increment' }], step: 2 }) as { token: string }
      expect(next.token).toBe(first.token)
      const answer = await premisePlan({ action: 'read', token: next.token, method: 'under', params: {} })
      expect(answer).toMatchObject({ step: 2, value: 2, changes: { changed: [{ edits: [{ before: 0, after: 2 }] }] } })
      expect(executions).toBe(2)
      expect(JSON.parse(doc.premiseRead!('under', '{}'))).toMatchObject({ value: 0 })
    } finally {
      await premisePlan({ action: 'end', token: first.token })
      doc.free()
    }
    await expect(premisePlan({ action: 'advance', token: first.token, steps: [] })).rejects.toThrow(/unavailable/)
  })
  it('keeps a premise plan cached across reads and discards all its writes', async () => {
    const raw = { kdm: 1, kit: 'kit.plan', schemaVersion: 1, root: 'Root', types: { Root: { fields: { value: { kind: 'integer' } } } } }
    const schema = parseSchema(raw)
    const model: KitModel<null> = {
      schema, load: () => null, apply: () => ({ kind: 'none' }), commands: () => [],
      import: (_name, _bytes, actor) => Replica.createWith(schema, newDocId(), actor, system('open'), tx => tx.create('Root', { value: 0 })).replica,
      export: () => new Uint8Array(),
      command: (_view, replica, _command, _params, origin) => replica.transact(origin, tx => tx.set(replica.objectsOfType('Root')[0], 'value', 1)),
      premise: (_view, replica, _method, params) => ({ ...params, value: replica.get(replica.objectsOfType('Root')[0], 'value') }),
    }
    const Document = kitEngineClass(model)
    const doc = Document.open('test', new Uint8Array()) as KitModuleDocument
    const plan = await premisePlan({ action: 'begin', steps: [{ command: 'set' }], step: 1 }, doc, raw) as { token: string }
    try {
      const read = { action: 'read', token: plan.token, method: 'under', params: {} }
      const answer = await premisePlan(read) as { step: number; value: number; changes: unknown }
      expect(answer).toMatchObject({ step: 1, value: 1 })
      expect(answer.changes).toBeTruthy()
      expect(await premisePlan(read)).toEqual(answer)
      expect(JSON.parse(doc.premiseRead!('under', '{}'))).toMatchObject({ value: 0 })
      await expect(premisePlan({ ...read, method: 'model.batch', params: { ops: [{ op: 'delete', target: 'root' }] } })).rejects.toThrow(/reads/)
    } finally {
      await premisePlan({ action: 'end', token: plan.token })
    }
    await expect(premisePlan({ action: 'read', token: plan.token, method: 'under' })).rejects.toThrow(/unavailable/)
    doc.free()
  })
  it('reads the SDK\'s own docId when it has one', () => {
    expect(replicaDocId(fakeDoc({ docId: 'room-1' }))).toBe('room-1')
  })

  it('answers null for an SDK with no docId', () => {
    expect(replicaDocId(fakeDoc())).toBeNull()
  })
})

describe('replicaBlobsSince', () => {
  it('prefers the SDK\'s blobsSince(since) over its whole blobs() bundle', () => {
    const calls: Uint8Array[] = []
    const doc = fakeDoc({
      blobsSince: (since) => {
        calls.push(since)
        return new Uint8Array([since.byteLength])
      },
      blobs: () => new Uint8Array([99]),
    })
    const since = new Uint8Array([1, 2, 3])
    expect(replicaBlobsSince(doc, since)).toEqual(new Uint8Array([3]))
    expect(calls).toEqual([since])
  })

  it('falls back to blobs() for an SDK with no blobsSince', () => {
    const doc = fakeDoc({ blobs: () => new Uint8Array([7, 8]) })
    expect(replicaBlobsSince(doc, new Uint8Array([1]))).toEqual(new Uint8Array([7, 8]))
  })

  it('fails for an SDK with neither blobsSince nor blobs', () => {
    expect(() => replicaBlobsSince(fakeDoc(), new Uint8Array())).toThrow(/replica/)
  })
})
