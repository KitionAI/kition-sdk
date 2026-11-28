import type { KitCommand, KitModuleManifest, KitModuleReplica, KitSavedReplica } from './kitModule'
import type { LentFiles } from './lentFiles'
import type { RasterPins } from './rasterViewport'
import { INVALID_PARAMS_REASON, type DraftSummary, type KitDiagnostic, type ModelBatchResult, type RestoreOrigin } from '@kition/kit-ui-protocol'
import type { Origin, StateDiff } from '@kition/kdm'
import { KitModelError, type KitModelSupport, type ModelErrorData } from './kitModel'
import { READ_ONLY_REASON, ReadOnlyError } from './readOnly'
import { KitEngineRefusal, KitParamsError, UNSUPPORTED_REASON, type KitParamError } from './refusal'

/** What the page keeps in sync about the open document after every request that can change it. */
export type KitEngineInfo = {
  width: number
  height: number
  pinned: RasterPins
  revision: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /** The SDK's `inspect()` JSON; each kit's editor reads its own fields from it. */
  inspected: Record<string, unknown>
  /** The replica's version, when the engine follows its replica and has made one. */
  replica?: Uint8Array | null
  /** How the engine answers the object model (`kitModel.ts`); absent or null: it does not. */
  model?: KitModelSupport
  /**
   * Whether the engine runs commands as an origin (engine contract 2, `executeAs`), so the agent's
   * steps are its own undo scope (KitModel M12a) and the agent's undo never takes back the
   * person's edit; absent: it does not.
   */
  origins?: boolean
  /**
   * Whether the engine keeps editor state and takes a call context (`editorState`,
   * `restoreEditorState`, `setContext`), so an agent's step can run in an editor state of the
   * agent's own (`KitAgentStep`) without moving the person's; absent: it does not.
   */
  context?: boolean
  /**
   * Whether the engine says what changed since a version of its replica (`version`,
   * `changesSince`), so the agent's write is answered with what it changed (`modelChanges`);
   * absent: it does not.
   */
  changes?: boolean
  /** The engine answers kit-defined premise reads for the live editor. */
  premises?: boolean
  /**
   * The schema version the engine's replica reads and the newest one its changes were written
   * under (KitModel rule M5a), read when the document opens and after imports; absent or
   * null for an engine that does not answer them.
   */
  schema?: KitEngineSchema | null
}

/** What one agent step acts on and in (Kit Process Protocol section 7a's `context.set`): the ids, the part, the time. */
export type KitCallContext = { on?: Array<string | number>; part?: Record<string, unknown>; time?: number }

/**
 * An agent's own editor state over one `ai/run` (C3b): what the kit's `editorState()` answered
 * after the agent's last step, `null` before its first (the step then starts from the person's).
 * Each step updates it.
 */
export type KitAgentState = { state: string | null }

/**
 * An agent step on the live document in the agent's own editor state: in one turn of the engine
 * the person's state is put aside, `state` is put in place and `set` (the step's call context)
 * set, the command runs, the agent's state is kept in `state`, and the person's is put back.
 */
export type KitAgentStep = { state: KitAgentState; set: KitCallContext | null }

/** What `modelChanges` answers: the change set and the version now, or no change set and why. */
export type KitModelChanges = { changes: StateDiff; version: string } | { changes: null; unavailable: string; version: string }

/** A replica's schema versions: what it reads, and the newest its changes name (`null`: none). */
export type KitEngineSchema = { reads: number; newestAuthor: number | null }

/** How a document opens with a replica: a stored one to open with, and whether `info` follows it. */
export type KitEngineReplica = { stored: KitModuleReplica | null; follow: boolean }

