/// <reference lib="webworker" />
/**
 * One open kit document in its own worker: the kit's SDK decodes, renders,
 * edits, and encodes here, so the page stays responsive however large the
 * file is, and a failing engine cannot take the page down. Requests are
 * answered in the order they arrive.
 */
import { createKitModuleDocument, kitModuleCommands, kitModuleLazyFonts, loadKitModule, openKitModuleDocument, type KitModuleDocument, type KitModuleManifest, type KitModuleReplica } from './kitModule'
import type { KitCallContext, KitEngineEvent, KitEngineInfo, KitEngineRequest, KitEngineResponse, KitEngineSchema, KitModelChanges, KitToolMethod } from './kitEngine'
import type { LazyFonts } from './lazyFonts'
import { lendFiles, lendHandle } from './lentFiles'
import { KitModelError, batchWrites, modelSupport } from './kitModel'
import { READ_ONLY_RULES, ReadOnlyError, commentCommands, commenterHistory, editsDocument } from './readOnly'
import { KitEngineRefusal, KitParamsError, UNSUPPORTED_REASON, commandFailure, paramsRefusal } from './refusal'
import type { ChangeAudit, Origin } from '@kition/kdm'

declare const self: DedicatedWorkerGlobalScope

let doc: KitModuleDocument | null = null
/** The engine's lazy fonts (`lazyFonts.ts`), once a document opened. */
let fonts: LazyFonts | null = null
/**
 * The file name the document was opened or made with. Saves pass it to the engine, which picks
 * the format from its extension (a `.pptx` saves as PowerPoint, not `.kslide`), as the headless
 * host does: a save keeps the file's format.
 */
let docName: string | undefined
/** Whether `info` reports the replica's version (the host keeps replicas). */
let followReplica = false
/** Whether the document is read-only (`document.readOnly`): edits are refused (see `readOnly.ts`). */
let readOnly = false
/** The comment commands a commenter's read-only session runs (`commentCommands`); empty for a viewer. */
let comments: ReadonlySet<string> = new Set()
/** What the comment backstop follows the replica with, once a comment command ran. */
let audit: ChangeAudit | null = null
/**
 * A commenter's own comment changes that Undo can take back and Redo bring back
 * (`commenterHistory`): counted from their comment commands, so the history of a read-only
 * session never reaches anything but their comments.
 */
let commentSteps = { undo: 0, redo: 0 }
/** The schema the engine's replica reads and the newest one its changes were written under (M5a). */
let schema: KitEngineSchema | null = null
/** The KDM module the comment backstop reads changes with, loaded on the first comment command. */
let kdm: Promise<typeof import('@kition/kdm')> | null = null
/** Whether each command edits, by id, for the read-only rules; loaded on the first `execute`. */
let editing: Map<string, boolean> | null = null
/** Whether the open document keeps editor state and takes a call context (`agentHooks`), read once it opens. */
let contextHooks = false
/** A premise plan (`premiseRead` `plan`): a fork of the document in an engine of its own, and what its steps changed since it began. */
type PremisePlan = { doc: KitModuleDocument; step: number; beforeState: unknown; before: Uint8Array; changes: unknown; refs: Record<string, unknown>; operations: number; bytes: number }
const premisePlans = new Map<string, PremisePlan>()
let nextPremisePlan = 0

function clearPremisePlans() {
  for (const plan of premisePlans.values()) plan.doc.free()
  premisePlans.clear()
}

/** A batch on a premise plan's fork, through its engine's own object model (`modelBatch`). */
function planBatch(scratch: KitModuleDocument, request: Record<string, unknown>): { refs?: Record<string, unknown> } & Record<string, unknown> {
  if (typeof scratch.modelBatch !== 'function') throw new KitEngineRefusal(UNSUPPORTED_REASON, "the kit's engine has no object model (modelBatch) to plan with")
  try {
    return JSON.parse(scratch.modelBatch(JSON.stringify(request))) as Record<string, unknown>
  } catch (error) {
    throw engineModelError(error) ?? error
  }
}

/** What a premise plan's steps changed since it began (its fork's `changesSince`). */
function planChanges(scratch: KitModuleDocument, before: Uint8Array): unknown {
  if (typeof scratch.changesSince !== 'function') throw new KitEngineRefusal(UNSUPPORTED_REASON, "the kit's engine cannot say what a premise plan changed (changesSince)")
  const answer = JSON.parse(scratch.changesSince(before)) as { changes: unknown; unavailable?: string }
  if (answer.changes === null || answer.changes === undefined) throw new Error(`premise plan changes unavailable: ${answer.unavailable ?? 'no change set'}`)
  return answer.changes
}

