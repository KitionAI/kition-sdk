/**
 * `ctx.document` inside an extension's worker: `@kition/script`'s document API (`run`, `context`,
 * proxies, `sync()`, `commands`, `changed`) over the host, which runs each batch on the document
 * and checks it against the extension's permissions.
 */
import type { BatchRequest, BatchResult, Schema } from '@kition/kdm'
// The worker needs only the proxies; the rest of the object model stays in the host.
import { RequestContext, type CommandMap, type ModelObject } from '@kition/script/proxy'
import type { KitCommandInfo } from '@kition/script'
import type { DocumentInfo } from '../protocol'
import type { RpcPeer } from '../rpc'

export type DocumentChangedEvent = { origin: 'local' | 'kit' }

export class ExtensionDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap> {
  private listeners = new Set<(event: DocumentChangedEvent) => void>()
  readonly id: string
  readonly kitId: string
  /** The document's file name, when the host gives it. */
  readonly name: string | undefined
  /** Whether writes are refused (a read-only document, or no `model.write` permission). */
  readonly readOnly: boolean
  readonly schema: Schema

  constructor(
    info: DocumentInfo,
    private readonly peer: RpcPeer,
  ) {
    this.id = info.documentId
    this.kitId = info.kitId
    this.name = info.name
    this.readOnly = info.readOnly
    this.schema = info.schema as Schema
  }

  /** Runs `script` with a new request context; what it queued and did not `sync()` is sent when it returns. */
  async run<T>(script: (context: RequestContext<Root, C>) => Promise<T> | T): Promise<T> {
    const context = this.context()
    const value = await script(context)
    if (context.queued) await context.sync()
    return value
  }

  context(): RequestContext<Root, C> {
    return new RequestContext<Root, C>(this.schema, (request) => this.batch(request))
  }

  /** One `model/batch` in its wire form (the host sets its origin). */
  batch(request: BatchRequest): Promise<BatchResult> {
    return this.peer.request<BatchResult>('model/batch', { documentId: this.id, request })
  }

  describe(): Promise<Record<string, unknown>> {
    return this.peer.request('model/describe', { documentId: this.id })
  }

  readonly commands = {
    list: (): Promise<KitCommandInfo[]> => this.peer.request<KitCommandInfo[]>('model/commands', { documentId: this.id }),
    enabled: async (id: string): Promise<boolean> => (await this.commands.list()).some((command) => command.id === id && command.enabled !== false),
    run: async <K extends keyof C & string>(id: K, params?: C[K]): Promise<unknown> =>
      (await this.batch({ ops: [{ op: 'command', id, ...(params === undefined ? {} : { params }) }] })).results[0],
  }

  on(event: 'changed', listener: (event: DocumentChangedEvent) => void): () => void {
    if (event !== 'changed') throw new Error(`unknown event \`${event}\``)
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The host's `document/changed`. */
  emit(event: DocumentChangedEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[kition-extension] a changed listener failed', error)
      }
    }
  }

  close() {
    this.listeners.clear()
  }
}
