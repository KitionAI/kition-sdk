/**
 * The panel page's only script (bundled into `sandbox/panel.html` by scripts/build-runtime.mjs and
 * allowed by its hash). The host posts it the panel's HTML, the extension's `connect-src`, the
 * host's theme, and the panel's end of a channel to the extension's worker. It adds the
 * `connect-src` policy, gives the panel `kitionPanel` (`request`, `onMessage`, `info`), and then
 * shows the panel's HTML, running its inline scripts in order as blob scripts (the page's CSP
 * allows nothing else).
 */
import { PANEL_TAG, type PanelInfo, type PanelStart } from '../protocol'
import { RpcPeer, type PortLike } from '../rpc'

/** A CSP source list the host may give: `'none'`, or origins (as `connectSources` writes them). */
const SOURCE = /^(?:'none'|(?:(?:https|wss|http|ws):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)(?: (?:https|wss|http|ws):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)*)$/
const THEME_NAME = /^--[a-zA-Z0-9-]{1,64}$/
/** Script types that are JavaScript; anything else (`application/json`, …) stays an inert data block. */
const JAVASCRIPT = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'])

type Listener = (message: unknown) => void

/** What the panel's scripts get as `window.kitionPanel`. */
export type KitionPanel = {
  readonly info: PanelInfo
  /** Asks the extension's worker (its `panel.onRequest` handler); answers what it answers. */
  request(message: unknown): Promise<unknown>
  /** Hears what the worker sends (`panel.post(message)`); answers an unsubscribe. */
  onMessage(listener: Listener): () => void
}

function addPolicy(content: string) {
  const policy = document.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = content
  document.head.appendChild(policy)
}

function applyTheme(theme: unknown) {
  if (!theme || typeof theme !== 'object') return
  for (const [name, value] of Object.entries(theme as Record<string, unknown>)) {
    if (THEME_NAME.test(name) && typeof value === 'string' && value.length <= 300) document.documentElement.style.setProperty(name, value)
  }
}

/**
 * Shows the panel's HTML: its head's styles and its body, then its inline classic scripts, in
 * document order. A script with `src` or of type `module` is left out: a panel is one
 * self-contained file of classic scripts.
 */
function render(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const scripts: string[] = []
  for (const script of [...parsed.querySelectorAll('script')]) {
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase()
    if (!JAVASCRIPT.has(type)) {
      // A data block: kept as is, never run.
      if (type !== 'module') continue
      console.warn('[kition-panel] module scripts do not run in a panel; bundle them into a classic script')
      script.remove()
      continue
    }
    if (script.hasAttribute('src')) {
      console.warn('[kition-panel] scripts with src do not run in a panel; put the code inline')
      script.remove()
      continue
    }
    const placeholder = parsed.createElement('template')
    placeholder.dataset.kitionScript = String(scripts.length)
    scripts.push(script.textContent ?? '')
    script.replaceWith(placeholder)
  }
  // Nothing that navigates or rebases the page.
  for (const element of [...parsed.querySelectorAll('base, meta[http-equiv="refresh" i]')]) element.remove()
  for (const attribute of [...parsed.documentElement.attributes]) document.documentElement.setAttribute(attribute.name, attribute.value)
  for (const child of [...parsed.head.childNodes]) document.head.appendChild(document.importNode(child, true))
  document.body.replaceWith(document.importNode(parsed.body, true))
  for (const placeholder of [...document.querySelectorAll<HTMLTemplateElement>('template[data-kition-script]')]) {
    const script = document.createElement('script')
    script.async = false
    script.src = URL.createObjectURL(new Blob([scripts[Number(placeholder.dataset.kitionScript)]], { type: 'text/javascript' }))
    script.addEventListener('load', () => URL.revokeObjectURL(script.src), { once: true })
    placeholder.replaceWith(script)
  }
}

let started = false
addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Partial<PanelStart> | null
  if (started || event.source !== parent || !data || data.tag !== PANEL_TAG || data.type !== 'start') return
  const port = event.ports[0]
  const info = data.info
  if (!port || typeof data.html !== 'string' || typeof data.connect !== 'string' || !SOURCE.test(data.connect) || !info || typeof info !== 'object') return
  started = true
  addPolicy(`connect-src ${data.connect}`)
  applyTheme(data.theme)
  if (typeof info.locale === 'string') document.documentElement.lang = info.locale
  const peer = new RpcPeer(port as unknown as PortLike)
  const listeners = new Set<Listener>()
  peer.handle('panel/message', (message: unknown) => {
    for (const listener of [...listeners]) {
      try {
        listener(message)
      } catch (error) {
        console.error('[kition-panel] a message listener failed', error)
      }
    }
  })
  const panel: KitionPanel = Object.freeze({
    info: Object.freeze({ extension: String(info.extension), panel: String(info.panel), documentId: String(info.documentId), title: String(info.title), ...(typeof info.locale === 'string' ? { locale: info.locale } : {}) }),
    request: (message: unknown) => peer.request('panel/request', message),
    onMessage: (listener: Listener) => {
      if (typeof listener !== 'function') throw new TypeError('onMessage takes a function')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  })
  Object.defineProperty(window, 'kitionPanel', { value: panel, enumerable: true })
  render(data.html)
})
