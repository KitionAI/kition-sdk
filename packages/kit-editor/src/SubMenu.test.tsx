// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu, KitEditorProvider, MenuItem, SubMenu, type ContextMenuPoint, type KitEditor } from './index'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  container?.remove()
})

function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(node))
}

/** What a submenu reads of the editor: its phrases. */
const editor = {
  session: { doc: { info: { canUndo: false, canRedo: false, dirty: false, revision: 1 } }, dirty: false, saving: false, editedBy: null },
  commands: [],
  byId: new Map(),
  enabled: () => true,
  run: vi.fn(async () => null),
  ask: vi.fn(),
  query: vi.fn(),
  save: vi.fn(async () => undefined),
  dialog: null,
  setDialog: vi.fn(),
  t: (key: string) => key,
  host: { ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined), init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration: {}, peer: { handle() {} } },
  phrase: (english: string) => (english === 'Label' ? 'Étiquette' : english),
  testId: 'k',
} as unknown as KitEditor

/** A clip's context menu with a Label submenu, as an editor's timeline draws it. */
function Clip({ onLabel }: { onLabel: (label: string) => void }) {
  const [at, setAt] = useState<ContextMenuPoint | null>({ x: 20, y: 30 })
  return (
    <KitEditorProvider editor={editor}>
      <ContextMenu at={at} onClose={() => setAt(null)} label="Clip" testId="menu">
        <MenuItem label="Cut" onSelect={() => undefined} />
        <SubMenu label="Label" path="Edit/Label">
          <MenuItem label="Violet" onSelect={() => onLabel('Violet')} testId="violet" uiId="command:edit.label.violet" />
        </SubMenu>
      </ContextMenu>
    </KitEditorProvider>
  )
}

const find = (selector: string) => document.querySelector<HTMLElement>(selector)

describe('SubMenu in a ContextMenu', () => {
  it('is exported, opens its flyout from its row, and a row in it runs and closes the menu', () => {
    const onLabel = vi.fn()
    render(<Clip onLabel={onLabel} />)
    const row = find('[data-kit-ui-id="menu:Edit/Label"]')!
    expect(row.textContent).toContain('Étiquette')
    expect(find('[data-testid="violet"]')).toBeNull()
    act(() => {
      row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    const violet = find('[data-testid="violet"]')!
    expect(violet.getAttribute('data-kit-ui-id')).toBe('command:edit.label.violet')
    act(() => {
      violet.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onLabel).toHaveBeenCalledWith('Violet')
    expect(find('[data-testid="menu"]')).toBeNull()
  })

  it('opens on the left of its row when the right has no room, rather than over its own row', () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 150 })
    const box = (left: number) => () => ({ left, right: left + 200, top: 100, bottom: 128, width: 200, height: 28, x: left, y: 100, toJSON: () => ({}) }) as DOMRect
    const openAt = (left: number) => {
      render(<Clip onLabel={vi.fn()} />)
      const row = find('[data-kit-ui-id="menu:Edit/Label"]')!
      row.closest<HTMLElement>('.kui-submenu')!.getBoundingClientRect = box(left)
      act(() => {
        row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      })
      const left_ = find('.kui-submenu-popover')!.style.left
      for (const root of roots) act(() => root.unmount())
      roots = []
      container.remove()
      return left_
    }
    try {
      // Room on the right: beside it there, overlapping its row by 2 px.
      expect(openAt(100)).toBe('298px')
      // None on the right (the window is jsdom's width): on the left, overlapping by 2 px.
      expect(openAt(window.innerWidth - 220)).toBe(`${window.innerWidth - 220 + 2 - 150}px`)
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
    }
  })
})

describe('SubMenu with an id of its own', () => {
  it('carries the given Kit UI id and test id in place of menu:<path>, and still opens', () => {
    render(
      <KitEditorProvider editor={editor}>
        <ContextMenu at={{ x: 20, y: 30 }} onClose={() => undefined} label="Panel">
          <SubMenu label="Font Size" path="Font Size" uiId="control:panel.fontSize" testId="font-size">
            <MenuItem label="Small" onSelect={() => undefined} testId="small" />
          </SubMenu>
        </ContextMenu>
      </KitEditorProvider>,
    )
    const row = find('[data-testid="font-size"]')!
    expect(row.getAttribute('data-kit-ui-id')).toBe('control:panel.fontSize')
    expect(find('[data-kit-ui-id="menu:Font Size"]')).toBeNull()
    act(() => {
      row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(find('[data-testid="small"]')).not.toBeNull()
  })
})
