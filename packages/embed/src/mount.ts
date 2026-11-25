/**
 * `KitionEmbed.mount`: a kit's editor in a cross-origin iframe inside the integrator's element,
 * over the Kit UI protocol (`mountKit`), with the integrator's storage behind the kit's file calls
 * (`handlers.ts`).
 *
 * The frame comes from the kit package's own origin (`kit.url`), and the protocol's handshake is
 * bound to exactly that origin. The storage stays in this page; the kit sees only its document's
 * bytes and its replica (E5).
 */
import { KitRpcError, mountKit, type KitConnection, type KitDocumentInit, type KitUiElement, type MountOptions } from '@kition/kit-host'
import { SERVICE_ERROR_REASONS } from '@kition/kit-ui-protocol'
import { createAgentPort, type AgentPort } from './agent'
import { blobBackedReplicas } from './blobs'
import type { CommentReader } from './comments'
import { createHandlers, toArrayBuffer, type NamedFile } from './handlers'
import { EmbedError } from './errors'
import { fetchPackageSchema, kitSchemaLoader } from './schemas'
import { kitTheme } from './theme'
import type { EmbedCommand, EmbedCommentThread, EmbedEditor, EmbedEvents, EmbedModelPort, EmbedOptions, EmbedServices, EmbedShownThread, EmbedUi, EmbedUser, PermissionMode } from './types'
import { People, kitUiConfig, strictestMode } from './ui'
import { EMBED_VERSION } from './version'

/** The capability sets this embed serves (Kition platform `docs/platform/index.md` section 3). */
export const EMBED_CAPABILITY_SETS = ['KitModel 1.1', 'KitObjectModel 1.0', 'KitEmbed 1.3'] as const

/** The kit frame's sandbox: its own origin (workers, storage), its forms (a comment composer), downloads, and popups, nothing more. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
export const FRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen'

/** What `mount` uses, replaceable in tests. */
export type EmbedDependencies = {
  mountKit: (frame: HTMLIFrameElement, options: MountOptions) => Promise<KitConnection>
  /**
   * Reads the KDM schema a kit package ships (`model/schema.json` at the URL given); without it, a
   * draft's review and the agent's object-model calls use the page's or the bundled kit's schema.
   */
  packageSchema?: (url: string) => Promise<object | undefined>
}

const DEFAULT_DEPENDENCIES: EmbedDependencies = { mountKit, packageSchema: fetchPackageSchema }

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/** The kit package's origin, its base URL (with its trailing `/`), and the UI entry in it. */
export function kitLocation(kit: EmbedOptions['kit'], base = globalThis.location?.href) {
  const url = new URL(kit.url, base)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`the kit URL ${kit.url} is not http(s)`)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return { origin: url.origin, base: url.href, entry: new URL(kit.entry ?? 'index.html', url).href }
}

/** `storage.lend`'s answer as the Kit UI protocol's `document.lend`: an http(s) URL ending in `/`, the document's folder at its root. */
export function lendLocation(url: string | URL | null | undefined, base = globalThis.location?.href): KitDocumentInit['lend'] | undefined {
  if (url == null || url === '') return undefined
  const root = new URL(String(url), base)
  if (root.protocol !== 'https:' && root.protocol !== 'http:') throw new Error(`the lend URL ${String(url)} is not http(s)`)
  root.search = ''
  root.hash = ''
  if (!root.pathname.endsWith('/')) root.pathname += '/'
  return { root: root.href, folder: '' }
}

function createFrame(src: string, title: string) {
  const frame = document.createElement('iframe')
  frame.title = title
  frame.setAttribute('sandbox', FRAME_SANDBOX)
  frame.setAttribute('allow', FRAME_ALLOW)
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
  frame.src = src
  return frame
}

/** The page's own display permissions and watermark (`EmbedOptions.display`), as the kit's document takes them. */
function displayOf(display: EmbedOptions['display']) {
  if (!display) return {}
  return { ...(display.permissions ? { permissions: { ...display.permissions } } : {}), ...(display.watermark !== undefined ? { watermark: display.watermark ? { text: display.watermark.text } : null } : {}) }
}

