/**
 * Kition's kits from Node, through `kition-kits serve`: the Kits Service API every host language
 * uses (`docs/sdk/hosts.md`). This process starts one service for a workspace folder and opens,
 * edits, and saves its files by path; the service runs each kit's headless executable and serves
 * it the files over the Kit Process Protocol (handles, staged and atomic writes, version checks). A
 * kit that serves the object model is scripted with the same proxies as a page
 * (`HeadlessDocument.model()`).
 *
 * Wire: JSON-RPC 2.0, one message per line, on the service's standard input and output.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { BatchError, parseSchema, schemaOfDescription, type BatchErrorCode, type BatchRequest, type BatchResult, type Schema } from '@kition/kdm'
import { ModelDocument, type ModelBackend, type ModelDescription, type OpenOptions } from './document'
import { kitDescriptor } from './kits'
import type { ConflictEvent, KitCommandInfo, SavedEvent } from './port'
import type { CommandMap, ModelObject } from './proxy'

/** The Kits Service API version this client speaks (`kits.initialize`'s `serviceVersion`). */
export const KITS_SERVICE_VERSION = 1

/**
 * An error the service answered: `reason` is the Kit Process Protocol's (`file_conflict`,
 * `command_not_found`, …) or the service's (`kit_unavailable`, `invalid_path`, `unknown_kit`).
 */
export class KitProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: { reason?: string; detail?: string; model?: { code: BatchErrorCode; index: number | null; message: string } } & Record<string, unknown>,
  ) {
    super(data?.detail ? `${message}: ${data.detail}` : message)
    this.name = 'KitProtocolError'
  }

  get reason(): string | undefined {
    return this.data?.reason
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/** A JSON-RPC connection over newline-delimited messages: the service's stdout in, stdin out. */
export class KitProtocolConnection {
  private next = 1
  private pending = new Map<number, Pending>()
  private closedWith: Error | null = null

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    createInterface({ input }).on('line', (line) => this.message(line))
    input.on('error', (error: Error) => this.fail(error))
    input.on('close', () => this.fail(new Error('kition-kits closed the connection')))
  }

  /** Sends a request; answers its `result`, or throws its `error` as a `KitProtocolError`. */
  request<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** Ends the connection: the service shuts its kits down and exits. */
  close() {
    this.output.end()
    this.fail(new Error('the connection is closed'))
  }

  private message(line: string) {
    let message: { id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: KitProtocolError['data'] } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    // Answers come as they finish; each carries its request's id.
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!pending || typeof message.id !== 'number') return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new KitProtocolError(message.error.code, message.error.message, message.error.data))
    else pending.resolve(message.result)
  }

  private fail(error: Error) {
    if (!this.closedWith) this.closedWith = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** A document open in a kit, as the service reports it. */
export type HeadlessDocumentState = {
  kitId: string
  documentId: string
  /** The workspace path, `/`-separated. */
  path: string | null
  title: string
  format: string
  readOnly: boolean
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /** The file changed under unsaved edits: `save()` fails `file_conflict`; `reload()` or `saveAs()`. */
  conflict: boolean
  /** Counts the kit's changes, so a view knows when to refresh. */
  version: number
  summary: string
  details: Record<string, unknown>
}

/** A kit the service knows (`kits.list`). */
export type KitStatus = { id: string; name: string; extensions: string[]; creates: string[]; installed: boolean }

export type LaunchOptions = {
  /** The workspace folder: every path is relative to it, and no file outside it is reached. */
  workspace: string
  /** A folder with one folder per kit holding its `kit.json` (an SDK bundle's `kits/`). */
  kitsDir?: string
  /** Kit executables, each found with the `kit.json` above it that names it. */
  kits?: string[]
  /** The `kition-kits` executable: `KITION_KITS` by default, else `kition-kits` on the PATH. */
  executable?: string
  /**
   * Extra environment for the service. Its kits start with the launch environment of the Kit Process
   * Protocol (section 3): a private folder for their current folder, home and temporary folder,
   * and of these variables only `KITION_FONTS_DIR`, `SOURCE_DATE_EPOCH`, `RUST_LOG`,
   * `RUST_BACKTRACE` and the `KITION_KIT_*` ones.
   */
  env?: Record<string, string>
  /** `inherit` shows the service's and the kits' stderr; `ignore` (default) drops it. */
  stderr?: 'inherit' | 'ignore'
}

export type HeadlessOpenOptions = {
  /** For a file that does not exist yet: options for the kit's new document (`width`, …). */
  create?: { options?: Record<string, unknown> }
}

/** `kition-kits serve` for one workspace, with this process as its host. */
export class KitsService {
  private constructor(
    readonly connection: KitProtocolConnection,
    readonly workspace: string,
    readonly kits: KitStatus[],
    private readonly child: ChildProcess | null,
  ) {}

  /** Starts `kition-kits serve` on `options.workspace` and initializes it. */
  static async launch(options: LaunchOptions): Promise<KitsService> {
    const workspace = resolve(options.workspace)
    const args = ['serve', '--workspace', workspace]
    if (options.kitsDir) args.push('--kits-dir', resolve(options.kitsDir))
    for (const kit of options.kits ?? []) args.push('--kit', resolve(kit))
    const executable = options.executable ?? process.env.KITION_KITS ?? 'kition-kits'
    const child = spawn(executable, args, { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', options.stderr ?? 'ignore'] })
    // Why the service stopped, when it stopped before answering: its output may close first.
    const stopped = new Promise<Error>((resolve) => {
      child.once('error', (error) => resolve(new Error(`cannot start ${executable}: ${error.message}`)))
      child.once('exit', (code) => resolve(new Error(`${executable} exited (${code}) before it answered`)))
    })
    const connection = new KitProtocolConnection(child.stdout!, child.stdin!)
    try {
      return await Promise.race([KitsService.connect(connection, workspace, child), stopped.then((error) => Promise.reject(error))])
    } catch (error) {
      const why = await Promise.race([stopped, new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))])
      child.kill()
      throw why ?? error
    }
  }

  /** Initializes a service over an existing connection (tests, or one another process started). */
  static async connect(connection: KitProtocolConnection, workspace: string, child: ChildProcess | null = null): Promise<KitsService> {
    const answer = await connection.request<{ serviceVersion: number; kits: KitStatus[] }>('kits.initialize', { client: { name: '@kition/script', version: '0' } })
    if (answer.serviceVersion !== KITS_SERVICE_VERSION) {
      connection.close()
      throw new Error(`kition-kits speaks Kits Service API ${answer.serviceVersion}; this client speaks ${KITS_SERVICE_VERSION}`)
    }
    return new KitsService(connection, resolve(workspace), answer.kits, child)
  }

  /** The workspace path of `path` (absolute, or already relative to the workspace). */
  private relative(path: string): string {
    return relative(this.workspace, resolve(this.workspace, path)).split(sep).join('/')
  }

  /** Opens the workspace file `path` in the kit that handles its extension. */
  async open(path: string): Promise<HeadlessDocument> {
    const state = await this.connection.request<HeadlessDocumentState>('documents.open', { path: this.relative(path) })
    return new HeadlessDocument(this, state)
  }

  /**
   * A new document at `path`, saved so the file exists. A new file never replaces one: when
   * `path` exists, the next free name (`Title 2.kslide`) is used; the document's `state.path` says.
   */
  async create(path: string, options: HeadlessOpenOptions['create'] = {}): Promise<HeadlessDocument> {
    const state = await this.connection.request<HeadlessDocumentState>('documents.create', { path: this.relative(path), options: options.options ?? {} })
    return new HeadlessDocument(this, state)
  }

  /** Ends the service, which shuts its kits down (documents close unsaved), and waits for it. */
  async shutdown(): Promise<void> {
    this.connection.close()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      const timer = setTimeout(() => child.kill(), 10_000)
      await exited
      clearTimeout(timer)
    }
  }
}

