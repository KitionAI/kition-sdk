/**
 * The UI configuration (Kit UI protocol section 9): which elements the host hides or disables,
 * the buttons it adds, and what the person hid. Pure functions over element ids such as
 * `command:image.crop`, `menu:Filter/Blur`, and `panel:layers`.
 */
import { KitRpcError, type KitUiConfig, type KitUiHostButton } from '@kition/kit-ui-protocol'
import type { KitCommand } from './engine/kitModule'
import { NO_MODE_RULES, isDisplayMode, type DisplayMode, type ModeRules } from './frame/modes'

/** A parsed configuration: every list present, every entry valid. `personal` is the person's hides; `modes` the display modes the host allows and presets. */
export type UiConfig = { hide: string[]; disable: string[]; add: KitUiHostButton[]; personal: string[]; modes: ModeRules }

export const EMPTY_UI_CONFIG: UiConfig = Object.freeze({
  hide: Object.freeze([]) as unknown as string[],
  disable: Object.freeze([]) as unknown as string[],
  add: Object.freeze([]) as unknown as KitUiHostButton[],
  personal: Object.freeze([]) as unknown as string[],
  modes: NO_MODE_RULES,
}) as UiConfig

const ID = /^(command|menu|tool|panel|tab|group|action|control):(?=\S)[^*]*\*?$/
const PLACE = /^(menu:\S.*|group:[^/\s]+\/\S.*|action)$/

/** Commands that are also document actions: hiding the action denies the command. */
const COMMAND_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['command:edit.undo', 'action:undo'],
  ['command:edit.redo', 'action:redo'],
])

type Warn = (message: string) => void
const consoleWarn: Warn = (message) => console.warn(`[kit-editor] ${message}`)

/** Describes `value` for a warning without throwing: BigInts and circular objects defeat `JSON.stringify` (UI-C4). */
const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return typeof value
  }
}

function ids(value: unknown, where: string, warn: Warn): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn(`ui.${where} is not a list`)
    return []
  }
  return value.filter((item): item is string => {
    const ok = typeof item === 'string' && ID.test(item)
    if (!ok) warn(`ui.${where}: ${show(item)} is not an element id`)
    return ok
  })
}

const optional = (value: unknown, type: string) => value === undefined || typeof value === type

function button(value: unknown, warn: Warn): KitUiHostButton | null {
  const item = (value && typeof value === 'object' ? value : {}) as Partial<KitUiHostButton>
  const plainLabel = item.label && typeof item.label === 'object' && !Array.isArray(item.label) ? item.label : null
  const labels = plainLabel ? Object.values(plainLabel) : []
  const valid =
    typeof item.id === 'string' &&
    item.id !== '' &&
    typeof item.place === 'string' &&
    PLACE.test(item.place) &&
    plainLabel !== null &&
    labels.length > 0 &&
    labels.every((text) => typeof text === 'string' && text.length > 0) &&
    optional(item.icon, 'string') &&
    optional(item.shortcut, 'string') &&
    optional(item.disabled, 'boolean') &&
    optional(item.pressed, 'boolean')
  if (!valid) {
    warn(`ui.add: ${show(value)} is not a valid button`)
    return null
  }
  return { id: item.id!, place: item.place!, label: { ...item.label! }, icon: item.icon, shortcut: item.shortcut, disabled: item.disabled, pressed: item.pressed }
}

/** Drops a button whose id repeats an earlier one, with a warning (UI-C4). */
function dedupeButtons(buttons: readonly KitUiHostButton[], warn: Warn): KitUiHostButton[] {
  const seen = new Set<string>()
  const out: KitUiHostButton[] = []
  for (const item of buttons) {
    if (seen.has(item.id)) {
      warn(`ui.add: duplicate button id "${item.id}"`)
      continue
    }
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/** The host's `ui.modes`, entry by entry (UI-C4): an empty or missing `allowed` allows every mode. */
function modes(value: unknown, warn: Warn): ModeRules {
  if (value === undefined) return NO_MODE_RULES
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warn('ui.modes is not an object')
    return NO_MODE_RULES
  }
  const raw = value as { allowed?: unknown; default?: unknown }
  let allowed: DisplayMode[] | null = null
  if (raw.allowed !== undefined) {
    if (!Array.isArray(raw.allowed)) warn('ui.modes.allowed is not a list')
    else {
      allowed = raw.allowed.filter((mode): mode is DisplayMode => {
        if (!isDisplayMode(mode)) warn(`ui.modes.allowed: ${show(mode)} is not a display mode`)
        return isDisplayMode(mode)
      })
      if (!allowed.length) allowed = null
    }
  }
  let preset: DisplayMode | null = null
  if (raw.default !== undefined) {
    if (isDisplayMode(raw.default)) preset = raw.default
    else warn(`ui.modes.default: ${show(raw.default)} is not a display mode`)
  }
  return { allowed, default: preset }
}

/** A configuration from the host, entry by entry: invalid ones are dropped with a warning (UI-C4). */
export function parseUiConfig(raw: unknown, warn: Warn = consoleWarn): UiConfig {
  if (raw === undefined || raw === null) return EMPTY_UI_CONFIG
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warn('ui is not an object')
    return EMPTY_UI_CONFIG
  }
  const config = raw as KitUiConfig
  if (config.add !== undefined && !Array.isArray(config.add)) warn('ui.add is not a list')
  const parsedButtons = Array.isArray(config.add) ? config.add.map((item) => button(item, warn)).filter((item): item is KitUiHostButton => item !== null) : []
  const add = dedupeButtons(parsedButtons, warn)
  let personal: string[] = []
  if (config.personal !== undefined) {
    if (config.personal !== null && typeof config.personal === 'object' && !Array.isArray(config.personal)) {
      personal = ids(config.personal.hide, 'personal.hide', warn)
    } else {
      warn('ui.personal is not an object')
    }
  }
  return { hide: ids(config.hide, 'hide', warn), disable: ids(config.disable, 'disable', warn), add, personal, modes: modes(config.modes, warn) }
}

