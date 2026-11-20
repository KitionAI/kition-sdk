/**
 * The canvas around an engine-drawn document (the pasteboard around pages, slides or spreads)
 * follows the host's theme. An engine that paints that area itself takes its colour as `#rrggbb`
 * through an engine extra (`setBackdrop` by default), so CSS cannot reach it: the editor gives it
 * the theme's `--kit-canvas` when the document opens and again whenever the host changes the theme
 * (`ui/theme`, applied at once by `applyTheme`, no reload), and the canvas repaints. Only the
 * on-screen editor does this; previews, export and print never set a backdrop.
 */
import { useEffect, type RefObject } from 'react'
import type { KitCanvasHandle } from './KitCanvas'
import type { KitEngine } from './kitEngine'

const HEX = /^#[0-9a-f]{6}$/i

/**
 * A theme token (`--kit-canvas` by default) of `root` as `#rrggbb`: the token is any CSS colour
 * (Kition sends `hsl(...)`), which the browser resolves through a 2D canvas. `null` when it is
 * unset, not a colour, or not opaque.
 */
export function canvasColor(root: HTMLElement = document.documentElement, token = '--kit-canvas'): string | null {
  const value = getComputedStyle(root).getPropertyValue(token).trim()
  if (HEX.test(value)) return value.toLowerCase()
  if (!value || typeof CSS === 'undefined' || !CSS.supports('color', value)) return null
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return null
  context.fillStyle = value
  const resolved = String(context.fillStyle)
  return HEX.test(resolved) ? resolved.toLowerCase() : null
}

export type EngineBackdropOptions = {
  /** The engine extra that takes the colour (`#rrggbb`); `setBackdrop` by default. */
  method?: string
  /** The theme token read; `--kit-canvas` by default. */
  token?: string
  /** The element the theme is applied to; the document's root by default. */
  root?: HTMLElement
}

/**
 * Keeps the engine's pasteboard the theme's canvas colour while `doc` is open: the colour is given
 * at open and on every change of the theme (the root's style, class or `data-color-scheme`), each
 * time it differs from the last one given, and `canvas` repaints after the engine took it. A
 * failure of the engine extra is ignored (the pasteboard keeps its colour).
 */
export function useEngineBackdrop(doc: KitEngine | null, canvas: RefObject<KitCanvasHandle | null>, options: EngineBackdropOptions = {}) {
  const { method = 'setBackdrop', token = '--kit-canvas', root } = options
  useEffect(() => {
    if (!doc) return undefined
    const element = root ?? document.documentElement
    let open = true
    let given: string | null = null
    const follow = () => {
      const color = canvasColor(element, token)
      if (!color || color === given) return
      given = color
      void doc
        .invoke(method, color)
        .then(() => (open ? canvas.current?.retryRender() : undefined))
        .catch(() => undefined)
    }
    follow()
    // kit-editor's `applyTheme` writes the tokens on the root's style and marks its data-color-scheme.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(follow)
    observer?.observe(element, { attributes: true, attributeFilter: ['style', 'data-color-scheme', 'class'] })
    return () => {
      open = false
      observer?.disconnect()
    }
  }, [doc, canvas, method, token, root])
}
