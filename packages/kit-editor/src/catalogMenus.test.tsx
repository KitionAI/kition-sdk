// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrushIcon as Brush } from '@kition/tessera-icons/react'
import { catalogMenuTree, type CatalogNode } from './catalogMenus'
import type { MenuRow } from './uiCatalog'
import { EditorFrame } from './frame/EditorFrame'
import { catalogTabs, type MenuTabOptions } from './frame/menus'
import { MenuItem } from '@kition/tessera-ui'
import { createKitStrings, KitEditorProvider, type KitEditor } from './editor'
import { EMPTY_UI_CONFIG, type UiConfig } from './uiConfig'
import { createUiStore, type UiStore } from './uiStore'
import type { KitCommand } from './engine/kitModule'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = (id: string, menu: string[]): KitCommand => ({ id, title: id, description: null, group: '', mutates: true, enabled: true, menu, shortcut: null })

const row = (path: string[], label: string, id: string, shortcut: string | null = null): MenuRow => ({ path, label, shortcut, command: id })
const sep = (path: string[]): MenuRow => ({ path, label: '---', shortcut: null, command: '---' })

/** Two menus, a submenu at the place of its first row, and a submenu three levels deep. */
const CATALOG: MenuRow[] = [
  row(['File'], 'Open…', 'file.open', 'Cmd+O'),
  sep(['File']),
  row(['File', 'Export'], 'Export As…', 'file.export.exportAs'),
  row(['File'], 'Print…', 'file.print'),
  row(['File', 'Export'], 'Quick Export', 'file.export.quick'),
  row(['Layer'], 'New Layer', 'layer.new'),
  row(['Layer', 'Smart Objects'], 'Convert', 'layer.smartObjects.convert'),
  row(['Layer', 'Smart Objects', 'Stack Mode'], 'Median', 'layer.smartObjects.stackMode.median'),
]

const ENGINE = [command('file.open', ['File']), command('file.export.exportAs', ['File', 'Export']), command('file.print', ['File']), command('layer.new', ['Layer']), command('layer.smartObjects.stackMode.median', ['Layer'])]

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
  return root
}

function store(part: Partial<UiConfig> = {}, action: () => void = () => undefined, customize: ((hide: string[]) => Promise<void>) | null = null): UiStore {
  return createUiStore({ ...EMPTY_UI_CONFIG, ...part }, customize, action)
}

/** A fake editor with what the menu bar reads (as in `editor.test.tsx`); a command runs only when the engine has it. */
function fakeEditor(ui: UiStore, commands: KitCommand[] = ENGINE) {
  const byId = new Map(commands.map((item) => [item.id, item]))
  return {
    session: { doc: { info: { canUndo: true, canRedo: false, dirty: false, revision: 1 } }, dirty: false, saving: false, editedBy: null },
    host: { ui, kit: { id: 'kit.test', version: '1' }, display: 'menus', init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration: {}, peer: { handle() {} }, openAgent: vi.fn() },
    commands,
    byId,
    enabled: (id: string) => byId.has(id),
    run: vi.fn(async () => null),
    ask: vi.fn(),
    query: vi.fn(),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: (key: string) => key,
    phrase: (english: string) => (english === 'Open…' ? 'Ouvrir…' : english),
    testId: 'k',
  } as unknown as KitEditor
}

/** A menu catalog as the frame's menu tabs, in Menus. */
function Catalog({ catalog, ...options }: { catalog: readonly MenuRow[] } & MenuTabOptions) {
  return <EditorFrame tabs={catalogTabs(catalog, options)}>{null}</EditorFrame>
}

function app(editor: KitEditor, frame: ReactNode) {
  return <KitEditorProvider editor={editor}>{frame}</KitEditorProvider>
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const byUiId = (id: string) => document.querySelector(`[data-kit-ui-id="${id}"]`) as HTMLElement | null

function contextMenu(element: Element | null) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
}

function click(element: Element | null) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Points at a submenu row, which opens its flyout. */
function hover(element: Element | null) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
  })
}

/** The Kit UI ids and separators of an open menu's own rows, in order (not those of submenus inside it). */
function rows(popover: Element | null) {
  return [...(popover?.children ?? [])].map((child) => {
    if (child.classList.contains('kui-menu-separator')) return '---'
    return (child.matches('[data-kit-ui-id]') ? child : child.querySelector('[data-kit-ui-id]'))?.getAttribute('data-kit-ui-id')
  })
}

