// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrushIcon as Brush, EraserIcon as Eraser, MoveIcon as Move } from '@kition/tessera-icons/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitNotifications } from '@kition/kit-ui-protocol'
import { CommandButton, KIT_UI_CATALOGS, KitEditorProvider, ToolButton, ToolRail, commandMenuTree, useKitEditorState, type KitEditor, type KitSession, type KitTools, type RailTool } from './editor'
import { EditorFrame } from './frame/EditorFrame'
import { commandMenuTabs, type FrameTab } from './frame/menus'
import { PreviewDialog } from '@kition/tessera-ui'
import { TextSink } from './TextSink'
import { createStrings } from './strings'
import { Dialog, Toaster } from '@kition/tessera-ui'
import { EMPTY_UI_CONFIG, notAllowed, type UiConfig } from './uiConfig'
import { createUiStore, type UiStore } from './uiStore'
import type { HostConnection } from './host'
import type { KitCommand } from './engine/kitModule'
import type { KitUiDeclaration } from './uiCatalog'
import { useEngineTools, type EngineToolInfo } from './engine/engineTools'
import type { KitChange } from './engine/useKitDocument'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = (id: string, menu: string[], schema?: Record<string, unknown>): KitCommand => ({ id, title: id, description: null, group: '', mutates: true, enabled: true, menu, shortcut: null, schema })

describe('commandMenuTree', () => {
  it('drops hidden commands and the menus they leave empty', () => {
    const commands = [command('filter.blur', ['Filter', 'Blur']), command('help.about', ['Help']), command('file.open', ['File']), command('file.export.png', ['File', 'Export'])]
    const hidden = new Set(['filter.blur', 'file.export.png'])
    const tree = commandMenuTree(commands, ['File', 'Filter', 'Help'], [], (item) => !hidden.has(item.id))
    expect(tree.map((menu) => [menu.label, menu.commands.map((item) => item.id), [...menu.submenus.keys()]])).toEqual([
      ['File', ['file.open'], []],
      ['Help', ['help.about'], []],
    ])
  })
})

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

const config = (part: Partial<UiConfig>): UiConfig => ({ ...EMPTY_UI_CONFIG, ...part })

function store(part: Partial<UiConfig> = {}, customize: ((hide: string[]) => Promise<void>) | null = null, action: (params: KitNotifications['ui/action']) => void = () => undefined) {
  return createUiStore(config(part), customize, action)
}

const COMMANDS = [command('edit.undo', ['Edit']), command('edit.redo', ['Edit']), command('help.about', ['Help']), command('x', ['Edit'])]

/** A fake editor with what the shared components read; it declares its UI unless `declaration` is null. */
function fakeEditor(ui: UiStore, commands: KitCommand[] = COMMANDS, declaration: KitUiDeclaration | null = {}, display: 'menus' | 'line' | 'classic' = 'menus') {
  return {
    session: { doc: { info: { canUndo: true, canRedo: false, dirty: true, revision: 1 } }, dirty: true, saving: false, editedBy: null },
    host: { ui, kit: { id: 'kit.test', version: '1' }, display, init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration, peer: { handle() {} }, openAgent: vi.fn() },
    commands,
    canUndo: true,
    canRedo: false,
    byId: new Map(commands.map((item) => [item.id, item])),
    enabled: () => true,
    run: vi.fn(async () => null),
    ask: vi.fn(),
    query: vi.fn(),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: (key: string) => key,
    phrase: (english: string) => english,
    testId: 'k',
  } as unknown as KitEditor
}

function app(editor: KitEditor, children: ReactNode, tools: KitTools | null = null, tabs: readonly FrameTab[] = []) {
  return (
    <KitEditorProvider editor={editor} tools={tools}>
      <EditorFrame tabs={tabs}>{children}</EditorFrame>
    </KitEditorProvider>
  )
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function click(element: Element | null) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function contextMenu(element: Element | null) {
  act(() => {
    element?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
}

function cmdS() {
  act(() => {
    document.querySelector('.kui-app')?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: true, bubbles: true }))
  })
}

describe('menu tabs', () => {
  it('hides a hidden menu and draws a menu with only host buttons', () => {
    const action = vi.fn()
    const ui = store({ hide: ['menu:Help'], add: [{ id: 'share', place: 'menu:Share', label: { 'en-US': 'Share it' } }] }, null, action)
    render(app(fakeEditor(ui), null, null, commandMenuTabs(COMMANDS, { order: ['Edit', 'Help'] })))
    expect(byTestId('k-menu-Help')).toBeNull()
    expect(byTestId('k-menu-Edit')).not.toBeNull()
    click(byTestId('k-menu-Share'))
    click(document.querySelector('[data-kit-ui-id="host:share"]'))
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: 'share' }))
  })
})

