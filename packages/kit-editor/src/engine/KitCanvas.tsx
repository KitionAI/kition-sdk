import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from 'react'
import type { KitEngine } from './kitEngine'
import { HAND_TOOL, type KitGesture, type KitOverlay, type KitPointer, type KitTool, type KitToolContext } from './kitTools'
import { RasterViewport, isEmptyArea, type RasterDecoration, type RasterRect, type RasterView, type RasterViewportStats } from './rasterViewport'
import type { KitChange, KitRepaint } from './useKitDocument'
import { isMac } from '../host'

const FALLBACK_BACKDROP = '#f3f3f6'

/** Behind the document: the theme's `--kit-canvas` (UI protocol section 4). */
function backdrop() {
  return getComputedStyle(document.documentElement).getPropertyValue('--kit-canvas').trim() || FALLBACK_BACKDROP
}
/** A trackpad pinch (or a wheel too fine to be notches) zooms continuously: this much per pixel of delta. */
const WHEEL_ZOOM_SPEED = 0.01
/** How much one notch of a mouse wheel zooms, with Cmd or Ctrl (Office and WPS go about as far). */
export const WHEEL_NOTCH_ZOOM = 1.2
/** At most this many notches count in one wheel event (a fast spin). */
const MAX_WHEEL_NOTCHES = 5

/**
 * How many notches of a mouse wheel a wheel event is, or 0 for a trackpad's scroll or pinch: a
 * wheel counted in lines (three a notch) or pages, or in whole multiples of about 100 pixels (a
 * browser's notch). At most five.
 */
export function wheelNotches(event: Pick<WheelEvent, 'deltaMode' | 'deltaY'>) {
  const delta = Math.abs(event.deltaY)
  let notches = 0
  if (event.deltaMode === 1) notches = delta > 0 ? Math.max(1, Math.round(delta / 3)) : 0
  else if (event.deltaMode === 2) notches = delta > 0 ? 1 : 0
  else if (delta >= 50 && Number.isInteger(event.deltaY)) {
    const whole = Math.round(delta / 100)
    notches = whole >= 1 && Math.abs(delta - whole * 100) <= 10 * whole ? whole : 0
  }
  return Math.min(notches, MAX_WHEEL_NOTCHES)
}

/**
 * A wheel with Cmd or Ctrl, as the canvas's `wheelZoom` gets it: `notches` of a mouse wheel (0 for
 * a trackpad pinch), `direction` 1 to zoom in and -1 out, `deltaY` the event's own delta.
 */
export type KitWheelZoom = { notches: number; direction: 1 | -1; deltaY: number }

/** The canvas's own wheel zoom: `WHEEL_NOTCH_ZOOM` a notch (before: e, 2.72 times, a notch), a pinch continuously. */
export function defaultWheelZoom(zoom: number, wheel: KitWheelZoom) {
  return wheel.notches ? zoom * WHEEL_NOTCH_ZOOM ** (wheel.notches * wheel.direction) : zoom * Math.exp(-wheel.deltaY * WHEEL_ZOOM_SPEED)
}

/** Zooms `viewport` for a wheel with Cmd or Ctrl, about the pointer: `zoom` decides how far. */
function zoomByWheel(viewport: RasterViewport, event: WheelEvent, zoom: ((zoom: number, wheel: KitWheelZoom) => number) | undefined) {
  const wheel: KitWheelZoom = { notches: wheelNotches(event), direction: event.deltaY < 0 ? 1 : -1, deltaY: event.deltaY }
  const next = (zoom ?? defaultWheelZoom)(viewport.view.zoom, wheel)
  if (Number.isFinite(next) && next > 0) viewport.zoomTo(next, event.clientX, event.clientY)
}
const DECORATION_FRAME_MS = 100

/** The canvas's view (its zoom and the document point at its top-left) and its size in CSS pixels. */
export type KitCanvasView = RasterView & { width: number; height: number }

