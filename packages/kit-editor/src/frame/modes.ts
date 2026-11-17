/**
 * The editor's display modes (Kit UI protocol section 9, display modes): the four modes, what the
 * host allows and presets (`ui.modes`), the person's stored choice, and which mode fits the
 * editor's width. Pure functions over plain values; no React.
 */
import type { KitDisplayMode } from '@kition/kit-ui-protocol'

export type DisplayMode = KitDisplayMode
/** A mode a kit may default to (`kit.json` `ui.display`) and the person's stored choice: Focus is entered, never kept. */
export type KitDisplay = Exclude<DisplayMode, 'focus'>

export const DISPLAY_MODES: readonly DisplayMode[] = ['menus', 'line', 'classic', 'focus']
const KIT_DISPLAYS: readonly string[] = ['menus', 'line', 'classic']

/** The narrowest editor that still shows the single line of commands; narrower, it steps down to Menus. */
export const LINE_MIN_WIDTH = 720

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value)
}

/** A `kit.json` `ui.display` (JSON, so checked at runtime); null when absent or not a kit default. */
export function validDisplay(value: unknown): KitDisplay | null {
  return typeof value === 'string' && KIT_DISPLAYS.includes(value) ? (value as KitDisplay) : null
}

export function modeStorageKey(kit: string) {
  return `kui.mode.${kit}`
}

/** The person's stored mode for `kit`; null when none, unreadable, or no storage (a sandboxed frame). */
export function readStoredMode(kit: string): KitDisplay | null {
  try {
    return validDisplay(localStorage.getItem(modeStorageKey(kit)))
  } catch {
    return null
  }
}

/** Keeps the person's mode for `kit`; without storage the choice lasts for this page only. */
export function writeStoredMode(kit: string, mode: KitDisplay) {
  try {
    localStorage.setItem(modeStorageKey(kit), mode)
  } catch {
    // No storage (disabled, full, or a sandboxed frame): the editor still shows the mode.
  }
}

/** The host's `ui.modes`, parsed: null `allowed` allows every mode, null `default` presets none. */
export type ModeRules = { allowed: readonly DisplayMode[] | null; default: DisplayMode | null }

export const NO_MODE_RULES: ModeRules = Object.freeze({ allowed: null, default: null })

/** The modes the person may choose, in `DISPLAY_MODES` order: every mode unless the host lists some. */
export function allowedModes(rules: ModeRules): readonly DisplayMode[] {
  const listed = rules.allowed
  return listed?.length ? DISPLAY_MODES.filter((mode) => listed.includes(mode)) : DISPLAY_MODES
}

/**
 * The mode the editor shows before fitting (UI-C7): the person's stored choice, else the host's
 * preset, else Menus for a read-only document, else the kit's default, else Single line, each
 * only when the host allows it; failing all, the first allowed mode that is not Focus, else Menus.
 */
export function chosenMode({ stored, rules, kit, readOnly }: { stored: KitDisplay | null; rules: ModeRules; kit: KitDisplay | null; readOnly: boolean }): KitDisplay {
  const allowed = allowedModes(rules)
  const preset = rules.default === 'focus' ? null : rules.default
  const candidates: Array<KitDisplay | null> = [stored, preset, readOnly ? 'menus' : null, kit, 'line']
  for (const mode of candidates) if (mode && allowed.includes(mode)) return mode
  return allowed.find((mode): mode is KitDisplay => mode !== 'focus') ?? 'menus'
}

/** The editor width each mode's commands needed when last shown, for the selected tab. */
export type ModeNeeds = { classic?: number; line?: number }

/**
 * The mode that fits `width` (UI-C8): `chosen`, stepped down Classic, Single line, Menus while it
 * does not fit. Single line needs at least `LINE_MIN_WIDTH`, and each needs what its commands
 * last measured; Menus always fits. A step skips modes the host does not allow; when none fits,
 * the lowest allowed one shows (and scrolls).
 */
export function stepDown(chosen: KitDisplay, width: number, needs: ModeNeeds, allowed: readonly DisplayMode[]): KitDisplay {
  const order: KitDisplay[] = ['classic', 'line', 'menus']
  const fits = (mode: KitDisplay) => mode === 'menus' || width >= Math.max(LINE_MIN_WIDTH, needs[mode] ?? 0)
  let last: KitDisplay = chosen
  for (const mode of order.slice(order.indexOf(chosen))) {
    if (!allowed.includes(mode)) continue
    last = mode
    if (fits(mode)) return mode
  }
  return last
}
