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
/**
 * A render while a frame is on screen (an edit, a zoom, a resize) paints the view alone, so the
 * person sees it in the time the view takes; the margin past it (AHEAD) follows once the canvas
 * has been still this long, a slice at a time, each slice at most GROW_SHARE of the view.
 */
const GROW_AFTER_MS = 120
const GROW_STEP_MS = 16
const GROW_SHARE = 0.25
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
 * A frame starts on a whole bitmap pixel of the document's own grid at its scale (`Grid`), so two
 * frames at one scale line up pixel for pixel. `edits` is the document state it shows (see
 * `RasterViewport.edits`).
 */
type Frame = { bitmap: HTMLCanvasElement; x: number; y: number; width: number; height: number; scale: number; pinX: boolean; pinY: boolean; edits: number }

/** An area in whole bitmap pixels of the grid at a frame's scale, from the document's origin. */
type Grid = { x0: number; y0: number; x1: number; y1: number }

/**
 * How a pane is rendered at the view: `k` for a whole-number reduction (`renderArea`, k × k blocks)
 * or the scale (`render`), the view's own area and the view with its margin (`target`), on the grid.
 */
type PanePlan = { k: number | null; scale: number; view: Grid; target: Grid }

const gridEmpty = (g: Grid) => g.x1 <= g.x0 || g.y1 <= g.y0
const gridSame = (a: Grid, b: Grid) => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
const gridContains = (outer: Grid, inner: Grid) => outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1
const gridMeet = (a: Grid, b: Grid): Grid => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) })
const gridJoin = (a: Grid, b: Grid): Grid => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })

/** `outer` less `inner` (which lies within it), as up to four rectangles: above, below, left, right. */
function gridLess(outer: Grid, inner: Grid): Grid[] {
  if (gridEmpty(inner)) return [outer]
  return [
    { x0: outer.x0, y0: outer.y0, x1: outer.x1, y1: inner.y0 },
    { x0: outer.x0, y0: inner.y1, x1: outer.x1, y1: outer.y1 },
    { x0: outer.x0, y0: inner.y0, x1: inner.x0, y1: inner.y1 },
    { x0: inner.x1, y0: inner.y0, x1: outer.x1, y1: inner.y1 },
  ].filter((part) => !gridEmpty(part))
}

/**
 * The next slice of the margin a frame at `held` (within `target`) still lacks: its left, right,
 * top and bottom in turn, at most `most` bitmap pixels; null when it has all of `target`.
 */