describe('DocumentActions', () => {
  it('a host-disabled Save is greyed and Cmd+S does not save', () => {
    const editor = fakeEditor(store({ disable: ['action:save'] }))
    render(app(editor, null))
    expect((byTestId('k-save') as HTMLButtonElement).disabled).toBe(true)
    cmdS()
    expect(editor.save).not.toHaveBeenCalled()
  })

  it('a personally hidden Save is not drawn but Cmd+S still saves', () => {
    const editor = fakeEditor(store({ personal: ['action:save'] }))
    render(app(editor, null))
    expect(byTestId('k-save')).toBeNull()
    cmdS()
    expect(editor.save).toHaveBeenCalled()
  })

  it('Cmd+S saves from a field, which keeps its other keys', () => {
    const editor = fakeEditor(store(), [{ ...command('x', ['Edit']), shortcut: 'K' } as KitCommand])
    render(app(editor, <input data-testid="field" />))
    const field = byTestId('field')
    act(() => void field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })))
    expect(editor.run).not.toHaveBeenCalled()
    act(() => void field?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })))
    expect(editor.save).toHaveBeenCalledTimes(1)
  })

  it("a host button's shortcut comes before Save's", () => {
    const action = vi.fn()
    const editor = fakeEditor(store({ add: [{ id: 'keep', place: 'action', label: { 'en-US': 'Keep' }, shortcut: 'Cmd+S' }] }, null, action))
    render(app(editor, null))
    cmdS()
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: 'keep' }))
    expect(editor.save).not.toHaveBeenCalled()
  })

  it('Undo follows its command: hidden with its menu, disabled with the command', () => {
    render(app(fakeEditor(store({ hide: ['menu:Edit'] })), null))
    expect(byTestId('k-undo')).toBeNull()
    act(() => roots.pop()?.unmount())
    render(app(fakeEditor(store({ disable: ['command:edit.undo'] })), null))
    expect((byTestId('k-undo') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('EditorFrame shell', () => {
  it('draws the status bar, with the unsaved mark, unless statusBar is false', () => {
    render(app(fakeEditor(store()), null))
    expect(document.querySelector('.kui-status-bar')).not.toBeNull()
    expect(byTestId('k-unsaved')).not.toBeNull()
    act(() => roots.pop()?.unmount())
    render(
      <KitEditorProvider editor={fakeEditor(store())}>
        <EditorFrame tabs={[]} status={<span data-testid="k-own-status" />} statusBar={false}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    expect(document.querySelector('.kui-status-bar')).toBeNull()
    expect(byTestId('k-own-status')).toBeNull()
    expect(byTestId('k-unsaved')).toBeNull()
    // The rest of the shell stays: Save still shows that the document has unsaved changes.
    expect((byTestId('k-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks what to do when the file changed on disk under unsaved edits: keep them or load the new file', () => {
    const editor = fakeEditor(store())
    const keepMine = vi.fn(async () => undefined)
    const reopen = vi.fn()
    Object.assign(editor.session, { conflict: true, keepMine, reopen })
    render(app(editor, null))
    expect(byTestId('k-file-changed')?.getAttribute('role')).toBe('alert')
    act(() => byTestId('k-keep-mine')?.click())
    expect(keepMine).toHaveBeenCalledTimes(1)
    act(() => byTestId('k-reload')?.click())
    expect(reopen).toHaveBeenCalledTimes(1)
    act(() => roots.pop()?.unmount())

    // A kit that asks in its own way turns the frame's question off; without a conflict there is none.
    render(
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={[]} fileChangedBar={false}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    expect(byTestId('k-file-changed')).toBeNull()
    act(() => roots.pop()?.unmount())
    Object.assign(editor.session, { conflict: false })
    render(app(editor, null))
    expect(byTestId('k-file-changed')).toBeNull()
  })

  it("runs no hidden command's shortcut, and leaves its key to a host button", () => {
    const closeAll = { ...command('file.closeAll', ['File']), shortcut: 'Cmd+Alt+W' }
    const press = () =>
      act(() => {
        document.querySelector('.kui-app')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, ctrlKey: true, altKey: true, bubbles: true }))
      })
    const shell = (editor: KitEditor, hidden?: (id: string) => boolean) => (
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={[]} hiddenCommands={hidden}>
          {null}
        </EditorFrame>
      </KitEditorProvider>
    )
    // Not hidden, the key runs the command.
    const shown = fakeEditor(store(), [...COMMANDS, closeAll])
    render(shell(shown))
    press()
    expect(shown.run).toHaveBeenCalledWith('file.closeAll', {})
    act(() => roots.pop()?.unmount())

    const hidden = fakeEditor(store(), [...COMMANDS, closeAll])
    render(shell(hidden, (id) => id === 'file.closeAll'))
    press()
    expect(hidden.run).not.toHaveBeenCalled()
    act(() => roots.pop()?.unmount())

    const action = vi.fn()
    const withButton = fakeEditor(store({ add: [{ id: 'close', place: 'action', label: { 'en-US': 'Close' }, shortcut: 'Cmd+Alt+W' }] }, null, action), [...COMMANDS, closeAll])
    render(shell(withButton, (id) => id === 'file.closeAll'))
    press()
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: 'close' }))
    expect(withButton.run).not.toHaveBeenCalled()
  })
})

const RAIL: RailTool[] = [
  { id: 'Brush', label: 'Brush', icon: Brush },
  { id: 'Eraser', label: 'Eraser', icon: Eraser },
  { id: 'Move', label: 'Move', icon: Move },
]

describe('ToolRail', () => {
  it('a disabled tool is greyed and never selected', () => {
    const onSelect = vi.fn()
    render(app(fakeEditor(store({ disable: ['tool:Brush'] })), <ToolRail tools={RAIL} active="Move" onSelect={onSelect} />))
    const brush = byTestId('k-tool-Brush') as HTMLButtonElement
    expect(brush.disabled).toBe(true)
    click(brush)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a personally hidden tool is not drawn, and stays active when it is', () => {
    const onSelect = vi.fn()
    render(app(fakeEditor(store({ personal: ['tool:Eraser'] })), <ToolRail tools={RAIL} active="Eraser" onSelect={onSelect} />))
    expect(byTestId('k-tool-Eraser')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('moves off an active tool the host denies, to the first allowed one', () => {
    const onSelect = vi.fn()
    const ui = store()
    render(app(fakeEditor(ui), <ToolRail tools={RAIL} active="Brush" onSelect={onSelect} />))
    expect(onSelect).not.toHaveBeenCalled()
    act(() => ui.replace(config({ disable: ['tool:Brush'], hide: ['tool:Eraser'] })))
    expect(onSelect).toHaveBeenCalledWith('Move')
  })

  it('a single-tool slot offers Hide on right-click; a flyout hides in one step', async () => {
    const customize = vi.fn(async () => undefined)
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move },
    ]
    render(app(fakeEditor(store({}, customize)), <ToolRail tools={grouped} active="Move" onSelect={() => undefined} />))
    contextMenu(byTestId('k-tool-Move'))
    await act(async () => byTestId('k-hide-element')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(customize).toHaveBeenLastCalledWith(['tool:Move'])
    contextMenu(byTestId('k-tool-Brush'))
    await act(async () => byTestId('k-tool-hide')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(customize).toHaveBeenLastCalledWith(['tool:Move', 'tool:Brush'])
  })

  it('a slot keeps showing the tool last active in it, however it was chosen (a key, not the rail)', () => {
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move, group: 2 },
    ]
    const editor = fakeEditor(store())
    const root = render(app(editor, <ToolRail tools={grouped} active="Move" onSelect={() => undefined} />))
    // The editor makes Eraser active itself (a letter key), then moves on to Move.
    act(() => root.render(app(editor, <ToolRail tools={grouped} active="Eraser" onSelect={() => undefined} />)))
    act(() => root.render(app(editor, <ToolRail tools={grouped} active="Move" onSelect={() => undefined} />)))
    expect(byTestId('k-tool-Eraser')).not.toBeNull()
    expect(byTestId('k-tool-Brush')).toBeNull()
  })

  it("a slot whose remembered tool the host denies shows the slot's first allowed tool", () => {
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move, group: 2 },
    ]
    render(app(fakeEditor(store({ disable: ['tool:Brush'] })), <ToolRail tools={grouped} active="Move" onSelect={() => undefined} />))
    expect(byTestId('k-tool-Eraser')).not.toBeNull()
    expect(byTestId('k-tool-Brush')).toBeNull()
  })

  it('with slotMemory off, a slot shows its active tool, else its first allowed one (not the one last active)', () => {
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move, group: 2 },
    ]
    const editor = fakeEditor(store())
    const root = render(app(editor, <ToolRail tools={grouped} active="Eraser" onSelect={() => undefined} slotMemory={false} />))
    expect(byTestId('k-tool-Eraser')).not.toBeNull()
    act(() => root.render(app(editor, <ToolRail tools={grouped} active="Move" onSelect={() => undefined} slotMemory={false} />)))
    expect(byTestId('k-tool-Brush')).not.toBeNull()
    expect(byTestId('k-tool-Eraser')).toBeNull()
  })

  it('a long press opens the flyout after flyoutPressMs, and its release selects nothing', () => {
    vi.useFakeTimers()
    try {
      const grouped: RailTool[] = [
        { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
        { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
        { id: 'Move', label: 'Move', icon: Move, group: 2 },
      ]
      const onSelect = vi.fn()
      render(app(fakeEditor(store()), <ToolRail tools={grouped} active="Move" onSelect={onSelect} flyoutPressMs={350} />))
      const slot = byTestId('k-tool-Brush')!
      const pointer = (type: string) => act(() => slot.dispatchEvent(new MouseEvent(type, { bubbles: true })))
      pointer('pointerdown')
      act(() => vi.advanceTimersByTime(340))
      expect(document.querySelector('.kui-tool-flyout')).toBeNull()
      act(() => vi.advanceTimersByTime(20))
      expect(document.querySelector('.kui-tool-flyout')).not.toBeNull()
      pointer('pointerup')
      pointer('click')
      expect(onSelect).not.toHaveBeenCalled()
      expect(document.querySelector('.kui-tool-flyout')).not.toBeNull()
      // A plain click afterwards still selects the slot's tool.
      pointer('pointerdown')
      pointer('pointerup')
      pointer('click')
      expect(onSelect).toHaveBeenCalledWith('Brush')
    } finally {
      vi.useRealTimers()
    }
  })

  it('only a primary press opens the flyout by holding, and leaving the slot or pressing elsewhere ends the hold', () => {
    vi.useFakeTimers()
    try {
      const grouped: RailTool[] = [
        { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
        { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
        { id: 'Move', label: 'Move', icon: Move, group: 2 },
      ]
      const onSelect = vi.fn()
      render(app(fakeEditor(store()), <ToolRail tools={grouped} active="Move" onSelect={onSelect} flyoutPressMs={350} />))
      const slot = byTestId('k-tool-Brush')!
      const fire = (target: EventTarget, type: string, button = 0) => act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button })))
      // A held secondary or middle button opens nothing.
      fire(slot, 'pointerdown', 1)
      act(() => vi.advanceTimersByTime(500))
      expect(document.querySelector('.kui-tool-flyout')).toBeNull()
      fire(slot, 'pointerup', 1)
      // A long press, then the pointer leaves the slot: a later click on the slot chooses its tool.
      fire(slot, 'pointerdown')
      act(() => vi.advanceTimersByTime(400))
      expect(document.querySelector('.kui-tool-flyout')).not.toBeNull()
      // React makes onPointerLeave from a pointerout toward an element outside the slot.
      act(() => slot.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
      fire(slot, 'click')
      expect(onSelect).toHaveBeenLastCalledWith('Brush')
      // A long press, then a press anywhere else: the next click on the slot chooses its tool.
      onSelect.mockClear()
      fire(slot, 'pointerdown')
      act(() => vi.advanceTimersByTime(400))
      fire(slot, 'pointerup')
      fire(document.body, 'pointerdown')
      fire(slot, 'click')
      expect(onSelect).toHaveBeenLastCalledWith('Brush')
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws a hairline divider between slots whose section differs, none when no tool sets one', () => {
    render(app(fakeEditor(store()), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} />))
    expect(byTestId('k-tool-rail')?.querySelectorAll('.kui-tool-rail-divider')).toHaveLength(0)

    const sectioned: RailTool[] = [
      { id: 'Move', label: 'Move', icon: Move, section: 0 },
      { id: 'Brush', label: 'Brush', icon: Brush, section: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, section: 1 },
    ]
    act(() => roots.pop()?.unmount())
    render(app(fakeEditor(store()), <ToolRail tools={sectioned} active="Move" onSelect={() => undefined} />))
    expect(byTestId('k-tool-rail')?.querySelectorAll('.kui-tool-rail-divider')).toHaveLength(1)
  })

  it('columns={2} lays slots in two columns, preserving order and keeping a section off a divider row', () => {
    const sectioned: RailTool[] = [
      { id: 'Move', label: 'Move', icon: Move, section: 0 },
      { id: 'Brush', label: 'Brush', icon: Brush, section: 0 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, section: 0 },
      { id: 'Hand', label: 'Hand', icon: Move, section: 1 },
    ]
    render(app(fakeEditor(store()), <ToolRail tools={sectioned} active="Move" onSelect={() => undefined} columns={2} />))
    const rail = byTestId('k-tool-rail')
    expect(rail?.getAttribute('data-columns')).toBe('2')
    // One divider (before the second section), never inside the first section's two rows.
    expect(rail?.querySelectorAll('.kui-tool-rail-divider')).toHaveLength(1)
    const ids = [...(rail?.querySelectorAll('[data-kit-ui-id^="tool:"]') ?? [])].map((element) => element.getAttribute('data-kit-ui-id'))
    expect(ids).toEqual(['tool:Move', 'tool:Brush', 'tool:Eraser', 'tool:Hand'])
  })

  it('onColumns heads the rail with a toggle that asks for the other column count, and none without it', () => {
    const onColumns = vi.fn()
    render(app(fakeEditor(store()), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns={2} onColumns={onColumns} />))
    const toggle = byTestId('k-tool-rail-columns') as HTMLElement
    expect(toggle.getAttribute('aria-label')).toBe('railOneColumn')
    expect(byTestId('k-tool-rail')?.firstElementChild).toBe(toggle)
    act(() => toggle.click())
    expect(onColumns).toHaveBeenCalledWith(1)

    act(() => roots.pop()?.unmount())
    render(app(fakeEditor(store()), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns={1} onColumns={onColumns} />))
    expect(byTestId('k-tool-rail')?.getAttribute('data-columns')).toBe('1')
    act(() => (byTestId('k-tool-rail-columns') as HTMLElement).click())
    expect(onColumns).toHaveBeenLastCalledWith(2)

    act(() => roots.pop()?.unmount())
    render(app(fakeEditor(store()), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns={2} />))
    expect(byTestId('k-tool-rail-columns')).toBeNull()
  })

  it('the column toggle is its Kit UI element: a host hides or disables it by its id', () => {
    render(app(fakeEditor(store({ disable: ['control:rail.columns'] })), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns={2} onColumns={() => undefined} columnsUiId="control:rail.columns" />))
    const toggle = byTestId('k-tool-rail-columns') as HTMLButtonElement
    expect(toggle.getAttribute('data-kit-ui-id')).toBe('control:rail.columns')
    expect(toggle.disabled).toBe(true)
    act(() => roots.pop()?.unmount())
    render(app(fakeEditor(store({ hide: ['control:rail.columns'] })), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns={2} onColumns={() => undefined} columnsUiId="control:rail.columns" />))
    expect(byTestId('k-tool-rail-columns')).toBeNull()
  })

  it("opens a first-column slot's flyout beside the whole rail, not the slot (so it cannot cover the second column)", () => {
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move },
    ]
    render(app(fakeEditor(store()), <ToolRail tools={grouped} active="Move" onSelect={() => undefined} columns={2} />))
    const rail = byTestId('k-tool-rail') as HTMLElement
    const firstSlot = rail.querySelector('.kui-tool-slot') as HTMLElement
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ left: 420, right: 500, top: 0, bottom: 400, width: 80, height: 400, x: 420, y: 0, toJSON: () => ({}) } as DOMRect)
    vi.spyOn(firstSlot, 'getBoundingClientRect').mockReturnValue({ left: 420, right: 450, top: 10, bottom: 40, width: 30, height: 30, x: 420, y: 10, toJSON: () => ({}) } as DOMRect)
    contextMenu(byTestId('k-tool-Brush'))
    const flyout = document.querySelector('.kui-tool-flyout') as HTMLElement
    expect(flyout).not.toBeNull()
    expect(parseFloat(flyout.style.left)).toBeGreaterThanOrEqual(500)
  })

  it("'auto' sizes columns from its container's height, not its own content", () => {
    const original = globalThis.ResizeObserver
    let report: (() => void) | null = null
    class StubResizeObserver {
      constructor(callback: () => void) {
        report = callback
      }
      observe() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
    try {
      render(app(fakeEditor(store()), <ToolRail tools={RAIL} active="Move" onSelect={() => undefined} columns="auto" />))
      const rail = byTestId('k-tool-rail') as HTMLElement
      const parent = rail.parentElement as HTMLElement
      // Viewport rects, not clientHeight/offsetTop: this would stay green if the code went back to
      // measuring offsetTop against a parent that is not the rail's offsetParent.
      vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect)

      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({ bottom: 540 } as DOMRect) // 40px of room
      act(() => report?.())
      expect(rail.getAttribute('data-columns')).toBe('2')

      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({ bottom: 4500 } as DOMRect) // 4000px of room
      act(() => report?.())
      expect(rail.getAttribute('data-columns')).toBe('1')
    } finally {
      globalThis.ResizeObserver = original
    }
  })
})

