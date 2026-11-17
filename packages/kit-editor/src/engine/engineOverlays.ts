/**
 * Drawing the engine tools' overlays (kit editors U8b): the marquee, path and
 * line previews, anchors and handles, labels, measurement pills, highlights and swatches an
 * engine answers with, in document pixels. Kit-editor draws them in Kition's style unless the
 * kit asks otherwise, in two ways that combine:
 *
 * - `overlayStyle`: colours, sizes, shapes, dashes and fonts per overlay kind (`OverlayStyle`),
 *   for a kit whose overlays only need a different look;
 * - `drawOverlay`: a hook that draws an overlay itself on the overlay canvas, with the current
 *   view transform; it returns `true` when it drew the overlay, and kit-editor draws the rest in
 *   the style.
 */
import type { RasterDecoration, RasterView } from './rasterViewport'

/** An overlay colour: red, green, blue and alpha, 0 to 255. */
export type OverlayRgba = [number, number, number, number]

/** A drawing primitive over the canvas, in document pixels (`kition_kit::tools::ToolOverlay`). */
export type EngineOverlay =
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'path'; d: string; color: OverlayRgba; width: number; dashed: boolean }
  | { kind: 'line'; ax: number; ay: number; bx: number; by: number; color: OverlayRgba; dashed: boolean }
  | { kind: 'anchor'; x: number; y: number; color: OverlayRgba; filled: boolean; size: number }
  | { kind: 'handle'; x: number; y: number; color: OverlayRgba }
  | { kind: 'label'; x: number; y: number; text: string; color: OverlayRgba }
  | { kind: 'measure'; x: number; y: number; text: string }
  | { kind: 'highlight'; quad: [number, number][]; color: OverlayRgba }
  | { kind: 'swatch'; x: number; y: number; color: OverlayRgba; selected: boolean }

/**
 * How kit-editor draws engine overlays. Sizes are in screen (CSS) pixels at every zoom; colours
 * are CSS colours. `null` where a colour is allowed means "the overlay's own colour".
 */
export type OverlayStyle = {
  /** The tool accent: the marquee's colours and a selected swatch's ring, unless they set theirs. */
  accent: string
  /** The light colour: unfilled anchors, a swatch's ring, text on a dark pill. */
  surface: string
  /** The dark colour: the measurement pill, and text on a light pill. */
  ink: string
  /** The font of labels and pills (CSS `font`). */
  font: string
  marquee: {
    /** Fill colour (`null`: `accent`), drawn at `fillOpacity`. */
    fill: string | null
    fillOpacity: number
    /** Stroke colour (`null`: `accent`). */
    stroke: string | null
    width: number
    /** The stroke's dash pattern; `[]` for a solid line. */
    dash: number[]
    /** Whether the stroke lies inside the rectangle (otherwise it is offset half a pixel past it). */
    inside: boolean
  }
  path: {
    /** The thinnest stroke drawn, whatever the overlay's width. */
    minWidth: number
    /** The dash pattern of a dashed path. */
    dash: number[]
  }
  line: {
    width: number
    /** The dash pattern of a dashed line. */
    dash: number[]
  }
  anchor: {
    /** `square` (rounded by `radius`) or `circle`. */
    shape: 'square' | 'circle'
    /** The square's corner radius. */
    radius: number
    /** The size when the overlay gives none. */
    size: number
    /** An unfilled anchor's fill (`null`: `surface`); a filled one takes the overlay's colour. */
    fill: string | null
    /** The ring in the overlay's colour; 0 for none. */
    ringWidth: number
  }
  handle: {
    radius: number
    /** The dot's fill (`null`: the overlay's colour). */
    fill: string | null
    /** The ring in the overlay's colour; 0 for none. */
    ringWidth: number
  }
  label: {
    font: string | null
    /** The text's offset from the overlay's point (the text's baseline at `dy`). */
    dx: number
    dy: number
  }
  measure: {
    /** Pill colour (`null`: `ink`). */
    fill: string | null
    /** Text colour (`null`: `surface`, or `ink` on a `surface` pill). */
    color: string | null
    font: string | null
    padX: number
    /** Pill height; `null`: the font's size times 1.2 plus `padY` above and below. */
    height: number | null
    padY: number
    radius: number
    /** The pill's offset from the overlay's point. */
    dx: number
    dy: number
    /** Where the point sits on the pill: its left edge (`start`) or its middle (`center`). */
    align: 'start' | 'center'
  }
  swatch: {
    size: number
    radius: number
    ringWidth: number
    /** Ring colour (`null`: `surface`); a selected swatch's (`null`: `accent`). */
    ring: string | null
    selectedRing: string | null
  }
}

/** A kit's changes to the style: any field of any kind (`{ marquee: { dash: [] } }`). */
export type OverlayStylePatch = {
  [K in keyof OverlayStyle]?: OverlayStyle[K] extends object ? Partial<OverlayStyle[K]> : OverlayStyle[K]
}

