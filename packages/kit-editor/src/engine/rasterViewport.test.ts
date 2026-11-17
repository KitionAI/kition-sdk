// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { RasterViewport, viewPanes, type RasterPins } from './rasterViewport'

describe('view panes', () => {
  it('is one scrolled pane without pinned bands', () => {
    expect(viewPanes({ zoom: 2, x: 10, y: -5 }, { left: 0, top: 0 }, 400, 300)).toEqual([
      { pinX: false, pinY: false, offX: 10, offY: -5, clip: { x0: 0, y0: 0, x1: 400, y1: 300 }, area: { x0: 10, y0: -5, x1: 210, y1: 145 } },
    ])
  })

  it('splits at pinned bands, the rest scrolled under them', () => {
    const panes = viewPanes({ zoom: 2, x: 100, y: 40 }, { left: 50, top: 20 }, 400, 300)
    expect(panes.map((pane) => [pane.pinX, pane.pinY])).toEqual([
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ])
    const corner = panes[0]
    expect(corner.clip).toEqual({ x0: 0, y0: 0, x1: 100, y1: 40 })
    expect(corner.area).toEqual({ x0: 0, y0: 0, x1: 50, y1: 20 })
    const rest = panes[3]
    // Scrolled by 100: the first document column after the band is 150, shown at the split.
    expect(rest.clip).toEqual({ x0: 100, y0: 40, x1: 400, y1: 300 })
    expect(rest.area).toEqual({ x0: 150, y0: 60, x1: 300, y1: 190 })
    expect((rest.area.x0 - rest.offX) * 2).toBe(rest.clip.x0)
  })

  it('shows only the band when it fills the canvas', () => {
    const panes = viewPanes({ zoom: 1, x: 0, y: 0 }, { left: 0, top: 500 }, 400, 300)
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({ pinY: true, clip: { y0: 0, y1: 300 }, area: { y0: 0, y1: 300 } })
  })
})

describe('resizing the canvas', () => {
  const viewports: RasterViewport[] = []
  afterEach(() => viewports.splice(0).forEach((viewport) => viewport.dispose()))

  /** A 400 × 300 document on a canvas whose size the test sets. */
  function setup(pinned?: RasterPins) {
    const canvas = { clientWidth: 0, clientHeight: 0, width: 0, height: 0, getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight }) }
    const empty = async () => new Uint8Array()
    const doc = { width: 400, height: 300, pinned, render: empty, renderArea: empty }
    const viewport = new RasterViewport(canvas as unknown as HTMLCanvasElement, doc, '#fff', () => {})
    viewports.push(viewport)
    const resize = (width: number, height: number) => {
      canvas.clientWidth = width
      canvas.clientHeight = height
      viewport.resized()
    }
    return { viewport, resize }
  }

  /** The document point at the canvas centre. */
  const centre = (viewport: RasterViewport, width: number, height: number) => ({ x: viewport.view.x + width / 2 / viewport.view.zoom, y: viewport.view.y + height / 2 / viewport.view.zoom })

  it('fits a fitted document again, centred', () => {
    const { viewport, resize } = setup()
    resize(464, 364)
    viewport.fit()
    expect(viewport.view).toEqual({ zoom: 1, x: -32, y: -32 })
    resize(864, 664)
    expect(viewport.view.zoom).toBe(2)
    expect(centre(viewport, 864, 664)).toEqual({ x: 200, y: 150 })
  })

  it('fits a fitted area again', () => {
    const { viewport, resize } = setup()
    resize(264, 164)
    viewport.fitArea({ x0: 100, y0: 100, x1: 300, y1: 200 })
    resize(464, 264)
    expect(viewport.view).toEqual({ zoom: 2, x: 84, y: 84 })
  })

  it('keeps the centre of a zoomed or panned view', () => {
    const { viewport, resize } = setup()
    resize(464, 364)
    viewport.fit()
    viewport.panBy(-50, -20)
    const before = centre(viewport, 464, 364)
    resize(1000, 800)
    expect(viewport.view.zoom).toBe(1)
    expect(centre(viewport, 1000, 800)).toEqual(before)
    // Moving the view ends the fit: a later resize keeps the zoom.
    resize(464, 364)
    expect(viewport.view.zoom).toBe(1)
  })

  it('keeps the top-left with pinned bands', () => {
    const { viewport, resize } = setup({ left: 40, top: 20 })
    resize(400, 300)
    viewport.panTo(10, 10)
    resize(800, 600)
    expect(viewport.view).toEqual({ zoom: 1, x: 10, y: 10 })
  })
})

describe('the backdrop', () => {
  it('paints a new backdrop at once when the theme changes it, and ignores the same colour', () => {
    const fills: string[] = []
    const context = {
      setTransform: () => undefined,
      fillRect: () => fills.push(context.fillStyle),
      fillStyle: '',
      save: () => undefined,
      restore: () => undefined,
      drawImage: () => undefined,
    }
    const canvas = { clientWidth: 100, clientHeight: 50, width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50 }) }
    const empty = async () => new Uint8Array()
    const viewport = new RasterViewport(canvas as unknown as HTMLCanvasElement, { width: 10, height: 10, render: empty, renderArea: empty }, '#f3f3f6', () => {}, false)
    viewport.draw()
    expect(fills[0]).toBe('#f3f3f6')
    viewport.setBackdrop('#1e1f22')
    expect(fills.at(-1)).toBe('#1e1f22')
    const count = fills.length
    viewport.setBackdrop('#1e1f22')
    expect(fills.length).toBe(count)
    viewport.dispose()
  })
})
