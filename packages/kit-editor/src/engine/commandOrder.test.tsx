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