export async function premisePlan(params: Record<string, unknown>, source?: KitModuleDocument): Promise<unknown> {
  if (params.action === 'begin' || params.action === 'advance') {
    const steps = params.steps
    const ops = params.ops
    const bytes = JSON.stringify(params).length
    if (!Array.isArray(steps) || (ops !== undefined && !Array.isArray(ops)) || steps.length + (Array.isArray(ops) ? ops.length : 0) > 256 || bytes > 1_048_576 || params.action === 'begin' && premisePlans.size >= 16) throw new Error('premise plan limit')
    const token = params.action === 'advance' ? String(params.token) : String(++nextPremisePlan)
    const plan: PremisePlan | undefined = params.action === 'advance' ? premisePlans.get(token) : (() => {
      const open = source ?? opened()
      if (!open.forkForPremises) throw new Error('the kit cannot fork for premise planning')
      const scratch = open.forkForPremises()
      try {
        const beforeState = JSON.parse(open.editorState?.() ?? 'null') as unknown
        if (typeof scratch.version !== 'function') throw new Error('the kit cannot fork for premise planning: its fork keeps no replica')
        return { doc: scratch, step: 0, beforeState, before: scratch.version(), changes: null as unknown, refs: {} as Record<string, unknown>, operations: 0, bytes: 0 }
      } catch (error) {
        scratch.free()
        throw error
      }
    })()
    if (!plan) throw new Error('premise plan unavailable')
    premisePlans.delete(token)
    try {
      plan.operations += steps.length + (Array.isArray(ops) ? ops.length : 0)
      plan.bytes += bytes
      if (plan.operations > 256 || plan.bytes > 1_048_576) throw new Error('premise plan limit')
      if (Array.isArray(ops)) {
        if (ops.some(op => typeof op?.ref === 'string' && Object.hasOwn(plan.refs, op.ref))) throw new Error('premise batch reference is already bound')
        const resolve = (value: unknown): unknown => {
          if (typeof value === 'string' && Object.hasOwn(plan.refs, value)) return plan.refs[value]
          if (Array.isArray(value)) return value.map(resolve)
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]))
          return value
        }
        Object.assign(plan.refs, planBatch(plan.doc, { ops: resolve(ops) }).refs ?? {})
      }
      const scratch = plan.doc
      for (const step of steps as { command: string; params?: Record<string, unknown>; context?: KitCallContext }[]) {
        if (step.context && Object.keys(step.context).length) {
          if (!scratch.setContext) throw new Error('the kit cannot set premise context')
          scratch.setContext(JSON.stringify(step.context))
        }
        if (!scratch.executeAs) throw new Error('the kit cannot execute premise plans as the agent')
        const result = scratch.executeAs(step.command, JSON.stringify(step.params ?? {}), encodeOrigin({ kind: 'agent', principal: 'premise-plan' }))
        if (closedResult(result)) {
          scratch.free()
          return { closed: true }
        }
      }
      plan.changes = planChanges(scratch, plan.before)
      plan.step = Number(params.step ?? plan.operations)
      premisePlans.set(token, plan)
      return { token, beforeState: plan.beforeState, state: JSON.parse(scratch.editorState?.() ?? 'null') as unknown, changes: plan.changes, refs: plan.refs }
    } catch (error) {
      plan.doc.free()
      throw error
    }
  }
  const token = String(params.token)
  const plan = premisePlans.get(token)
  if (!plan) throw new Error('premise plan unavailable')
  if (params.action === 'end') {
    premisePlans.delete(token)
    plan.doc.free()
    return {}
  }
  if (params.action !== 'read') throw new Error('premise plan action required')
  const given = (params.params ?? {}) as Record<string, unknown>
  const method = String(params.method)
  if (method === 'model.batch') {
    if (!Array.isArray(given.ops) || given.ops.length) throw new Error('premise plan only accepts model reads')
    return planBatch(plan.doc, given)
  }
  if (method === 'model.describe') {
    if (typeof plan.doc.modelDescribe !== 'function') throw new KitEngineRefusal(UNSUPPORTED_REASON, "the kit's engine has no object model (modelDescribe)")
    return JSON.parse(plan.doc.modelDescribe()) as unknown
  }
  if (!['under', 'covered', 'content', 'state', 'identity', 'derived', 'blob', 'blob-support'].includes(method)) throw new Error('unsupported premise plan read')
  if (method === 'state') return { state: JSON.parse(plan.doc.editorState?.() ?? 'null') as unknown, beforeState: plan.beforeState }
  if (!plan.doc.premiseRead) throw new Error('premise reads unavailable')
  const read = () => JSON.parse(plan.doc.premiseRead!(method, JSON.stringify({ ...given, step: plan.step, changes: plan.changes, state: JSON.parse(plan.doc.editorState?.() ?? 'null') as unknown }))) as unknown
  const { on, part, time } = given as KitCallContext
  const set = { ...(on ? { on } : {}), ...(part ? { part } : {}), ...(time !== undefined ? { time } : {}) }
  return contextHooks ? inAgentState(plan.doc, { state: null, set }, read).value : read()
}

/** Whether the engine's own history can undo (or redo). */
function engineCan(open: KitModuleDocument, what: 'undo' | 'redo') {
  const method = what === 'undo' ? open.canUndo : open.canRedo
  if (typeof method === 'function') return method.call(open)
  const inspected = JSON.parse(open.inspect()) as Record<string, unknown>
  return inspected[what === 'undo' ? 'canUndo' : 'canRedo'] === true
}

/** An origin in the engine's form, `[kind, principal, label]` (`@kition/kdm`'s `encodeOrigin`, which is loaded only when needed). */
const encodeOrigin = (origin: Origin) => JSON.stringify([origin.kind, origin.principal, origin.label ?? null])

/** The shared contract's own methods, which `invoke` must not reach around. */
const CONTRACT = new Set(['free', 'execute', 'save', 'markSaved', 'constructor', 'open', 'create', 'openWithReplica', 'takeOutput'])

/** The replica's version when followed and made: asking an engine without one would make it. */
function replicaVersion(open: KitModuleDocument) {
  if (!followReplica || typeof open.version !== 'function' || open.hasReplica === false) return null
  try {
    return open.version()
  } catch {
    return null
  }
}

/** The SDK's replica member `name`, or an error naming it. */
function member<K extends 'version' | 'exportChanges' | 'importChanges' | 'snapshot' | 'blobs' | 'addBlobs'>(open: KitModuleDocument, name: K) {
  const method = open[name]
  if (typeof method !== 'function') throw new Error(`the kit module has no replica (${name})`)
  return method.bind(open) as NonNullable<KitModuleDocument[K]>
}

