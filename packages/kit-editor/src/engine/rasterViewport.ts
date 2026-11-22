/** What the viewport needs from an engine: the document size and two render calls. */
export type RasterSource = {
  readonly width: number
  readonly height: number
  /** Bands that stay in view while the rest scrolls (engine contract E10); none when absent. */
  readonly pinned?: RasterPins
  render(x: number, y: number, scale: number, width: number, height: number): Promise<Uint8Array>
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Promise<Uint8Array>
}

/** The largest image the engine renders for one frame with a margin past the view (see AHEAD). */
const MAX_FRAME_PIXELS = 8_000_000
/**
 * The largest image for the view alone: a large canvas on a dense screen (a wide window on a 2×
 * display passes MAX_FRAME_PIXELS) still renders at the screen's own pixels, as text drawn scaled
 * up blurs. Bigger views (and sides past the engine's MAX_RENDER_SIDE) are drawn scaled up.
 */
const MAX_VIEW_PIXELS = 33_554_432
const MAX_RENDER_SIDE = 8192
/**
 * How far past the view a frame reaches along a scrolled axis, as a share of the view on each
 * side, so a scroll or a pan shows painted pixels before its own render lands. Smaller when the
 * frame would pass MAX_FRAME_PIXELS: the margin never costs the frame its sharpness.
 */
const AHEAD = [0.5, 0.25, 0]
const FIT_MARGIN = 32
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64
const CHECKER = 8

/**
 * The view: `zoom` screen pixels per image pixel, with image point (`x`, `y`) at the top-left.
 * Along an axis with a pinned band, `x` (or `y`) is how far the rest is scrolled under the band.
 */
export type RasterView = { zoom: number; x: number; y: number }

/** The columns left of `left` and the rows above `top` (document pixels) stay in view. */
export type RasterPins = { left: number; top: number }

/**
 * A part of the canvas showing the document unscrolled along a pinned axis (`pinX`, `pinY`) or
 * scrolled: document point (`dx`, `dy`) is at canvas point ((`dx` − `offX`) × zoom, …), shown
 * within the canvas rectangle `clip` (CSS pixels) and covering document area `area`.
 */
export type RasterPane = { pinX: boolean; pinY: boolean; offX: number; offY: number; clip: RasterRect; area: RasterRect }

type Span = { pinned: boolean; off: number; s0: number; s1: number; d0: number; d1: number }

function spans(pin: number, scroll: number, extent: number, zoom: number): Span[] {
  const scrolled = (s0: number, d0: number): Span => ({ pinned: false, off: scroll, s0, s1: extent, d0, d1: scroll + extent / zoom })
  if (pin <= 0) return [scrolled(0, scroll)]
  const split = Math.min(extent, pin * zoom)
  return [{ pinned: true, off: 0, s0: 0, s1: split, d0: 0, d1: split / zoom }, scrolled(split, pin + scroll)].filter((span) => span.s1 > span.s0 && span.d1 > span.d0)
}

/**
 * The panes of a `width` × `height` canvas at `view`: one, or with pinned bands up to four (the
 * pinned corner, the pinned top and left bands, and the scrolled rest), as a spreadsheet's frozen
 * panes are.
 */
export function viewPanes(view: RasterView, pins: RasterPins, width: number, height: number): RasterPane[] {
  const panes: RasterPane[] = []
  for (const row of spans(pins.top, view.y, height, view.zoom)) {
    for (const column of spans(pins.left, view.x, width, view.zoom)) {
      panes.push({
        pinX: column.pinned,
        pinY: row.pinned,
        offX: column.off,
        offY: row.off,
        clip: { x0: column.s0, y0: row.s0, x1: column.s1, y1: row.s1 },
        area: { x0: column.d0, y0: row.d0, x1: column.d1, y1: row.d1 },
      })
    }
  }
  return panes
}

/**
 * The cached render of one pane: `bitmap` shows the image area at (`x`, `y`), `width` × `height`
 * image pixels, at `scale`. Below 1:1 the scale is 1/k, so each bitmap pixel is exactly a k × k block.
 */
