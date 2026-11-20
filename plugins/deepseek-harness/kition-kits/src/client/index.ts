/**
 * @kition/dsh-kits, the browser module: a Kition kit's file opens in the kit's own editor in
 * DeepSeek Harness's right sidebar. The editor is kition gateway's editor page (kition-sdk
 * docs/sdk/gateway-page.md), framed same-origin from the host module's /kition/ routes, so an
 * agent's kit tool calls on the open file happen in it, live, and its draft shows there for review.
 *
 * - Extensions only Kition opens (`.ktable`, `.kboard`, ...) are a right sidebar tab type: a click
 *   in the file tree opens the Kition editor.
 * - Extensions DeepSeek Harness previews itself (`.md`, `.docx`, `.xlsx`, `.pptx`, `.pdf`,
 *   `.html`) get the kit as a document preview under "Open with"; DeepSeek Harness's stays the default.
 *
 * Every service it uses is the same in DeepSeek Harness 0.2.2-rc.2 and rc.5; each is looked up
 * and left out when a host lacks it.
 */
import * as React from 'react'
import { baseName, extensionOf, parseFileAddress } from './address'
import { makeFrame, PageFrame, type Language, type PageState, type Scheme } from './frame'
import { en, fill, NAMESPACE, zh, type Key } from './i18n'
import { kitName, KIT_EXTENSIONS, PREVIEW_EXTENSIONS, TAB_EXTENSIONS } from './kits'

const h = React.createElement

export const name = '@kition/dsh-kits'
export const inject = ['slots']

/** The tab type's id and kind, and the slot key of its body and title. */
export const TAB_TYPE = 'kition'
const previewId = (kit: string) => `kition/${kit}`

/* -------------------------------------------------------------------------------------------- */
/* What every tab shares: DeepSeek Harness's theme and language, and each tab's page state.     */

type Context = any // DeepSeek Harness's client context (cordis): services looked up by name.

class Environment {
  private listeners = new Set<() => void>()
  scheme: Scheme = 'light'
  language: Language = 'en'
  translate: ((key: string, params?: Record<string, string>) => string) | null = null

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(changes: Partial<Pick<Environment, 'scheme' | 'language'>>) {
    Object.assign(this, changes)
    for (const listener of [...this.listeners]) listener()
  }

  t(key: Key, params: Record<string, string> = {}) {
    const bound = this.translate?.(key, params)
    if (bound && bound !== key) return bound
    return fill((this.language === 'zh' ? zh : en)[key], params)
  }
}

const environment = new Environment()

/** Each open Kition view's page state, by tab id, for its title and its close guard. */
const pages = new Map<string, PageState & { name: string }>()
const pageListeners = new Set<() => void>()
function setPage(tabId: string, state: (PageState & { name: string }) | null) {
  if (state) pages.set(tabId, state)
  else pages.delete(tabId)
  for (const listener of [...pageListeners]) listener()
}
const subscribePages = (listener: () => void) => {
  pageListeners.add(listener)
  return () => pageListeners.delete(listener)
}

