// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitHost } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { isFileChangedError, useKitDocument, type KitDocumentOptions } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** The fake engine `KitEngine.open` answers: `execute` records, and moves the revision unless told it is a view-only command. */
const fake = vi.hoisted(() => ({ engine: null as unknown, opens: 0 }))
vi.mock('./kitEngine', () => ({
  KitEngine: {
    open: async () => {
      fake.opens += 1
      return fake.engine
    },
  },
}))
vi.mock('./replica', () => ({ replicaToOpen: async () => null, writeWithReplica: async () => null }))

function fakeEngine() {
  const engine = {
    info: { revision: 0, dirty: false, width: 1, height: 1, canUndo: false, canRedo: false, inspected: { playhead: 0 } },
    executed: [] as string[],
    execute: vi.fn(async (command: string) => {
      engine.executed.push(command)
      if (!command.startsWith('view.')) engine.info = { ...engine.info, revision: engine.info.revision + 1, dirty: true }
      return null
    }),
    refreshInfo: vi.fn(async () => engine.info),
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
})

async function mount() {
  const engine = fakeEngine()
  const describes = { count: 0 }
  const renders = { count: 0 }
  const current: { session: ReturnType<typeof useKitDocument<number>> | null } = { session: null }
  function Probe() {
    renders.count += 1
    current.session = useKitDocument(host, manifest, 'a.kit', false, () => {
      describes.count += 1
      return describes.count
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await act(async () => undefined)
  cleanups.push(() => act(() => root.unmount()))
  return { engine, describes, renders, session: () => current.session! }
}

describe('useKitDocument run refresh', () => {
  it('detaches a closed engine without describing it or repainting', async () => {
    const {session,describes,engine} = await mount()
    const count = describes.count
    Object.assign(engine, {execute:vi.fn(async () => JSON.stringify({closed:true})),closed:true})
    await act(async () => void (await session().run('file.close', {})))
    expect(session().doc).toBeNull()
    expect(session().dirty).toBe(false)
    expect(describes.count).toBe(count)
  })

  it("refreshes everything by default: state, info, and the change counter", async () => {
    const { session, describes } = await mount()
    const before = { describes: describes.count, change: session().change.revision }
    await act(async () => void (await session().run('edit.thing', {})))
    expect(describes.count).toBe(before.describes + 1)
    expect(session().change.revision).toBe(before.change + 1)
  })

  it("'none' runs the command and refreshes nothing: no describe, no change, no render", async () => {
    const { session, describes, renders, engine } = await mount()
    const before = { describes: describes.count, change: session().change.revision, renders: renders.count, repaint: session().repaints.get() }
    await act(async () => void (await session().run('view.playhead', { at: 1 }, null, { refresh: 'none' })))
    expect(engine.executed).toContain('view.playhead')
    expect(describes.count).toBe(before.describes)
    expect(session().change.revision).toBe(before.change)
    expect(renders.count).toBe(before.renders)
    expect(session().repaints.get()).toBe(before.repaint)
  })

  it("'repaint' only moves the repaint store: no describe, no change, no render of the editor", async () => {
    const { session, describes, renders } = await mount()
    const heard: number[] = []
    const unsubscribe = session().repaints.subscribe(() => heard.push(session().repaints.get().tick))
    const before = { describes: describes.count, change: session().change.revision, renders: renders.count, tick: session().repaints.get().tick }
    await act(async () => void (await session().run('view.playhead', { at: 1 }, { x0: 0, y0: 0, x1: 2, y1: 2 }, { refresh: 'repaint' })))
    unsubscribe()
    expect(heard).toEqual([before.tick + 1])
    expect(session().repaints.get().damage).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 })
    expect(describes.count).toBe(before.describes)
    expect(session().change.revision).toBe(before.change)
    expect(renders.count).toBe(before.renders)
  })
})

describe('useKitDocument skipUnchangedPaint', () => {
  it('a command that moved neither the revision nor inspect() refreshes the editor with nothing to repaint', async () => {
    const { session, describes } = await mount()
    const before = describes.count
    await act(async () => void (await session().run('view.select', {}, null, { skipUnchangedPaint: true })))
    expect(describes.count).toBe(before + 1)
    expect(session().change.damage).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 })
  })

  it('one that changed inspect() (a playhead) or the revision repaints everything, and without the option nothing changes', async () => {
    const { session, engine } = await mount()
    engine.execute.mockImplementationOnce(async (command: string) => {
      engine.executed.push(command)
      engine.info = { ...engine.info, inspected: { playhead: 5 } }
      return null
    })
    await act(async () => void (await session().run('view.playhead', {}, null, { skipUnchangedPaint: true })))
    expect(session().change.damage).toBeNull()
    await act(async () => void (await session().run('edit.thing', {}, null, { skipUnchangedPaint: true })))
    expect(session().change.damage).toBeNull()
    await act(async () => void (await session().run('view.select', {})))
    expect(session().change.damage).toBeNull()
  })
})

