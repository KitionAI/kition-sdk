// @vitest-environment jsdom
// regressions/issue-kit-editor-merged-damage: the repaint a refresh asks for was REPLACED by the next
// refresh's when React took both in one render, so the canvas saw only the last area. kition-sheet
// (d89be60) saw a check box ticked by a click stay undrawn: the press changed the document (repaint
// everything), the release changed nothing (the empty area), and the canvas painted nothing.
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas } from './KitCanvas'
import type { KitHost } from './kitHost'
import type { KitModuleManifest } from './kitModule'
import { RasterViewport, mergeDamage, type RasterRect } from './rasterViewport'
import { useKitDocument } from './useKitDocument'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fake = vi.hoisted(() => ({ engine: null as unknown }))
vi.mock('./kitEngine', () => ({ KitEngine: { open: async () => fake.engine } }))
vi.mock('./replica', () => ({ replicaToOpen: async () => null, writeWithReplica: async () => null }))

const NOTHING: RasterRect = { x0: 0, y0: 0, x1: 0, y1: 0 }
const A: RasterRect = { x0: 10, y0: 10, x1: 20, y1: 20 }
const B: RasterRect = { x0: 50, y0: 5, x1: 60, y1: 15 }

/**
 * An engine whose tool calls answer as the kit's engine tools do: `press` changes the document (the
 * revision moves; `damage` names the area when given), `release` (settled) changes nothing more.
 * `edit.*` commands move the revision, `view.*` ones do not.
 */
function fakeEngine() {
  const engine = {
    width: 400,
    height: 200,
    info: { revision: 0, dirty: false, width: 400, height: 200, canUndo: false, canRedo: false, inspected: {} },
    render: async () => new Uint8Array(0),
    renderArea: async () => new Uint8Array(0),
    onFonts: () => () => undefined,
    execute: vi.fn(async (command: string) => {
      if (command.startsWith('edit.')) engine.info = { ...engine.info, revision: engine.info.revision + 1, dirty: true }
      return null
    }),
    tool: vi.fn(async (name: string, args: unknown[]) => {
      if (name === 'press') engine.info = { ...engine.info, revision: engine.info.revision + 1 }
      const damage = (args[0] as { damage?: RasterRect } | undefined)?.damage
      return { value: damage ? { damage } : null, changed: true }
    }),
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

/** The session and its canvas, as a kit's editor shows them; the paints counted from here on. */
async function mount(options = {}) {
  const engine = fakeEngine()
  const renders = { count: 0 }
  const current: { session: ReturnType<typeof useKitDocument<null>> | null } = { session: null }
  function Editor() {
    renders.count += 1
    const session = useKitDocument(host, manifest, 'a.kit', false, () => null, options)
    current.session = session
    const viewMemory = useRef(null)
    return session.doc ? <KitCanvas doc={session.doc} change={session.change} tool={{ id: 't', cursor: 'default', begin: () => undefined }} onView={() => undefined} viewMemory={viewMemory} /> : null
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
  return { engine, renders, session: () => current.session! }
}

/** What the canvas painted since the last call: everything, the areas it patched, or nothing. */
function painted() {
  const result = { whole: paints.render.mock.calls.length, invalidated: paints.invalidate.mock.calls.length, patched: paints.patch.mock.calls.map(([area]) => area) }
  clearPaints()
  return result
}

function clearPaints() {
  paints.invalidate.mockClear()
  paints.render.mockClear()
  paints.patch.mockClear()
}

describe('mergeDamage: two repaints taken together', () => {
  it('the whole canvas wins, the empty area adds nothing, two areas give the rectangle covering both', () => {
    expect(mergeDamage(null, A)).toBeNull()
    expect(mergeDamage(A, null)).toBeNull()
    expect(mergeDamage(null, NOTHING)).toBeNull()
    expect(mergeDamage(NOTHING, null)).toBeNull()
    expect(mergeDamage(A, NOTHING)).toEqual(A)
    expect(mergeDamage(NOTHING, A)).toEqual(A)
    expect(mergeDamage(NOTHING, NOTHING)).toEqual(NOTHING)
    expect(mergeDamage(A, B)).toEqual({ x0: 10, y0: 5, x1: 60, y1: 20 })
    // An area with no pixel (x1 ≤ x0 or y1 ≤ y0) anywhere is empty too.
    expect(mergeDamage(A, { x0: 300, y0: 300, x1: 300, y1: 310 })).toEqual(A)
  })
})

describe('useKitDocument and KitCanvas: refreshes React takes in one render', () => {
  it('a press that changed the document, then a release that changed nothing: the whole canvas repaints', async () => {
    const { session, renders } = await mount()
    const before = { renders: renders.count, revision: session().change.revision }
    await act(async () => {
      await session().tool('press' as never, [])
      await session().tool('release' as never, [], true)
    })
    expect(renders.count).toBe(before.renders + 1)
    expect(session().change.revision).toBe(before.revision + 2)
    expect(painted()).toEqual({ whole: 1, invalidated: 1, patched: [] })
  })

  it('the reverse order (nothing, then everything) repaints the whole canvas too', async () => {
    const { session } = await mount()
    await act(async () => {
      await session().tool('release' as never, [], true)
      await session().tool('press' as never, [])
    })
    expect(painted()).toEqual({ whole: 1, invalidated: 1, patched: [] })
  })

  it('two areas repaint the rectangle covering both, and the empty area between them changes nothing', async () => {
    const { session } = await mount()
    await act(async () => {
      await session().tool('press' as never, [{ damage: A }])
      await session().tool('release' as never, [], true)
      await session().tool('press' as never, [{ damage: B }])
    })
    expect(painted()).toEqual({ whole: 0, invalidated: 0, patched: [{ x0: 10, y0: 5, x1: 60, y1: 20 }] })
  })

  it('the empty area alone paints nothing, and an area already painted is not owed again', async () => {
    const { session } = await mount()
    await act(async () => void (await session().tool('press' as never, [{ damage: A }])))
    expect(painted()).toEqual({ whole: 0, invalidated: 0, patched: [A] })
    await act(async () => void (await session().tool('release' as never, [], true)))
    expect(painted()).toEqual({ whole: 0, invalidated: 0, patched: [] })
    await act(async () => void (await session().tool('press' as never, [{ damage: B }])))
    expect(painted()).toEqual({ whole: 0, invalidated: 0, patched: [B] })
  })

  it("a person's edit, then an agent's read that skips the unchanged paint: the edit's repaint is kept", async () => {
    const { session } = await mount()
    await act(async () => {
      await session().run('edit.thing', {})
      await session().run('view.read', {}, null, { skipUnchangedPaint: true })
    })
    expect(painted()).toEqual({ whole: 1, invalidated: 1, patched: [] })
    // The agent's reads alone still cost the canvas nothing.
    await act(async () => {
      await session().run('view.read', {}, null, { skipUnchangedPaint: true })
      await session().run('view.read', {}, null, { skipUnchangedPaint: true })
    })
    expect(painted()).toEqual({ whole: 0, invalidated: 0, patched: [] })
  })
})
