/**
 * The engine contract from JavaScript (Kition platform docs/platform/reference/contract.md): how a kit's engine, compiled to
 * WebAssembly or written in TypeScript (`ts-worker`), is loaded and opened. Every kit exposes the same document class shape, so one
 * worker, one client, and one document hook serve every kit.
 */

import { LazyFonts, type AddFont } from './lazyFonts'

/** One engine command, as the editor's menus and shortcuts show it. */
export type KitCommand = {
  id: string
  title: string
  /** What the command does, when to choose it, and what it changes or answers (KitCommand::description); null when the kit has not said. */
  description: string | null
  /** The command's family, the id's first segment. */
  group: string
  mutates: boolean
  enabled: boolean
  /** The menu path, for example ["Layer", "New"]; empty when it is not in a menu. */
  menu: string[]
  /** As `Cmd+Shift+N`; `Cmd` is Control off macOS. */
  shortcut: string | null
  /** The parameters as a DeepSeek Harness `ParameterSchemaSpec`; commands with one can be agent tools. */
  schema?: Record<string, unknown> | null
  /** What the command answers, as one `ValueSchemaSpec` (KHP A1 `output.schema`); hosts send it as the tool's MCP `outputSchema`. */
  outputSchema?: Record<string, unknown> | null
  /** The engine's own parameter notes, as the agent reads them. */
  params?: string | null
  /** Words an agent's command search finds it by that its title and params do not say (the effect names `effect.apply` takes); searched, never shown. */
  keywords?: string[] | null
}

/** The contract version this host implements (`contractVersion()` in the Rust crate). */
const KIT_CONTRACT_VERSION = 1

/**
 * How the engine is built (`engine.runtime` in kit.json, rule K11): `rust-wasm`, a wasm-pack
 * module (`<module>.js` and `<module>_bg.wasm`), or `ts-worker`, an ES module `<module>.js` whose
 * default export prepares it given `{ base }` (`@kition/kit-engine`'s `KitEngineInit`).
 */
export type KitModuleRuntime = 'rust-wasm' | 'ts-worker'

/** Where a kit's engine module lives: `<base>/<module>.js`, and `<module>_bg.wasm` for a Rust engine. */
export type KitModuleManifest = {
  /** The kit id, for example `kit.photo`. */
  kitId: string
  /** The folder holding the module, as a URL (absolute, or relative to the page). */
  base?: string
  /** Without `base`: the folder under the host's `/kits/` (host-drawn editors). */
  dir?: string
  /** The wasm-pack module name, for example `kition_photo_kit`. */
  module: string
  /** The exported document class, for example `PhotoDocument`. */
  documentClass: string
  /** `rust-wasm` when absent. */
  runtime?: KitModuleRuntime
  /**
   * Extra methods (declared `extras`) the worker calls on every document it opens or makes,
   * before the first render: an embedded editor's view options, such as one slide at a time.
   */
  setup?: Array<{ method: string; args: unknown[] }>
  /**
   * Font files (URLs) given to the engine's `addFont(bytes)` once it loads, in order, before any
   * document opens: the faces the first frame needs (the primary face). One that does not load is
   * skipped; text in it shows in the engine's own faces.
   */
  fonts?: string[]
  /**
   * Font files (URLs) given to `addFont` after the document opened, in order (engine contract E9):
   * faces for scripts the engine does not embed and few documents use (a CJK or emoji font in a
   * web build), so the first frame does not wait for them. They load once the engine's
   * `wantsFonts()` says text needed a face it does not have, or right after the document opens
   * when the engine has no `wantsFonts`. `KitEngine.onFonts` tells the page when each one is in,
   * since what the engine draws may then change.
   */
  lazyFonts?: string[]
  /**
   * The commands that write only comment threads (KitModel rule M23): the kit's
   * `kit.json` `collaboration.comments.commands`. A commenter's read-only session runs them (the
   * Kit UI protocol's `document.comments.canComment`); see `readOnly.ts`.
   */
  commentCommands?: readonly string[]
}

