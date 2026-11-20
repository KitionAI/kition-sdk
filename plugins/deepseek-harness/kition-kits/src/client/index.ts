/**
 * @kition/dsh-kits, the browser module: a Kition kit's file opens in the kit's own editor in
 * DeepSeek Harness's right sidebar, and the person reviews what an agent did to kit files at the
 * end of its turn. The editor is kition gateway's editor page (kition-sdk docs/sdk/gateway-page.md),
 * framed same-origin from the host module's /kition/ routes, so an agent's kit tool calls on the
 * open file happen in it, live, and its draft shows there for review.
 *
 * - Extensions only Kition opens (`.ktable`, `.kboard`, ...) are a right sidebar tab type: a click
 *   in the file tree opens the Kition editor.
 * - Extensions DeepSeek Harness previews itself (`.md`, `.docx`, `.xlsx`, `.pptx`, `.pdf`,
 *   `.html`, `.csv`, `.svg`) get the kit as a document preview under "Open with"; DeepSeek
 *   Harness's stays the default unless the person's setting says Kition.
 * - A kit's view-only formats (Vector's `.svg`, Sheet's `.csv`) open read-only.
 * - Each turn's kit tool calls are projected from the session's events (`kitionTurn`), and the
 *   turn's tail shows a card per file it changed: what changed, its state, Open, Review, and the
 *   person's own Merge and Discard. While an agent edits a file that is not open, a floating
 *   window shows it (a setting).
 *
 * Every service it uses is the same in DeepSeek Harness 0.2.2-rc.2 and rc.5; each is looked up
 * and left out when a host lacks it.
 */
import * as React from 'react'
import { baseName, extensionOf, parseFileAddress } from './address'
import { makeFrame, PageFrame, type Language, type PageState, type Scheme } from './frame'
import { compare, discard, draftingTurnOf, draftingTurnsOf, draftingVersionNow, draftsOf, exists, merge, noteDraftingTurn, openFile, reviewsOf, route, subscribeDraftingTurns, type Comparison, type Opened } from './gateway'
import { en, fill, NAMESPACE, zh, type Key } from './i18n'
import { kitName, KIT_EXTENSIONS, KIT_FORMATS, PREVIEW_EXTENSIONS, TAB_EXTENSIONS } from './kits'
import { cardActions, cardState, draftedAt, kitTurnDefinition, outcomeFor, type CardState, type KitTurnData, type KitTurnFile } from './turn'
import { ask } from './dialog'
import { liveWindowRect } from './placement'

const h = React.createElement

export const name = '@kition/dsh-kits'
export const inject = ['slots']

/** The tab type's id and kind, and the slot key of its body and title. */
export const TAB_TYPE = 'kition'
/** DeepSeek Harness's own document preview tab type (its id and kind), where "Open with" lives. */
const TEXT_TYPE = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
const TEXT_KIND = 'text'
/** The host module's row: its Config is the person's settings. */
const HOST_ENTRY = 'kition-kits-host'
const previewId = (kit: string) => `kition/${kit}`

type Context = any // DeepSeek Harness's client context (cordis): services looked up by name.

/* -------------------------------------------------------------------------------------------- */
/* What every view shares: theme, language, settings, keys, and each open page's state.         */

type Settings = { liveFloat: boolean; openWith: 'dsh' | 'kition'; autoOpen: boolean }
const DEFAULTS: Settings = { liveFloat: true, openWith: 'dsh', autoOpen: false }

