/**
 * The extension's side of the channel: loads its module, calls `activate(ctx)` per document, and
 * runs the commands it registered. It runs in the sandbox's worker (`worker.ts`), and in tests on
 * any port.
 */
import type { ExtensionManifest } from '../manifest'
import type { DocumentInfo, Notice } from '../protocol'
import { ExtensionError, RpcPeer, type PortLike } from '../rpc'
import { ExtensionDocument } from './document'

/** A command handler; what it answers goes back to the host. */
export type CommandHandler = () => unknown | Promise<unknown>

/** One open panel, as the extension's worker sees it: messages to it, and its requests. */
export type PanelConnection = {
  /** The panel's id (`contributes.panels[].id`). */
  readonly id: string
  /** This panel's session: a panel shown twice has two. */
  readonly session: string
  /** Sends `message` to the panel (`kitionPanel.onMessage` there). */
  post(message: unknown): void
  /** Answers the panel's `kitionPanel.request(message)`; what `handler` answers goes back. */
  onRequest(handler: (message: unknown) => unknown): void
  /** Runs `listener` when the panel closes; answers a disposer. */
  onClose(listener: () => void): () => void
}

/** Called when a panel of this extension opens on the document; may answer a disposer. */
export type PanelHandler = (panel: PanelConnection) => unknown

/** What `activate(ctx)` (and a script's default export) gets. */
export type ExtensionContext = {
  extension: { id: string; name: string; version: string; permissions: string[] }
  /** The document this activation is for. */
  document: ExtensionDocument
  commands: {
    /** Handles a command the manifest contributes; answers a disposer. */
    register(id: string, handler: CommandHandler): () => void
  }
  panels: {
    /** Serves a panel the manifest contributes each time it opens on this document; answers a disposer. */
    register(id: string, handler: PanelHandler): () => void
  }
  /** Shows a message to the person. */
  notify(notice: Notice | string, options?: Omit<Notice, 'title'>): void
  /** Disposers run when the extension is deactivated on this document. */
  subscriptions: Array<() => void>
}

/** The module an extension's entry is. */
export type ExtensionModule = {
  activate?: (ctx: ExtensionContext) => unknown
  deactivate?: (ctx: ExtensionContext) => unknown
  default?: unknown
  run?: unknown
}

/** Loads an extension's module from its source. The worker imports a blob URL of it. */
export type ModuleLoader = (source: string) => Promise<ExtensionModule>

type Activation = { context: ExtensionContext; handlers: Map<string, CommandHandler>; panels: Map<string, PanelHandler>; disposeActivate: (() => unknown) | null }
type Session = { documentId: string; peer: RpcPeer; closed: Set<() => void>; dispose: (() => unknown) | null }

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

