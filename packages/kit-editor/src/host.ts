/**
 * The kit's side of the Kit UI protocol (Kition platform docs/platform/reference/ui-protocol.md): wait for the host's port, take
 * `ui/initialize`, and offer the host's file calls as a `KitHost` the engine hooks use.
 */
import {
  KIT_UI_PROTOCOL,
  KitPeer,
  isArrayBuffer,
  isHandshake,
  isHello,
  matchesShortcut,
  HOST_SERVICE_CAPABILITY_PREFIX,
  KitRpcError,
  parseCommentAnchor,
  parseDocumentPermissions,
  parseKitView,
  parseWatermark,
  type InitializeParams,
  type KitCommentAnchor,
  type KitDocumentPermissions,
  type KitHostService,
  type KitHostServices,
  type KitShownThread,
  type KitLinksPickParams,
  type KitNotifications,
  type KitPickedLink,
  type KitSidePeer,
  type KitTheme,
  type KitView,
  type KitWatermark,
} from '@kition/kit-ui-protocol'
import { brandTokens, validBrand, type KitBrand } from './brand'
import { validDisplay, type KitDisplay } from './frame/modes'
import type { KitHost } from './engine/kitHost'
import { createFilesClient, type KitFilesClient } from './files'
import { parseUiConfig } from './uiConfig'
import { createUiStore, type UiStore } from './uiStore'
import type { KitUiDeclaration } from './uiCatalog'

export type { InitializeParams, KitTheme }

/** The kit's connection to its host. */
export type HostConnection = {
  peer: KitSidePeer
  init: InitializeParams
  /** The document's file, through the host; with its stored replica when `replica`. */
  files: KitHost
  /**
   * Files beyond the document, through handles the host grants (KitFiles 1.0, protocol section
   * 7g): pick, create, read, write in chunks, list, print, and an engine's outputs (E16).
   */
  kitFiles: KitFilesClient
  /** The host keeps replicas and the kit declared `replica`: it serves `replica/*` too. */
  replica: boolean
  /**
   * The document is read-only for this session (`document.readOnly`): the kit refuses edits
   * with the reason `read-only`. It never changes; a host reopens the kit to change it. Absent: false.
   */
  readOnly?: boolean
  /**
   * Where in the document to show first (`document.view`, protocol section 2),
   * checked; null when the host named none. The kit shows it once its document is open, or ignores it.
   */
  view: KitView | null
  /**
   * What the person may take out of the document (`document.permissions`): the kit
   * hides Download, Export and Print, and Share controls whose flag is false. All true when the
   * host sent none.
   */
  permissions: KitDocumentPermissions
  /** The text to draw over the canvas (`document.watermark`), checked; null for none. */
  watermark: KitWatermark | null
  /**
   * Hears the host's `document/reveal` (section 7i, OP3): show `view` in the open document. The
   * view is checked; malformed ones are dropped. Answers an unsubscribe.
   */
  onReveal: (listener: (view: KitView) => void) => () => void
  /** The UI configuration (protocol section 9). */
  ui: UiStore
  /** The kit's brand color, from its kit.json (standard U5b). */
  brand: KitBrand | null
  /** The kit, as it named itself to `connectHost`: its id keys the person's display mode. */
  kit: { id: string; version: string }
  /** The kit's default display mode, from its kit.json `ui.display` (platform U5c); null when it names none. */
  display: KitDisplay | null
  /** The kit's declared elements; null when it does not honor UI configuration. */
  declaration: KitUiDeclaration | null
  /**
   * Tells the host the kit opened the document; answers `ui/initialize`. `extra` are capabilities
   * known only once the document's engine runs (`model`).
   */
  opened: (extra?: string[]) => void
  /** Tells the host the document could not be opened. */
  failed: (error: unknown) => void
  changed: (state: KitNotifications['document/changed']) => void
  notify: (notice: KitNotifications['host/notify']) => void
  openAgent: (prompt?: string) => Promise<void>
  pick: (purpose: string, accept: string[]) => Promise<string | null>
  /**
   * Asks the person for existing workspace files to link (`links/pick`, capability `links-pick`,
   * section 7i; UI-N2): the host copies nothing and answers each by its path relative to the
   * document's folder, which the kit then reads with `files.read` and `files.stamp` (UI-N3).
   * Send it only from a person's gesture; none when the person cancels.
   */
  pickLinks: (params: KitLinksPickParams) => Promise<KitPickedLink[]>
  /**
   * Writes a new file next to the document (an export, a rendered movie): the host keeps
   * existing files and may change the name to an unused one; answers the path it wrote.
   */
  exportFile: (path: string, bytes: Uint8Array) => Promise<string>
  /** Whether the host serves `service` (capability `service:<id>`, protocol section 7k). */
  hasService: (service: KitHostService) => boolean
  /**
   * Asks the host for one of its services (`host/service`, section 7k; managed co-editing D4):
   * only from a person's gesture (UI-V1), and only for a service it serves; one it does not is
   * refused here (`-32000`, reason `not-allowed`) without asking. A kit with a host service shows
   * no version of its own (UI-V2).
   */
  service: <S extends KitHostService>(service: S, params: KitHostServices[S][0]) => Promise<KitHostServices[S][1]>
  /** The host keeps comment threads itself and marks them through the kit (capability `comment-anchors`). */
  commentAnchors: boolean
  /** Hears the host's threads to mark (`comments/show`), checked: the whole list each time. Answers an unsubscribe. */
  onComments: (listener: (threads: KitShownThread[]) => void) => () => void
  /** Tells the host the person clicked a thread's marker (`comments/activated`). */
  activateComment: (id: string) => void
  /** Answers the host's `comments/locate` with `locate`: whether each anchor is found in the document now. */
  locateComments: (locate: (anchors: KitCommentAnchor[]) => boolean[] | Promise<boolean[]>) => void
  /** Removes the window listeners. */
  close: () => void
}

