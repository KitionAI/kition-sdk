/**
 * Stacking canvas decorations: the engine's overlays (its caret, its selection, a tool's
 * preview) under a kit's own decoration, so a kit's decoration (comment pins, other people's
 * selections, markers) adds to them and never hides them.
 */
import type { RasterDecoration } from './rasterViewport'

/** The decorations already drawn under the decoration being drawn now (drawing is synchronous). */
const drawnBelow = new Set<RasterDecoration>()

/**
 * `draw`, made to draw nothing while `stackDecorations` has already drawn it under the
 * decoration being drawn now: a kit's decoration that still draws the engine's overlays itself
 * (as kits had to before the canvas stacked them) does not draw them twice.
 */
export function drawnOnce(draw: RasterDecoration): RasterDecoration {
  const once: RasterDecoration = (context, toScreen, view) => {
    if (drawnBelow.has(once)) return
    draw(context, toScreen, view)
  }
  return once
}

/** The decorations a stack draws, for marking them all drawn below the one over it. */
const stacked = new WeakMap<RasterDecoration, RasterDecoration[]>()

function partsOf(draw: RasterDecoration): RasterDecoration[] {
  return [draw, ...(stacked.get(draw) ?? []).flatMap(partsOf)]
}

/** `under` then `over`, each on its own canvas state (either may be absent). */
export function stackDecorations(under: RasterDecoration | null | undefined, over: RasterDecoration | null | undefined): RasterDecoration | null {
  if (!under || !over) return under ?? over ?? null
  const stack: RasterDecoration = (context, toScreen, view) => {
    context.save()
    try {
      under(context, toScreen, view)
    } finally {
      context.restore()
    }
    const below = partsOf(under).filter((part) => !drawnBelow.has(part))
    for (const part of below) drawnBelow.add(part)
    context.save()
    try {
      over(context, toScreen, view)
    } finally {
      context.restore()
      for (const part of below) drawnBelow.delete(part)
    }
  }
  stacked.set(stack, [under, over])
  return stack
}
