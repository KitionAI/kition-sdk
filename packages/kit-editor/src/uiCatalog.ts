/**
 * A kit editor's elements (protocol section 9, `ui/elements`). Commands and menus come from the
 * engine; tools, panels, ribbon tabs and groups, and a kit's own controls are declared with
 * `defineKitUi`, because closed menus and inactive tabs are never rendered to be found.
 */
import type { KitUiElement } from '@kition/kit-ui-protocol'
import type { KitCommand } from './engine/kitModule'
import { uiState, type UiConfig } from './uiConfig'

/** A declared element: its full id (`panel:layers`), a key the kit's strings translate, and the element it sits in. */
export type KitUiItem = { id: string; label: string; parent?: string }

/** One row of an upstream-style menu catalog; `command: "---"` is a separator, and a `kit:` command is the kit's own. */
export type MenuRow = { path: readonly string[]; label: string; shortcut?: string | null; command: string }

/**
 * A kit's elements. `menus` is the menu catalog the kit passes to `catalogTabs`, so its menus, commands,
 * and kit rows are listed even while closed.
 */
export type KitUiDeclaration = { tools?: KitUiItem[]; panels?: KitUiItem[]; tabs?: KitUiItem[]; groups?: KitUiItem[]; controls?: KitUiItem[]; menus?: readonly MenuRow[] }

/** The prefix of a catalog row the kit runs itself (Window toggles, Help). */
export const KIT_COMMAND_PREFIX = 'kit:'

/** A catalog row's element id: `control:<name>` for a `kit:<name>` row, `command:<id>` for an engine row. */
export function catalogRowId(command: string) {
  return command.startsWith(KIT_COMMAND_PREFIX) ? `control:${command.slice(KIT_COMMAND_PREFIX.length)}` : `command:${command}`
}

type CatalogElement = { id: string; kind: 'menu' | 'command' | 'control'; label: string; parent: string | null; menu: readonly string[] }

/** A menu catalog's elements in catalog order: each menu before its first row, then the rows (separators skipped), labels untranslated. */
function catalogElements(rows: readonly MenuRow[]): CatalogElement[] {
  const out: CatalogElement[] = []
  const menus = new Set<string>()
  for (const row of rows) {
    for (let depth = 1; depth <= row.path.length; depth += 1) {
      const id = `menu:${row.path.slice(0, depth).join('/')}`
      if (menus.has(id)) continue
      menus.add(id)
      out.push({ id, kind: 'menu', label: row.path[depth - 1], parent: depth > 1 ? `menu:${row.path.slice(0, depth - 1).join('/')}` : null, menu: [] })
    }
    if (row.command === '---') continue
    const id = catalogRowId(row.command)
    out.push({ id, kind: id.startsWith('control:') ? 'control' : 'command', label: row.label, parent: row.path.length ? `menu:${row.path.join('/')}` : null, menu: row.path })
  }
  return out
}

/** A kit's elements, declared once next to its `connectHost` call. */
export function defineKitUi(declaration: KitUiDeclaration): KitUiDeclaration {
  return declaration
}

/** The document actions every shell draws, labeled with the shell's own strings. */
export const DOCUMENT_ACTIONS: KitUiItem[] = [
  { id: 'action:undo', label: 'undo' },
  { id: 'action:redo', label: 'redo' },
  { id: 'action:agent', label: 'askAgent' },
  { id: 'action:mode', label: 'modeMenu' },
  { id: 'action:save', label: 'save' },
  { id: 'action:more', label: 'more' },
]

const KINDS: Record<Exclude<keyof KitUiDeclaration, 'menus'>, string> = { tools: 'tool', panels: 'panel', tabs: 'tab', groups: 'group', controls: 'control' }

/** Every id a kit declared, with the document actions; null when it declared nothing (no warnings then). */
export function declaredIds(declaration: KitUiDeclaration | null): ReadonlySet<string> | null {
  if (!declaration) return null
  const items = (Object.keys(KINDS) as Array<keyof typeof KINDS>).flatMap((key) => (declaration[key] ?? []).map((item) => item.id))
  return new Set([...catalogElements(declaration.menus ?? []).map((element) => element.id), ...items, ...DOCUMENT_ACTIONS.map((item) => item.id)])
}

export type CatalogInput = {
  commands: readonly KitCommand[]
  declaration: KitUiDeclaration | null
  /** The engine's own tools (engine-tools capability), by their engine ids. */
  engineTools: ReadonlyArray<{ id: string; label: string }>
  /** Whether the host has an agent (capability `agent`): without one, Ask Agent is not an element. */
  agent: boolean
  t: (key: string) => string
  phrase: (english: string) => string
  config: UiConfig
}

/** The editor's elements in declared menu catalog, engine menu and command, tool, declared, action order; each id once (the first listing wins). */
export function buildCatalog({ commands, declaration, engineTools, agent, t, phrase, config }: CatalogInput): KitUiElement[] {
  const out: KitUiElement[] = []
  const seen = new Set<string>()
  const add = (id: string, kind: string, label: string, parent: string | null, menu: readonly string[] = []) => {
    if (seen.has(id)) return
    seen.add(id)
    const state = uiState(config, id, menu)
    out.push({ id, kind, label, parent, hidden: state.hidden, disabled: state.disabled })
  }
  for (const element of catalogElements(declaration?.menus ?? [])) add(element.id, element.kind, phrase(element.label), element.parent, element.menu)
  for (const command of commands) {
    for (let depth = 1; depth <= command.menu.length; depth += 1) {
      const parent = depth > 1 ? `menu:${command.menu.slice(0, depth - 1).join('/')}` : null
      add(`menu:${command.menu.slice(0, depth).join('/')}`, 'menu', phrase(command.menu[depth - 1]), parent)
    }
    add(`command:${command.id}`, 'command', phrase(command.title), command.menu.length ? `menu:${command.menu.join('/')}` : null, command.menu)
  }
  for (const tool of engineTools) add(`tool:${tool.id}`, 'tool', phrase(tool.label), null)
  for (const key of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
    for (const item of declaration?.[key] ?? []) add(item.id, KINDS[key], t(item.label), item.parent ?? null)
  }
  for (const item of DOCUMENT_ACTIONS) if (agent || item.id !== 'action:agent') add(item.id, 'action', t(item.label), null)
  return out
}
