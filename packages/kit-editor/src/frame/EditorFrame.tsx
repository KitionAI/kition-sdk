/**
 * The frame every kit editor draws: the top bar (the kit's tabs, then the document actions and
 * the display mode button), the command area of the display mode (none in Menus, one row in
 * Single line, the ribbon in Classic), the active tool's options, the tool rail, side panels, the
 * body, and the status bar. Focus hides all of it but a floating bar. The chosen mode is kept per
 * kit, a host restricts or presets it (`ui.modes`), a mode that does not fit steps down, a coarse
 * pointer sizes it for touch, and a read-only document shows only its viewing tabs. A Classic
 * ribbon gives way before the frame steps down: large buttons draw small, then buttons draw their
 * icons alone, then groups collapse to one button each from the end (`ribbonFitAt`).
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { CatalogNode } from '../catalogMenus'
import { DropPanel } from '@kition/tessera-ui'
import { DocumentActions, ShellFrame, ToolOptionsBar, useKitEditor, type ShellProps } from '../editor'
import { HostButtons } from '../HostButtons'
import { isMac } from '../host'
import { FULL_RIBBON_FIT, ICON_STROKE, LineMoreLabelContext, MenuButton, MenuItem, OverflowStrip, RibbonFitContext, RibbonPresentationContext, type RibbonFit } from '@kition/tessera-ui'
import { ChevronDownIcon as ChevronDown } from '@kition/tessera-icons/react'
import { useUi } from '../uiContext'
import { FocusBar, type FocusTool } from './FocusBar'
import { MenuNodes, useVisibleMenus } from './MenuNodes'
import { MenuRibbon } from './MenuRibbon'
import { ModeButton } from './ModeButton'
import { tabUiId, type FrameTab } from './menus'
import type { DisplayMode } from './modes'
import { useDisplayMode, useStepDown, useTouchDensity, type DisplayModeState } from './useFrameLayout'

const FrameModeContext = createContext<DisplayMode | null>(null)
const FrameDisplayContext = createContext<DisplayModeState | null>(null)

/** The display mode the frame shows (after stepping down, or `focus`); `null` outside an `EditorFrame`. */
export function useFrameMode(): DisplayMode | null {
  return useContext(FrameModeContext)
}

/**
 * The frame's display mode controls, for a kit's own command that changes the mode (a ported
 * app's Show/Hide UI enters Focus with `toggleFocus`); `null` outside an `EditorFrame`.
 */
export function useFrameDisplay(): DisplayModeState | null {
  return useContext(FrameDisplayContext)
}

/**
 * A kit's own bar (a formula bar, sheet tabs, a notes pane, a command line), anywhere in the
 * frame's tree: drawn in every mode but Focus, which shows the canvas and its floating bar only.
 */
export function FrameChrome({ children }: { children: ReactNode }) {
  return useFrameMode() === 'focus' ? null : <>{children}</>
}

/**
 * Kits should memoize `tabs` (and the `hidden` rules inside menu tabs): a new array or function
 * on every render rebuilds the frame's menus and generated ribbons each time.
 */
export type EditorFrameProps = Omit<ShellProps, 'children'> & {
  /** The kit's command areas in order (File, Home, Insert, …, or a menu bar's menus); memoize it. */
  tabs: readonly FrameTab[]
  /** The selected tab, for a kit that chooses it itself (context tabs); with `onTab`. */
  tab?: string
  onTab?: (id: string) => void
  /** The tab selected first when the kit does not choose (`home`); else the first. */
  defaultTab?: string
  /** Before the tabs: the document's name in an editor without tabs. */
  title?: ReactNode
  /** The kit's own buttons before the document actions (Render, Comments). */
  actions?: ReactNode
  /** The active tool's options, under the command area. */
  options?: ReactNode
  /** The tool rail, left of the body; not drawn in a read-only document or in Focus. */
  rail?: ReactNode
  /** A panel left of the body (slide thumbnails); not drawn in Focus. */
  sidebar?: ReactNode
  /** Panels right of the body; not drawn in Focus. */
  panels?: ReactNode
  /** The tool the Focus bar names; the engine's active tool when unset. */
  focusTool?: FocusTool | null
  children: ReactNode
}

/** The More tabs button's width (`.kui-frame-tabs-more`) and the strip's gap between tabs. */
const MORE_WIDTH = 32
const TAB_GAP = 2

/**
 * Which tabs a bar `width` wide shows whole: the selected one always, then the others in order
 * while they fit, leaving room for the More tabs button when any is left out. `widths` are the
 * tabs' own; `null` when every tab fits.
 */
