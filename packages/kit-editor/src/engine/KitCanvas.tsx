import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from 'react'
import type { KitEngine } from './kitEngine'
import { HAND_TOOL, type KitGesture, type KitOverlay, type KitPointer, type KitTool, type KitToolContext } from './kitTools'
import { RasterViewport, isEmptyArea, type RasterDecoration, type RasterRect, type RasterView, type RasterViewportStats } from './rasterViewport'
import type { KitChange, KitRepaint } from './useKitDocument'

const FALLBACK_BACKDROP = '#f3f3f6'

/** Behind the document: the theme's `--kit-canvas` (UI protocol section 4). */
function backdrop() {
  return getComputedStyle(document.documentElement).getPropertyValue('--kit-canvas').trim() || FALLBACK_BACKDROP
}
const WHEEL_ZOOM_SPEED = 0.01
const DECORATION_FRAME_MS = 100

/** The canvas's view (its zoom and the document point at its top-left) and its size in CSS pixels. */
export type KitCanvasView = RasterView & { width: number; height: number }

export type KitCanvasHandle = {
  /** The current view and the canvas's size, or null before the canvas is laid out. */
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

type KitCanvasProps = {
  doc: KitEngine
  /** Moves with every document change; the canvas repaints what it names. */
  change: KitChange
  /** Moves with each repaint asked for without a document change (a run with `refresh: 'repaint'`). */
  repaint?: KitRepaint
  tool: KitTool
  /** Every change of the view (a scroll, a zoom, the canvas resized), with the canvas's size. */
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

function pointerOf(event: { clientX: number; clientY: number; pressure: number; pointerType?: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }, viewport: RasterViewport, previous = 1): KitPointer {
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
export function KitCanvas({ doc, change, repaint, tool, onView, onRender, viewMemory, initialArea = null, panBounds = null, decorate = null, animated = false, spacePans = true, framed = true, children, ref }: KitCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<RasterViewport | null>(null)
  const gesture = useRef<KitGesture | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const latest = useRef({ doc, onView, onRender, initialArea, panBounds })
  latest.current = { doc, onView, onRender, initialArea, panBounds }
  const overlay = useOverlay(overlayRef, viewportRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    // Remember the view only once it is placed (fitted, or carried over), never the default.
    let placed = viewMemory.current != null
    const viewport = new RasterViewport(canvas, doc, backdrop(), (view, stats) => {
      if (placed) viewMemory.current = view
      latest.current.onView({ ...view, width: canvas.clientWidth, height: canvas.clientHeight }, stats)
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
    })
    observer.observe(canvas)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) viewport.zoomTo(viewport.view.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), event.clientX, event.clientY)
      else viewport.panBy(-event.deltaX, -event.deltaY)
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
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
      canvas.removeEventListener('wheel', wheel)
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
      return viewport && canvas ? { ...viewport.view, width: canvas.clientWidth, height: canvas.clientHeight } : null
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

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    if (!tools || event.button === 2) return
    // Keyboard focus goes to the editor now (committing any open field), not on the browser's
    // mousedown afterwards, so a field a tool opens (Type) keeps the focus it takes.
    event.preventDefault()
    const editor = event.currentTarget.closest<HTMLElement>('[tabindex]')
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const active = spaceHeld || event.button === 1 ? HAND_TOOL : tool
    const pointer = pointerOf(event, tools.viewport)
    lastPressure.current = pointer.pressure
    gesture.current = active.begin(pointer, tools) || null
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    if (tools) tool.track?.(pointerOf(event, tools.viewport), tools)
    if (tools && !current && !spaceHeld && event.buttons === 0) tool.hover?.(pointerOf(event, tools.viewport), tools)
    if (!tools || !current?.move) return
    for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
      const pointer = pointerOf(sample, tools.viewport, lastPressure.current)
      lastPressure.current = pointer.pressure
      current.move(pointer, tools)
    }
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    gesture.current = null
    if (tools && current) current.end?.(pointerOf(event, tools.viewport, lastPressure.current), tools)
  }

  // Escape while a gesture is held drops it (KitPointer 4.1, 4.3: cancel the gesture in progress,
  // which restores what it changed); the release then commits nothing, and the Escape is the
  // gesture's alone, so it does not also leave Focus or run a command. Heard first, on the window.
  const dropOnEscape = useRef<(event: KeyboardEvent) => void>(() => undefined)
  dropOnEscape.current = (event) => {
    const current = gesture.current
    if (!current || event.key !== 'Escape' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    gesture.current = null
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
    if (tools) current.cancel?.(tools)
    overlay.clear()
  }

  return (
    <div className="kui-canvas" data-testid="kit-canvas">
      <canvas
        ref={canvasRef}
        className="kui-canvas-surface"
        style={{ cursor: spaceHeld ? HAND_TOOL.cursor : tool.cursor }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={pointerCancel}
        onPointerLeave={() => {
          const tools = context()
          // A held gesture keeps the pointer (it is captured) until its release.
          if (tools && !gesture.current) tool.leave?.(tools)
        }}
        onDoubleClick={(event) => {
          const tools = context()
          if (tools) tool.doubleClick?.(pointerOf({ ...event, clientX: event.clientX, clientY: event.clientY, pressure: 1 }, tools.viewport), tools)
        }}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="kit-canvas-surface"
      />
      <canvas ref={overlayRef} className="kui-canvas-overlay" aria-hidden="true" />
      {children}
    </div>
  )
}