export type KitCanvasHandle = {
  /**
   * The current view as it is drawn (on a whole device pixel, as `onView` reports it) and the
   * canvas's size, or null before the canvas is laid out.
   */
  view: () => KitCanvasView | null
  fit: () => void
  /** Fits an area of the document (a page, a spread) in view. */
  show: (area: RasterRect) => void
  zoomTo: (zoom: number) => void
  zoomBy: (factor: number) => void
  /** Scrolls so document point (`x`, `y`) is at the top-left, keeping the zoom. */
  panTo: (x: number, y: number) => void
  /** Paints the same live document again, preserving unsaved edits and the current view. */
  retryRender: () => Promise<boolean>
}

/**
 * A wheel's scroll (without Cmd or Ctrl) before the canvas pans by it: `dx` and `dy` as the canvas
 * pans (the event's deltas, CSS pixels), the view now, and where its top-left would go (`x`, `y`,
 * document pixels, before the pan bounds).
 */
export type KitWheelPan = { dx: number; dy: number; view: RasterView; x: number; y: number; event: WheelEvent }

/** How far past each edge of the canvas's scrolling part the pointer is, in CSS pixels (0: not past it). */
export type KitEdgePast = { left: number; right: number; top: number; bottom: number }

/**
 * Scrolling while a held gesture's pointer is past the edge of the canvas's scrolling part (the
 * canvas without its pinned bands, `RasterSource.pinned`): a drag selection reaching what is out of
 * view. A timer scrolls the view every frame, the pointer still or not, and sends the gesture's
 * `move` again from the pointer's last place as the view now is. Past the left or top edge counts
 * only while the view can scroll back that way. A pan with Space, the middle button or the Hand
 * tool never scrolls.
 */
export type KitEdgeScroll = {
  /**
   * How fast the view scrolls along `axis`, in CSS pixels a second, with the pointer `over` CSS
   * pixels past the edge (more than 0); 0 does not scroll (`onEdge` still hears it).
   */
  speed: (over: number, axis: 'x' | 'y') => number
  /** Which ways the gesture may scroll now (`back` is left and up); null: none. All by default. */
  ways?: (view: RasterView) => { x: boolean; y: boolean; back: boolean } | null
  /**
   * Whether the pointer is held at the edge it is past for the gesture: its moves and its release
   * name the point just inside the edge (a cell selection reaches the cells at the edge, not the
   * headings or the nothing past it). Off, they name where the pointer is.
   */
  hold?: boolean
  /** During a held gesture: how far past the edges the pointer is, at each sample and frame while it is past one, then null once, when it is back or the gesture ends. */
  onEdge?: (past: KitEdgePast | null) => void
}