const schemeOf = (snapshot: any): Scheme => (snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light')
const languageOf = (active: unknown): Language => (typeof active === 'string' && active.toLowerCase().startsWith('zh') ? 'zh' : 'en')

/* -------------------------------------------------------------------------------------------- */
/* The view: asks the host module for the page's address, then frames it.                       */

type Opened = { phase: 'opening' } | { phase: 'open'; page: string } | { phase: 'failed'; error: string; message: string }

/** The host module's route `path`, relative to where DeepSeek Harness is served. */
const route = (path: string) => new URL(path, document.baseURI).href

/** Asks the host module to open the file: its gateway started, the page's address. */
async function open(sessionId: string, path: string): Promise<Opened> {
  try {
    const response = await fetch(route(`kition/api/open?${new URLSearchParams({ session: sessionId, path })}`), { credentials: 'same-origin', cache: 'no-store' })
    const answer = await response.json().catch(() => ({}))
    if (response.ok && typeof answer.page === 'string') return { phase: 'open', page: answer.page }
    return { phase: 'failed', error: String(answer.error ?? `http-${response.status}`), message: String(answer.message ?? response.statusText) }
  } catch (error) {
    return { phase: 'failed', error: 'unreachable', message: (error as Error).message }
  }
}

/** Gives DeepSeek Harness a shortcut pressed in the editor (in the web UI its keys are heard on the top window only). */
function forwardShortcut(key: { key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) {
  const init = { key: key.key, code: key.code, metaKey: !!key.meta, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, altKey: !!key.alt, bubbles: true, cancelable: true }
  document.body.dispatchEvent(new KeyboardEvent('keydown', init))
  document.body.dispatchEvent(new KeyboardEvent('keyup', init))
}

function useEnvironment() {
  React.useSyncExternalStore(environment.subscribe, () => `${environment.scheme}:${environment.language}`)
  return environment
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

const code = (text: string) => h('code', { style: { userSelect: 'all', padding: '6px 8px', borderRadius: '4px', background: 'rgba(127,127,127,0.15)', fontSize: '12px', overflowWrap: 'anywhere' } }, text)

type ViewProps = {
  address: string
  /** The session the tab belongs to, for a file named by its absolute path. */
  sessionId?: string
  tabId: string
  /** Closes the tab (DeepSeek Harness asks the close guard first for a Kition tab). */
  close?: () => void
  /** Whether closing asks here (an "Open with" preview, whose tab kind is DeepSeek Harness's). */
  guardClose: boolean
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
  const frameRef = React.useRef<PageFrame | null>(null)
  const latest = React.useRef(props)
  latest.current = props

  React.useEffect(() => {
    if (!sessionId || !path) return
    let current = true
    setOpened({ phase: 'opening' })
    void open(sessionId, path).then((result) => current && setOpened(result))
    return () => {
      current = false
    }
  }, [sessionId, path, attempt])

  React.useEffect(() => {
    if (opened.phase !== 'open' || !host.current) return
    const url = new URL(opened.page, document.baseURI)
    url.searchParams.set('theme', environment.scheme)
    url.searchParams.set('locale', environment.language)
    const frame = makeFrame(props.tabId, url.href, `Kition ${fileName}`)
    const page = new PageFrame(
      frame,
      {
        change: (state) => {
          setPage(props.tabId, { ...state, name: fileName })
          if (state.status === 'open') latest.current.onOpen?.()
        },
        shortcut: forwardShortcut,
        requestClose: (dirty) => {
          if (latest.current.guardClose && dirty && !window.confirm(environment.t('closeDirty', { name: fileName }))) return
          latest.current.close?.()
        },
      },
      environment.scheme,
      environment.language,
    )
    frameRef.current = page
    setPage(props.tabId, { ...page.state, name: fileName })
    const stop = environment.subscribe(() => {
      page.setTheme(environment.scheme)
      page.setLanguage(environment.language)
    })
    host.current.replaceChildren(frame)
    return () => {
      stop()
      page.dispose()
      frameRef.current = null
      frame.remove()
      setPage(props.tabId, null)
    }
  }, [opened, props.tabId, fileName])

  if (!sessionId || !path) return h(Panel, { state: 'no-session', title: env.t('noSession') })
  if (opened.phase === 'opening') return h(Panel, { state: 'starting', title: env.t('starting'), detail: env.t('startingDetail') })
  if (opened.phase === 'failed') {
    const retry = () => setAttempt((n) => n + 1)
    if (opened.error === 'kition-missing' || opened.error === 'kition-invalid')
      return h(
        Panel,
        { state: 'kition-missing', title: env.t('missingTitle'), detail: env.t('missingDetail'), onRetry: retry },
        code('npm install -g @kition/cli'),
        h('div', { style: { opacity: 0.8 } }, env.t('missingOr')),
        code('curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh'),
        opened.error === 'kition-invalid' ? h('div', { style: { opacity: 0.7, fontSize: '12px' } }, opened.message) : null,
      )
    if (opened.error === 'outside-workspace') return h(Panel, { state: 'outside-workspace', title: env.t('outsideTitle'), detail: env.t('outsideDetail') })
    return h(Panel, { state: 'unreachable', title: env.t('unreachableTitle'), detail: env.t('unreachableDetail'), onRetry: retry }, h('div', { style: { opacity: 0.7, fontSize: '12px' } }, opened.message))
  }
  return h('div', { ref: host, 'data-kition-view': '', style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, WebkitAppRegion: 'no-drag' } })
}

/* -------------------------------------------------------------------------------------------- */
/* DeepSeek Harness's slots: the tab body and title, and the document preview body.             */

function TabBody(props: any) {
  const info = props.useTabInfo()
  return h(KitionView, { address: info.tab.contentId, sessionId: props.sessionId, tabId: info.tab.id, close: () => info.tab.actions?.close?.(), guardClose: false })
}

/** The tab's title: the file's name, `●` while it has unsaved edits, and a mark while an agent's draft waits. */
function TabTitle(props: any) {
  const env = useEnvironment()
  const info = props.useTabInfo()
  React.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id))
  const page = pages.get(info.tab.id)
  return h(
    React.Fragment,
    null,
    info.tab.title,
    page?.dirty ? h('span', { 'data-kition-dirty': '', 'aria-label': 'unsaved', style: { marginLeft: '4px' } }, '●') : null,
    page?.draft ? h('span', { 'data-kition-draft': page.draft.state, title: env.t('draftTitle'), style: { marginLeft: '6px', fontSize: '10px', padding: '0 4px', borderRadius: '6px', whiteSpace: 'nowrap', background: 'rgba(255,170,0,0.25)' } }, env.t('draft')) : null,
  )
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
    guardClose: true,
    onOpen: () => {
      if (loaded.current || content?.kind !== 'renderer') return
      loaded.current = true
      content.loaded(String(content.revision))
    },
  })
}