function growSlice(held: Grid, target: Grid, most: number): Grid | null {
  const rows = Math.max(1, held.y1 - held.y0)
  const columns = Math.max(1, held.x1 - held.x0)
  const across = Math.max(1, Math.floor(most / rows))
  const down = Math.max(1, Math.floor(most / columns))
  if (held.x0 > target.x0) return { ...held, x0: Math.max(target.x0, held.x0 - across) }
  if (held.x1 < target.x1) return { ...held, x1: Math.min(target.x1, held.x1 + across) }
  if (held.y0 > target.y0) return { ...held, y0: Math.max(target.y0, held.y0 - down) }
  if (held.y1 < target.y1) return { ...held, y1: Math.min(target.y1, held.y1 + down) }
  return null
}

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
   * The view still on screen while a scroll waits for its render: a jump past every painted pixel
   * (a scroll bar dragged far) keeps showing the frame where it was, never blank canvas, until the
   * new view is painted. A pan the frame still reaches into shows at once, the part it uncovers
   * blank until its render lands.
   */
  private held: RasterView | null = null
  /**
   * Moves with every edit and every render asked for from outside (the document may have changed):
   * only a frame made at the current count is the document as it is, and can be moved or grown
   * by rendering just what it lacks.
   */
  private edits = 0
  /** The next render grows the margin past the view (see GROW_AFTER_MS), not just the view. */
  private growNext = false
  /**
   * When the margin grows (`Date.now()`), or null; one timer at a time waits for it, and
   * waits again when it moved later (timers are never called off: see `schedule`).
   */
  private growAt: number | null = null
  private growWaiting = false
  /** Patches (`renderArea`) on their way. */
  private patching = 0
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
    this.edits += 1
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
    this.growAt = null
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

  /**
   * The view on screen as it is drawn: its top-left moved by less than half a device pixel onto a
   * whole one at its scale, so a frame rendered at the screen's own pixels (on its grid, see
   * `Frame`) is copied pixel for pixel, never across half pixels (which drops or doubles rows and
   * columns of thin lines). The document, the decorations and pointer positions all use it.
   */
  private get placed(): RasterView {
    const shown = this.shown
    const device = shown.zoom * (window.devicePixelRatio || 1)
    // A view already on a whole device pixel stays exactly as it is (no rounding error added).
    const snap = (value: number) => {
      const whole = Math.round(value * device)
      return Math.abs(value * device - whole) < 1e-6 ? value : whole / device
    }
    return { zoom: shown.zoom, x: snap(shown.x), y: snap(shown.y) }
  }

  /** Canvas CSS pixel position of a document point. */
  toScreen(x: number, y: number) {
    const { left, top } = this.pins
    const shown = this.placed
    const { zoom } = shown
    return { x: (x < left ? x : x - shown.x) * zoom, y: (y < top ? y : y - shown.y) * zoom }
  }

  /** Image coordinates of a point in the canvas's CSS pixels. */
  toImage(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect()
    const { left, top } = this.pins
    const shown = this.placed
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
    this.growLater()
    // A scroll (the zoom kept) past every painted pixel waits for its render; a scroll the frame
    // still reaches into, and a zoom, show at once.
    if (view.zoom === before.zoom && this.frames.length && !this.reaches(view)) {
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

  /** Whether the frames show some of what every pane of `view` shows of the document. */
  private reaches(view: RasterView) {
    const { width, height } = this.size
    if (!width || !height) return true
    return viewPanes(view, this.pins, width, height).every((pane) => {
      const x0 = Math.max(0, pane.area.x0)
      const y0 = Math.max(0, pane.area.y0)
      const x1 = Math.min(this.doc.width, pane.area.x1)
      const y1 = Math.min(this.doc.height, pane.area.y1)
      if (x1 <= x0 || y1 <= y0) return true
      const frame = this.frames.find((item) => item.pinX === pane.pinX && item.pinY === pane.pinY)
      return !!frame && frame.x < x1 && frame.y < y1 && frame.x + frame.width > x0 && frame.y + frame.height > y0
    })
  }

  /** Renders the view the next animation frame (a render in flight renders again after it). */
  private schedule() {
    if (this.settle !== undefined || this.disposed) return
    const run = () => {
      this.settle = undefined
      void this.paint()
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
    // The document may have changed: no frame on screen is kept or grown, every pane renders again.
    this.edits += 1
    return this.paint()
  }

  /** Renders what the view lacks now: the whole view after `render`, else what a move uncovered. */
  private async paint(): Promise<boolean> {
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
      return this.paint()
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

  /**
   * Renders each pane. A frame of the document as it is, at the same scale, is kept where it
   * still shows the whole view, and otherwise moved, with only the part it lacks rendered: a pan
   * renders the strip it uncovers. Other frames on screen (an edit, a zoom) are replaced by the
   * view alone first, its margin growing once the canvas is still; with none, the view and its
   * margin render at once.
   */
  private async renderNow(generation: number): Promise<boolean> {
    const { width, height, dpr } = this.size
    if (!width || !height) return false
    const grow = this.growNext
    this.growNext = false
    const started = performance.now()
    const rendered = this.view
    const edits = this.edits
    const onScreen = this.frames.length > 0
    const frames: Frame[] = []
    let frameWidth = 0
    let frameHeight = 0
    let drew = false
    for (const pane of viewPanes(rendered, this.pins, width, height)) {
      const plan = this.plan(pane, dpr)
      if (!plan) continue
      const previous = this.frames.find((item) => item.pinX === pane.pinX && item.pinY === pane.pinY)
      const held = previous && !this.failed && previous.edits === edits ? this.gridOf(previous, plan) : null
      let frame: Frame | null
      if (previous && held && (grow || gridContains(held, plan.view))) {
        // Grows by the next slice of the margin, or crops to it; kept as it is when it has it all.
        const base = gridMeet(held, plan.target)
        const next = grow ? (gridEmpty(base) ? plan.target : growSlice(base, plan.target, this.growLimit(plan)) ?? base) : held
        frame = gridSame(next, held) ? previous : await this.compose(previous, held, next, plan, pane, edits)
      } else if (previous && held && !gridEmpty(gridMeet(held, plan.view))) {
        frame = await this.compose(previous, held, gridJoin(plan.view, gridMeet(held, plan.target)), plan, pane, edits)
      } else if (grow) {
        // Nothing of the document as it is to grow: the render asked for does it.
        frame = previous ?? null
      } else {
        frame = await this.compose(null, null, onScreen ? plan.view : plan.target, plan, pane, edits)
      }
      if (!frame) continue
      if (frame !== previous) drew = true
      frames.push(frame)
      frameWidth = Math.max(frameWidth, frame.bitmap.width)
      frameHeight += frame.bitmap.height
    }
    if (this.disposed || generation !== this.generation) return false
    if (!drew && frames.length === this.frames.length) {
      this.growLater()
      return true
    }
    this.frames = frames
    // The view asked for shows when the frame reaches it; else, while the view jumped on, the view
    // this frame was rendered for (never blank canvas), until the next render lands.
    this.held = rendered.zoom === this.view.zoom && !this.reaches(this.view) ? rendered : null
    const renderMs = Math.round(performance.now() - started)
    this.draw()
    if (frames.length) this.onChange(this.shown, { renderMs, frameWidth, frameHeight })
    this.growLater(grow ? GROW_STEP_MS : GROW_AFTER_MS)
    return true
  }

  /** How a pane renders at the view (see `PanePlan`); null when it shows none of the document. */
  private plan(pane: RasterPane, dpr: number): PanePlan | null {
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
    const target = AHEAD.map(reach).find((rect) => fits(rect)) ?? reach(0)
    const view = reach(0)
    if (target.x1 <= target.x0 || target.y1 <= target.y0) return null
    let k: number | null = null
    let scale: number
    if (wanted < 1) {
      // A whole-number reduction at least as sharp as the screen, so patches line up exactly.
      k = Math.max(1, Math.floor(1 / wanted))
      while (((target.x1 - target.x0) / k) * ((target.y1 - target.y0) / k) > MAX_FRAME_PIXELS) k += 1
      scale = 1 / k
    } else {
      scale = wanted
      const pixels = (target.x1 - target.x0) * (target.y1 - target.y0) * scale * scale
      const limit = Math.max(MAX_FRAME_PIXELS, Math.min(MAX_VIEW_PIXELS, (view.x1 - view.x0) * (view.y1 - view.y0) * wanted * wanted))
      if (pixels > limit) scale = Math.max(1, scale * Math.sqrt(limit / pixels))
      scale = Math.max(1, Math.min(scale, MAX_RENDER_SIDE / (target.x1 - target.x0), MAX_RENDER_SIDE / (target.y1 - target.y0)))
    }
    const at = (value: number) => (k ? value / k : value * scale)
    const grid = (rect: RasterRect): Grid => {
      const g = { x0: Math.floor(at(rect.x0)), y0: Math.floor(at(rect.y0)), x1: Math.ceil(at(rect.x1)), y1: Math.ceil(at(rect.y1)) }
      return { ...g, x1: Math.max(g.x1, g.x0 + 1), y1: Math.max(g.y1, g.y0 + 1) }
    }
    return { k, scale, view: grid(view), target: grid(target) }
  }

  /** Where `frame` lies on `plan`'s grid; null when it was rendered at another scale. */
  private gridOf(frame: Frame, plan: PanePlan): Grid | null {
    const k = plan.k
    if (Math.abs(frame.scale - plan.scale) > 1e-9 * plan.scale) return null
    const x0 = Math.round(k ? frame.x / k : frame.x * plan.scale)
    const y0 = Math.round(k ? frame.y / k : frame.y * plan.scale)
    return { x0, y0, x1: x0 + frame.bitmap.width, y1: y0 + frame.bitmap.height }
  }

  /** The most bitmap pixels one slice of a growing margin renders: a share of the view. */
  private growLimit(plan: PanePlan) {
    return Math.max(1, Math.floor((plan.view.x1 - plan.view.x0) * (plan.view.y1 - plan.view.y0) * GROW_SHARE))
  }

  /** Renders `grid` of the document (bitmap pixels on `plan`'s grid) through the engine. */
  private renderGrid(plan: PanePlan, grid: Grid): Promise<Uint8Array> {
    const width = grid.x1 - grid.x0
    const height = grid.y1 - grid.y0
    const k = plan.k
    return k
      ? this.doc.renderArea(grid.x0 * k, grid.y0 * k, grid.x1 * k, grid.y1 * k, width, height)
      : this.doc.render(grid.x0 / plan.scale, grid.y0 / plan.scale, plan.scale, width, height)
  }

  /**
   * A frame of `next` (on `plan`'s grid): what `previous` (at `held`) has of it is copied, and
   * only the rest is rendered; everything is rendered without one.
   */
  private async compose(previous: Frame | null, held: Grid | null, next: Grid, plan: PanePlan, pane: RasterPane, edits: number): Promise<Frame> {
    const width = next.x1 - next.x0
    const height = next.y1 - next.y0
    const kept = previous && held ? gridMeet(held, next) : null
    const parts = kept ? gridLess(next, kept) : [next]
    const pixels: Uint8Array[] = []
    for (const part of parts) pixels.push(await this.renderGrid(plan, part))
    const bitmap = document.createElement('canvas')
    bitmap.width = width
    bitmap.height = height
    const context = bitmap.getContext('2d')
    if (previous && held && kept && !gridEmpty(kept)) {
      const w = kept.x1 - kept.x0
      const h = kept.y1 - kept.y0
      context?.drawImage(previous.bitmap, kept.x0 - held.x0, kept.y0 - held.y0, w, h, kept.x0 - next.x0, kept.y0 - next.y0, w, h)
    }
    parts.forEach((part, i) => context?.putImageData(imageData(pixels[i], part.x1 - part.x0, part.y1 - part.y0), part.x0 - next.x0, part.y0 - next.y0))
    const k = plan.k
    const from = (value: number) => (k ? value * k : value / plan.scale)
    return { bitmap, x: from(next.x0), y: from(next.y0), width: from(width), height: from(height), scale: plan.scale, pinX: pane.pinX, pinY: pane.pinY, edits }
  }

  /**
   * Grows the margin past the view once the canvas has been still `after` milliseconds: called
   * whenever the view moves or a render lands, it starts the wait again. Nothing when every pane's
   * frame has its whole margin, or is not the document as it is (its render is on its way).
   */
  private growLater(after = GROW_AFTER_MS) {
    this.growAt = null
    if (this.disposed || !this.frames.length) return
    const { width, height, dpr } = this.size
    if (!width || !height) return
    const short = viewPanes(this.view, this.pins, width, height).some((pane) => {
      const plan = this.plan(pane, dpr)
      const frame = plan && this.frames.find((item) => item.pinX === pane.pinX && item.pinY === pane.pinY)
      const held = plan && frame && frame.edits === this.edits ? this.gridOf(frame, plan) : null
      return !!plan && !!held && !gridSame(held, plan.target)
    })
    if (!short) return
    this.growAt = Date.now() + after
    if (!this.growWaiting) this.waitToGrow(after)
  }

  private waitToGrow(delay: number) {
    this.growWaiting = true
    setTimeout(() => {
      this.growWaiting = false
      if (this.disposed || this.growAt === null) return
      const left = this.growAt - Date.now()
      if (left > 1) {
        this.waitToGrow(left)
        return
      }
      // A patch or a render on its way first: the margin waits for the canvas to be still.
      if (this.patching > 0 || this.rendering) {
        this.growLater()
        return
      }
      this.growAt = null
      this.growNext = true
      void this.paint()
    }, delay)
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
    this.patching += 1
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
    } finally {
      this.patching -= 1
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
    this.growLater()
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
    const shown = this.placed
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
        const at = toPane(frame.x, frame.y)
        if (Math.abs(frame.bitmap.width / frame.width - zoom * dpr) <= 1e-9 * zoom * dpr) {
          // One bitmap pixel per device pixel: copied whole, at a whole device pixel (see `placed`).
          context.imageSmoothingEnabled = false
          context.drawImage(frame.bitmap, Math.round(at.x * dpr) / dpr, Math.round(at.y * dpr) / dpr, frame.bitmap.width / dpr, frame.bitmap.height / dpr)
        } else {
          context.imageSmoothingEnabled = zoom < 1
          context.imageSmoothingQuality = 'high'
          context.drawImage(frame.bitmap, at.x, at.y, frame.width * zoom, frame.height * zoom)
        }
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
