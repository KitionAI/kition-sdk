// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RasterViewport } from './rasterViewport'

// Stage S1 of "design usable by hand": a pan past the painted frame shows at once and renders only
// what it uncovered; a whole render with a frame on screen paints the view first and its margin
// once the canvas is still, a slice at a time; frames lie on whole device pixels at any zoom.

const viewports: RasterViewport[] = []
let frames: FrameRequestCallback[] = []
let drawn: { args: unknown[]; smoothing: boolean }[] = []
beforeEach(() => {
  frames = []
  drawn = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  const context = {
    imageSmoothingEnabled: true,
    putImageData: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => drawn.push({ args, smoothing: context.imageSmoothingEnabled })),
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  viewports.splice(0).forEach((viewport) => viewport.dispose())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A tall document in a 100 × 50 canvas (CSS pixels). */
function setup({ width = 100, height = 50, docHeight = 100_000 } = {}) {
  const canvas = { clientWidth: width, clientHeight: height, width: 0, height: 0, getContext: () => HTMLCanvasElement.prototype.getContext.call(canvas as never, '2d'), getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) }
  const pixels = async (_x: number, _y: number, _scale: number, w: number, h: number) => new Uint8Array(w * h * 4)
  const doc = { width: 100, height: docHeight, render: vi.fn(pixels), renderArea: vi.fn(async (_x0: number, _y0: number, _x1: number, _y1: number, w: number, h: number) => new Uint8Array(w * h * 4)) }
  const onChange = vi.fn()
  const viewport = new RasterViewport(canvas as unknown as HTMLCanvasElement, doc, '#fff', onChange, false)
  viewports.push(viewport)
  return { viewport, doc, onChange }
}

/** Runs the animation frames asked for so far, and the renders they start. */
async function nextFrame() {
  const pending = frames.splice(0)
  pending.forEach((callback) => callback(0))
  await vi.advanceTimersByTimeAsync(0)
}

describe('a pan past the painted frame', () => {
  it('shows at once and renders only the rows it uncovered', async () => {
    const { viewport, doc, onChange } = setup()
    viewport.panTo(0, 1000)
    await nextFrame()
    // The view (1000–1050) and half a view each side: 975–1075.
    expect(doc.render.mock.calls.map((call) => [call[1], call[4]])).toEqual([[975, 100]])
    doc.render.mockClear()
    onChange.mockClear()
    // 40 rows past the frame's end: the view shows now, its last 15 rows blank until rendered.
    viewport.panTo(0, 1040)
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 1040 }, null)
    expect(viewport.toScreen(0, 1050).y).toBe(10)
    await nextFrame()
    // Only what the view lacked: rows 1075–1090. The frame keeps what is within its margin (1015–1075).
    expect(doc.render.mock.calls.map((call) => [call[1], call[4]])).toEqual([[1075, 15]])
    expect(onChange).toHaveBeenLastCalledWith({ zoom: 1, x: 0, y: 1040 }, expect.objectContaining({ frameHeight: 75 }))
  })

  it.each([1, 0.75, 0.5])('renders nothing for a pan within the frame at zoom %s', async (zoom) => {
    const { viewport, doc } = setup()
    viewport.zoomTo(zoom)
    viewport.panTo(0, 1000)
    await nextFrame()
    doc.render.mockClear()
    doc.renderArea.mockClear()
    viewport.panTo(0, 1010)
    await nextFrame()
    expect(doc.render).not.toHaveBeenCalled()
    expect(doc.renderArea).not.toHaveBeenCalled()
  })

  it('grows the margin back once the canvas is still, a quarter of the view at a time', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 1000)
    await nextFrame()
    viewport.panTo(0, 1040)
    await nextFrame()
    doc.render.mockClear()
    // Still moving (or patching): nothing grows yet.
    await vi.advanceTimersByTimeAsync(100)
    viewport.panTo(0, 1039)
    await nextFrame()
    await vi.advanceTimersByTimeAsync(100)
    expect(doc.render).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    const slices = doc.render.mock.calls.map((call) => call[3] * call[4])
    expect(slices.length).toBeGreaterThan(1)
    expect(Math.max(...slices)).toBeLessThanOrEqual(100 * 50 * 0.25)
    // The frame reaches half a view past the view again, and then stops growing.
    doc.render.mockClear()
    viewport.panTo(0, 1039 + 24)
    await nextFrame()
    await vi.advanceTimersByTimeAsync(2000)
    expect(doc.render.mock.calls.reduce((rows, call) => rows + call[4], 0)).toBe(24)
  })

  it('still waits for a jump past every painted pixel, showing the frame where it was', async () => {
    const { viewport, onChange } = setup()
    await viewport.render()
    onChange.mockClear()
    viewport.panTo(0, 50_000)
    expect(onChange).not.toHaveBeenCalled()
    expect(viewport.toScreen(0, 10).y).toBe(10)
  })
})

