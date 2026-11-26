// @vitest-environment jsdom
/**
 * A command (a shortcut, a menu) waits for the engine tool events still waiting on the page: the
 * tools send their events one at a time, so with a slow engine Shift+Arrow keys pile up, and Cmd+B
 * pressed right after them must reach the engine after them, or it formats part of the selection.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import type { KitHost } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { useKitDocument } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fake = vi.hoisted(() => ({ engine: null as unknown }))
vi.mock('./kitEngine', () => ({ KitEngine: { open: async () => fake.engine } }))
vi.mock('./replica', () => ({ replicaToOpen: async () => null, writeWithReplica: async () => null }))

const TEXT: EngineToolResponse = { requests: [], overlays: [], cursor: 'text', busy: false, wantsText: true }

/** An engine whose every answer takes a while, as a loaded worker's does; `posted` is what reached it, in order. */
function slowEngine(delay: number) {
  const posted: string[] = []
  const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delay))
  const engine = {
    info: { revision: 0, dirty: false, width: 1, height: 1, canUndo: false, canRedo: false, inspected: {} },
    posted,
    tool: vi.fn((name: string, args: unknown[]) => {
      posted.push(name === 'toolKey' || name === 'selectTool' ? `${name} ${String(args[0])}` : name)
      return later({ value: name === 'tools' ? [] : name === 'tool' ? '' : TEXT, changed: false })
    }),
    execute: vi.fn((command: string) => {
      posted.push(`execute ${command}`)
      return later(null)
    }),
    disabledCommands: vi.fn(() => {
      posted.push('disabledCommands')
      return later([] as string[])
    }),
    serialize: vi.fn(() => {
      posted.push('save')
      return later({ bytes: new Uint8Array(), revision: 0 })
    }),
    markSaved: vi.fn(() => later(undefined)),
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

/** The document alone, as a kit without engine tools has it. */
async function mountDocument() {
  const engine = slowEngine(5)
  const current = {} as { session: ReturnType<typeof useKitDocument<null>> }
  function Probe() {
    current.session = useKitDocument(host, manifest, 'a.kit', false, () => null)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
  cleanups.push(() => act(() => root.unmount()))
  return { engine, current }
}

async function mount() {
  const engine = slowEngine(5)
  const current = {} as { session: ReturnType<typeof useKitDocument<null>>; tools: ReturnType<typeof useEngineTools> }
  function Probe() {
    const session = useKitDocument(host, manifest, 'a.kit', false, () => null)
    current.session = session
    current.tools = useEngineTools(session.tool, session.doc != null, session.change, { initial: 'text' })
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  // The text tool is chosen and answers that it takes text.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
  cleanups.push(() => act(() => root.unmount()))
  return { engine, current }
}

const shiftRight = { key: 'ArrowRight', shiftKey: true, altKey: false, metaKey: false, ctrlKey: false }

describe('commands after engine tool events', () => {
  it('acknowledges a completed tool switch before starting a newer command', async () => {
    const { engine, current } = await mount()
    engine.posted.length = 0
    let release!: () => void
    engine.tool.mockImplementationOnce((name: string) => {
      engine.posted.push(name)
      return new Promise((resolve) => {
        release = () => resolve({ value: { ...TEXT, requests: [{ kind: 'switchTool', id: 'select' }] }, changed: false })
      })
    })
    act(() => current.tools.refresh())
    let ran!: Promise<unknown>
    act(() => { ran = current.session.run('start.next') })
    await act(async () => { release(); await ran })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(engine.posted.slice(0, 3)).toEqual(['toolState', 'selectTool select', 'execute start.next'])
    expect(engine.posted.filter((entry) => entry === 'selectTool select')).toHaveLength(1)
    expect(current.tools.active).toBe('select')
  })

  it('runs a shortcut after the Shift+Arrow keys pressed before it', async () => {
    const { engine, current } = await mount()
    expect(current.tools.wantsText).toBe(true)
    engine.posted.length = 0
    let ran: Promise<unknown> = Promise.resolve()
    await act(async () => {
      for (let index = 0; index < 4; index += 1) expect(current.tools.keyDown(shiftRight)).toBe(true)
      ran = current.session.run('format.bold', {})
      await ran
    })
    // (The tools then ask for their state after the change.)
    expect(engine.posted.slice(0, 5)).toEqual(['toolKey ArrowRight', 'toolKey ArrowRight', 'toolKey ArrowRight', 'toolKey ArrowRight', 'execute format.bold'])
  })

  it('runs a command at once when no tool event is waiting', async () => {
    const { engine, current } = await mount()
    engine.posted.length = 0
    await act(async () => {
      const ran = current.session.run('format.bold', {})
      // Sent in the same tick, ahead of anything that comes after it.
      expect(engine.posted).toEqual(['execute format.bold'])
      expect(current.tools.keyDown(shiftRight)).toBe(true)
      await ran
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(engine.posted.slice(0, 2)).toEqual(['execute format.bold', 'toolKey ArrowRight'])
  })

  it('sets no state from an engine answer that arrives after the editor closed', async () => {
    const { current } = await mount()
    // The tools' state request is out when the editor closes; its answer comes 5 ms later.
    act(() => current.tools.refresh())
    cleanups.pop()!()
    // React reads `window.event` for each state update: after a test's DOM is torn down that
    // threw "window is not defined" as an unhandled rejection.
    const read = vi.spyOn(window, 'event', 'get')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('holds the keys and commands after a decision made with the engine behind it', async () => {
    // F8 bound to a command the list read after the last change still calls disabled: the frame
    // asks the engine and runs it (`runWhenEnabled`); `a` and Cmd+B pressed meanwhile come after.
    const { engine, current } = await mount()
    engine.posted.length = 0
    const typed = { key: 'a', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }
    await act(async () => {
      const decided = current.session.inOrder(async () => {
        await engine.disabledCommands()
        return current.session.run('mark.put', {}, null, { inOrder: true })
      })
      expect(current.tools.keyDown(typed)).toBe(true)
      const bold = current.session.run('format.bold', {})
      await Promise.all([decided, bold])
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(engine.posted.slice(0, 4)).toEqual(['disabledCommands', 'execute mark.put', 'toolText', 'execute format.bold'])
  })

  it('holds the commands after a decision made with the engine behind it without engine tools too', async () => {
    const { engine, current } = await mountDocument()
    engine.posted.length = 0
    await act(async () => {
      const decided = current.session.inOrder(async () => {
        await engine.disabledCommands()
        return current.session.run('mark.put', {}, null, { inOrder: true })
      })
      const bold = current.session.run('format.bold', {})
      const italic = current.session.run('format.italic', {})
      await Promise.all([decided, bold, italic])
    })
    expect(engine.posted).toEqual(['disabledCommands', 'execute mark.put', 'execute format.bold', 'execute format.italic'])
  })

  it('decides an Enter the last answer does not take once the events before it are answered', async () => {
    // The click that starts a text frame is still on its way: the answer before it takes no text.
    const { engine, current } = await mount()
    const NO_TEXT: EngineToolResponse = { ...TEXT, wantsText: false }
    engine.tool.mockImplementationOnce((name: string) => {
      engine.posted.push(name)
      return new Promise((resolve) => setTimeout(() => resolve({ value: NO_TEXT, changed: false }), 5))
    })
    act(() => current.tools.refresh())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(current.tools.wantsText).toBe(false)
    engine.posted.length = 0
    const enter = { key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }
    // A held key goes to the page again once the events before it are answered, as the frame's keys do.
    const page = (event: KeyboardEvent) => current.tools.keyDown(event)
    document.body.addEventListener('keydown', page)
    cleanups.push(() => document.body.removeEventListener('keydown', page))
    await act(async () => {
      // The click: its answer takes text.
      current.tools.canvasTool.doubleClick?.({ x: 1, y: 1, pressure: 1 } as never, { viewport: { view: { zoom: 1 } } } as never)
      expect(current.tools.keyDown(enter)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(engine.posted.slice(0, 2)).toEqual(['pointer', 'toolKey Enter'])
  })

  it('saves after the keys pressed before Save, so the file holds them', async () => {
    const { engine, current } = await mount()
    engine.posted.length = 0
    await act(async () => {
      for (let index = 0; index < 3; index += 1) expect(current.tools.keyDown(shiftRight)).toBe(true)
      await current.session.save()
    })
    expect(engine.posted.slice(0, 4)).toEqual(['toolKey ArrowRight', 'toolKey ArrowRight', 'toolKey ArrowRight', 'save'])
  })
})