const shape = (nodes: readonly CatalogNode[]): unknown[] => nodes.map((node) => (node.kind === 'separator' ? '---' : node.kind === 'row' ? node.row.command : { [node.path]: shape(node.children) }))

describe('catalogMenuTree', () => {
  it('keeps catalog order, puts a submenu where its first row is, and nests to any depth', () => {
    const tree = catalogMenuTree(CATALOG, () => true)
    expect(tree.map((menu) => menu.label)).toEqual(['File', 'Layer'])
    expect(shape(tree[0].children)).toEqual(['file.open', '---', { 'File/Export': ['file.export.exportAs', 'file.export.quick'] }, 'file.print'])
    expect(shape(tree[1].children)).toEqual(['layer.new', { 'Layer/Smart Objects': ['layer.smartObjects.convert', { 'Layer/Smart Objects/Stack Mode': ['layer.smartObjects.stackMode.median'] }] }])
  })

  it('collapses separators left leading, trailing, or doubled by hidden rows, and drops emptied submenus and menus', () => {
    const catalog = [sep(['Edit']), row(['Edit'], 'A', 'a'), sep(['Edit']), row(['Edit'], 'B', 'b'), sep(['Edit']), row(['Edit', 'Sub'], 'C', 'c'), sep(['Edit']), row(['Edit'], 'D', 'd'), sep(['Edit']), row(['Edit'], 'E', 'e'), sep(['Edit']), row(['Help'], 'F', 'f')]
    const hidden = new Set(['b', 'c', 'e', 'f'])
    const tree = catalogMenuTree(catalog, (item) => !hidden.has(item.command))
    expect(tree.map((menu) => menu.label)).toEqual(['Edit'])
    expect(shape(tree[0].children)).toEqual(['a', '---', 'd'])
  })

  it('keeps an emptied submenu or menu the caller wants (host buttons go there), in catalog order', () => {
    const catalog = [row(['Edit'], 'A', 'a'), row(['Edit', 'Sub'], 'C', 'c'), row(['Image'], 'I', 'i'), row(['Help'], 'H', 'h')]
    const tree = catalogMenuTree(catalog, (item) => item.command !== 'c' && item.command !== 'i', (path) => path === 'Edit/Sub' || path === 'Image')
    expect(tree.map((menu) => menu.label)).toEqual(['Edit', 'Image', 'Help'])
    expect(shape(tree[0].children)).toEqual(['a', { 'Edit/Sub': [] }])
    expect(tree[1].children).toEqual([])
  })
})