/** The SDK's own `docId` (`replica/info`), or `null` when the
 * engine's document has none. */
export function replicaDocId(open: KitModuleDocument): string | null {
  return typeof open.docId === 'string' ? open.docId : null
}

/**
 * The blobs a `replicaExport` sends alongside its changes: only what changed since `since` when
 * the SDK can tell narrower than its whole bundle (`blobsSince`),
 * else every blob the replica references.
 */
export function replicaBlobsSince(open: KitModuleDocument, since: Uint8Array): Uint8Array {
  return typeof open.blobsSince === 'function' ? open.blobsSince(since) : member(open, 'blobs')()
}

/**
 * The schema the engine's replica reads and the newest one its changes were written under
 * (KitModel rule M5a), for an engine that answers both and has made its replica (asking
 * would make it); `null` otherwise. Read when a document opens and after imports: the person's
 * own edits are written under the replica's own schema.
 */
export function readSchema(open: KitModuleDocument): KitEngineSchema | null {
  if (typeof open.schemaVersion !== 'function' || typeof open.authorSchemaVersion !== 'function' || open.hasReplica === false) return null
  try {
    const reads = Number(open.schemaVersion())
    const author = open.authorSchemaVersion()
    if (!Number.isFinite(reads)) return null
    return { reads, newestAuthor: typeof author === 'number' && Number.isFinite(author) ? author : null }
  } catch {
    return null
  }
}

/** Whether a read-only session's Undo (or Redo) has a step of the commenter's own to take. */
function commenterCan(open: KitModuleDocument, what: 'undo' | 'redo') {
  if (commentSteps[what] === 0) return false
  try {
    return engineCan(open, what)
  } catch {
    return false
  }
}

/**
 * The last `info` made and what it was made for. Geometry metadata can reuse it, but commands
 * and settled gestures must inspect again: selection and prompts need not move the revision.
 */
let infoMade: { key: string; value: KitEngineInfo } | null = null
/** The `info` the page has from this worker: an answer that would repeat it sends `null` instead. */
let infoSent: KitEngineInfo | null = null

/** What `info` depends on that can change: the size, revision, saved state, replica, history, and schema versions. */
function infoKey(open: KitModuleDocument) {
  const replica = replicaVersion(open)
  return [
    open.revision,
    open.width,
    open.height,
    open.pinnedLeft ?? 0,
    open.pinnedTop ?? 0,
    !readOnly && open.dirty,
    replica ? replica.join(',') : '',
    JSON.stringify(schema ?? null),
  ].join('|')
}

/** `value`, noted as the page's (it goes to the page). */
function sent(value: KitEngineInfo) {
  infoSent = value
  return value
}

/** `info`, or `null` when the page has this very one already. */
function infoChanged(open: KitModuleDocument, refresh = false): KitEngineInfo | null {
  const value = info(open, refresh)
  if (value === infoSent) return null
  infoSent = value
  return value
}

function info(open: KitModuleDocument, refresh = false): KitEngineInfo {
  const key = infoKey(open)
  if (!refresh && infoMade?.key === key) return infoMade.value
  const value = inspectedInfo(open)
  // Keep duplicate reads off the wire without assuming revision covers transient UI state.
  if (infoMade?.key === key && JSON.stringify(infoMade.value.inspected) === JSON.stringify(value.inspected)) return infoMade.value
  infoMade = { key, value }
  infoSent = null
  return value
}

function inspectedInfo(open: KitModuleDocument): KitEngineInfo {
  const inspected = JSON.parse(open.inspect()) as Record<string, unknown>
  return {
    replica: replicaVersion(open),
    width: open.width,
    height: open.height,
    pinned: { left: open.pinnedLeft ?? 0, top: open.pinnedTop ?? 0 },
    revision: Number(open.revision),
    // A viewer has nothing to save: room imports make the engine unsaved, but not the viewer's edits.
    dirty: !readOnly && open.dirty,
    // A read-only session undoes only a commenter's own comment changes.
    canUndo: readOnly ? commenterCan(open, 'undo') : inspected.canUndo === true,
    canRedo: readOnly ? commenterCan(open, 'redo') : inspected.canRedo === true,
    inspected,
    model: modelSupport(open),
    ...(typeof open.executeAs === 'function' ? { origins: true } : {}),
    ...(contextHooks ? { context: true } : {}),
    ...(keepsChanges(open) ? { changes: true } : {}),
    ...(typeof open.premiseRead === 'function' ? { premises: true } : {}),
    schema,
  }
}

const TOOL_METHODS = new Set<KitToolMethod>(['tools', 'tool', 'selectTool', 'pointer', 'pointerLeft', 'toolKey', 'toolText', 'toolPreedit', 'toolState'])
/** Tool members a kit may leave out: without one, the call answers nothing and changes nothing. */
const OPTIONAL_TOOL_METHODS = new Set<KitToolMethod>(['pointerLeft', 'toolPreedit'])

/**
 * `info` mid-gesture without reading `inspect()` (KitEngine.tool's `quiet`): the last one, with
 * what `infoKey` follows brought up to date. It is not kept as `infoMade`, so the next `info`
 * (the release's) reads `inspect()` again.
 */
function gestureInfo(open: KitModuleDocument): KitEngineInfo {
  const last = infoMade?.value
  if (!last) return info(open)
  return {
    ...last,
    replica: replicaVersion(open),
    width: open.width,
    height: open.height,
    pinned: { left: open.pinnedLeft ?? 0, top: open.pinnedTop ?? 0 },
    revision: Number(open.revision),
    dirty: !readOnly && open.dirty,
  }
}

