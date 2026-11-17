// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RasterViewport } from './rasterViewport'

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

describe('an edit during a render', () => {
  it('renders again when an edit drops the render in flight, even with no repaint of its own', async () => {
    const canvas = { clientWidth: 20, clientHeight: 10 }
    let release!: () => void
    const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
    const render = vi.fn(pixels)
    render.mockImplementationOnce((_x, _y, _scale, width, height) => new Promise((resolve) => { release = () => resolve(new Uint8Array(width * height * 4)) }))
    const doc = { width: 20, height: 10, render, renderArea: vi.fn(pixels) }
    const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false)
    const draw = vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
    viewports.push(viewport)
    // A slow render of a large document is in flight when a settled click changes nothing more:
    // its refresh invalidates the frame and asks for no repaint.
    const pending = viewport.render()
    viewport.invalidate()
    release()
    await pending
    expect(render).toHaveBeenCalledTimes(2)
    expect(draw).toHaveBeenCalled()
  })
})
