// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RasterViewport } from './rasterViewport'
import { toolDamage } from './useKitDocument'

const viewports: RasterViewport[] = []
beforeEach(() => {
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  viewports.splice(0).forEach((viewport) => viewport.dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A sheet-like document (headings pinned left and top) in a 200 × 100 canvas. */
function setup() {
  const canvas = { clientWidth: 200, clientHeight: 100 }
  const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
  const doc = { width: 2000, height: 4000, pinned: { left: 40, top: 20 }, render: vi.fn(pixels), renderArea: vi.fn(async (_a: number, _b: number, _c: number, _d: number, width: number, height: number) => new Uint8Array(width * height * 4)) }
  const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false)
  vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
  viewports.push(viewport)
  return { viewport, doc }
}

it('patches only the area a caret changed, even with pinned bands', async () => {
  const { viewport, doc } = setup()
  expect(await viewport.render()).toBe(true)
  const full = doc.render.mock.calls.length
  expect(full).toBeGreaterThan(1)
  doc.render.mockClear()
  // A cell being typed in the scrolled pane: one small render, not every pane again.
  expect(await viewport.renderArea({ x0: 100, y0: 60, x1: 180, y1: 80 })).toBe(true)
  expect(doc.render).toHaveBeenCalledTimes(1)
  const [x, y, , width, height] = doc.render.mock.calls[0]
  expect([x, y]).toEqual([100, 60])
  expect(width * height).toBeLessThanOrEqual(81 * 21 * (window.devicePixelRatio || 1) ** 2)
  // An area across a pinned band patches the band too.
  doc.render.mockClear()
  expect(await viewport.renderArea({ x0: 0, y0: 60, x1: 180, y1: 80 })).toBe(true)
  expect(doc.render.mock.calls.length).toBe(2)
})

it('reads the area a tool answer names, and refuses a broken one', () => {
  expect(toolDamage({ cursor: 'text', damage: { x0: 1, y0: 2, x1: 30, y1: 40 } })).toEqual({ x0: 1, y0: 2, x1: 30, y1: 40 })
  expect(toolDamage({ cursor: 'text' })).toBeNull()
  expect(toolDamage({ damage: { x0: 5, y0: 0, x1: 5, y1: 9 } })).toBeNull()
  expect(toolDamage({ damage: { x0: 'a', y0: 0, x1: 5, y1: 9 } })).toBeNull()
  expect(toolDamage('select')).toBeNull()
  expect(toolDamage(null)).toBeNull()
})

it('keeps a render in flight for a caret move and patches the area once it lands', async () => {
  const { viewport, doc } = setup()
  await viewport.render()
  const panes = doc.render.mock.calls.length
  let release!: () => void
  const original = doc.render.getMockImplementation()!
  doc.render.mockImplementationOnce((x, y, scale, width, height) => new Promise((resolve) => { release = () => resolve(original(x, y, scale, width, height)) }))
  doc.render.mockClear()
  const pending = viewport.render()
  // Two caret moves while it renders: nothing renders for them yet, and the view is not rendered again.
  expect(await viewport.patch({ x0: 100, y0: 60, x1: 180, y1: 80 })).toBe(false)
  expect(await viewport.patch({ x0: 110, y0: 60, x1: 190, y1: 80 })).toBe(false)
  release()
  await pending
  // One whole render (its panes), then one patch covering both moves.
  expect(doc.render.mock.calls.length).toBe(panes + 1)
  const [x, y] = doc.render.mock.calls[panes]
  expect([x, y]).toEqual([100, 60])
})