/** Whether `pattern` names `id`: the same id, or a prefix ending in `*`. */
export function matches(pattern: string, id: string) {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id
}

/** The ids an element answers to: its own, every menu above it (a command or a menu), and its action. */
export function idsFor(id: string, menu: readonly string[] = []) {
  const out = [id]
  const isMenu = id.startsWith('menu:')
  const path = isMenu ? id.slice('menu:'.length).split('/') : menu
  // A menu id's own id is already `out[0]`: only its strict ancestors go in the loop.
  const upTo = isMenu ? path.length - 1 : path.length
  for (let depth = 1; depth <= upTo; depth += 1) out.push(`menu:${path.slice(0, depth).join('/')}`)
  const action = COMMAND_ACTIONS.get(id)
  if (action) out.push(action)
  return out
}

/** The More menu: the person's only way back to Customize, so a personal hide never hides it. */
export const MORE_ACTION = 'action:more'

/**
 * An element's state: `hidden` (not drawn), `disabled` (drawn greyed), and `denied` (refused on
 * every path, UI-C2; only the host's configuration denies). A host hide counts before a personal
 * one, and a personal hide never covers `action:more`.
 */
export type UiState = { hostHidden: boolean; hostDisabled: boolean; personalHidden: boolean; hidden: boolean; disabled: boolean; denied: boolean }

export function uiState(config: UiConfig, id: string, menu: readonly string[] = []): UiState {
  const names = idsFor(id, menu)
  const any = (patterns: readonly string[]) => patterns.some((pattern) => names.some((name) => matches(pattern, name)))
  const hostHidden = any(config.hide)
  const hostDisabled = !hostHidden && any(config.disable)
  const personalHidden = !hostHidden && id !== MORE_ACTION && any(config.personal)
  return { hostHidden, hostDisabled, personalHidden, hidden: hostHidden || personalHidden, disabled: hostDisabled, denied: hostHidden || hostDisabled }
}

/** The host buttons at `place`, in the host's order. */
export function buttonsAt(config: UiConfig, place: string) {
  return config.add.filter((item) => item.place === place)
}

/** A host button's label for `locale`: the exact tag, its language, `en-US`, then the id (own keys only, so `constructor` is no label). */
export function buttonLabel(item: KitUiHostButton, locale: string) {
  const own = (tag: string) => (Object.hasOwn(item.label, tag) ? item.label[tag] : undefined)
  return own(locale) ?? own(locale.split('-')[0]) ?? own('en-US') ?? item.id
}

/** The error a refused command answers with (UI-C2). `step` names the `ai/run` step, in the message and the data. */
export function notAllowed(command: string, step?: number) {
  const what = step == null ? `\`${command}\`` : `step ${step} (\`${command}\`)`
  return new KitRpcError(-32000, `${what} is not allowed in this editor`, step == null ? { reason: 'not-allowed', command } : { reason: 'not-allowed', command, step })
}

/** The first `ai/run` step the configuration refuses, or -1 (UI-C6). */
export function refusedStep(config: UiConfig, steps: ReadonlyArray<{ command: string }>, menuOf: (id: string) => readonly string[]) {
  return steps.findIndex((step) => uiState(config, `command:${step.command}`, menuOf(step.command)).denied)
}

/** The commands an agent may see: without host-hidden ones, host-disabled ones not enabled (UI-C2). */
export function agentCommands(config: UiConfig, commands: readonly KitCommand[]): KitCommand[] {
  return commands.flatMap((command) => {
    const state = uiState(config, `command:${command.id}`, command.menu)
    if (state.hostHidden) return []
    return [state.hostDisabled ? { ...command, enabled: false } : command]
  })
}