export type KitEngineRequest =
  | { method: 'open'; manifest: KitModuleManifest; name: string; bytes: ArrayBuffer; lent: LentFiles | null; replica?: KitEngineReplica | null; readOnly?: boolean; canComment?: boolean }
  | { method: 'create'; manifest: KitModuleManifest; name: string; width: number; height: number; lent: LentFiles | null; readOnly?: boolean }
  | { method: 'execute'; command: string; params: Record<string, unknown>; origin?: Origin; agent?: { state: string | null; set: KitCallContext | null } }
  | { method: 'render'; x: number; y: number; scale: number; width: number; height: number }
  | { method: 'renderArea'; x0: number; y0: number; x1: number; y1: number; width: number; height: number }
  | { method: 'commands' }
  | { method: 'disabledCommands' }
  | { method: 'check' }
  | { method: 'lendHandle'; handle: string; bytes: ArrayBuffer | null }
  | { method: 'takeOutput'; id: string; max?: number }
  | { method: 'save' }
  | { method: 'markSaved'; revision?: number }
  | { method: 'info' }
  | { method: 'fonts' }
  | { method: 'invoke'; name: string; args: unknown[] }
  | { method: 'tool'; name: KitToolMethod; args: unknown[]; settled: boolean; quiet?: boolean }
  | { method: 'saveWithReplica' }
  | { method: 'replicaVersion' }
  | { method: 'replicaExport'; since: ArrayBuffer }
  | { method: 'replicaImport'; changes: ArrayBuffer; blobs: ArrayBuffer }
  | { method: 'replicaDocId' }
  | { method: 'replicaMerge'; changes: ArrayBuffer; blobs: ArrayBuffer; origin: Origin }
  | { method: 'replicaCompare'; changes: ArrayBuffer }
  | { method: 'replicaRestore'; snapshot: ArrayBuffer; blobs: ArrayBuffer; origin: RestoreOrigin }
  | { method: 'modelVersion' }
  | { method: 'modelChanges'; since: string }
  | { method: 'modelDescribe' }
  | { method: 'modelBatch'; request: Record<string, unknown> }
  | { method: 'modelReply'; value: unknown }
  | { method: 'premiseRead'; name: string; params: Record<string, unknown> }
  | { method: 'inspectAt'; context: KitCallContext; part?: number }

/** The engine-tools capability's methods (kit editors U8b), each answering JSON. */
/**
 * The engine tools' members (contract "Engine tools"). `pointerLeft` is optional: a kit without it
 * answers nothing, and the call changes nothing.
 */
export type KitToolMethod = 'tools' | 'tool' | 'selectTool' | 'pointer' | 'pointerLeft' | 'toolKey' | 'toolText' | 'toolPreedit' | 'toolState'

/**
 * A refusal names its reason (`read-only`; `invalid-params` with the engine's `errors`;
 * `unsupported`), so the page can tell it from a failure; a refused object-model batch carries
 * the protocol's error `data`.
 */
export type KitEngineResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string; reason?: string; data?: ModelErrorData; errors?: KitParamError[] }

/**
 * What the worker tells the page unasked: `fonts`, how many of the manifest's `lazyFonts` the
 * engine has not been given yet, when the document opens and after each one is in.
 */
export type KitEngineEvent = { fonts: number }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const CLOSED_INFO: KitEngineInfo = { width: 0, height: 0, pinned: { left: 0, top: 0 }, revision: 0, dirty: false, canUndo: false, canRedo: false, inspected: {} }

/**
 * The page's handle on one document open in a kit engine worker. Every call
 * is asynchronous and answered in order; `info` is current after each change.
 */
export class KitEngine {
  closed = false
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failure: Error | null = null
  private readonly fontListeners = new Set<() => void>()
  /** How many of the manifest's `lazyFonts` the engine has not been given yet. */
  fontsPending = 0

  private constructor(private readonly worker: Worker, public info: KitEngineInfo) {}

  /**
   * Starts a worker and opens the file's bytes in it with the kit's SDK; the bytes move to the
   * worker. `lent` is where the document's other files (media) are read from, if anywhere;
   * `replica` the stored replica to open them with, and whether `info` follows the replica.
   * `readOnly` opens it for viewing: the worker refuses edits (`ReadOnlyError`, see `readOnly.ts`);
   * with `canComment` (a commenter), it still runs the manifest's `commentCommands`, as long as
   * they change only comment objects.
   */
  static async open(manifest: KitModuleManifest, name: string, bytes: ArrayBuffer, lent: LentFiles | null = null, replica: KitEngineReplica | null = null, readOnly = false, canComment = false) {
    const worker = new Worker(new URL('./kitEngine.worker.ts', import.meta.url), { type: 'module' })
    const engine = new KitEngine(worker, CLOSED_INFO)
    worker.onmessage = (event: MessageEvent<KitEngineResponse | KitEngineEvent>) => engine.settle(event.data)
    worker.onerror = (event) => engine.fail(new Error(event.message || 'the kit engine stopped'))
    try {
      const stored = replica?.stored
      engine.info = (await engine.call({ method: 'open', manifest, name, bytes, lent, replica, readOnly, canComment }, stored ? [bytes, stored.snapshot, stored.blobs] : [bytes])) as KitEngineInfo
      return engine
    } catch (error) {
      engine.dispose()
      throw error
    }
  }