/** One document open in a kit. */
export class HeadlessDocument {
  private readonly savedListeners = new Set<(event: SavedEvent) => void>()
  private readonly conflictListeners = new Set<(event: ConflictEvent) => void>()

  constructor(
    readonly service: KitsService,
    private current: HeadlessDocumentState,
  ) {}

  get id(): string {
    return this.current.documentId
  }

  get kitId(): string {
    return this.current.kitId
  }

  /** The document's state as the service last answered it. */
  get state(): HeadlessDocumentState {
    return this.current
  }

  /** Asks the service for the document's state again. */
  async refresh(): Promise<HeadlessDocumentState> {
    this.current = await this.request<HeadlessDocumentState>('documents.get')
    return this.current
  }

  /**
   * The object model over this document, served by the kit (`model.describe`, `model.batch`).
   * The schema is the one registered for the kit (`@kition/script/kits/*`), else the kit's own
   * (`model.describe`).
   */
  async model<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(options: OpenOptions = {}): Promise<ModelDocument<Root, C>> {
    const schema: Schema | object | undefined = options.schema ?? kitDescriptor(this.kitId)?.schema
    const parsed = schema ? parseSchema(schema) : schemaOfDescription(await this.request<ModelDescription>('model.describe'))
    return new ModelDocument<Root, C>(headlessBackend(this, parsed), options.origin)
  }

  /** `command.list` for this document. */
  async commands(): Promise<KitCommandInfo[]> {
    const answer = await this.request<{ commands: KitCommandInfo[] }>('command.list')
    return answer.commands
  }