export async function mountEmbed(element: HTMLElement, options: EmbedOptions, dependencies: EmbedDependencies = DEFAULT_DEPENDENCIES): Promise<EmbedEditor> {
  const { kit } = options
  const { origin, base, entry } = kitLocation(kit)
  if (!options.storage.stamp && !options.storage.info) throw new Error('the storage needs stamp or info')
  if (!options.file.name && !options.storage.info) throw new Error('the file needs a name, or the storage info to name it')
  const storage = options.storage
  // The document's name comes from the page, or from `storage.info` before the kit opens.
  let file: NamedFile = { id: options.file.id, name: options.file.name ?? '' }
  const people = new People(options.identity)

  const listeners = new Map<keyof EmbedEvents, Set<(value: never) => void>>()
  const emit = <E extends keyof EmbedEvents>(event: E, value: EmbedEvents[E]) => {
    for (const listener of [...(listeners.get(event) ?? [])] as Array<(value: EmbedEvents[E]) => void>) {
      try {
        listener(value)
      } catch (error) {
        console.error('[kition-embed] a listener failed', error)
      }
    }
  }

  let theme = kitTheme(options.theme)
  let locale = options.locale ?? globalThis.navigator?.language ?? 'en-US'
  let mode: PermissionMode = strictestMode(options.permissions?.mode)
  let ui: EmbedUi | undefined = options.ui
  // What the person last hid themselves (`host/customize`).
  let personal: { hide: string[] } | null = null
  // The kit's elements, when `ui.panels` needs them to tell which panels to hide.
  let elements: KitUiElement[] | null = null
  let lend: KitDocumentInit['lend'] | undefined
  let user: EmbedUser | null = null
  let connection: KitConnection | null = null
  let frame: HTMLIFrameElement | null = null
  let opening: AbortController | null = null
  // Who drafts are merged as (`origin.principal`): the principal the page last gave an agent
  // port; before any, the person (an agent acts for the person who started it, KHP A11, A14), or
  // `agent` without an identity.
  let agentPrincipal: string | null = null
  const mergePrincipal = () => agentPrincipal ?? user?.id ?? 'agent'
  let agentLabel: string | undefined
  const ports = new Set<AgentPort>()
  let destroyed = false
  const version = { current: null as string | null }
  // The kit keeps a replica when the integrator stores one; with a blob store, the replica's blobs
  // go there instead of inside the stored replica.
  const kept = storage.replica ?? null
  const replicas = kept && storage.blob ? blobBackedReplicas(kept, storage.blob) : kept
  // `replica/changed` of whichever frame is current, for the object model.
  const replicaListeners = new Set<(version: Uint8Array | null) => void>()

  function dropFrame() {
    frame?.remove()
    frame = null
  }

  /** Opens the kit in a new frame. */
  async function open(openMode: PermissionMode): Promise<KitConnection> {
    const readOnly = openMode !== 'edit'
    const abandon = new AbortController()
    opening = abandon
    // The kit starts loading while the document is read; it announces itself when ready.
    const next = createFrame(entry, file.name)
    frame = next
    element.append(next)
    const read = await storage.read(file.id)
    if (destroyed || abandon.signal.aborted) throw new Error('the editor was closed')
    version.current = read.version
    const sentTheme = theme
    const sentLocale = locale
    const sentUi = ui
    // Who comments, for a kit that keeps comment threads, once the page names the person.
    const comments = options.identity || openMode === 'comment' ? { me: user?.id ?? null, ...(user?.name ? { name: user.name } : {}), canComment: openMode !== 'view', othersReadOnly: true } : undefined
    const mounted = await dependencies.mountKit(next, {
      signal: abandon.signal,
      origin,
      host: { name: 'Kition Embed', version: EMBED_VERSION },
      document: {
        path: file.name,
        name: file.name,
        bytes: toArrayBuffer(read.bytes),
        version: read.version,
        ...(readOnly ? { readOnly: true } : {}),
        ...(lend ? { lend } : {}),
        ...(comments ? { comments } : {}),
        // What the page lets the person take out, and the watermark.
        ...displayOf(options.display),
      },
      theme: sentTheme,
      locale: sentLocale,
      shortcuts: [...(options.shortcuts ?? [])],
      ui: kitUiConfig(sentUi, elements, personal),
      capabilitySets: [...EMBED_CAPABILITY_SETS],
      timeoutMs: options.timeoutMs,
      handlers: {
        ...createHandlers({
          file,
          storage,
          replicas,
          readOnly,
          version,
          onSaved: (saved) => emit('saved', { version: saved }),
          onChanged: (change) => emit('changed', change),
          onNotify: (notice) => emit('notify', notice),
          onConflict: (error) => emit('conflict', error),
        }),
        // The page's services and the comment threads it keeps (KitEmbed 1.7, EM29 and EM30).
        ...(options.services ? { services: pageServices(options.services) } : {}),
        ...(options.comments ? { comments: { activated: (id: string) => options.comments?.activated(id) } } : {}),
        schema: (report) => emit('newerKit', report),
        draftChanged: (info) => emit('draft', info),
        action: (action) => emit('action', action),
        shortcut: (key) => emit('shortcut', key),
        // The person's own hides go to the page (`ui.customize`), which passes them back later.
        ...(sentUi?.customize
          ? {
              customize: async ({ personal: chosen }) => {
                personal = { hide: [...(chosen?.hide ?? [])] }
                emit('customize', personal)
                await ui?.customize?.(personal)
              },
            }
          : {}),
      },
    })
    if (destroyed || abandon.signal.aborted) {
      mounted.close()
      throw new Error('the editor was closed')
    }
    if (mounted.kit.id !== kit.id) {
      mounted.close()
      throw new Error(`the kit at ${kit.url} is ${mounted.kit.id}, not ${kit.id}`)
    }
    if (mounted.capabilities.includes('replica')) {
      mounted.replica.onChanged((changed) => {
        for (const listener of [...replicaListeners]) listener(new Uint8Array(changed))
        refreshComments()
      })
    }
    // A theme or locale set while the kit was opening.
    if (theme !== sentTheme) mounted.setTheme(theme)
    if (locale !== sentLocale) mounted.setLocale(locale)
    connection = mounted
    // The page's threads, shown before the kit opened (EM30).
    if (shownThreads) mounted.showComments(shownThreads)
    commentReader?.reset()
    if (ui !== sentUi || ui?.panels) void applyUi(mounted)
    refreshComments()
    return mounted
  }

  /** Sends the kit the page's UI configuration, after listing its panels when `ui.panels` names the ones to keep. */
  async function applyUi(target: KitConnection) {
    if (ui?.panels) elements = await target.elements().catch(() => [])
    if (connection !== target) return
    target.configure(kitUiConfig(ui, elements, personal) ?? {})
  }

  // The document's comment threads, read from the kit's replica while the page listens (`comments`).
  let commentReader: CommentReader | null = null
  let commentTimer: ReturnType<typeof setTimeout> | null = null
  let commentRun: Promise<void> = Promise.resolve()
  let lastComments: { text: string; threads: EmbedCommentThread[] } | null = null
  let commentsFailed = false

  function refreshComments() {
    if (destroyed || !listeners.get('comments')?.size || commentTimer) return
    commentTimer = setTimeout(() => {
      commentTimer = null
      commentRun = commentRun.then(readComments)
    }, 100)
  }

  async function readComments() {
    const current = connection
    if (destroyed || !current || !replicas || !current.capabilities.includes('replica') || !listeners.get('comments')?.size) return
    try {
      const { CommentReader } = await import('./comments')
      commentReader ??= new CommentReader(kit.id)
      const threads = await people.threads(await commentReader.threads(current.replica))
      const text = JSON.stringify(threads)
      if (destroyed || text === lastComments?.text) return
      lastComments = { text, threads }
      emit('comments', threads)
    } catch (error) {
      if (!commentsFailed) console.warn('[kition-embed] could not read the comment threads', error)
      commentsFailed = true
    }
  }

  /** The threads the page keeps, as last shown (EM30). */
  let shownThreads: EmbedShownThread[] | null = null
  const ready = (async () => {
    if (!options.file.name) {
      const info = await storage.info!(file.id)
      if (!info?.name) throw new Error(`the storage has no file ${file.id}`)
      file = { id: file.id, name: info.name }
    }
    if (options.identity?.permissions) mode = strictestMode(mode, (await options.identity.permissions(file.id))?.mode)
    if (options.identity?.user) user = await options.identity.user()
    if (storage.lend) lend = lendLocation(await storage.lend(file.id))
    await open(mode)
  })()
  // `ready()` reports a failure; nothing else needs to hear it.
  ready.catch(() => undefined)

  const opened = async () => {
    await ready
    if (!connection) throw new Error('the editor was closed')
    return connection
  }

  const packageSchema = dependencies.packageSchema
  const kitSchema = kitSchemaLoader(kit.id, kit.schema, packageSchema && (() => packageSchema(new URL('model/schema.json', base).href)))
  /** The open editor, when its kit keeps drafts. */
  const reviewing = async () => {
    const current = await opened()
    if (!current.capabilities.includes('draft')) throw new EmbedError('unsupported', `the ${kit.id} editor keeps no drafts`)
    return current
  }
  /** The open editor, when the person may merge or discard its open draft (UI-D1: the page calls this only on their action). */
  const deciding = async () => {
    const current = await reviewing()
    if (mode !== 'edit') throw new EmbedError('read-only', 'the person may not change this document, so they cannot merge or discard a draft')
    if ((await current.draft.state()).state === 'none') throw new EmbedError('no-draft', 'there is no draft to merge or discard')
    return current
  }

  const on: EmbedEditor['on'] = (event, listener) => {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(listener)
    if (event === 'comments') {
      // A new listener hears the threads as they are, then every change.
      const known = lastComments
      if (known) queueMicrotask(() => set.has(listener) && (listener as (value: EmbedCommentThread[]) => void)(known.threads))
      refreshComments()
    }
    return () => {
      set.delete(listener)
    }
  }

  const editor: EmbedEditor = {
    ready: () => ready,
    save: async () => (await opened()).save(),
    on,
    setTheme: (next) => {
      theme = kitTheme(next)
      connection?.setTheme(theme)
    },
    setLocale: (next) => {
      locale = next
      connection?.setLocale(next)
    },
    comments: {
      show: (threads) => {
        shownThreads = [...threads]
        connection?.showComments(shownThreads)
      },
      locate: async (anchors) => (await opened()).locateComments(anchors),
    },
    commands: {
      list: async (query = '') => (await (await opened()).ai.commands(query)) as EmbedCommand[],
      run: async (id, params, runOptions) => {
        const steps = [{ command: id, ...(params ? { params } : {}) }]
        const save = runOptions?.save ?? false
        // The page's own change (EM31): the kit records it under the system origin, no undo step.
        const origin = runOptions?.origin ? { origin: runOptions.origin, ...(runOptions.originLabel != null ? { originLabel: runOptions.originLabel } : {}) } : null
        const connection = await opened()
        const result = await (origin ? connection.ai.run(steps, save, origin) : connection.ai.run(steps, save))
        return result.completed[0] ?? { command: id, changed: false, result: null }
      },
    },
    check: async (checkOptions) => (await opened()).check(checkOptions?.draft ? { draft: true } : undefined),
    draft: {
      state: async () => {
        const current = await opened()
        return current.capabilities.includes('draft') ? current.draft.state() : { state: 'none', revision: null }
      },
      compare: async (compareOptions) => {
        const current = await reviewing()
        const schema = await kitSchema()
        return current.draft.compare({ ...(compareOptions?.maxSize ? { maxSize: compareOptions.maxSize } : {}), ...(schema ? { schema } : {}) })
      },
      merge: async (mergeOptions) => {
        const current = await deciding()
        const label = mergeOptions?.label ?? agentLabel
        return current.draft.merge({ kind: 'agent', principal: mergePrincipal(), ...(label ? { label } : {}) }, await kitSchema())
      },
      discard: async () => (await deciding()).draft.discard(),
    },
    agentPort: (portOptions) => {
      // An agent acts for the person who started it (KHP A11, A14): its edits and a merged
      // draft carry the person's id unless the page names another principal.
      agentPrincipal = portOptions?.principal ?? user?.id ?? agentPrincipal
      agentLabel = portOptions?.label ?? agentLabel
      const port = createAgentPort({ kitId: kit.id, path: () => file.name, opened, editable: () => mode === 'edit', version: EMBED_VERSION, schema: kitSchema }, { ...portOptions, principal: mergePrincipal() })
      ports.add(port)
      const close = port.close
      port.close = () => {
        close()
        ports.delete(port)
      }
      return port
    },
    replicaVersion: async () => {
      const current = await opened()
      if (!replicas || !current.capabilities.includes('replica')) return null
      return new Uint8Array(await current.replica.version())
    },
    modelPort: (): EmbedModelPort => {
      // The kit answers the object model itself when the editor open now lists `model`.
      const answering = async () => {
        const current = await opened()
        if (!current.capabilities.includes('model')) throw new Error(`the ${kit.id} editor does not answer the object model (capability model)`)
        return current
      }
      return {
        kitId: kit.id,
        commands: async () => (await (await opened()).ai.commands('')) as EmbedCommand[],
        // What the object model's documents hear from this editor (`@kition/script` `doc.on`).
        events: ['saved', 'conflict'],
        on: (event, listener) => {
          const heard = listener as (value: unknown) => void
          if (event === 'saved') return on('saved', ({ version }) => heard({ version }))
          if (event === 'conflict') return on('conflict', (error) => heard({ message: error.message }))
          return () => undefined
        },
        onChanged: (listener) => {
          replicaListeners.add(listener)
          return () => {
            replicaListeners.delete(listener)
          }
        },
        model: {
          describe: async (schema) => (await answering()).model.describe(schema),
          batch: async (request, schema) => {
            const { version, ...result } = await (await answering()).model.batch({ ...request, schema })
            return { ...result, version: version ? new Uint8Array(version) : null }
          },
        },
      }
    },
    document: async (typings, documentOptions) => {
      if (!typings?.schema || typings.id !== kit.id) throw new Error(`document() takes ${kit.id}'s typings, not ${typings?.id ?? 'none'}`)
      await opened()
      // `@kition/script`'s object model, loaded (and bundled) only for this call.
      const { openDocument } = await import('../../script/src/document')
      return openDocument(editor.modelPort(), { schema: typings.schema, ...(documentOptions?.origin ? { origin: documentOptions.origin } : {}) })
    },
    configure: (next) => {
      ui = next
      if (connection) void applyUi(connection)
    },
    get mode() {
      return mode
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      if (commentTimer) clearTimeout(commentTimer)
      opening?.abort()
      for (const port of ports) port.close()
      ports.clear()
      connection?.close()
      connection = null
      dropFrame()
      listeners.clear()
      replicaListeners.clear()
    },
  }
  return editor
}

/**
 * The page's service handlers as the kit's host answers them (EM29): a refusal keeps its reason
 * when it is one of the protocol's, and any other failure answers `failed`.
 */
function pageServices(services: EmbedServices): NonNullable<MountOptions['handlers']['services']> {
  const served: Record<string, (params: never) => Promise<unknown>> = {}
  for (const [id, run] of Object.entries(services) as [string, ((params: never) => unknown) | undefined][]) {
    if (typeof run !== 'function') continue
    served[id] = async (params) => {
      try {
        return await run(params)
      } catch (error) {
        const reason = (error as { reason?: unknown } | null)?.reason
        const known = (SERVICE_ERROR_REASONS as readonly unknown[]).includes(reason) ? (reason as string) : 'failed'
        throw new KitRpcError(-32000, error instanceof Error ? error.message : `the page could not serve ${id}`, { reason: known })
      }
    }
  }
  return served as NonNullable<MountOptions['handlers']['services']>
}
