/**
 * The editor frame's tabs: a kit's command areas, each with a ribbon (its groups, as kits lay them
 * out), a menu (rows of a menu bar's menu), or both; and the builders that turn a menu catalog or
 * the engine's command paths into menu tabs. The frame filters a menu's rows where it draws them
 * (the UI configuration lives inside the editor provider; kits build tabs outside it).
 */
import type { ReactNode } from 'react'
import { type IconComponent } from '@kition/tessera-icons/react'
import { commandMenuTree } from '../editor'
import type { KitCommand } from '../engine/kitModule'
import type { MenuRow } from '../uiCatalog'

/** A row a kit adds at the top of a menu tab (Layout's Templates…): a menu item, and a button in the tab's generated ribbon; `primary` shows that button in Single line's row. */
export type MenuAction = { label: string; icon?: IconComponent; onSelect: () => void; testId?: string; primary?: boolean }

/** A menu tab's content: its catalog rows (every path starts with the tab's menu) and how they run. */
export type MenuTree = {
  rows: readonly MenuRow[]
  /** Rows the kit never shows (commands a browser cannot run); the same function across renders, or the menu is rebuilt. */
  hidden?: (row: MenuRow) => boolean
  /** Runs a `kit:` row. */
  onKitCommand?: (command: string) => void
  /** Runs an engine row through the kit's own entry point instead of the editor's `run`. */
  onCommand?: (command: string) => void
  /** Check marks for rows that toggle. */
  checked?: (command: string) => boolean | undefined
  before?: readonly MenuAction[]
  /** The row commands (engine ids, and `kit:` rows with their prefix) the generated ribbon shows in Single line's row. */
  primary?: readonly string[]
}

/**
 * A command area. `ribbon` draws in Single line and Classic (and in Menus as a drop-down panel);
 * `menu` draws in Menus as a drop-down menu, and becomes the ribbon (a command grid) when there is
 * no `ribbon`. `view` keeps the tab in a read-only document.
 */
export type FrameTab = { id: string; label: string; view?: boolean; ribbon?: ReactNode; menu?: MenuTree }

/** The Kit UI id a tab answers to: a menu tab its menu's (`menu:File`), a ribbon tab `tab:<id>`. */
export function tabUiId(tab: Pick<FrameTab, 'id' | 'menu'>) {
  return tab.menu ? `menu:${tab.id}` : `tab:${tab.id}`
}

export type MenuTabOptions = Pick<MenuTree, 'hidden' | 'onKitCommand' | 'onCommand' | 'checked'> & {
  /** Translates the menus' names (the editor's `phrase`). */
  phrase?: (english: string) => string
  /** Menus kept in a read-only document (View, Window, Help). */
  view?: readonly string[]
  /** Actions at the top of a menu, by menu name. */
  before?: Readonly<Record<string, readonly MenuAction[]>>
  /** The row commands Single line's row shows, by menu name (see `MenuTree.primary`). */
  primary?: Readonly<Record<string, readonly string[]>>
}

const split = new WeakMap<readonly MenuRow[], Map<string, MenuRow[]>>()

/** A catalog's rows by top-level menu, in catalog order; the same lists for the same catalog. */
function byMenu(catalog: readonly MenuRow[]) {
  let menus = split.get(catalog)
  if (!menus) {
    menus = new Map()
    for (const row of catalog) {
      const top = row.path[0]
      if (!top) continue
      const rows = menus.get(top) ?? []
      rows.push(row)
      menus.set(top, rows)
    }
    split.set(catalog, menus)
  }
  return menus
}

/** A menu catalog's top-level menus as tabs (a ported app's menu bar). */
export function catalogTabs(catalog: readonly MenuRow[], { phrase = (english) => english, view = [], before = {}, primary = {}, ...run }: MenuTabOptions = {}): FrameTab[] {
  return [...byMenu(catalog)].map(([label, rows]) => ({ id: label, label: phrase(label), view: view.includes(label), menu: { rows, before: before[label], primary: primary[label], ...run } }))
}

const commandRows = new WeakMap<readonly KitCommand[], Map<string, MenuRow[]>>()

/** The engine's commands as menu rows; the same list for the same commands, order, and exclusions. */
function rowsOfCommands(commands: readonly KitCommand[], order: readonly string[], exclude: readonly string[]) {
  let known = commandRows.get(commands)
  if (!known) commandRows.set(commands, (known = new Map()))
  const key = JSON.stringify([order, exclude])
  let rows = known.get(key)
  if (!rows) {
    rows = []
    for (const menu of commandMenuTree(commands, order, exclude)) {
      for (const command of menu.commands) rows.push({ path: [menu.label], label: command.title, command: command.id })
      if (menu.commands.length && menu.submenus.size) rows.push({ path: [menu.label], label: '---', command: '---' })
      for (const [sub, items] of menu.submenus) for (const command of items) rows.push({ path: [menu.label, sub], label: command.title, command: command.id })
    }
    known.set(key, rows)
  }
  return rows
}

/** The engine's commands as menu tabs, menus in `order` (others after): a menu's own commands, a separator, then its submenus. */
export function commandMenuTabs(commands: readonly KitCommand[], { order, exclude = [], ...options }: MenuTabOptions & { order: readonly string[]; exclude?: readonly string[] }): FrameTab[] {
  return catalogTabs(rowsOfCommands(commands, order, exclude), options)
}