export function fitTabs(ids: readonly string[], widths: ReadonlyMap<string, number>, width: number, active: string | null): Set<string> | null {
  const size = (id: string) => (widths.get(id) ?? 0) + TAB_GAP
  if (ids.reduce((sum, id) => sum + size(id), 0) <= width) return null
  let room = width - MORE_WIDTH - TAB_GAP
  const shown = new Set<string>()
  if (active !== null && ids.includes(active)) {
    shown.add(active)
    room -= size(active)
  }
  for (const id of ids) {
    if (shown.has(id)) continue
    if (size(id) > room) break
    shown.add(id)
    room -= size(id)
  }
  return shown
}

/**
 * The tabs in Single line and Classic. A tab shows whole or not at all: those the bar cannot hold
 * move under a More tabs button at its end (the selected tab always shows, in its place).
 */
function TabStrip({ tabs, active, onTab }: { tabs: readonly FrameTab[]; active: string | null; onTab: (id: string) => void }) {
  const { t } = useKitEditor()
  const bar = useRef<HTMLDivElement>(null)
  // Each tab's width by id and label, measured while it shows; `null` shows every tab.
  const widths = useRef(new Map<string, number>())
  const [shown, setShown] = useState<Set<string> | null>(null)
  // The latest tabs and selection, read by one observer that lives as long as the strip: a new
  // observer on every render observes the strip again while the browser delivers a resize, which
  // WebKit reports as a ResizeObserver loop.
  const fitRef = useRef<() => void>(() => undefined)
  fitRef.current = () => {
    const element = bar.current
    if (!element) return
    const key = (tab: FrameTab) => `${tab.id}\n${tab.label}`
    for (const button of element.querySelectorAll<HTMLElement>('.kui-ribbon-tab')) {
      const tab = tabs.find((item) => item.id === button.dataset.tab)
      if (tab && !button.hidden) widths.current.set(key(tab), button.offsetWidth)
    }
    // A tab not measured yet (new, or relabelled) shows first, to be measured.
    const next = tabs.every((tab) => widths.current.has(key(tab)))
      ? fitTabs(
          tabs.map((tab) => tab.id),
          new Map(tabs.map((tab) => [tab.id, widths.current.get(key(tab)) ?? 0])),
          element.clientWidth,
          active,
        )
      : null
    setShown((current) => (sameTabs(current, next) ? current : next))
  }
  useLayoutEffect(() => fitRef.current(), [tabs, active, shown])
  useLayoutEffect(() => {
    const element = bar.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const sizes = new ResizeObserver(() => fitRef.current())
    sizes.observe(element)
    return () => sizes.disconnect()
  }, [])
  const hidden = shown === null ? [] : tabs.filter((tab) => !shown.has(tab.id))
  return (
    <div ref={bar} className="kui-frame-tabs">
      <div className="kui-ribbon-tabs" role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" className="kui-ribbon-tab" aria-selected={tab.id === active} hidden={shown !== null && !shown.has(tab.id)} onClick={() => onTab(tab.id)} data-tab={tab.id} data-testid={`ribbon-tab-${tab.id}`} data-kit-ui-id={tabUiId(tab)}>
            {tab.label}
          </button>
        ))}
      </div>
      {hidden.length > 0 ? (
        <MenuButton
          align="end"
          trigger={({ toggle, open }) => (
            <button type="button" className="kui-frame-tabs-more" aria-label={t('moreTabs')} title={t('moreTabs')} aria-haspopup="menu" aria-expanded={open} onClick={toggle} data-testid="ribbon-tabs-more">
              <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )}
        >
          {hidden.map((tab) => (
            <MenuItem key={tab.id} label={tab.label} onSelect={() => onTab(tab.id)} testId={`ribbon-tabs-more-${tab.id}`} uiId={tabUiId(tab)} />
          ))}
        </MenuButton>
      ) : null}
    </div>
  )
}

function sameTabs(a: Set<string> | null, b: Set<string> | null) {
  if (a === null || b === null) return a === b
  return a.size === b.size && [...a].every((id) => b.has(id))
}