/** One open document, as every kit module exposes it to JavaScript. */
export interface KitModuleDocument {
  readonly width: number
  readonly height: number
  /** Bands that stay in view while the rest scrolls, in document pixels (Standard E10); optional. */
  readonly pinnedLeft?: number
  readonly pinnedTop?: number
  /** Moves with every change. */
  readonly revision: bigint
  readonly dirty: boolean
  /** RGBA8 of the area at (`x`, `y`) document pixels shown at `scale` screen pixels per pixel. */
  render(x: number, y: number, scale: number, width: number, height: number): Uint8Array
  /** RGBA8 of the document area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Uint8Array
  /** Runs an engine command with JSON parameters; returns its JSON result. */
  execute(command: string, params: string): string
  /** The document as JSON; it includes `canUndo` and `canRedo`. */
  inspect(): string
  /** Every command as JSON: id, title, menu path, shortcut, mutates, enabled. */
  commands(): string
  /** The ids of the commands that cannot run now, as JSON; optional in contract 1. */
  disabledCommands?(): string
  /** The document's diagnostics as JSON `{ diagnostics: [...] }` (KHP A21); optional, engines before it have none. */
  check?(): string
  /** The next chunk of a file a command produced (engine contract E16), at most `max` bytes; optional, engines before it make none. */
  takeOutput?(id: string, max?: number): Uint8Array
  /** The document as file bytes; it stays unsaved until `markSaved`. */
  save(name?: string): Uint8Array
  /** Records that the bytes from the last `save` reached the file. */
  markSaved(): void
  free(): void
  // Engine contract 2's replica members (optional): the document as a KDM replica.
  /** Whether the document has made its replica yet (it makes one lazily); absent: it always has one. */
  readonly hasReplica?: boolean
  /** The replica's version; makes the replica if there is none yet. */
  version?(): Uint8Array
  exportChanges?(since: Uint8Array): Uint8Array
  /** Answers the damage as JSON. Add the changes' blobs first. */
  importChanges?(changes: Uint8Array): string
  snapshot?(): Uint8Array
  /** Every blob the replica references, for `addBlobs`. */
  blobs?(): Uint8Array
  /** Only the blobs new changes since `since` may need, when the engine can tell; narrower than
   * `blobs()` for a client that already has most of them. Protocol minor version 1.3. */
  blobsSince?(since: Uint8Array): Uint8Array
  addBlobs?(blobs: Uint8Array): void
  /** The replica's own id (a sync room's `docId`), when the engine's document is tied to one.
   * Protocol minor version 1.3; absent (not merely empty) means the engine has none. */
  readonly docId?: string
  /** Undo and redo of the engine's own history (contract 2); `undo()` answers `{"done", "damage"}`. */
  canUndo?(): boolean
  canRedo?(): boolean
  /** Runs a command as `origin`, the KDM's commit form `[kind, principal, label]` (contract 2). */
  executeAs?(command: string, params: string, origin: string): string
  /** The schema version the replica reads (its kit's `model.schemaVersion`). */
  schemaVersion?(): number
  /**
   * The newest schema version any of the replica's changes was written under (KitModel
   * rule M5a); `null` or `undefined` when none records one. Above `schemaVersion()`, a newer kit
   * edited the document: the editor tells its host (`document/schema`).
   */
  authorSchemaVersion?(): number | null | undefined
  /**
   * The object model answered by the engine itself (`export_kit_session!`): JSON text in and out.
   * A batch is one undo step; a refused one throws an error whose message is `{code, index, message}`.
   */
  modelDescribe?(): string
  modelBatch?(request: string): string
  /**
   * The editor state that is not the document (selection, current part, current time), as JSON
   * (`KitDocument::editor_state`); `"null"` for a kit that keeps none. Optional: engines before
   * the call context have none.
   */
  editorState?(): string
  /** Puts back what `editorState()` answered (`KitDocument::restore_editor_state`). */
  restoreEditorState?(state: string): void
  /** Sets the editor state one command reads from a call context `{on?, part?, time?}` as JSON (`KitDocument::set_context`). */
  setContext?(context: string): void
  /** Read-only guard callback (`under`, `covered`, `content`, `derived`, `identity`, `inputs`), JSON in and out. */
  premiseRead?(method: string, params: string): string
  forkForPremises?(): KitModuleDocument
}

/** A stored replica to open a file with: a snapshot and its blobs. */
export type KitModuleReplica = { snapshot: ArrayBuffer; blobs: ArrayBuffer }

type KitModuleExports = {
  default: (input?: { module_or_path?: string | URL }) => Promise<unknown>
} & Record<string, { open(name: string, bytes: Uint8Array): KitModuleDocument } | unknown>

function sdkURL(manifest: KitModuleManifest, file: string) {
  const base = manifest.base ?? `/kits/${manifest.dir}/`
  return new URL(file, new URL(base.endsWith('/') ? base : `${base}/`, globalThis.location.href))
}

const loading = new Map<string, Promise<KitModuleExports>>()
const lazy = new Map<string, LazyFonts>()

