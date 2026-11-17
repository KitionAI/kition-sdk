/**
 * "Customize interface" (protocol section 9): the editor's elements as a checkbox tree; what
 * the person unchecks becomes their personal hides. Host-hidden elements are not listed (UI-C3).
 */
import { useMemo, useState } from 'react'
import type { KitUiElement } from '@kition/kit-ui-protocol'
import { Button, Dialog } from '@kition/tessera-ui'
import { MORE_ACTION } from './uiConfig'

export type CustomizeNode = { element: KitUiElement; children: CustomizeNode[] }

/** Ids already warned about once, so a cyclic declaration does not spam the console on every render. */
const warnedCycles = new Set<string>()

/**
 * The tree the dialog shows: elements without host hides (`catalog` is built without the
 * person's hides, so `hidden` means hidden by the host) or a host-hidden element above them,
 * without commands outside menus, without More (the way back here), and, with a `query`, only
 * matches and the elements above them.
 *
 * A kit's declared `parent` ids can be wrong and form a cycle (an element that is, directly or
 * through a loop, its own ancestor). Children are indexed once (`O(n)`), and a node's subtree is
 * built while tracking the ids on its current path; a child already on that path is cut (and
 * warned about once) instead of recursed into, so a bad declaration cannot hang the dialog.
 */
export function customizeTree(catalog: readonly KitUiElement[], query: string): CustomizeNode[] {
  const all = new Map(catalog.map((element) => [element.id, element]))
  /** Whether a parent, a grandparent, and so on is hidden by the host (a parent cycle stops the walk). */
  const hiddenAbove = (element: KitUiElement) => {
    const seen = new Set<string>()
    for (let parent = element.parent; parent !== null && !seen.has(parent); ) {
      seen.add(parent)
      const above = all.get(parent)
      if (!above) return false
      if (above.hidden) return true
      parent = above.parent
    }
    return false
  }
  const shown = catalog.filter((element) => !element.hidden && element.id !== MORE_ACTION && !(element.kind === 'command' && element.parent === null) && !hiddenAbove(element))
  const byId = new Map(shown.map((element) => [element.id, element]))
  const childrenOf = new Map<string, KitUiElement[]>()
  for (const element of shown) {
    if (element.parent === null) continue
    const siblings = childrenOf.get(element.parent)
    if (siblings) siblings.push(element)
    else childrenOf.set(element.parent, [element])
  }

  const node = (element: KitUiElement, path: ReadonlySet<string>): CustomizeNode => {
    const nextPath = new Set(path)
    nextPath.add(element.id)
    const children = (childrenOf.get(element.id) ?? [])
      .filter((child) => {
        if (!nextPath.has(child.id)) return true
        if (!warnedCycles.has(child.id)) {
          warnedCycles.add(child.id)
          console.warn(`[kit-editor] ${child.id} is its own ancestor in the declared elements`)
        }
        return false
      })
      .map((child) => node(child, nextPath))
    return { element, children }
  }

  // A root is an element with no shown parent, or, when a chain of parents loops back on itself
  // with no such element (a pure cycle), the first element of that loop reached while walking up
  // from it — otherwise its whole cycle would never appear. Each element settles exactly once,
  // so a cycle contributes one entry, not one per member.
  const roots: KitUiElement[] = []
  const settled = new Set<string>()
  for (const start of shown) {
    if (settled.has(start.id)) continue
    const path: string[] = []
    let current: KitUiElement | undefined = start
    while (current !== undefined) {
      const here: KitUiElement = current
      if (settled.has(here.id)) {
        for (const id of path) settled.add(id)
        break
      }
      const loopAt = path.indexOf(here.id)
      if (loopAt !== -1) {
        roots.push(byId.get(path[loopAt])!)
        for (const id of path) settled.add(id)
        break
      }
      path.push(here.id)
      const next: KitUiElement | undefined = here.parent !== null ? byId.get(here.parent) : undefined
      if (next === undefined) {
        roots.push(here)
        for (const id of path) settled.add(id)
        break
      }
      current = next
    }
  }

  const needle = query.trim().toLowerCase()
  const matching = (candidate: CustomizeNode): CustomizeNode | null => {
    const children = candidate.children.map(matching).filter((child): child is CustomizeNode => child !== null)
    if (needle && !candidate.element.label.toLowerCase().includes(needle) && !children.length) return null
    return { element: candidate.element, children }
  }

  return roots.map((element) => matching(node(element, new Set()))).filter((item): item is CustomizeNode => item !== null)
}

type Labels = { title: string; search: string; restore: string; cancel: string; save: string }

export function CustomizeDialog({ catalog, personal, labels, onSave, onClose }: { catalog: readonly KitUiElement[]; personal: readonly string[]; labels: Labels; onSave: (hide: string[]) => void; onClose: () => void }) {
  // Personal hides of elements not listed (gone from the kit, or hidden by the host now) are
  // kept; Restore defaults clears them.
  const [hidden, setHidden] = useState<string[]>([...personal])
  const [query, setQuery] = useState('')
  const tree = useMemo(() => customizeTree(catalog, query), [catalog, query])
  const toggle = (id: string) => setHidden((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  const row = (node: CustomizeNode, parentHidden: boolean) => {
    const off = hidden.includes(node.element.id)
    return (
      <li key={node.element.id}>
        <label className="kui-customize-row">
          <input type="checkbox" checked={!off} disabled={parentHidden} onChange={() => toggle(node.element.id)} data-element={node.element.id} />
          <span>{node.element.label}</span>
        </label>
        {node.children.length ? <ul>{node.children.map((child) => row(child, parentHidden || off))}</ul> : null}
      </li>
    )
  }
  return (
    <Dialog
      title={labels.title}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={() => setHidden([])} data-action="restore">
            {labels.restore}
          </Button>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button variant="primary" onClick={() => onSave(hidden)} data-action="save">
            {labels.save}
          </Button>
        </>
      }
    >
      <input className="kui-field kui-customize-search" type="search" placeholder={labels.search} aria-label={labels.search} value={query} onChange={(event) => setQuery(event.target.value)} />
      <ul className="kui-customize-tree" data-testid="kit-customize-tree">
        {tree.map((node) => row(node, false))}
      </ul>
    </Dialog>
  )
}
