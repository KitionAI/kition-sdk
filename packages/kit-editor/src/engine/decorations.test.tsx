// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawnOnce, stackDecorations } from './decorations'
import type { RasterDecoration } from './rasterViewport'
import { KitDocumentCanvas, KitEditorProvider, type KitEditor, type KitTools } from '../editor'
import { EMPTY_UI_CONFIG } from '../uiConfig'
import { createUiStore } from '../uiStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The decoration the canvas was last given (the real canvas needs a 2D context jsdom lacks). */
const drawn = vi.hoisted(() => ({ decorate: undefined as RasterDecoration | null | undefined }))
vi.mock('./KitCanvas', () => ({
  KitCanvas: ({ decorate }: { decorate?: RasterDecoration | null }) => {
    drawn.decorate = decorate
    return null
  },
}))

/** A 2D context that records what is drawn, and its save/restore depth. */
function recorder() {
  const log: string[] = []
  let depth = 0
  const context = {
    save: () => {
      depth += 1
    },
    restore: () => {
      depth -= 1
    },
    fillText: (text: string) => log.push(`${text} at depth ${depth}`),
  } as unknown as CanvasRenderingContext2D
  return { log, context }
}
const toScreen = (x: number, y: number) => ({ x, y })
const view = { zoom: 1, x: 0, y: 0 }
const drawing = (name: string): RasterDecoration => (context) => context.fillText(name, 0, 0)

describe('stackDecorations', () => {
  it('draws the engine overlays first and the kit decoration over them, each on its own state', () => {
    const { log, context } = recorder()
    stackDecorations(drawing('caret'), drawing('pins'))!(context, toScreen, view)
    expect(log).toEqual(['caret at depth 1', 'pins at depth 1'])
  })

  it('answers either alone when the other is absent', () => {
    const only = drawing('caret')
    expect(stackDecorations(only, null)).toBe(only)
    expect(stackDecorations(undefined, only)).toBe(only)
    expect(stackDecorations(null, null)).toBeNull()
  })

  it("does not draw the engine overlays twice when the kit's decoration draws them too", () => {
    const { log, context } = recorder()
    const engine = drawnOnce(drawing('caret'))
    const kit: RasterDecoration = (ctx, at, v) => {
      engine(ctx, at, v)
      ctx.fillText('pins', 0, 0)
    }
    stackDecorations(engine, kit)!(context, toScreen, view)
    expect(log).toEqual(['caret at depth 1', 'pins at depth 1'])
    // Outside a stack it draws, every time.
    engine(context, toScreen, view)
    engine(context, toScreen, view)
    expect(log.filter((line) => line.startsWith('caret'))).toHaveLength(3)
  })

  it('draws the kit decoration even when the engine overlays throw, and forgets the frame', () => {
    const { log, context } = recorder()
    const engine = drawnOnce(() => {
      throw new Error('broken overlay')
    })
    expect(() => stackDecorations(engine, drawing('pins'))!(context, toScreen, view)).toThrow('broken overlay')
    expect(log).toEqual([])
    const fine = drawnOnce(drawing('caret'))
    stackDecorations(fine, drawing('pins'))!(context, toScreen, view)
    fine(context, toScreen, view)
    expect(log).toEqual(['caret at depth 1', 'pins at depth 1', 'caret at depth 0'])
  })
})

describe('KitDocumentCanvas', () => {
  let root: Root | null = null
  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = null
    drawn.decorate = undefined
  })

  const noRepaint = { tick: 0, damage: null }
  const editor = {
    session: { doc: { info: { revision: 1 } }, change: { revision: 1, damage: null }, failure: null, repaints: { subscribe: () => () => undefined, get: () => noRepaint } },
    host: { ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined), init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration: {}, peer: { handle() {} } },
    commands: [],
    byId: new Map(),
    enabled: () => true,
    t: (key: string) => key,
    phrase: (english: string) => english,
    testId: 'k',
  } as unknown as KitEditor
  const tools = (decorate: RasterDecoration | null) => ({ decorate, canvasTool: { id: 'select' }, wantsText: false, typeText: () => undefined, keyDown: () => false }) as unknown as KitTools

  function draw(decorate: RasterDecoration | null, engine: RasterDecoration | null, under: RasterDecoration | null = null) {
    const container = document.createElement('div')
    root = createRoot(container)
    act(() =>
      root!.render(
        <KitEditorProvider editor={editor} tools={tools(engine)}>
          <KitDocumentCanvas canvas={{ current: null }} decorate={decorate} decorateUnder={under} />
        </KitEditorProvider>,
      ),
    )
    const { log, context } = recorder()
    drawn.decorate?.(context, toScreen, view)
    return log
  }

  it("draws the engine's caret and selection under the kit's own decoration, which no longer replaces them", () => {
    expect(draw(drawing('pins'), drawnOnce(drawing('caret')))).toEqual(['caret at depth 1', 'pins at depth 1'])
  })

  it("draws the engine's overlays alone without a kit decoration, and the kit's alone without overlays", () => {
    expect(draw(null, drawing('caret'))).toEqual(['caret at depth 0'])
    act(() => root!.unmount())
    root = null
    expect(draw(drawing('pins'), null)).toEqual(['pins at depth 0'])
  })

  it("draws the kit's underlay under the engine's overlays, and the overlays once when the kit's decoration draws them too", () => {
    expect(draw(drawing('pins'), drawnOnce(drawing('caret')), drawing('grid'))).toEqual(['grid at depth 2', 'caret at depth 2', 'pins at depth 1'])
    act(() => root!.unmount())
    root = null
    const engine = drawnOnce(drawing('caret'))
    const kit: RasterDecoration = (ctx, at, v) => {
      engine(ctx, at, v)
      ctx.fillText('pins', 0, 0)
    }
    expect(draw(kit, engine, drawing('grid'))).toEqual(['grid at depth 2', 'caret at depth 2', 'pins at depth 1'])
  })
})