/** Kition's overlay style, which every kit gets unless it changes it. */
export const DEFAULT_OVERLAY_STYLE: OverlayStyle = Object.freeze({
  accent: '#5645d4',
  surface: '#ffffff',
  ink: '#1f1d2b',
  font: '11px ui-sans-serif, system-ui, sans-serif',
  marquee: { fill: null, fillOpacity: 0.08, stroke: null, width: 1, dash: [4, 3], inside: false },
  path: { minWidth: 1, dash: [4, 3] },
  line: { width: 1, dash: [4, 3] },
  anchor: { shape: 'square', radius: 0, size: 6, fill: null, ringWidth: 1 },
  handle: { radius: 3, fill: null, ringWidth: 0 },
  label: { font: null, dx: 4, dy: -4 },
  measure: { fill: null, color: null, font: null, padX: 6, height: 18, padY: 2, radius: 4, dx: 12, dy: 12, align: 'start' },
  swatch: { size: 12, radius: 3, ringWidth: 2, ring: null, selectedRing: null },
}) as OverlayStyle

/** The default style with a kit's changes. */
export function overlayStyle(patch?: OverlayStylePatch | null): OverlayStyle {
  if (!patch) return DEFAULT_OVERLAY_STYLE
  const base = DEFAULT_OVERLAY_STYLE as Record<string, unknown>
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = base[key]
    out[key] = current && typeof current === 'object' && !Array.isArray(current) ? { ...current, ...(value as object) } : value
  }
  return out as OverlayStyle
}

/** What a kit's `drawOverlay` hook draws with. */
export type OverlayDrawContext = {
  /** The overlay canvas, in CSS pixels, on its own saved state (line width 1, no dash). */
  context: CanvasRenderingContext2D
  /** A document point on the canvas. */
  toScreen: (x: number, y: number) => { x: number; y: number }
  /** The current view: zoom (CSS pixels per document pixel) and the shown pane's offset. */
  view: RasterView
  /** The style in effect (the default with the kit's `overlayStyle`). */
  style: OverlayStyle
  /** Every overlay of this frame, in order, and this one's place among them. */
  overlays: readonly EngineOverlay[]
  index: number
  /** Scratch space shared by one frame's calls (for example labels placed so far); new every frame. */
  frame: Record<string, unknown>
  /** Draws an overlay (this one when none is given) in `style`. */
  drawDefault: (overlay?: EngineOverlay) => void
}

/** A kit's own drawing of an overlay: `true` when it drew it, otherwise kit-editor draws it in the style. */
export type OverlayDrawer = (overlay: EngineOverlay, draw: OverlayDrawContext) => boolean | void