describe('catalog menu tabs', () => {
  it('draws the menus in catalog order with nested submenus, and runs a deep row through the engine', () => {
    const editor = fakeEditor(store())
    render(app(editor, <Catalog catalog={CATALOG} />))
    const bar = byTestId('k-menu-bar')
    expect([...(bar?.querySelectorAll('.kui-menu-bar-item') ?? [])].map((item) => item.getAttribute('data-kit-ui-id'))).toEqual(['menu:File', 'menu:Layer'])
    // The bar's name is the shell's string, in the page's language (the fake editor's `t` answers the key).
    expect(bar?.getAttribute('aria-label')).toBe('menuBar')
    // …which reads "Menu" in en-US and "菜单" in zh-CN.
    expect(createKitStrings({}, 'en-US')('menuBar')).toBe('Menu')
    expect(createKitStrings({}, 'zh-CN')('menuBar')).toBe('菜单')

    click(byTestId('k-menu-File'))
    const file = document.querySelector('.kui-popover')
    expect(rows(file)).toEqual(['command:file.open', '---', 'menu:File/Export', 'command:file.print'])
    const open = byUiId('command:file.open')
    expect(open?.textContent).toContain('Ouvrir…')
    expect(open?.querySelector('kbd')?.textContent).toBe('Cmd+O')
    click(byTestId('k-menu-File'))

    click(byTestId('k-menu-Layer'))
    hover(byUiId('menu:Layer/Smart Objects'))
    hover(byUiId('menu:Layer/Smart Objects/Stack Mode'))
    click(byUiId('command:layer.smartObjects.stackMode.median'))
    expect(editor.run).toHaveBeenCalledWith('layer.smartObjects.stackMode.median', undefined)
  })

  it('collapses separators around rows the kit hides', () => {
    const catalog = [row(['Edit'], 'A', 'file.open'), sep(['Edit']), row(['Edit'], 'B', 'file.print'), sep(['Edit']), row(['Edit'], 'C', 'layer.new')]
    render(app(fakeEditor(store()), <Catalog catalog={catalog} hidden={(item) => item.command === 'file.print'} />))
    click(byTestId('k-menu-Edit'))
    expect(rows(document.querySelector('.kui-popover'))).toEqual(['command:file.open', '---', 'command:layer.new'])
  })

  it('does not draw a row or a submenu the host hides, nor the separators they leave', () => {
    const ui = store({ hide: ['command:file.open', 'menu:File/Export'] })
    render(app(fakeEditor(ui), <Catalog catalog={CATALOG} />))
    click(byTestId('k-menu-File'))
    expect(rows(document.querySelector('.kui-popover'))).toEqual(['command:file.print'])
    expect(byUiId('command:file.open')).toBeNull()
  })

  it('gives kit: rows control ids and onKitCommand, with check marks, and greys rows the engine lacks', () => {
    const onKitCommand = vi.fn()
    const catalog = [row(['Window'], 'Layers', 'kit:panel.layers'), row(['Window'], 'Toolbar', 'kit:toolbar'), row(['Window'], 'Arrange', 'window.arrange'), row(['Window'], 'Plain', 'kit:plain')]
    const checked = (id: string) => (id === 'kit:panel.layers' ? true : id === 'kit:toolbar' ? false : undefined)
    const editor = fakeEditor(store())
    render(app(editor, <Catalog catalog={catalog} onKitCommand={onKitCommand} checked={checked} />))
    click(byTestId('k-menu-Window'))
    expect(byUiId('command:kit:panel.layers')).toBeNull()
    const layers = byUiId('control:panel.layers') as HTMLButtonElement
    expect(layers.getAttribute('role')).toBe('menuitemcheckbox')
    expect(layers.getAttribute('aria-checked')).toBe('true')
    expect(layers.querySelector('.tessera-icon-check')).not.toBeNull()
    expect(byUiId('control:toolbar')?.getAttribute('aria-checked')).toBe('false')
    expect(byUiId('control:plain')?.getAttribute('role')).toBe('menuitem')
    expect(byUiId('control:plain')?.hasAttribute('aria-checked')).toBe(false)
    expect((byUiId('command:window.arrange') as HTMLButtonElement).disabled).toBe(true)
    expect(layers.disabled).toBe(false)
    click(layers)
    expect(onKitCommand).toHaveBeenCalledWith('kit:panel.layers')
    expect(editor.run).not.toHaveBeenCalled()
  })

  it('offers no right-click Hide on a kit row (Customize hides it), but does on an engine row', () => {
    const catalog = [row(['Window'], 'Layers', 'kit:panel.layers'), row(['Window'], 'Open', 'file.open')]
    render(app(fakeEditor(store({}, () => undefined, async () => undefined)), <Catalog catalog={catalog} />))
    click(byTestId('k-menu-Window'))
    contextMenu(byUiId('control:panel.layers'))
    expect(byTestId('k-hide-element')).toBeNull()
    contextMenu(byUiId('command:file.open'))
    expect(byTestId('k-hide-element')).not.toBeNull()
  })

  it('a kit row follows hides and disables of its catalog menu', () => {
    const catalog = [row(['Window'], 'Layers', 'kit:panel.layers'), row(['Window', 'Workspace'], 'Reset', 'kit:workspace.reset'), row(['Window'], 'Open', 'file.open')]
    render(app(fakeEditor(store({ hide: ['menu:Window/Workspace'], disable: ['control:panel.layers'] })), <Catalog catalog={catalog} />))
    click(byTestId('k-menu-Window'))
    expect(byUiId('control:workspace.reset')).toBeNull()
    expect((byUiId('control:panel.layers') as HTMLButtonElement).disabled).toBe(true)
  })

  it('greys an engine row when the host disables the catalog menu it is drawn under', () => {
    // `layer.new` lives under the engine's Layer menu; the catalog draws it under Image › Adjust.
    const catalog = [row(['Image', 'Adjust'], 'New Layer', 'layer.new'), row(['Image'], 'Open', 'file.open')]
    render(app(fakeEditor(store({ disable: ['menu:Image/Adjust'] })), <Catalog catalog={catalog} />))
    click(byTestId('k-menu-Image'))
    hover(byUiId('menu:Image/Adjust'))
    expect((byUiId('command:layer.new') as HTMLButtonElement).disabled).toBe(true)
    expect((byUiId('command:file.open') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a menu only host buttons fill in its catalog place', () => {
    const catalog = [row(['File'], 'Open', 'file.open'), row(['Edit'], 'Gone', 'edit.gone'), row(['Layer'], 'New Layer', 'layer.new')]
    const ui = store({ hide: ['command:edit.gone'], add: [{ id: 'paste', place: 'menu:Edit', label: { 'en-US': 'Paste it' } }] })
    render(app(fakeEditor(ui), <Catalog catalog={catalog} />))
    expect([...(byTestId('k-menu-bar')?.querySelectorAll('.kui-menu-bar-item') ?? [])].map((item) => item.getAttribute('data-kit-ui-id'))).toEqual(['menu:File', 'menu:Edit', 'menu:Layer'])
  })

  it('builds its menus once while the catalog, hidden, configuration, and commands stay the same', () => {
    const hidden = vi.fn(() => false)
    const editor = fakeEditor(store())
    const root = render(app(editor, <Catalog catalog={CATALOG} hidden={hidden} />))
    const calls = hidden.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    act(() => root.render(app(editor, <Catalog catalog={CATALOG} hidden={hidden} />)))
    click(byTestId('k-menu-File'))
    expect(hidden.mock.calls.length).toBe(calls)
  })

  it("draws the host's buttons in menus and submenus, and a menu only they fill", () => {
    const action = vi.fn()
    const ui = store({ add: [{ id: 'mail', place: 'menu:File/Export', label: { 'en-US': 'Mail it' } }, { id: 'share', place: 'menu:Share', label: { 'en-US': 'Share it' } }] }, action)
    render(app(fakeEditor(ui), <Catalog catalog={CATALOG} />))
    click(byTestId('k-menu-File'))
    hover(byUiId('menu:File/Export'))
    expect(byUiId('host:mail')).not.toBeNull()
    click(byTestId('k-menu-File'))
    click(byTestId('k-menu-Share'))
    click(byUiId('host:share'))
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: 'share' }))
  })
})