describe('a plain shortcut the list of what can run calls disabled', () => {
  it('is decided by the engine in the order of the input, and not asked when no answer could let it run', async () => {
    const commands = [{ ...command('edit.delete', ['Edit']), shortcut: 'Delete' } as KitCommand]
    let engineCould = true
    const runWhenEnabled = vi.fn(async () => null)
    const run = vi.fn(async () => null)
    const editor = { ...fakeEditor(store(), commands), enabled: () => false, enabledByEngine: () => engineCould, runWhenEnabled, run }
    render(app(editor, null))
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      document.querySelector('.kui-app')?.dispatchEvent(event)
      return event
    }
    let pressed!: KeyboardEvent
    await act(async () => void (pressed = press()))
    expect(runWhenEnabled).toHaveBeenCalledWith('edit.delete')
    // Run there, in the order of the input, not here after the engine answered.
    expect(run).not.toHaveBeenCalled()
    expect(pressed.defaultPrevented).toBe(true)
    engineCould = false
    runWhenEnabled.mockClear()
    await act(async () => void press())
    expect(runWhenEnabled).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves a character typed into the text sink to the text', async () => {
    const commands = [{ ...command('mark.put', ['Edit']), shortcut: 'Shift+0' } as KitCommand]
    const runWhenEnabled = vi.fn(async () => null)
    const run = vi.fn(async () => null)
    const editor = { ...fakeEditor(store(), commands), enabled: () => false, enabledByEngine: () => true, runWhenEnabled, run }
    render(app(editor, <textarea className="kui-text-sink" data-testid="sink" />))
    const typed = new KeyboardEvent('keydown', { key: ')', code: 'Digit0', shiftKey: true, bubbles: true, cancelable: true })
    await act(async () => void byTestId('sink')?.dispatchEvent(typed))
    expect(typed.defaultPrevented).toBe(false)
    expect(runWhenEnabled).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('CommandButton', () => {
  it('a command the editor cannot run stays disabled even when the kit says enabled', () => {
    const editor = { ...fakeEditor(store({ disable: ['command:x'] })), enabled: () => false }
    render(app(editor, <CommandButton command="x" disabled={false} />))
    expect((byTestId('k-cmd-x') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ToolButton', () => {
  it('a denied tool stays disabled even when the kit says enabled, and is not selected', () => {
    const select = vi.fn()
    const tools = { active: 'Move', select } as unknown as KitTools
    render(app(fakeEditor(store({ disable: ['tool:Brush'] })), <ToolButton tool="Brush" label="Brush" disabled={false} />, tools))
    const button = byTestId('k-tool-Brush') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    click(button)
    expect(select).not.toHaveBeenCalled()
  })
})

describe('engine tools', () => {
  const info = (id: string): EngineToolInfo => ({ id, label: id, shortcut: null, icon: id, group: 0 })
  const ENGINE_TOOLS = [info('select'), info('pen'), info('type')]
  const CHANGE: KitChange = { revision: 0, damage: null }
  const idle = { requests: [], overlays: [], cursor: '', busy: false, wantsText: false }

  /** An engine whose `toolState` answers `switchTo`'s request, recording the tools it was told to select. */
  function engine(switchTo: string | null = null) {
    const selected: string[] = []
    const tool = vi.fn(async (name: string, args: unknown[] = []) => {
      if (name === 'tools') return ENGINE_TOOLS
      if (name === 'selectTool') selected.push(args[0] as string)
      if (name === 'toolState' && switchTo) return { ...idle, requests: [{ kind: 'switchTool', id: switchTo }] }
      return idle
    })
    return { tool: tool as never, selected }
  }

  let tools!: KitTools
  /** A kit's editor: it makes its tools, then mounts the provider with them. */
  function Kit({ editor, tool, ready, initial }: { editor: KitEditor; tool: never; ready: boolean; initial: string }) {
    tools = useEngineTools(tool, ready, CHANGE, { initial })
    return <KitEditorProvider editor={editor} tools={tools}>{null}</KitEditorProvider>
  }

  async function open(ui: UiStore, initial: string, switchTo: string | null = null) {
    const fake = engine(switchTo)
    const editor = fakeEditor(ui)
    const root = render(<Kit editor={editor} tool={fake.tool} ready={false} initial={initial} />)
    await act(async () => root.render(<Kit editor={editor} tool={fake.tool} ready initial={initial} />))
    return fake
  }

  it('never starts on a tool the host denies', async () => {
    const fake = await open(store({ disable: ['tool:select'] }), 'select')
    expect(tools.active).not.toBe('select')
    expect(fake.selected).not.toContain('select')
  })

  it('refuses a denied tool chosen by the editor or asked for by the engine', async () => {
    const fake = await open(store({ hide: ['tool:pen'] }), 'select', 'pen')
    act(() => tools.select('pen'))
    expect(tools.active).toBe('select')
    await act(async () => tools.refresh())
    expect(tools.active).toBe('select')
    expect(fake.selected).not.toContain('pen')
  })

  it('moves off the active tool when the host denies it, to the first allowed one', async () => {
    const ui = store()
    const fake = await open(ui, 'pen')
    expect(tools.active).toBe('pen')
    await act(async () => ui.replace(config({ disable: ['tool:pen', 'tool:select'] })))
    expect(tools.active).toBe('type')
    expect(fake.selected.at(-1)).toBe('type')
  })

  it('falls back to the hand tool when no engine tool is allowed', async () => {
    const ui = store()
    await open(ui, 'pen')
    await act(async () => ui.replace(config({ disable: ['tool:select', 'tool:pen', 'tool:type'] })))
    expect(tools.active).toBe('Hand')
    expect(tools.canvasTool.id).toBe('Hand')
  })
})

describe('ui/elements', () => {
  it('answers from the engine before the editor has loaded its commands', async () => {
    const handlers = new Map<string, () => unknown>()
    const editor = fakeEditor(store(), [])
    const engineCommands = [command('filter.blur', ['Filter', 'Blur'])]
    Object.assign(editor.session, { commands: async () => engineCommands, tool: async (name: string) => (name === 'tools' ? [{ id: 'Brush', label: 'Brush', shortcut: null, icon: 'brush', group: 0 }] : null) })
    Object.assign(editor.host, { peer: { handle: (method: string, handler: () => unknown) => handlers.set(method, handler) } })
    const tools = { tools: [], active: 'Brush', select: () => undefined } as unknown as KitTools
    render(<KitEditorProvider editor={editor} tools={tools}>{null}</KitEditorProvider>)
    const elements = (await handlers.get('ui/elements')?.()) as Array<{ id: string }>
    expect(elements.map((element) => element.id)).toEqual(expect.arrayContaining(['menu:Filter', 'menu:Filter/Blur', 'command:filter.blur', 'tool:Brush']))
  })
})

describe('EditorFrame ribbon tabs', () => {
  const tabs: FrameTab[] = [
    { id: 'home', label: 'Home', ribbon: <div data-testid="ribbon-content" /> },
    { id: 'insert', label: 'Insert', ribbon: <div data-testid="ribbon-content" /> },
  ]

  it('moves off a hidden active tab', () => {
    const onTab = vi.fn()
    render(
      <KitEditorProvider editor={fakeEditor(store({ hide: ['tab:insert'] }), COMMANDS, {}, 'classic')}>
        <EditorFrame tabs={tabs} tab="insert" onTab={onTab}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    expect(onTab).toHaveBeenCalledWith('home')
    expect(byTestId('ribbon-tab-home')).not.toBeNull()
    expect(byTestId('ribbon-tab-insert')).toBeNull()
  })

  it('draws no ribbon content when every tab is hidden', () => {
    render(
      <KitEditorProvider editor={fakeEditor(store({ hide: ['tab:*'] }), COMMANDS, {}, 'classic')}>
        <EditorFrame tabs={tabs} tab="insert" onTab={() => undefined}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    expect(byTestId('ribbon-content')).toBeNull()
  })
})

describe('Hide', () => {
  it('keeps a hide chosen on an element and stops drawing it', async () => {
    const customize = vi.fn(async () => undefined)
    render(app(fakeEditor(store({}, customize)), <CommandButton command="x" />))
    contextMenu(byTestId('k-cmd-x'))
    await act(async () => byTestId('k-hide-element')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(customize).toHaveBeenCalledWith(['command:x'])
    expect(byTestId('k-cmd-x')).toBeNull()
  })

  it('says when the host could not keep it', async () => {
    const customize = vi.fn(async () => {
      throw new Error('no room')
    })
    render(app(fakeEditor(store({}, customize)), <CommandButton command="x" />))
    contextMenu(byTestId('k-cmd-x'))
    await act(async () => byTestId('k-hide-element')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('customizeFailed')
  })

  it('closes the Hide menu on Escape', () => {
    render(app(fakeEditor(store({}, async () => undefined)), <CommandButton command="x" />))
    contextMenu(byTestId('k-cmd-x'))
    expect(byTestId('k-hide-element')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(byTestId('k-hide-element')).toBeNull()
  })

  it('keeps More drawn when the person hid it', () => {
    render(app(fakeEditor(store({ personal: ['action:more', 'action:save'] }, async () => undefined)), null))
    expect(byTestId('k-more')).not.toBeNull()
    expect(byTestId('k-save')).toBeNull()
  })

  it('offers neither Customize nor Hide for a kit that does not declare its UI', () => {
    const grouped: RailTool[] = [
      { id: 'Brush', label: 'Brush', icon: Brush, group: 1 },
      { id: 'Eraser', label: 'Eraser', icon: Eraser, group: 1 },
      { id: 'Move', label: 'Move', icon: Move },
    ]
    const editor = fakeEditor(store({}, async () => undefined), COMMANDS, null)
    render(
      app(
        editor,
        <>
          <CommandButton command="x" />
          <ToolRail tools={grouped} active="Move" onSelect={() => undefined} />
        </>,
      ),
    )
    expect(byTestId('k-more')).toBeNull()
    contextMenu(byTestId('k-cmd-x'))
    expect(byTestId('k-hide-element')).toBeNull()
    contextMenu(byTestId('k-tool-Move'))
    expect(byTestId('k-hide-element')).toBeNull()
    contextMenu(byTestId('k-tool-Brush'))
    expect(byTestId('k-tool-Eraser')).not.toBeNull()
    expect(byTestId('k-tool-hide')).toBeNull()
  })

  it('a kit right-click handler still runs without personal hides', () => {
    const onContextMenu = vi.fn()
    render(app(fakeEditor(store()), <CommandButton command="x" onContextMenu={onContextMenu} />))
    contextMenu(byTestId('k-cmd-x'))
    expect(onContextMenu).toHaveBeenCalled()
  })
})

describe('useKitEditorState', () => {
  it('refuses a query that edits when the host denies it, and answers read-only ones', async () => {
    const edits = command('fill', ['Edit'])
    const reads = { ...command('format.state', ['Format']), mutates: false }
    const execute = vi.fn(async () => '{"ok":true}')
    const session = { doc: { commands: async () => [edits, reads], disabledCommands: async () => [], execute }, change: { revision: 0 } } as unknown as KitSession<unknown>
    const host = { ui: store({ disable: ['command:fill', 'command:format.state'] }) } as unknown as HostConnection
    let editor!: KitEditor
    function Probe() {
      editor = useKitEditorState(session, host, (key) => key, 'k')
      return null
    }
    render(<Probe />)
    await act(async () => undefined)
    expect(await editor.query('fill')).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(await editor.query('format.state')).toEqual({ ok: true })
  })

  it("reports a failed command through the editor's report, instead of a toast", async () => {
    const run = vi.fn(async () => {
      throw new Error('the engine refused')
    })
    const session = { doc: { commands: async () => [command('fill', ['Edit'])], disabledCommands: async () => [] }, change: { revision: 0 }, run } as unknown as KitSession<unknown>
    const host = { ui: store() } as unknown as HostConnection
    const report = vi.fn()
    let editor!: KitEditor
    function Probe() {
      editor = useKitEditorState(session, host, (key) => key, 'k', undefined, undefined, { report })
      return <Toaster />
    }
    render(<Probe />)
    await act(async () => undefined)
    await act(async () => void (await editor.run('fill', {})))
    expect(report).toHaveBeenCalledWith('commandFailed', expect.objectContaining({ message: 'the engine refused' }))
    expect(container.textContent).not.toContain('commandFailed')
  })

  it('refuses a denied command instead of asking for its values', async () => {
    const needs = command('fill', ['Edit'], { color: { type: 'string', required: true } })
    const ui = store({ disable: ['command:fill'] })
    const run = vi.fn(async (id: string) => {
      throw notAllowed(id)
    })
    const session = { doc: { commands: async () => [needs], disabledCommands: async () => [] }, change: { revision: 0 }, run } as unknown as KitSession<unknown>
    const host = { ui } as unknown as HostConnection
    let editor!: KitEditor
    function Probe() {
      editor = useKitEditorState(session, host, (key) => key, 'k')
      return <Toaster />
    }
    render(<Probe />)
    await act(async () => undefined)
    await act(async () => void (await editor.run('fill')))
    expect(editor.dialog).toBeNull()
    expect(run).toHaveBeenCalled()
    await act(async () => editor.ask('fill'))
    expect(editor.dialog).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('commandFailed')
  })
})

describe('a kit’s own undo history (KitEditorOptions.history)', () => {
  /** A history the test drives: one step to undo, then none. */
  function ownHistory() {
    const listeners = new Set<() => void>()
    const state = { undo: 1, redo: 0 }
    const changed = () => listeners.forEach((listener) => listener())
    return {
      state,
      changed,
      history: {
        canUndo: () => state.undo > 0,
        canRedo: () => state.redo > 0,
        undo: vi.fn(async () => {
          if (state.undo === 0) return false
          state.undo -= 1
          state.redo += 1
          changed()
          return true
        }),
        redo: vi.fn(() => false),
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    }
  }

  function mounted(history: ReturnType<typeof ownHistory>['history'], ui = store()) {
    const run = vi.fn(async () => '{}')
    // The engine has nothing to undo and says so; the kit's history does.
    const commands = [command('edit.undo', ['Edit']), command('edit.redo', ['Edit']), command('x', ['Edit'])]
    const session = {
      doc: { info: { canUndo: false, canRedo: false, dirty: false, revision: 1 }, commands: async () => commands, disabledCommands: async () => ['edit.undo', 'edit.redo'] },
      change: { revision: 0 },
      dirty: false,
      saving: false,
      editedBy: null,
      run,
    } as unknown as KitSession<unknown>
    const host = { ui, kit: { id: 'kit.test', version: '1' }, display: 'menus', init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration: {}, peer: { handle() {} } } as unknown as HostConnection
    let editor!: KitEditor
    function Probe() {
      editor = useKitEditorState(session, host, (key) => key, 'k', undefined, undefined, { history })
      return (
        <KitEditorProvider editor={editor}>
          <EditorFrame tabs={[]}>{null}</EditorFrame>
        </KitEditorProvider>
      )
    }
    render(<Probe />)
    return { run, editor: () => editor }
  }

  it('shows and runs the kit’s history in the frame’s Undo and Redo, not the engine’s', async () => {
    const own = ownHistory()
    const { run, editor } = mounted(own.history)
    await act(async () => undefined)
    expect((byTestId('k-undo') as HTMLButtonElement).disabled).toBe(false)
    expect((byTestId('k-redo') as HTMLButtonElement).disabled).toBe(true)
    expect(editor().enabled('edit.undo')).toBe(true)
    await act(async () => click(byTestId('k-undo')))
    expect(own.history.undo).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    // The history said it changed: the frame follows.
    expect((byTestId('k-undo') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('k-redo') as HTMLButtonElement).disabled).toBe(false)
    // Menus and shortcuts reach it through `run` as well; other commands still go to the engine.
    expect(await act(async () => editor().run('edit.undo', {}))).toBe(JSON.stringify({ done: false }))
    await act(async () => void (await editor().run('x', {})))
    expect(run).toHaveBeenCalledWith('x', {})
  })

  it('stays under the host’s configuration', async () => {
    const own = ownHistory()
    const { editor } = mounted(own.history, store({ disable: ['command:edit.undo'] }))
    await act(async () => undefined)
    expect((byTestId('k-undo') as HTMLButtonElement).disabled).toBe(true)
    expect(editor().enabled('edit.undo')).toBe(false)
    expect(await act(async () => editor().run('edit.undo', {}))).toBeNull()
    expect(own.history.undo).not.toHaveBeenCalled()
  })
})

describe('the shell while a dialog is open', () => {
  it('leaves keys pressed in a dialog to the dialog: no editor key, no command shortcut, no save', () => {
    const editor = fakeEditor(store(), [{ ...command('x', ['Edit']), shortcut: 'K' } as KitCommand])
    const keys = vi.fn(() => true)
    const shell = (dialog: boolean) => (
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={[]} onKeyDown={keys}>
          {dialog ? (
            <Dialog title="Name" onClose={() => undefined} actions={<button type="button" data-testid="ok">OK</button>}>
              {null}
            </Dialog>
          ) : null}
        </EditorFrame>
      </KitEditorProvider>
    )
    const root = render(shell(true))
    const press = (target: Element | null, init: KeyboardEventInit) =>
      act(() => {
        target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      })
    press(byTestId('ok'), { key: 'k' })
    press(byTestId('ok'), { key: '`' })
    press(byTestId('ok'), { key: 's', metaKey: true, ctrlKey: true })
    expect(keys).not.toHaveBeenCalled()
    expect(editor.run).not.toHaveBeenCalled()
    expect(editor.save).not.toHaveBeenCalled()
    act(() => root.render(shell(false)))
    press(document.querySelector('.kui-app'), { key: '`' })
    expect(keys).toHaveBeenCalledTimes(1)
  })
})

describe('the shell while a non-modal dialog is open', () => {
  it("gives the editor its keys beside a dialog opened with modal={false}, but not the dialog's own keys", () => {
    const editor = fakeEditor(store(), [])
    const keys = vi.fn(() => true)
    const shell = (modal: boolean | undefined) => (
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={[]} onKeyDown={keys}>
          <PreviewDialog title="Opacity" modal={modal} onOk={() => undefined} onCancel={() => undefined}>
            {null}
          </PreviewDialog>
        </EditorFrame>
      </KitEditorProvider>
    )
    const press = (target: Element | null, init: KeyboardEventInit) =>
      act(() => {
        target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      })
    const root = render(shell(undefined))
    press(document.querySelector('.kui-app'), { key: '`' })
    expect(keys).not.toHaveBeenCalled()
    act(() => root.render(shell(false)))
    press(document.querySelector('.kui-app'), { key: '`' })
    expect(keys).toHaveBeenCalledTimes(1)
    press(document.querySelector('[data-testid="preview-dialog-ok"]'), { key: 'k' })
    expect(keys).toHaveBeenCalledTimes(1)
  })
})

describe('the shell and a focused button', () => {
  it('leaves Space and Enter to a focused button or menu row, and gives the editor every other key', () => {
    const editor = fakeEditor(store(), [])
    const keys = vi.fn(() => true)
    render(
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={[]} onKeyDown={keys}>
          <button type="button" data-testid="lock">
            Lock
          </button>
          <div role="menuitem" tabIndex={0} data-testid="row">
            Row
          </div>
          <div tabIndex={0} data-testid="plain">
            Plain
          </div>
        </EditorFrame>
      </KitEditorProvider>,
    )
    const press = (target: Element | null, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      act(() => {
        target?.dispatchEvent(event)
      })
      return event.defaultPrevented
    }
    // The button activates itself: the editor's Space (play) and Enter keys do not run.
    expect(press(byTestId('lock'), { key: ' ' })).toBe(false)
    expect(press(byTestId('lock'), { key: 'Enter' })).toBe(false)
    expect(press(byTestId('row'), { key: 'Enter' })).toBe(false)
    expect(keys).not.toHaveBeenCalled()
    // With a modifier, or any other key, or away from a button, the editor's keys still run.
    press(byTestId('lock'), { key: ' ', shiftKey: true })
    press(byTestId('lock'), { key: 'k' })
    expect(press(byTestId('plain'), { key: ' ' })).toBe(true)
    expect(keys).toHaveBeenCalledTimes(3)
  })
})

describe('EditorFrame onStatusClick', () => {
  it('hears a click anywhere on the status bar but on its buttons', () => {
    const onStatusClick = vi.fn()
    render(
      <KitEditorProvider editor={fakeEditor(store())}>
        <EditorFrame tabs={[]} status={<span data-testid="k-message">Said</span>} statusEnd={<button type="button" data-testid="k-cancel">Cancel</button>} onStatusClick={onStatusClick}>
          {null}
        </EditorFrame>
      </KitEditorProvider>,
    )
    const click = (element: Element | null) => act(() => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    click(byTestId('k-message'))
    click(document.querySelector('.kui-status-spacer'))
    expect(onStatusClick).toHaveBeenCalledTimes(2)
    click(byTestId('k-cancel'))
    expect(onStatusClick).toHaveBeenCalledTimes(2)
  })

  it('leaves the status bar without a click handler when unset', () => {
    render(app(fakeEditor(store()), null))
    act(() => void document.querySelector('.kui-status-bar')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.querySelector('.kui-status-bar')).not.toBeNull()
  })
})

describe('the status line says who made the last change', () => {
  function edited(editedBy: unknown, locale = 'en-US') {
    const editor = fakeEditor(store())
    return { ...editor, session: { ...editor.session, editedBy }, t: createStrings(KIT_UI_CATALOGS, locale) } as unknown as KitEditor
  }

  it('says the app edited it for a host’s change, with the host feature as its title, and the agent for an agent’s', () => {
    render(app(edited({ by: 'system', originLabel: 'emailsync' }), null))
    const status = document.querySelector('.kui-status-bar')!
    expect(status.textContent).toContain('Edited by the app')
    expect(status.textContent).not.toContain('agent')
    expect(byTestId('k-agent-edited')).toBeNull()
    expect(byTestId('k-host-edited')?.getAttribute('title')).toBe('emailsync')
    act(() => roots.pop()!.unmount())
    container.remove()

    render(app(edited({ by: 'agent' }), null))
    expect(byTestId('k-agent-edited')?.textContent).toBe('Edited by the agent')
    expect(byTestId('k-host-edited')).toBeNull()
  })

  it('says it in the editor’s language, and nothing after the person’s own edit', () => {
    render(app(edited({ by: 'system', originLabel: 'host' }, 'zh-CN'), null))
    expect(byTestId('k-host-edited')?.textContent).toBe('由应用编辑')
    act(() => roots.pop()!.unmount())
    container.remove()
    render(app(edited(null), null))
    expect(byTestId('k-host-edited')).toBeNull()
    expect(byTestId('k-agent-edited')).toBeNull()
  })
})

describe('the text sink and command shortcuts', () => {
  it('runs no shortcut for a key the sink already gave the tool, and still runs the others', () => {
    const remove = { ...command('edit.delete', ['Edit']), shortcut: 'Delete' }
    const bold = { ...command('format.bold', ['Format']), shortcut: 'Cmd+B' }
    const editor = fakeEditor(store(), [remove, bold])
    render(app(editor, <TextSink active onText={() => undefined} onKey={(event) => event.key === 'Delete'} />))
    const sink = byTestId('kit-text-sink')
    act(() => void sink?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })))
    expect(editor.run).not.toHaveBeenCalled()
    act(() => void sink?.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })))
    expect(editor.run).toHaveBeenCalledWith('format.bold', {})
  })

  it('gives every key of an input method composition to the input method: no command, shortcut or tool key', () => {
    const remove = { ...command('edit.delete', ['Edit']), shortcut: 'Backspace' }
    const bold = { ...command('format.bold', ['Format']), shortcut: 'Cmd+B' }
    const confirm = { ...command('edit.confirm', ['Edit']), shortcut: 'Enter' }
    const editor = fakeEditor(store(), [remove, bold, confirm])
    const onKey = vi.fn((event: { key: string }) => event.key === 'Delete')
    render(app(editor, <TextSink active onText={() => undefined} onKey={onKey} />))
    const sink = byTestId('kit-text-sink')!
    const shell = document.querySelector('.kui-app')!
    // Composing (isComposing), and the key that starts or ends a composition (keyCode 229, "Process").
    const composing: KeyboardEventInit[] = [
      { key: 'Backspace', isComposing: true },
      { key: 'Enter', isComposing: true },
      { key: 'b', code: 'KeyB', metaKey: true, ctrlKey: true, isComposing: true },
      { key: 'Process', code: 'Backspace' },
    ]
    const pressed: KeyboardEvent[] = []
    for (const target of [sink, shell]) {
      for (const init of composing) {
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
        pressed.push(event)
        act(() => void target.dispatchEvent(event))
      }
      // keyCode 229 has no init field: Chrome and Safari set it on composition keys.
      const process = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      Object.defineProperty(process, 'keyCode', { value: 229 })
      pressed.push(process)
      act(() => void target.dispatchEvent(process))
    }
    expect(editor.run).not.toHaveBeenCalled()
    expect(onKey).not.toHaveBeenCalled()
    // The input method keeps the key's default (it edits the composition).
    expect(pressed.filter((event) => event.defaultPrevented)).toEqual([])
    // Once the composition ends, the same keys are the editor's again.
    act(() => void sink.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })))
    expect(editor.run).toHaveBeenCalledWith('format.bold', {})
  })
})