class Environment {
  private listeners = new Set<() => void>()
  scheme: Scheme = 'light'
  language: Language = 'en'
  settings: Settings = DEFAULTS
  /** DeepSeek Harness's own shortcuts the editor hands back (the web UI's; Desktop routes them itself). */
  keys: string[] = []
  translate: ((key: string, params?: Record<string, string>) => string) | null = null
  sidebar: Context | null = null
  version = 0

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(changes: Partial<Pick<Environment, 'scheme' | 'language' | 'settings' | 'keys'>>) {
    Object.assign(this, changes)
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  t(key: Key, params: Record<string, string> = {}) {
    const bound = this.translate?.(key, params)
    if (bound && bound !== key) return bound
    return fill((this.language === 'zh' ? zh : en)[key], params)
  }
}

const environment = new Environment()

type OpenPage = PageState & { name: string; path: string; sessionId: string | null; frame: PageFrame; tabId: string; floating: boolean }
/** Each open Kition view, by tab id: its title and close guard read it, cards and the float too. */
const pages = new Map<string, OpenPage>()
const pageListeners = new Set<() => void>()
function setPage(tabId: string, state: OpenPage | null) {
  if (state) pages.set(tabId, state)
  else pages.delete(tabId)
  for (const listener of [...pageListeners]) listener()
}
const subscribePages = (listener: () => void) => {
  pageListeners.add(listener)
  return () => pageListeners.delete(listener)
}
const openPage = (sessionId: string, path: string) => [...pages.values()].find((page) => page.path === path && (page.sessionId === null || page.sessionId === sessionId))

/** Reviews asked for before their file's page is ready, by `<session>:<path>`. */
const pendingReview = new Set<string>()

const schemeOf = (snapshot: any): Scheme => (snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light')
const languageOf = (active: unknown): Language => (typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en')

function useEnvironment() {
  React.useSyncExternalStore(environment.subscribe, () => environment.version)
  return environment
}

/** A session's file as DeepSeek Harness addresses it. */
function fileAddress(sessionId: string, path: string) {
  const segment = (text: string) => encodeURIComponent(text).replace(/%3A/gi, ':')
  return `dsh-resource://file/session/${segment(sessionId)}/${path.split('/').map(segment).join('/')}`
}

/**
 * Opens a session's file in a Kition tab, in the sidebar (`sidebar`) or as a live window the
 * person watches (`live`): floating beside the conversation where it fits, else in the sidebar.
 * The keyboard stays where the person had it.
 */
function openInSidebar(sessionId: string, path: string, destination: 'sidebar' | 'live' = 'sidebar') {
  const sidebar = environment.sidebar
  if (typeof sidebar?.openResource !== 'function') return false
  const active = document.activeElement as HTMLElement | null
  const address = fileAddress(sessionId, path)
  const composer = document.querySelector('[data-composer-input]')?.closest('form, [class*="input"], [class*="Input"]') ?? document.querySelector('[data-composer-input]')
  const rect = destination === 'live' ? liveWindowRect({ width: innerWidth, height: innerHeight }, composer?.getBoundingClientRect() ?? null) : null
  const collapsed = typeof sidebar.isExpanded === 'function' ? !sidebar.isExpanded() : false
  try {
    sidebar.openResource(address, { kind: TAB_TYPE, revealIfOpened: true, ...(destination === 'live' ? { params: { live: true } } : {}) })
    if (rect && typeof sidebar.float === 'function' && typeof sidebar.tabsIn === 'function') {
      // A floating window at a place of our choosing: DeepSeek Harness takes a rectangle when a docked tab floats.
      const tab = (sidebar.tabsIn(sessionId) as Array<{ id: string; contentId: string; kind: string }>).find((record) => record.contentId === address && record.kind === TAB_TYPE)
      if (tab) {
        sidebar.float(tab.id, rect)
        if (collapsed && sidebar.isExpanded?.()) sidebar.toggleExpanded?.()
      }
    }
  } catch {
    return false
  }
  if (destination === 'live' && active && active !== document.body) requestAnimationFrame(() => active.focus({ preventScroll: true }))
  return true
}

/* -------------------------------------------------------------------------------------------- */
/* The view: asks the host module for the page's address, then frames it.                       */

/** Gives DeepSeek Harness a shortcut pressed in the editor (in the web UI its keys are heard on the top window only). */
function forwardShortcut(key: { key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) {
  const init = { key: key.key, code: key.code, metaKey: !!key.meta, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, altKey: !!key.alt, bubbles: true, cancelable: true }
  document.body.dispatchEvent(new KeyboardEvent('keydown', init))
  document.body.dispatchEvent(new KeyboardEvent('keyup', init))
}

function Panel(props: { state: string; title: string; detail?: string; children?: React.ReactNode; onRetry?: () => void }) {
  const env = useEnvironment()
  return h(
    'div',
    { 'data-kition-state': props.state, role: props.state === 'starting' ? 'status' : 'alert', style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px', font: 'inherit', color: 'inherit', overflow: 'auto' } },
    h('strong', { style: { fontSize: '14px' } }, props.title),
    props.detail ? h('div', { style: { opacity: 0.8 } }, props.detail) : null,
    props.children,
    props.onRetry ? h('button', { type: 'button', onClick: props.onRetry, 'data-kition-retry': '', style: { alignSelf: 'flex-start', padding: '4px 12px', cursor: 'pointer' } }, env.t('retry')) : null,
  )
}

type ViewProps = {
  address: string
  /** The session the tab belongs to, for a file named by its absolute path. */
  sessionId?: string
  tabId: string
  /** Closes the tab (DeepSeek Harness asks the close guard first). */
  close?: () => void
  /** Whether closing asks here (a host without a close guard for the tab's kind). */
  guardClose: () => boolean
  /** A live window the person watches: the editor does not take the keyboard. */
  watching?: boolean
  /** The tab floats. */
  floating?: boolean
  /** Told when the page shows the file (a document preview reports it loaded). */
  onOpen?: () => void
}

function KitionView(props: ViewProps) {
  const env = useEnvironment()
  const parsed = parseFileAddress(props.address)
  const sessionId = parsed?.scope === 'session' ? parsed.sessionId : props.sessionId
  const path = parsed?.path ?? ''
  const fileName = baseName(path)
  const [attempt, setAttempt] = React.useState(0)
  const [opened, setOpened] = React.useState<Opened>({ phase: 'opening' })
  const host = React.useRef<HTMLDivElement | null>(null)
  const latest = React.useRef(props)
  latest.current = props

  React.useEffect(() => {
    if (!sessionId || !path) return
    let current = true
    setOpened({ phase: 'opening' })
    void openFile(sessionId, path).then((result) => current && setOpened(result))
    return () => {
      current = false
    }
  }, [sessionId, path, attempt])

  React.useEffect(() => {
    if (opened.phase !== 'open' || !host.current) return
    const url = new URL(opened.page, document.baseURI)
    url.searchParams.set('theme', environment.scheme)
    url.searchParams.set('locale', environment.language)
    if (environment.keys.length) url.searchParams.set('keys', environment.keys.join(' '))
    if (props.watching) url.searchParams.set('focus', 'no')
    // The tab's close guard asks; and the app's unload is asked about once, at the top (unloadGuard).
    url.searchParams.set('closing', 'host')
    const frame = makeFrame(props.tabId, url.href, `Kition ${fileName}`)
    const reviewKey = `${sessionId}:${opened.path}`
    const remember = (state: PageState) => setPage(props.tabId, { ...state, name: fileName, path: opened.path, sessionId: sessionId ?? null, frame: page, tabId: props.tabId, floating: latest.current.floating === true })
    const page: PageFrame = new PageFrame(
      frame,
      {
        change: (state) => {
          remember(state)
          if (state.status === 'open') latest.current.onOpen?.()
          if (state.status === 'open' && pendingReview.delete(reviewKey)) page.review()
          void draftsOf(opened.key).refresh()
        },
        shortcut: forwardShortcut,
        requestClose: (dirty) => {
          if (latest.current.guardClose() && dirty) void confirmClose(props.tabId, () => latest.current.close?.())
          else latest.current.close?.()
        },
        reviewed: () => {
          void draftsOf(opened.key).refresh()
          if (sessionId) void reviewsOf(sessionId).refresh()
        },
      },
      environment.scheme,
      environment.language,
    )
    remember(page.state)
    const stop = environment.subscribe(() => {
      page.setTheme(environment.scheme)
      page.setLanguage(environment.language)
    })
    host.current.replaceChildren(frame)
    return () => {
      stop()
      page.dispose()
      frame.remove()
      setPage(props.tabId, null)
    }
  }, [opened, props.tabId, fileName])

  if (!sessionId || !path) return h(Panel, { state: 'no-session', title: env.t('noSession') })
  if (opened.phase === 'opening') return h(Panel, { state: 'starting', title: env.t('starting'), detail: env.t('startingDetail') })
  if (opened.phase === 'failed') {
    const retry = () => setAttempt((n) => n + 1)
    if (opened.error === 'kition-missing' || opened.error === 'kition-invalid') {
      // kition comes with the plugin: none runs only on a platform it has no build for, after an
      // install that left out optional dependencies, when the one it brought is too old, or with
      // an option naming another.
      const why = opened.error === 'kition-invalid' ? 'missingOption' : opened.reason === 'unsupported' ? 'missingUnsupported' : opened.reason === 'omitted' ? 'missingOmitted' : opened.reason === 'old-bundled' ? 'missingOld' : opened.reason === 'folder' ? 'missingFolder' : 'missingCli'
      return h(
        Panel,
        { state: 'kition-missing', title: env.t('missingTitle'), detail: env.t(why, { platform: opened.platform ?? '' }), onRetry: retry },
        h('div', { 'data-kition-missing-reason': opened.reason ?? opened.error, style: { opacity: 0.7, fontSize: '12px', overflowWrap: 'anywhere' } }, opened.message),
      )
    }
    if (opened.error === 'outside-workspace') return h(Panel, { state: 'outside-workspace', title: env.t('outsideTitle'), detail: env.t('outsideDetail') })
    return h(Panel, { state: 'unreachable', title: env.t('unreachableTitle'), detail: env.t('unreachableDetail'), onRetry: retry }, h('div', { style: { opacity: 0.7, fontSize: '12px' } }, opened.message))
  }
  return h('div', { ref: host, 'data-kition-view': '', style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, WebkitAppRegion: 'no-drag' } })
}

/* -------------------------------------------------------------------------------------------- */
/* DeepSeek Harness's slots: the tab body and title, the document preview body and its title.   */

function TabBody(props: any) {
  const info = props.useTabInfo()
  const params = info.tab.navigation?.params ?? {}
  return h(KitionView, {
    address: info.tab.contentId,
    sessionId: props.sessionId,
    tabId: info.tab.id,
    close: () => info.tab.actions?.close?.(),
    guardClose: () => !guards.kition,
    watching: params.live === true || params.float === true,
    floating: info.panel?.isFloating === true,
  })
}

/**
 * A tab's title: its marks, then its name. The marks come first because DeepSeek Harness's tab is at
 * most 170 px wide and fades its title's last 30 px under the close button: a long name is cut, the
 * marks never are. `●` while it has unsaved edits, a Draft mark while an agent's draft waits, Read-only.
 */
function titled(name: string, page: OpenPage | undefined, env: Environment) {
  const mark = { flex: 'none', fontSize: '10px', lineHeight: '14px', padding: '0 4px', borderRadius: '6px', whiteSpace: 'nowrap' } as const
  return [
    page?.dirty ? h('span', { key: 'dirty', 'data-kition-dirty': '', 'aria-label': env.t('unsaved'), title: env.t('unsaved'), style: { flex: 'none' } }, '●') : null,
    page?.draft ? h('span', { key: 'draft', 'data-kition-draft': page.draft.state, title: env.t('draftTitle'), style: { ...mark, background: 'rgba(255,170,0,0.25)' } }, env.t('draft')) : null,
    page?.readOnly ? h('span', { key: 'ro', 'data-kition-readonly': '', style: { ...mark, opacity: 0.75, border: '1px solid currentColor', lineHeight: '12px' } }, env.t('readOnly')) : null,
    h('span', { key: 'name', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
  ]
}

function TabTitle(props: any) {
  const env = useEnvironment()
  const info = props.useTabInfo()
  React.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id))
  return h(React.Fragment, null, ...titled(info.tab.title, pages.get(info.tab.id), env))
}

/**
 * DeepSeek Harness's document preview title, with the marks of a Kition preview in it. It stands in
 * for DeepSeek Harness's own (a plugin's keyed entry shadows the product's), drawn the same way:
 * the file type's sheet, then the name.
 */
function textTitle(primitives: { FileTypeIcon?: any; classifyFileType?: (name: string) => unknown } | null) {
  return function TextTabTitle(props: any) {
    const env = useEnvironment()
    const info = props.useTabInfo()
    React.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id))
    const icon = primitives?.FileTypeIcon && primitives.classifyFileType ? h(primitives.FileTypeIcon, { kind: primitives.classifyFileType(info.tab.title), size: 16, style: { flex: 'none' } }) : null
    return h(React.Fragment, null, icon, ...titled(info.tab.title, pages.get(info.tab.id), env))
  }
}

function PreviewBody(props: any) {
  const info = props.useTabInfo?.()
  const content = props.content
  const loaded = React.useRef(false)
  React.useEffect(() => {
    loaded.current = false
  }, [content?.revision])
  return h(KitionView, {
    address: props.resourceAddress,
    sessionId: props.sessionId,
    tabId: info?.tab?.id ?? props.resourceAddress,
    close: () => info?.tab?.actions?.close?.(),
    guardClose: () => !guards.text,
    onOpen: () => {
      if (loaded.current || content?.kind !== 'renderer') return
      loaded.current = true
      content.loaded(String(content.revision))
    },
  })
}

/** Which tab kinds have the plugin's close guard (it asks before a tab with unsaved edits closes). */
const guards = { kition: false, text: false }

/** Tabs the person chose to close with their unsaved edits: the guard lets them go. */
const closing = new Set<string>()

/**
 * Asks the person what becomes of a tab's unsaved edits: Save and close, Close without saving, or
 * Keep editing. An in-page dialog: a native one (the browser's confirm) would stop the whole page,
 * DeepSeek Harness Desktop's included, until answered.
 */
async function confirmClose(tabId: string, close: () => void) {
  const page = pages.get(tabId)
  if (!page) return close()
  const choice = await ask(environment.t('closeDirty', { name: page.name }), [
    { id: 'save', label: environment.t('closeSave'), primary: true },
    { id: 'discard', label: environment.t('closeDiscard'), danger: true },
    { id: 'keep', label: environment.t('closeKeep') },
  ])
  if (choice === 'save') {
    const saved = await new Promise<boolean>((resolve) => {
      const stop = subscribePages(() => {
        const now = pages.get(tabId)
        if (!now || !now.dirty) {
          stop()
          resolve(true)
        }
      })
      page.frame.save()
      setTimeout(() => {
        stop()
        resolve(!pages.get(tabId)?.dirty)
      }, 15_000)
    })
    if (!saved) return
  } else if (choice !== 'discard') return
  closing.add(tabId)
  close()
  setTimeout(() => closing.delete(tabId), 2000)
}

function closeGuard(_session: string, tab: { id: string }) {
  const page = pages.get(tab.id)
  if (!page?.dirty || closing.has(tab.id)) return
  // DeepSeek Harness takes only an answer now: keep the tab, and ask the person in the page.
  void confirmClose(tab.id, () => environment.sidebar?.close?.(tab.id))
  throw new Error('Kition: the tab has unsaved edits; the person is asked')
}

/* -------------------------------------------------------------------------------------------- */
/* The review cards at the end of an agent's turn.                                              */

/** The workspace key of a session, from the host module (which starts its gateway). */
const keys = new Map<string, Promise<Opened>>()
function workspaceOf(sessionId: string, path: string) {
  const cached = keys.get(sessionId)
  if (cached) return cached
  const asked = openFile(sessionId, path)
  keys.set(sessionId, asked)
  // A failure is asked again next time (Kition installed, the gateway back).
  void asked.then((answer) => answer.phase !== 'open' && keys.delete(sessionId))
  return asked
}

function useWatch<T>(subscribe: ((listener: () => void) => () => void) | null, read: () => T): T {
  const [, setTick] = React.useState(0)
  React.useEffect(() => (subscribe ? subscribe(() => setTick((n) => n + 1)) : undefined), [subscribe])
  return read()
}

const STATE_WORDS: Record<CardState, Key> = {
  pending: 'statePending',
  failed: 'stateFailed',
  live: 'stateLive',
  saved: 'stateSaved',
  created: 'stateCreated',
  'draft-open': 'stateDraftOpen',
  'draft-ready': 'stateDraftReady',
  stale: 'stateStale',
  merged: 'stateMerged',
  discarded: 'stateDiscarded',
  'draft-gone': 'stateDraftGone',
  missing: 'stateMissing',
}

const button = (label: string, action: string, onClick: () => void, busy: boolean, primary = false) =>
  h(
    'button',
    {
      key: action,
      type: 'button',
      'data-kition-card-action': action,
      disabled: busy,
      onClick,
      style: { padding: '2px 10px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', background: primary ? 'rgba(80,90,255,0.12)' : 'transparent', color: 'inherit', cursor: busy ? 'default' : 'pointer', font: 'inherit', fontSize: '12px' },
    },
    label,
  )

function FileCard(props: { sessionId: string; turn: number; file: KitTurnFile; open: (path: string) => void }) {
  const env = useEnvironment()
  const { sessionId, file, turn } = props
  const [workspace, setWorkspace] = React.useState<Opened>({ phase: 'opening' })
  const [attempt, setAttempt] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [fileThere, setFileThere] = React.useState<boolean | undefined>(undefined)
  const [comparison, setComparison] = React.useState<Comparison | null>(null)
  React.useEffect(() => {
    let current = true
    void workspaceOf(sessionId, file.path).then((answer) => current && setWorkspace(answer))
    return () => {
      current = false
    }
  }, [sessionId, file.path, attempt])
  const key = workspace.phase === 'open' ? workspace.key : null
  const watch = React.useMemo(() => (key ? draftsOf(key) : null), [key])
  const subscribe = React.useMemo(() => (watch ? (listener: () => void) => watch.subscribe(listener) : null), [watch])
  const listed = useWatch(subscribe, () => (watch?.drafts ? (watch.drafts.get(file.path) ?? null) : undefined))
  React.useSyncExternalStore(subscribePages, () => pages.size)
  const drafted = file.operations.some((operation) => operation.writes && operation.draft && operation.phase === 'done')
  if (drafted) noteDraftingTurn(sessionId, file.path, turn, draftedAt(file))
  // The person's reviews, as the host recorded them: the same in every browser.
  const reviews = React.useMemo(() => reviewsOf(sessionId), [sessionId])
  const subscribeReviews = React.useMemo(() => (listener: () => void) => reviews.subscribe(listener), [reviews])
  useWatch(subscribeReviews, () => reviews.reviews)
  React.useEffect(() => (watch ? watch.subscribe(() => void reviews.refresh()) : undefined), [watch, reviews])
  // The file's existence and the draft's comparison, asked again as the draft changes.
  const listedKey = listed ? `${listed.state}:${listed.stale}:${listed.updated ?? ''}` : String(listed)
  React.useEffect(() => {
    if (!key) return
    let current = true
    void exists(key, file.path).then((there) => current && setFileThere(there))
    if (listed && drafted) void compare(key, file.path).then((answer) => current && setComparison(answer), () => current && setComparison(null))
    else setComparison(null)
    return () => {
      current = false
    }
  }, [key, file.path, listedKey, drafted])

  // The draft the gateway lists now is the latest drafting turn's: an older turn's card shows what the person did to its own.
  React.useSyncExternalStore(subscribeDraftingTurns, draftingVersionNow)
  const latest = draftingTurnOf(sessionId, file.path) === turn
  const review = drafted ? outcomeFor(reviews.reviews, sessionId, file.path, turn, draftingTurnsOf(sessionId, file.path)) : null
  const kept = review?.outcome ?? null
  const state = cardState(file, { draft: kept ? null : watch?.drafts ? (latest ? listed : null) : undefined, outcome: kept, exists: fileThere })
  if (state === null) return null
  const kit = file.kit?.replace(/^kit\./, '') ?? KIT_EXTENSIONS[extensionOf(file.path)] ?? null
  let words = env.t(STATE_WORDS[state])
  let shown: string = state
  if (workspace.phase === 'failed') {
    shown = workspace.error === 'kition-missing' || workspace.error === 'kition-invalid' ? 'kition-missing' : 'gateway-down'
    words = env.t(shown === 'kition-missing' ? 'stateKitionMissing' : 'stateGatewayDown')
  }
  const origin = { session: sessionId, turn }
  const act = (run: () => Promise<unknown>) => async () => {
    if (!key) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
    } catch (error) {
      setProblem(env.t('failedAction', { message: (error as Error).message }))
    } finally {
      setBusy(false)
      void watch?.refresh()
      void reviews.refresh()
    }
  }
  const actions = workspace.phase === 'failed' ? [] : cardActions(state)
  const counts = comparison?.diff ? { created: String(comparison.diff.created?.length ?? 0), changed: String(comparison.diff.changed?.length ?? 0), deleted: String(comparison.diff.deleted?.length ?? 0) } : null
  const picture = comparison?.previews?.draft
  return h(
    'div',
    {
      'data-kition-card': file.path,
      'data-state': shown,
      style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 10px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: '8px', margin: '6px 0', fontSize: '13px' },
    },
    picture ? h('img', { src: `data:image/png;base64,${picture}`, alt: '', 'data-kition-card-picture': '', style: { width: '64px', height: '48px', objectFit: 'contain', borderRadius: '4px', background: 'rgba(127,127,127,0.1)', flex: 'none' } }) : null,
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 } },
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
        h('strong', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: file.path }, baseName(file.path)),
        kit ? h('span', { style: { opacity: 0.7, fontSize: '12px' } }, `Kition ${kitName(kit)}`) : null,
        h('span', { 'data-kition-card-state': shown, style: { fontSize: '12px', opacity: 0.85 } }, words),
      ),
      counts ? h('div', { 'data-kition-card-changes': '', style: { fontSize: '12px', opacity: 0.75 } }, env.t('changes', counts)) : comparison?.diffUnavailable ? h('div', { style: { fontSize: '12px', opacity: 0.75 } }, comparison.diffUnavailable) : null,
      problem ? h('div', { role: 'alert', style: { fontSize: '12px', color: '#c0392b' } }, problem) : null,
      workspace.phase === 'failed' ? h('div', null, button(env.t('retry'), 'retry', () => setAttempt((n) => n + 1), false)) : null,
      actions.length
        ? h(
            'div',
            { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            ...actions.map((action) => {
              switch (action) {
                case 'open':
                  return button(env.t('actionOpen'), action, () => props.open(file.path), false)
                case 'review':
                  return button(env.t('actionReview'), action, () => reviewInSidebar(sessionId, file.path), false)
                case 'merge':
                  return button(env.t('actionMerge'), action, act(() => merge(key!, file.path, false, origin)), busy, true)
                case 'overwrite':
                  return button(env.t('actionOverwrite'), action, act(() => merge(key!, file.path, true, origin)), busy, true)
                case 'discard':
                  return button(env.t('actionDiscard'), action, () => {
                    void ask(env.t('confirmDiscard', { name: baseName(file.path) }), [
                      { id: 'discard', label: env.t('actionDiscard'), danger: true },
                      { id: 'keep', label: env.t('keepDraft') },
                    ]).then((choice) => {
                      if (choice === 'discard') void act(() => discard(key!, file.path, origin))()
                    })
                  }, busy)
              }
            }),
          )
        : null,
    ),
  )
}