type KitCanvasProps = {
  doc: KitEngine
  /** Moves with every document change; the canvas repaints what it names. */
  change: KitChange
  /** Moves with each repaint asked for without a document change (a run with `refresh: 'repaint'`). */
  repaint?: KitRepaint
  tool: KitTool
  /**
   * Every change of the view (a scroll, a zoom, the canvas resized), with the canvas's size: the
   * view the document is drawn at and pointers are read with, its top-left on a whole device pixel.
   */
  onView: (view: KitCanvasView, stats: RasterViewportStats | null) => void
  onRender?: (error: unknown | null) => void
  /** The last view, kept when the document is replaced by a newer version of the file. */
  viewMemory: RefObject<RasterView | null>
  /** Drawn over the document on every frame; `animated` redraws it continuously (marching ants). */
  decorate?: RasterDecoration | null
  animated?: boolean
  /** The area the first view fits (a layout's first spread); the whole document by default. */
  initialArea?: RasterRect | null
  /** The document bounds scrolling stops at; absent for a freely pannable canvas. */
  panBounds?: RasterRect | null
  /** Whether holding Space pans (on by default); a player uses Space for play and pause. */
  spacePans?: boolean
  /**
   * A page shadow and transparency checks under the document (on by default). Off for an engine
   * that paints its own canvas around the document (slides on a pasteboard).
   */
  framed?: boolean
  /**
   * Where a wheel's scroll takes the view (`KitWheelPan`): the view's top-left, in document
   * pixels, the canvas pans to instead (a sheet's whole rows); null or undefined pans by the wheel
   * as usual. The wheel with Cmd or Ctrl zooms as before.
   */
  wheelPan?: ((pan: KitWheelPan) => { x: number; y: number } | null | undefined) | null
  /** Scrolling while a held gesture's pointer is past the canvas's edge (`KitEdgeScroll`); none by default. */
  edgeScroll?: KitEdgeScroll | null
  /**
   * The zoom a wheel with Cmd or Ctrl goes to from `zoom`, about the pointer (a kit's own steps:
   * the next multiple of 10% a notch); `defaultWheelZoom` by default.
   */
  wheelZoom?: (zoom: number, wheel: KitWheelZoom) => number
  /**
   * The text caret while the tool takes text, in document pixels (its top and height): the
   * editor's hidden text field (`TextSink`) is kept on it as the view moves, so an input method's
   * candidate window opens just under the caret's line, lined up with the composition.
   */
  caret?: { x: number; y: number; height: number } | null
  /** HTML laid over the canvas, for example an inline text field. */
  children?: ReactNode
  ref?: Ref<KitCanvasHandle>
}

/**
 * A pointer's pressure, 0 to 1. Only a pen has one: a mouse, a finger, or an unknown device is 1
 * (browsers report 0.5 for a pressed mouse button, which would halve a pressure-sized brush). A
 * pen sample that reports 0 keeps `previous`, the stroke's last pressure (1 at its first sample).
 */
export function pressureOf(event: { pressure: number; pointerType?: string }, previous = 1) {
  if (event.pointerType !== 'pen') return 1
  return event.pressure > 0 ? event.pressure : previous
}

/** What a pointer sample carries that a `KitPointer` is made of. */
type PointerSample = { clientX: number; clientY: number; pressure: number; pointerType?: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }

const sampleOf = ({ clientX, clientY, pressure, pointerType, shiftKey, altKey, metaKey, ctrlKey }: PointerSample): PointerSample => ({ clientX, clientY, pressure, pointerType, shiftKey, altKey, metaKey, ctrlKey })

const isPast = (past: KitEdgePast) => past.left > 0 || past.right > 0 || past.top > 0 || past.bottom > 0

function pointerOf(event: PointerSample, viewport: RasterViewport, previous = 1): KitPointer {
  const point = viewport.toImage(event.clientX, event.clientY)
  const local = viewport.toScreen(point.x, point.y)
  return {
    x: point.x,
    y: point.y,
    pressure: pressureOf(event, previous),
    clientX: event.clientX,
    clientY: event.clientY,
    canvasX: local.x,
    canvasY: local.y,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey || event.ctrlKey,
    ctrl: event.ctrlKey,
  }
}

/**
 * Whether an element from `target` up to (not including) `region` can still scroll by (`dx`, `dy`):
 * a list, a text area or a panel laid over the canvas keeps its own wheel until it reaches its end.
 */
export function scrollsInside(target: EventTarget | null, region: Element, dx: number, dy: number) {
  for (let element = target instanceof Element ? target : null; element && element !== region; element = element.parentElement) {
    if (element instanceof HTMLSelectElement) return true
    const style = getComputedStyle(element)
    const can = (overflow: string, scroll: number, size: number, at: number, delta: number) =>
      (overflow === 'auto' || overflow === 'scroll') && scroll > size && (delta > 0 ? at + size < scroll - 0.5 : delta < 0 ? at > 0.5 : false)
    if (can(style.overflowY, element.scrollHeight, element.clientHeight, element.scrollTop, dy) || can(style.overflowX, element.scrollWidth, element.clientWidth, element.scrollLeft, dx)) return true
  }
  return false
}