/** Whether a tool's answer is a gesture's: busy, before the settled event that ends it. */
function midGesture(value: unknown, settled: boolean) {
  return !settled && value !== null && typeof value === 'object' && (value as { busy?: unknown }).busy === true
}

/** The manifest's `setup` calls, on a document just opened or made (an editor's view options). */
function setup(open: KitModuleDocument, manifest: KitModuleManifest) {
  for (const call of manifest.setup ?? []) {
    const method = (open as unknown as Record<string, unknown>)[call.method]
    if (CONTRACT.has(call.method) || typeof method !== 'function') throw new Error(`the kit module has no method ${call.method}`)
    ;(method as (...args: unknown[]) => unknown).apply(open, call.args)
  }
}

/** Opens a document's session: read-only or not (and commenting or not), its commands not yet known. */
/** The page hears how many lazy fonts are left now and after each one is given to the engine. */
function followFonts(manifest: KitModuleManifest) {
  const lazy = kitModuleLazyFonts(manifest)
  if (lazy !== fonts) {
    fonts = lazy
    lazy?.onSettled((pending) => post({ fonts: pending }))
  }
  post({ fonts: fonts?.pending ?? 0 })
}

/** An event to the page (`KitEngineEvent`); none outside a worker (the tests call `handle`). */
function post(event: KitEngineEvent) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') self.postMessage(event)
}

function start(asReadOnly: boolean, canComment: boolean, manifest: KitModuleManifest) {
  readOnly = asReadOnly
  comments = commentCommands(manifest.commentCommands, asReadOnly && canComment)
  audit = null
  commentSteps = { undo: 0, redo: 0 }
  schema = doc ? readSchema(doc) : null
  editing = null
  contextHooks = doc ? agentHooks(doc) : false
}

/**
 * Whether the engine can run an agent's step in an editor state of the agent's own: it answers
 * its editor state, puts one back and takes a call context, and keeps some state (`editorState()`
 * is not `null`). An engine that answers `null` keeps none, and has nothing to keep apart.
 */
function agentHooks(open: KitModuleDocument) {
  if (typeof open.editorState !== 'function' || typeof open.restoreEditorState !== 'function' || typeof open.setContext !== 'function') return false
  try {
    return open.editorState() !== 'null'
  } catch {
    return false
  }
}

/**
 * Runs `run` (an agent's step) in the agent's own editor state, in this one turn of the worker
 * (C3b): the person's state is put aside, the agent's (`agent.state`; `null` before its first step:
 * the person's) put in place and the step's call context set, then the agent's state after the
 * step is kept and the person's put back, however the step ends. A context the kit cannot set is
 * refused (`unsupported`) and nothing runs.
 */
