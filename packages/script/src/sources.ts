import type { BatchResult } from '@kition/kdm'
import type { DocumentEventName, DocumentEvents, DocumentEventSource, KitCommandInfo, ModelPort } from './port'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

export function isModelPort(value: unknown): value is ModelPort {
  return isObject(value) && typeof value.kitId === 'string' && isFunction(value.commands) && isObject(value.model) && isFunction(value.model.batch)
}

const bytes = (buffer: ArrayBuffer | Uint8Array): Uint8Array => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))

/** The parts of a `KitConnection` (`@kition/kit-host`) the object model uses. */
export type ConnectionLike = {
  kit: { id: string }
  capabilities: string[]
  ai: {
    commands: (query: string) => Promise<Array<Record<string, unknown>>>
  }
  replica: {
    onChanged: (listener: (version: ArrayBuffer) => void) => () => void
  }
  /**
   * Hears the kit's `presence/set` (Kit UI protocol section 7e): what the person selected, as KDM
   * object ids. With it, the document fires `selection`.
   */
  onPresence?: (listener: (presence: { selection: string[] }) => void) => () => void
  /** The kit's own object model (capability `model`). */
  model: {
    describe: (schema?: object) => Promise<Record<string, unknown>>
    batch: (params: Record<string, unknown>) => Promise<{ refs: Record<string, string>; results: unknown[]; loaded: Array<{ id: string; type: string; fields: Record<string, unknown> }>; version?: ArrayBuffer | null }>
  }
}

const isConnection = (value: unknown): value is ConnectionLike =>
  isObject(value) && isObject(value.kit) && Array.isArray(value.capabilities) && isObject(value.ai) && isObject(value.replica) && isObject(value.model)

/**
 * A kit editor in a frame (Kit UI protocol): the object model through `model/describe` and
 * `model/batch` (capability `model`), the command catalogue through the Kit AI bridge.
 */
export function portFromConnection(connection: ConnectionLike): ModelPort {
  if (!connection.capabilities.includes('model')) {
    throw new Error(`${connection.kit.id} was opened without the model capability: its kit does not answer the object model`)
  }
  const model = connection.model
  const onPresence = typeof connection.onPresence === 'function' ? connection.onPresence.bind(connection) : null
  return {
    kitId: connection.kit.id,
    commands: async () => (await connection.ai.commands('')) as KitCommandInfo[],
    onChanged: (listener) => connection.replica.onChanged((version) => listener(bytes(version))),
    ...(onPresence
      ? {
          events: ['selection'] as const,
          on: <E extends DocumentEventName>(event: E, listener: (value: DocumentEvents[E]) => void) =>
            event === 'selection' ? onPresence((presence) => (listener as (value: DocumentEvents['selection']) => void)({ ids: [...presence.selection] })) : () => undefined,
        }
      : {}),
    model: {
      describe: (schema) => model.describe(schema),
      batch: async (request, schema) => {
        const { version, ...result } = await model.batch({ ...request, schema })
        return { ...result, version: version ? bytes(version) : null }
      },
    },
  }
}

/** The members of a kit engine's class (`kition-kit`'s `export_kit_session!`) the object model uses. */
export type EngineLike = {
  commands: () => string
  /** `model/describe` as JSON text. */
  modelDescribe: () => string
  /** `model/batch`: the request and the answer as JSON text; a refusal throws an error whose message is `{"code", "index", "message"}`. */
  modelBatch: (request: string) => string
  version?: () => Uint8Array
}

const isEngine = (value: unknown): value is EngineLike => isObject(value) && isFunction(value.modelDescribe) && isFunction(value.modelBatch) && isFunction(value.commands)

/** An engine's refusal (its message is the batch error's JSON) as an error with that `data`. */
function engineError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message === null) return error
  try {
    const data = JSON.parse(message) as unknown
    if (isObject(data) && typeof data.code === 'string') return Object.assign(new Error(typeof data.message === 'string' ? data.message : message), { data })
  } catch {
    // Not the batch error's JSON: passed on as it is.
  }
  return error
}

/** A kit engine in this process (Node, a worker): each batch runs in the engine as one undo step. */
export function portFromEngine(engine: EngineLike, kitId: string, options: { onChanged?: ModelPort['onChanged'] } & DocumentEventSource = {}): ModelPort {
  return {
    events: options.events,
    on: options.on,
    kitId,
    commands: async () => JSON.parse(engine.commands()) as KitCommandInfo[],
    onChanged: options.onChanged,
    model: {
      describe: async () => JSON.parse(engine.modelDescribe()) as Record<string, unknown>,
      batch: async (request) => {
        let answer: string
        try {
          answer = engine.modelBatch(JSON.stringify(request))
        } catch (error) {
          throw engineError(error)
        }
        return { ...(JSON.parse(answer) as BatchResult), version: engine.version ? engine.version() : null }
      },
    },
  }
}

/** An editor of `@kition/embed` (it gives its own port), a `KitConnection`, or an engine. */
export async function portFromSource(source: unknown, kit?: string): Promise<ModelPort> {
  if (isObject(source) && isFunction(source.modelPort)) return (await (source.modelPort as () => ModelPort | Promise<ModelPort>)()) as ModelPort
  if (isConnection(source)) return portFromConnection(source)
  if (isEngine(source)) {
    if (!kit) throw new Error('an engine does not name its kit: pass options.kit')
    return portFromEngine(source, kit)
  }
  throw new Error('openDocument takes a ModelPort, an @kition/embed editor, a KitConnection with the model capability, or a kit engine with modelDescribe and modelBatch')
}
