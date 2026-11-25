import type { BatchRequest, BatchResult } from '@kition/kdm'

/** One kit command as a kit's catalogue lists it. */
export type KitCommandInfo = {
  id: string
  title?: string
  menu?: string[] | null
  shortcut?: string | null
  params?: string | null
  /** What the command does, when to choose it, and what it changes or answers (KitCommand::description). */
  description?: string
  schema?: unknown
  /** What the command answers, as one `ValueSchemaSpec` (KHP A1 `output.schema`). */
  outputSchema?: unknown
  mutates?: boolean
  enabled?: boolean
}

/** The document was written to its file or storage: the storage's new version, or the file it went to. */
export type SavedEvent = { version: string | null; uri?: string }
/** A save was refused because the file changed elsewhere since it was read: nothing was overwritten. */
export type ConflictEvent = { message: string }
/** The objects the person selected in the kit's editor, as KDM object ids. */
export type SelectionEvent = { ids: string[] }

/** The document events a source reports besides `changed`, and what each carries. */
export type DocumentEvents = { saved: SavedEvent; conflict: ConflictEvent; selection: SelectionEvent }
export type DocumentEventName = keyof DocumentEvents

/** The events a source reports: which (`events`), and how to hear one (`on`). */
export interface DocumentEventSource {
  /** The events of `DocumentEvents` this source reports; any other is never heard. */
  readonly events?: readonly DocumentEventName[]
  /** Hears one of `events`; answers an unsubscribe. */
  on?<E extends DocumentEventName>(event: E, listener: (value: DocumentEvents[E]) => void): () => void
}

/**
 * A document as the object model reaches it: a kit that answers the object model itself (`model`),
 * and its commands. A kit editor whose connection has the `model` capability, a kit engine with
 * `modelDescribe` and `modelBatch`, and an `@kition/embed` editor give one.
 */
export interface ModelPort extends DocumentEventSource {
  readonly kitId: string
  commands(): Promise<KitCommandInfo[]>
  /** Hears the kit's document move (its version when known). */
  onChanged?(listener: (version: Uint8Array | null) => void): () => void
  /** The kit's object model: each batch is one undo step of the person's history. */
  model: KitModel
}

/**
 * A kit's own `model/describe` and `model/batch`. `schema` is the kit's KDM schema, for a kit
 * whose engine does not describe its own. A refused batch rejects with a `BatchError`.
 */
export interface KitModel {
  describe(schema: object): Promise<Record<string, unknown>>
  /** `version` is the kit's replica version after the batch, when it has one. */
  batch(request: BatchRequest, schema: object): Promise<BatchResult & { version?: Uint8Array | null }>
}