describe('useKitDocument reads (an agent reading, Stage S of PDF usable by hand)', () => {
  it('a read that changed nothing info holds refreshes nothing: no change, no describe, no repaint', async () => {
    const { session, describes, renders } = await mount()
    const before = { describes: describes.count, change: session().change, renders: renders.count, repaint: session().repaints.get() }
    // `view.*` leaves the fake engine's info as it was, as a worker that sends no new info does.
    await act(async () => void (await session().run('view.list', {}, null, { reads: true })))
    expect(session().change).toBe(before.change)
    expect(describes.count).toBe(before.describes)
    expect(renders.count).toBe(before.renders)
    expect(session().repaints.get()).toBe(before.repaint)
  })

  it('a read that did change what info holds refreshes as usual, and without the option every command does', async () => {
    const { session, engine } = await mount()
    const start = session().change.revision
    await act(async () => void (await session().run('view.list', {})))
    expect(session().change.revision).toBe(start + 1)
    engine.execute.mockImplementationOnce(async () => {
      engine.info = { ...engine.info, inspected: { playhead: 3 } }
      return null
    })
    await act(async () => void (await session().run('view.list', {}, null, { reads: true })))
    expect(session().change.revision).toBe(start + 2)
  })
})

describe('useKitDocument following its file (checkFile, followFile)', () => {
  /** A file whose stamp the test moves, as another program saving it would. */
  async function mountFile(options: KitDocumentOptions = {}) {
    const engine = fakeEngine()
    const file = { stamp: 'v1' }
    const fileHost = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: file.stamp }), stamp: async () => file.stamp, write: async () => null } as unknown as KitHost
    fake.opens = 0
    const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
    function Probe() {
      current.session = useKitDocument(fileHost, manifest, 'a.md', false, () => null, options)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => undefined)
    cleanups.push(() => act(() => root.unmount()))
    return { engine, file, session: () => current.session! }
  }

  it('reopens a document without unsaved edits when its file changed, and leaves an unchanged one', async () => {
    const { file, session } = await mountFile()
    expect(fake.opens).toBe(1)
    await act(() => session().checkFile())
    expect(fake.opens).toBe(1)
    file.stamp = 'v2'
    await act(() => session().checkFile())
    expect(fake.opens).toBe(2)
  })

  it('lets the kit take the change in (followFile): no reopen, and the new stamp is the document’s', async () => {
    const followFile = vi.fn(async () => true)
    const { engine, file, session } = await mountFile({ followFile })
    file.stamp = 'v2'
    await act(() => session().checkFile())
    expect(followFile).toHaveBeenCalledWith(engine, 'v2')
    expect(engine.refreshInfo).toHaveBeenCalledTimes(1)
    expect(fake.opens).toBe(1)
    await act(() => session().checkFile())
    expect(followFile).toHaveBeenCalledTimes(1)
  })

  it('reopens when followFile declines or fails, and raises conflict over unsaved edits without asking it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const followFile = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('cannot merge'))
    const { engine, file, session } = await mountFile({ followFile })
    file.stamp = 'v2'
    await act(() => session().checkFile())
    expect(fake.opens).toBe(2)
    file.stamp = 'v3'
    await act(() => session().checkFile())
    expect(fake.opens).toBe(3)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    engine.info = { ...engine.info, dirty: true }
    file.stamp = 'v4'
    await act(() => session().checkFile())
    expect(session().conflict).toBe(true)
    expect(followFile).toHaveBeenCalledTimes(2)
    expect(fake.opens).toBe(3)
  })

  it('waits for a command already sent before deciding: an edit still running is a conflict, not a reload', async () => {
    const { engine, file, session } = await mountFile()
    let finish!: () => void
    engine.execute.mockImplementationOnce(async (command: string) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      engine.executed.push(command)
      engine.info = { ...engine.info, revision: engine.info.revision + 1, dirty: true }
      return null
    })
    let running!: Promise<unknown>
    await act(async () => {
      running = session().run('edit.thing', {})
    })
    file.stamp = 'v2'
    let checking!: Promise<void>
    await act(async () => {
      checking = session().checkFile()
    })
    finish()
    await act(async () => {
      await running
      await checking
    })
    expect(engine.executed).toContain('edit.thing')
    expect(session().conflict).toBe(true)
    expect(fake.opens).toBe(1)
  })
})