/** The turn tail: a card per kit file the turn changed. */
function TurnCards(props: any) {
  const data = props.turn?.data?.get?.('kitionTurn') as KitTurnData | undefined
  const sessionId = props.sessionId as string | undefined
  if (!data || !sessionId) return null
  const files = data.files.filter((file) => cardState(file, {}) !== null)
  if (files.length === 0) return null
  const open = (path: string) => {
    if (!openInSidebar(sessionId, path)) props.openFile?.(path)
  }
  return h(
    'div',
    { 'data-kition-cards': props.turn.turn, 'aria-label': environment.t('cardsLabel') },
    ...files.map((file) => h(FileCard, { key: file.path, sessionId, turn: props.turn.turn, file, open })),
  )
}

/* -------------------------------------------------------------------------------------------- */
/* While an agent edits a file that is not open: a floating window, or the file opened.          */

/**
 * Opens the review of a file's draft at a usable size: in the right sidebar (a live window the file
 * was in moves there), over its editor.
 */
function reviewInSidebar(sessionId: string, path: string) {
  const page = openPage(sessionId, path)
  if (page && page.status === 'open' && !page.floating) return page.frame.review()
  const key = `${sessionId}:${path}`
  pendingReview.add(key)
  openInSidebar(sessionId, path, 'sidebar')
  // A window moved into the sidebar keeps its page: ask it there.
  setTimeout(() => {
    const now = openPage(sessionId, path)
    if (now && now.status === 'open' && pendingReview.delete(key)) now.frame.review()
  }, 800)
}

