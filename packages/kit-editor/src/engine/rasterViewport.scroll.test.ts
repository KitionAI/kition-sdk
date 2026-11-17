// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RasterViewport } from './rasterViewport'

const viewports: RasterViewport[] = []
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  frames = []
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  viewports.splice(0).forEach((viewport) => viewport.dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A tall document (a long note) in a 100 × 50 canvas. */
function setup(height = 1000) {
  const canvas = { clientWidth: 100, clientHeight: 50 }
  const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
  const doc = { width: 100, height, render: vi.fn(pixels), renderArea: vi.fn(async (_x0: number, _y0: number, _x1: number, _y1: number, width: number, height: number) => new Uint8Array(width * height * 4)) }
  const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false)
  vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
  viewports.push(viewport)
  return { viewport, doc }
}

/** Runs the animation frames asked for so far, and the renders they start. */
async function nextFrame() {
  const pending = frames.splice(0)
  pending.forEach((callback) => callback(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a view that keeps moving', () => {
  it('paints the next animation frame, not once the view settles', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 300)
    viewport.panTo(0, 320)
    expect(doc.render).not.toHaveBeenCalled()
    await nextFrame()
    // One render for the two moves, at the latest view.
    expect(doc.render).toHaveBeenCalledTimes(1)
    expect(doc.render.mock.calls[0][1]).toBeLessThanOrEqual(320)
  })

  it('shows a render the view moved away from, then renders where the view is', async () => {
    const { viewport, doc } = setup()
    let release!: () => void
    doc.render.mockImplementationOnce((_x, _y, _scale, width, height) => new Promise((resolve) => { release = () => resolve(new Uint8Array(width * height * 4)) }))
    const pending = viewport.render()
    viewport.panTo(0, 400)
    release()
    expect(await pending).toBe(true)
    // The first render was drawn (it shows the area it rendered), and the moved view rendered after it.
    expect(doc.render).toHaveBeenCalledTimes(2)
    const [, y, , , frameHeight] = doc.render.mock.calls[1]
    expect(y).toBeLessThanOrEqual(400)
    expect(y + frameHeight).toBeGreaterThanOrEqual(450)
  })
})

describe("a render asked for the next frame", () => {
  it("is called off with cancelAnimationFrame, never clearTimeout (which would stop another timer with that number)", async () => {
    const { viewport } = setup()
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    viewport.panTo(0, 100)
    await viewport.render()
    viewport.panTo(0, 200)
    viewport.dispose()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(clearTimeout).not.toHaveBeenCalled()
  })
})

describe('a scroll past the painted frame', () => {
  it('keeps the frame where it was until the new view is painted, so the canvas never shows blank', async () => {
    const canvas = { clientWidth: 100, clientHeight: 50 }
    const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
    const doc = { width: 100, height: 100_000, render: vi.fn(pixels), renderArea: vi.fn(pixels) }
    const onChange = vi.fn()
    const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', onChange, false)
    vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
    viewports.push(viewport)
    await viewport.render()
    onChange.mockClear()
    // A drag of the scroll bar jumps far past the frame (half a view past the view at most).
    viewport.panTo(0, 50_000)
    expect(viewport.view.y).toBe(50_000)
    expect(onChange).not.toHaveBeenCalled()
    expect(viewport.toScreen(0, 10).y).toBe(10)
    await nextFrame()
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 50_000 }, expect.anything())
    expect(viewport.toScreen(0, 50_010).y).toBe(10)
  })

  it('shows the view a late render painted while the scroll goes on, then the scroll', async () => {
    const canvas = { clientWidth: 100, clientHeight: 50 }
    const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
    const doc = { width: 100, height: 100_000, render: vi.fn(pixels), renderArea: vi.fn(pixels) }
    const onChange = vi.fn()
    const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', onChange, false)
    vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
    viewports.push(viewport)
    await viewport.render()
    let release!: () => void
    doc.render.mockImplementationOnce((_x, _y, _scale, width, height) => new Promise((resolve) => { release = () => resolve(new Uint8Array(width * height * 4)) }))
    viewport.panTo(0, 10_000)
    const first = viewport.render()
    viewport.panTo(0, 20_000)
    // The render for 10 000 lands: that view shows (the frame covers it), not blank canvas at 20 000.
    let shownAtFirst: unknown = null
    onChange.mockImplementationOnce((view) => { shownAtFirst = view })
    release()
    await first
    expect(shownAtFirst).toEqual({ zoom: 1, x: 0, y: 10_000 })
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 20_000 }, expect.anything())
  })

  it('shows a scroll within the frame at once', async () => {
    const { viewport } = setup()
    const onChange = vi.fn()
    ;(viewport as unknown as { onChange: typeof onChange }).onChange = onChange
    await viewport.render()
    viewport.panTo(0, 20)
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 20 }, null)
  })
})

describe('the frame reaches past the view', () => {
  it('renders half a view above and below the view along the scrolled axis', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 400)
    await nextFrame()
    const [x, y, scale, width, height] = doc.render.mock.calls[0]
    expect([x, y, scale, width]).toEqual([0, 375, 1, 100])
    expect(height).toBe(100)
  })

  it('stops at the document', async () => {
    const { viewport, doc } = setup()
    await viewport.render()
    const [, y, , , height] = doc.render.mock.calls[0]
    expect([y, height]).toEqual([0, 75])
  })

  it('reaches less, or not at all, when the frame would pass the largest image', async () => {
    // A 3000 × 1500 view is 4 500 000 pixels: half a view more each side would pass the largest
    // image, a quarter would not.
    const canvas = { clientWidth: 3000, clientHeight: 1500 }
    const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
    const doc = { width: 3000, height: 100_000, render: vi.fn(pixels), renderArea: vi.fn(pixels) }
    const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false)
    vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
    viewports.push(viewport)
    viewport.panTo(0, 50_000)
    await nextFrame()
    const [, y, scale, , height] = doc.render.mock.calls[0]
    expect([y, scale, height]).toEqual([49_625, 1, 2250])
  })
})

describe('a large canvas', () => {
  it('renders the view at the screen\'s own pixels, never scaled down into blurred text', async () => {
    // A 2400 × 1160 canvas on a 2× screen is 11 136 000 device pixels a view.
    vi.stubGlobal('devicePixelRatio', 2)
    const canvas = { clientWidth: 2400, clientHeight: 1160 }
    const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
    const doc = { width: 2400, height: 100_000, render: vi.fn(pixels), renderArea: vi.fn(pixels) }
    const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false)
    vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
    viewports.push(viewport)
    viewport.panTo(0, 50_000)
    await nextFrame()
    const [, , scale, width, height] = doc.render.mock.calls[0]
    expect(scale).toBe(2)
    expect(width).toBe(4800)
    expect(height).toBeGreaterThanOrEqual(2320)
  })
})