/** A Mac's Ctrl and a click of the main button, which the Mac makes a right-click. */
function macContextClick(event: { button: number; ctrlKey: boolean; metaKey: boolean }) {
  return isMac() && event.button === 0 && event.ctrlKey && !event.metaKey
}

/** Presses this close in time (ms) and place (CSS pixels) to the last count as one more click. */
const MULTI_CLICK_MS = 500
const MULTI_CLICK_SLOP = 4

/**
 * Counts the clicks of a press, 1 to 3: the browser's own count is not on `pointerdown` (it is on
 * the mouse events that follow, which the canvas does not get once it takes the press).
 */
export function clickCounter() {
  let last: { at: number; x: number; y: number; button: number; clicks: number } | null = null
  return (event: { timeStamp: number; clientX: number; clientY: number; button: number }) => {
    const near = last && event.button === last.button && event.timeStamp - last.at <= MULTI_CLICK_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) <= MULTI_CLICK_SLOP
    const clicks = near && last ? (last.clicks % 3) + 1 : 1
    last = { at: event.timeStamp, x: event.clientX, y: event.clientY, button: event.button, clicks }
    return clicks
  }
}

function useOverlay(overlayRef: RefObject<HTMLCanvasElement | null>, viewportRef: RefObject<RasterViewport | null>): KitOverlay {
  const paint = (clear: boolean, draw: Parameters<KitOverlay['draw']>[0]) => {
    const overlay = overlayRef.current
    const viewport = viewportRef.current
    const context = overlay?.getContext('2d')
    if (!overlay || !viewport || !context) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(overlay.clientWidth * dpr)
    const height = Math.round(overlay.clientHeight * dpr)
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width
      overlay.height = height
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (clear) context.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight)
    context.save()
    draw(context, (x, y) => viewport.toScreen(x, y))
    context.restore()
  }
  return {
    draw: (draw) => paint(true, draw),
    add: (draw) => paint(false, draw),
    clear: () => {
      const overlay = overlayRef.current
      overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
    },
  }
}

/**
 * A kit document on a canvas, with Kition's pointer handling: the active
 * tool gets gestures in document pixels; Space, the middle button, and the
 * Hand tool pan; the wheel pans, and zooms with Cmd or Ctrl (and pinch). Escape drops a held
 * gesture.
 */