/** A ribbon tab in Menus: its Classic ribbon in a drop-down panel (Office's collapsed ribbon), scrolling as Classic's does when wider than the window. */
function RibbonDrop({ tab }: { tab: FrameTab }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const ui = useUi()
  const { t } = useKitEditor()
  const state = ui.state(tabUiId(tab))
  return (
    <span ref={anchor} style={{ display: 'inline-flex' }}>
      <button type="button" className="kui-menu-bar-item" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} data-testid={`ribbon-tab-${tab.id}`} data-kit-ui-id={tabUiId(tab)}>
        {tab.label}
      </button>
      <DropPanel open={open} anchor={anchor} onClose={() => setOpen(false)} label={tab.label} className="kui-drop-ribbon" testId={`ribbon-drop-${tab.id}`}>
        <OverflowStrip className="kui-drop-ribbon-strip" panelClassName="kui-ribbon-panel" resetKey={tab.id} labels={{ start: t('ribbonScrollStart'), end: t('ribbonScrollEnd') }} testId={`ribbon-drop-${tab.id}-scroll`}>
          <fieldset className="kui-element" disabled={state.disabled}>
            <RibbonPresentationContext.Provider value="full">{tab.ribbon}</RibbonPresentationContext.Provider>
          </fieldset>
        </OverflowStrip>
      </DropPanel>
    </span>
  )
}

/**
 * Menus: every tab in the top bar, a menu tab as a drop-down menu, a ribbon tab as a drop-down panel.
 * More menus than the bar holds scroll, with a fade and a button at the cut edge, as the tab strip does.
 */
function MenusStrip({ tabs, menus }: { tabs: readonly FrameTab[]; menus: ReadonlyMap<string, CatalogNode[]> }) {
  const { t, testId } = useKitEditor()
  return (
    <nav className="kui-menu-nav" aria-label={t('menuBar')} data-testid={`${testId}-menu-bar`}>
      <OverflowStrip className="kui-menu-strip" panelClassName="kui-menu-bar" labels={{ start: t('menusScrollStart'), end: t('menusScrollEnd') }} testId={`${testId}-menu-bar-scroll`}>
        {tabs.map((tab) =>
          tab.menu ? (
            <MenuButton
              key={tab.id}
              trigger={({ toggle, open }) => (
                <button type="button" className="kui-menu-bar-item" aria-expanded={open} onClick={toggle} data-testid={`${testId}-menu-${tab.id}`} data-kit-ui-id={`menu:${tab.id}`}>
                  {tab.label}
                </button>
              )}
            >
              <MenuNodes tree={tab.menu} nodes={menus.get(tab.id) ?? []} />
              <HostButtons place={`menu:${tab.id}`} as="menu" />
            </MenuButton>
          ) : (
            <RibbonDrop key={tab.id} tab={tab} />
          ),
        )}
      </OverflowStrip>
    </nav>
  )
}

/**
 * How a Classic ribbon gives way at step `level` (0 draws it whole), group by group from the end
 * as Office's does, over `groups` (their keys in ribbon order): 1 draws large buttons small; the
 * next steps draw one more group's buttons as icons alone each, from the last group; then each
 * step collapses one more group, from the last, to one button. `ribbonFitSteps` is the last step.
 */
export function ribbonFitAt(level: number, groups: readonly string[]): RibbonFit {
  if (level <= 0) return FULL_RIBBON_FIT
  const count = groups.length
  const iconed = Math.min(count, level - 1)
  const collapsed = Math.min(count, Math.max(0, level - 1 - count))
  const last = (n: number) => new Set(groups.slice(count - n))
  return { size: iconed === count && count > 0 ? 'icon' : 'small', icons: last(iconed), collapsed: last(collapsed) }
}

export function ribbonFitSteps(groups: number) {
  return 1 + 2 * groups
}

/** The ribbon's group elements in order, collapsed ones included, not those inside a drop-down panel. */
function groupElements(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('[data-ribbon-group]')].filter((group) => !group.closest('.kui-drop-panel'))
}

function ribbonGroups(panel: HTMLElement) {
  return groupElements(panel).map((group) => group.dataset.ribbonGroup ?? '')
}

/** The width the ribbon's groups take together (a panel's scrollWidth stops at its own width). */
function groupsWidth(panel: HTMLElement) {
  return groupElements(panel).reduce((sum, group) => sum + group.offsetWidth, 0)
}

/**
 * Single line's row or Classic's ribbon for the selected tab: its ribbon, or one built from its
 * menu. Classic takes the steps of `ribbonFitAt` while its ribbon overflows; once it fits, or
 * every step is taken, `measure` hears its width (the frame steps down only from the last step).
 * A wider panel, or groups that change size by anything but these steps, start it again from the
 * ribbon drawn whole.
 */