/** Serves the host on `port` until it closes; answers the channel. */
export function startRuntime(port: PortLike, load: ModuleLoader): RpcPeer {
  const peer = new RpcPeer(port)
  let manifest: ExtensionManifest | null = null
  let module: ExtensionModule | null = null
  let kind: 'extension' | 'script' = 'extension'
  const activations = new Map<string, Activation>()
  const sessions = new Map<string, Session>()

  const closeSession = (id: string) => {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    session.peer.close('the panel closed')
    for (const listener of [...session.closed, ...(session.dispose ? [session.dispose] : [])]) {
      try {
        listener()
      } catch (error) {
        console.error('[kition-extension] a panel close listener failed', error)
      }
    }
  }

  const context = (info: DocumentInfo, pending: Array<Promise<unknown>>, handlers: Map<string, CommandHandler>, panels: Map<string, PanelHandler>): ExtensionContext => {
    const document = new ExtensionDocument(info, peer)
    const { id, name, version, permissions } = manifest!
    return {
      extension: { id, name, version, permissions: [...permissions] },
      document,
      commands: {
        register: (command, handler) => {
          if (typeof command !== 'string' || !isFunction(handler)) throw new TypeError('commands.register takes a command id and a function')
          if (kind === 'script') throw new ExtensionError('invalid', 'a script cannot register commands')
          if (!manifest!.contributes.commands.some((contributed) => contributed.id === command)) {
            throw new ExtensionError('invalid', `${id} does not contribute ${command}: declare it in extension.json contributes.commands`)
          }
          handlers.set(command, handler)
          pending.push(peer.request('commands/register', { documentId: info.documentId, command }))
          return () => {
            if (handlers.get(command) === handler) handlers.delete(command)
          }
        },
      },
      panels: {
        register: (panel, handler) => {
          if (typeof panel !== 'string' || !isFunction(handler)) throw new TypeError('panels.register takes a panel id and a function')
          if (kind === 'script') throw new ExtensionError('invalid', 'a script cannot serve panels')
          if (!manifest!.contributes.panels?.some((contributed) => contributed.id === panel)) {
            throw new ExtensionError('invalid', `${id} does not contribute the panel ${panel}: declare it in extension.json contributes.panels`)
          }
          panels.set(panel, handler)
          return () => {
            if (panels.get(panel) === handler) panels.delete(panel)
          }
        },
      },
      notify: (notice, options) => {
        const full: Notice = typeof notice === 'string' ? { level: options?.level ?? 'info', title: notice, ...(options?.description ? { description: options.description } : {}) } : notice
        peer.notify('host/notify', full)
      },
      subscriptions: [],
    }
  }

  const loaded = () => {
    if (!manifest || !module) throw new ExtensionError('failed', 'the extension has not started')
    return { manifest, module }
  }

  peer
    .handle('extension/start', async (params: { manifest: ExtensionManifest; source: string; kind?: 'extension' | 'script' }) => {
      if (module) throw new ExtensionError('invalid', 'the extension has already started')
      manifest = params.manifest
      kind = params.kind ?? 'extension'
      const imported = await load(params.source)
      if (kind === 'script' ? !isFunction(imported.default) && !isFunction(imported.run) : !isFunction(imported.activate)) {
        throw new ExtensionError('invalid', kind === 'script' ? 'a script exports a default function (or run)' : `${manifest.entry} exports no activate function`)
      }
      module = imported
      return null
    })
    .handle('extension/activate', async (info: DocumentInfo) => {
      const { module } = loaded()
      if (activations.has(info.documentId)) return { commands: [...activations.get(info.documentId)!.handlers.keys()] }
      const pending: Array<Promise<unknown>> = []
      const handlers = new Map<string, CommandHandler>()
      const panels = new Map<string, PanelHandler>()
      const ctx = context(info, pending, handlers, panels)
      const activation: Activation = { context: ctx, handlers, panels, disposeActivate: null }
      activations.set(info.documentId, activation)
      try {
        const answer = await module.activate!(ctx)
        if (isFunction(answer)) activation.disposeActivate = answer as () => unknown
        await Promise.all(pending)
      } catch (error) {
        activations.delete(info.documentId)
        // Registrations sent before the failure are moot; their answers must not go unheard.
        for (const registration of pending) registration.catch(() => undefined)
        throw error
      }
      return { commands: [...handlers.keys()] }
    })
    .handle('extension/command', async ({ documentId, command }: { documentId: string; command: string }) => {
      const handler = activations.get(documentId)?.handlers.get(command)
      if (!handler) throw new ExtensionError('not-found', `${command} is not registered on ${documentId}`)
      return (await handler()) ?? null
    })
    .handle('extension/deactivate', async ({ documentId }: { documentId: string }) => {
      const activation = activations.get(documentId)
      if (!activation) return null
      activations.delete(documentId)
      for (const [id, session] of [...sessions]) if (session.documentId === documentId) closeSession(id)
      const { context } = activation
      try {
        await module?.deactivate?.(context)
        await activation.disposeActivate?.()
      } finally {
        for (const dispose of context.subscriptions.splice(0)) {
          try {
            dispose()
          } catch (error) {
            console.error('[kition-extension] a subscription failed to dispose', error)
          }
        }
        context.document.close()
      }
      return null
    })
    .handle('script/run', async (info: DocumentInfo) => {
      const { module } = loaded()
      const run = (isFunction(module.default) ? module.default : module.run) as (ctx: ExtensionContext) => unknown
      const ctx = context(info, [], new Map(), new Map())
      activations.set(info.documentId, { context: ctx, handlers: new Map(), panels: new Map(), disposeActivate: null })
      return (await run(ctx)) ?? null
    })
    .handle('document/changed', ({ documentId, origin }: { documentId: string; origin: 'local' | 'kit' }) => {
      activations.get(documentId)?.context.document.emit({ origin })
    })
    .handle('panel/open', async ({ documentId, panel, session }: { documentId: string; panel: string; session: string }, ports: readonly MessagePort[]) => {
      const activation = activations.get(documentId)
      if (!activation) throw new ExtensionError('not-found', `the extension is not active on ${documentId}`)
      const port = ports[0]
      if (!port) throw new ExtensionError('invalid', 'a panel opens with its port')
      if (sessions.has(session)) throw new ExtensionError('invalid', `the panel session ${session} is open already`)
      const panelPeer = new RpcPeer(port as unknown as PortLike)
      let answer: ((message: unknown) => unknown) | null = null
      panelPeer.handle('panel/request', async (message: unknown) => {
        if (!answer) throw new ExtensionError('not-found', `the extension does not answer the panel ${panel}`)
        return (await answer(message)) ?? null
      })
      const open: Session = { documentId, peer: panelPeer, closed: new Set(), dispose: null }
      sessions.set(session, open)
      const connection: PanelConnection = {
        id: panel,
        session,
        post: (message) => panelPeer.notify('panel/message', message),
        onRequest: (handler) => {
          if (!isFunction(handler)) throw new TypeError('onRequest takes a function')
          answer = handler as (message: unknown) => unknown
        },
        onClose: (listener) => {
          open.closed.add(listener)
          return () => {
            open.closed.delete(listener)
          }
        },
      }
      const handler = activation.panels.get(panel)
      try {
        const dispose = handler ? await handler(connection) : null
        if (isFunction(dispose)) open.dispose = dispose as () => unknown
      } catch (error) {
        closeSession(session)
        throw error
      }
      return null
    })
    .handle('panel/close', ({ session }: { session: string }) => {
      closeSession(session)
      return null
    })
  return peer
}
