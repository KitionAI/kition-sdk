/**
 * The editor page's frame in a DeepSeek Harness tab and the host's side of its `postMessage`
 * protocol (kition-sdk docs/sdk/gateway-page.md): it tells the page the theme and the language,
 * and hears its state (title, dirty mark, draft), its shortcuts and its requests to close.
 */
import { GATEWAY_PAGE_PROTOCOL, isGatewayPageMessage, type GatewayPageCommand, type GatewayPageDraft, type GatewayPageKey, type GatewayPageMessage } from '@kition/gateway-page'

export type Scheme = 'light' | 'dark'
export type Language = 'en' | 'zh'

/** What the tab shows of the page: its last `state`, and its draft. */
export type PageState = {
  ready: boolean
  title: string | null
  kit: string | null
  status: string | null
  dirty: boolean
  draft: GatewayPageDraft
  progress?: { done: number; total: number }
  detail?: string
}

export type FrameEvents = {
  /** The page's state changed (`ready`, `state`, `draft`, `reviewed`). */
  change: (state: PageState) => void
  /** A host shortcut pressed in the editor (Cmd+W aside: that is `requestClose`). */
  shortcut: (key: GatewayPageKey) => void
  /** The person pressed Cmd+W in the editor. */
  requestClose: (dirty: boolean) => void
  /** The answer to `save()`. */
  saved: (saved: boolean, error?: string) => void
}

/**
 * The name DeepSeek Harness gives the frame of a sidebar tab's HTML preview. Its keyboard
 * shortcuts reach a frame only when the frame carries this name and a `data-html-preview`
 * attribute from the moment it is made (setting them later has no effect).
 */
export const frameName = (tabId: string) => `dsh-sidebar-html-${tabId}`

/** Makes the page's frame for the tab `tabId` at `src`. */
export function makeFrame(tabId: string, src: string, title: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.name = frameName(tabId)
  frame.setAttribute('data-html-preview', '')
  frame.setAttribute('data-kition-page', '')
  frame.title = title
  frame.allow = 'clipboard-read; clipboard-write; fullscreen'
  frame.style.cssText = 'flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 0; display: block; -webkit-app-region: no-drag'
  frame.src = src
  return frame
}

/** The host's side of the protocol with one page frame. */
export class PageFrame {
  readonly state: PageState = { ready: false, title: null, kit: null, status: null, dirty: false, draft: null }
  private readonly listener: (event: MessageEvent) => void

  constructor(
    readonly frame: HTMLIFrameElement,
    private readonly events: Partial<FrameEvents>,
    private scheme: Scheme,
    private language: Language,
  ) {
    this.listener = (event) => this.receive(event)
    window.addEventListener('message', this.listener)
  }

  /** The page's origin is the host's (a same-origin proxy): its messages come from there. */
  private receive(event: MessageEvent) {
    if (event.source !== this.frame.contentWindow) return
    if (event.origin !== location.origin && !(event.origin === 'null' || location.origin === 'null')) return
    if (!isGatewayPageMessage(event.data)) return
    const message = event.data as GatewayPageMessage
    switch (message.type) {
      case 'ready':
        this.state.ready = true
        // The page read theme and locale from its address; they may have changed since.
        this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'theme', theme: this.scheme })
        this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'locale', locale: this.language })
        break
      case 'state':
        Object.assign(this.state, { title: message.title, kit: message.kit, status: message.status, dirty: message.dirty, progress: message.progress, detail: message.detail })
        break
      case 'draft':
        this.state.draft = message.draft
        break
      case 'reviewed':
        this.state.draft = null
        break
      case 'shortcut':
        // Cmd+W comes as request-close as well, which asks first when there are unsaved edits.
        if (!(message.key.code === 'KeyW' && (message.key.meta || message.key.ctrl))) this.events.shortcut?.(message.key)
        return
      case 'request-close':
        this.events.requestClose?.(message.dirty)
        return
      case 'saved':
        this.events.saved?.(message.saved, message.error)
        return
    }
    this.events.change?.({ ...this.state })
  }

  private send(command: GatewayPageCommand) {
    const target = location.origin && location.origin !== 'null' ? location.origin : '*'
    this.frame.contentWindow?.postMessage(command, target)
  }

  setTheme(scheme: Scheme) {
    if (scheme === this.scheme) return
    this.scheme = scheme
    if (this.state.ready) this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'theme', theme: scheme })
  }

  setLanguage(language: Language) {
    if (language === this.language) return
    this.language = language
    if (this.state.ready) this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'locale', locale: language })
  }

  save() {
    this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'save' })
  }

  focus() {
    this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'focus' })
  }

  dispose() {
    window.removeEventListener('message', this.listener)
  }
}