function inAgentState<T>(open: KitModuleDocument, agent: { state: string | null; set: KitCallContext | null }, run: () => T): { value: T; state: string } {
  if (!contextHooks) throw new KitEngineRefusal(UNSUPPORTED_REASON, "this kit's engine keeps no editor state of the agent's own: it does not answer editorState, restoreEditorState and setContext")
  const person = open.editorState!()
  let closed = false
  try {
    if (agent.state !== null) open.restoreEditorState!(agent.state)
    if (agent.set && Object.keys(agent.set).length) {
      const named = Object.keys(agent.set)
        .map((key) => `\`${key}\``)
        .join(', ')
      try {
        open.setContext!(JSON.stringify(agent.set))
      } catch (error) {
        throw new KitEngineRefusal(UNSUPPORTED_REASON, `the kit could not set ${named}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const value = run()
    closed = closedResult(value)
    return { value, state: closed ? 'null' : open.editorState!() }
  } finally {
    if (!closed) open.restoreEditorState!(person)
  }
}


/** Whether `command` edits by the read-only rules; a command the catalog does not list runs under the backstop. */
function commandEdits(open: KitModuleDocument, command: string) {
  if (!editing) editing = new Map(kitModuleCommands(open.commands()).map((item) => [item.id, editsDocument(item)]))
  return editing.get(command) ?? editsDocument({ id: command })
}

/**
 * The replica's version as text, or null when there is none: the engine has no replica members,
 * or has not made its replica yet (asking would make it, and the host decides when that happens).
 */
function currentVersion(open: KitModuleDocument) {
  if (typeof open.version !== 'function' || open.hasReplica === false) return null
  try {
    return open.version().join(',')
  } catch {
    return null
  }
}

/**
 * Runs `call` under the read-only backstop: when it committed to the replica anyway (an engine
 * without one: made the document unsaved), the session's undo reverts it and `what` is refused.
 */
function guarded<T>(open: KitModuleDocument, what: string, call: () => T): T {
  if (!readOnly) return call()
  const version = currentVersion(open)
  const dirty = open.dirty
  const value = call()
  if (closedResult(value)) return value
  const after = currentVersion(open)
  // Without a replica before, one made by the call is an edit, and so is a document now unsaved.
  const changed = version != null ? after !== version : after != null || (!dirty && open.dirty)
  if (!changed) return value
  revert(open)
  throw new ReadOnlyError(what)
}

/**
 * Takes back the call that just changed a read-only document, with the session's undo (else the
 * engine's Undo); `redo` takes back an Undo the same way.
 */
function revert(open: KitModuleDocument, how: 'undo' | 'redo' = 'undo') {
  const method = (open as unknown as Record<string, unknown>)[how]
  try {
    if (typeof method === 'function') (method as () => unknown).call(open)
    else open.execute(how === 'undo' ? 'edit.undo' : 'edit.redo', '{}')
  } catch {
    // Refused either way; what could not be undone stays local (the host refuses a viewer's writes).
  }
}

/**
 * Runs a comment command of a commenter's read-only session under the comment backstop: when its
 * change touches anything but `CommentThread` and `Comment` objects (as a sync server checks a
 * commenter's push), it is undone and refused. Comments live in the replica (rule M23), so one
 * not made yet is made first; an engine without one has nowhere for a comment to go, and the
 * read-only backstop applies.
 */
async function commentGuarded<T>(open: KitModuleDocument, command: string, call: () => T, takeBack: 'undo' | 'redo' = 'undo'): Promise<{ value: T; changed: boolean }> {
  if (typeof open.version !== 'function' || typeof open.exportChanges !== 'function') return { value: guarded(open, `\`${command}\``, call), changed: false }
  try {
    open.version()
  } catch {
    return { value: guarded(open, `\`${command}\``, call), changed: false }
  }
  const { ChangeAudit, touchesOnlyComments } = await (kdm ??= import('@kition/kdm'))
  const exportChanges = member(open, 'exportChanges')
  // What the replica took since (another replica's changes, an undo) is not this command's.
  if (!audit) audit = ChangeAudit.load(exportChanges(new Uint8Array(0)))
  else audit.follow(exportChanges(audit.version().encode()))
  const before = currentVersion(open)
  const value = call()
  if (currentVersion(open) === before) return { value, changed: false }
  let comment = false
  try {
    comment = touchesOnlyComments(audit.touched(exportChanges(audit.version().encode())))
  } catch {
    // A change the backstop cannot read is not taken as a comment.
  }
  if (comment) return { value, changed: true }
  // The audit takes the undo with the next comment command, like any change it did not make.
  revert(open, takeBack)
  throw new ReadOnlyError(`\`${command}\``, `\`${command}\` is not allowed: it changed more than comments, and the document is read-only`)
}

/**
 * A commenter's Undo or Redo (`commenterHistory`): only while their comment commands left a step
 * to take, and under the comment backstop, so it never takes back or brings back anything but
 * their comments (an engine whose history reaches further is refused, and its step taken back).
 */
async function commenterStep(open: KitModuleDocument, command: string, params: Record<string, unknown>, what: 'undo' | 'redo') {
  if (commentSteps[what] === 0) throw new ReadOnlyError(`\`${command}\``, `\`${command}\` is not allowed: the document is read-only, and there is no comment of yours to ${what}`)
  const { value, changed } = await commentGuarded(open, command, () => open.execute(command, JSON.stringify(params)), what === 'undo' ? 'redo' : 'undo')
  if (changed) commentSteps = what === 'undo' ? { undo: commentSteps.undo - 1, redo: commentSteps.redo + 1 } : { undo: commentSteps.undo + 1, redo: commentSteps.redo - 1 }
  return value
}

/** A commenter's comment command: one step of the person's own, under the comment backstop. */
async function commentStep(open: KitModuleDocument, command: string, params: Record<string, unknown>) {
  try {
    const { value, changed } = await commentGuarded(open, command, () => open.execute(command, JSON.stringify(params)))
    // A new step: what was undone cannot be redone any more (the engine dropped it too).
    if (changed) commentSteps = { undo: commentSteps.undo + 1, redo: 0 }
    return value
  } catch (error) {
    // A refused command was a new edit all the same, taken back: nothing is left to redo.
    if (error instanceof ReadOnlyError) commentSteps = { undo: commentSteps.undo, redo: 0 }
    throw error
  }
}

/** Whether the engine says what changed since a version of its replica (`changesSince`, for `modelChanges`). */
function keepsChanges(open: KitModuleDocument) {
  return typeof open.version === 'function' && typeof open.changesSince === 'function'
}

/** Bytes as base64, as the agent's tools carry a replica version. */
function base64(bytes: Uint8Array) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function fromBase64(text: string) {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
  } catch {
    return new Uint8Array(0)
  }
}

/** The replica's version as bytes, or null when there is none (see `currentVersion`). */
function currentVersionBytes(open: KitModuleDocument) {
  if (typeof open.version !== 'function' || open.hasReplica === false) return null
  try {
    return open.version()
  } catch {
    return null
  }
}

/** A failure of the object model as the protocol answers it. */
function modelError(error: unknown) {
  if (error instanceof KitModelError) return error
  return new KitModelError({ code: 'invalid-value', index: null, message: error instanceof Error ? error.message : String(error) })
}

/** A draft the engine refused to merge or compare, as the protocol answers it. */
function draftRefusal(error: unknown) {
  return new KitModelError({ code: 'invalid-value', index: null, message: `the draft does not merge: ${error instanceof Error ? error.message : String(error)}` })
}

/** The engine's member `name` for drafts and restores, or a refusal naming it: the feature is unavailable, the document still opens and edits. */
function engineMember<K extends 'mergeChanges' | 'compareChanges' | 'restoreState'>(open: KitModuleDocument, name: K, what: string) {
  const method = open[name]
  if (typeof method !== 'function') throw new KitEngineRefusal(UNSUPPORTED_REASON, `this kit's engine cannot ${what}: it has no ${name}`)
  return method.bind(open) as NonNullable<KitModuleDocument[K]>
}

/** An engine's own batch refusal: its message is the protocol's `{code, index, message}`. */
function engineModelError(error: unknown) {
  try {
    const data = JSON.parse(error instanceof Error ? error.message : String(error)) as { code?: unknown; index?: unknown; message?: unknown }
    if (typeof data?.code !== 'string' || typeof data.message !== 'string') return null
    return new KitModelError({ code: data.code as KitModelError['data']['code'], index: typeof data.index === 'number' ? data.index : null, message: data.message })
  } catch {
    return null
  }
}

function opened() {
  if (!doc) throw new Error('no document is open')
  return doc
}

/** Runs an engine command (`execute`), as `request.origin` when given. */
async function executeCommand(request: Extract<KitEngineRequest, { method: 'execute' }>): Promise<{ value: unknown }> {
  const open = opened()
  if (readOnly && commandEdits(open, request.command)) {
    const history = commenterHistory(request.command, comments)
    if (history) return { value: { result: await commenterStep(open, request.command, request.params, history), info: sent(info(open)) } }
    if (!comments.has(request.command)) throw new ReadOnlyError(`\`${request.command}\``)
    return { value: { result: await commentStep(open, request.command, request.params), info: sent(info(open)) } }
  }
  // As the origin the editor gives (an `ai/run` step runs as the agent), when the engine can.
  const origin = request.origin
  const asOrigin = origin && typeof open.executeAs === 'function'
  // A host's change (origin `system`) is no undo step in any history: an engine that cannot
  // run it as that origin would make it the person's step, so it is refused (Kit UI protocol
  // 2.7, as Kit Process Protocol's `command.execute` refuses it).
  const system = origin?.kind === 'system'
  if (system && !asOrigin) throw new KitEngineRefusal(UNSUPPORTED_REASON, `\`${request.command}\` was not run: this kit cannot keep a host's change out of the undo history`)
  const execute = asOrigin ? () => open.executeAs!(request.command, JSON.stringify(request.params), encodeOrigin(origin)) : () => open.execute(request.command, JSON.stringify(request.params))
  const step = () => guarded(open, `\`${request.command}\``, execute)
  if (request.agent) {
    const { value: result, state } = inAgentState(open, request.agent, step)
    if (closedResult(result)) return finishClosed(open, result)
    return { value: { result, info: infoChanged(open, true), state } }
  }
  const result = step()
  if (closedResult(result)) return finishClosed(open, result)
  return { value: { result, info: infoChanged(open, true) } }
}

function closedResult(value: unknown): boolean {
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : value
    return result !== null && typeof result === 'object' && result.closed === true
  } catch { return false }
}