function CommandArea({ mode, tab, nodes, panel, measure }: { mode: 'line' | 'classic'; tab: FrameTab; nodes: readonly CatalogNode[]; panel: RefObject<HTMLDivElement | null>; measure: (mode: 'line' | 'classic', panel: HTMLElement | null) => void }) {
  const { t } = useKitEditor()
  const ui = useUi()
  const content = tab.ribbon ?? (tab.menu ? <MenuRibbon tab={tab} nodes={nodes} /> : null)
  const moreLabel = useCallback((group: string) => t('lineMore', { group }), [t])
  const line = mode === 'line'
  const key = `${mode}:${tab.id}`
  // `fresh` counts restarts, so a restart from the whole ribbon draws again even at step 0.
  const [step, setStep] = useState({ key, level: 0, groups: [] as readonly string[], fresh: 0 })
  const level = step.key === key ? step.level : 0
  const groups = step.key === key ? step.groups : []
  const fit = useMemo(() => (line ? FULL_RIBBON_FIT : ribbonFitAt(level, groups)), [groups, level, line])
  // What the ribbon measured when it last settled, and the observer that watches it change.
  const settled = useRef({ width: 0, content: 0 })
  const watcher = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    const element = panel.current
    if (!line && element) {
      const found = ribbonGroups(element)
      const over = element.scrollWidth - element.clientWidth > 1
      if (over && level < ribbonFitSteps(found.length)) {
        setStep((current) => ({ key, level: level + 1, groups: found, fresh: current.fresh }))
        return
      }
      settled.current = { width: element.clientWidth, content: groupsWidth(element) }
      const observer = watcher.current
      if (observer) {
        observer.disconnect()
        observer.observe(element)
        for (const group of groupElements(element)) observer.observe(group)
      }
    }
    measure(mode, element)
  })
  // The ribbon starts again from whole when its panel grows, or when its groups change size by
  // anything but its own steps (the kit's styles or fonts arriving, a group's content changing):
  // a step taken for the old sizes may be more than the new ones need.
  useLayoutEffect(() => {
    const element = panel.current
    if (line || !element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const was = settled.current
      if (element.clientWidth > was.width + 1 || Math.abs(groupsWidth(element) - was.content) > 1) setStep((current) => ({ key, level: 0, groups: current.groups, fresh: current.fresh + 1 }))
    })
    watcher.current = observer
    observer.observe(element)
    return () => {
      observer.disconnect()
      watcher.current = null
    }
  }, [key, line, panel])
  if (!content) return null
  return (
    <OverflowStrip className={line ? 'kui-line' : 'kui-ribbon-body'} panelClassName={line ? 'kui-line-panel' : 'kui-ribbon-panel'} role="tabpanel" resetKey={tab.id} labels={{ start: t('ribbonScrollStart'), end: t('ribbonScrollEnd') }} testId="ribbon-scroll" panelRef={panel}>
      <fieldset className="kui-element" disabled={ui.state(tabUiId(tab)).disabled}>
        <LineMoreLabelContext.Provider value={moreLabel}>
          <RibbonPresentationContext.Provider value={line ? 'line' : 'full'}>
            <RibbonFitContext.Provider value={fit}>{content}</RibbonFitContext.Provider>
          </RibbonPresentationContext.Provider>
        </LineMoreLabelContext.Provider>
      </fieldset>
    </OverflowStrip>
  )
}

