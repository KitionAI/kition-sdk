/**
 * `@kition/script/node`: kit engines in Node, with no page. A kit package (`<kit>-ui/`, as Kition
 * ships it) carries its engine as WebAssembly; `openKitPackage` loads it in-process and opens
 * documents with it, so scripts run headless against the same engine the editor runs.
 * `openHeadless` instead opens the file in a kit's native executable, through `kition-kits serve`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// Every generated kit's schema, so a document of any of them opens without `registerKit`.
import '../kits/index'
import { openDocument, type ModelDocument, type OpenOptions } from './document'
import type { CommandMap, ModelObject } from './proxy'
import type { DocumentEventSource, SavedEvent } from './port'
import { portFromEngine, type EngineLike } from './sources'

type EngineClass = {
  open: (name: string, bytes: Uint8Array) => KitEngine
  create: (name: string, width: number, height: number) => KitEngine
  prototype: object
}

/** A kit engine's document, as its class exposes it. */
export type KitEngine = EngineLike & {
  execute: (command: string, params: string) => string
  save: (name?: string) => Uint8Array
  markSaved: () => void
  readonly dirty: boolean
  free?: () => void
}

/** One open document of a kit engine in Node. */
export type NodeKitDocument = {
  readonly kitId: string
  readonly engine: KitEngine
  /** The object model over this document. */
  model: <Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(options?: OpenOptions) => Promise<ModelDocument<Root, C>>
  /** The document as file bytes, in `name`'s format or its own. */
  save: (name?: string) => Uint8Array
  close: () => void
}

export type KitPackage = {
  readonly kitId: string
  readonly version: string
  /** The package's KDM schema (`model/schema.json`) when it ships one; documents use it over the bundled kit's. */
  readonly schema?: object
  open: (name: string, bytes: Uint8Array) => NodeKitDocument
  create: (name: string, size?: { width: number; height: number }) => NodeKitDocument
}

/**
 * Loads the engine of the kit package in `dir` (the folder holding `kit-ui.json` and `engine/`).
 * A package that ships its KDM schema (`model/schema.json`) opens its documents with it, since it is
 * the schema its engine was built with; otherwise the bundled kit's (`@kition/script/kits`) is used.
 */
export async function openKitPackage(dir: string): Promise<KitPackage> {
  const manifest = JSON.parse(readFileSync(join(dir, 'kit-ui.json'), 'utf8')) as { kitId: string; version: string }
  const schemaFile = join(dir, 'model', 'schema.json')
  const schema = existsSync(schemaFile) ? (JSON.parse(readFileSync(schemaFile, 'utf8')) as { kit?: unknown }) : undefined
  if (schema && schema.kit !== manifest.kitId) throw new Error(`${schemaFile} is the schema of ${String(schema.kit)}, not of ${manifest.kitId}`)
  const engineDir = join(dir, 'engine')
  const files = readdirSync(engineDir)
  const script = files.find((name) => name.endsWith('.js') && !name.endsWith('.worker.js'))
  const wasm = files.find((name) => name.endsWith('_bg.wasm'))
  if (!script || !wasm) throw new Error(`${engineDir} holds no engine (a wasm-bindgen module and its .wasm)`)
  const module = (await import(pathToFileURL(join(engineDir, script)).href)) as Record<string, unknown> & { initSync: (options: { module: Uint8Array }) => unknown }
  module.initSync({ module: readFileSync(join(engineDir, wasm)) })
  const engineClass = Object.values(module).find(
    (value): value is EngineClass => typeof value === 'function' && typeof (value as { open?: unknown }).open === 'function' && 'exportChanges' in ((value as { prototype?: object }).prototype ?? {}),
  )
  if (!engineClass) throw new Error(`${script} exports no contract 2 engine class`)
  const wrap = (engine: KitEngine): NodeKitDocument => {
    // `saved` for the object model's documents: this handle's `save()` made the file's bytes.
    const saved = new Set<(event: SavedEvent) => void>()
    const on: DocumentEventSource['on'] = (event, listener) => {
      if (event !== 'saved') return () => undefined
      const heard = listener as (event: SavedEvent) => void
      saved.add(heard)
      return () => {
        saved.delete(heard)
      }
    }
    return {
      kitId: manifest.kitId,
      engine,
      model: (options) => openDocument(portFromEngine(engine, manifest.kitId, { events: ['saved'], on }), { kit: manifest.kitId, ...(schema ? { schema } : {}), ...options }),
      save: (name) => {
        const bytes = engine.save(name)
        engine.markSaved()
        for (const listener of [...saved]) listener({ version: null })
        return bytes
      },
      close: () => engine.free?.(),
    }
  }
  return {
    kitId: manifest.kitId,
    version: manifest.version,
    ...(schema ? { schema } : {}),
    open: (name, bytes) => wrap(engineClass.open(name, bytes)),
    create: (name, size = { width: 960, height: 540 }) => wrap(engineClass.create(name, size.width, size.height)),
  }
}

export {
  HeadlessDocument,
  KITS_SERVICE_VERSION,
  KitProtocolConnection,
  KitProtocolError,
  KitsService,
  openHeadless,
  type HeadlessDocumentState,
  type HeadlessOpenOptions,
  type KitStatus,
  type LaunchOptions,
  type OpenedHeadless,
  type OpenHeadlessOptions,
} from './headless'
export { createAgentRelay, type AgentRelay, type RelayMessage } from './agentRelay'
export {
  DraftCommandError,
  workspaceDrafts,
  type DraftComparison,
  type DraftDiff,
  type DraftObjectChange,
  type DraftObjectId,
  type DraftPosition,
  type DraftValue,
  type WorkspaceDraft,
  type WorkspaceDrafts,
  type WorkspaceDraftsOptions,
} from './drafts'
export * from './index'
