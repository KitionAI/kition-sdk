// @vitest-environment jsdom
/**
 * Save takes the document's bytes after the commands and engine tool events still on their way
 * (a command finished with Enter, then Save at once), and marks it saved only when nothing reached
 * the engine after those bytes: the engine answers which revision it serialized.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitHost } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { orderCommands, useKitDocument } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fake = vi.hoisted(() => ({ engine: null as unknown, written: [] as string[], writing: null as Promise<void> | null }))
vi.mock('./kitEngine', () => ({ KitEngine: { open: async () => fake.engine } }))
vi.mock('./replica', () => ({
  replicaToOpen: async () => null,
  writeWithReplica: async (_host: unknown, _path: string, bytes: Uint8Array) => {
    fake.written.push(new TextDecoder().decode(bytes))
    await fake.writing
    return null
  },
}))

/**
 * An engine answering in order after a delay, as its worker does: `info` (the page's copy) moves
 * only when an answer arrives, so a command still on its way has not moved it yet.
 */
function workerEngine(delay: number) {
  const state = { edits: [] as string[], revision: 0, saved: 0 }
  let queue: Promise<unknown> = Promise.resolve()
  const answer = <T,>(work: () => T) => {
    const next = queue.then(() => new Promise<T>((resolve) => setTimeout(() => resolve(work()), delay)))
    queue = next
    return next
  }
  const snapshot = () => ({ revision: state.revision, dirty: state.revision !== state.saved, width: 1, height: 1, canUndo: false, canRedo: false, inspected: {} })
  const engine = {
    info: snapshot(),
    execute: vi.fn(async (command: string) => {
      engine.info = await answer(() => {
        state.edits.push(command)
        state.revision += 1
        return snapshot()
      })
      return null
    }),
    serialize: vi.fn(() => answer(() => ({ bytes: new TextEncoder().encode(state.edits.join(',')), revision: state.revision }))),
    saveWithReplica: vi.fn(),
    markSaved: vi.fn(async (revision?: number) => {
      engine.info = await answer(() => {
        if (revision == null || revision === state.revision) state.saved = state.revision
        return snapshot()
      })
    }),
    dispose: vi.fn(),
  }
  fake.engine = engine
  return engine
}

const host: KitHost = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: null }), stamp: async () => null, write: async () => null } as unknown as KitHost
const manifest = { kitId: 'kit.test' } as KitModuleManifest

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  fake.written = []
  fake.writing = null
})

async function mount(options: { readOnly?: boolean } = {}) {
  const engine = workerEngine(5)
  const current = {} as { session: ReturnType<typeof useKitDocument<null>> }
  function Probe() {
    current.session = useKitDocument(host, manifest, 'a.kit', false, () => null, options)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await act(async () => undefined)
  cleanups.push(() => act(() => root.unmount()))
  return { engine, session: () => current.session }
}

describe('useKitDocument save order', () => {
  it('saves after a command still on its way, and the document is saved', async () => {
    const { session } = await mount()
    await act(async () => {
      const ran = session().run('command.finish', {})
      await session().save()
      await ran
    })
    expect(fake.written).toEqual(['command.finish'])
    expect(session().dirty).toBe(false)
    expect(session().info?.dirty).toBe(false)
  })

  it('keeps the document unsaved when an edit lands while the file is written', async () => {
    const { session } = await mount()
    let release = () => undefined as void
    fake.writing = new Promise<void>((resolve) => {
      release = resolve
    })
    await act(async () => void (await session().run('edit.one', {})))
    await act(async () => {
      const saved = session().save()
      await vi.waitFor(() => expect(fake.written).toHaveLength(1))
      await session().run('edit.two', {})
      release()
      await saved
    })
    expect(fake.written).toEqual(['edit.one'])
    expect(session().dirty).toBe(true)
  })

  it('refuses to save a read-only document', async () => {
    const { session, engine } = await mount({ readOnly: true })
    await expect(session().save()).rejects.toThrow()
    expect(engine.serialize).not.toHaveBeenCalled()
  })
})

describe('useKitDocument disabledCommands', () => {
  it('asks the engine after the tool events still waiting, as a command runs', async () => {
    const { engine, session } = await mount()
    const asked = vi.fn(async () => ['edit.delete'])
    Object.assign(engine, { disabledCommands: asked })
    // A tool event (the click that selects) still waits: work queued behind it waits too.
    let release = () => undefined as void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = orderCommands(session().tool, (work) => pending.then(work))
    cleanups.push(stop)
    let answer: string[] | null = null
    await act(async () => {
      void session().disabledCommands().then((off) => {
        answer = off
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(asked).not.toHaveBeenCalled()
    await act(async () => {
      release()
      await vi.waitFor(() => expect(answer).toEqual(['edit.delete']))
    })
  })
})
