import type { KitCommand } from './kitModule'

/**
 * Shortcuts Kition itself owns, written as kits write them; a kit command never takes them. A kit
 * with its own key router drops its bindings that match one of these (and the host's
 * `init.shortcuts`), so the host's key still reaches the host. `Cmd+.` opens Kition's command
 * palette from inside a kit (Cmd+K stays the kit's: Word, Slide, and Sheet insert links with it).
 */
export const RESERVED_SHORTCUTS: ReadonlySet<string> = new Set(['Cmd+N', 'Cmd+W', 'Cmd+O', 'Cmd+P', 'Cmd+Q', 'Cmd+,', 'Cmd+S', 'Cmd+Shift+S', 'Cmd+T', 'Cmd+.'])
const HOST_SHORTCUTS = RESERVED_SHORTCUTS

const CODES: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '-': 'Minus',
  '=': 'Equal',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
}

type KeyLike = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
}

/**
 * What a `Ctrl+…` shortcut means off a Mac, where Ctrl is the main modifier: `control` (the
 * default) the Control key as on a Mac, which no key off a Mac matches (Ctrl is read as Cmd
 * there); `primary` Ctrl itself, as `Cmd+…` is (Sheet's `Ctrl+Enter` fills the selection on
 * Windows as WPS does). On a Mac `Ctrl` is always the Control key.
 */
export type CtrlShortcuts = 'control' | 'primary'

/**
 * Whether `event` is `shortcut`, written as kits write it: `Cmd+Shift+Z`, `Alt+Backspace`, `F12`.
 * `Delete` also answers to Backspace (the Mac delete key) unless `exact`. `ctrl` is what a
 * `Ctrl+…` shortcut means off a Mac (`CtrlShortcuts`).
 */
export function shortcutMatches(shortcut: string, event: KeyLike, mac = isMac(), exact = false, ctrl: CtrlShortcuts = 'control') {
  const parts = shortcut.split('+')
  const key = parts.length > 1 && parts[parts.length - 1] === '' ? '+' : parts.pop() ?? ''
  const mods = new Set(parts.filter(Boolean))
  // Off a Mac, `primary` reads `Ctrl+…` (without Cmd) as `Cmd+…`: Ctrl is the main modifier there.
  const primaryCtrl = !mac && ctrl === 'primary' && mods.has('Ctrl') && !mods.has('Cmd')
  const wantCommand = mods.has('Cmd') || primaryCtrl
  const command = mac ? event.metaKey : event.ctrlKey
  const control = mac ? event.ctrlKey : false
  if (wantCommand !== command || (mods.has('Ctrl') && !primaryCtrl) !== control) return false
  if (mods.has('Shift') !== event.shiftKey || mods.has('Alt') !== event.altKey) return false
  if (/^[A-Za-z]$/.test(key)) return event.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}`
  if (CODES[key]) return event.code === CODES[key]
  if (key === 'Delete') return event.key === 'Delete' || (!exact && event.key === 'Backspace')
  return event.key === key
}

/**
 * Whether the frame binds `shortcut`: with a modifier, or Delete, Backspace, Page Up, Page Down,
 * or a function key; never Kition's own.
 */
export function bindableShortcut(shortcut: string | null): shortcut is string {
  if (!shortcut || HOST_SHORTCUTS.has(shortcut)) return false
  return shortcut.includes('+') || /^(Delete|Backspace|PageUp|PageDown|F[0-9]{1,2})$/.test(shortcut)
}

/**
 * The command whose shortcut is `event`, if any, whether or not it can run now. An exact key wins
 * over the Delete and Backspace alias (Film binds both, to different commands). With `ctrl`
 * `primary`, a `Ctrl+…` shortcut off a Mac is pressed with Ctrl (`CtrlShortcuts`); one written
 * with Cmd wins where both match.
 */
export function commandForShortcut(commands: readonly KitCommand[], event: KeyLike, mac = isMac(), ctrl: CtrlShortcuts = 'control') {
  const bound = commands.filter((command) => bindableShortcut(command.shortcut))
  const find = (mode: CtrlShortcuts) => bound.find((command) => shortcutMatches(command.shortcut!, event, mac, true, mode)) ?? bound.find((command) => shortcutMatches(command.shortcut!, event, mac, false, mode))
  return find('control') ?? (ctrl === 'primary' && !mac ? find('primary') : undefined)
}