/** An overlay colour as CSS. */
export function overlayCss([r, g, b, a]: OverlayRgba) {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`
}

function fontSize(font: string) {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match ? Number(match[1]) : 11
}

function pill(context: CanvasRenderingContext2D, x: number, y: number, text: string, style: OverlayStyle) {
  const m = style.measure
  const font = m.font ?? style.font
  const fill = m.fill ?? style.ink
  context.font = font
  const width = context.measureText(text).width + m.padX * 2
  const height = m.height ?? Math.round(fontSize(font) * 1.2) + m.padY * 2
  const left = m.align === 'center' ? x - width / 2 : x
  context.fillStyle = fill
  context.beginPath()
  context.roundRect(left, y, width, height, m.radius)
  context.fill()
  context.fillStyle = m.color ?? (fill === style.surface ? style.ink : style.surface)
  context.textBaseline = 'middle'
  context.fillText(text, left + m.padX, y + height / 2)
}

/** Draws one overlay in `style`, on the context's current state. */
export function drawOverlayInStyle(context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, view: RasterView, overlay: EngineOverlay, style: OverlayStyle) {
  switch (overlay.kind) {
    case 'marquee': {
      const s = style.marquee
      const a = toScreen(overlay.x0, overlay.y0)
      const b = toScreen(overlay.x1, overlay.y1)
      context.save()
      context.globalAlpha *= s.fillOpacity
      context.fillStyle = s.fill ?? style.accent
      context.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
      context.restore()
      context.strokeStyle = s.stroke ?? style.accent
      context.lineWidth = s.width
      context.setLineDash(s.dash)
      if (s.inside) {
        const half = s.width / 2
        const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
        const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
        context.strokeRect(x0 + half, y0 + half, Math.max(0, x1 - x0 - s.width), Math.max(0, y1 - y0 - s.width))
      } else context.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y)
      break
    }
    case 'path': {
      const origin = toScreen(0, 0)
      context.translate(origin.x, origin.y)
      context.scale(view.zoom, view.zoom)
      context.lineWidth = Math.max(overlay.width, style.path.minWidth) / view.zoom
      if (overlay.dashed) context.setLineDash(style.path.dash.map((n) => n / view.zoom))
      context.strokeStyle = overlayCss(overlay.color)
      context.stroke(new Path2D(overlay.d))
      break
    }
    case 'line': {
      const a = toScreen(overlay.ax, overlay.ay)
      const b = toScreen(overlay.bx, overlay.by)
      context.lineWidth = style.line.width
      if (overlay.dashed) context.setLineDash(style.line.dash)
      context.strokeStyle = overlayCss(overlay.color)
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.stroke()
      break
    }
    case 'anchor': {
      const s = style.anchor
      const p = toScreen(overlay.x, overlay.y)
      const size = overlay.size || s.size
      const color = overlayCss(overlay.color)
      context.fillStyle = overlay.filled ? color : (s.fill ?? style.surface)
      context.strokeStyle = color
      context.lineWidth = s.ringWidth
      if (s.shape === 'circle') {
        context.beginPath()
        context.arc(p.x, p.y, size / 2, 0, Math.PI * 2)
        context.fill()
        if (s.ringWidth > 0) {
          context.beginPath()
          context.arc(p.x, p.y, Math.max(0, size / 2 - s.ringWidth / 2), 0, Math.PI * 2)
          context.stroke()
        }
      } else if (s.radius > 0) {
        const x = Math.round(p.x - size / 2)
        const y = Math.round(p.y - size / 2)
        const half = s.ringWidth / 2
        context.beginPath()
        context.roundRect(x, y, size, size, s.radius)
        context.fill()
        if (s.ringWidth > 0) {
          context.beginPath()
          context.roundRect(x + half, y + half, size - s.ringWidth, size - s.ringWidth, Math.max(0, s.radius - half))
          context.stroke()
        }
      } else {
        const x = Math.round(p.x - size / 2)
        const y = Math.round(p.y - size / 2)
        context.fillRect(x, y, size, size)
        if (s.ringWidth > 0) context.strokeRect(x + s.ringWidth / 2, y + s.ringWidth / 2, size - s.ringWidth, size - s.ringWidth)
      }
      break
    }
    case 'handle': {
      const s = style.handle
      const p = toScreen(overlay.x, overlay.y)
      const color = overlayCss(overlay.color)
      context.fillStyle = s.fill ?? color
      context.beginPath()
      context.arc(p.x, p.y, s.radius, 0, Math.PI * 2)
      context.fill()
      if (s.ringWidth > 0) {
        context.strokeStyle = color
        context.lineWidth = s.ringWidth
        context.stroke()
      }
      break
    }
    case 'label': {
      const p = toScreen(overlay.x, overlay.y)
      context.font = style.label.font ?? style.font
      context.fillStyle = overlayCss(overlay.color)
      context.fillText(overlay.text, p.x + style.label.dx, p.y + style.label.dy)
      break
    }
    case 'measure': {
      const p = toScreen(overlay.x, overlay.y)
      pill(context, p.x + style.measure.dx, p.y + style.measure.dy, overlay.text, style)
      break
    }
    case 'highlight': {
      context.fillStyle = overlayCss(overlay.color)
      context.beginPath()
      overlay.quad.forEach(([x, y], index) => {
        const p = toScreen(x, y)
        if (index === 0) context.moveTo(p.x, p.y)
        else context.lineTo(p.x, p.y)
      })
      context.closePath()
      context.fill()
      break
    }
    case 'swatch': {
      const s = style.swatch
      const p = toScreen(overlay.x, overlay.y)
      context.fillStyle = overlayCss(overlay.color)
      context.strokeStyle = overlay.selected ? (s.selectedRing ?? style.accent) : (s.ring ?? style.surface)
      context.lineWidth = s.ringWidth
      context.beginPath()
      context.roundRect(p.x - s.size / 2, p.y - s.size / 2, s.size, s.size, s.radius)
      context.fill()
      context.stroke()
      break
    }
  }
}

/** The decoration that draws `overlays`: each by the kit's `draw` hook, or else in `style`. */
export function drawEngineOverlays(overlays: readonly EngineOverlay[], style: OverlayStyle = DEFAULT_OVERLAY_STYLE, draw?: OverlayDrawer | null): RasterDecoration {
  return (context, toScreen, view) => {
    const frame: Record<string, unknown> = {}
    overlays.forEach((overlay, index) => {
      const fresh = () => {
        context.lineWidth = 1
        context.setLineDash([])
      }
      context.save()
      try {
        fresh()
        let drawn = false
        if (draw) {
          const drawDefault = (other: EngineOverlay = overlay) => {
            context.save()
            try {
              fresh()
              drawOverlayInStyle(context, toScreen, view, other, style)
            } finally {
              context.restore()
            }
          }
          drawn = draw(overlay, { context, toScreen, view, style, overlays, index, frame, drawDefault }) === true
        }
        if (!drawn) {
          context.restore()
          context.save()
          fresh()
          drawOverlayInStyle(context, toScreen, view, overlay, style)
        }
      } finally {
        context.restore()
      }
    })
  }
}