  /**
   * Runs a command outside the object model: as the host's person (`user`), the agent, or the
   * host itself on the person's behalf (`system`, by the host feature `originLabel`, `emailsync`).
   * A `system` change is no undo step: neither the person's undo nor an agent's takes it back.
   */
  async execute(command: string, params: Record<string, unknown> = {}, origin: 'user' | 'agent' | 'system' = 'user', originLabel?: string): Promise<unknown> {
    const answer = await this.request<{ result?: unknown; document: HeadlessDocumentState }>('command.execute', {
      command,
      params,
      origin,
      ...(originLabel ? { originLabel } : {}),
    })
    this.current = answer.document
    return answer.result
  }

  /**
   * Writes the document to its file. The save commits only while the file is the version the
   * kit read: a file changed meanwhile is a `KitProtocolError` with reason `file_conflict`.
   */
  async save(): Promise<void> {
    try {
      this.current = await this.request<HeadlessDocumentState>('documents.save')
    } catch (error) {
      if (error instanceof KitProtocolError && error.reason === 'file_conflict') for (const listener of [...this.conflictListeners]) listener({ message: error.message })
      throw error
    }
    this.saved()
  }

  /** Writes it to the workspace file `path`, in `format` or the file's; the document then lives there. */
  async saveAs(path: string, format?: string): Promise<void> {
    this.current = await this.request<HeadlessDocumentState>('documents.saveAs', { path: relative(this.service.workspace, resolve(this.service.workspace, path)).split(sep).join('/'), ...(format ? { format } : {}) })
    this.saved()
  }

  /** Reads the file again, dropping unsaved edits: resolves a conflict in favour of the file. */
  async reload(): Promise<void> {
    this.current = await this.request<HeadlessDocumentState>('documents.reload')
  }

  async close(discardChanges = false): Promise<void> {
    await this.request('documents.close', { discardChanges })
  }

  /** Hears this document's saves made through this handle. */
  onSaved(listener: (event: SavedEvent) => void): () => void {
    this.savedListeners.add(listener)
    return () => {
      this.savedListeners.delete(listener)
    }
  }

  /** Hears this handle's saves refused because the file changed since the kit read it. */
  onConflict(listener: (event: ConflictEvent) => void): () => void {
    this.conflictListeners.add(listener)
    return () => {
      this.conflictListeners.delete(listener)
    }
  }

  private saved() {
    for (const listener of [...this.savedListeners]) listener({ version: null, ...(this.current.path ? { uri: this.current.path } : {}) })
  }

  request<T>(method: string, params: object = {}): Promise<T> {
    return this.service.connection.request<T>(method, { kit: this.kitId, documentId: this.id, ...params })
  }
}

/** The kit's object model as a `ModelBackend`: every batch is one `model.batch`. */
function headlessBackend(document: HeadlessDocument, schema: Schema): ModelBackend {
  const call = async <T>(method: string, params: object): Promise<T> => {
    try {
      return await document.request<T>(method, params)
    } catch (error) {
      const model = error instanceof KitProtocolError ? error.data?.model : undefined
      throw model ? new BatchError(model.code, model.index, model.message) : error
    }
  }
  return {
    kitId: document.kitId,
    schema,
    batch: async (request: BatchRequest) => {
      const answer = await call<BatchResult>('model.batch', request)
      if ((request.ops?.length ?? 0) > 0) await document.refresh()
      return answer
    },
    describe: () => call<ModelDescription>('model.describe', {}),
    commands: () => document.commands(),
    version: () => null,
    // Saves through this handle (`uri` is the file's workspace path), and saves refused because
    // the file changed meanwhile.
    events: ['saved', 'conflict'],
    on: (event, listener) => {
      if (event === 'saved') return document.onSaved(listener as (event: SavedEvent) => void)
      if (event === 'conflict') return document.onConflict(listener as (event: ConflictEvent) => void)
      return () => undefined
    },
  }
}

export type OpenHeadlessOptions = Omit<LaunchOptions, 'workspace' | 'kits'> &
  HeadlessOpenOptions & {
    /** The workspace folder; the file's folder by default. */
    workspace?: string
  }

/** A document in a service this call started: `shutdown()` stops it and its kits. */
export type OpenedHeadless = HeadlessDocument & { shutdown: () => Promise<void> }

/**
 * Starts `kition-kits serve` with the kit executable `binary` and opens `file` in it; a file that
 * does not exist yet is created by the kit for its extension, and saved.
 */
export async function openHeadless(binary: string, file: string, options: OpenHeadlessOptions = {}): Promise<OpenedHeadless> {
  const path = resolve(file)
  const service = await KitsService.launch({ ...options, kits: [binary], workspace: options.workspace ?? dirname(path) })
  try {
    const document = existsSync(path) ? await service.open(path) : await service.create(path, options.create)
    return Object.assign(document, { shutdown: () => service.shutdown() })
  } catch (error) {
    await service.shutdown()
    throw error
  }
}
