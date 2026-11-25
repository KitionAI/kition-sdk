import { BatchError, parseSchema, type BatchErrorCode, type BatchRequest, type BatchResult, type Origin, type Schema } from '@kition/kdm'
import { kitDescriptor } from './kits'
import type { DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, ModelPort } from './port'
import { RequestContext, type CommandMap, type ModelObject } from './proxy'
import { isModelPort, portFromSource } from './sources'

/** The document moved: by this handle's own `sync()` (`local`) or otherwise (`kit`: a person, a command). */
export type ChangedEvent = { origin: 'local' | 'kit'; version: Uint8Array | null }

/** `model/describe`'s answer: the schema, the root's id, and the kit's commands. */
export type ModelDescription = {
  capability: string
  kit: string
  schemaVersion: number
  root: string
  rootId: string
  types: Record<string, unknown>
  commands: KitCommandInfo[]
}

export type OpenOptions = {
  /** The kit's schema; by default the one registered for the kit's id (`registerKit`). */
  schema?: Schema | object
  /** The kit's id, for an engine (which does not name its kit). */
  kit?: string
  /** The origin every batch of this handle carries; `extension`/`script` by default. */
  origin?: Origin
}

/**
 * What answers a document's `model/describe` and `model/batch`: a kit's own object model over a
 * `ModelPort`, or a kit that serves it over the Kit Process Protocol (a headless kit executable,
 * `@kition/script/node`'s `openHeadless`).
 */
export interface ModelBackend extends DocumentEventSource {
  readonly kitId: string
  readonly schema: Schema
  batch(request: BatchRequest): Promise<BatchResult>
  describe(): Promise<ModelDescription>
  commands(): Promise<KitCommandInfo[]>
  /** The document's version after this handle's last batch, when known. */
  version(): Uint8Array | null
  /** Hears the document move (its version when known). */
  onChanged?(listener: (version: Uint8Array | null) => void): () => void
}

const CODES: readonly BatchErrorCode[] = ['invalid-op', 'not-found', 'invalid-value', 'read-only', 'command-failed']

/**
 * A kit's refusal of a batch as a `BatchError`: the Kit UI protocol answers it as an error whose
 * `data` is `{ code, index, message }`. Anything else is passed on as it is.
 */
function batchErrorOf(error: unknown): unknown {
  const data = (error as { data?: { code?: unknown; index?: unknown; message?: unknown } } | null)?.data
  if (!data || typeof data.code !== 'string' || !CODES.includes(data.code as BatchErrorCode)) return error
  const message = typeof data.message === 'string' ? data.message : error instanceof Error ? error.message : String(error)
  return new BatchError(data.code as BatchErrorCode, typeof data.index === 'number' ? data.index : null, message)
}

const parsedSchema = (schema: Schema | object): Schema => ('types' in schema && 'root' in schema && 'kit' in schema ? parseSchema(schema) : (schema as Schema))

/**
 * The object model answered by the kit (`port.model`): each batch is one `model/batch`, one undo
 * step of the person's history. Batches go one at a time; the kit's change announcement for a
 * batch still running is held until it answers, so this handle knows its own change.
 */
function kitBackend(port: ModelPort, schema: Schema | object): ModelBackend {
  // What crosses to the kit: plain JSON.
  const wire = JSON.parse(JSON.stringify(schema)) as object
  let version: Uint8Array | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let running: Promise<unknown> | null = null
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    kitId: port.kitId,
    schema: parsedSchema(schema),
    batch: (request) =>
      serial(async () => {
        const call = port.model.batch(request, wire)
        running = call.catch(() => undefined)
        try {
          const { version: after, ...result } = await call
          version = after ?? null
          return result
        } catch (error) {
          throw batchErrorOf(error)
        } finally {
          running = null
        }
      }),
    describe: () =>
      serial(async () => {
        try {
          return (await port.model.describe(wire)) as ModelDescription
        } catch (error) {
          throw batchErrorOf(error)
        }
      }),
    commands: () => port.commands(),
    version: () => version,
    events: port.events,
    on: port.on?.bind(port),
    onChanged: port.onChanged
      ? (listener) =>
          port.onChanged!((changed) => {
            const waiting = running
            if (waiting) void waiting.then(() => listener(changed))
            else listener(changed)
          })
      : undefined,
  }
}

/** A document opened for scripting: run batches through request contexts, and hear its changes. */
export class ModelDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap> {
  private listeners = new Set<(event: ChangedEvent) => void>()
  private unsubscribe: (() => void) | null = null
  /** Unsubscribes of the source's other events this handle hears. */
  private hearing = new Set<() => void>()
  private closed = false