  /**
   * Starts a worker with a new, empty document made by the kit's SDK; nothing is written yet.
   * `lent` lets it read other files, for example the clip a video project is made from.
   */
  static async create(manifest: KitModuleManifest, name: string, width: number, height: number, lent: LentFiles | null = null, readOnly = false) {
    const worker = new Worker(new URL('./kitEngine.worker.ts', import.meta.url), { type: 'module' })
    const engine = new KitEngine(worker, CLOSED_INFO)
    worker.onmessage = (event: MessageEvent<KitEngineResponse | KitEngineEvent>) => engine.settle(event.data)
    worker.onerror = (event) => engine.fail(new Error(event.message || 'the kit engine stopped'))
    try {
      engine.info = (await engine.call({ method: 'create', manifest, name, width, height, lent, readOnly })) as KitEngineInfo
      return engine
    } catch (error) {
      engine.dispose()
      throw error
    }
  }

  get width() {
    return this.info.width
  }

  get height() {
    return this.info.height
  }

  get pinned() {
    return this.info.pinned
  }

  private settle(response: KitEngineResponse | KitEngineEvent) {
    if (!('id' in response)) {
      const added = response.fonts < this.fontsPending
      this.fontsPending = response.fonts
      if (added) for (const listener of this.fontListeners) listener()
      return
    }
    const waiting = this.pending.get(response.id)
    if (!waiting) return
    this.pending.delete(response.id)
    if (response.ok === true) waiting.resolve(response.value)
    else if (response.data) waiting.reject(new KitModelError(response.data))
    else if (response.reason === READ_ONLY_REASON) waiting.reject(new ReadOnlyError('', response.error))
    else if (response.reason === INVALID_PARAMS_REASON) waiting.reject(new KitParamsError(response.error, response.errors ?? []))
    else if (response.reason === UNSUPPORTED_REASON) waiting.reject(new KitEngineRefusal(UNSUPPORTED_REASON, response.error))
    else waiting.reject(new Error(response.error))
  }

  private fail(error: Error) {
    this.failure = error
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }

