/**
 * An upstream-style menu catalog as menus: rows in catalog order, submenus to any depth where
 * their first row is, separators collapsed where hidden rows leave them. Pure.
 */
import type { MenuRow } from './uiCatalog'

const SEPARATOR = '---'

/** A menu's contents: rows, separators, and submenus (`path` is the submenu's `menu:` path). */
export type CatalogNode = { kind: 'row'; row: MenuRow } | { kind: 'separator' } | { kind: 'submenu'; label: string; path: string; children: CatalogNode[] }

export type CatalogMenu = { label: string; children: CatalogNode[] }

/** `nodes` without separators that lead, trail, or follow another separator. */
function collapseSeparators(nodes: readonly CatalogNode[]) {
  const out: CatalogNode[] = []
  for (const node of nodes) {
    if (node.kind === 'separator' && (out.length === 0 || out.at(-1)?.kind === 'separator')) continue
    out.push(node)
  }
  if (out.at(-1)?.kind === 'separator') out.pop()
  return out
}

/** The rows at `depth` and below: rows in order, each submenu where its first row is (as upstream draws them). */
function level(rows: readonly MenuRow[], depth: number, visible: (row: MenuRow) => boolean, keepEmpty: (path: string) => boolean): CatalogNode[] {
  const nodes: CatalogNode[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.path.length === depth) {
      if (row.command === SEPARATOR) nodes.push({ kind: 'separator' })
      else if (visible(row)) nodes.push({ kind: 'row', row })
      continue
    }
    const label = row.path[depth]
    if (seen.has(label)) continue
    seen.add(label)
    const path = row.path.slice(0, depth + 1).join('/')
    const children = level(
      rows.filter((item) => item.path.length > depth && item.path[depth] === label),
      depth + 1,
      visible,
      keepEmpty,
    )
    if (children.length || keepEmpty(path)) nodes.push({ kind: 'submenu', label, path, children })
  }
  return collapseSeparators(nodes)
}

/**
 * A catalog as menus, in catalog order, with only `visible` rows. Separators collapse where hidden
 * rows leave them leading, trailing, or doubled; a menu or submenu left empty is dropped unless
 * `keepEmpty(path)`.
 */
export function catalogMenuTree(catalog: readonly MenuRow[], visible: (row: MenuRow) => boolean, keepEmpty: (path: string) => boolean = () => false): CatalogMenu[] {
  const tops: string[] = []
  for (const row of catalog) {
    const top = row.path[0]
    if (top && !tops.includes(top)) tops.push(top)
  }
  return tops
    .map((label) => ({ label, children: level(catalog.filter((row) => row.path[0] === label), 1, visible, keepEmpty) }))
    .filter((menu) => menu.children.length > 0 || keepEmpty(menu.label))
}