describe('useKitDocument save over a file changed on disk', () => {
  it('refuses to replace a file changed on disk since it was read, raising conflict, until the person keeps theirs', async () => {
    const engine = fakeEngine()
    Object.assign(engine, {
      serialize: vi.fn(async () => ({ bytes: new Uint8Array([1]), revision: engine.info.revision })),
      markSaved: vi.fn(async () => undefined),
    })
    const file = { stamp: 'v1' }
    const fileHost = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: file.stamp }), stamp: async () => file.stamp, write: async () => 'v2' } as unknown as KitHost
    const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
    function Probe() {
      current.session = useKitDocument(fileHost, manifest, 'a.md', false, () => null)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => undefined)
    cleanups.push(() => act(() => root.unmount()))

    await act(async () => void (await current.session!.run('edit.thing', {})))
    file.stamp = 'v1-elsewhere'
    let refused: unknown
    await act(async () => {
      refused = await current.session!.save().catch((error: unknown) => error)
    })
    expect(isFileChangedError(refused)).toBe(true)
    // Nothing was taken to write (the file module, `writeWithReplica`, is a stub here).
    expect((engine as unknown as { serialize: ReturnType<typeof vi.fn> }).serialize).not.toHaveBeenCalled()
    expect(current.session!.conflict).toBe(true)

    await act(async () => current.session!.keepMine())
    await act(async () => current.session!.save())
    expect((engine as unknown as { serialize: ReturnType<typeof vi.fn> }).serialize).toHaveBeenCalledTimes(1)
    expect(current.session!.conflict).toBe(false)
  })
})

describe('useKitDocument and a co-editor`s save it already holds (document/held)', () => {
  async function open(file: { stamp: string }) {
    const engine = fakeEngine()
    const fileHost = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: file.stamp }), stamp: async () => file.stamp, write: async () => 'v9' } as unknown as KitHost
    const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
    function Probe() {
      current.session = useKitDocument(fileHost, manifest, 'a.md', false, () => null)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => undefined)
    cleanups.push(() => act(() => root.unmount()))
    await act(async () => void (await current.session!.run('edit.thing', {})))
    return { engine, session: () => current.session! }
  }

  it('raises no conflict for a version the host says the document holds, and keeps the edits unsaved', async () => {
    const file = { stamp: 'v1' }
    const { session } = await open(file)
    file.stamp = 'v2'
    await act(async () => session().holdFile('v2'))
    await act(async () => session().checkFile())
    expect(session().conflict).toBe(false)
    expect(session().dirty).toBe(true)
  })

  it('clears a conflict already raised for that version, but not for another', async () => {
    const file = { stamp: 'v1' }
    const { session } = await open(file)
    file.stamp = 'v2'
    await act(async () => session().checkFile())
    expect(session().conflict).toBe(true)
    await act(async () => session().holdFile('v1-old'))
    expect(session().conflict).toBe(true)
    await act(async () => session().holdFile('v2'))
    expect(session().conflict).toBe(false)
  })
})
