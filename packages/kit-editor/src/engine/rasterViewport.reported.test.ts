// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RasterViewport, type RasterView } from './rasterViewport'

// The view the canvas reports is the one it draws and maps pointers with (case
// regressions/issue-reported-view-is-drawn-view). Since frames lie on whole device pixels
// (sdk.editor.canvas-by-hand), the document is drawn at its view moved onto a whole device pixel;
// the view reported to the kit (`onChange`, KitCanvas's `onView` and `view()`) was still the one
// before that move, up to half a device pixel off. A point placed from it (a kit's guides and
// rulers, a test's pointer) missed the pixel drawn there: Kition Photo's marquee from document
// row 24 to 72 at 100 % in an odd-height canvas selected rows 24 to 73, Kition Layout's shape
// drawn to y 398 ended at 397.9 (Chromium) or 397 (WebKit).

beforeEach(() => {
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  const context = { imageSmoothingEnabled: true, putImageData: vi.fn(), drawImage: vi.fn(), setTransform: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A `width` × `height` canvas (CSS pixels) at (`left`, `top`) on the page, over a `docWidth` × `docHeight` document. */
function setup({ width, height, docWidth, docHeight, left = 0, top = 0 }: { width: number; height: number; docWidth: number; docHeight: number; left?: number; top?: number }) {
  const canvas = { clientWidth: width, clientHeight: height, width: 0, height: 0, getContext: () => HTMLCanvasElement.prototype.getContext.call(canvas as never, '2d'), getBoundingClientRect: () => ({ left, top, width, height }) }
  const pixels = async (_x: number, _y: number, _scale: number, w: number, h: number) => new Uint8Array(w * h * 4)
  const doc = { width: docWidth, height: docHeight, render: vi.fn(pixels), renderArea: vi.fn(async (_x0: number, _y0: number, _x1: number, _y1: number, w: number, h: number) => new Uint8Array(w * h * 4)) }
  const onChange = vi.fn()
  const viewport = new RasterViewport(canvas as unknown as HTMLCanvasElement, doc, '#fff', onChange, false)
  return { viewport, onChange, left, top }
}

/** A document point placed on screen from the reported view lands where the canvas draws it, and a pointer there reads it back exactly. */
function expectReportedIsDrawn(viewport: RasterViewport, reported: RasterView, left: number, top: number) {
  for (const [x, y] of [[0, 0], [24, 72], [33.25, 17.5]]) {
    const screen = { x: (x - reported.x) * reported.zoom, y: (y - reported.y) * reported.zoom }
    const drawn = viewport.toScreen(x, y)
    expect(drawn.x).toBeCloseTo(screen.x, 9)
    expect(drawn.y).toBeCloseTo(screen.y, 9)
    const read = viewport.toImage(left + screen.x, top + screen.y)
    expect(read.x).toBeCloseTo(x, 9)
    expect(read.y).toBeCloseTo(y, 9)
  }
}

describe('the view the canvas reports', () => {
  it('is the one it draws: a small document centred in an odd-sized canvas at 100 %', () => {
    // 128 × 96 in 301 × 151: centred, its top-left is at (-86.5, -27.5), half a pixel off the grid.
    const { viewport, onChange, left, top } = setup({ width: 301, height: 151, docWidth: 128, docHeight: 96, left: 10, top: 40 })
    viewport.setPanBounds({ x0: 0, y0: 0, x1: 128, y1: 96 })
    const reported = onChange.mock.lastCall![0] as RasterView
    expect(Number.isInteger(reported.x) && Number.isInteger(reported.y)).toBe(true)
    expectReportedIsDrawn(viewport, reported, left, top)
  })

  it.each([[1.5, 1], [1, 2], [0.5, 1], [1, 1]])('is the one it draws at zoom %s on a %s× screen after a pan to a fraction', (zoom, dpr) => {
    vi.stubGlobal('devicePixelRatio', dpr)
    const { viewport, onChange, left, top } = setup({ width: 100, height: 50, docWidth: 100, docHeight: 100_000 })
    viewport.zoomTo(zoom)
    viewport.panTo(3.3, 1001.7)
    const reported = onChange.mock.lastCall![0] as RasterView
    expect(reported.zoom).toBe(zoom)
    expectReportedIsDrawn(viewport, reported, left, top)
  })

  it('stays exactly as asked when it already lies on whole device pixels', () => {
    const { viewport, onChange } = setup({ width: 100, height: 50, docWidth: 100, docHeight: 100_000 })
    viewport.panTo(0, 1040)
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 1040 }, null)
  })
})