describe('menu keys', () => {
  /** A key as a person presses it: on whatever has the focus. */
  const press = (key: string) =>
    act(() => {
      ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-kit-ui-id')

  it('walks into a submenu and back out, each key handled once, and gives the focus back to the menu bar', () => {
    const editor = fakeEditor(store())
    const shell = vi.fn(() => false)
    render(
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={catalogTabs(CATALOG)} onKeyDown={shell}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    const trigger = byTestId('k-menu-File')!
    act(() => trigger.focus())
    click(trigger)
    // The menu takes the focus at its first row.
    expect(focused()).toBe('command:file.open')
    // Down passes the separator and stops on the submenu's row (it takes the focus).
    press('ArrowDown')
    expect(focused()).toBe('menu:File/Export')
    expect(byUiId('command:file.export.exportAs')).toBeNull()
    // Right opens the submenu and moves into it; Down stays inside it (one step, not two).
    press('ArrowRight')
    expect(focused()).toBe('command:file.export.exportAs')
    press('ArrowDown')
    expect(focused()).toBe('command:file.export.exportAs')
    // Escape closes only the submenu and returns to its row; Left does too.
    press('Escape')
    expect(byUiId('command:file.export.exportAs')).toBeNull()
    expect(focused()).toBe('menu:File/Export')
    press('Enter')
    expect(focused()).toBe('command:file.export.exportAs')
    press('ArrowLeft')
    expect(focused()).toBe('menu:File/Export')
    press('ArrowDown')
    expect(focused()).toBe('command:file.print')
    // None of the menu's keys reached the editor's shortcuts.
    expect(shell).not.toHaveBeenCalled()
    // Escape closes the menu and gives the focus back to its button, where the editor's keys work.
    press('Escape')
    expect(document.querySelector('.kui-popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    press('x')
    expect(shell).toHaveBeenCalledTimes(1)
  })

  it('gives the focus back to the button after a choice', () => {
    const editor = fakeEditor(store())
    render(app(editor, <Catalog catalog={CATALOG} />))
    const trigger = byTestId('k-menu-Layer')!
    act(() => trigger.focus())
    click(trigger)
    expect(focused()).toBe('command:layer.new')
    click(byUiId('command:layer.new'))
    expect(document.querySelector('.kui-popover')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('menu placement', () => {
  let resize: (() => void) | null = null
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const name of ['scrollHeight', 'offsetWidth']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    resize = null
  })

  /**
   * A 1000 × 700 window (jsdom has no layout): the File button's box, a submenu row at `rowTop`
   * ending at `rowRight`, and a flyout `height()` tall (its content) and `width` wide.
   */
  function layout({ rowTop, rowRight = 200, height, width = 200, innerWidth = 1000 }: { rowTop: number; rowRight?: number; height: () => number; width?: number; innerWidth?: number }) {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(innerWidth)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('kui-submenu')) return DOMRect.fromRect({ x: rowRight - 200, y: rowTop, width: 200, height: 28 })
      return DOMRect.fromRect({ x: 0, y: 12, width: 40, height: 28 })
    })
    const flyout = (element: HTMLElement) => element.classList.contains('kui-submenu-popover')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return flyout(this) ? height() : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return flyout(this) ? width : 0 } })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect() {}
      },
    )
  }

  function openExport() {
    render(app(fakeEditor(store()), <Catalog catalog={CATALOG} />))
    click(byTestId('k-menu-File'))
    hover(byUiId('menu:File/Export')?.parentElement ?? null)
    return document.querySelector('.kui-submenu-popover') as HTMLElement
  }

  it("fills the room below a menu's button and scrolls, its bottom 8 px inside the window", () => {
    layout({ rowTop: 100, height: () => 100 })
    render(app(fakeEditor(store()), <Catalog catalog={CATALOG} />))
    click(byTestId('k-menu-File'))
    const menu = document.querySelector('.kui-popover') as HTMLElement
    // The button ends at 40; the menu starts 4 px below: 700 − 44 − 8.
    expect([menu.style.top, menu.style.maxHeight]).toEqual(['44px', '648px'])
  })

  it('lifts a flyout that would run past the bottom of the window, so its last rows stay reachable', () => {
    layout({ rowTop: 600, height: () => 400 })
    const flyout = openExport()
    // 700 − 8 − 400: its bottom sits inside the window; it may be as tall as the window less 16 px.
    expect([flyout.style.top, flyout.style.maxHeight]).toEqual(['292px', '684px'])
  })

  it('leaves a flyout that fits beside its row', () => {
    layout({ rowTop: 100, height: () => 120 })
    expect(openExport().style.top).toBe('96px')
  })

  it('scrolls a flyout taller than the window from 8 px below its top', () => {
    layout({ rowTop: 300, height: () => 900 })
    const flyout = openExport()
    expect([flyout.style.top, flyout.style.maxHeight]).toEqual(['8px', '684px'])
  })

  it('moves a flyout left by its measured width to stay inside the window', () => {
    layout({ rowTop: 100, rowRight: 450, height: () => 120, width: 300, innerWidth: 500 })
    // 500 − 300 − 4, not the row's right edge.
    expect(openExport().style.left).toBe('196px')
  })

  it('places a flyout again when its content grows', () => {
    let height = 100
    layout({ rowTop: 500, height: () => height })
    const flyout = openExport()
    expect(flyout.style.top).toBe('496px')
    height = 600
    act(() => resize?.())
    expect(flyout.style.top).toBe('92px')
  })
})

