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

function setup() {
  const canvas = { clientWidth: 20, clientHeight: 10 }
  const pixels = async (_x: number, _y: number, _scale: number, width: number, height: number) => new Uint8Array(width * height * 4)
  const doc = { width: 20, height: 10, render: vi.fn(pixels), renderArea: vi.fn(async (_x0: number, _y0: number, _x1: number, _y1: number, width: number, height: number) => new Uint8Array(width * height * 4)) }
  const status = vi.fn()
  const viewport = new RasterViewport(canvas as HTMLCanvasElement, doc, '#fff', vi.fn(), false, status)
  vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
  viewports.push(viewport)
  return { viewport, doc, status }
}

describe('render failure reporting', () => {
  it.each([1, 0.5])('reports full-frame rejection at scale %s and clears it only after retry paints', async (zoom) => {
    const { viewport, doc, status } = setup()
    viewport.view.zoom = zoom
    const failure = new Error('page 2 failed')
    if (zoom < 1) doc.renderArea.mockRejectedValueOnce(failure)
    else doc.render.mockRejectedValueOnce(failure)
    expect(await viewport.render()).toBe(false)
    expect(status).toHaveBeenLastCalledWith(failure)
    expect(await viewport.render()).toBe(true)
    expect(status.mock.calls.map(([error]) => error)).toEqual([failure, null])
  })

  it('reports a failed patch and promotes the next patch to a whole-frame retry', async () => {
    const { viewport, doc, status } = setup()
    await viewport.render()
    const failure = new Error('damaged area failed')
    doc.render.mockRejectedValueOnce(failure)
    expect(await viewport.renderArea({ x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(false)
    expect(status).toHaveBeenLastCalledWith(failure)
    expect(await viewport.renderArea({ x0: 4, y0: 4, x1: 5, y1: 5 })).toBe(true)
    expect(doc.render.mock.calls.at(-1)?.slice(-2)).toEqual([20, 10])
    expect(status).toHaveBeenLastCalledWith(null)
  })

  it.each(['dispose', 'edit', 'view'])('ignores an obsolete failure after %s', async (kind) => {
    const { viewport, doc, status } = setup()
    let reject!: (error: Error) => void
    doc.render.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    const pending = viewport.render()
    if (kind === 'dispose') viewport.dispose()
    if (kind === 'edit') viewport.invalidate()
    if (kind === 'view') viewport.panTo(2, 2)
    reject(new Error('obsolete'))
    // After an edit the frame renders again, with the edit, and after a move at the new view; the
    // obsolete failure is never reported.
    expect(await pending).toBe(kind !== 'dispose')
    expect(status).not.toHaveBeenCalledWith(expect.any(Error))
  })

  it('does not publish stale successful pixels after an edit, and renders the edit instead', async () => {
    const { viewport, doc, status } = setup()
    let resolve!: (pixels: Uint8Array<ArrayBuffer>) => void
    doc.render.mockImplementationOnce(() => new Promise((yes) => { resolve = yes }))
    const pending = viewport.render()
    viewport.invalidate()
    resolve(new Uint8Array(20 * 10 * 4))
    expect(await pending).toBe(true)
    expect(doc.render).toHaveBeenCalledTimes(2)
    expect(status.mock.calls).toEqual([[null]])
  })

  it.each(['dispose', 'edit'])('ignores a pending patch failure after %s', async (kind) => {
    const { viewport, doc, status } = setup()
    await viewport.render()
    status.mockClear()
    let reject!: (error: Error) => void
    doc.render.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    const pending = viewport.renderArea({ x0: 0, y0: 0, x1: 2, y1: 2 })
    if (kind === 'dispose') viewport.dispose()
    else viewport.invalidate()
    reject(new Error('obsolete patch'))
    expect(await pending).toBe(false)
    expect(status).not.toHaveBeenCalled()
  })
})
