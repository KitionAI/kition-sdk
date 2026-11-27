// @vitest-environment jsdom
// Stage S1 of "design usable by hand": a change made by a drag's steps (the tool's answers busy, not
// settled) says so (`gesture`), so what follows changes but not each step waits for the release's
// change, which never says so; `quietGestures` asks the engine not to inspect at those steps.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
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

/** An engine whose `pointer` moves the revision; down and drag answer busy, up settles. */
function fakeEngine() {
  const engine = {
    width: 400,
    height: 200,
    info: { revision: 0, dirty: false, width: 400, height: 200, canUndo: false, canRedo: false, inspected: {} },
    render: async () => new Uint8Array(0),
    renderArea: async () => new Uint8Array(0),
    onFonts: () => () => undefined,
    execute: vi.fn(async () => {
      engine.info = { ...engine.info, revision: engine.info.revision + 1 }
      return null
    }),
    tool: vi.fn(async (_name: string, args: unknown[], _settled?: boolean, _quiet?: boolean) => {
      engine.info = { ...engine.info, revision: engine.info.revision + 1 }
      const action = JSON.parse(String(args[0])).action as string
      return { value: { requests: [], overlays: [], cursor: 'default', busy: action !== 'up', wantsText: false }, changed: true }
    }),
    refreshInfo: vi.fn(async () => engine.info),
    dispose: vi.fn(),
  }
  fake.engine = engine
  return engine
}

const host = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: null }), stamp: async () => null, write: async () => null } as unknown as KitHost
const manifest = { kitId: 'kit.test' } as KitModuleManifest

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  vi.restoreAllMocks()
})

async function mount(options = {}) {
  const engine = fakeEngine()
  const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
  function Editor() {
    current.session = useKitDocument(host, manifest, 'a.kit', false, () => null, options)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Editor />))
  await act(async () => undefined)
  cleanups.push(() => act(() => root.unmount()))
  return { engine, session: () => current.session! }
}

const event = (action: string) => [JSON.stringify({ action, x: 1, y: 1, zoom: 1 })]

it('marks the changes of a drag’s steps, never the release’s', async () => {
  const { session } = await mount()
  await act(async () => { await session().tool('pointer', event('down')) })
  expect(session().change.gesture).toBe(true)
  await act(async () => { await session().tool('pointer', event('drag')) })
  expect(session().change.gesture).toBe(true)
  await act(async () => { await session().tool('pointer', event('up'), true) })
  expect(session().change.gesture).toBeUndefined()
})

it('does not mark a change that also holds a command’s, taken in the same render', async () => {
  const { session } = await mount()
  await act(async () => {
    await session().run('edit.thing')
    await session().tool('pointer', event('drag'))
  })
  expect(session().change.gesture).toBeUndefined()
})

it('asks the engine for quiet gestures only when the kit does', async () => {
  for (const quiet of [false, true]) {
    const { engine, session } = await mount(quiet ? { quietGestures: true } : {})
    await act(async () => { await session().tool('pointer', event('drag')) })
    expect(engine.tool.mock.calls.at(-1)![3]).toBe(quiet)
  }
})
