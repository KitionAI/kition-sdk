/**
 * A menu tab's rows as menu items, and which rows of each menu tab are drawn: rows, separators,
 * and submenus to any depth; `kit:` rows run by the kit, engine rows through the editor.
 */
import { useMemo, useRef } from 'react'
import { MenuItem, MenuSeparator } from '@kition/tessera-ui'
import { CommandItem, SubMenu, useKitEditor } from '../editor'
import { useUi, warnUndeclared } from '../uiContext'
import { buttonsAt, uiState, type UiConfig } from '../uiConfig'
import { KIT_COMMAND_PREFIX, catalogRowId, type MenuRow } from '../uiCatalog'
import { catalogMenuTree, type CatalogNode } from '../catalogMenus'
import type { FrameTab, MenuTree } from './menus'

/**
 * A `kit:` row: the kit runs it. It is the kit's own element `control:<name>`, under the catalog's
 * menus for hides and disables; people hide it in Customize, not with a right-click (protocol
 * section 9).
 */
function KitRow({ row, checked, onKitCommand }: { row: MenuRow; checked?: boolean; onKitCommand?: (command: string) => void }) {
  const { phrase, testId } = useKitEditor()
  const ui = useUi()
  const id = catalogRowId(row.command)
  warnUndeclared(id, ui.declared)
  const state = ui.state(id, row.path)
  return <MenuItem label={phrase(row.label)} shortcut={row.shortcut} disabled={state.disabled} checked={checked} onSelect={() => !state.denied && onKitCommand?.(row.command)} testId={`${testId}-${id.replace(':', '-')}`} uiId={id} />
}

export function Nodes({ nodes, checked, onKitCommand, onCommand }: { nodes: readonly CatalogNode[]; checked?: MenuTree['checked']; onKitCommand?: (command: string) => void; onCommand?: (command: string) => void }) {
  const { phrase } = useKitEditor()
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === 'separator') return <MenuSeparator key={`---${index}`} />
        if (node.kind === 'submenu')
          return (
            <SubMenu key={`menu:${node.path}`} label={node.label} path={node.path}>
              <Nodes nodes={node.children} checked={checked} onKitCommand={onKitCommand} onCommand={onCommand} />
            </SubMenu>
          )
        const { row } = node
        const key = `${row.command}@${index}`
        if (row.command.startsWith(KIT_COMMAND_PREFIX)) return <KitRow key={key} row={row} checked={checked?.(row.command)} onKitCommand={onKitCommand} />
        // A row the engine lacks is drawn disabled: `enabled` is false for a command it does not know.
        return <CommandItem key={key} command={row.command} path={row.path} label={phrase(row.label)} shortcut={row.shortcut ?? undefined} checked={checked?.(row.command)} onRun={onCommand} />
      })}
    </>
  )
}

/** A menu tab's drop-down: the kit's `before` actions, then its rows. */
export function MenuNodes({ tree, nodes }: { tree: MenuTree; nodes: readonly CatalogNode[] }) {
  return (
    <>
      {tree.before?.map((action) => <MenuItem key={action.label} icon={action.icon} label={action.label} onSelect={action.onSelect} testId={action.testId} />)}
      {tree.before?.length && nodes.length ? <MenuSeparator /> : null}
      <Nodes nodes={nodes} checked={tree.checked} onKitCommand={tree.onKitCommand} onCommand={tree.onCommand} />
    </>
  )
}

type Built = { hidden: MenuTree['hidden']; config: UiConfig; byId: unknown; sessionHidden: unknown; nodes: CatalogNode[] }

/**
 * Each menu tab's rows that are drawn: not hidden by the kit (`hidden`), the host, the person
 * (under the catalog's menus or the engine's own), or the session (a commenter's edits). A submenu
 * left empty stays when the host has buttons for it. A menu is built again only when its rows,
 * `hidden`, the configuration, or the commands change.
 */
export function useVisibleMenus(tabs: readonly FrameTab[]): ReadonlyMap<string, CatalogNode[]> {
  const { byId } = useKitEditor()
  const { config, sessionHidden } = useUi()
  const built = useRef(new WeakMap<readonly MenuRow[], Built>())
  return useMemo(() => {
    const out = new Map<string, CatalogNode[]>()
    const keepEmpty = (path: string) => buttonsAt(config, `menu:${path}`).length > 0 && !uiState(config, `menu:${path}`).hidden
    for (const tab of tabs) {
      if (!tab.menu) continue
      const { rows, hidden } = tab.menu
      const known = built.current.get(rows)
      if (known && known.hidden === hidden && known.config === config && known.byId === byId && known.sessionHidden === sessionHidden) {
        out.set(tab.id, known.nodes)
        continue
      }
      const visible = (row: MenuRow) => {
        if (hidden?.(row)) return false
        if (!row.command.startsWith(KIT_COMMAND_PREFIX) && sessionHidden(row.command)) return false
        const id = catalogRowId(row.command)
        return !uiState(config, id, row.path).hidden && !uiState(config, id, byId.get(row.command)?.menu ?? []).hidden
      }
      const nodes = catalogMenuTree(rows, visible, keepEmpty).find((menu) => menu.label === tab.id)?.children ?? []
      built.current.set(rows, { hidden, config, byId, sessionHidden, nodes })
      out.set(tab.id, nodes)
    }
    return out
  }, [byId, config, sessionHidden, tabs])
}