/** Loads and starts a kit's SDK once per page or worker. */
export function loadKitModule(manifest: KitModuleManifest): Promise<KitModuleExports> {
  let module = loading.get(manifest.kitId)
  if (!module) {
    module = (async () => {
      // A full URL, so the dev server serves the file as it is instead of as an app module.
      const loaded = (await import(/* @vite-ignore */ sdkURL(manifest, `${manifest.module}.js`).href)) as KitModuleExports
      if (manifest.runtime === 'ts-worker') {
        // A TypeScript engine: its module prepares itself from its own folder (no `_bg.wasm` of ours).
        const init = (loaded as Record<string, unknown>).default
        if (typeof init === 'function') await (init as (init: { base: string }) => Promise<unknown>)({ base: sdkURL(manifest, './').href })
      } else {
        await loaded.default({ module_or_path: sdkURL(manifest, `${manifest.module}_bg.wasm`) })
      }
      const exports = loaded as Record<string, unknown>
      const addFont = typeof exports.addFont === 'function' ? (exports.addFont as AddFont) : null
      const wantsFonts = typeof exports.wantsFonts === 'function' ? (exports.wantsFonts as () => boolean) : null
      // The primary faces now, the rest once the engine wants them (or the document opened).
      if (addFont) await new LazyFonts(manifest.fonts ?? [], addFont, null).loadAll()
      lazy.set(manifest.kitId, new LazyFonts(manifest.lazyFonts ?? [], addFont, wantsFonts))
      return loaded
    })()
    loading.set(manifest.kitId, module)
    module.catch(() => loading.delete(manifest.kitId))
  }
  return module
}

/** The lazy fonts of a kit's loaded SDK (its manifest's `lazyFonts`); null before `loadKitModule` answered. */
export function kitModuleLazyFonts(manifest: KitModuleManifest): LazyFonts | null {
  return lazy.get(manifest.kitId) ?? null
}

type KitModuleClass = {
  open?: (name: string, bytes: Uint8Array) => KitModuleDocument
  /** Opens a file with the replica stored for it (a file format that cannot hold one, like PSD). */
  openWithReplica?: (name: string, bytes: Uint8Array, snapshot: Uint8Array, blobs: Uint8Array) => KitModuleDocument
  create?: (name: string, width: number, height: number) => KitModuleDocument
  contractVersion?: () => number
}

function documentClassOf(module: KitModuleExports, manifest: KitModuleManifest) {
  const documentClass = module[manifest.documentClass] as KitModuleClass | undefined
  if (typeof documentClass?.open !== 'function') throw new Error(`${manifest.module} has no ${manifest.documentClass}.open`)
  const version = documentClass.contractVersion?.() ?? 1
  if (version > KIT_CONTRACT_VERSION) throw new Error(`${manifest.module} needs kit engine contract ${version}; this app supports ${KIT_CONTRACT_VERSION}`)
  return documentClass
}

/** Opens file bytes with a loaded SDK's document class, with their stored replica when given and the SDK takes one. */
export function openKitModuleDocument(module: KitModuleExports, manifest: KitModuleManifest, name: string, bytes: Uint8Array, replica: KitModuleReplica | null = null) {
  const documentClass = documentClassOf(module, manifest)
  if (replica && typeof documentClass.openWithReplica === 'function') {
    return documentClass.openWithReplica(name, bytes, new Uint8Array(replica.snapshot), new Uint8Array(replica.blobs))
  }
  return documentClass.open!(name, bytes)
}

/** A new, empty document of the SDK's own making (New image, New video project). */
export function createKitModuleDocument(module: KitModuleExports, manifest: KitModuleManifest, name: string, width: number, height: number) {
  const documentClass = documentClassOf(module, manifest)
  if (typeof documentClass.create !== 'function') throw new Error(`${manifest.module} cannot create documents`)
  return documentClass.create(name, width, height)
}

/** Whether a kit's SDK is built into this app (a missing file falls back to the app page). */
export async function kitModuleAvailable(manifest: KitModuleManifest) {
  try {
    const response = await fetch(sdkURL(manifest, `${manifest.module}.js`), { method: 'HEAD' })
    return response.ok && /javascript/i.test(response.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

/** A kit's commands from its SDK's `commands()` JSON. */
export function kitModuleCommands(json: string): KitCommand[] {
  const commands = JSON.parse(json) as Array<{ id: string; title: string; menu: string[] | null; shortcut: string | null; mutates: boolean; enabled: boolean; description?: string | null; schema?: Record<string, unknown> | null; outputSchema?: Record<string, unknown> | null; params?: string | null }>
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    description: command.description ?? null,
    group: command.id.split('.')[0] ?? '',
    mutates: command.mutates,
    enabled: command.enabled,
    menu: command.menu ?? [],
    shortcut: command.shortcut,
    schema: command.schema ?? null,
    outputSchema: command.outputSchema ?? null,
    params: command.params ?? null,
  }))
}