const BRAND_TOKENS = ['--kit-primary', '--kit-primary-text', '--kit-primary-soft']

/**
 * Applies the host's theme tokens to the document root (protocol section 4), then the kit's
 * brand over the primary tokens unless the host keeps its own (`theme.brand: "host"`, section 9).
 * Clears a previous brand's tokens first, so a later `theme.brand: "host"` does not leave them
 * stale under the host's own primary tokens.
 */
export function applyTheme(theme: KitTheme, brand: KitBrand | null = null, root: HTMLElement = document.documentElement) {
  if (root.dataset.brand === 'kit') for (const name of BRAND_TOKENS) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (name.startsWith('--')) root.style.setProperty(name, value)
  }
  const branded = brand !== null && theme.brand !== 'host'
  if (branded) for (const [name, value] of Object.entries(brandTokens(brand, theme.colorScheme))) root.style.setProperty(name, value)
  root.dataset.brand = branded ? 'kit' : 'host'
  root.style.colorScheme = theme.colorScheme
  root.dataset.colorScheme = theme.colorScheme
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)

/**
 * Waits for the host's handshake and its `ui/initialize`. The kit then opens the document and
 * calls `opened()` (or `failed()`), which answers the host. Options name the kit; `brand` is its
 * kit.json `ui.brand`, `display` its `ui.display`, and `ui` its declared elements (with it, the kit
 * honors UI configuration).
 * Passing `ui` requires the editor to mount `KitEditorProvider`, which answers `ui/elements`.
 */
