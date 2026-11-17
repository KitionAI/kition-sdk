// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import { HAND_TOOL } from './kitTools'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
const switchTo = (id: string): EngineToolResponse => ({ ...idle, requests: [{ kind: 'switchTool', id }] })
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** Hold exactly one engine reply so the user can choose a tool before it arrives. */
async function mount() {
  let hold: string | null = null
  let release!: (reply: EngineToolResponse) => void
  const selected: string[] = []
  const tool = (async (name: string, args: unknown[] = []) => {
    if (name === 'tools') return ['select', 'circle', 'line'].map((id) => ({ id, label: id, shortcut: null, icon: id, group: 0 }))
    if (name === 'selectTool') selected.push(String(args[0]))
    if (name === hold) {
      hold = null
      return new Promise<EngineToolResponse>((resolve) => { release = resolve })
    }
    return idle
  }) as Parameters<typeof useEngineTools>[0]
  let current!: ReturnType<typeof useEngineTools>
  function Probe() {
    current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select', hostTools: { hand: HAND_TOOL } })
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  return { get tools() { return current }, selected, hold: (name: string) => { hold = name }, reply: (value: EngineToolResponse) => release(value) }
}

it('keeps a toolbar choice when an older command-state reply asks for Select', async () => {
  const kit = await mount()
  kit.hold('toolState')
  act(() => kit.tools.refresh())
  act(() => kit.tools.select('circle'))
  expect(kit.tools.active).toBe('circle')
  await act(async () => kit.reply(switchTo('select')))
  expect(kit.tools.active).toBe('circle')
  expect(kit.selected.at(-1)).toBe('circle')
  // Once the choice is acknowledged, the engine can switch tools on command completion.
  kit.hold('toolState')
  act(() => kit.tools.refresh())
  await act(async () => kit.reply(switchTo('select')))
  expect(kit.tools.active).toBe('select')
})

it('keeps the newest of several choices while an earlier selection is in flight', async () => {
  const kit = await mount()
  kit.hold('selectTool')
  act(() => kit.tools.select('circle'))
  act(() => { kit.tools.select('line'); kit.tools.select('circle') })
  await act(async () => kit.reply(switchTo('select')))
  expect(kit.tools.active).toBe('circle')
  expect(kit.selected.at(-1)).toBe('circle')
})

it('keeps a host Pan choice while an old engine reply is in flight', async () => {
  const kit = await mount()
  kit.hold('toolState')
  act(() => kit.tools.refresh())
  act(() => kit.tools.select('hand'))
  await act(async () => kit.reply(switchTo('select')))
  expect(kit.tools.active).toBe('hand')
  await act(async () => kit.tools.select('line'))
  expect(kit.selected.at(-1)).toBe('line')
})

it('honors a switch requested by the newly selected tool itself', async () => {
  const kit = await mount()
  kit.hold('selectTool')
  act(() => kit.tools.select('circle'))
  await act(async () => kit.reply(switchTo('line')))
  expect(kit.tools.active).toBe('line')
  expect(kit.selected.at(-1)).toBe('line')
})

it('handles an engine request for host Pan without sending it back as an engine tool', async () => {
  const kit = await mount()
  const selected = [...kit.selected]
  kit.hold('toolState')
  act(() => kit.tools.refresh())
  await act(async () => kit.reply(switchTo('hand')))
  expect(kit.tools.active).toBe('hand')
  expect(kit.selected).toEqual(selected)
  await act(async () => kit.tools.select('line'))
  expect(kit.selected.at(-1)).toBe('line')
})
