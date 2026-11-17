// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import type { KitPointer, KitToolContext } from './kitTools'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const at: KitPointer = { x: 10, y: 20, clientX: 10, clientY: 20, canvasX: 10, canvasY: 20, pressure: 1, shift: false, alt: false, meta: false }
const context = { viewport: { view: { zoom: 2 } } } as unknown as KitToolContext

async function mount() {
  let current!: ReturnType<typeof useEngineTools>
  let hold = false
  let release!: () => void
  const calls: Array<{ name: string; args: unknown[]; settled: boolean }> = []
  const tool = (async (name: string, args: unknown[] = [], settled = false) => {
    if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0 }]
    calls.push({ name, args, settled })
    if (name === 'pointer' && hold) {
      hold = false
      return new Promise<EngineToolResponse>((resolve) => { release = () => resolve(idle) })
    }
    return idle
  }) as Parameters<typeof useEngineTools>[0]
  function Probe() {
    current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  calls.length = 0
  return { get tools() { return current }, calls, hold: () => { hold = true }, release: () => release() }
}

it('queues interruption after a pending press and before the next gesture without committing a release', async () => {
  const kit = await mount()
  kit.hold()
  let gesture!: ReturnType<typeof kit.tools.canvasTool.begin>
  act(() => { gesture = kit.tools.canvasTool.begin(at, context) })
  act(() => { gesture?.cancel?.(context); kit.tools.canvasTool.begin(at, context) })
  expect(kit.calls).toHaveLength(1)
  await act(async () => kit.release())
  expect(kit.calls.map((call) => call.name === 'pointer' ? JSON.parse(String(call.args[0])).action : `${call.name} ${call.args[0]}`)).toEqual(['down', 'toolKey Escape', 'down'])
  expect(kit.calls[1]).toMatchObject({ args: ['Escape', '{}', 2], settled: true })
})

it('a normal release still commits through pointer up', async () => {
  const kit = await mount()
  await act(async () => {
    const gesture = kit.tools.canvasTool.begin(at, context)
    gesture?.end?.(at, context)
  })
  expect(kit.calls.map((call) => JSON.parse(String(call.args[0])).action)).toEqual(['down', 'up'])
  expect(kit.calls[1].settled).toBe(true)
})

it('holds Delete pressed while the engine answers a press, and gives it to the page once answered', async () => {
  const kit = await mount()
  const replayed: string[] = []
  const listen = (event: KeyboardEvent) => replayed.push(event.key)
  document.addEventListener('keydown', listen)
  cleanups.push(() => document.removeEventListener('keydown', listen))
  kit.hold()
  act(() => { kit.tools.canvasTool.begin(at, context) })
  let held = false
  act(() => { held = kit.tools.keyDown({ key: 'Delete', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }) })
  expect(held).toBe(true)
  expect(replayed).toEqual([])
  await act(async () => kit.release())
  expect(replayed).toEqual(['Delete'])
})

it('a held Delete given back once a marquee is released is no longer the gesture’s key, so its shortcut takes it', async () => {
  const busy: EngineToolResponse = { ...idle, busy: true }
  let current!: ReturnType<typeof useEngineTools>
  let release!: () => void
  const sent: string[] = []
  const tool = (async (name: string, args: unknown[] = []) => {
    if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0 }]
    const action = name === 'pointer' ? JSON.parse(String(args[0])).action : name
    sent.push(name === 'toolKey' ? `toolKey ${args[0]}` : action)
    if (action === 'down' || action === 'drag') return busy
    if (action === 'up') return new Promise<EngineToolResponse>((resolve) => { release = () => resolve(idle) })
    return idle
  }) as Parameters<typeof useEngineTools>[0]
  function Probe() {
    current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  // The page's key handler, as the editor's: the tool first, then the shortcut.
  const shortcuts: string[] = []
  const page = (event: KeyboardEvent) => {
    if (current.keyDown(event)) return
    shortcuts.push(event.key)
  }
  document.addEventListener('keydown', page)
  cleanups.push(() => document.removeEventListener('keydown', page))
  let gesture!: ReturnType<typeof current.canvasTool.begin>
  await act(async () => {
    gesture = current.canvasTool.begin(at, context)
    gesture?.move?.({ ...at, x: 300 }, context)
  })
  act(() => gesture?.end?.({ ...at, x: 300 }, context))
  let held = false
  act(() => { held = current.keyDown({ key: 'Delete', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }) })
  expect(held).toBe(true)
  await act(async () => release())
  expect(sent).not.toContain('toolKey Delete')
  expect(shortcuts).toEqual(['Delete'])
})

it('keys held while the engine answers reach it in the order they were typed, Backspace included', async () => {
  const typing: EngineToolResponse = { ...idle, wantsText: true }
  let current!: ReturnType<typeof useEngineTools>
  let release!: () => void
  let first = true
  const sent: string[] = []
  const tool = (async (name: string, args: unknown[] = []) => {
    if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0 }]
    if (name === 'toolText' || name === 'toolKey') sent.push(`${name} ${args[0]}`)
    if (name === 'toolText' && first) {
      first = false
      return new Promise<EngineToolResponse>((resolve) => { release = () => resolve(typing) })
    }
    return typing
  }) as Parameters<typeof useEngineTools>[0]
  function Probe() {
    current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  // The page's key handler, as the editor's: the tool first, then the shortcut.
  const page = (event: KeyboardEvent) => { current.keyDown(event) }
  document.addEventListener('keydown', page)
  cleanups.push(() => document.removeEventListener('keydown', page))
  const press = (key: string) => current.keyDown({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false })
  // "x" goes at once; the engine is still answering it while Backspace, Backspace, L and a come.
  act(() => { press('x') })
  act(() => { for (const key of ['Backspace', 'Backspace', 'L', 'a']) expect(press(key)).toBe(true) })
  await act(async () => release())
  expect(sent).toEqual(['toolText x', 'toolKey Backspace', 'toolKey Backspace', 'toolText L', 'toolText a'])
})

it('gives Escape to a tool taking text only while the kit says it has something to cancel (escapable)', async () => {
  const text: EngineToolResponse = { ...idle, cursor: 'text', wantsText: true }
  let current!: ReturnType<typeof useEngineTools>
  let cancellable = false
  const sent: string[] = []
  const tool = (async (name: string, args: unknown[] = []) => {
    if (name === 'tools') return [{ id: 'text', label: 'Text', group: 0 }]
    if (name === 'toolKey') sent.push(String(args[0]))
    return text
  }) as Parameters<typeof useEngineTools>[0]
  function Probe() {
    current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'text', escapable: () => cancellable })
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  await act(async () => {
    const gesture = current.canvasTool.begin(at, context)
    gesture?.end?.(at, context)
  })
  const escape = { key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }
  let taken = true
  act(() => { taken = current.keyDown(escape) })
  expect(taken).toBe(false)
  expect(sent).toEqual([])
  cancellable = true
  act(() => { taken = current.keyDown(escape) })
  expect(taken).toBe(true)
  await act(async () => undefined)
  expect(sent).toEqual(['Escape'])
  // Other editing keys still go to the tool taking text.
  act(() => { taken = current.keyDown({ ...escape, key: 'Enter' }) })
  expect(taken).toBe(true)
})
