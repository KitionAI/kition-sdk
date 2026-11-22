// @vitest-environment jsdom
// regressions/issue-kit-editor-merged-repaint: the repaint store (`refresh: 'repaint'`, KitRepaint) kept
// only its last tick's area, so when React took several ticks in one render the canvas repainted
// only the last one's: a playhead (kition-film), a click (kition-html), a presence or a progressive
// render step (kition-scene) whose area an empty or partial tick right after replaced. The same rule
// as the document's refresh now (`owedDamage`, useKitDocument.damage.test.tsx).
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitDocumentCanvas, KitEditorProvider, type KitEditor } from '../editor'
import { EMPTY_UI_CONFIG } from '../uiConfig'
import { createUiStore } from '../uiStore'
import type { KitHost } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { NOTHING, owedDamage } from './owedDamage'
import { RasterViewport, type RasterRect } from './rasterViewport'
import { useKitDocument } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fake = vi.hoisted(() => ({ engine: null as unknown }))
vi.mock('./kitEngine', () => ({ KitEngine: { open: async () => fake.engine } }))
vi.mock('./replica', () => ({ replicaToOpen: async () => null, writeWithReplica: async () => null }))

const A: RasterRect = { x0: 10, y0: 10, x1: 20, y1: 20 }
const B: RasterRect = { x0: 50, y0: 5, x1: 60, y1: 15 }

/** An engine whose commands change nothing the editor reads (a playhead, a progressive render step). */
function fakeEngine() {
  const engine = {
    width: 400,
    height: 200,
    info: { revision: 0, dirty: false, width: 400, height: 200, canUndo: false, canRedo: false, inspected: {} },
    render: async () => new Uint8Array(0),
    renderArea: async () => new Uint8Array(0),
    onFonts: () => () => undefined,
    execute: vi.fn(async () => null),
    refreshInfo: vi.fn(async () => engine.info),
    dispose: vi.fn(),
  }
  fake.engine = engine
  return engine
}

const host = { read: async () => ({ bytes: new ArrayBuffer(1), stamp: null }), stamp: async () => null, write: async () => null } as unknown as KitHost
const manifest = { kitId: 'kit.test' } as KitModuleManifest

// jsdom lays nothing out and has no ResizeObserver; the viewport's paints are spied on, not run.
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}
function spyPaints() {
  return {
    invalidate: vi.spyOn(RasterViewport.prototype, 'invalidate').mockImplementation(() => undefined),
    render: vi.spyOn(RasterViewport.prototype, 'render').mockResolvedValue(false),
    renderArea: vi.spyOn(RasterViewport.prototype, 'renderArea').mockResolvedValue(false),
    patch: vi.spyOn(RasterViewport.prototype, 'patch').mockResolvedValue(false),
  }
}
let paints: ReturnType<typeof spyPaints>
beforeEach(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  paints = spyPaints()
})
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  vi.restoreAllMocks()
})

/** The session and the editor's canvas region (`KitDocumentCanvas`), as a kit shows them. */
async function mount() {
  fakeEngine()
  const renders = { count: 0 }
  const ui = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)
  const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
  function Editor() {
    renders.count += 1
    const session = useKitDocument(host, manifest, 'a.kit', false, () => null)
    current.session = session
    const canvas = useRef(null)
    const editor = {
      session,
      host: { ui, init: { locale: 'en-US', capabilities: [], document: { path: 'a.kit' } }, declaration: {}, peer: { handle() {} } },
      commands: [],
      byId: new Map(),
      enabled: () => true,
      t: (key: string) => key,
      phrase: (english: string) => english,
      testId: 'k',
    } as unknown as KitEditor
    return (
      <KitEditorProvider editor={editor}>
        <KitDocumentCanvas canvas={canvas} />
      </KitEditorProvider>
    )
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<Editor />))
  await act(async () => undefined)
  cleanups.push(() => {
    act(() => root.unmount())
    element.remove()
  })
  clearPaints()
  return { renders, session: () => current.session! }
}

/** What the canvas painted since the last call: everything, the areas it repainted, or nothing. */
function painted() {
  const result = { whole: paints.render.mock.calls.length, areas: paints.renderArea.mock.calls.map(([area]) => area) }
  clearPaints()
  return result
}

function clearPaints() {
  paints.invalidate.mockClear()
  paints.render.mockClear()
  paints.renderArea.mockClear()
  paints.patch.mockClear()
}

/** A command that repaints the canvas only (`refresh: 'repaint'`), limited to `damage`. */
const repaint = (session: ReturnType<typeof useKitDocument<null>>, damage: RasterRect | null) => session.run('view.step', {}, damage, { refresh: 'repaint' })

describe('owedDamage: the areas owed until a repaint that holds them is committed', () => {
  it('merges what is owed, drops what was paid, and never forgets an area when it keeps fewer apart', () => {
    const owed = owedDamage()
    expect(owed.total()).toEqual(NOTHING)
    const a = owed.add(A)
    owed.add(B)
    expect(owed.total()).toEqual({ x0: 10, y0: 5, x1: 60, y1: 20 })
    owed.paid(a)
    expect(owed.total()).toEqual(B)
    owed.paid(owed.last())
    expect(owed.total()).toEqual(NOTHING)
    // Nobody commits: past the areas it keeps apart, the oldest are merged, and still owed.
    for (let i = 0; i < 100; i += 1) owed.add({ x0: i, y0: 0, x1: i + 1, y1: 1 })
    expect(owed.total()).toEqual({ x0: 0, y0: 0, x1: 100, y1: 1 })
    owed.paid(owed.last() - 1)
    expect(owed.total()).toEqual({ x0: 99, y0: 0, x1: 100, y1: 1 })
  })
})

// A store's tick renders the canvas region at once (useSyncExternalStore: a sync render, in a
// microtask): ticks React takes in one render are those that land in one task, as two answers
// resolved together (`Promise.all`) do.
describe("useKitDocument's repaint store and the editor's canvas: ticks React takes in one render", () => {
  it('everything, then the empty area: the whole canvas repaints, and the editor does not render', async () => {
    const { session, renders } = await mount()
    const before = { renders: renders.count, tick: session().repaints.get().tick }
    await act(async () => void (await Promise.all([repaint(session(), null), repaint(session(), NOTHING)])))
    expect(renders.count).toBe(before.renders)
    expect(session().repaints.get().tick).toBe(before.tick + 2)
    expect(painted()).toEqual({ whole: 1, areas: [] })
  })

  it('the reverse order (nothing, then everything) repaints the whole canvas too', async () => {
    const { session } = await mount()
    await act(async () => void (await Promise.all([repaint(session(), NOTHING), repaint(session(), null)])))
    expect(painted()).toEqual({ whole: 1, areas: [] })
  })

  it('two areas repaint the rectangle covering both', async () => {
    const { session } = await mount()
    await act(async () => void (await Promise.all([repaint(session(), A), repaint(session(), B)])))
    expect(painted()).toEqual({ whole: 0, areas: [{ x0: 10, y0: 5, x1: 60, y1: 20 }] })
  })

  it('the empty area alone paints nothing, and an area already painted is not owed again', async () => {
    const { session } = await mount()
    await act(async () => void (await repaint(session(), NOTHING)))
    expect(painted()).toEqual({ whole: 0, areas: [] })
    await act(async () => void (await repaint(session(), A)))
    expect(painted()).toEqual({ whole: 0, areas: [A] })
    await act(async () => void (await repaint(session(), B)))
    expect(painted()).toEqual({ whole: 0, areas: [B] })
  })
})
