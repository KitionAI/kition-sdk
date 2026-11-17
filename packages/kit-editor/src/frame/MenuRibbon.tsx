/**
 * A menu tab's commands as ribbon groups, for a tab without a ribbon of its own: the menu's own
 * rows (and the kit's `before` actions) in a group named after the tab, then one group per
 * submenu (deeper submenus' rows join it), each a grid of small buttons with the commands' icons
 * (a `before` action without an icon of its own gets one by its name, here only: menu rows need none).
 * Single line's row shows the kit's `primary` rows, else the tab's first `FALLBACK_PRIMARY` rows. A
 * group's icon, the button it collapses to, is its first row's. Undo and Redo, which the top bar
 * draws, are left out (unless the host hides them there); the tab's menu keeps them.
 */
import { needsParams } from '../CommandDialog'
import { useHistoryState, useKitEditor } from '../editor'
import { COMMAND_FALLBACK_ICON, commandIcon } from '../toolIcons'
import { RibbonButton, RibbonGroup } from '@kition/tessera-ui'
import { useUi } from '../uiContext'
import { KIT_COMMAND_PREFIX, catalogRowId, type MenuRow } from '../uiCatalog'
import type { CatalogNode } from '../catalogMenus'
import type { FrameTab, MenuTree } from './menus'

const rowsOf = (nodes: readonly CatalogNode[]): MenuRow[] => nodes.flatMap((node) => (node.kind === 'row' ? [node.row] : node.kind === 'submenu' ? rowsOf(node.children) : []))

/** How many of its first rows a menu tab shows in Single line's row when its kit names none (`MenuTree.primary`), so the row is never one button. */
export const FALLBACK_PRIMARY = 5

/** A row's button; in Single line's row it keeps its label while its icon is only the fallback. */
function MenuRowButton({ row, tree, primary }: { row: MenuRow; tree: MenuTree; primary?: boolean }) {
  const editor = useKitEditor()
  const ui = useUi()
  const { byId, phrase, testId } = editor
  const label = phrase(row.label)
  if (row.command.startsWith(KIT_COMMAND_PREFIX)) {
    const id = catalogRowId(row.command)
    const state = ui.state(id, row.path)
    const icon = commandIcon({ id: row.command.slice(KIT_COMMAND_PREFIX.length), title: row.label })
    return (
      <RibbonButton
        icon={icon}
        lineLabel={icon === COMMAND_FALLBACK_ICON}
        primary={primary}
        label={label}
        pressed={tree.checked?.(row.command)}
        disabled={state.disabled}
        onClick={() => !state.denied && tree.onKitCommand?.(row.command)}
        data-testid={`${testId}-${id.replace(':', '-')}`}
        data-kit-ui-id={id}
      />
    )
  }
  const known = byId.get(row.command)
  const drawnUnder = ui.state(`command:${row.command}`, row.path)
  const icon = commandIcon(known ?? { id: row.command, title: row.label })
  return (
    <RibbonButton
      icon={icon}
      lineLabel={icon === COMMAND_FALLBACK_ICON}
      primary={primary}
      label={label}
      pressed={tree.checked?.(row.command)}
      disabled={!editor.enabled(row.command) || drawnUnder.disabled}
      onClick={() => {
        if (tree.onCommand && !(known && needsParams(known))) tree.onCommand(row.command)
        else void editor.run(row.command)
      }}
      data-testid={`${testId}-cmd-${row.command}`}
      data-kit-ui-id={`command:${row.command}`}
    />
  )
}

export function MenuRibbon({ tab, nodes }: { tab: FrameTab; nodes: readonly CatalogNode[] }) {
  const { byId, phrase } = useKitEditor()
  // Undo and Redo the top bar draws are not drawn again here (the menu keeps them).
  const history = useHistoryState()
  const above = new Set([...(history.undo.hidden ? [] : ['edit.undo']), ...(history.redo.hidden ? [] : ['edit.redo'])])
  const kept = (rows: readonly MenuRow[]) => rows.filter((row) => !above.has(row.command))
  // A group's icon (the button it becomes when collapsed): its first row's command icon.
  const groupIcon = (rows: readonly MenuRow[]) => {
    const row = rows.find((item) => item.command !== '---')
    return row ? commandIcon(byId.get(row.command) ?? { id: row.command.replace(KIT_COMMAND_PREFIX, ''), title: row.label }) : undefined
  }
  const tree = tab.menu
  if (!tree) return null
  const own = kept(nodes.flatMap((node) => (node.kind === 'row' ? [node.row] : [])))
  const subs = nodes.flatMap((node) => (node.kind === 'submenu' && kept(rowsOf(node.children)).length ? [node] : []))
  // A kit that names no primary rows gets the tab's first rows in Single line's row (an empty list names none on purpose).
  const fallback = tree.primary ? null : new Set([...own, ...subs.flatMap((sub) => kept(rowsOf(sub.children)))].filter((row) => row.command !== '---').slice(0, FALLBACK_PRIMARY).map((row) => row.command))
  const primary = (row: MenuRow) => (fallback ? fallback.has(row.command) : tree.primary?.includes(row.command))
  return (
    <>
      {own.length || tree.before?.length ? (
        <RibbonGroup id={`menu:${tab.id}`} label={tab.label} icon={groupIcon(own)}>
          <div className="kui-command-grid">
            {tree.before?.map((action) => {
              const icon = action.icon ?? commandIcon({ id: action.testId ?? action.label, title: action.label })
              return <RibbonButton key={action.label} icon={icon} lineLabel={!action.icon && icon === COMMAND_FALLBACK_ICON} primary={action.primary} label={action.label} onClick={action.onSelect} data-testid={action.testId} />
            })}
            {own.map((row, index) => (
              <MenuRowButton key={`${row.command}@${index}`} row={row} tree={tree} primary={primary(row)} />
            ))}
          </div>
        </RibbonGroup>
      ) : null}
      {subs.map((sub) => (
        <RibbonGroup key={sub.path} id={`menu:${sub.path}`} label={phrase(sub.label)} icon={groupIcon(kept(rowsOf(sub.children)))}>
          <div className="kui-command-grid">
            {kept(rowsOf(sub.children)).map((row, index) => (
              <MenuRowButton key={`${row.command}@${index}`} row={row} tree={tree} primary={primary(row)} />
            ))}
          </div>
        </RibbonGroup>
      ))}
    </>
  )
}