export function KitCanvas({ doc, change, repaint, tool, onView, onRender, viewMemory, initialArea = null, panBounds = null, decorate = null, animated = false, spacePans = true, framed = true, wheelZoom, caret = null, wheelPan = null, edgeScroll = null, children, ref }: KitCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<RasterViewport | null>(null)
  const gesture = useRef<KitGesture | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  /** The cursor the tool's `hover` last answered, for that tool only. */
  const [hovered, setHovered] = useState<{ tool: KitTool; cursor: string } | null>(null)
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered
  const showHover = (answer: unknown) => {
    const cursor = typeof answer === 'string' && answer ? answer : null
    const now = hoveredRef.current
    if (cursor === null ? now === null : now?.tool === tool && now.cursor === cursor) return
    const next = cursor === null ? null : { tool, cursor }
    hoveredRef.current = next
    setHovered(next)
  }
  const regionRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ doc, onView, onRender, initialArea, panBounds, wheelPan, edgeScroll })
  latest.current = { doc, onView, onRender, initialArea, panBounds, wheelPan, edgeScroll }
  const overlay = useOverlay(overlayRef, viewportRef)
  const latestWheelZoom = useRef(wheelZoom)
  latestWheelZoom.current = wheelZoom
  const latestCaret = useRef(caret)
  latestCaret.current = caret
  /** Puts the editor's text field on the caret, as the frame drawn has it. */
  const placeSink = useRef(() => {
    const at = latestCaret.current
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!at || !viewport || !canvas) return
    const frame = regionRef.current?.closest('.kui-app') ?? document
    const field = frame.querySelector<HTMLTextAreaElement>('textarea.kui-text-sink')
    if (!field) return
    const point = viewport.toScreen(at.x, at.y)
    const box = canvas.getBoundingClientRect()
    const holder = (field.offsetParent ?? document.body).getBoundingClientRect()
    const left = Math.round(box.left + point.x - holder.left)
    const top = Math.round(box.top + point.y - holder.top)
    const height = Math.max(1, Math.round(at.height * viewport.view.zoom))
    if (![left, top, height].every(Number.isFinite)) return
    // One line as tall as the caret: the composition starts where the caret is.
    Object.assign(field.style, { left: `${left}px`, top: `${top}px`, height: `${height}px`, lineHeight: `${height}px`, fontSize: `${Math.max(1, Math.round(height * 0.8))}px` })
  })
  useLayoutEffect(() => placeSink.current(), [caret?.x, caret?.y, caret?.height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    // Remember the view only once it is placed (fitted, or carried over), never the default.
    let placed = viewMemory.current != null
    const viewport = new RasterViewport(canvas, doc, backdrop(), (view, stats) => {
      if (placed) viewMemory.current = view
      latest.current.onView({ ...view, width: canvas.clientWidth, height: canvas.clientHeight }, stats)
      placeSink.current()
    }, framed, (error) => { if (latest.current.doc === doc) latest.current.onRender?.(error) })
    viewportRef.current = viewport
    if (viewMemory.current) viewport.view = { ...viewMemory.current }
    viewport.setPanBounds(latest.current.panBounds)
    const observer = new ResizeObserver(() => {
      // Placed once the canvas has both sides: a flex layout can give it a width before a height.
      if (!placed && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        placed = true
        const area = latest.current.initialArea
        if (area) viewport.fitArea(area)
        else viewport.fit()
      }
      if (placed) viewport.resized()
      void viewport.render()
      placeSink.current()
    })
    observer.observe(canvas)
    // Heard on the whole region, so a wheel over the HTML a kit lays over the canvas (`children`:
    // a form field, a note) scrolls and zooms the document too; one a child took (default
    // prevented) or one a scrolling element in it can still scroll by stays the child's.
    const region: HTMLElement = regionRef.current ?? canvas
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return
      const zoom = event.ctrlKey || event.metaKey
      if (!zoom && event.target !== canvas && scrollsInside(event.target, region, event.deltaX, event.deltaY)) return
      event.preventDefault()
      if (zoom) {
        zoomByWheel(viewport, event, latestWheelZoom.current)
        return
      }
      const snap = latest.current.wheelPan
      const view = viewport.view
      const to = snap?.({ dx: event.deltaX, dy: event.deltaY, view: { ...view }, x: view.x + event.deltaX / view.zoom, y: view.y + event.deltaY / view.zoom, event })
      if (to) viewport.panTo(to.x, to.y)
      else viewport.panBy(-event.deltaX, -event.deltaY)
    }
    region.addEventListener('wheel', wheel, { passive: false })
    // The host's theme lands on the root element (`applyTheme`: its style and data-color-scheme):
    // the backdrop follows it, as the rest of the UI does through CSS.
    const theme = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => viewport.setBackdrop(backdrop()))
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-color-scheme', 'data-brand', 'class'] })
    // A lazy font the engine got may change what it draws (glyphs it had none for).
    const fonts = doc.onFonts(() => {
      viewport.invalidate()
      void viewport.render()
    })
    return () => {
      fonts()
      theme?.disconnect()
      observer.disconnect()
      region.removeEventListener('wheel', wheel)
      viewport.dispose()
      viewportRef.current = null
    }
  }, [doc, framed, viewMemory])

  useEffect(() => viewportRef.current?.setPanBounds(panBounds), [doc, panBounds])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // A tool's preview stays until the engine's pixels replace it. An edit that names the area it
    // changed patches that area, keeping a render in flight (its other pixels are still right).
    // The empty area (refreshes that changed no pixel, such as an agent's reads) paints nothing.
    if (change.damage && isEmptyArea(change.damage)) return
    if (!change.damage) viewport.invalidate()
    void (change.damage ? viewport.patch(change.damage) : viewport.render()).then((painted) => { if (painted) overlay.clear() })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repaint once per change
  }, [change])

  // A repaint without a document change: the pixels only, once per tick. Its damage is what the
  // ticks since the last one committed owe together; the empty area paints nothing.
  const repainted = useRef(repaint?.tick ?? 0)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !repaint || repaint.tick === repainted.current) return
    repainted.current = repaint.tick
    if (repaint.damage && isEmptyArea(repaint.damage)) return
    viewport.invalidate()
    void (repaint.damage ? viewport.renderArea(repaint.damage) : viewport.render())
  }, [repaint])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.decorate = decorate
    viewport.draw()
    if (!animated || !decorate) return undefined
    const timer = window.setInterval(() => viewport.draw(), DECORATION_FRAME_MS)
    return () => window.clearInterval(timer)
  }, [animated, decorate, doc])

  useEffect(() => {
    if (!spacePans) return undefined
    const editable = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !editable(event.target)) setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [spacePans])

  useImperativeHandle(ref, () => ({
    view: () => {
      const viewport = viewportRef.current
      const canvas = canvasRef.current
      return viewport && canvas ? { ...viewport.place(viewport.view), width: canvas.clientWidth, height: canvas.clientHeight } : null
    },
    fit: () => viewportRef.current?.fit(),
    show: (area) => viewportRef.current?.fitArea(area),
    zoomTo: (zoom) => viewportRef.current?.zoomTo(zoom),
    zoomBy: (factor) => {
      const viewport = viewportRef.current
      if (viewport) viewport.zoomTo(viewport.view.zoom * factor)
    },
    panTo: (x, y) => viewportRef.current?.panTo(x, y),
    retryRender: async () => {
      const painted = await viewportRef.current?.render() ?? false
      if (painted) overlay.clear()
      return painted
    },
  }), [])

  const context = (): KitToolContext | null => (viewportRef.current ? { viewport: viewportRef.current, overlay } : null)

  // A pen's last pressure in the stroke, for its samples that report none.
  const lastPressure = useRef(1)
  const countClicks = useRef<ReturnType<typeof clickCounter> | null>(null)
  countClicks.current ??= clickCounter()

  /**
   * Edge scrolling (`edgeScroll`): the held gesture's last sample, whether the gesture may scroll
   * (not a pan), its timer, the last frame's time, and whether the pointer was past an edge.
   */
  const edge = useRef<{ sample: PointerSample | null; active: boolean; frame: number; then: number; past: boolean }>({ sample: null, active: false, frame: 0, then: 0, past: false })

  /** How far past each edge of the scrolling part `sample` is, and the point just inside the edges it is past. */
  const edgesOf = (sample: PointerSample, viewport: RasterViewport) => {
    const scroll = latest.current.edgeScroll
    const canvas = canvasRef.current
    if (!scroll || !canvas || !edge.current.active) return null
    const ways = scroll.ways ? scroll.ways({ ...viewport.view }) : { x: true, y: true, back: true }
    if (!ways) return null
    const box = canvas.getBoundingClientRect()
    const right = box.left + canvas.clientWidth
    const bottom = box.top + canvas.clientHeight
    const { zoom } = viewport.view
    const pins = viewport.pins
    const left = box.left + pins.left * zoom
    const top = box.top + pins.top * zoom
    const past: KitEdgePast = {
      left: ways.x && ways.back && viewport.canPanBy(1, 0) ? Math.max(0, left + 1 - sample.clientX) : 0,
      right: ways.x ? Math.max(0, sample.clientX - (right - 1)) : 0,
      top: ways.y && ways.back && viewport.canPanBy(0, 1) ? Math.max(0, top + 1 - sample.clientY) : 0,
      bottom: ways.y ? Math.max(0, sample.clientY - (bottom - 1)) : 0,
    }
    const clientX = past.right > 0 ? right - 1 : past.left > 0 ? left + 1 : sample.clientX
    const clientY = past.bottom > 0 ? bottom - 1 : past.top > 0 ? top + 1 : sample.clientY
    return { past, clientX, clientY }
  }

  /** The held gesture's pointer for `sample`: held just inside the edge it is past when `edgeScroll.hold`. */
  const gesturePointer = (sample: PointerSample, viewport: RasterViewport, previous: number) => {
    const pointer = pointerOf(sample, viewport, previous)
    if (!latest.current.edgeScroll?.hold) return pointer
    const at = edgesOf(sample, viewport)
    if (!at || (at.clientX === sample.clientX && at.clientY === sample.clientY)) return pointer
    const point = viewport.toImage(at.clientX, at.clientY)
    const local = viewport.toScreen(point.x, point.y)
    return { ...pointer, x: point.x, y: point.y, canvasX: local.x, canvasY: local.y }
  }

  /** Tells the kit how far past the edges the pointer is (`onEdge`), and null once when it is back. */
  const tellEdge = (past: KitEdgePast | null) => {
    const state = edge.current
    if (!past && !state.past) return
    state.past = past !== null
    latest.current.edgeScroll?.onEdge?.(past)
  }

  const edgeSpeed = (over: number, axis: 'x' | 'y') => {
    const speed = over > 0 ? latest.current.edgeScroll?.speed(over, axis) ?? 0 : 0
    return Number.isFinite(speed) && speed > 0 ? speed : 0
  }

  const edgeTick = (now: number) => {
    const state = edge.current
    state.frame = 0
    const tools = context()
    const current = gesture.current
    const sample = state.sample
    const at = tools && current && sample ? edgesOf(sample, tools.viewport) : null
    if (!tools || !current || !sample || !at || !isPast(at.past)) {
      tellEdge(null)
      return
    }
    tellEdge(at.past)
    const seconds = state.then ? Math.min(0.1, Math.max(0, (now - state.then) / 1000)) : 1 / 60
    state.then = now
    const dx = (edgeSpeed(at.past.right, 'x') - edgeSpeed(at.past.left, 'x')) * seconds
    const dy = (edgeSpeed(at.past.bottom, 'y') - edgeSpeed(at.past.top, 'y')) * seconds
    const before = tools.viewport.view
    if (dx || dy) tools.viewport.panBy(-dx, -dy)
    const after = tools.viewport.view
    if (after.x !== before.x || after.y !== before.y) current.move?.(gesturePointer(sample, tools.viewport, lastPressure.current), tools)
    state.frame = window.requestAnimationFrame(edgeTick)
  }

  /** After a held gesture's sample: tells the kit where the pointer is and starts the timer when it is past an edge. */
  const edgeSample = (sample: PointerSample) => {
    const state = edge.current
    const tools = context()
    if (!latest.current.edgeScroll || !state.active || !tools) return
    state.sample = sampleOf(sample)
    const at = edgesOf(state.sample, tools.viewport)
    if (!at || !isPast(at.past)) {
      tellEdge(null)
      return
    }
    tellEdge(at.past)
    if (state.frame) return
    state.then = 0
    state.frame = window.requestAnimationFrame(edgeTick)
  }

  /** The held gesture ended: the timer stops, and the kit hears the pointer is back. */
  const edgeStop = () => {
    const state = edge.current
    if (state.frame) window.cancelAnimationFrame(state.frame)
    state.frame = 0
    state.sample = null
    tellEdge(null)
    state.active = false
  }
  useEffect(
    () => () => {
      if (edge.current.frame) window.cancelAnimationFrame(edge.current.frame)
      edge.current.frame = 0
    },
    [],
  )

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    if (!tools || event.button === 2) return
    // On a Mac a click with Ctrl held is a right-click (its contextmenu follows) for a tool with a
    // context menu: no press of the tool.
    if (tool.contextMenu && macContextClick(event)) {
      event.preventDefault()
      return
    }
    // Keyboard focus goes to the editor now (committing any open field), not on the browser's
    // mousedown afterwards, so a field a tool opens (Type) keeps the focus it takes.
    event.preventDefault()
    const editor = event.currentTarget.closest<HTMLElement>('[tabindex]')
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const active = spaceHeld || event.button === 1 ? HAND_TOOL : tool
    const pointer = { ...pointerOf(event, tools.viewport), clicks: countClicks.current!(event) }
    lastPressure.current = pointer.pressure
    edgeStop()
    gesture.current = active.begin(pointer, tools) || null
    edge.current.active = gesture.current !== null && active !== HAND_TOOL
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    if (tools) tool.track?.(pointerOf(event, tools.viewport), tools)
    if (tools && !current && !spaceHeld && event.buttons === 0 && tool.hover) showHover(tool.hover(pointerOf(event, tools.viewport), tools))
    if (!tools || !current?.move) return
    for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
      const pointer = gesturePointer(sample, tools.viewport, lastPressure.current)
      lastPressure.current = pointer.pressure
      current.move(pointer, tools)
    }
    edgeSample(event.nativeEvent)
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    gesture.current = null
    const pointer = tools && current ? gesturePointer(event, tools.viewport, lastPressure.current) : null
    edgeStop()
    if (tools && current && pointer) current.end?.(pointer, tools)
  }

  // Escape while a gesture is held drops it (KitPointer 4.1, 4.3: cancel the gesture in progress,
  // which restores what it changed); the release then commits nothing, and the Escape is the
  // gesture's alone, so it does not also leave Focus or run a command. Heard first, on the window.
  const dropOnEscape = useRef<(event: KeyboardEvent) => void>(() => undefined)
  dropOnEscape.current = (event) => {
    const current = gesture.current
    if (!current || event.key !== 'Escape' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    gesture.current = null
    edgeStop()
    const tools = context()
    if (tools) current.cancel?.(tools)
    overlay.clear()
    event.preventDefault()
    event.stopPropagation()
  }
  useEffect(() => {
    const listen = (event: KeyboardEvent) => dropOnEscape.current(event)
    window.addEventListener('keydown', listen, true)
    return () => window.removeEventListener('keydown', listen, true)
  }, [])

  const pointerCancel = () => {
    const tools = context()
    const current = gesture.current
    // Normal pointer-up also releases capture. Only a still-active gesture is interrupted.
    if (!current) return
    gesture.current = null
    edgeStop()
    if (tools) current.cancel?.(tools)
    overlay.clear()
  }

  return (
    <div ref={regionRef} className="kui-canvas" data-testid="kit-canvas">
      <canvas
        ref={canvasRef}
        className="kui-canvas-surface"
        style={{ cursor: spaceHeld ? HAND_TOOL.cursor : hovered?.tool === tool ? hovered.cursor : tool.cursor }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={pointerCancel}
        onPointerLeave={() => {
          const tools = context()
          // A held gesture keeps the pointer (it is captured) until its release.
          if (tools && !gesture.current) {
            showHover(null)
            tool.leave?.(tools)
          }
        }}
        onDoubleClick={(event) => {
          const tools = context()
          if (tools) tool.doubleClick?.(pointerOf({ ...event, clientX: event.clientX, clientY: event.clientY, pressure: 1 }, tools.viewport), tools)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          const tools = context()
          // Not while a gesture is held (a right-click in the middle of a drag).
          if (!tools || gesture.current || !tool.contextMenu) return
          tool.contextMenu(pointerOf({ clientX: event.clientX, clientY: event.clientY, pressure: 1, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey }, tools.viewport), tools)
        }}
        data-testid="kit-canvas-surface"
      />
      <canvas ref={overlayRef} className="kui-canvas-overlay" aria-hidden="true" />
      {children}
    </div>
  )
}
