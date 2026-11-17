/**
 * The frame's layout state: the person's display mode (stored per kit, within what the host
 * allows), the mode that fits the frame's width (step-down), and touch sizing.
 */
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import type { HostConnection } from '../host'
import { allowedModes, chosenMode, readStoredMode, stepDown, writeStoredMode, type DisplayMode, type KitDisplay } from './modes'

export type DisplayModeState = {
  /** The mode the person chose (or the default), before fitting. */
  chosen: KitDisplay
  focus: boolean
  allowed: readonly DisplayMode[]
  /** Chooses a mode: Menus, Single line, or Classic is kept for the kit; Focus lasts until left. */
  choose: (mode: DisplayMode) => void
  toggleFocus: () => void
  exitFocus: () => void
}

/**
 * The person's display mode. `areas` is false for a frame without tabs, where Menus, Single line,
 * and Classic draw the same: it then shows Menus, and allows only Menus and Focus.
 */
export function useDisplayMode(host: HostConnection, areas = true): DisplayModeState {
  const { modes } = useSyncExternalStore(host.ui.subscribe, host.ui.get)
  const kit = host.kit.id
  const [stored, setStored] = useState(() => readStoredMode(kit))
  const [focus, setFocus] = useState(() => modes.default === 'focus')
  const hostAllowed = allowedModes(modes)
  const allowed = areas ? hostAllowed : hostAllowed.filter((mode) => mode === 'menus' || mode === 'focus')
  const chosen = areas ? chosenMode({ stored, rules: modes, kit: host.display, readOnly: host.readOnly === true }) : 'menus'
  const choose = useCallback(
    (mode: DisplayMode) => {
      if (mode === 'focus') {
        setFocus(true)
        return
      }
      writeStoredMode(kit, mode)
      setStored(mode)
      setFocus(false)
    },
    [kit],
  )
  const toggleFocus = useCallback(() => setFocus((value) => !value), [])
  const exitFocus = useCallback(() => setFocus(false), [])
  return { chosen, focus: focus && allowed.includes('focus'), allowed, choose, toggleFocus, exitFocus }
}

/**
 * The mode that fits: the frame's width (a `ResizeObserver` on its root; unbounded without one),
 * and per mode and tab the width its commands needed when they last overflowed. `measure` reads a
 * shown command row: one that overflows needs the frame's width plus what did not fit; one that
 * fits needs no more than the frame's width, and records nothing more.
 */
export function useStepDown(root: RefObject<HTMLElement | null>, chosen: KitDisplay, tab: string, allowed: readonly DisplayMode[]) {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const [needs, setNeeds] = useState<ReadonlyMap<string, number>>(() => new Map())
  useLayoutEffect(() => {
    const node = root.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next != null) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [root])
  const effective = stepDown(chosen, width, { classic: needs.get(`classic:${tab}`), line: needs.get(`line:${tab}`) }, allowed)
  const measure = useCallback(
    (mode: 'classic' | 'line', panel: HTMLElement | null) => {
      const frame = root.current
      if (!panel || !frame || typeof ResizeObserver === 'undefined') return
      // The border box's width, as fractional as the observer's (clientWidth rounds).
      const frameWidth = frame.getBoundingClientRect().width
      const overflow = panel.scrollWidth - panel.clientWidth
      const key = `${mode}:${tab}`
      setNeeds((known) => {
        const had = known.get(key)
        // Overflowing (1 px of slack for rounding): it needs the frame's width plus what did not fit.
        if (overflow > 1) {
          const need = Math.ceil(frameWidth + overflow)
          return had !== undefined && Math.abs(had - need) <= 1 ? known : new Map(known).set(key, need)
        }
        // It fits: a need above this width was too high (the content shrank); a fit records none.
        if (had === undefined || had <= frameWidth) return known
        return new Map(known).set(key, Math.floor(frameWidth))
      })
    },
    [root, tab],
  )
  return { effective, measure }
}

const COARSE = '(pointer: coarse)'

/** Whether the main pointer is coarse (a finger): the frame then sizes for touch. */
export function useTouchDensity() {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE).matches)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(COARSE)
    const update = () => setTouch(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return touch
}