  constructor(
    readonly backend: ModelBackend,
    private readonly origin?: Origin,
  ) {
    this.unsubscribe =
      backend.onChanged?.((version) => {
        // The engine announcing the changes this handle just gave it is not news.
        const own = this.backend.version()
        if (version && own && sameBytes(version, own)) return
        this.emit({ origin: 'kit', version })
      }) ?? null
  }

  get kitId(): string {
    return this.backend.kitId
  }

  get schema(): Schema {
    return this.backend.schema
  }

  /**
   * Runs `script` with a new request context; operations it queued and did not `sync()` are sent
   * when it returns. Answers what `script` answers.
   */
  async run<T>(script: (context: RequestContext<Root, C>) => Promise<T> | T): Promise<T> {
    const context = this.context()
    const value = await script(context)
    if (context.queued) await context.sync()
    return value
  }

  /** A request context to keep (`run` makes one per script). */
  context(): RequestContext<Root, C> {
    this.alive()
    return new RequestContext<Root, C>(this.schema, (request) => this.batch(request), this.origin)
  }

  /** One `model/batch` in its wire form. */
  async batch(request: BatchRequest): Promise<BatchResult> {
    this.alive()
    const result = await this.backend.batch(request.origin || !this.origin ? request : { ...request, origin: this.origin })
    if ((request.ops?.length ?? 0) > 0) this.emit({ origin: 'local', version: this.backend.version() })
    return result
  }

  /** `model/describe`: the schema, the root's id, and the kit's commands. */
  describe() {
    this.alive()
    return this.backend.describe()
  }

  readonly commands = {
    list: (): Promise<KitCommandInfo[]> => this.backend.commands(),
    /** Whether a command can run now. */
    enabled: async (id: string): Promise<boolean> => (await this.backend.commands()).some((command) => command.id === id && command.enabled !== false),
    /** Runs one command now (outside any request context). */
    run: async <K extends keyof C & string>(id: K, params?: C[K]): Promise<unknown> =>
      (await this.batch({ ops: [{ op: 'command', id, ...(params === undefined ? {} : { params }) }] })).results[0],
  }

  /**
   * Whether this document's source reports `event`: `changed` always; `saved`, `conflict`, and
   * `selection` when its host or kit does (an `@kition/embed` editor reports `saved` and
   * `conflict`; a headless kit and a Node package document report `saved`).
   */
  supports(event: 'changed' | DocumentEventName): boolean {
    return event === 'changed' || (typeof this.backend.on === 'function' && (this.backend.events ?? []).includes(event))
  }

  /** Hears an event; answers an unsubscribe. An event the source does not report (`supports`) is never heard. */
  on(event: 'changed', listener: (event: ChangedEvent) => void): () => void
  on<E extends DocumentEventName>(event: E, listener: (event: DocumentEvents[E]) => void): () => void
  on(event: string, listener: (event: never) => void): () => void {
    if (event === 'changed') {
      const heard = listener as (event: ChangedEvent) => void
      this.listeners.add(heard)
      return () => {
        this.listeners.delete(heard)
      }
    }
    if (!EVENTS.includes(event as DocumentEventName)) throw new Error(`unknown event \`${event}\``)
    this.alive()
    if (!this.supports(event as DocumentEventName)) return () => undefined
    const off = this.backend.on!(event as DocumentEventName, (value) => {
      const call = listener as (value: unknown) => void
      try {
        call(value)
      } catch (error) {
        console.error(`[kition-sdk] a ${event} listener failed`, error)
      }
    })
    this.hearing.add(off)
    return () => {
      if (this.hearing.delete(off)) off()
    }
  }

  /** Stops listening to the engine; the engine (or the kit's document) itself stays open. */
  close() {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
    for (const off of this.hearing) off()
    this.hearing.clear()
  }

  private alive() {
    if (this.closed) throw new Error('the document handle is closed')
  }

  private emit(event: ChangedEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[kition-sdk] a changed listener failed', error)
      }
    }
  }
}

const EVENTS: readonly DocumentEventName[] = ['saved', 'conflict', 'selection']

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])

/**
 * Opens a document for scripting. `source` is a `ModelPort`, an `@kition/embed` editor, a
 * `KitConnection` (`@kition/kit-host`) whose kit has the `model` capability, or a kit engine with
 * `modelDescribe` and `modelBatch` (`options.kit` names its kit). The kit runs each batch as one
 * undo step of the person's history.
 */
export async function openDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(
  source: unknown,
  options: OpenOptions = {},
): Promise<ModelDocument<Root, C>> {
  const port: ModelPort = isModelPort(source) ? source : await portFromSource(source, options.kit)
  const schema = options.schema ?? kitDescriptor(port.kitId)?.schema
  if (!schema) throw new Error(`no schema for ${port.kitId}: pass options.schema or registerKit() its descriptor`)
  return new ModelDocument<Root, C>(kitBackend(port, schema), options.origin)
}