/** Waits until the file's page is open (its editor attached to the gateway's bridge), at most `ms`. */
function whenOpen(sessionId: string, path: string, ms: number) {
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      stop()
      clearTimeout(timer)
      resolve(value)
    }
    const check = () => {
      if (openPage(sessionId, path)?.status === 'open') done(true)
    }
    const stop = subscribePages(check)
    const timer = setTimeout(() => done(false), ms)
    check()
  })
}

/**
 * The live window: the host module announces an agent's edit of a file before it runs it (an event
 * stream, /kition/api/live); this opens the file, floating beside the conversation or in the
 * sidebar, and answers once its editor is attached, so the edit runs in it and the person watches.
 * Once per file and turn: a window the person closed stays closed for the turn. Edits the host
 * does not announce (drafts, new files) open the window once they show in the turn.
 */
function LiveWatcher(props: any) {
  const timeline = props.useChat?.((snapshot: any) => snapshot.timeline)
  useEnvironment()
  const seen = React.useRef(new Set<string>())
  const sessionId = props.sessionId as string | undefined
  const current = React.useRef<{ timeline: any }>({ timeline })
  current.current.timeline = timeline
  /** The turn now running, if any. */
  const runningTurn = () => {
    const now = current.current.timeline
    for (const turnNumber of [...(now?.turnOrder ?? [])].reverse()) if (now.turns.get(turnNumber)?.status === 'open') return turnNumber as number
    return null
  }
  const show = (path: string, turn: number | null) => {
    if (!sessionId) return false
    const { liveFloat, autoOpen } = environment.settings
    if (!(liveFloat || autoOpen) || !(extensionOf(path) in KIT_EXTENSIONS)) return false
    const once = `${sessionId}:${turn ?? 'now'}:${path}`
    if (seen.current.has(once)) return false
    seen.current.add(once)
    return openInSidebar(sessionId, path, autoOpen ? 'sidebar' : 'live')
  }

  React.useEffect(() => {
    if (!sessionId) return
    const stop = new AbortController()
    const answerEditing = async (event: { id?: string; path?: string; openingMs?: number }) => {
      if (typeof event.id !== 'string' || typeof event.path !== 'string') return
      const id = event.id
      const answer = (state: string) => fetch(route('kition/api/live'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state }) }).catch(() => undefined)
      const path = event.path.replace(/^(\.\/)+/, '')
      if (openPage(sessionId, path)?.status === 'open') return void (await answer('open'))
      if (!show(path, runningTurn())) return void (await answer('none'))
      // The editor loads (the first time, its kit's engine too): the host waits longer for it.
      void answer('opening')
      const within = typeof event.openingMs === 'number' && event.openingMs > 0 ? event.openingMs - 300 : 2700
      await answer((await whenOpen(sessionId, path, within)) ? 'attached' : 'none')
    }
    void (async () => {
      for (let attempt = 0; !stop.signal.aborted; attempt++) {
        try {
          const response = await fetch(route(`kition/api/live?${new URLSearchParams({ session: sessionId })}`), { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal: stop.signal })
          if (!response.ok || !response.body) throw new Error(String(response.status))
          attempt = 0
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += value
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim()
              if (!data) continue
              let event: { id?: string; path?: string; openingMs?: number }
              try {
                event = JSON.parse(data)
              } catch {
                continue
              }
              void answerEditing(event)
            }
          }
        } catch {
          if (stop.signal.aborted) return
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
    })()
    return () => stop.abort()
  }, [sessionId])

  React.useEffect(() => {
    if (!timeline || !sessionId) return
    for (const turnNumber of timeline.turnOrder ?? []) {
      const turn = timeline.turns.get(turnNumber)
      // Only a turn now running: a conversation loaded again opens nothing.
      if (!turn || turn.status !== 'open') continue
      const data = turn.data?.get?.('kitionTurn') as KitTurnData | undefined
      for (const file of data?.files ?? []) {
        if (!file.operations.some((operation) => operation.writes && operation.phase !== 'failed')) continue
        if (openPage(sessionId, file.path)) {
          seen.current.add(`${sessionId}:${turnNumber}:${file.path}`)
          continue
        }
        show(file.path, turnNumber)
      }
    }
  }, [timeline, sessionId, environment.version])
  return null
}

