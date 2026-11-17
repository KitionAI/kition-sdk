// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TypeIcon as Type } from '@kition/tessera-icons/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandButton, CommandGroupButtons, CommandTab, KitEditorProvider, ToolButton, type KitEditor, type KitTools } from '../editor'
import { RibbonButton, RibbonFitContext, RibbonGroup } from '@kition/tessera-ui'
import { DrawingFormatGroup, DrawingInsertGroup } from '../drawing'
import { ChartInsertMenu } from '../chart'
import { InkGroup } from '../ink'
import { EMPTY_UI_CONFIG, type UiConfig } from '../uiConfig'
import { createUiStore } from '../uiStore'
import type { KitCommand } from '../engine/kitModule'
import { EditorFrame, FrameChrome, ribbonFitAt, ribbonFitSteps, useFrameDisplay, useFrameMode, type EditorFrameProps } from './EditorFrame'
import { catalogTabs, commandMenuTabs, type FrameTab } from './menus'
import type { KitDisplay } from './modes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = (id: string, menu: string[]): KitCommand => ({ id, title: id, description: null, group: '', mutates: true, enabled: true, menu, shortcut: null })
const COMMANDS = [command('edit.undo', ['Edit']), command('edit.redo', ['Edit']), command('edit.paste', ['Edit']), command('x', ['Home'])]

/** Resize observers by what they watch: the test resizes the frame's root only. */
let observers: Array<{ target: Element; callback: ResizeObserverCallback }> = []
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observers.push({ target, callback: this.callback })
  }
  unobserve() {}
  disconnect() {}
}
function resizeFrame(width: number) {
  act(() => {
    for (const { target, callback } of observers) if (target.classList.contains('kui-app')) callback([{ contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver)
  })
}

let container: HTMLDivElement
let roots: Root[] = []
beforeEach(() => localStorage.clear())
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  observers = []
  container?.remove()
  vi.unstubAllGlobals()
})

function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(node))
}

function fakeEditor({ config = {}, display = 'line', readOnly = false, agent = false }: { config?: Partial<UiConfig>; display?: KitDisplay | null; readOnly?: boolean; agent?: boolean } = {}) {
  const ui = createUiStore({ ...EMPTY_UI_CONFIG, ...config }, null, () => undefined)
  return {
    session: { doc: { info: { canUndo: true, canRedo: false, dirty: false, revision: 1 } }, dirty: false, saving: false, editedBy: null },
    host: { ui, kit: { id: 'kit.test', version: '1' }, display, readOnly, init: { locale: 'en-US', capabilities: agent ? ['agent'] : [], document: { path: 'a' } }, declaration: null, peer: { handle() {} }, openAgent: vi.fn() },
    commands: COMMANDS,
    canUndo: true,
    canRedo: false,
    byId: new Map(COMMANDS.map((item) => [item.id, item])),
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

const HOME: FrameTab = {
  id: 'home',
  label: 'Home',
  ribbon: (
    <>
      <RibbonGroup label="Clipboard">
        <RibbonButton label="Paste" primary />
        <RibbonButton label="Cut" />
      </RibbonGroup>
      <RibbonGroup label="Font" icon={Type}>
        <CommandButton command="x" />
      </RibbonGroup>
    </>
  ),
}
const VIEW: FrameTab = {
  id: 'view',
  label: 'View',
  view: true,
  ribbon: (
    <RibbonGroup label="Zoom">
      <RibbonButton label="Fit" primary />
    </RibbonGroup>
  ),
}
const EDIT_MENU = catalogTabs([{ path: ['Edit'], label: 'Undo', command: 'edit.undo' }])

function frame(editor: KitEditor, tabs: readonly FrameTab[] = [HOME, VIEW], props: Partial<EditorFrameProps> = {}) {
  return (
    <KitEditorProvider editor={editor}>
      <EditorFrame tabs={tabs} {...props}>
        <div data-testid="body" />
      </EditorFrame>
    </KitEditorProvider>
  )
}

const app = () => document.querySelector('.kui-app') as HTMLElement
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (element: Element | null) => act(() => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const press = (init: KeyboardEventInit) => act(() => void app().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })))
const labels = (selector: string) => [...document.querySelectorAll(`${selector} button[aria-label]`)].map((button) => button.getAttribute('aria-label'))

