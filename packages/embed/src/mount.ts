/**
 * `KitionEmbed.mount`: a kit's editor in a cross-origin iframe inside the integrator's element,
 * over the Kit UI protocol (`mountKit`), with the integrator's storage behind the kit's file calls
 * (`handlers.ts`) and, when asked, a collaboration session (`collab.ts`).
 *
 * The frame comes from the kit package's own origin (`kit.url`), and the protocol's handshake is
 * bound to exactly that origin. Tokens, the sync connection, and the storage stay in this page;
 * the kit sees only its document's bytes and replica changes (E5).
 */
import { KitRpcError, mountKit, type KitConnection, type KitDocumentInit, type KitUiElement, type MountOptions } from '@kition/kit-host'
import { SERVICE_ERROR_REASONS } from '@kition/kit-ui-protocol'
import type { ReplicaVersions, TransportFactory } from '@kition/sync'
import { createAgentPort, type AgentPort } from './agent'
import { blobBackedReplicas } from './blobs'
import type { CollabHost, CollabSession } from './collab'
import type { CommentReader } from './comments'
import { createHandlers, toArrayBuffer, type NamedFile } from './handlers'
import { EmbedError } from './errors'
import { fetchPackageSchema, kitSchemaLoader } from './schemas'
import { indexedDbReplicaStore, memoryReplicaStore } from './replicaStore'
import { kitTheme } from './theme'
import type { CollabState, EmbedCommand, EmbedCommentThread, EmbedEditor, EmbedEvents, EmbedModelPort, EmbedOptions, EmbedServices, EmbedShownThread, EmbedUi, EmbedUser, PermissionMode, ReplicaStore, StoredReplica } from './types'
import { People, kitUiConfig, namePeers, strictestMode } from './ui'
import { EMBED_VERSION } from './version'

/** The capability sets this embed serves (Kition platform `docs/platform/index.md` section 3). */
export const EMBED_CAPABILITY_SETS = ['KitModel 1.1', 'KitObjectModel 1.0', 'KitEmbed 1.3'] as const

/** The kit frame's sandbox: its own origin (workers, storage), its forms (a comment composer), downloads, and popups, nothing more. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
export const FRAME_ALLOW = 'clipboard-read; clipboard-write; fullscreen'

/** What `mount` uses, replaceable in tests. */
export type EmbedDependencies = {
  mountKit: (frame: HTMLIFrameElement, options: MountOptions) => Promise<KitConnection>
  /** The replica store of a collaboration session whose storage has none. */
  replicaStore: () => ReplicaStore
  createTransport?: TransportFactory
  versions?: ReplicaVersions
  /**
   * Reads the KDM schema a kit package ships (`model/schema.json` at the URL given); without it, a
   * draft's review and the agent's object-model calls use the page's or the bundled kit's schema.
   */
  packageSchema?: (url: string) => Promise<object | undefined>
}

const DEFAULT_DEPENDENCIES: EmbedDependencies = { mountKit, replicaStore: () => indexedDbReplicaStore(), packageSchema: fetchPackageSchema }

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

/**
 * The replica of a kit closed to be opened again read-only, unsaved edits included: its whole
 * history as a change export from nothing, which also opens as a snapshot.
 */
type Carried = { changes: ArrayBuffer; blobs: ArrayBuffer }

/** A document id as the two sides may spell it: lowercase hex, no hyphens. */
const docIdKey = (docId: string) => docId.replace(/-/g, '').toLowerCase()

/**
 * Whether the kit `opened` holds an earlier state of the carried replica: the same document, and
 * no change the carried one lacks. Only then do the carried changes continue it. A kit that opened
 * another replica (none was stored with the file, or the file won over the stored one and was
 * recorded onto it as new objects) would take them as more objects, or refuse them.
 */
async function continuesCarried(carried: Carried, opened: KitConnection, known?: ReplicaVersions) {
  const [{ openEnvelope }, versions] = await Promise.all([import('@kition/kdm'), known ?? import('@kition/sync/replicaVersions').then((loaded) => loaded.LORO_REPLICA_VERSIONS)])
  const changes = new Uint8Array(carried.changes)
  const reached = versions.endOf(changes)
  const version = new Uint8Array(await opened.replica.version())
  // Every opened replica holds at least the change that created its document.
  if (!reached || !version.length || !versions.includes(reached, version)) return false
  const docId = await opened.replica.info().catch(() => null)
  const carriedId = [...openEnvelope(changes).docId].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return !docId || docIdKey(docId) === carriedId
}