/* -------------------------------------------------------------------------------------------- */
/* The person's settings, on the plugin's own page in DeepSeek Harness's plugins.               */

let settingsForm: any = null

function SettingsCard() {
  const env = useEnvironment()
  const writable = settingsForm?.getSnapshot?.()?.writable === true
  const set = (field: keyof Settings, value: unknown) => void settingsForm?.set?.(field, value)
  const row = (children: React.ReactNode[]) => h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' } }, ...children)
  if (!settingsForm) return h('div', { 'data-kition-settings': 'unavailable' }, env.t('settingsUnavailable'))
  return h(
    'div',
    { 'data-kition-settings': '', style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 0' } },
    h('strong', null, env.t('settingsTitle')),
    row([h('input', { type: 'checkbox', 'data-kition-setting': 'liveFloat', checked: env.settings.liveFloat, disabled: !writable, onChange: (event: any) => set('liveFloat', event.target.checked) }), env.t('settingLiveFloat')]),
    row([h('input', { type: 'checkbox', 'data-kition-setting': 'autoOpen', checked: env.settings.autoOpen, disabled: !writable, onChange: (event: any) => set('autoOpen', event.target.checked) }), env.t('settingAutoOpen')]),
    row([
      env.t('settingOpenWith'),
      h(
        'select',
        { 'data-kition-setting': 'openWith', value: env.settings.openWith, disabled: !writable, onChange: (event: any) => set('openWith', event.target.value) },
        h('option', { value: 'dsh' }, env.t('settingOpenWithDsh')),
        h('option', { value: 'kition' }, env.t('settingOpenWithKition')),
      ),
    ]),
  )
}

/* -------------------------------------------------------------------------------------------- */

/** DeepSeek Harness's web shortcut bindings as the editor writes keys (`Cmd+Alt+,`); none in Desktop, which routes keys itself. */
function webKeys(shortcuts: Context, mac: boolean): string[] {
  if (shortcuts?.runtime !== 'web') return []
  const names: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backquote: '`', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete' }
  const out: string[] = []
  for (const entry of shortcuts.catalog?.getSnapshot?.() ?? []) {
    const binding = entry?.binding
    if (!binding || binding.secondCode) continue
    const key = /^Key[A-Z]$/.test(binding.code) ? binding.code.slice(3) : /^Digit[0-9]$/.test(binding.code) ? binding.code.slice(5) : /^F[0-9]{1,2}$/.test(binding.code) ? binding.code : names[binding.code]
    if (!key) continue
    const modifiers: string[] = []
    for (const modifier of binding.modifiers as string[]) {
      if (modifier === 'meta') {
        if (!mac) modifiers.length = 0
        modifiers.push('Cmd')
      } else if (modifier === 'control') modifiers.push(mac ? 'Ctrl' : 'Cmd')
      else if (modifier === 'alt') modifiers.push('Alt')
      else if (modifier === 'shift') modifiers.push('Shift')
    }
    if (modifiers.some((modifier) => modifier === 'Cmd' || modifier === 'Ctrl' || modifier === 'Alt')) out.push([...modifiers, key].join('+'))
  }
  return [...new Set(out)].slice(0, 32)
}

export function apply(ctx: Context) {
  // DeepSeek Harness's theme and language, followed as they change.
  ctx.inject(['theme'], (inner: Context) => {
    const read = () => environment.set({ scheme: schemeOf(inner.theme.getTheme()) })
    read()
    inner.on('theme/change', read)
  })
  ctx.inject(['locale'], (inner: Context) => {
    inner.effect(() => inner.locale.register(NAMESPACE, { en, zh }), 'kition: words')
    const t = inner.locale.bind(NAMESPACE)
    environment.translate = (key, params) => t(key, params)
    const read = () => environment.set({ language: languageOf(inner.locale.getSnapshot()?.active) })
    read()
    inner.on('locale/change', read)
  })
  // The person's settings: the host row's Config, as DeepSeek Harness's settings edit it.
  ctx.inject(['configForms'], (inner: Context) => {
    const form = inner.configForms.get(HOST_ENTRY)
    settingsForm = form
    const read = () => {
      const value = form?.getSnapshot?.()?.value ?? {}
      environment.set({
        settings: {
          liveFloat: typeof value.liveFloat === 'boolean' ? value.liveFloat : DEFAULTS.liveFloat,
          openWith: value.openWith === 'kition' ? 'kition' : 'dsh',
          autoOpen: typeof value.autoOpen === 'boolean' ? value.autoOpen : DEFAULTS.autoOpen,
        },
      })
    }
    read()
    if (typeof form?.subscribe === 'function') inner.effect(() => form.subscribe(read), 'kition: settings')
    inner.effect(() => inner.slots.inject('plugins.bundle.config', () => inner.slots.register({ name: 'plugins.bundle.config', key: name }, SettingsCard)), 'kition: settings card')
  })
  ctx.inject(['shortcuts'], (inner: Context) => {
    const mac = /Mac|iPhone|iPad/i.test(navigator.platform)
    const read = () => environment.set({ keys: webKeys(inner.shortcuts, mac) })
    read()
    if (typeof inner.shortcuts.catalog?.subscribe === 'function') inner.effect(() => inner.shortcuts.catalog.subscribe(read), 'kition: shortcuts')
  })

  // Kition-only extensions: a right sidebar tab type.
  ctx.inject(['sidebarRightTabs'], (inner: Context) => {
    inner.effect(() => {
      const disposeBody = inner.slots.inject('sidebar.right.pane.tab', () => inner.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_TYPE }, TabBody))
      const disposeTitle = inner.slots.inject('sidebar.right.pane.tab.title', () => inner.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_TYPE }, TabTitle))
      const disposeType = inner.sidebarRightTabs.register({
        id: TAB_TYPE,
        kind: TAB_TYPE,
        patterns: TAB_EXTENSIONS.map((extension) => `*.${extension}`),
        priority: 'extension',
        canOpen: (address: string) => {
          const parsed = parseFileAddress(address)
          return parsed !== null && extensionOf(parsed.path) in KIT_FORMATS
        },
        title: (address: string) => baseName(parseFileAddress(address)?.path ?? address),
      })
      return () => {
        disposeType()
        disposeTitle()
        disposeBody()
      }
    }, 'kition: sidebar tab type')
    // The document preview's title, with a Kition preview's marks: below DeepSeek Harness's own
    // entry's priority, so both register and this one renders (the lowest does).
    inner.effect(() => inner.slots.inject('sidebar.right.pane.tab.title', () => inner.slots.register({ name: 'sidebar.right.pane.tab.title', key: TEXT_TYPE, priority: -10 }, textTitle(primitives()))), 'kition: preview title')
  })

  // Closing a tab with unsaved edits asks first (the chip's ×, the menu, Cmd+W), Kition's tabs and "Open with" previews.
  ctx.inject(['sidebarRight'], (inner: Context) => {
    environment.sidebar = inner.sidebarRight
    if (typeof inner.sidebarRight.registerCloseHandler !== 'function') return
    for (const kind of [TAB_TYPE, TEXT_KIND] as const) {
      inner.effect(() => {
        try {
          const dispose = inner.sidebarRight.registerCloseHandler(kind, closeGuard)
          guards[kind === TAB_TYPE ? 'kition' : 'text'] = true
          return () => {
            guards[kind === TAB_TYPE ? 'kition' : 'text'] = false
            dispose()
          }
        } catch {
          // Another plugin guards this kind: the view asks itself on Cmd+W.
          return () => undefined
        }
      }, `kition: close guard (${kind})`)
    }
  })

  // Leaving or reloading DeepSeek Harness's web UI with unsaved edits in a Kition page asks first:
  // the browser's own question, once, here at the top (the pages ask nothing, `closing=host`). Not
  // in Desktop (dsh-app://): Electron shows no page's question and refuses to close the window
  // instead, so the app could not be quit at all.
  if (location.protocol !== 'dsh-app:') {
    const unloadGuard = (event: BeforeUnloadEvent) => {
      if (![...pages.values()].some((page) => page.dirty)) return
      event.preventDefault()
      event.returnValue = ''
    }
    ctx.effect(() => {
      window.addEventListener('beforeunload', unloadGuard)
      return () => window.removeEventListener('beforeunload', unloadGuard)
    }, 'kition: unload guard')
  }

  // Extensions DeepSeek Harness previews: the kit under "Open with", after DeepSeek Harness's own (or first, as the person set).
  ctx.inject(['documentPreviews'], (inner: Context) => {
    for (const [kit, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
      const id = previewId(kit)
      inner.effect(() => inner.slots.inject('sidebar.right.tab.document', () => inner.slots.register({ name: 'sidebar.right.tab.document', key: id }, PreviewBody)), `kition: ${kit} preview body`)
    }
    let registered: Array<() => void> = []
    let priority: string | null = null
    const register = () => {
      const next = environment.settings.openWith === 'kition' ? 'extension' : 'builtin'
      if (next === priority) return
      priority = next
      for (const dispose of registered) dispose()
      registered = Object.entries(PREVIEW_EXTENSIONS).map(([kit, extensions]) =>
        inner.documentPreviews.register({ id: previewId(kit), extensions, priority: next, loading: 'renderer', title: () => environment.t('openWith', { kit: kitName(kit) }) }),
      )
    }
    register()
    inner.effect(() => {
      const stop = environment.subscribe(register)
      return () => {
        stop()
        for (const dispose of registered) dispose()
        registered = []
        priority = null
      }
    }, 'kition: previews')
  })

  // The turn projection, and its cards at each turn's tail.
  ctx.inject(['uiConversation'], (inner: Context) => {
    try {
      inner.uiConversation.events.register(kitTurnDefinition)
    } catch (error) {
      if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error
    }
    inner.effect(() => inner.slots.inject('conversation.chat.turnTail', () => inner.slots.register({ name: 'conversation.chat.turnTail', id: 'kition-cards' }, TurnCards)), 'kition: review cards')
    inner.effect(() => inner.slots.inject('conversation.input.dock', () => inner.slots.register({ name: 'conversation.input.dock', id: 'kition-live', order: 900 }, LiveWatcher)), 'kition: live window')
  })
}

/** The module loader's `require` (the bundle's factory parameter). */
declare const require: (name: string) => any

/** DeepSeek Harness's UI primitives (the file type's sheet), from its module loader; null where it has none. */
function primitives() {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives') ?? null
  } catch {
    return null
  }
}