export function connectHost(kit: { id: string; version: string; capabilities?: string[]; brand?: KitBrand; ui?: KitUiDeclaration; display?: string }): Promise<HostConnection> {
  return new Promise((resolve) => {
    // This document's id: the host answers our `ready` with a handshake naming it.
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const announce = () => window.parent.postMessage({ kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id }, '*')
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      // A host that started listening after we announced asks again.
      if (isHello(event.data) && event.data.hello === KIT_UI_PROTOCOL) {
        announce()
        return
      }
      if (!isHandshake(event.data) || event.data.protocol !== KIT_UI_PROTOCOL || !event.ports[0]) return
      if (event.data.id != null && event.data.id !== id) return
      window.removeEventListener('message', onMessage)
      const peer: KitSidePeer = new KitPeer(event.ports[0], 'k')
      peer.handle('ui/initialize', (init) =>
        new Promise((answer, refuse) => {
          // The document's own bytes come with the request; the first read of its path uses them.
          let initial: ArrayBuffer | null = init.document.bytes ?? null
          const replica = init.capabilities.includes('replica') && (kit.capabilities ?? []).includes('replica')
          // Checkpoints name versions of the stored replica: only for a kit that keeps one there.
          const checkpoints = replica && init.capabilities.includes('checkpoints')
          const files: KitHost = {
            read: async (path) => {
              if (initial && path === init.document.path) {
                const bytes = initial
                initial = null
                return { bytes, stamp: init.document.version ?? null }
              }
              const read = await peer.request('host/read', { path })
              return { bytes: read.bytes, stamp: read.version }
            },
            stamp: async (path) => (await peer.request('host/stamp', { path })).version,
            write: async (path, bytes, expected) => {
              const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
              return (await peer.request('host/write', { path, bytes: copy, mode: 'save', ...(expected === undefined ? {} : { expected }) }, { transfer: true })).version || null
            },
            lend: () => init.document.lend ?? null,
          }
          if (replica) {
            files.replicaRead = async (path) => {
              const stored = await peer.request('host/replicaRead', { path })
              return stored && stored.snapshot instanceof ArrayBuffer && stored.blobs instanceof ArrayBuffer && typeof stored.fileStamp === 'string' ? stored : null
            }
            files.replicaWrite = async (path, stored, checkpoint) => {
              const answer = await peer.request('host/replicaWrite', { path, ...stored, ...(checkpoint && checkpoints ? { checkpoint } : {}) }, { transfer: true })
              return answer?.checkpoint ?? null
            }
            if (checkpoints) {
              files.checkpoints = {
                list: async (path, options = {}) => {
                  const answer = await peer.request('host/checkpointList', { path, ...options })
                  return { checkpoints: Array.isArray(answer?.checkpoints) ? answer.checkpoints : [], more: answer?.more === true }
                },
                update: async (path, id, fields) => (await peer.request('host/checkpointUpdate', { path, id, ...fields })).checkpoint,
                delete: async (path, id) => {
                  await peer.request('host/checkpointDelete', { path, id })
                },
                read: (path, id, options = {}) => peer.request('host/checkpointRead', { path, id, ...(options.state ? { state: true } : {}) }),
              }
            }
          }
          if (init.capabilities.includes('view-state')) {
            files.viewState = {
              read: async (path) => {
                const answer = await peer.request('host/viewStateRead', { path })
                const state = answer && typeof answer.state === 'object' && !Array.isArray(answer.state) ? answer.state : null
                return state && isArrayBuffer(answer.bytes) ? { state, bytes: answer.bytes } : { state }
              },
              write: async (path, value) => {
                const bytes = value.bytes ? value.bytes.slice(0) : undefined
                await peer.request('host/viewStateWrite', { path, state: value.state, ...(bytes ? { bytes } : {}) }, { transfer: true })
              },
            }
          }
          // The brand comes from kit.json, so it is checked at runtime.
          const brand = validBrand(kit.brand)
          applyTheme(init.theme, brand)
          const ui = createUiStore(
            parseUiConfig(init.ui),
            init.capabilities.includes('customize') ? async (hide) => void (await peer.request('host/customize', { personal: { hide } })) : null,
            (params) => peer.notify('ui/action', params),
          )
          // Malformed params (no object) configure nothing rather than throw.
          peer.on('ui/configure', (params) => ui.replace(parseUiConfig(params?.ui)))
          document.documentElement.lang = init.locale
          const shortcuts = init.shortcuts
          const onKey = (key: KeyboardEvent) => {
            if (!shortcuts.some((shortcut) => matchesShortcut(shortcut, key, isMac()))) return
            key.preventDefault()
            key.stopPropagation()
            peer.notify('host/shortcut', { key: key.key, code: key.code, meta: key.metaKey, ctrl: key.ctrlKey, shift: key.shiftKey, alt: key.altKey })
          }
          window.addEventListener('keydown', onKey, true)
          peer.on('ui/theme', ({ theme }) => applyTheme(theme, brand))
          peer.on('ui/locale', ({ locale }) => {
            document.documentElement.lang = locale
          })
          resolve({
            peer,
            init,
            files,
            kitFiles: createFilesClient(peer, init.capabilities),
            replica,
            readOnly: init.document.readOnly === true,
            view: parseKitView(init.document.view),
            permissions: parseDocumentPermissions(init.document.permissions),
            watermark: parseWatermark(init.document.watermark),
            onReveal: (listener) =>
              peer.on('document/reveal', (params) => {
                const view = parseKitView(params?.view)
                if (view) listener(view)
              }),
            ui,
            brand,
            kit: { id: kit.id, version: kit.version },
            display: validDisplay(kit.display),
            declaration: kit.ui ?? null,
            opened: (extra = []) => {
              const declared = [...(kit.capabilities ?? ['ai']), ...(kit.ui ? ['ui-config'] : [])]
              answer({ kit: { id: kit.id, version: kit.version }, capabilities: [...declared, ...extra.filter((name) => !declared.includes(name))] })
            },
            failed: (error) => refuse(error),
            changed: (state) => peer.notify('document/changed', state),
            notify: (notice) => peer.notify('host/notify', notice),
            exportFile: async (path, bytes) => {
              const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
              return (await peer.request('host/write', { path, bytes: copy, mode: 'export' }, { transfer: true })).path
            },
            openAgent: async (prompt) => {
              await peer.request('host/openAgent', prompt ? { prompt } : {})
            },
            pick: async (purpose, accept) => (await peer.request('host/pick', { purpose, accept })).path,
            pickLinks: async (params) => (await peer.request('links/pick', params)).links,
            hasService: (service) => init.capabilities.includes(`${HOST_SERVICE_CAPABILITY_PREFIX}${service}`),
            service: async (service, params) => {
              if (!init.capabilities.includes(`${HOST_SERVICE_CAPABILITY_PREFIX}${service}`)) throw new KitRpcError(-32000, `the host does not serve ${service}`, { reason: 'not-allowed' })
              const transfer = service === 'file.saveAs'
              return (await peer.request('host/service', { service, params } as never, transfer ? { transfer: true } : undefined)) as never
            },
            commentAnchors: init.capabilities.includes('comment-anchors'),
            onComments: (listener) =>
              peer.on('comments/show', (params) => {
                const threads = Array.isArray(params?.threads) ? params.threads : []
                listener(
                  threads.flatMap((thread) => {
                    const anchor = parseCommentAnchor(thread?.anchor)
                    return anchor && typeof thread?.id === 'string' ? [{ id: thread.id, anchor, resolved: thread.resolved === true, count: Number.isSafeInteger(thread.count) ? thread.count : 0 }] : []
                  }),
                )
              }),
            activateComment: (id) => peer.notify('comments/activated', { id }),
            locateComments: (locate) =>
              peer.handle('comments/locate', async (params) => {
                const anchors = Array.isArray(params?.anchors) ? params.anchors : []
                const checked = anchors.map((anchor) => parseCommentAnchor(anchor))
                const found = await locate(checked.filter((anchor): anchor is KitCommentAnchor => anchor !== null))
                let next = 0
                return { found: checked.map((anchor) => (anchor ? found[next++] === true : false)) }
              }),
            close: () => {
              window.removeEventListener('keydown', onKey, true)
              peer.close()
            },
          })
        }),
      )
    }
    window.addEventListener('message', onMessage)
    announce()
  })
}