describe('EditorFrame modes', () => {
  it("opens in the kit's default mode and keeps the person's choice per kit", () => {
    render(frame(fakeEditor({ display: 'line' })))
    expect(app().dataset.mode).toBe('line')
    expect(labels('.kui-line-inline')).toEqual(['Paste'])
    // The chevron's name is the editor's string ("More: Clipboard").
    expect(byTestId('kui-line-more-Clipboard')?.getAttribute('aria-label')).toBe('lineMore')
    click(byTestId('k-mode'))
    click(byTestId('k-mode-classic'))
    expect(app().dataset.mode).toBe('classic')
    expect(labels('.kui-ribbon-panel')).toEqual(['Paste', 'Cut', 'x'])
    expect(localStorage.getItem('kui.mode.kit.test')).toBe('classic')
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ display: 'line' })))
    expect(app().dataset.mode).toBe('classic')
  })

  it('offers only the modes the host allows, and opens in its preset', () => {
    localStorage.setItem('kui.mode.kit.test', 'line')
    render(frame(fakeEditor({ config: { modes: { allowed: ['menus', 'classic'], default: 'classic' } } })))
    expect(app().dataset.mode).toBe('classic')
    click(byTestId('k-mode'))
    expect(['menus', 'line', 'classic', 'focus'].map((mode) => byTestId(`k-mode-${mode}`) !== null)).toEqual([true, false, true, false])
  })

  it('draws no mode button when the host allows one mode or hides the button', () => {
    render(frame(fakeEditor({ config: { modes: { allowed: ['classic'], default: null } } })))
    expect(byTestId('k-mode')).toBeNull()
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ config: { hide: ['action:mode'] } })))
    expect(byTestId('k-mode')).toBeNull()
    press({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
    expect(app().dataset.mode).toBe('line')
  })

  it('steps down to fit the window and back, marking the step on the mode button', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(frame(fakeEditor({ display: 'line' })))
    resizeFrame(600)
    expect(app().dataset.mode).toBe('menus')
    expect(app().dataset.chosenMode).toBe('line')
    expect(byTestId('k-mode')?.dataset.stepped).toBe('true')
    resizeFrame(1024)
    expect(app().dataset.mode).toBe('line')
    expect(byTestId('k-mode')?.dataset.stepped).toBeUndefined()
  })
})