describe('a whole render with a frame on screen', () => {
  it('renders the view alone first, then its margin when the canvas is still', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 1000)
    await nextFrame()
    doc.render.mockClear()
    // An edit (or a zoom, an undo): the view, not the view and its margin, four times as much.
    viewport.invalidate()
    await viewport.render()
    expect(doc.render.mock.calls.map((call) => [call[1], call[4]])).toEqual([[1000, 50]])
    doc.render.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    const rows = doc.render.mock.calls.map((call) => [call[1], call[4]])
    expect(rows.reduce((sum, [, height]) => sum + height, 0)).toBe(50)
    expect(Math.min(...rows.map(([y]) => y))).toBe(975)
  })

  it('renders the view and its margin at once when nothing is on screen yet', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 1000)
    await viewport.render()
    expect(doc.render.mock.calls.map((call) => [call[1], call[4]])).toEqual([[975, 100]])
  })

  it('patches made while the margin waits keep it waiting', async () => {
    const { viewport, doc } = setup()
    viewport.panTo(0, 1000)
    await nextFrame()
    viewport.invalidate()
    await viewport.render()
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(60)
      await viewport.patch({ x0: 10, y0: 1010, x1: 20, y1: 1020 })
    }
    // Five patches, 60 ms apart: the margin has not started.
    expect(doc.render.mock.calls.slice(-5).every((call) => call[3] === 10 && call[4] === 10)).toBe(true)
  })
})

describe('frames on whole device pixels', () => {
  const whole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6
  it.each([[1.5, 1], [1, 2], [0.5, 1], [3, 1]])('at zoom %s on a %s× screen, copies a frame pixel for pixel at a whole device pixel', async (zoom, dpr) => {
    vi.stubGlobal('devicePixelRatio', dpr)
    const { viewport, doc } = setup()
    viewport.zoomTo(zoom)
    viewport.panTo(3.3, 1001.7)
    await viewport.render()
    const device = zoom * dpr
    const reduced = device < 1
    const call = (reduced ? doc.renderArea.mock.calls.at(-1)! : doc.render.mock.calls.at(-1)!) as number[]
    // The frame starts on the document's grid at its scale: a whole bitmap pixel from the origin.
    const frameX = call[0]
    expect(whole(reduced ? frameX / Math.round(1 / device) : frameX * device)).toBe(true)
    drawn = []
    viewport.draw()
    const [, x, y, width] = drawn.at(-1)!.args as number[]
    expect(drawn.at(-1)!.smoothing).toBe(false)
    expect(whole(x * dpr) && whole(y * dpr)).toBe(true)
    // One bitmap pixel per device pixel.
    expect(width * dpr).toBeCloseTo(reduced ? call[4] : call[3], 9)
    // Decorations and pointers use the same placement: the frame's first column is on a whole device pixel.
    expect(whole(viewport.toScreen(frameX, 2000).x * dpr)).toBe(true)
  })
})
