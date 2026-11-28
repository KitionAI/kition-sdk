// @vitest-environment jsdom
// Stage S1 of "design usable by hand": the editor asks the engine which commands are disabled after
// each change, but not after the steps of a drag (`KitChange.gesture`); the release's change asks.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useKitEditorState, type KitSession } from './editor'
import type { HostConnection } from './host'
import type { KitChange } from './engine/useKitDocument'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

it('asks for the disabled commands after a change, not after a drag’s steps', async () => {
  const disabledCommands = vi.fn(async () => [] as string[])
  const doc = { commands: async () => [], disabledCommands }
  const host = { ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined) } as unknown as HostConnection
  let change: KitChange = { revision: 0, damage: null }
  function Probe() {
    useKitEditorState({ doc, change } as unknown as KitSession<unknown>, host, (key) => key, 'k')
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  disabledCommands.mockClear()
  for (const next of [{ revision: 1, damage: null, gesture: true }, { revision: 2, damage: null, gesture: true }] as KitChange[]) {
    change = next
    await act(async () => root.render(<Probe />))
  }
  expect(disabledCommands).not.toHaveBeenCalled()
  change = { revision: 3, damage: null }
  await act(async () => root.render(<Probe />))
  expect(disabledCommands).toHaveBeenCalledTimes(1)
})

// Stage S of "PDF usable by hand": the list may be behind the engine until it is read for the last
// change, and while commands or tool events are on their way; a Cmd shortcut then asks the engine.
it('says the list of disabled commands is behind until it was read for the last change, and while work is on its way', async () => {
  let answer: (off: string[]) => void = () => undefined
  const disabledCommands = vi.fn(() => new Promise<string[]>((resolve) => { answer = resolve }))
  const doc = { commands: async () => [], disabledCommands }
  const host = { ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined) } as unknown as HostConnection
  let change: KitChange = { revision: 0, damage: null }
  let sending = false
  let behind!: () => boolean
  function Probe() {
    behind = useKitEditorState({ doc, change, pending: () => sending } as unknown as KitSession<unknown>, host, (key) => key, 'k').listBehind
    return null
  }
  const root = createRoot(document.createElement('div'))
  cleanups.push(() => act(() => root.unmount()))
  await act(async () => root.render(<Probe />))
  expect(behind()).toBe(true)
  await act(async () => answer([]))
  expect(behind()).toBe(false)
  change = { revision: 1, damage: null }
  await act(async () => root.render(<Probe />))
  expect(behind()).toBe(true)
  await act(async () => answer(['edit.undo']))
  expect(behind()).toBe(false)
  sending = true
  expect(behind()).toBe(true)
})