export function EditorFrame({ tabs, tab, onTab, defaultTab, title, actions, options, rail, sidebar, panels, focusTool, statusBar = true, children, ...shell }: EditorFrameProps) {
  const editor = useKitEditor()
  const { host, phrase, testId } = editor
  const ui = useUi()
  const root = useRef<HTMLDivElement>(null)
  const commandPanel = useRef<HTMLDivElement>(null)
  const readOnly = host.readOnly === true
  const touch = useTouchDensity()

  // A menu only the host's buttons fill gets a tab, as the menu bars drew it, in a kit with menus.
  const add = ui.config.add
  const allTabs = useMemo<readonly FrameTab[]>(() => {
    if (!tabs.some((item) => item.menu)) return tabs
    const extra = add
      .map((item) => item.place)
      .filter((place) => place.startsWith('menu:') && !place.includes('/'))
      .map((place) => place.slice('menu:'.length))
      .filter((label, index, all) => all.indexOf(label) === index && !tabs.some((item) => item.id === label))
    return extra.length ? [...tabs, ...extra.map((label) => ({ id: label, label: phrase(label), menu: { rows: [] } }))] : tabs
  }, [add, phrase, tabs])
  const menus = useVisibleMenus(allTabs)
  const shown = allTabs.filter((item) => {
    if (ui.state(tabUiId(item)).hidden || (readOnly && !item.view)) return false
    if (!item.menu || item.ribbon) return true
    return (menus.get(item.id)?.length ?? 0) > 0 || (item.menu.before?.length ?? 0) > 0 || ui.buttons(`menu:${item.id}`).length > 0
  })

  // Without tabs, Menus, Single line, and Classic draw the same: the mode button only enters Focus.
  const display = useDisplayMode(host, shown.length > 0)

  const [own, setOwn] = useState<string | null>(defaultTab ?? null)
  const wanted = tab ?? own
  // Without a kit's choice, the first tab that is not File (its commands are kept, not used, as Office's backstage).
  const active = shown.find((item) => item.id === wanted) ?? shown.find((item) => item.id === defaultTab) ?? shown.find((item) => item.id.toLowerCase() !== 'file') ?? shown[0] ?? null
  const activeId = active?.id ?? null
  const choose = useCallback(
    (id: string) => {
      setOwn(id)
      onTab?.(id)
    },
    [onTab],
  )
  // Before paint, so a hidden tab's content is never drawn: a kit that chooses the tab hears the move.
  useLayoutEffect(() => {
    if (tab !== undefined && activeId !== null && activeId !== tab) onTab?.(activeId)
  }, [activeId, onTab, tab])

  const fit = useStepDown(root, display.chosen, activeId ?? '', display.allowed)
  const mode: DisplayMode = display.focus ? 'focus' : fit.effective

  const frameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const modifier = isMac() ? event.metaKey : event.ctrlKey
    // Mod+\ (not Mod+Shift+F, which kits keep for Find and Search).
    if (modifier && !event.shiftKey && !event.altKey && event.code === 'Backslash') {
      if (!display.allowed.includes('focus') || ui.state('action:mode').denied) return false
      display.toggleFocus()
      return true
    }
    return false
  }
  // Escape the kit left untaken (no tool, gesture, or selection to cancel) leaves Focus.
  const frameEscape = () => {
    if (!display.focus) return false
    display.exitFocus()
    return true
  }

  const focus = mode === 'focus'
  // Entering or leaving Focus by a button unmounts the button: where the focus fell to nothing,
  // the frame takes it (so Escape still leaves Focus), and on leaving, the mode button does.
  const wasFocus = useRef(focus)
  useLayoutEffect(() => {
    if (wasFocus.current === focus) return
    wasFocus.current = focus
    const now = document.activeElement
    if (now && now !== document.body && now.isConnected) return
    const button = focus ? null : root.current?.querySelector<HTMLElement>('.kui-mode-button')
    ;(button ?? root.current)?.focus({ preventScroll: true })
  }, [focus])
  const top = focus ? (
    <FocusBar tool={focusTool} onExit={display.exitFocus} />
  ) : (
    <>
      <div className="kui-frame-top" data-testid={`${testId}-top-bar`}>
        {title ? <div className="kui-frame-title">{title}</div> : null}
        {mode === 'menus' ? <MenusStrip tabs={shown} menus={menus} /> : <TabStrip tabs={shown} active={activeId} onTab={choose} />}
        <div className="kui-ribbon-end">
          <DocumentActions before={actions} mode={<ModeButton display={display} shown={mode} areas={shown.length > 0} />} />
        </div>
      </div>
      {(mode === 'line' || mode === 'classic') && active ? <CommandArea mode={mode} tab={active} nodes={menus.get(active.id) ?? []} panel={commandPanel} measure={fit.measure} /> : null}
      {options ? <ToolOptionsBar>{options}</ToolOptionsBar> : null}
    </>
  )
  return (
    <FrameModeContext.Provider value={mode}>
      <FrameDisplayContext.Provider value={display}>
      <ShellFrame {...shell} statusBar={statusBar && !focus} top={top} frame={{ ref: root, mode, chosen: display.chosen, touch, viewOnly: readOnly, keyDown: frameKeyDown, escape: frameEscape }}>
        <div className="kui-frame-body">
          {rail && !readOnly && !focus ? rail : null}
          {sidebar && !focus ? sidebar : null}
          <div className="kui-frame-main">{children}</div>
          {panels && !focus ? panels : null}
        </div>
      </ShellFrame>
      </FrameDisplayContext.Provider>
    </FrameModeContext.Provider>
  )
}