describe('onCommand', () => {
  it("runs engine rows through the kit's own entry point, and still asks for values a command needs", () => {
    const needs = command('layer.new', ['Layer'])
    needs.schema = { name: { type: 'string', required: true } }
    const editor = fakeEditor(store(), [...ENGINE.filter((item) => item.id !== 'layer.new'), needs])
    const onCommand = vi.fn()
    render(app(editor, <Catalog catalog={CATALOG} onCommand={onCommand} />))
    click(byTestId('k-menu-File'))
    click(byUiId('command:file.print'))
    expect(onCommand).toHaveBeenCalledWith('file.print')
    expect(editor.run).not.toHaveBeenCalled()
    click(byTestId('k-menu-Layer'))
    click(byUiId('command:layer.new'))
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(editor.run).toHaveBeenCalledWith('layer.new', undefined)
  })

  it('runs engine rows through the editor when unset', () => {
    const editor = fakeEditor(store())
    render(app(editor, <Catalog catalog={CATALOG} />))
    click(byTestId('k-menu-File'))
    click(byUiId('command:file.print'))
    expect(editor.run).toHaveBeenCalledWith('file.print', undefined)
  })
})

describe('MenuItem', () => {
  it('shows the check mark in place of its icon while checked', () => {
    render(<MenuItem icon={Brush} label="Brush" checked onSelect={() => undefined} uiId="x" />)
    const item = byUiId('x')
    expect(item?.querySelector('.tessera-icon-check')).not.toBeNull()
    expect(item?.querySelector('.tessera-icon-brush')).toBeNull()
    act(() => roots[0].render(<MenuItem icon={Brush} label="Brush" checked={false} onSelect={() => undefined} uiId="x" />))
    expect(byUiId('x')?.querySelector('.tessera-icon-brush')).not.toBeNull()
  })
})