describe('EditorFrame tabs', () => {
  it('opens a ribbon tab as a drop-down panel and a menu tab as a menu in Menus', () => {
    const editor = fakeEditor({ display: 'menus' })
    render(frame(editor, [HOME, ...EDIT_MENU]))
    expect(document.querySelector('.kui-line-panel, .kui-ribbon-body')).toBeNull()
    click(byTestId('ribbon-tab-home'))
    expect(labels('[data-testid="ribbon-drop-home"]')).toEqual(['Paste', 'Cut', 'x'])
    click(byTestId('k-cmd-x'))
    expect(editor.run).toHaveBeenCalledWith('x', undefined)
    expect(byTestId('ribbon-drop-home')).toBeNull()
    click(byTestId('k-menu-Edit'))
    expect(document.querySelector('.kui-popover [data-kit-ui-id="command:edit.undo"]')).not.toBeNull()
  })

  it('gives a menu tab without a ribbon one built from its rows', () => {
    // Undo is a row here too; the ribbon leaves it to the top bar.
    const editor = fakeEditor({ display: 'classic' })
    render(frame(editor, catalogTabs([...EDIT_MENU[0].menu!.rows, { path: ['Edit'], label: 'Paste', command: 'edit.paste' }])))
    const button = document.querySelector('.kui-ribbon-panel [data-testid="k-cmd-edit.paste"]') as HTMLElement
    expect(button.closest('[data-kit-ui-id="menu:Edit"]')).not.toBeNull()
    click(button)
    expect(editor.run).toHaveBeenCalledWith('edit.paste')
  })

  it("leaves Undo and Redo out of a generated ribbon while the top bar draws them, and keeps them in the menu", () => {
    const rows = ['undo', 'redo', 'paste'].map((id) => ({ path: ['Edit'], label: id, command: `edit.${id}` }))
    render(frame(fakeEditor({ display: 'classic' }), catalogTabs(rows)))
    expect(document.querySelector('.kui-ribbon-panel [data-testid="k-cmd-edit.undo"], .kui-ribbon-panel [data-testid="k-cmd-edit.redo"]')).toBeNull()
    expect(document.querySelector('.kui-ribbon-panel [data-testid="k-cmd-edit.paste"]')).not.toBeNull()
    expect(byTestId('k-undo')).not.toBeNull()
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ display: 'menus' }), catalogTabs(rows)))
    click(byTestId('k-menu-Edit'))
    expect(document.querySelector('.kui-popover [data-kit-ui-id="command:edit.undo"]')).not.toBeNull()
  })

  it("draws a kit's before action without an icon of its own with a command icon in the ribbon, and none in the menu", () => {
    const onSelect = vi.fn()
    const tabs = catalogTabs([{ path: ['File'], label: 'Export', command: 'file.export' }], { before: { File: [{ label: 'Download', onSelect, testId: 'k-download' }] } })
    render(frame(fakeEditor({ display: 'classic' }), tabs))
    expect(byTestId('k-download')?.querySelector('svg')).not.toBeNull()
    click(byTestId('k-download'))
    expect(onSelect).toHaveBeenCalled()
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ display: 'menus' }), tabs))
    click(byTestId('k-menu-File'))
    expect(document.querySelector('.kui-popover [data-testid="k-download"] svg')).toBeNull()
  })

  it('moves off a hidden active tab, and draws no command area when every tab is hidden', () => {
    const onTab = vi.fn()
    render(frame(fakeEditor({ config: { hide: ['tab:view'] } }), [HOME, VIEW], { tab: 'view', onTab }))
    expect(onTab).toHaveBeenCalledWith('home')
    expect(byTestId('ribbon-tab-view')).toBeNull()
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ config: { hide: ['tab:*'] } })))
    expect(document.querySelector('.kui-line-panel')).toBeNull()
  })

  it('shows a fade and a scroll button on a Menus bar wider than the window, so cut menus stay reachable', () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('kui-menu-bar') ? 800 : 0
    })
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('kui-menu-bar') ? 500 : 0
    })
    try {
      render(frame(fakeEditor({ display: 'menus' }), [HOME, VIEW]))
      const bar = byTestId('k-menu-bar')
      expect(bar?.getAttribute('aria-label')).toBe('menuBar')
      expect(bar?.querySelector('[data-overflow]')?.getAttribute('data-overflow')).toBe('end')
      const end = byTestId('k-menu-bar-scroll-end') as HTMLButtonElement
      expect(end.getAttribute('aria-label')).toBe('menusScrollEnd')
      const panel = bar?.querySelector('.kui-menu-bar') as HTMLElement
      act(() => end.click())
      expect(panel.scrollLeft).toBeGreaterThan(0)
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
    }
  })

  it('watches the tab strip with one observer across renders, so a render during a resize does not observe it again (WebKit ResizeObserver loop)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(frame(fakeEditor({ display: 'line' })))
    const watching = () => observers.filter(({ target }) => target.classList.contains('kui-frame-tabs')).length
    const before = watching()
    expect(before).toBeGreaterThan(0)
    resizeFrame(1000)
    resizeFrame(1100)
    click(byTestId('ribbon-tab-view'))
    expect(watching()).toBe(before)
  })

  it('hides tabs the bar cannot hold whole and lists them under More tabs, so no tab label is cut (U8)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const INSERT: FrameTab = { id: 'insert', label: 'Insert', ribbon: <RibbonGroup label="Shapes"><RibbonButton label="Line" primary /></RibbonGroup> }
    const FORMAT: FrameTab = { id: 'format', label: 'Format', ribbon: <RibbonGroup label="Text"><RibbonButton label="Bold" primary /></RibbonGroup> }
    // The bar holds 200 px; each tab is 60 px wide; the More button takes 32 px and a 2 px gap.
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('kui-frame-tabs') ? 200 : 0
    })
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('kui-ribbon-tab') ? 60 : 0
    })
    try {
      const onTab = vi.fn()
      render(frame(fakeEditor({ display: 'line' }), [HOME, INSERT, FORMAT, VIEW], { tab: 'home', onTab }))
      const shown = (id: string) => !(byTestId(`ribbon-tab-${id}`) as HTMLElement).hidden
      expect(['home', 'insert', 'format', 'view'].map(shown)).toEqual([true, true, false, false])
      expect(byTestId('tabs-scroll-end')).toBeNull()
      const more = byTestId('ribbon-tabs-more') as HTMLButtonElement
      expect(more.getAttribute('aria-label')).toBe('moreTabs')
      click(more)
      expect([...document.querySelectorAll('.kui-popover [role="menuitem"]')].map((item) => item.textContent)).toEqual(['Format', 'View'])
      click(byTestId('ribbon-tabs-more-view'))
      expect(onTab).toHaveBeenCalledWith('view')
      // The selected tab always shows, in its place among the tabs, even when it was cut.
      act(() => roots.pop()?.unmount())
      render(frame(fakeEditor({ display: 'line' }), [HOME, INSERT, FORMAT, VIEW], { tab: 'view', onTab }))
      expect(['home', 'insert', 'format', 'view'].map(shown)).toEqual([true, false, false, true])
      // A bar that holds every tab draws no More button.
      clientWidth.mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('kui-frame-tabs') ? 400 : 0
      })
      act(() => {
        for (const { target, callback } of observers) if (target.classList.contains('kui-frame-tabs')) callback([], {} as ResizeObserver)
      })
      expect(['home', 'insert', 'format', 'view'].map(shown)).toEqual([true, true, true, true])
      expect(byTestId('ribbon-tabs-more')).toBeNull()
    } finally {
      clientWidth.mockRestore()
      offsetWidth.mockRestore()
    }
  })

  it('shows only viewing tabs in a read-only document, opens it in Menus, and draws no rail', () => {
    render(frame(fakeEditor({ display: 'line', readOnly: true }), [HOME, VIEW], { rail: <div data-testid="rail" /> }))
    expect(app().dataset.mode).toBe('menus')
    expect(app().dataset.viewOnly).toBe('true')
    expect(byTestId('ribbon-tab-home')).toBeNull()
    expect(byTestId('ribbon-tab-view')).not.toBeNull()
    expect(byTestId('rail')).toBeNull()
  })
})

