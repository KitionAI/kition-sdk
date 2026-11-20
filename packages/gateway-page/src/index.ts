/**
 * The editor page `kition gateway` serves (`/page/`), as a host that frames it sees it: the
 * addresses it is opened at, and the `postMessage` protocol it speaks with the window that frames
 * it (`docs/sdk/gateway-page.md`). The page itself is built from `src/page/` into the gateway's
 * binary; this module is what an embedding host (DeepSeek Harness's Kition module) imports.
 *
 * Every message either way is an object with `kitionGatewayPage: 1` and a `type`. The page posts
 * only to `window.parent`, only with the target origin of its own address, and only when it is
 * framed; it takes messages only from `window.parent` and only from its own origin (a same-origin
 * proxy puts both on one origin). Standalone, it posts nothing and works alone.
 */

/** The protocol's version, the value of every message's `kitionGatewayPage`. */
export const GATEWAY_PAGE_PROTOCOL = 1

/** What the page shows. */
export type GatewayPageView = 'editor' | 'review'

/**
 * The editor's state: `opening` (reading the file, loading the editor), `downloading` (installing
 * the kit's editor package, with `progress`), `open`, `missing` (no such file), `no-kit` (no kit
 * edits this type), `not-installed` (the kit's editor cannot be installed: the index offers none),
 * `unreachable` (the gateway does not answer, or the page's session ended), `failed` (the kit could
 * not open the file; `detail` says why).
 */
export type GatewayPageStatus = 'opening' | 'downloading' | 'open' | 'missing' | 'no-kit' | 'not-installed' | 'unreachable' | 'failed'

/** A key pressed in the kit that the kit leaves to its host (Kit UI protocol `host/shortcut`). */
export type GatewayPageKey = { key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }

/** The agent's headless draft of the open file, as the review lists it; `null`: none. */
export type GatewayPageDraft = { state: 'open' | 'ready'; stale: boolean; updated: number | null } | null

/** What the page tells the window that frames it. */
export type GatewayPageMessage =
  /** Once, when the page has read its address and listens for messages. */
  | { kitionGatewayPage: 1; type: 'ready'; view: GatewayPageView; path: string | null }
  /** The editor's state; `title` is the file's name, `kit` the kit's id once chosen. */
  | {
      kitionGatewayPage: 1
      type: 'state'
      path: string
      title: string
      kit: string | null
      status: GatewayPageStatus
      dirty: boolean
      /** The kit only views the file's type: the editor shows it read-only. */
      readOnly?: boolean
      progress?: { done: number; total: number }
      detail?: string
    }
  /** A host shortcut pressed in the kit (Cmd+W, Cmd+N, ...): the host acts on it. */
  | { kitionGatewayPage: 1; type: 'shortcut'; key: GatewayPageKey }
  /** The person asked to close the file (Cmd+W in the editor): the host closes the tab, asking first when `dirty`. */
  | { kitionGatewayPage: 1; type: 'request-close'; path: string; dirty: boolean }
  /** The agent's draft of the file changed (made, edited, ready, merged, discarded). */
  | { kitionGatewayPage: 1; type: 'draft'; path: string; draft: GatewayPageDraft }
  /** The person merged (`merged`) or discarded the draft in the review. */
  | { kitionGatewayPage: 1; type: 'reviewed'; path: string; outcome: 'merged' | 'discarded' }
  /** The answer to a `save`. */
  | { kitionGatewayPage: 1; type: 'saved'; path: string; saved: boolean; error?: string }

/** What the window that frames the page may tell it. */
export type GatewayPageCommand =
  /** The colour scheme to show, the editor's included. */
  | { kitionGatewayPage: 1; type: 'theme'; theme: 'light' | 'dark' }
  /** The language to show, the editor's included. */
  | { kitionGatewayPage: 1; type: 'locale'; locale: 'en' | 'zh' }
  /** Save the open file now; the page answers `saved`. */
  | { kitionGatewayPage: 1; type: 'save' }
  /** Give the editor the keyboard focus. */
  | { kitionGatewayPage: 1; type: 'focus' }
  /** Open the review of the agent's draft of the file over the editor. */
  | { kitionGatewayPage: 1; type: 'review' }

/** Whether `data` is a message of this protocol (either way). */
export function isGatewayPageMessage(data: unknown): data is GatewayPageMessage | GatewayPageCommand {
  return typeof data === 'object' && data !== null && (data as { kitionGatewayPage?: unknown }).kitionGatewayPage === GATEWAY_PAGE_PROTOCOL && typeof (data as { type?: unknown }).type === 'string'
}

/**
 * The page's address under `prefix` (where a same-origin proxy serves the gateway, `/kition/` for
 * example; `/` for the gateway itself) for the workspace file `path`: `<prefix>page/?path=...`, or
 * the review of its draft, `<prefix>page/review?path=...`. `theme` and `locale` set what it shows
 * first (`theme=light|dark`, `locale=en|zh`); `keys` are host shortcuts the editor leaves to the host
 * besides the page's own (`keys=Cmd+Alt+, Cmd+Alt+W`); `focus: false` (`focus=no`) opens the editor
 * without taking the keyboard focus (a window the person watches while typing elsewhere).
 */
export function gatewayPageAddress(prefix: string, path: string, options: { view?: GatewayPageView; theme?: 'light' | 'dark'; locale?: 'en' | 'zh'; keys?: string[]; focus?: boolean } = {}) {
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  const query = new URLSearchParams({ path })
  if (options.theme) query.set('theme', options.theme)
  if (options.locale) query.set('locale', options.locale)
  if (options.keys?.length) query.set('keys', options.keys.join(' '))
  if (options.focus === false) query.set('focus', 'no')
  return `${base}page/${options.view === 'review' ? 'review' : ''}?${query.toString()}`
}