  private call(request: KitEngineRequest, transfer: Transferable[] = []) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, request }, transfer)
    })
  }

  /**
   * Runs an engine command, as `origin` when given and the engine runs commands as an origin
   * (`executeAs`); with `agent`, in the agent's own editor state (`KitAgentStep`), which it
   * updates.
   */
  async execute(command: string, params: Record<string, unknown> = {}, origin?: Origin, agent?: KitAgentStep) {
    const request: KitEngineRequest = { method: 'execute', command, params, ...(origin ? { origin } : {}), ...(agent ? { agent: { state: agent.state.state, set: agent.set } } : {}) }
    // `null` when nothing `info` holds changed (a read): the info the page has stays.
    const { result, info, state, closed } = (await this.call(request)) as { result: string; info: KitEngineInfo | null; state?: string | null; closed?: boolean }
    if (closed) {
      this.closed = true
      this.info = CLOSED_INFO
    }
    if (info) this.info = info
    if (agent && state !== undefined) agent.state.state = state
    return result
  }

  /** RGBA8 of the area at (`x`, `y`) document pixels shown at `scale` screen pixels per pixel. */
  async render(x: number, y: number, scale: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'render', x, y, scale, width, height })) as ArrayBuffer)
  }

  /** RGBA8 of the document area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  async renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'renderArea', x0, y0, x1, y1, width, height })) as ArrayBuffer)
  }

  async commands() {
    return (await this.call({ method: 'commands' })) as KitCommand[]
  }

  /** The ids of the commands that cannot run now: the cheap call for menu and shortcut states. */
  async disabledCommands() {
    return (await this.call({ method: 'disabledCommands' })) as string[]
  }

  /** The engine's diagnostics on the document (KHP A21), errors first; none from an engine without `check`. */
  async check() {
    return (await this.call({ method: 'check' })) as KitDiagnostic[]
  }

  /**
   * Lends a granted file's bytes to the engine under its handle (engine contract E15), before a command that
   * names the handle runs; `null` takes them back. The bytes move to the worker.
   */
  async lendHandle(handle: string, bytes: ArrayBuffer | null) {
    await this.call({ method: 'lendHandle', handle, bytes }, bytes ? [bytes] : [])
  }

  /**
   * The next chunk of a file a command produced (engine contract E16), at most `max` bytes: take chunks until
   * the output's `size`; the engine then forgets it. An engine without outputs refuses every id.
   */
  async takeOutput(id: string, max?: number) {
    return new Uint8Array((await this.call({ method: 'takeOutput', id, ...(max === undefined ? {} : { max }) })) as ArrayBuffer)
  }

  /** The document as file bytes; it stays unsaved until `markSaved`. */
  async save() {
    return (await this.serialize()).bytes
  }

  /**
   * The document as file bytes and the revision they hold, which may be later than `info`'s when
   * commands were still on their way to the engine: give it to `markSaved`.
   */
  async serialize() {
    const saved = (await this.call({ method: 'save' })) as { bytes: ArrayBuffer; revision: number }
    return { bytes: new Uint8Array(saved.bytes), revision: saved.revision }
  }

  /**
   * The document as file bytes with its replica and the replica's version taken at the same
   * moment (null when the engine has none to give), so the stored replica holds exactly what the
   * file does and a checkpoint names exactly that version (UI-R6), and the revision they hold (see
   * `serialize`).
   */
  async saveWithReplica() {
    const saved = (await this.call({ method: 'saveWithReplica' })) as { bytes: ArrayBuffer; replica: KitSavedReplica | null; revision: number }
    return { bytes: new Uint8Array(saved.bytes), replica: saved.replica, revision: saved.revision }
  }

  /** The replica's version; the engine makes its replica now if it has none yet. */
  async replicaVersion() {
    return (await this.call({ method: 'replicaVersion' })) as ArrayBuffer
  }

  /** The replica's changes since `since` (empty: all of them) and every blob they may need. */
  async replicaExport(since: ArrayBuffer) {
    return (await this.call({ method: 'replicaExport', since })) as { changes: ArrayBuffer; blobs: ArrayBuffer }
  }

  /** Imports another replica's changes (and their blobs) into the document; answers the damage. */
  async replicaImport(changes: ArrayBuffer, blobs: ArrayBuffer) {
    const { damage, info } = (await this.call({ method: 'replicaImport', changes, blobs })) as { damage: unknown; info: KitEngineInfo }
    this.info = info
    return damage
  }

  /** The replica's own id (the kit module's `docId`), or `null` when the engine has none. */
  async replicaDocId() {
    return (await this.call({ method: 'replicaDocId' })) as string | null
  }

  /**
   * Takes a draft's changes (and their blobs) into the document as one step of the person's undo
   * history, recorded as `origin` (Kit UI protocol section 7d), through the engine's
   * `mergeChanges`. Answers what changed. A refusal rejects with a `KitModelError`; an engine
   * without `mergeChanges` refuses (`unsupported`).
   */
  async replicaMerge(changes: ArrayBuffer, blobs: ArrayBuffer, origin: Origin) {
    const { summary, info } = (await this.call({ method: 'replicaMerge', changes, blobs, origin })) as { summary: DraftSummary; info: KitEngineInfo }
    this.info = info
    return summary
  }

  /** What merging a draft's changes would change in the document now (the engine's `compareChanges`). */
  async replicaCompare(changes: ArrayBuffer) {
    return (await this.call({ method: 'replicaCompare', changes })) as DraftSummary
  }

  /**
   * Writes the state `snapshot` holds (a checkpoint's) over the document as one change of
   * `origin`, one step of the person's undo (`replica/restore`, the engine's `restoreState`), after
   * adding `blobs`. Answers the damage.
   */
  async replicaRestore(snapshot: ArrayBuffer, blobs: ArrayBuffer, origin: RestoreOrigin) {
    const { damage, info } = (await this.call({ method: 'replicaRestore', snapshot, blobs, origin })) as { damage: unknown; info: KitEngineInfo }
    this.info = info
    return damage
  }

  /** The replica's version, base64 (C3b): what `modelChanges` takes back. */
  async modelVersion() {
    return (await this.call({ method: 'modelVersion' })) as string
  }

  async premiseRead(name: string, params: Record<string, unknown>) {
    return this.call({ method: 'premiseRead', name, params })
  }

  async inspectAt(context: KitCallContext, part?: number) {
    return (await this.call({ method: 'inspectAt', context, part })) as { details: Record<string, unknown>; part?: unknown }
  }

  /**
   * What changed since the replica version `since` (base64), with the version now: a change set,
   * or `null` and why when the replica's history does not hold `since` (C3b, as Kit Process
   * Protocol's `model.changes`), through the engine's `changesSince`.
   */
  async modelChanges(since: string) {
    return (await this.call({ method: 'modelChanges', since })) as KitModelChanges
  }

  /** `model/describe` (`kitModel.ts`): the engine's own description. */
  async modelDescribe() {
    return (await this.call({ method: 'modelDescribe' })) as Record<string, unknown>
  }

  /**
   * An agent's reply (`ai/inspect`, `document/check`, `ai/run`) with its object ids as tool ids,
   * through the engine's `modelReply`; as it is when the engine has none or cannot translate it.
   */
  async agentReply<T>(value: T): Promise<T> {
    return (await this.call({ method: 'modelReply', value })) as T
  }

  /**
   * `model/batch`: answers `{ refs, results, loaded, version }`, `version` the replica's after it
   * (null when there is none). A refused batch rejects with a `KitModelError`.
   */
  async modelBatch(request: Record<string, unknown>) {
    const { answer, info } = (await this.call({ method: 'modelBatch', request })) as { answer: ModelBatchResult; info: KitEngineInfo }
    this.info = info
    return answer
  }

  /**
   * Marks the document saved; with `revision` (what `serialize` answered) only if it has not
   * changed since, so an edit that reached the engine after the bytes were taken stays unsaved.
   */
  async markSaved(revision?: number) {
    this.info = (await this.call({ method: 'markSaved', revision })) as KitEngineInfo
  }

  /**
   * Calls `listener` each time the engine was given one of the manifest's `lazyFonts`: what it
   * draws may have changed (text it drew as missing glyphs), so the page draws again. Answers how
   * to stop.
   */
  onFonts(listener: () => void): () => void {
    this.fontListeners.add(listener)
    return () => this.fontListeners.delete(listener)
  }

  /** Gives the engine every one of the manifest's `lazyFonts` now; resolves once each is in (or skipped). */
  async loadFonts() {
    await this.call({ method: 'fonts' })
  }

  /** Brings `info` up to date after changes it does not follow (an `invoke` that edits, such as a merge of the file). */
  async refreshInfo() {
    this.info = (await this.call({ method: 'info' })) as KitEngineInfo
    return this.info
  }

  /**
   * Calls one of the kit module's own document methods beyond the shared contract, for example
   * Photo's `selectionOutline`. Typed-array results arrive as that array. Changes made this way
   * are not reflected in `info`; use `execute` for edits.
   */
  async invoke<T = unknown>(name: string, ...args: unknown[]) {
    return (await this.call({ method: 'invoke', name, args })) as T
  }

  /**
   * Calls one of the engine's tool methods and returns its parsed answer. `info` is brought up
   * to date when the call changed the document, or always when `settled` (the end of a gesture,
   * which may change only the selection); mid-drag calls skip that, since `inspect()` costs.
   * `quiet`: while the answer is a gesture's (busy, not settled), `inspect()` is not read again at
   * all: `info` follows the revision, size and saved state, and keeps its last `inspected` until
   * the settled call that ends the gesture reads it once.
   */
  async tool<T = unknown>(name: KitToolMethod, args: unknown[] = [], settled = false, quiet = false) {
    const { value, info } = (await this.call({ method: 'tool', name, args, settled, ...(quiet ? { quiet } : {}) })) as { value: T; info: KitEngineInfo | null }
    if (info) this.info = info
    return { value, changed: info != null }
  }

  dispose() {
    this.worker.terminate()
    this.fail(new Error('the document was closed'))
  }
}