describe('EditorFrame Focus and touch', () => {
  it('enters Focus with Cmd+\\, keeping only the body and the Focus bar, and leaves with Escape or Exit', () => {
    const editor = fakeEditor({ display: 'line', agent: true })
    render(frame(editor, [HOME], { rail: <div data-testid="rail" />, panels: <div data-testid="panels" />, status: <span data-testid="status" /> }))
    press({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
    expect(app().dataset.mode).toBe('focus')
    expect([byTestId('k-top-bar'), byTestId('rail'), byTestId('panels'), byTestId('status')]).toEqual([null, null, null, null])
    expect(byTestId('k-focus-bar')).not.toBeNull()
    expect(byTestId('k-focus-ask')).not.toBeNull()
    expect(byTestId('body')).not.toBeNull()
    click(byTestId('k-focus-undo'))
    expect(editor.run).toHaveBeenCalledWith('edit.undo', {})
    press({ key: 'Escape' })
    expect(app().dataset.mode).toBe('line')
    click(byTestId('k-mode'))
    click(byTestId('k-mode-focus'))
    expect(app().dataset.mode).toBe('focus')
    click(byTestId('k-focus-exit'))
    expect(app().dataset.mode).toBe('line')
    expect(localStorage.getItem('kui.mode.kit.test')).toBeNull()
  })

  it('names Exit focus and its key in the Focus bar, and shows the bar in full on entering Focus before it fades', () => {
    vi.useFakeTimers()
    try {
      render(frame(fakeEditor({ display: 'line' })))
      click(byTestId('k-mode'))
      click(byTestId('k-mode-focus'))
      const exit = byTestId('k-focus-exit')
      expect(exit?.textContent).toContain('exitFocus')
      expect(exit?.querySelector('kbd')?.textContent).toBe('Esc')
      expect(byTestId('k-focus-bar')?.hasAttribute('data-fresh')).toBe(true)
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(byTestId('k-focus-bar')?.hasAttribute('data-fresh')).toBe(false)
      const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
      expect(css).toMatch(/\.kui-focus-bar\[data-fresh\][^{]*\{[^}]*opacity:\s*1/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("hides the kit's own bars in FrameChrome in Focus, wherever they sit, and tells the kit the shown mode", () => {
    const seen: Array<string | null> = []
    function Probe() {
      seen.push(useFrameMode())
      return null
    }
    render(
      <KitEditorProvider editor={fakeEditor({ display: 'classic' })}>
        <EditorFrame tabs={[HOME]}>
          <FrameChrome>
            <div data-testid="formula-bar" />
          </FrameChrome>
          <div data-testid="body" />
          <Probe />
          <FrameChrome>
            <div data-testid="sheet-tabs" />
          </FrameChrome>
        </EditorFrame>
      </KitEditorProvider>,
    )
    expect([byTestId('formula-bar'), byTestId('sheet-tabs')].every(Boolean)).toBe(true)
    expect(seen.at(-1)).toBe('classic')
    click(byTestId('k-mode'))
    click(byTestId('k-mode-focus'))
    expect(app().dataset.mode).toBe('focus')
    expect([byTestId('formula-bar'), byTestId('sheet-tabs')]).toEqual([null, null])
    expect(byTestId('body')).not.toBeNull()
    expect(seen.at(-1)).toBe('focus')
    press({ key: 'Escape' })
    expect(byTestId('sheet-tabs')).not.toBeNull()
  })

  it('draws FrameChrome outside a frame, where useFrameMode is null', () => {
    let mode: string | null = 'unset'
    function Probe() {
      mode = useFrameMode()
      return null
    }
    render(
      <FrameChrome>
        <div data-testid="bar" />
        <Probe />
      </FrameChrome>,
    )
    expect(byTestId('bar')).not.toBeNull()
    expect(mode).toBeNull()
  })

  it('keeps the keyboard in the frame when Focus is entered and left with its buttons', () => {
    render(frame(fakeEditor({ display: 'line' })))
    click(byTestId('k-mode'))
    const row = byTestId('k-mode-focus') as HTMLElement
    row.focus()
    click(row)
    expect(app().dataset.mode).toBe('focus')
    // The pressed row is gone; the frame holds the focus, so Escape reaches it.
    expect(app().contains(document.activeElement)).toBe(true)
    act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(app().dataset.mode).toBe('line')
    press({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
    const exit = byTestId('k-focus-exit') as HTMLElement
    exit.focus()
    click(exit)
    expect(app().dataset.mode).toBe('line')
    expect(document.activeElement).toBe(byTestId('k-mode'))
  })

  it("gives Escape in Focus to the kit first, and leaves Focus only on an Escape nothing took", () => {
    // The text tool takes one Escape (it ends the text it was taking), then has nothing to cancel.
    let taking = true
    const toolKey = vi.fn((event: React.KeyboardEvent) => {
      if (taking) event.preventDefault()
      taking = false
    })
    render(
      <KitEditorProvider editor={fakeEditor({ display: 'line' })}>
        <EditorFrame tabs={[HOME]}>
          <textarea className="kui-text-sink" data-testid="sink" onKeyDown={toolKey} />
        </EditorFrame>
      </KitEditorProvider>,
    )
    const sink = byTestId('sink') as HTMLTextAreaElement
    const key = (init: KeyboardEventInit) => act(() => void sink.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })))
    key({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
    expect(app().dataset.mode).toBe('focus')
    key({ key: 'Escape' })
    expect(toolKey).toHaveBeenCalledTimes(1)
    expect(app().dataset.mode).toBe('focus')
    key({ key: 'Escape' })
    expect(toolKey).toHaveBeenCalledTimes(2)
    expect(app().dataset.mode).toBe('line')
  })

  it("takes Mod+\\ in a field, leaves Mod+Shift+F to the kit (Find), and labels the shortcut for the platform", () => {
    render(frame(fakeEditor({ display: 'line' }), [HOME], { options: <input data-testid="field" /> }))
    const field = byTestId('field') as HTMLInputElement
    const key = (init: KeyboardEventInit) => act(() => void field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })))
    key({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
    expect(app().dataset.mode).toBe('focus')
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ display: 'line' })))
    click(byTestId('k-mode'))
    expect(byTestId('k-mode-focus')?.querySelector('kbd')?.textContent).toBe('Ctrl+\\')
    press({ key: 'F', code: 'KeyF', metaKey: true, ctrlKey: true, shiftKey: true })
    expect(app().dataset.mode).toBe('line')
  })

  it('floats the Focus bar at the bottom, faint until hovered or focused, off the content at the top', () => {
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    const bar = rule('.kui-focus-bar')
    expect(bar).toMatch(/bottom:\s*12px/)
    expect(bar).not.toMatch(/\btop:/)
    expect(bar).toMatch(/opacity:\s*0?\.45;/)
    expect(rule('.kui-focus-bar:is(:hover, :focus-within)')).toMatch(/opacity:\s*1/)
  })

  it('sizes for touch on a coarse pointer', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', addEventListener: () => undefined, removeEventListener: () => undefined }))
    render(frame(fakeEditor()))
    expect(app().dataset.density).toBe('touch')
  })
})

describe('EditorFrame Single line content', () => {
  const lineFrame = (tabs: readonly FrameTab[], editor: KitEditor = fakeEditor({ display: 'line' }), tools: KitTools | null = null) => (
    <KitEditorProvider editor={editor} tools={tools}>
      <EditorFrame tabs={tabs}>
        <div />
      </EditorFrame>
    </KitEditorProvider>
  )
  const inline = () => [...document.querySelectorAll('.kui-line-inline button')].map((button) => [button.getAttribute('aria-label'), button.textContent])

  it("runs a command button through the kit's own entry point, and names a tool button's test id", () => {
    const editor = fakeEditor({ display: 'line' })
    const onRun = vi.fn()
    const tools = { active: 'pen', select: vi.fn(), tools: [] } as unknown as KitTools
    const tab: FrameTab = {
      id: 'home',
      label: 'Home',
      ribbon: (
        <RibbonGroup label="Edit">
          <CommandButton command="x" onRun={onRun} primary />
          <ToolButton tool="pen" label="Pen" testId="k-home-pen" primary />
        </RibbonGroup>
      ),
    }
    render(lineFrame([tab], editor, tools))
    click(byTestId('k-cmd-x'))
    expect(onRun).toHaveBeenCalledWith('x')
    expect(editor.run).not.toHaveBeenCalled()
    expect(byTestId('k-home-pen')?.getAttribute('aria-pressed')).toBe('true')
    expect(byTestId('k-home-pen')?.getAttribute('data-kit-ui-id')).toBe('tool:pen')
    click(byTestId('k-home-pen'))
    expect(tools.select).toHaveBeenCalledWith('pen')
  })

  it("shows a command tab's primary commands inline, as icons when they have one", () => {
    render(lineFrame([{ id: 'edit', label: 'Edit', ribbon: <CommandTab menu="Edit" primary={['edit.undo', 'edit.paste']} /> }]))
    // edit.undo reads its verb "undo", edit.paste "paste": icons alone.
    expect(inline()).toEqual([
      ['edit.undo', ''],
      ['edit.paste', ''],
    ])
  })

  it('labels an inline command whose icon is only the fallback', () => {
    render(lineFrame([{ id: 'home', label: 'Home', ribbon: <CommandTab menu="Home" primary={['x']} /> }]))
    // `x` matches no verb, object, or word: the neutral fallback, so the label shows.
    expect(inline()).toEqual([['x', 'x']])
  })

  it("shows a hand-made group's engine buttons inline only where listed", () => {
    const tab: FrameTab = {
      id: 'home',
      label: 'Home',
      ribbon: (
        <RibbonGroup label="Edit">
          <CommandGroupButtons path="Edit" primary={['edit.redo']} />
        </RibbonGroup>
      ),
    }
    render(lineFrame([tab]))
    expect(inline()).toEqual([['edit.redo', '']])
    click(byTestId('kui-line-more-Edit'))
    expect(labels('[data-testid="kui-line-popover-Edit"]')).toEqual(['edit.undo', 'edit.redo', 'edit.paste'])
  })

  it("shows a menu tab's primary rows and actions inline in its generated ribbon", () => {
    const onSelect = vi.fn()
    const onKitCommand = vi.fn()
    const tabs = catalogTabs(
      [
        { path: ['Edit'], label: 'Undo', command: 'edit.undo' },
        { path: ['Edit'], label: 'Paste', command: 'edit.paste' },
        { path: ['Edit', 'More'], label: 'Clear', command: 'kit:clear' },
        { path: ['Edit', 'More'], label: 'Keep', command: 'kit:keep' },
      ],
      { primary: { Edit: ['edit.paste', 'kit:clear'] }, before: { Edit: [{ label: 'Download', onSelect, testId: 'k-download', primary: true }] }, onKitCommand },
    )
    render(lineFrame(tabs))
    // A primary row the top bar does not draw (Redo here was one; X6 leaves it to the top bar).
    expect(labels('.kui-line-inline')).toEqual(['Download', 'Paste', 'Clear'])
    click(document.querySelector('.kui-line-inline [data-kit-ui-id="control:clear"]'))
    expect(onKitCommand).toHaveBeenCalledWith('kit:clear')
  })

  it('passes a primary list through commandMenuTabs', () => {
    const tabs = commandMenuTabs(COMMANDS, { order: ['Edit', 'Home'], primary: { Edit: ['edit.paste'] } })
    expect(tabs.find((tab) => tab.id === 'Edit')?.menu?.primary).toEqual(['edit.paste'])
    expect(tabs.find((tab) => tab.id === 'Home')?.menu?.primary).toBeUndefined()
  })

  it('gives every shared group and every group built from commands an icon, which it shows when collapsed', () => {
    const editor = fakeEditor({ display: 'classic' })
    Object.assign(editor, { query: vi.fn(async () => null) })
    Object.assign(editor.session as object, { change: { revision: 1 } })
    const collapseAll = { size: 'icon' as const, icons: new Set<string>(), collapsed: { has: () => true } as unknown as ReadonlySet<string> }
    render(
      <KitEditorProvider editor={editor}>
        <RibbonFitContext.Provider value={collapseAll}>
          <DrawingInsertGroup testId="k-drawing" />
          <InkGroup testId="k-ink" />
          <DrawingFormatGroup ids={['1']} testId="k-format" />
          <CommandTab menu="Edit" />
        </RibbonFitContext.Provider>
      </KitEditorProvider>,
    )
    const groups = [...document.querySelectorAll<HTMLElement>('.kui-ribbon-group-collapsed')]
    expect(groups.length).toBeGreaterThanOrEqual(5)
    // Each collapsed group's button: the group's icon, then the chevron.
    for (const group of groups) expect([group.dataset.ribbonGroup, group.querySelectorAll('button svg').length]).toEqual([group.dataset.ribbonGroup, 2])
  })

  it("marks the shared groups' main items for Single line's row", () => {
    const editor = fakeEditor({ display: 'line' })
    // The groups ask the engine for the pen and the shape's state; it answers nothing here.
    Object.assign(editor, { query: vi.fn(async () => null) })
    Object.assign(editor.session as object, { change: { revision: 1 } })
    const tab: FrameTab = {
      id: 'insert',
      label: 'Insert',
      ribbon: (
        <>
          <DrawingInsertGroup testId="k-drawing" merge="Edit" primary={['edit.paste']} />
          <RibbonGroup label="Charts">
            <ChartInsertMenu testId="k-chart" primary />
          </RibbonGroup>
          <InkGroup testId="k-ink" />
          <DrawingFormatGroup ids={['1', '2']} testId="k-format" />
        </>
      ),
    }
    render(lineFrame([tab], editor))
    const ids = [...document.querySelectorAll('.kui-line-inline [data-testid]')].map((element) => element.getAttribute('data-testid'))
    expect(ids).toEqual(
      expect.arrayContaining(['k-drawing-shapes', 'k-drawing-text-box', 'k-cmd-edit.paste', 'k-chart-insert', 'k-ink-select', 'k-ink-pen', 'k-ink-pencil', 'k-ink-highlighter', 'k-ink-eraser', 'k-ink-color', 'k-ink-weight', 'k-format-fill', 'k-format-outline', 'k-format-bring', 'k-format-send', 'k-format-group']),
    )
    expect(ids).not.toContain('k-cmd-edit.undo')
    expect(ids).not.toContain('k-format-effects')
  })
})

describe('EditorFrame display mode fit', () => {
  it('gives a Classic ribbon way group by group: small, icons alone from the last group, then groups collapsed from the last', () => {
    const at = (level: number) => {
      const fit = ribbonFitAt(level, ['a', 'b'])
      return [fit.size, [...fit.icons].join(''), [...fit.collapsed].join('')].join('|')
    }
    expect(ribbonFitAt(0, ['a', 'b']).size).toBe('full')
    expect([1, 2, 3, 4, 5, 9].map(at)).toEqual(['small||', 'small|b|', 'icon|ab|', 'icon|ab|b', 'icon|ab|ab', 'icon|ab|ab'])
    expect(ribbonFitSteps(2)).toBe(5)
  })

  /** A ribbon panel and frame `room` wide: each group drawn whole needs 500 px, a collapsed one 380. */
  function ribbonRoom(room: number) {
    const needed = (panel: HTMLElement) => [...panel.querySelectorAll('[data-ribbon-group]')].reduce((sum, group) => sum + (group.classList.contains('kui-ribbon-group-collapsed') ? 380 : 500), 0)
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('kui-ribbon-panel') ? Math.max(room, needed(this)) : 0
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('kui-ribbon-panel') ? room : 0
      }),
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { width: this.classList.contains('kui-app') ? room : 0 } as DOMRect
      }),
    ]
    return () => spies.forEach((spy) => spy.mockRestore())
  }

  it('keeps Classic where its ribbon fits once groups collapse, and steps down only when even collapsed it does not', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    let restore = ribbonRoom(900)
    try {
      render(frame(fakeEditor({ display: 'classic' }), [HOME, VIEW], { defaultTab: 'home' }))
      resizeFrame(900)
      expect(app().dataset.mode).toBe('classic')
      expect(byTestId('kui-ribbon-collapsed-Font')).not.toBeNull()
      expect(document.querySelector('[data-ribbon-group="Clipboard"]')?.classList.contains('kui-ribbon-group-collapsed')).toBe(false)
      click(byTestId('kui-ribbon-collapsed-Font'))
      expect(byTestId('kui-ribbon-collapsed-panel-Font')?.querySelector('[data-testid="k-cmd-x"]')).not.toBeNull()
      act(() => roots.pop()?.unmount())
      restore()
      restore = ribbonRoom(740)
      render(frame(fakeEditor({ display: 'classic' }), [HOME, VIEW], { defaultTab: 'home' }))
      resizeFrame(740)
      expect(app().dataset.chosenMode).toBe('classic')
      expect(app().dataset.mode).toBe('line')
    } finally {
      restore()
    }
  })

  it("lays a menu tab's command grid out as one row in Single line, so no primary button falls outside the row", () => {
    render(frame(fakeEditor({ display: 'line' }), catalogTabs([{ path: ['Edit'], label: 'Paste', command: 'edit.paste' }])))
    expect(document.querySelector('.kui-line-inline .kui-command-grid')).not.toBeNull()
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8')
    expect(css).toMatch(/\.kui-line-inline \.kui-command-grid\s*\{[^}]*display:\s*contents/)
  })

  it("gives a menu tab's generated groups their first row's icon, which a collapsed group shows", () => {
    render(frame(fakeEditor({ display: 'line' }), catalogTabs([
      { path: ['Edit'], label: 'Paste', command: 'edit.paste' },
      ...['a', 'b', 'c', 'd', 'e'].map((id) => ({ path: ['Edit'], label: id, command: `edit.${id}` })),
      { path: ['Edit', 'More'], label: 'Special', command: 'edit.special' },
    ])))
    // The group's own icon, then the chevron.
    expect(byTestId('kui-line-group-menu:Edit/More')?.querySelectorAll('svg').length).toBe(2)
  })

  it('starts the ribbon again from whole when its groups change size by anything but its own steps (the styles arriving)', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // Unstyled, a group drawn whole is 600 px and a collapsed one 380; styled, 300 and 200.
    let whole = 600
    const collapsed = () => (whole === 600 ? 380 : 200)
    const needed = (panel: HTMLElement) => [...panel.querySelectorAll('[data-ribbon-group]')].reduce((sum, group) => sum + (group.classList.contains('kui-ribbon-group-collapsed') ? collapsed() : whole), 0)
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('kui-ribbon-panel') ? Math.max(900, needed(this)) : 0
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('kui-ribbon-panel') ? 900 : 0
      }),
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { width: this.classList.contains('kui-app') ? 900 : 0 } as DOMRect
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        if (!this.hasAttribute('data-ribbon-group')) return 0
        return this.classList.contains('kui-ribbon-group-collapsed') ? collapsed() : whole
      }),
    ]
    try {
      render(frame(fakeEditor({ display: 'classic' }), [HOME, VIEW], { defaultTab: 'home' }))
      resizeFrame(900)
      expect(document.querySelectorAll('.kui-ribbon-group-collapsed').length).toBe(2)
      whole = 300
      act(() => {
        for (const { target, callback } of observers) if (target.matches('.kui-ribbon-panel, [data-ribbon-group]')) callback([], {} as ResizeObserver)
      })
      expect(app().dataset.mode).toBe('classic')
      expect(document.querySelectorAll('.kui-ribbon-group-collapsed').length).toBe(0)
      expect(document.querySelectorAll('.kui-ribbon-panel [data-size="icon"]').length).toBe(0)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  it('opens on the first tab that is not File when the kit names no default tab', () => {
    const tabs = catalogTabs([
      { path: ['File'], label: 'Export', command: 'file.export' },
      { path: ['Edit'], label: 'Paste', command: 'edit.paste' },
    ])
    render(frame(fakeEditor({ display: 'classic' }), tabs))
    expect(byTestId('ribbon-tab-Edit')?.getAttribute('aria-selected')).toBe('true')
    expect(byTestId('ribbon-tab-File')?.getAttribute('aria-selected')).toBe('false')
  })

  it("shows a menu tab's first rows in Single line's row when the kit names none, and only its named ones otherwise", () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ path: ['Edit'], label: id, command: `edit.${id}` }))
    render(frame(fakeEditor({ display: 'line' }), catalogTabs(rows)))
    expect(labels('.kui-line-inline')).toEqual(['a', 'b', 'c', 'd', 'e'])
    act(() => roots.pop()?.unmount())
    render(frame(fakeEditor({ display: 'line' }), catalogTabs(rows, { primary: { Edit: ['edit.g'] } })))
    expect(labels('.kui-line-inline')).toEqual(['g'])
  })

  it('offers only Focus in a frame without tabs, where the other modes draw the same', () => {
    render(frame(fakeEditor({ display: 'classic' }), []))
    expect(app().dataset.mode).toBe('menus')
    const button = byTestId('k-mode-focus')
    expect(button?.getAttribute('aria-label')).toBe('mode_focus (Ctrl+\\)')
    expect(byTestId('k-mode')).toBeNull()
    click(button)
    expect(app().dataset.mode).toBe('focus')
  })

  it("lets a kit's own command enter and leave Focus through useFrameDisplay", () => {
    function ShowHideUi() {
      const display = useFrameDisplay()
      return <button type="button" data-testid="show-hide" onClick={() => display?.toggleFocus()} />
    }
    render(
      <KitEditorProvider editor={fakeEditor({ display: 'line' })}>
        <EditorFrame tabs={[HOME]}>
          <ShowHideUi />
        </EditorFrame>
      </KitEditorProvider>,
    )
    click(byTestId('show-hide'))
    expect(app().dataset.mode).toBe('focus')
    click(byTestId('show-hide'))
    expect(app().dataset.mode).toBe('line')
  })
})