/* -------------------------------------------------------------------------------------------- */

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
          return parsed !== null && extensionOf(parsed.path) in KIT_EXTENSIONS
        },
        title: (address: string) => baseName(parseFileAddress(address)?.path ?? address),
      })
      return () => {
        disposeType()
        disposeTitle()
        disposeBody()
      }
    }, 'kition: sidebar tab type')
  })

  // Closing a tab with unsaved edits asks first (the chip's ×, the menu, Cmd+W).
  ctx.inject(['sidebarRight'], (inner: Context) => {
    if (typeof inner.sidebarRight.registerCloseHandler !== 'function') return
    inner.effect(
      () =>
        inner.sidebarRight.registerCloseHandler(TAB_TYPE, (_session: string, tab: { id: string }) => {
          const page = pages.get(tab.id)
          if (page?.dirty && !window.confirm(environment.t('closeDirty', { name: page.name }))) throw new Error('Kition: the tab keeps its unsaved edits')
        }),
      'kition: close guard',
    )
  })

  // Extensions DeepSeek Harness previews: the kit under "Open with", after DeepSeek Harness's own.
  ctx.inject(['documentPreviews'], (inner: Context) => {
    for (const [kit, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
      const id = previewId(kit)
      inner.effect(
        () =>
          inner.documentPreviews.register({
            id,
            extensions,
            priority: 'builtin',
            loading: 'renderer',
            title: () => environment.t('openWith', { kit: kitName(kit) }),
          }),
        `kition: ${kit} preview`,
      )
      inner.effect(() => inner.slots.inject('sidebar.right.tab.document', () => inner.slots.register({ name: 'sidebar.right.tab.document', key: id }, PreviewBody)), `kition: ${kit} preview body`)
    }
  })
}
