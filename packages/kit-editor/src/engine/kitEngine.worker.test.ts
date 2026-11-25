// @vitest-environment jsdom
/**
 * The worker's own replica helpers, tested directly against fake `KitModuleDocument`-shaped objects
 * (no real wasm engine, no real worker thread): `replicaDocId` reads the SDK's optional `docId`
 * getter, and `replicaBlobsSince` prefers the SDK's optional `blobsSince(since)` over its whole
 * `blobs()` bundle when the SDK offers it.
 */
import { describe, expect, it } from 'vitest'
import type { KitModuleDocument } from './kitModule'
import { premisePlan, replicaBlobsSince, replicaDocId } from './kitEngine.worker'

/**
 * A document of one counter as an engine answers it: its replica's version is the number of edits
 * (`[seq]`), `changesSince` answers the counter's edit since a version, `forkForPremises` copies it
 * with its history, and a command (`executeAs`) runs `command` (default: adds one).
 */
function counterDoc(command: (doc: { value: number }, name: string) => string = (doc) => (doc.value++, '{}'), history: number[] = [0]): KitModuleDocument & { value: number } {
  const doc = fakeDoc({
    version: () => new Uint8Array([history.length - 1]),
    executeAs: (name) => {
      const answer = command(doc, name)
      if (doc.value !== history[history.length - 1]) history.push(doc.value)
      return answer
    },
    changesSince: (since) => {
      const was = history[since[0] ?? 0]
      if (was === undefined) return JSON.stringify({ changes: null, unavailable: 'not held' })
      const changed = was === doc.value ? [] : [{ id: 'root', type: 'Root', fields: ['value'], edits: [{ field: 'value', before: was, after: doc.value }] }]
      return JSON.stringify({ changes: { created: [], changed, moved: [], deleted: [] } })
    },
    editorState: () => 'null',
    premiseRead: (_method, params) => JSON.stringify({ ...JSON.parse(params), value: doc.value }),
    modelBatch: (request) => {
      if (JSON.parse(request).ops?.length) throw new Error(JSON.stringify({ code: 'read-only', index: null, message: 'a premise plan only reads' }))
      return JSON.stringify({ refs: {}, results: [], loaded: [] })
    },
    forkForPremises: () => {
      const copy = counterDoc(command, [...history])
      copy.value = doc.value
      return copy
    },
  }) as KitModuleDocument & { value: number }
  doc.value = history[history.length - 1]!
  return doc
}

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
    for (const action of ['begin', 'advance']) {
      let released = 0
      let closed = false
      const executed: string[] = []
      const doc = counterDoc((_doc, command) => {
        if (closed) throw new Error('executing after close')
        executed.push(command)
        if (command === 'close.fail') throw new Error('close failed')
        closed = command === 'close'
        return JSON.stringify({ closed })
      })
      const fork = doc.forkForPremises!.bind(doc)
      doc.forkForPremises = () => {
        const scratch = fork()
        const state = scratch.editorState!.bind(scratch)
        const changes = scratch.changesSince!.bind(scratch)
        const free = scratch.free.bind(scratch)
        scratch.editorState = () => { if (closed) throw new Error('state after close'); return state() }
        scratch.changesSince = (since) => { if (closed) throw new Error('model after close'); return changes(since) }
        scratch.free = () => { released++; free() }
        return scratch
      }
      try {
        await expect(premisePlan({ action: 'begin', steps: [{ command: 'close.fail' }, { command: 'later' }] }, doc)).rejects.toThrow('close failed')
        expect(closed).toBe(false)
        expect(released).toBe(1)
        executed.length = 0
        const first = await premisePlan({ action: 'begin', steps: [{ command: 'close.cancel' }, { command: 'before' }] }, doc) as { token: string; closed?: boolean }
        expect(first.closed).not.toBe(true)
        expect(executed).toEqual(['close.cancel', 'before'])
        if (action === 'begin') await premisePlan({ action: 'end', token: first.token })
        const terminal = await premisePlan({ action, token: first.token, steps: [{ command: 'close' }, { command: 'later' }] }, doc)
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
    let executions = 0
    const doc = counterDoc((counter) => {
      executions++
      counter.value++
      return '{}'
    })
    const first = await premisePlan({ action: 'begin', steps: [{ command: 'increment' }], step: 1 }, doc) as { token: string }
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
    const doc = counterDoc((counter) => ((counter.value = 1), '{}'))
    const plan = await premisePlan({ action: 'begin', steps: [{ command: 'set' }], step: 1 }, doc) as { token: string }
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
  it('refuses a premise plan on a fork that cannot say what changed', async () => {
    const doc = counterDoc()
    const fork = doc.forkForPremises!.bind(doc)
    doc.forkForPremises = () => Object.assign(fork(), { changesSince: undefined })
    await expect(premisePlan({ action: 'begin', steps: [{ command: 'increment' }] }, doc)).rejects.toThrow(/changesSince/)
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