type Frame = { bitmap: HTMLCanvasElement; x: number; y: number; width: number; height: number; scale: number; pinX: boolean; pinY: boolean }

/** An image area in image pixels. */
export type RasterRect = { x0: number; y0: number; x1: number; y1: number }

/** Whether `area` holds no pixel (x1 ≤ x0 or y1 ≤ y0), as the empty area `{0, 0, 0, 0}` does. */
export const isEmptyArea = (area: RasterRect): boolean => area.x1 <= area.x0 || area.y1 <= area.y0

/**
 * Two repaints taken together: the whole canvas (`null`) wins over anything, the empty area adds
 * nothing, and two areas give the rectangle covering both.
 */
export function mergeDamage(a: RasterRect | null, b: RasterRect | null): RasterRect | null {
  if (a === null || b === null) return null
  if (isEmptyArea(b)) return a
  if (isEmptyArea(a)) return b
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

export type RasterViewportStats = { renderMs: number; frameWidth: number; frameHeight: number }

function imageData(rgba: Uint8Array, width: number, height: number) {
  return new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

function checkerPattern(context: CanvasRenderingContext2D) {
  const tile = document.createElement('canvas')
  tile.width = CHECKER * 2
  tile.height = CHECKER * 2
  const tileContext = tile.getContext('2d')
  if (!tileContext) return null
  tileContext.fillStyle = '#ffffff'
  tileContext.fillRect(0, 0, CHECKER * 2, CHECKER * 2)
  tileContext.fillStyle = '#e8e8ec'
  tileContext.fillRect(0, 0, CHECKER, CHECKER)
  tileContext.fillRect(CHECKER, CHECKER, CHECKER, CHECKER)
  return context.createPattern(tile, 'repeat')
}

/**
 * Paints a kit document into a `<canvas>`. The engine renders the visible part of the image, and
 * a margin around it, at the current zoom into a cached frame; panning and zooming redraw that
 * frame at once, and a fresh render follows the next animation frame (one at a time, the last view
 * again after it), so a view that keeps moving keeps being painted.
 */
/** Draws on top of the document in canvas CSS pixels; `toScreen` maps document points there. */
export type RasterDecoration = (context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, view: RasterView) => void

export class RasterViewport {
  view: RasterView = { zoom: 1, x: 0, y: 0 }
  /** Drawn after the document on every frame, for example marching ants. */
  decorate: RasterDecoration | null = null
  private frames: Frame[] = []
  /**
   * The view still on screen while a scroll waits for its render: a pan past the painted frame
   * keeps showing the frame where it was, never blank canvas, until the new view is painted.
   */
  private held: RasterView | null = null
  private pattern: CanvasPattern | null = null
  /** The render asked for the next animation frame, and how to call it off. */
  private settle: (() => void) | undefined
  /** Moves with every view change: a failure of a render for an older view is not reported. */
  private moves = 0
  private rendering = false
  private renderAgain = false
  /** Areas edits changed while a render was in flight, patched once it lands. */
  private pendingDamage: RasterRect | null = null
  private disposed = false
  private generation = 0
  private failed = false
  /** The area the view was last fitted to; cleared when the view moves otherwise. */
  private fitted: RasterRect | null = null
  /** The canvas size the view was laid out for. */
  private laidOut: { width: number; height: number } | null = null
  private panBounds: RasterRect | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly doc: RasterSource,
    private backdrop: string,
    private readonly onChange: (view: RasterView, stats: RasterViewportStats | null) => void,
    /** A page shadow and transparency checks under the document; off for engines that paint their own canvas. */
    private readonly framed = true,
    /** A current render failed, or null after its pixels were replaced successfully. */
    private readonly onRender: (error: unknown | null) => void = () => undefined,
  ) {}

  /**
   * In-flight pixels and failures from before an edit must not replace the new state. A render
   * in flight is dropped, so it runs again once it ends: the edit's own repaint may be a patch,
   * or none at all (a settled click that changed nothing more), which would leave the dropped
   * frame's older pixels on screen.
   */
  invalidate() {
    // A whole render follows: it covers the areas waiting for a patch.
    this.pendingDamage = null
    this.drop()
    if (this.rendering) this.renderAgain = true
  }

  /** Drops what is in flight (the view moved: its own settled render follows). */
  private drop() {
    this.generation += 1
  }

  dispose() {
    this.settle?.()
    this.settle = undefined
    this.disposed = true
    this.frames = []
  }

  private get size() {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight, dpr: window.devicePixelRatio || 1 }
  }

  private get pins(): RasterPins {
    const pins = this.doc.pinned
    return { left: Math.max(0, pins?.left ?? 0), top: Math.max(0, pins?.top ?? 0) }
  }

  /** Canvas CSS pixel position of a document point. */
  toScreen(x: number, y: number) {
    const { left, top } = this.pins
    const shown = this.shown
    const { zoom } = shown
    return { x: (x < left ? x : x - shown.x) * zoom, y: (y < top ? y : y - shown.y) * zoom }
  }

  /** Image coordinates of a point in the canvas's CSS pixels. */
  toImage(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect()
    const { left, top } = this.pins
    const shown = this.shown
    const sx = (clientX - rect.left) / shown.zoom
    const sy = (clientY - rect.top) / shown.zoom
    return { x: sx < left ? sx : shown.x + sx, y: sy < top ? sy : shown.y + sy }
  }

  fit() {
    this.fitArea({ x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height })
  }

  /** Fits `area` (document pixels) in the canvas, centred: a page or spread brought into view. */
  fitArea(area: RasterRect) {
    const { width, height } = this.size
    const w = area.x1 - area.x0
    const h = area.y1 - area.y0
    if (!width || !height || w <= 0 || h <= 0) return
    const zoom = clampZoom(Math.min((width - FIT_MARGIN * 2) / w, (height - FIT_MARGIN * 2) / h))
    this.setView({ zoom, x: area.x0 + w / 2 - width / 2 / zoom, y: area.y0 + h / 2 - height / 2 / zoom }, { ...area })
  }

  /**
   * Lays the view out again after the canvas changed size (a window maximized, a panel closed):
   * a fitted view fits its area again; otherwise the document point at the centre stays there, or,
   * with pinned bands, the top-left stays put as a spreadsheet's does.
   */
  resized() {
    const { width, height } = this.size
    const before = this.laidOut
    if (!width || !height) return
    this.laidOut = { width, height }
    if (!before || (before.width === width && before.height === height)) return
    if (this.fitted) {
      this.fitArea(this.fitted)
      return
    }
    const { left, top } = this.pins
    if (left > 0 || top > 0) return
    const { zoom } = this.view
    // The middle stays where it was, but a view at the start of the pages stays at their start,
    // as a scrolled page does when its window gets shorter or narrower.
    const bounds = this.panBounds
    const atStart = (position: number, start: number | undefined) => start !== undefined && Math.abs(position - start) < 1e-6
    this.setView({
      zoom,
      x: atStart(this.view.x, bounds?.x0) ? this.view.x : this.view.x + (before.width - width) / 2 / zoom,
      y: atStart(this.view.y, bounds?.y0) ? this.view.y : this.view.y + (before.height - height) / 2 / zoom,
    })
  }

  /** Zooms to `zoom`, keeping the image point under (`clientX`, `clientY`) still; the centre by default. */
  zoomTo(zoom: number, clientX?: number, clientY?: number) {
    const rect = this.canvas.getBoundingClientRect()
    const anchorX = clientX ?? rect.left + rect.width / 2
    const anchorY = clientY ?? rect.top + rect.height / 2
    const point = this.toImage(anchorX, anchorY)
    const next = clampZoom(zoom)
    const { left, top } = this.pins
    // A point in a pinned band keeps the scroll along that axis; the band itself does not move.
    this.setView({
      zoom: next,
      x: point.x < left ? this.view.x : point.x - (anchorX - rect.left) / next,
      y: point.y < top ? this.view.y : point.y - (anchorY - rect.top) / next,
    })
  }

  /** Puts document point (`x`, `y`) at the view's top-left, keeping the zoom. */
  panTo(x: number, y: number) {
    this.setView({ ...this.view, x, y })
  }

  panBy(dx: number, dy: number) {
    this.setView({ ...this.view, x: this.view.x - dx / this.view.zoom, y: this.view.y - dy / this.view.zoom })
  }

  /** Limits panning to a document's pages; a smaller document stays centred in the canvas. */
  setPanBounds(bounds: RasterRect | null) {
    const before = this.panBounds
    if (before === bounds || (before && bounds && before.x0 === bounds.x0 && before.y0 === bounds.y0 && before.x1 === bounds.x1 && before.y1 === bounds.y1)) return
    this.panBounds = bounds ? { ...bounds } : null
    this.setView(this.view, this.fitted)
  }

  private setView(view: RasterView, fitted: RasterRect | null = null) {
    // A render in flight stays: its frame knows the area it shows, so it is drawn where it belongs.
    this.moves += 1
    this.fitted = fitted
    // Nothing scrolls out from under a pinned band.
    const { left, top } = this.pins
    const before = this.shown
    const bounds = this.panBounds
    const { width, height } = this.size
    if (bounds && width > 0 && height > 0) {
      const limit = (position: number, low: number, high: number, extent: number) =>
        extent >= high - low ? (low + high - extent) / 2 : Math.max(low, Math.min(high - extent, position))
      view = { ...view, x: limit(view.x, bounds.x0, bounds.x1, width / view.zoom), y: limit(view.y, bounds.y0, bounds.y1, height / view.zoom) }
    }
    this.view = { zoom: view.zoom, x: left > 0 ? Math.max(0, view.x) : view.x, y: top > 0 ? Math.max(0, view.y) : view.y }
    view = this.view
    this.schedule()
    // A scroll (the zoom kept) past the painted frame waits for its render; a zoom shows at once.
    if (view.zoom === before.zoom && this.frames.length && !this.covers(view)) {
      this.held = before
      return
    }
    this.held = null
    this.draw()
    this.onChange(view, null)
  }

  /** The view on screen: the held one while a scroll waits for its render (see `held`). */
  get shown(): RasterView {
    return this.held ?? this.view
  }

  /** Shows the view asked for, painted or not (a render that ended without pixels for it). */
  private release() {
    if (!this.held || this.disposed) return
    this.held = null
    this.draw()
    this.onChange(this.view, null)
  }

  /** Whether the frames hold every document pixel `view` shows. */
  private covers(view: RasterView) {
    const { width, height } = this.size
    if (!width || !height) return true
    return viewPanes(view, this.pins, width, height).every((pane) => {
      const x0 = Math.max(0, pane.area.x0)
      const y0 = Math.max(0, pane.area.y0)
      const x1 = Math.min(this.doc.width, pane.area.x1)
      const y1 = Math.min(this.doc.height, pane.area.y1)
      if (x1 <= x0 || y1 <= y0) return true
      const frame = this.frames.find((item) => item.pinX === pane.pinX && item.pinY === pane.pinY)
      return !!frame && frame.x <= x0 + 0.5 && frame.y <= y0 + 0.5 && frame.x + frame.width >= x1 - 0.5 && frame.y + frame.height >= y1 - 0.5
    })
  }

  /** Renders the view the next animation frame (a render in flight renders again after it). */
  private schedule() {
    if (this.settle !== undefined || this.disposed) return
    const run = () => {
      this.settle = undefined
      void this.render()
    }
    // Each kind of id is called off by its own call: a frame id given to clearTimeout could stop
    // someone else's timer with the same number.
    if (window.requestAnimationFrame) {
      const frame = window.requestAnimationFrame(run)
      this.settle = () => window.cancelAnimationFrame(frame)
    } else {
      const timer = window.setTimeout(run, 16)
      this.settle = () => window.clearTimeout(timer)
    }
  }

  /**
   * Renders the visible part of the image in the engine, then shows it; call after the
   * document changes. One render runs at a time; a request meanwhile renders again after it.
   */
  async render(): Promise<boolean> {
    this.settle?.()
    this.settle = undefined
    if (this.disposed) return false
    if (this.rendering) {
      this.renderAgain = true
      return false
    }
    this.rendering = true
    const generation = this.generation
    const moves = this.moves
    let painted = false
    try {
      painted = await this.renderNow(generation)
      if (painted) {
        this.failed = false
        this.onRender(null)
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation && moves === this.moves) {
        this.failed = true
        this.onRender(error)
      }
    } finally {
      this.rendering = false
    }
    // The view moved while it rendered: render where it is now.
    if (moves !== this.moves) this.renderAgain = true
    // Nothing painted, and nothing more to come: the view asked for shows, as it is.
    if (!painted && !this.renderAgain) this.release()
    if (this.renderAgain && !this.disposed) {
      this.renderAgain = false
      return this.render()
    }
    // Areas edits changed while it rendered (see `patch`): its other pixels are right.
    const pending = this.pendingDamage
    this.pendingDamage = null
    if (pending && !this.disposed) await this.renderArea(pending)
    return painted
  }

  /**
   * Repaints `area` after an edit that changed only it (a caret moved): now, or once the render
   * in flight lands. That render is kept, since everything outside `area` in it is still right;
   * dropping it, as `invalidate` does, would render the whole view again for every caret move.
   */
  async patch(area: RasterRect): Promise<boolean> {
    if (this.disposed) return false
    if (this.rendering) {
      // The empty area adds nothing (it does not stretch the area waiting toward 0, 0).
      if (!isEmptyArea(area)) this.pendingDamage = this.pendingDamage ? mergeDamage(this.pendingDamage, area) : area
      return false
    }
    return this.renderArea(area)
  }

  private async renderNow(generation: number): Promise<boolean> {
    const { width, height, dpr } = this.size
    if (!width || !height) return false
    const started = performance.now()
    const rendered = this.view
    const frames: Frame[] = []
    let frameWidth = 0
    let frameHeight = 0
    for (const pane of viewPanes(rendered, this.pins, width, height)) {
      const frame = await this.renderPane(pane, dpr)
      if (!frame) continue
      frames.push(frame)
      frameWidth = Math.max(frameWidth, frame.bitmap.width)
      frameHeight += frame.bitmap.height
    }
    if (this.disposed || generation !== this.generation) return false
    this.frames = frames
    // The view asked for shows when the frame covers it; else, while the view moved on, the view
    // this frame was rendered for (never blank canvas), until the next render lands.
    this.held = rendered.zoom === this.view.zoom && !this.covers(this.view) ? rendered : null
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    if (frames.length) this.onChange(this.shown, { renderMs, frameWidth, frameHeight })
    return true
  }

  /** Renders the document area a pane shows, at the zoom; null when it shows none of it. */
  private async renderPane(pane: RasterPane, dpr: number): Promise<Frame | null> {
    const wanted = this.view.zoom * dpr
    // The view's area and a margin past it along each scrolled axis (see AHEAD), within the document.
    const reach = (ahead: number) => {
      const ax = pane.pinX ? 0 : (pane.area.x1 - pane.area.x0) * ahead
      const ay = pane.pinY ? 0 : (pane.area.y1 - pane.area.y0) * ahead
      return {
        x0: Math.max(0, Math.floor(pane.area.x0 - ax)),
        y0: Math.max(0, Math.floor(pane.area.y0 - ay)),
        x1: Math.min(this.doc.width, Math.ceil(pane.area.x1 + ax)),
        y1: Math.min(this.doc.height, Math.ceil(pane.area.y1 + ay)),
      }
    }
    const fits = (rect: RasterRect) => (rect.x1 - rect.x0) * (rect.y1 - rect.y0) * Math.min(1, wanted) ** 2 * Math.max(1, wanted) ** 2 <= MAX_FRAME_PIXELS
    const { x0, y0, x1, y1 } = AHEAD.map(reach).find((rect) => fits(rect)) ?? reach(0)
    if (x1 <= x0 || y1 <= y0) return null
    let area: Omit<Frame, 'bitmap' | 'pinX' | 'pinY'>
    let rgba: Uint8Array
    let frameWidth: number
    let frameHeight: number
    if (wanted < 1) {
      // A whole-number reduction at least as sharp as the screen, so patches line up exactly.
      let k = Math.max(1, Math.floor(1 / wanted))
      while (((x1 - x0) / k) * ((y1 - y0) / k) > MAX_FRAME_PIXELS) k += 1
      frameWidth = Math.ceil((x1 - x0) / k)
      frameHeight = Math.ceil((y1 - y0) / k)
      rgba = await this.doc.renderArea(x0, y0, x0 + frameWidth * k, y0 + frameHeight * k, frameWidth, frameHeight)
      area = { x: x0, y: y0, width: frameWidth * k, height: frameHeight * k, scale: 1 / k }
    } else {
      let scale = wanted
      const pixels = (x1 - x0) * (y1 - y0) * scale * scale
      const view = reach(0)
      const limit = Math.max(MAX_FRAME_PIXELS, Math.min(MAX_VIEW_PIXELS, (view.x1 - view.x0) * (view.y1 - view.y0) * wanted * wanted))
      if (pixels > limit) scale = Math.max(1, scale * Math.sqrt(limit / pixels))
      scale = Math.max(1, Math.min(scale, MAX_RENDER_SIDE / (x1 - x0), MAX_RENDER_SIDE / (y1 - y0)))
      frameWidth = Math.max(1, Math.ceil((x1 - x0) * scale))
      frameHeight = Math.max(1, Math.ceil((y1 - y0) * scale))
      rgba = await this.doc.render(x0, y0, scale, frameWidth, frameHeight)
      area = { x: x0, y: y0, width: frameWidth / scale, height: frameHeight / scale, scale }
    }
    const bitmap = document.createElement('canvas')
    bitmap.width = frameWidth
    bitmap.height = frameHeight
    bitmap.getContext('2d')?.putImageData(imageData(rgba, frameWidth, frameHeight), 0, 0)
    return { bitmap, ...area, pinX: pane.pinX, pinY: pane.pinY }
  }

  /**
   * Re-renders only `area` (what a stroke or a caret touched) into the cached frames, each pane's
   * at its own scale, then redraws. When the frames changed meanwhile, renders them all again.
   */
  async renderArea(area: RasterRect): Promise<boolean> {
    if (this.disposed) return false
    const frames = this.frames
    if (!frames.length || this.rendering || this.failed) {
      return this.render()
    }
    // Each pane the area reaches (pinned bands included), in its bitmap's pixels.
    const patches = frames.flatMap((frame) => {
      const sx = frame.bitmap.width / frame.width
      const sy = frame.bitmap.height / frame.height
      const px0 = clamp(Math.floor((area.x0 - frame.x) * sx), 0, frame.bitmap.width)
      const py0 = clamp(Math.floor((area.y0 - frame.y) * sy), 0, frame.bitmap.height)
      const px1 = clamp(Math.ceil((area.x1 - frame.x) * sx), 0, frame.bitmap.width)
      const py1 = clamp(Math.ceil((area.y1 - frame.y) * sy), 0, frame.bitmap.height)
      return px1 > px0 && py1 > py0 ? [{ frame, sx, sy, px0, py0, width: px1 - px0, height: py1 - py0 }] : []
    })
    if (!patches.length) return false
    const started = performance.now()
    const generation = this.generation
    const pixels: Uint8Array[] = []
    try {
      for (const { frame, sx, sy, px0, py0, width, height } of patches) {
        const k = Math.round(1 / frame.scale)
        pixels.push(frame.scale < 1
          ? await this.doc.renderArea(frame.x + px0 * k, frame.y + py0 * k, frame.x + (px0 + width) * k, frame.y + (py0 + height) * k, width, height)
          : await this.doc.render(frame.x + px0 / sx, frame.y + py0 / sy, frame.scale, width, height))
      }
    } catch (error) {
      if (!this.disposed && generation === this.generation && this.frames === frames) {
        this.failed = true
        this.onRender(error)
      }
      return false
    }
    if (this.disposed || generation !== this.generation) return false
    if (this.frames !== frames) {
      return this.render()
    }
    patches.forEach(({ frame, px0, py0, width, height }, i) => frame.bitmap.getContext('2d')?.putImageData(imageData(pixels[i], width, height), px0, py0))
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    const biggest = patches.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    this.onChange(this.shown, { renderMs, frameWidth: biggest.width, frameHeight: biggest.height })
    this.onRender(null)
    return true
  }

  /** Paints `color` behind the document from now on (the theme changed), redrawing at once. */
  setBackdrop(color: string) {
    if (color === this.backdrop || this.disposed) return
    this.backdrop = color
    this.draw()
  }

  /** Redraws the cached frame at the current view. */
  draw() {
    const { width, height, dpr } = this.size
    const backingWidth = Math.round(width * dpr)
    const backingHeight = Math.round(height * dpr)
    if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
      this.canvas.width = backingWidth
      this.canvas.height = backingHeight
    }
    const context = this.canvas.getContext('2d')
    if (!context) return
    const shown = this.shown
    const { zoom } = shown
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = this.backdrop
    context.fillRect(0, 0, width, height)
    const panes = viewPanes(shown, this.pins, width, height)
    for (const pane of panes) {
      context.save()
      if (panes.length > 1) {
        context.beginPath()
        context.rect(pane.clip.x0, pane.clip.y0, pane.clip.x1 - pane.clip.x0, pane.clip.y1 - pane.clip.y0)
        context.clip()
      }
      const toPane = (px: number, py: number) => ({ x: (px - pane.offX) * zoom, y: (py - pane.offY) * zoom })
      const origin = toPane(0, 0)
      if (this.framed) {
        context.shadowColor = 'rgba(15, 15, 30, 0.12)'
        context.shadowBlur = 12
        this.pattern ??= checkerPattern(context)
        context.fillStyle = this.pattern ?? '#ffffff'
        context.fillRect(origin.x, origin.y, this.doc.width * zoom, this.doc.height * zoom)
        context.shadowBlur = 0
      }
      const frame = this.frames.find((item) => item.pinX === pane.pinX && item.pinY === pane.pinY)
      if (frame) {
        context.imageSmoothingEnabled = zoom < 1
        context.imageSmoothingQuality = 'high'
        const at = toPane(frame.x, frame.y)
        context.drawImage(frame.bitmap, at.x, at.y, frame.width * zoom, frame.height * zoom)
      }
      // Decorations in every pane, each clipped to it, so a selection across the split shows in both.
      if (this.decorate) {
        context.save()
        this.decorate(context, toPane, { zoom, x: pane.offX, y: pane.offY })
        context.restore()
      }
      context.restore()
    }
  }

  /** The colour of the image pixel under a canvas point, from the cached frame. */
  sample(clientX: number, clientY: number): [number, number, number] | null {
    const point = this.toImage(clientX, clientY)
    const { left, top } = this.pins
    const frame = this.frames.find((item) => item.pinX === point.x < left && item.pinY === point.y < top)
    if (!frame) return null
    const fx = Math.floor(((point.x - frame.x) / frame.width) * frame.bitmap.width)
    const fy = Math.floor(((point.y - frame.y) / frame.height) * frame.bitmap.height)
    if (fx < 0 || fy < 0 || fx >= frame.bitmap.width || fy >= frame.bitmap.height) return null
    const data = frame.bitmap.getContext('2d')?.getImageData(fx, fy, 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  }
}