/** `replicas`, whose first read answers `first` (the kit opening from it), and later ones the store. */
function readingFirst(replicas: ReplicaStore, first: StoredReplica): ReplicaStore {
  let next: StoredReplica | null = first
  return {
    read: async (fileId) => {
      const answer = next
      next = null
      return answer ?? replicas.read(fileId)
    },
    write: (fileId, replica) => replicas.write(fileId, replica),
  }
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
  if (options.collaboration && (!options.identity?.token || !options.identity.user)) throw new Error('collaboration needs an identity provider with token and user')
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
  // What the person last hid themselves (`host/customize`), kept for the kit opening again.
  let personal: { hide: string[] } | null = null
  // The kit's elements, when `ui.panels` needs them to tell which panels to hide.
  let elements: KitUiElement[] | null = null
  let lend: KitDocumentInit['lend'] | undefined
  let user: EmbedUser | null = null
  let connection: KitConnection | null = null
  let frame: HTMLIFrameElement | null = null
  let opening: AbortController | null = null
  let collab: CollabSession | null = null
  // Who drafts are merged as: the agent the page last gave a port (`origin.principal`).
  let agentPrincipal = 'agent'
  let agentLabel: string | undefined
  const ports = new Set<AgentPort>()
  let destroyed = false
  const closing = new AbortController()
  const version = { current: null as string | null }
  // The kit keeps a replica when the integrator stores one, or when collaboration needs one.
  const kept = storage.replica ?? (options.collaboration ? dependencies.replicaStore() : options.model ? memoryReplicaStore() : null)
  // With a blob store, the replica's blobs go there instead of inside the stored replica.
  const replicas = kept && storage.blob ? blobBackedReplicas(kept, storage.blob) : kept
  // `replica/changed` of whichever frame is current, for the object model.
  const replicaListeners = new Set<(version: Uint8Array | null) => void>()

  function dropFrame() {
    frame?.remove()
    frame = null
  }

  /**
   * Opens the kit in a new frame, replacing any earlier one. `carried` is the replica of the kit
   * it replaces: imported when the kit opened an earlier state of it, else the kit is opened
   * again from it alone (`fromCarried`: no file bytes, the carried replica as the stored one), so
   * its changes never go into another replica.
   */
  async function open(openMode: PermissionMode, carried: Carried | null = null, fromCarried = false): Promise<KitConnection> {
    const readOnly = openMode !== 'edit'
    opening?.abort()
    const abandon = new AbortController()
    opening = abandon
    // The kit starts loading while the document is read; it announces itself when ready.
    frame?.remove()
    const next = createFrame(entry, file.name)
    frame = next
    element.append(next)
    const read = await storage.read(file.id)
    if (destroyed || abandon.signal.aborted) throw new Error('the editor was closed')
    version.current = read.version
    const lent = fromCarried && carried && replicas && read.version ? { snapshot: carried.changes, blobs: carried.blobs, fileStamp: read.version } : null
    if (fromCarried && !lent) console.warn('[kition-embed] could not open the kit again with its edits')
    const sentTheme = theme
    const sentLocale = locale
    const sentUi = ui
    // Who comments, for a kit that keeps comment threads (Kit UI protocol 1.6), once the page names the person.
    const comments = options.identity || openMode === 'comment' ? { me: user?.id ?? null, ...(user?.name ? { name: user.name } : {}), canComment: openMode !== 'view', othersReadOnly: !options.collaboration } : undefined
    const mounted = await dependencies.mountKit(next, {
      signal: abandon.signal,
      origin,
      host: { name: 'Kition Embed', version: EMBED_VERSION },
      document: {
        path: file.name,
        name: file.name,
        bytes: lent ? new ArrayBuffer(0) : toArrayBuffer(read.bytes),
        version: read.version,
        ...(readOnly ? { readOnly: true } : {}),
        ...(lend ? { lend } : {}),
        ...(comments ? { comments } : {}),
        // What a managed room's open token lets the person take out, and the watermark (Kit UI protocol 2.6).
        ...(collab?.openDocument ?? displayOf(options.display)),
      },
      theme: sentTheme,
      locale: sentLocale,
      shortcuts: [...(options.shortcuts ?? [])],
      ui: kitUiConfig(sentUi, elements, personal),
      capabilitySets: [...EMBED_CAPABILITY_SETS, ...(options.collaboration ? ['KitCollab 1.0'] : [])],
      timeoutMs: options.timeoutMs,
      handlers: {
        ...createHandlers({
          file,
          storage,
          replicas: lent && replicas ? readingFirst(replicas, lent) : replicas,
          readOnly,
          version,
          onSaved: (saved) => emit('saved', { version: saved }),
          onChanged: (change) => emit('changed', change),
          onNotify: (notice) => emit('notify', notice),
          onConflict: (error) => emit('conflict', error),
          // A managed room's saves go through its save state machine (KitCollab 1.4, D3).
          coordinate: () => collab?.coordinator() ?? null,
          // A save in a managed room goes through the room, never to the file directly (SV1).
          managedRoom: () => collab?.isManaged() ?? false,
          // The file moved to a later generation since the room was joined (1.3, SV5).
          moving: () => collab?.moving() ?? null,
          nextGeneration: () =>
            collab?.generationMoved()
              ? { occupied: () => collab!.nextGenerationHasRoom(), moved: (before) => void collab!.moveToNextGeneration(before).catch((error: unknown) => emit('error', toError(error))), docKey: () => collab!.currentDocKey() }
              : null,
        }),
        // Leases on the room's scopes (Kit UI protocol section 7b), when co-editing.
        ...(options.collaboration
          ? {
              leases: {
                acquire: (params) => (collab ? collab.acquireLease(params) : { lease: null }),
                release: async (params) => {
                  await collab?.releaseLease(params)
                },
                list: () => collab?.listLeases() ?? [],
              },
            }
          : {}),
        // The page's services and the comment threads it keeps (KitEmbed 1.7, EM29 and EM30).
        ...(options.services ? { services: pageServices(options.services) } : {}),
        ...(options.comments ? { comments: { activated: (id: string) => options.comments?.activated(id) } } : {}),
        conflicts: ({ conflicts }) => emit('mergeConflicts', conflicts),
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
    if (carried && !fromCarried && mounted.capabilities.includes('replica')) {
      const continues = await continuesCarried(carried, mounted, dependencies.versions).catch(() => false)
      if (destroyed || abandon.signal.aborted) {
        mounted.close()
        throw new Error('the editor was closed')
      }
      if (!continues) {
        mounted.close()
        return open(openMode, carried, true)
      }
      await mounted.replica.importChanges(carried.changes, carried.blobs)
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
    // The page's threads, marked again in a kit opened again (EM30).
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

  /** The room lets this person only view or comment: the kit opens again read-only, keeping its unsaved edits. */
  function reopenReadOnly(next: Exclude<PermissionMode, 'edit'>) {
    if (destroyed || strictestMode(mode, next) === mode) return
    mode = strictestMode(mode, next)
    void (async () => {
      collab?.detach()
      const current = connection
      connection = null
      let carried: Carried | null = null
      if (current?.capabilities.includes('replica')) {
        carried = await current.replica.exportChanges(new ArrayBuffer(0)).catch((error: unknown) => {
          console.warn('[kition-embed] could not keep the replica before opening the kit again', error)
          return null
        })
      }
      current?.close()
      const mounted = await open(mode, carried)
      void collab?.attach(mounted, mode)
    })().catch((error: unknown) => {
      if (!destroyed) emit('error', toError(error))
    })
  }

  /** Opens the kit again from the stored file and replica, carrying nothing (a managed viewer whose file got its room). */
  /** The threads the page keeps, as last shown (EM30). */
  let shownThreads: EmbedShownThread[] | null = null
  let reopening: Promise<void> | null = null
  function reopenFresh() {
    if (destroyed) return
    const run = (reopening = (async () => {
      collab?.detach()
      connection?.close()
      connection = null
      const mounted = await open(mode)
      void collab?.attach(mounted, mode)
    })()
      .catch((error: unknown) => {
        if (!destroyed) emit('error', toError(error))
      })
      .finally(() => {
        if (reopening === run) reopening = null
      }))
  }

  /** What a collaboration session reports, with the page's names for the people in the room. */
  let presenceCount = 0
  const sessionEmit: CollabHost['emit'] = (event, value) => {
    if (event !== 'presence') return emit(event, value)
    const peers = value as EmbedEvents['presence']
    if (!people.serves) return emit('presence', namePeers(peers, new Map()))
    const count = (presenceCount += 1)
    void people.presence(peers).then((named) => {
      // A newer list may have come while this one was named.
      if (count === presenceCount && !destroyed) emit('presence', named)
    })
  }

  const ready = (async () => {
    if (!options.file.name) {
      const info = await storage.info!(file.id)
      if (!info?.name) throw new Error(`the storage has no file ${file.id}`)
      file = { id: file.id, name: info.name }
    }
    if (options.identity?.permissions) mode = strictestMode(mode, (await options.identity.permissions(file.id))?.mode)
    if (options.identity?.user) user = await options.identity.user()
    if (storage.lend) lend = lendLocation(await storage.lend(file.id))
    if (options.collaboration) {
      const { openCollabSession } = await import('./collab')
      const session = await openCollabSession({
        kit,
        file,
        storage,
        identity: options.identity!,
        collaboration: options.collaboration,
        replicas: replicas!,
        emit: sessionEmit,
        reopenReadOnly,
        reopen: reopenFresh,
        onVersion: (moved) => {
          version.current = moved
        },
        signal: closing.signal,
        createTransport: dependencies.createTransport,
        versions: dependencies.versions,
      })
      if (destroyed) {
        session.close()
        throw new Error('the editor was closed')
      }
      collab = session
      if (ports.size > 0) session.setAgent({ name: agentLabel ?? 'Agent' })
      mode = strictestMode(mode, session.roleMode)
    }
    const mounted = await open(mode)
    if (collab) {
      try {
        await collab.claimOpened(mounted)
      } catch (error) {
        // Another editor on the page co-edits this document: this one closes before it shows.
        collab.close()
        collab = null
        mounted.close()
        connection = null
        dropFrame()
        throw error
      }
    }
    void collab?.attach(mounted, mode)
  })()
  // `ready()` reports a failure; nothing else needs to hear it.
  ready.catch(() => undefined)

  const opened = async () => {
    await ready
    // The kit opens on the file's next generation after a kept copy (SV5): wait for it.
    await collab?.moving()
    await reopening
    if (!connection) throw new Error(destroyed ? 'the editor was closed' : 'the kit is opening again')
    return connection
  }

  const offState: CollabState = { status: 'off', docId: null, role: null }

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
    collab: {
      get state() {
        return collab?.state ?? offState
      },
      shareLink: async (role) => {
        await ready
        if (!collab) throw new Error('this editor does not co-edit')
        return collab.shareLink(role)
      },
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
        return current.draft.merge({ kind: 'agent', principal: agentPrincipal, ...(label ? { label } : {}) }, await kitSchema())
      },
      discard: async () => (await deciding()).draft.discard(),
    },
    agentPort: (portOptions) => {
      // An agent acts for the person who started it (KHP A11, A14): its edits and a merged
      // draft carry the person's id unless the page names another principal.
      agentPrincipal = portOptions?.principal ?? user?.id ?? agentPrincipal
      agentLabel = portOptions?.label ?? agentLabel
      const port = createAgentPort({ kitId: kit.id, path: () => file.name, opened, editable: () => mode === 'edit', version: EMBED_VERSION, schema: kitSchema }, { ...portOptions, principal: agentPrincipal })
      ports.add(port)
      // While a port is open, co-editors see the agent working for the person (KitAgent A20).
      collab?.setAgent({ name: agentLabel ?? 'Agent' })
      const close = port.close
      port.close = () => {
        close()
        ports.delete(port)
        if (ports.size === 0) collab?.setAgent(null)
      }
      return port
    },
    replicaVersion: async () => {
      const current = await opened()
      if (!replicas || !current.capabilities.includes('replica')) return null
      return new Uint8Array(await current.replica.version())
    },
    modelPort: () => {
      const kitModel = (): NonNullable<EmbedModelPort['model']> => {
        const answering = async () => {
          const current = await opened()
          if (!current.capabilities.includes('model')) throw new Error(`the ${kit.id} editor no longer answers the object model`)
          return current
        }
        return {
          describe: async (schema) => (await answering()).model.describe(schema),
          batch: async (request, schema) => {
            const { version, ...result } = await (await answering()).model.batch({ ...request, schema })
            return { ...result, version: version ? new Uint8Array(version) : null }
          },
        }
      }
      const replica = async () => {
        const current = await opened()
        if (!replicas || !current.capabilities.includes('replica')) throw new Error(`the ${kit.id} editor keeps no replica: mount it with model: true`)
        return current
      }
      const slice = (view: Uint8Array) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
      return {
        kitId: kit.id,
        exportChanges: async (since) => new Uint8Array((await (await replica()).replica.exportChanges(slice(since))).changes),
        importChanges: async (changes) => {
          await (await replica()).replica.importChanges(slice(changes), new ArrayBuffer(0))
        },
        command: async (id, params) => {
          const steps = [{ command: id, ...(params && typeof params === 'object' ? { params: params as Record<string, unknown> } : {}) }]
          return (await (await opened()).ai.run(steps, false)).completed[0]?.result ?? null
        },
        commands: async () => (await (await opened()).ai.commands('')) as EmbedCommand[],
        readOnly: () => mode !== 'edit',
        // What the object model's documents hear from this editor (`@kition/script` `doc.on`).
        events: options.collaboration ? ['saved', 'conflict', 'presence'] : ['saved', 'conflict'],
        on: (event, listener) => {
          const heard = listener as (value: unknown) => void
          if (event === 'saved') return on('saved', ({ version }) => heard({ version }))
          if (event === 'conflict') return on('conflict', (error) => heard({ message: error.message }))
          if (event === 'presence') return on('presence', (peers) => heard({ peers }))
          return () => undefined
        },
        onChanged: (listener) => {
          replicaListeners.add(listener)
          return () => {
            replicaListeners.delete(listener)
          }
        },
        // The kit answers the object model itself when its editor (open now) lists `model`.
        ...(connection?.capabilities.includes('model') ? { model: kitModel() } : {}),
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
      closing.abort()
      opening?.abort()
      for (const port of ports) port.close()
      ports.clear()
      collab?.close()
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