function finishClosed(open: KitModuleDocument, result: unknown) {
  open.free()
  doc = null
  infoMade = null
  infoSent = null
  clearPremisePlans()
  return { value: { result, info: null, closed: true, state: null } }
}

/**
 * Opens file bytes with their stored replica when given; a snapshot the engine cannot read counts
 * as none (UI-R1): the file opens plainly.
 */
function openWithStored(sdk: Awaited<ReturnType<typeof loadKitModule>>, manifest: KitModuleManifest, name: string, bytes: Uint8Array, stored: KitModuleReplica | null) {
  if (!stored) return openKitModuleDocument(sdk, manifest, name, bytes)
  try {
    return openKitModuleDocument(sdk, manifest, name, bytes, stored)
  } catch (error) {
    console.warn('[kit] the stored replica does not open; the file opens without it', error)
    return openKitModuleDocument(sdk, manifest, name, bytes)
  }
}

/** Answers one request; exported for tests (the worker answers through `onmessage`). */
export async function handle(request: KitEngineRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (request.method) {
    case 'open': {
      const sdk = await loadKitModule(request.manifest)
      lendFiles(request.lent)
      clearPremisePlans()
      doc?.free()
      followReplica = request.replica?.follow ?? false
      doc = openWithStored(sdk, request.manifest, request.name, new Uint8Array(request.bytes), request.replica?.stored ?? null)
      docName = request.name
      // Another document: none of the last one's info is its.
      infoMade = null
      infoSent = null
      setup(doc, request.manifest)
      start(request.readOnly === true, request.canComment === true, request.manifest)
      followFonts(request.manifest)
      return { value: sent(info(doc)) }
    }
    case 'create': {
      const sdk = await loadKitModule(request.manifest)
      lendFiles(request.lent)
      clearPremisePlans()
      doc?.free()
      followReplica = false
      doc = createKitModuleDocument(sdk, request.manifest, request.name, request.width, request.height)
      docName = request.name
      // Another document: none of the last one's info is its.
      infoMade = null
      infoSent = null
      setup(doc, request.manifest)
      start(request.readOnly === true, false, request.manifest)
      followFonts(request.manifest)
      return { value: sent(info(doc)) }
    }
    case 'execute':
      try {
        return await executeCommand(request)
      } catch (error) {
        // An engine's refusal of the parameters reads as its text, its errors beside it; a failure
        // whose reason the kit gave, as its text with the reason beside it.
        throw paramsRefusal(error) ?? commandFailure(error) ?? error
      }
    case 'render': {
      const rgba = opened().render(request.x, request.y, request.scale, request.width, request.height)
      return { value: rgba.buffer, transfer: [rgba.buffer] }
    }
    case 'renderArea': {
      const rgba = opened().renderArea(request.x0, request.y0, request.x1, request.y1, request.width, request.height)
      return { value: rgba.buffer, transfer: [rgba.buffer] }
    }
    case 'commands':
      return { value: kitModuleCommands(opened().commands()) }
    case 'premiseRead': {
      if (request.name === 'plan') return { value: await premisePlan(request.params) }
      const open = opened()
      if (typeof open.premiseRead !== 'function') throw new KitEngineRefusal(UNSUPPORTED_REASON, 'the kit cannot answer premise reads in its editor')
      const read = () => JSON.parse(open.premiseRead!(request.name, JSON.stringify(request.params))) as unknown
      const { on, part, time } = request.params as KitCallContext
      const set = { ...(on ? { on } : {}), ...(part ? { part } : {}), ...(time !== undefined ? { time } : {}) }
      if (!contextHooks) {
        if (Object.keys(set).length) throw new KitEngineRefusal(UNSUPPORTED_REASON, 'the kit cannot isolate the premise call context')
        return { value: read() }
      }
      return { value: inAgentState(open, { state: null, set }, read).value }
    }
    case 'inspectAt': {
      const open = opened()
      if (!contextHooks) throw new KitEngineRefusal(UNSUPPORTED_REASON, 'the kit cannot isolate the inspection context')
      return { value: inAgentState(open, { state: null, set: request.context }, () => {
        const details = JSON.parse(open.inspect()) as Record<string, unknown>
        const command = request.part === undefined ? undefined : kitModuleCommands(open.commands()).find((command) =>
          ['slide.inspect', 'page.inspect'].includes(command.id) && command.mutates === false)
        const part = command ? JSON.parse(open.execute(command.id, JSON.stringify({ index: request.part! - 1 }))) as unknown : undefined
        return { details, ...(part === undefined ? {} : { part }) }
      }).value }
    }
    case 'disabledCommands': {
      const open = opened()
      // Kits before disabledCommands answer from the full list.
      if (typeof open.disabledCommands !== 'function') return { value: kitModuleCommands(open.commands()).filter((command) => !command.enabled).map((command) => command.id) }
      return { value: JSON.parse(open.disabledCommands()) as string[] }
    }
    case 'check': {
      const open = opened()
      if (typeof open.check !== 'function') return { value: [] }
      const answer = JSON.parse(open.check()) as { diagnostics?: unknown }
      return { value: Array.isArray(answer.diagnostics) ? answer.diagnostics : [] }
    }
    case 'lendHandle': {
      lendHandle(request.handle, request.bytes ? new Uint8Array(request.bytes) : null)
      return { value: null }
    }
    case 'takeOutput': {
      const open = opened()
      if (typeof open.takeOutput !== 'function') throw new Error(`there is no output ${request.id}`)
      const bytes = open.takeOutput(request.id, request.max)
      return { value: bytes.buffer, transfer: [bytes.buffer] }
    }
    case 'save': {
      const open = opened()
      const bytes = open.save(docName)
      return { value: { bytes: bytes.buffer, revision: Number(open.revision) }, transfer: [bytes.buffer] }
    }
    case 'invoke': {
      const open = opened() as unknown as Record<string, unknown>
      const method = open[request.name]
      if (CONTRACT.has(request.name) || request.name.startsWith('_') || typeof method !== 'function') {
        throw new Error(`the kit module has no method ${request.name}`)
      }
      // These edit around the contract's checks (and the read-only rules): no editor calls them.
      if (READ_ONLY_RULES.refusedMethods.includes(request.name)) throw new Error(`the kit module's ${request.name} is not open to editors`)
      const value = guarded(opened(), request.name, () => (method as (...args: unknown[]) => unknown).apply(open, request.args))
      return ArrayBuffer.isView(value) ? { value, transfer: [value.buffer] } : { value }
    }
    case 'tool': {
      const open = opened()
      const method = (open as unknown as Record<string, unknown>)[request.name]
      if (TOOL_METHODS.has(request.name) && OPTIONAL_TOOL_METHODS.has(request.name) && typeof method !== 'function') return { value: { value: null, info: null } }
      if (!TOOL_METHODS.has(request.name) || typeof method !== 'function') throw new Error(`the kit module has no engine tools (${request.name})`)
      if (readOnly && READ_ONLY_RULES.refusedTools.includes(request.name)) throw new ReadOnlyError(`the engine tools' ${request.name}`)
      const before = open.revision
      const answer = guarded(open, `the engine tools' ${request.name}`, () => (method as (...args: unknown[]) => string).apply(open, request.args))
      // `toolPreedit` answers nothing when the kit shows no composition.
      const value = request.name === 'tool' ? answer : (answer as string | null | undefined) == null ? null : JSON.parse(answer)
      if (!request.settled && open.revision === before) return { value: { value, info: null } }
      const quiet = request.quiet === true && midGesture(value, request.settled)
      return { value: { value, info: sent(quiet ? gestureInfo(open) : info(open, request.settled)) } }
    }
    case 'info':
      return { value: info(opened(), true) }
    case 'fonts':
      await fonts?.loadAll()
      return { value: null }
    case 'markSaved': {
      if (readOnly) throw new ReadOnlyError('markSaved')
      const open = opened()
      // Bytes taken at an earlier revision do not hold what changed since: that stays unsaved.
      if (request.revision == null || Number(open.revision) === request.revision) open.markSaved()
      return { value: sent(info(open)) }
    }
    case 'saveWithReplica': {
      const open = opened()
      // The file's bytes, then the store's snapshot, its blobs and the version it holds, all in this
      // one step: a checkpoint keeps exactly the saved state (UI-R6), never a later one.
      const bytes = open.save(docName)
      let replica: { snapshot: ArrayBuffer; blobs: ArrayBuffer; version: ArrayBuffer } | null = null
      try {
        const snapshot = member(open, 'snapshot')().buffer as ArrayBuffer
        const blobs = member(open, 'blobs')().buffer as ArrayBuffer
        replica = { snapshot, blobs, version: member(open, 'version')().buffer as ArrayBuffer }
      } catch {
        // A document its engine cannot hold in a replica still saves; no replica is kept.
      }
      const transfer: Transferable[] = [bytes.buffer, ...(replica ? [replica.snapshot, replica.blobs, replica.version] : [])]
      return { value: { bytes: bytes.buffer, replica, revision: Number(open.revision) }, transfer }
    }
    case 'replicaVersion': {
      const version = member(opened(), 'version')()
      return { value: version.buffer, transfer: [version.buffer] }
    }
    case 'replicaExport': {
      const open = opened()
      const since = new Uint8Array(request.since)
      const changes = member(open, 'exportChanges')(since)
      const blobs = replicaBlobsSince(open, since)
      return { value: { changes: changes.buffer, blobs: blobs.buffer }, transfer: [changes.buffer, blobs.buffer] }
    }
    case 'replicaImport': {
      const open = opened()
      if (request.blobs.byteLength) member(open, 'addBlobs')(new Uint8Array(request.blobs))
      const damage = JSON.parse(member(open, 'importChanges')(new Uint8Array(request.changes))) as unknown
      // Another replica's changes may be a newer kit's (M5a).
      schema = readSchema(open) ?? schema
      return { value: { damage, info: sent(info(open)) } }
    }
    case 'replicaDocId':
      return { value: replicaDocId(opened()) }
    case 'replicaMerge': {
      const open = opened()
      if (readOnly) throw new ReadOnlyError('the draft merge')
      const merge = engineMember(open, 'mergeChanges', 'merge a draft')
      // An engine whose documents carry no media has no blobs to add.
      if (request.blobs.byteLength && typeof open.addBlobs === 'function') open.addBlobs(new Uint8Array(request.blobs))
      let answer: { summary: unknown }
      try {
        answer = JSON.parse(merge(new Uint8Array(request.changes), encodeOrigin(request.origin))) as { summary: unknown }
      } catch (error) {
        throw draftRefusal(error)
      }
      schema = readSchema(open) ?? schema
      return { value: { summary: answer.summary, info: sent(info(open)) } }
    }
    case 'replicaCompare': {
      const compare = engineMember(opened(), 'compareChanges', 'compare a draft')
      try {
        return { value: JSON.parse(compare(new Uint8Array(request.changes))) as unknown }
      } catch (error) {
        throw draftRefusal(error)
      }
    }
    case 'replicaRestore': {
      const open = opened()
      if (readOnly) throw new ReadOnlyError('the restore')
      const restore = engineMember(open, 'restoreState', 'restore an earlier state')
      if (request.blobs.byteLength && typeof open.addBlobs === 'function') open.addBlobs(new Uint8Array(request.blobs))
      const damage = JSON.parse(restore(new Uint8Array(request.snapshot), encodeOrigin(request.origin))) as unknown
      return { value: { damage, info: sent(info(open)) } }
    }
    case 'modelVersion': {
      const bytes = currentVersionBytes(opened())
      if (!bytes) throw new Error("the kit's engine keeps no replica, so it cannot say what changed")
      return { value: base64(bytes) }
    }
    case 'modelChanges': {
      const open = opened()
      if (!keepsChanges(open)) throw new Error("the kit's engine cannot say what changed (it has no changesSince)")
      const found = JSON.parse(open.changesSince!(fromBase64(request.since))) as KitModelChanges
      return { value: { ...found, version: base64(member(open, 'version')()) } }
    }
    case 'modelReply': {
      // Only the agent's reply is named in tool ids; a reply never fails for want of them.
      const open = opened()
      if (typeof open.modelReply !== 'function') return { value: request.value }
      try {
        return { value: JSON.parse(open.modelReply(JSON.stringify(request.value))) as unknown }
      } catch {
        return { value: request.value }
      }
    }
    case 'modelDescribe': {
      const open = opened()
      if (modelSupport(open) !== 'engine') throw new Error("the kit's engine has no object model")
      return { value: JSON.parse(open.modelDescribe!()) as unknown }
    }
    case 'modelBatch': {
      const open = opened()
      if (modelSupport(open) !== 'engine') throw new Error("the kit's engine has no object model")
      // A viewer may read, never write (the engine's own batch does not know the session is read-only).
      if (readOnly && batchWrites(request.request)) throw new KitModelError({ code: 'read-only', index: null, message: 'the document is read-only' })
      let answer: Record<string, unknown>
      try {
        answer = JSON.parse(open.modelBatch!(JSON.stringify(request.request))) as Record<string, unknown>
      } catch (error) {
        throw engineModelError(error) ?? modelError(error)
      }
      const version = currentVersionBytes(open)
      return { value: { answer: { ...answer, version: version?.buffer ?? null }, info: sent(info(open)) }, transfer: version ? [version.buffer] : [] }
    }
  }
}

let queue = Promise.resolve()

self.onmessage = (event: MessageEvent<{ id: number; request: KitEngineRequest }>) => {
  const { id, request } = event.data
  queue = queue.then(async () => {
    try {
      const { value, transfer = [] } = await handle(request)
      self.postMessage({ id, ok: true, value } satisfies KitEngineResponse, transfer)
    } catch (error) {
      const reason = error instanceof ReadOnlyError || error instanceof KitParamsError || error instanceof KitEngineRefusal ? error.reason : undefined
      const data = error instanceof KitModelError ? error.data : undefined
      const errors = error instanceof KitParamsError ? error.errors : undefined
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), reason, data, errors } satisfies KitEngineResponse)
    }
    // Text this request laid out may have wanted a face the engine has not got yet.
    fonts?.check()
  })
}
