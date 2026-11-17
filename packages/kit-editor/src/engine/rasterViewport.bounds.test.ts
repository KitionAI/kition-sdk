// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RasterViewport } from './rasterViewport'

const viewports: RasterViewport[] = []
afterEach(() => {
  viewports.splice(0).forEach((viewport) => viewport.dispose())
  vi.restoreAllMocks()
})

function setup(width = 400, height = 300) {
  const canvas = { clientWidth: width, clientHeight: height, getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight }) }
  const pixels = async () => new Uint8Array()
  const viewport = new RasterViewport(canvas as HTMLCanvasElement, { width: 600, height: 1600, render: pixels, renderArea: pixels }, '#fff', vi.fn(), false)
  vi.spyOn(viewport, 'draw').mockImplementation(() => undefined)
  viewports.push(viewport)
  return { viewport, canvas }
}

const pages = { x0: -24, y0: -24, x1: 624, y1: 1624 }

describe('a document with bounded scrolling', () => {
  it('stops wheel panning at the first and last page with a page margin', () => {
    const { viewport } = setup()
    viewport.setPanBounds(pages)
    viewport.panBy(10_000, 10_000)
    expect(viewport.view).toEqual({ zoom: 1, x: -24, y: -24 })
    viewport.panBy(-100_000, -100_000)
    expect(viewport.view).toEqual({ zoom: 1, x: 224, y: 1324 })
  })

  it('still scrolls within the pages and keeps their zoom', () => {
    const { viewport } = setup()
    viewport.setPanBounds(pages)
    viewport.zoomTo(2)
    viewport.panTo(100, 500)
    viewport.panBy(-40, -60)
    expect(viewport.view).toEqual({ zoom: 2, x: 120, y: 530 })
    viewport.panTo(100_000, 100_000)
    expect(viewport.view).toEqual({ zoom: 2, x: 424, y: 1474 })
  })

  it('centres a document smaller than the canvas instead of allowing empty scrolling', () => {
    const { viewport } = setup(1000, 2000)
    viewport.setPanBounds(pages)
    viewport.panTo(10_000, -10_000)
    expect(viewport.view).toEqual({ zoom: 1, x: -200, y: -200 })
  })

  it('keeps a view at the top of the pages there when the window gets shorter', () => {
    const { viewport, canvas } = setup(400, 1000)
    viewport.setPanBounds(pages)
    viewport.panTo(0, -24)
    viewport.resized()
    canvas.clientHeight = 500
    viewport.resized()
    expect(viewport.view.y).toBe(-24)
    canvas.clientHeight = 900
    viewport.resized()
    expect(viewport.view.y).toBe(-24)
  })

  it('keeps the middle of a scrolled view in place when the window resizes', () => {
    const { viewport, canvas } = setup(400, 1000)
    viewport.setPanBounds(pages)
    viewport.panTo(0, 300)
    viewport.resized()
    canvas.clientHeight = 600
    viewport.resized()
    expect(viewport.view.y).toBe(500)
  })

  it('brings a view back within the pages when pages are removed', () => {
    const { viewport } = setup()
    viewport.setPanBounds(pages)
    viewport.panTo(0, 1300)
    viewport.setPanBounds({ ...pages, y1: 824 })
    expect(viewport.view.y).toBe(524)
    viewport.setPanBounds(pages)
    viewport.panTo(0, 1300)
    expect(viewport.view.y).toBe(1300)
  })

  it('keeps the document in view when the canvas grows', () => {
    const { viewport, canvas } = setup()
    viewport.setPanBounds(pages)
    viewport.resized()
    viewport.panTo(224, 1324)
    canvas.clientHeight = 1800
    canvas.clientWidth = 800
    viewport.resized()
    expect(viewport.view).toEqual({ zoom: 1, x: -100, y: -100 })
  })

  it('leaves a free canvas unbounded, including after bounds are removed', () => {
    const { viewport } = setup()
    viewport.panTo(-1000, 4000)
    expect(viewport.view).toEqual({ zoom: 1, x: -1000, y: 4000 })
    viewport.setPanBounds(pages)
    viewport.setPanBounds(null)
    viewport.panTo(-1000, 4000)
    expect(viewport.view).toEqual({ zoom: 1, x: -1000, y: 4000 })
  })
})
