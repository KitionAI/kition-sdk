// @vitest-environment jsdom
/**
 * A labelled checkpoint names the document exactly as it was saved (Kit UI protocol UI-R6, UI-C1;
 * regressions/issue-checkpoint-version-at-save). `saveCheckpoint` takes the replica's version with
 * the saved bytes and sends it in the replica write, so an edit made while the file write and the
 * replica write are pending is not in the checkpoint: reading it back gives the saved content.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitCheckpoint, KitHost, KitWrittenReplica } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { useKitDocument } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fake = vi.hoisted(() => ({ engine: null as unknown }))
vi.mock('./kitEngine', () => ({ KitEngine: { open: async () => fake.engine } }))

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: ArrayBuffer | Uint8Array) => new TextDecoder().decode(bytes)
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))

/**
 * An engine answering in order, as its worker does. Its replica's version is its revision, and it
 * keeps the content at every version, as a replica derives the content at a checkpoint's version.
 */
function workerEngine() {
  const state = { edits: [] as string[], revision: 0, saved: 0 }
  const contentAt = new Map<string, string>([[base64(new Uint8Array([0]).buffer), '']])
  let queue: Promise<unknown> = Promise.resolve()
  const answer = <T,>(work: () => T) => {
    const next = queue.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(work()), 2)))
    queue = next
    return next
  }
  const version = () => new Uint8Array([state.revision]).buffer
  const snapshot = () => ({ revision: state.revision, dirty: state.revision !== state.saved, width: 1, height: 1, canUndo: false, canRedo: false, inspected: {} })
  const engine = {
    info: snapshot(),
    execute: vi.fn(async (command: string) => {
      engine.info = await answer(() => {
        state.edits.push(command)
        state.revision += 1
        contentAt.set(base64(version()), state.edits.join(','))
        return snapshot()
      })
      return null
    }),
    saveWithReplica: vi.fn(() =>
      answer(() => {
        const content = state.edits.join(',')
        return { bytes: encode(content), replica: { snapshot: encode(content).buffer as ArrayBuffer, blobs: new ArrayBuffer(0), version: version() }, revision: state.revision }
      }),
    ),
    replicaVersion: vi.fn(() => answer(version)),
    markSaved: vi.fn(async (revision?: number) => {
      engine.info = await answer(() => {
        if (revision == null || revision === state.revision) state.saved = state.revision
        return snapshot()
      })
    }),
    dispose: vi.fn(),
  }
  fake.engine = engine
  return { engine, contentAt }
}

/**
 * A host keeping replicas and checkpoints as the protocol says: it records a checkpoint keeping the
 * write's snapshot, at the version the write carries. Its file write waits for `release`.
 */
function checkpointHost() {
  const files: string[] = []
  const replicas: KitWrittenReplica[] = []
  const checkpoints: Array<{ checkpoint: KitCheckpoint; snapshot: ArrayBuffer }> = []
  let release = () => undefined as void
  const writing = new Promise<void>((resolve) => {
    release = resolve
  })
  const host: KitHost = {
    read: async () => ({ bytes: new ArrayBuffer(0), stamp: null }),
    stamp: async () => null,
    write: async (_path, bytes) => {
      files.push(decode(bytes))
      await writing
      return 'v2'
    },
    replicaRead: async () => null,
    replicaWrite: async (_path, replica, request) => {
      replicas.push(replica)
      if (!request) return null
      const checkpoint: KitCheckpoint = { id: `c${checkpoints.length + 1}`, time: 1, origin: 'kit', ...(request.label ? { label: request.label } : {}), version: base64(replica.version) }
      checkpoints.push({ checkpoint, snapshot: replica.snapshot.slice(0) })
      return checkpoint
    },
    checkpoints: {
      list: async () => ({ checkpoints: checkpoints.map((kept) => kept.checkpoint).reverse(), more: false }),
      update: async () => Promise.reject(new Error('not used')),
      delete: async () => undefined,
      read: async (_path, id) => {
        const kept = checkpoints.find((candidate) => candidate.checkpoint.id === id)!
        return { checkpoint: kept.checkpoint, blobs: new ArrayBuffer(0), snapshot: kept.snapshot.slice(0) }
      },
    },
  }
  return { host, files, replicas, release }
}

const manifest = { kitId: 'kit.test' } as KitModuleManifest
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('saveCheckpoint names the saved state (UI-R6, issue-checkpoint-version-at-save)', () => {
  it('an edit made while the writes are pending is not in the labelled checkpoint', async () => {
    const { engine, contentAt } = workerEngine()
    const { host, files, replicas, release } = checkpointHost()
    const current = {} as { session: ReturnType<typeof useKitDocument<null>> }
    function Probe() {
      current.session = useKitDocument(host, manifest, 'a.kit', false, () => null)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => undefined)
    cleanups.push(() => act(() => root.unmount()))

    await act(async () => void (await current.session.run('edit.one', {})))
    let checkpoint: KitCheckpoint | null = null
    await act(async () => {
      const saving = current.session.saveCheckpoint({ label: 'Sent to print' })
      // The file write is pending: the person edits meanwhile.
      await vi.waitFor(() => expect(files).toHaveLength(1))
      await current.session.run('edit.two', {})
      // The document is now past the saved state: a version asked now would name the edit.
      expect(new Uint8Array(await engine.replicaVersion())).toEqual(new Uint8Array([2]))
      release()
      checkpoint = await saving
    })

    expect(files).toEqual(['edit.one'])
    expect(replicas).toHaveLength(1)
    const recorded = checkpoint as KitCheckpoint | null
    expect(recorded).toMatchObject({ label: 'Sent to print', version: base64(new Uint8Array([1]).buffer) })
    // Read back: the stored snapshot and the content at the checkpoint's version are the saved bytes'.
    const read = await host.checkpoints!.read('a.kit', recorded!.id)
    expect(decode(read.snapshot)).toBe(files[0])
    expect(contentAt.get(read.checkpoint.version)).toBe(files[0])
    expect(contentAt.get(read.checkpoint.version)).not.toContain('edit.two')
    // The edit stays unsaved.
    expect(current.session.dirty).toBe(true)
  })
})
