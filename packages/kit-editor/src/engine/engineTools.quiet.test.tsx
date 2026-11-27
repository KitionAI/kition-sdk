// @vitest-environment jsdom
// Stage S1 of "design usable by hand": no state query after each step of a drag (its own answers
// carry the overlays; the release asks once), a stable `useEngineTools` result, every drag sample
// kept for a tool that wants them (a pencil), the real Control key, the press's click count, and
// the pointer leaving the canvas reaching the engine.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import type { KitPointer, KitToolContext } from './kitTools'
import type { KitChange } from './useKitDocument'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
const busy: EngineToolResponse = { ...idle, busy: true }
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const at: KitPointer = { x: 10, y: 20, clientX: 10, clientY: 20, canvasX: 10, canvasY: 20, pressure: 1, shift: false, alt: false, meta: false }
const context = { viewport: { view: { zoom: 2 } } } as unknown as KitToolContext

async function mount(options: Partial<Parameters<typeof useEngineTools>[3]> = {}) {
  let current!: ReturnType<typeof useEngineTools>
  const seen: ReturnType<typeof useEngineTools>[] = []
  let hold = false
  let release!: () => void
  const calls: Array<{ name: string; args: unknown[]; settled: boolean }> = []
  const tool = (async (name: string, args: unknown[] = [], settled = false) => {
    if (name === 'tools') return [{ id: 'pencil', label: 'Pencil', group: 0 }]
    calls.push({ name, args, settled })
    if (name === 'pointer' && hold) {
      hold = false
      return new Promise<EngineToolResponse>((resolve) => { release = () => resolve(busy) })
    }
    if (name === 'pointer') return JSON.parse(String(args[0])).action === 'up' ? idle : busy
    return idle
  }) as Parameters<typeof useEngineTools>[0]
  let change: KitChange = { revision: 0, damage: null }
  function Probe() {
    current = useEngineTools(tool, true, change, { initial: 'pencil', ...options })
    seen.push(current)
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  calls.length = 0
  return {
    get tools() { return current },
    seen,
    calls,
    hold: () => { hold = true },
    release: () => release(),
    async change(next: KitChange) {
      change = next
      await act(async () => root.render(<Probe />))
    },
  }
}

const names = (calls: Array<{ name: string; args: unknown[] }>) => calls.map((call) => (call.name === 'pointer' ? JSON.parse(String(call.args[0])).action : call.name))

it('asks the tool for its state after a change, but not after the steps of a drag; the release asks once', async () => {
  const kit = await mount()
  await kit.change({ revision: 1, damage: null, gesture: true })
  await kit.change({ revision: 2, damage: null, gesture: true })
  expect(names(kit.calls)).toEqual([])
  await kit.change({ revision: 3, damage: null })
  expect(names(kit.calls)).toEqual(['toolState'])
})

it('gives the same result while nothing it holds changed', async () => {
  const kit = await mount()
  const before = kit.tools
  await kit.change({ revision: 1, damage: null, gesture: true })
  expect(kit.tools).toBe(before)
})

it('keeps every drag sample of a tool that wants them while the engine answers', async () => {
  for (const keep of [false, true]) {
    const kit = await mount(keep ? { keepsDragSamples: (id) => id === 'pencil' } : {})
    kit.hold()
    let gesture!: ReturnType<typeof kit.tools.canvasTool.begin>
    act(() => { gesture = kit.tools.canvasTool.begin(at, context) })
    act(() => {
      for (const x of [11, 12, 13]) gesture?.move?.({ ...at, x }, context)
    })
    await act(async () => kit.release())
    const drags = kit.calls.filter((call) => names([call])[0] === 'drag').map((call) => JSON.parse(String(call.args[0])).x)
    expect(drags).toEqual(keep ? [11, 12, 13] : [13])
  }
})

it('sends the real Control key, and a press its click count', async () => {
  const kit = await mount()
  await act(async () => {
    const gesture = kit.tools.canvasTool.begin({ ...at, meta: true, ctrl: true, clicks: 2 }, context)
    gesture?.end?.({ ...at, meta: true, ctrl: true }, context)
  })
  const [down, up] = kit.calls.map((call) => JSON.parse(String(call.args[0])))
  expect(down).toMatchObject({ action: 'down', clicks: 2, mods: { command: true, control: true } })
  expect(up.clicks).toBeUndefined()
  // Without Control (Command alone), control stays false.
  kit.calls.length = 0
  await act(async () => kit.tools.canvasTool.begin({ ...at, meta: true }, context))
  expect(JSON.parse(String(kit.calls[0].args[0])).mods).toMatchObject({ command: true, control: false })
})

it('tells the engine when the pointer leaves the canvas', async () => {
  const kit = await mount()
  await act(async () => kit.tools.canvasTool.leave?.(context))
  expect(kit.calls).toEqual([{ name: 'pointerLeft', args: [2], settled: false }])
})
