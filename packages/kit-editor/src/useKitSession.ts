/**
 * An embedded kit editor's document session: the document opened through the host
 * (`useKitDocument` over `host/read` and `host/write`), the host told of every change
 * (`document/changed`) and of the open (`ui/initialize`), and the Kit AI bridge (`ai/*`) served
 * from the live engine, so an agent's edits repaint here and join the undo history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HOST_ORIGIN_LABEL, INVALID_PARAMS_REASON, KitRpcError, LEASE_HELD_REASON, ORIGIN_LABEL, type AiRunParams, type DocumentChangeBy, type KitLease } from '@kition/kit-ui-protocol'
import type { Origin } from '@kition/kdm'
import type { HostConnection } from './host'
import type { KitAgentState, KitCallContext, KitEngine, KitEngineInfo } from './engine/kitEngine'
import type { KitCommand, KitModuleManifest } from './engine/kitModule'
import { useKitDocument, type KitDocumentOptions, type KitRunOptions } from './engine/useKitDocument'
import type { RasterRect } from './engine/rasterViewport'
import { agentCommands, notAllowed, refusedStep, uiState } from './uiConfig'
import { READ_ONLY_REASON, commentCommands, isReadOnlyError, refusedReadOnly } from './engine/readOnly'
import { KitModelError, type ModelErrorData } from './engine/kitModel'
import { KitEngineRefusal, KitParamsError, UNSUPPORTED_REASON } from './engine/refusal'
import { KitDraft, previewPng } from './engine/kitDraft'
import type { DraftOrigin, DraftSummary } from '@kition/kit-ui-protocol'
import { kitLeases, type KitLeases, type LeaseOutcome } from './lease'
import { KIT_UI_CATALOGS } from './editor'
import { createStrings } from './strings'

/** Each command's menu path, by command id. */
type MenuMap = ReadonlyMap<string, readonly string[]>
/** The catalog's commands, by id. */
type CommandMap = ReadonlyMap<string, KitCommand>

/** The error a command refused because the document is read-only answers with. `step` names the `ai/run` step. */
export function readOnlyRefusal(command: string, step?: number) {
  const what = step == null ? `\`${command}\`` : `step ${step} (\`${command}\`)`
  return new KitRpcError(-32000, `${what} is not allowed: the document is read-only`, step == null ? { reason: READ_ONLY_REASON, command } : { reason: READ_ONLY_REASON, command, step })
}

/** A refused object-model batch, as the protocol answers it (`data` is `{ code, index, message }`). */
function modelRefusal(data: ModelErrorData) {
  return new KitRpcError(-32000, data.message, data)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Who made the document's last change, when it was not the person: the editor's status line says so. */
export type KitEditedBy = Exclude<DocumentChangeBy, { by: 'person' }>

/**
 * Who an `ai/run` runs as: the agent, or the host's own change with `origin:
 * "system"` and its `originLabel`. A malformed origin is refused (`-32602`) before any step runs.
 */
function runAs(params: Pick<AiRunParams, 'origin' | 'originLabel' | 'draft'>): KitEditedBy {
  const { origin, originLabel, draft } = params
  if (origin === undefined) {
    if (originLabel !== undefined) throw new KitRpcError(-32602, '`originLabel` names a host feature: it needs `origin: "system"`')
    return { by: 'agent' }
  }
  if (origin !== 'system') throw new KitRpcError(-32602, `\`origin\` is "system" or absent, not ${JSON.stringify(origin)}`)
  if (draft === true) throw new KitRpcError(-32602, "a host's change (`origin: \"system\"`) is made on the document, not on the agent's draft")
  if (originLabel !== undefined && (typeof originLabel !== 'string' || !ORIGIN_LABEL.test(originLabel))) {
    throw new KitRpcError(-32602, `\`originLabel\` is 1 to 64 letters, digits, \`.\`, \`_\` or \`-\`, not ${JSON.stringify(originLabel)}`)
  }
  return { by: 'system', originLabel: originLabel ?? HOST_ORIGIN_LABEL }
}

/** An `ai/run` step's failure as the protocol answers it: a refusal keeps its reason, and the engine's refusal of the parameters its errors. */
function stepFailure(error: unknown, command: string, step: number) {
  const what = `step ${step} (\`${command}\`) failed`
  if (error instanceof KitParamsError) return new KitRpcError(-32000, `${what}: ${error.message}`, { reason: INVALID_PARAMS_REASON, command, step, errors: error.errors })
  if (error instanceof KitEngineRefusal) return new KitRpcError(-32000, `${what}: ${error.message}`, { reason: error.reason, command, step })
  if (error instanceof KitRpcError) return new KitRpcError(error.code, `${what}: ${error.message}`, error.data)
  return new Error(`${what}: ${errorText(error)}`)
}

/** One step an `ai/run` ran: its command, whether it changed the document, and its result. */
type RunStep = { command: string; changed: boolean; result: unknown }

/** The commands that take back or bring back edits: a run that ran one is not undone by counting steps. */
const UNDO_OR_REDO = new Set(['edit.undo', 'edit.redo'])

/** The agent's undo (KitModel M12a): takes back the agents' last step, never the person's. */
const AGENT_UNDO = { scope: 'agent' }

/** The error a step with a `context` answers on an engine that keeps no editor state of the agent's own. */
function noAgentState(command: string, step: number) {
  return new KitRpcError(
    -32000,
    `step ${step} (\`${command}\`) cannot run in a call context: this kit's engine keeps no editor state of the agent's own, so its \`on\`, \`part\` and \`time\` cannot be set without moving the person's`,
    { reason: UNSUPPORTED_REASON, command, step },
  )
}

/** Commands whose id, title, or parameter notes hold every keyword, as Kition's runtime matches them. */
function matching(commands: readonly KitCommand[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands
    .filter((command) => {
      const haystack = `${command.id} ${command.title} ${command.description ?? ''} ${command.params ?? ''}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      enabled: command.enabled,
      mutates: command.mutates,
      schema: command.schema ?? null,
    }))
}


/**
 * Opens the host's document in `manifest`'s engine. `describe` turns `inspect()` into what the
 * editor shows. Answers the host's `ui/initialize` once open, and serves `ai/*`.
 */
/** A kit's own choices for its session. */
export type KitSessionOptions = {
  /**
   * An `ai/run` step that moves neither the engine's revision nor its `inspect()` (an agent
   * selecting) refreshes the editor without repainting the canvas (`KitRunOptions.skipUnchangedPaint`).
   * Off by default: a kit opts in when its engine paints nothing that neither of them shows.
   */
  agentSkipsUnchangedPaint?: boolean
  /**
   * The lease (Kit UI protocol section 7b) an `ai/run` step on the live document must hold, for a
   * kit some of whose commands need one (a PDF's full rewrite takes the whole document, `*`):
   * asked before each step with its command and params, answering the scope, or `null` or `''`
   * for none (a kit with an engine extra such as `leaseScope` asks its engine). The session takes
   * the lease through the host before the step and releases it when the step ends. A step whose
   * lease another session holds is not run: `ai/run` fails at it with reason `held` and the
   * person sees a notice; with a kit that asks, a step that edits without a lease of its own is
   * refused the same way while another session holds the whole document (`*`). Not asked when
   * the host serves no leases (nobody to coordinate with) or for the agent's draft, which is
   * never shared until the person merges it. An error asking counts as no lease.
   */
  agentLeaseScope?: (command: string, params: Record<string, unknown>, engine: KitEngine) => string | null | Promise<string | null>
  /** One renewal's length for an agent step's lease (milliseconds, `host/leaseAcquire`'s `ttl`); the host's own by default. */
  agentLeaseTtl?: number
  /**
   * Takes a change of the file on disk into the open document while it has no unsaved edits
   * (`KitDocumentOptions.followFile`); without it, or when it answers `false`, the document reopens.
   */
  followFile?: KitDocumentOptions['followFile']
  /** The person's view state kept with the host after each save (`KitDocumentOptions.viewState`, capability `view-state`). */
  viewState?: KitDocumentOptions['viewState']
  /**
   * The person merged the agent's draft (`draft/merge`, section 7d): it is in the document as
   * one step of the person's Undo (KitModel 1.1 M12a). A kit that keeps its own undo history
   * records the step here. Called once the merge took changes in, before the host's answer.
   */
  draftMerged?: (merged: { summary: DraftSummary }) => void
}

/** The error an `ai/run` step answers when another session holds the lease it needs (`data.reason` `held`). */
export function leaseHeldRefusal(command: string, step: number, scope: string, holder: KitLease['holder'] | null) {
  const who = holder?.name || 'another session'
  return new KitRpcError(-32000, `step ${step} (\`${command}\`) is not allowed: ${who} holds the lease on \`${scope}\``, { reason: LEASE_HELD_REASON, command, step, scope, ...(holder ? { holder } : {}) })
}

/**
 * Runs one agent step under the lease `scope` needs (none when empty): a lease another session
 * holds refuses it before anything runs (`refuse` answers the error to throw), and the step's own
 * lease is released when it ends, however it ends. Without a scope, a step that edits is refused
 * while another session holds the whole document.
 */
export async function withAgentLease<T>(leases: KitLeases, scope: string, mutates: boolean, ttl: number | undefined, step: () => Promise<T>, refuse: (scope: string, holder: KitLease['holder'] | null) => Error): Promise<T> {
  if (!scope) {
    const whole = mutates ? leases.list().find((lease) => !lease.holder.self && lease.scope === '*') : undefined
    if (whole) throw refuse('*', whole.holder)
    return step()
  }
  const outcome = await leases.acquire(scope, ttl)
  if (!outcome.granted) {
    // Narrowed by hand: kits may build this source with strict mode off, where `granted` does not narrow.
    const refused = outcome as Extract<LeaseOutcome, { granted: false }>
    // A read-only session's step runs into the session's own refusal, which says why.
    if (refused.reason === 'read-only') return step()
    throw refuse(scope, refused.holder)
  }
  try {
    return await step()
  } finally {
    // `lease` is null when nobody was there to coordinate with: nothing to let go.
    if (outcome.lease) await leases.release(scope)
  }
}

export function useKitSession<T>(host: HostConnection, manifest: KitModuleManifest, describe: (info: KitEngineInfo) => T, options: KitSessionOptions = {}) {
  const path = host.init.document.path
  const readOnly = host.readOnly === true
  // A commenter (`document.comments.canComment` on a read-only document) runs the kit's comment commands.
  const canComment = readOnly && host.init.document.comments?.canComment === true
  const commentList = manifest.commentCommands
  const comments = useMemo(() => commentCommands(commentList, canComment), [canComment, commentList])
  const session = useKitDocument(host.files, manifest, path, true, describe, { readOnly, canComment, followFile: options.followFile, viewState: options.viewState })
  const { doc, failure } = session
  // The host hears of the engine's changes, keyed on its revision and saved state, not on the
  // editor's own refreshes (a view-only command refreshes the editor without changing the document).
  const revision = doc?.info.revision ?? null
  const dirty = doc?.info.dirty ?? false
  const latest = useRef(session)
  latest.current = session

  /**
   * Each command's menu path, for configuration by menu (`menu:Filter`): loaded once per open
   * document. Every caller waits on the same `commands()` call, so runs waiting for it continue in
   * the order they were made.
   */
  const menus = useRef<{ doc: KitEngine | null; map: MenuMap | null; commands: CommandMap | null; loading: Promise<MenuMap> | null }>({ doc: null, map: null, commands: null, loading: null })
  const menusFor = useCallback((open: KitEngine) => {
    const held = menus.current
    if (held.doc === open && held.loading) return held.loading
    const loading = open.commands().then((list) => {
      const map: MenuMap = new Map(list.map((command) => [command.id, command.menu]))
      if (menus.current.loading === loading) menus.current = { doc: open, map, commands: new Map(list.map((command) => [command.id, command])), loading }
      return map
    })
    // A failed load is not kept: the next caller tries again.
    loading.catch(() => {
      if (menus.current.loading === loading) menus.current = { doc: null, map: null, commands: null, loading: null }
    })
    menus.current = { doc: open, map: null, commands: null, loading }
    return loading
  }, [])
  useEffect(() => {
    if (doc) menusFor(doc).catch(() => undefined)
  }, [doc, menusFor])

  /**
   * Whether the read-only rules refuse `command` (only asked once the catalog is loaded): an edit
   * that is not one of a commenter's comment commands.
   */
  const edits = useCallback(
    (command: string) => {
      const known = menus.current.commands?.get(command)
      return refusedReadOnly(known ?? { id: command }, comments)
    },
    [comments],
  )

  /**
   * Runs a command unless the host's configuration refuses it (UI-C2), or the document is
   * read-only and the command edits (reason `read-only`; the engine worker refuses it too, and
   * whatever edit gets past these rules). Every command a kit runs through the session comes here
   * (menus, buttons, shortcuts, canvas tools, and `ai/run`), so the host's configuration is
   * enforced here; engine tool calls (`session.tool`) and read-only queries do not run commands
   * and are not gated here.
   */
  const run = useCallback(
    async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null, options: KitRunOptions = {}) => {
      const open = latest.current.doc
      // Before the editor sees the document, nothing runs (fail closed).
      if (!open) return null
      const held = menus.current
      // Once the menu map is loaded the check is synchronous, so the engine gets the command in
      // the same tick. Before that the run waits for the map; if loading it fails, the run
      // rejects: a command whose menus are unknown is not run (fail closed).
      const map = held.doc === open && held.map ? held.map : await menusFor(open)
      if (uiState(host.ui.get(), `command:${command}`, map.get(command) ?? []).denied) throw notAllowed(command)
      if (readOnly && edits(command)) throw readOnlyRefusal(command)
      try {
        return await session.run(command, params, damage, options)
      } catch (error) {
        if (isReadOnlyError(error)) throw readOnlyRefusal(command)
        throw error
      }
    },
    [edits, host, menusFor, readOnly, session.run],
  )
  const skipUnchanged = options.agentSkipsUnchangedPaint === true
  const latestOptions = useRef(options)
  latestOptions.current = options
  const strings = useMemo(() => createStrings(KIT_UI_CATALOGS, host.init.locale), [host])
  // A kit that leases agent steps hears the document's leases from the start, so a step knows
  // who holds what before its first acquire.
  const leasesAgent = options.agentLeaseScope != null
  useEffect(() => {
    if (leasesAgent) kitLeases(host)
  }, [host, leasesAgent])
  /** The agent runs on the live document, one at a time: the last one queued. */
  const agentRuns = useRef<Promise<void>>(Promise.resolve())
  /** Who the `ai/run` or draft merge under way runs as. */
  const running = useRef<KitEditedBy | null>(null)
  /** Who made the change that left the document at `revision`, until the person edits again. */
  const lastEdit = useRef<{ edit: KitEditedBy; revision: number } | null>(null)
  const [editedBy, setEditedBy] = useState<KitEditedBy | null>(null)
  /** The agent or the host made the change that left the document at the engine's revision now. */
  const edited = useCallback((edit: KitEditedBy, revision: number) => {
    lastEdit.current = { edit, revision }
    setEditedBy(edit)
  }, [])
  const answered = useRef(false)
  /** The replica version the host last heard of, per open document. */
  const heardVersion = useRef<{ doc: KitEngine | null; version: string | null }>({ doc: null, version: null })

  /**
   * The agent's draft (protocol section 7d): a second engine on a fork of this document, made on
   * the first `ai/run` with `draft: true`, gone with the document.
   */
  const draftRef = useRef<KitDraft | null>(null)
  draftRef.current ??= new KitDraft({
    open: () => latest.current.draft.open(),
    merge: (changes, blobs, origin) => latest.current.draft.merge(changes, blobs, origin),
    compare: (changes) => latest.current.draft.compare(changes),
    preview: async (maxSize) => {
      const open = latest.current.doc
      return open ? previewPng(open, maxSize).catch(() => null) : null
    },
    changed: (info) => host.peer.notify('draft/changed', info),
  })
  useEffect(() => {
    const draft = draftRef.current!
    draft.attach()
    return () => draft.dispose()
  }, [])

  // The host's `ui/initialize` is answered when the document is open, or fails with why not.
  useEffect(() => {
    if (answered.current) return
    if (doc) {
      answered.current = true
      // The kit answers the object model when its engine can (`engine/kitModel.ts`).
      // `draft-model`: object-model batches also run on the agent's draft (section 7d).
      // `check`: `document/check` answers the engine's diagnostics (none from an engine without them).
      // `context`: agent steps run in an editor state of the agent's own, with their call context.
      // `changes`: the replica's version and what changed since one (`ai/version`, `ai/changes`).
      host.opened([...(doc.info.model ? ['model', 'draft', 'draft-model', 'check'] : ['check']), ...(doc.info.context ? ['context'] : []), ...(doc.info.changes ? ['changes'] : []), ...(doc.info.premises ? ['premises'] : [])])
    } else if (failure) {
      answered.current = true
      host.failed(new Error(failure))
    }
  }, [doc, failure, host])

  // Every change goes to the host: the tab's unsaved mark, and the agent's `kit.changed`.
  useEffect(() => {
    if (!doc) return
    const by: DocumentChangeBy = running.current ?? (lastEdit.current?.revision === doc.info.revision ? lastEdit.current.edit : { by: 'person' })
    if (by.by === 'person' && lastEdit.current) {
      lastEdit.current = null
      setEditedBy(null)
    }
    host.changed({ dirty: doc.info.dirty, revision: doc.info.revision, title: host.init.document.name, ...by })
  }, [doc, host, revision, dirty])

  // A newer kit edited the document (protocol section 7f, KitModel rule M5a): the engine
  // reads its schema versions when the document opens and after imports, and the host hears once
  // of each newer one, to tell the person and offer the update (it never blocks editing).
  const schemaReads = doc?.info.schema?.reads ?? null
  const newestAuthor = doc?.info.schema?.newestAuthor ?? null
  const toldSchema = useRef<string | null>(null)
  useEffect(() => {
    if (schemaReads === null || newestAuthor === null || newestAuthor <= schemaReads) return
    const key = `${schemaReads}:${newestAuthor}`
    if (toldSchema.current === key) return
    toldSchema.current = key
    host.peer.notify('document/schema', { reads: schemaReads, newestAuthor })
  }, [host, newestAuthor, schemaReads])

  // The replica's version after every edit that moved it (capability `replica`); a document just
  // opened starts from the version it opened with.
  useEffect(() => {
    if (!host.replica || !doc) return
    const bytes = doc.info.replica ?? null
    const version = bytes ? bytes.join(',') : null
    const heard = heardVersion.current
    heardVersion.current = { doc, version }
    if (heard.doc !== doc || !bytes || version === heard.version) return
    host.peer.notify('replica/changed', { version: bytes.slice().buffer })
  }, [doc, host, revision])

  useEffect(() => {
    const { peer } = host
    peer.handle('document/state', () => {
      const open = latest.current.doc
      return { dirty: open?.info.dirty ?? false, revision: open?.info.revision ?? 0, title: host.init.document.name }
    })
    peer.handle('document/save', async () => {
      if (readOnly) throw new KitRpcError(-32000, 'the document is read-only', { reason: READ_ONLY_REASON })
      await latest.current.save()
      return { saved: !(latest.current.doc?.info.dirty ?? true), version: null }
    })
    const opened = () => {
      const open = latest.current.doc
      if (!open) throw new Error('the document is still opening')
      return open
    }
    const draft = draftRef.current!
    /** The draft's engine for an `ai/*` call with `draft: true`; a read-only document has none. */
    const draftEngine = (create: boolean) => {
      if (readOnly) throw new KitRpcError(-32000, 'a draft is not allowed: the document is read-only', { reason: READ_ONLY_REASON })
      return draft.engine(create)
    }
    peer.handle('ai/inspect', async (params) => {
      const isDraft = params?.draft === true
      const open = isDraft ? await draftEngine(false) : opened()
      const { width, height, dirty, canUndo, canRedo, inspected } = open.info
      const summary = `${width} × ${height}${isDraft ? ', draft' : dirty ? ', unsaved' : ''}`
      const at = params.context ? await open.inspectAt(params.context, params.part) : { details: inspected }
      return open.agentReply({ path, kit: manifest.kitId, revision: open.info.revision, summary, dirty: isDraft ? false : dirty, canUndo, canRedo, ...at, ...(isDraft ? { draft: draft.info() } : {}) })
    })
    peer.handle('document/check', async (params) => {
      const open = params?.draft === true ? await draftEngine(false) : opened()
      return open.agentReply({ diagnostics: await open.check() })
    })
    peer.handle('ai/commands', async ({ query }) => {
      const listed = agentCommands(host.ui.get(), await opened().commands())
      // A read-only document lists its editing commands as not enabled.
      return matching(readOnly ? listed.map((command) => (refusedReadOnly(command, comments) ? { ...command, enabled: false } : command)) : listed, query)
    })
    peer.handle('ai/run', async (params) => {
      const { steps, save, draft: onDraft } = params
      const by = runAs(params)
      const open = opened()
      const map = await menusFor(open)
      const refused = refusedStep(host.ui.get(), steps, (id) => map.get(id) ?? [])
      if (refused >= 0) throw notAllowed(steps[refused].command, refused)
      const editing = readOnly ? steps.findIndex((step) => edits(step.command)) : -1
      if (editing >= 0) throw readOnlyRefusal(steps[editing].command, editing)
      // On the draft: the live document, its undo history, and its file are left alone.
      if (onDraft === true) return runOnDraft(await draftEngine(true), steps)
      // A context the engine cannot set apart from the person's state is refused, never ignored.
      const contextless = open.info.context === true ? -1 : steps.findIndex((step) => step.context != null)
      if (contextless >= 0) throw noAgentState(steps[contextless].command, contextless)
      return oneAgentRun(() => runLive(open, steps, save, by))
    })
    /**
     * Runs `steps` on the live document as `by`. A failed run is atomic (KHP A53): the steps before
     * the failing one are undone in the agent's undo scope (`rolledBackRun`). A step another
     * session's lease refuses is the exception (section 7b): the steps before it stay.
     */
    const runLive = async (open: KitEngine, steps: AiRunParams['steps'], save: boolean, by: KitEditedBy) => {
      const completed: RunStep[] = []
      // The steps are the agent's, for the person who started it (KitModel M12a): the person's
      // Undo keeps them, and the agent's own `edit.undo` takes back only the agent's steps. A
      // host's change is KDM's `system(label)`: a step of no history.
      const origin: Origin = by.by === 'system' ? { kind: 'system', principal: 'kdm', label: by.originLabel } : { kind: 'agent', principal: host.init.document.comments?.me ?? 'agent', label: 'ai/run' }
      /** The revision the agent's last step left, to tell another's edit between steps. */
      const track = { last: null as number | null, meanwhile: false }
      // The agent's own editor state through the run (C3b), on an engine that can hold one: each
      // step runs in it with its context, and the person's selection, part and time stay put.
      const own: KitAgentState | null = open.info.context === true ? { state: null } : null
      const options = (set: KitCallContext | null): KitRunOptions => ({ ...(skipUnchanged ? { skipUnchangedPaint: true } : {}), origin, ...(own ? { agent: { state: own, set } } : {}) })
      running.current = by
      try {
        for (const [index, step] of steps.entries()) {
          let before = open.info.revision
          let result: string | null
          try {
            // With the kit's consent, a step that changes neither the revision nor inspect() (the agent selecting) does not repaint.
            const runStep = () => {
              // Read once the step's lease is held: what changed while it was asked for is not the step's.
              before = open.info.revision
              if (track.last !== null && before !== track.last) track.meanwhile = true
              // A read (the catalog's `mutates: false`; Undo and Redo always count as edits) that
              // changed nothing refreshes nothing: the person's selection and find matches, kept
              // per change, stay as they are.
              const reads = !UNDO_OR_REDO.has(step.command) && menus.current.commands?.get(step.command)?.mutates === false
              return run(step.command, step.params ?? {}, null, { ...options(step.context ?? null), ...(reads ? { reads: true } : {}) })
            }
            result = await leasedStep(open, step.command, step.params ?? {}, index, runStep, by)
          } catch (error) {
            if (error instanceof KitRpcError && (error.data as { reason?: unknown } | undefined)?.reason === LEASE_HELD_REASON) throw error
            // A refusal (the configuration changed mid-run) answers as one; other RPC errors keep their code and data.
            const failure =
              error instanceof KitRpcError && (error.data as { reason?: unknown } | undefined)?.reason === 'not-allowed'
                ? notAllowed(step.command, index)
                : error instanceof KitRpcError && (error.data as { reason?: unknown } | undefined)?.reason === READ_ONLY_REASON
                  ? readOnlyRefusal(step.command, index)
                  : stepFailure(error, step.command, index)
            // A host's change is no undo step of anyone's: there is nothing to take it back with.
            if (by.by === 'system') throw failure
            throw await rolledBackRun(open, completed, failure, step.command, index, track, options(null), by)
          }
          let parsed: unknown = result
          try {
            parsed = result == null ? null : JSON.parse(result)
          } catch {
            // A plain string result stays a string.
          }
          track.last = open.info.revision
          completed.push({ command: step.command, changed: open.info.revision !== before, result: parsed })
          if (parsed !== null && typeof parsed === 'object' && 'closed' in parsed && parsed.closed === true) {
            return {completed,closed:true,saved:false,notRun:steps.length-completed.length}
          }
        }
      } finally {
        running.current = null
      }
      if (completed.some((step) => step.changed)) edited(by, open.info.revision)
      const saveAllowed = !readOnly && !uiState(host.ui.get(), 'action:save').denied
      if (save && saveAllowed && open.info.dirty) await latest.current.save()
      return open.agentReply({ completed, saved: save && saveAllowed && !open.info.dirty })
    }
    /**
     * Puts the live document back after the agent's step `index` failed (KHP A53): each earlier
     * step that changed it is undone in the agent's undo scope, newest first, so the person's own
     * edits stay. Answers the failure to throw, its `data` saying what happened: `completed` empty
     * and the steps in `rolledBack`; `editedMeanwhile` when someone else edited the document while
     * the run was under way, so it is not simply as it was; and, when the steps cannot all be
     * taken back, the steps that stay in `completed` and why in the message.
     */
    const rolledBackRun = async (open: KitEngine, done: RunStep[], failure: Error, command: string, index: number, track: { last: number | null; meanwhile: boolean }, undoOptions: KitRunOptions, by: KitEditedBy) => {
      const fields = failure instanceof KitRpcError && failure.data && typeof failure.data === 'object' ? (failure.data as Record<string, unknown>) : {}
      const code = failure instanceof KitRpcError ? failure.code : -32000
      const answer = (sentence: string, stay: RunStep[], undone: RunStep[] | null) => {
        const data: Record<string, unknown> = { ...fields, command, step: index, completed: stay, ...(undone ? { rolledBack: undone } : {}) }
        if (track.meanwhile) data.editedMeanwhile = true
        return new KitRpcError(code, `${failure.message}${sentence}`, data)
      }
      const changed = done.filter((step) => step.changed).length
      const cannot = (why: string) => answer(` The ${done.length} step(s) before it could not be rolled back (${why}): they stay in the document; undo them (\`edit.undo\`) or keep them.`, done, null)
      if (track.last !== null && open.info.revision !== track.last) track.meanwhile = true
      if (changed === 0) return answer(done.length ? ` The ${done.length} step(s) before it were rolled back: the document is as it was before the run.` : '', [], done)
      if (done.some((step) => UNDO_OR_REDO.has(step.command))) return cannot('the steps undid or redid edits themselves')
      // Without its own undo scope, the engine's undo takes back the last edit whoever made it.
      if (track.meanwhile && open.info.origins !== true) return cannot("someone else edited the document while the run was under way, and this kit's engine cannot take back the agent's steps alone: it does not run commands as an origin")
      let undone = 0
      let why = ''
      while (undone < changed) {
        const before = open.info.revision
        if (track.last !== null && before !== track.last) track.meanwhile = true
        try {
          await leasedStep(open, 'edit.undo', AGENT_UNDO, index, () => run('edit.undo', AGENT_UNDO, null, undoOptions), by)
        } catch (error) {
          why = errorText(error)
          break
        }
        if (open.info.revision === before) {
          why = 'the kit had nothing more to undo'
          break
        }
        undone += 1
        track.last = open.info.revision
      }
      if (undone === 0) return cannot(why)
      if (undone < changed) {
        // The newest steps were undone: the earlier ones up to the last step still standing stay.
        let left = changed - undone
        let cut = 0
        while (left > 0) if (done[cut++].changed) left -= 1
        return answer(` Only ${undone} of the ${changed} step(s) that changed the document could be rolled back (${why}): the first ${cut} step(s) stay in the document.`, done.slice(0, cut), done.slice(cut))
      }
      if (track.meanwhile) {
        return answer(
          ` The ${done.length} step(s) before it were rolled back in the agent's undo scope, but someone else edited the document while the run was under way: their edits stay, and where they changed what those steps made or changed, their change was kept (an object a step created went, with what they did to it). Inspect the document before going on.`,
          [],
          done,
        )
      }
      return answer(` The ${done.length} step(s) before it were rolled back: the document is as it was before the run.`, [], done)
    }
    /** Runs one agent run on the live document at a time, so a run's rollback never meets another's steps. */
    const oneAgentRun = <R,>(call: () => Promise<R>): Promise<R> => {
      const next = agentRuns.current.then(call, call)
      agentRuns.current = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }
    /**
     * Runs an agent step on the live document under the lease the kit says it needs
     * (`agentLeaseScope`); a step another session's lease refuses tells the person and fails.
     */
    const leasedStep = async <R,>(open: KitEngine, command: string, params: Record<string, unknown>, index: number, step: () => Promise<R>, by: KitEditedBy): Promise<R> => {
      const ask = latestOptions.current.agentLeaseScope
      const leases = ask ? kitLeases(host) : null
      if (!ask || !leases?.available) return step()
      let scope = ''
      try {
        scope = (await ask(command, params, open)) || ''
      } catch {
        scope = ''
      }
      const mutates = menus.current.commands?.get(command)?.mutates ?? true
      return withAgentLease(leases, scope, mutates, latestOptions.current.agentLeaseTtl, step, (held, holder) => {
        // The person hears of the agent's edit not made; a host's own change is the host's to report.
        if (by.by === 'agent') host.notify({ level: 'warning', title: strings('agentLeaseHeld', { name: holder?.name || strings('someone') }) })
        return leaseHeldRefusal(command, index, held, holder)
      })
    }
    peer.handle('ai/preview', async ({ maxSize, draft: onDraft }) => ({ png: await previewPng(onDraft === true ? await draftEngine(false) : opened(), maxSize) }))
    /** Runs the agent's steps on the draft's engine, as `ai/run` runs them on the document. */
    const runOnDraft = async (engine: KitEngine, steps: Array<{ command: string; params?: Record<string, unknown> }>) => {
      const completed: Array<{ command: string; changed: boolean; result: unknown }> = []
      let closed = false
      try {
        for (const [index, step] of steps.entries()) {
          const before = engine.info.revision
          let result: string | null
          try {
            result = await engine.execute(step.command, step.params ?? {})
          } catch (error) {
            if (error instanceof KitParamsError) throw new KitRpcError(-32000, `step ${index} (\`${step.command}\`) failed on the draft: ${error.message}`, { reason: INVALID_PARAMS_REASON, command: step.command, step: index, errors: error.errors })
            throw new Error(`step ${index} (\`${step.command}\`) failed on the draft: ${errorText(error)}`)
          }
          let parsed: unknown = result
          try {
            parsed = result == null || result === '' ? null : JSON.parse(result)
          } catch {
            // A plain string result stays a string.
          }
          completed.push({ command: step.command, changed: engine.info.revision !== before, result: parsed })
          if (parsed !== null && typeof parsed === 'object' && 'closed' in parsed && parsed.closed === true) {
            closed = true
            return {completed,closed:true,saved:false,notRun:steps.length-completed.length}
          }
        }
      } finally {
        if (!closed && completed.some((step) => step.changed)) draft.edited()
      }
      return { completed, saved: false }
    }
    // The draft (capability `draft`, section 7d). Merge and discard are the person's, through the
    // host; a host never forwards them from a model.
    peer.handle('draft/state', () => draft.info())
    peer.handle('draft/ready', () => draft.ready())
    peer.handle('draft/reopen', () => draft.reopen())
    peer.handle('draft/compare', (params) => draft.compare(Math.max(1, Number(params?.maxSize) || 1024)))
    peer.handle('draft/merge', async ({ origin }) => {
      if (readOnly) throw new KitRpcError(-32000, 'the document is read-only', { reason: READ_ONLY_REASON })
      const recorded: DraftOrigin = { kind: 'agent', principal: String(origin?.principal ?? ''), ...(origin?.label ? { label: String(origin.label) } : {}) }
      running.current = { by: 'agent' }
      try {
        const merged = await draft.merge(recorded)
        const open = latest.current.doc
        if (open) edited({ by: 'agent' }, open.info.revision)
        if (merged.merged) latestOptions.current.draftMerged?.({ summary: merged.summary })
        return merged
      } catch (error) {
        if (error instanceof KitModelError) throw modelRefusal(error.data)
        throw error
      } finally {
        running.current = null
      }
    })
    peer.handle('draft/discard', () => draft.discard())
    // The object model (capability `model`, protocol section 7a): a batch is one step of this
    // editor's undo history. A command the host's configuration refuses fails the batch at it.
    const modelCall = async <R,>(call: () => Promise<R>) => {
      if (!opened().info.model) throw new KitRpcError(-32601, "the kit's engine does not answer the object model")
      try {
        return await call()
      } catch (error) {
        if (error instanceof KitModelError) throw modelRefusal(error.data)
        throw error
      }
    }
    peer.handle('model/describe', () => modelCall(() => latest.current.model.describe()))
    // What an agent's write changed (capability `changes`, C3b): the replica's version before it,
    // and the change set since that version after it, as Kit Process Protocol's `model.version` and
    // `model.changes` answer them on the headless path.
    const replicaCall = <R,>(call: () => Promise<R>) => {
      if (opened().info.changes !== true) throw new KitRpcError(-32601, "the kit's engine keeps no replica, so it cannot say what changed")
      return call()
    }
    peer.handle('ai/version', () => replicaCall(async () => ({ version: await latest.current.model.version() })))
    peer.handle('ai/changes', (params) => replicaCall(() => latest.current.model.changes(String(params?.since ?? ''))))
    peer.handle('ai/premise', ({ method, params }) => opened().premiseRead(method, params))
    peer.handle('model/batch', (params) =>
      modelCall(async () => {
        // The engine describes its own schema: a host's `schema` is not passed on.
        const { schema: _schema, draft: onDraft, ...request } = params ?? {}
        const ops = Array.isArray(request.ops) ? request.ops : []
        if (readOnly && ops.length) throw new KitModelError({ code: READ_ONLY_REASON, index: null, message: 'the document is read-only' })
        const map = await menusFor(opened())
        ops.forEach((op, index) => {
          if (op?.op === 'command' && typeof op.id === 'string' && uiState(host.ui.get(), `command:${op.id}`, map.get(op.id) ?? []).denied) {
            throw new KitModelError({ code: 'command-failed', index, message: notAllowed(op.id).message })
          }
        })
        if (onDraft !== true) return latest.current.model.batch(request)
        // On the agent's draft (capability `draft-model`): the document, its undo history, and its
        // file are left alone. Only writes open a draft; a read answers from the one there is.
        const engine = await draftEngine(ops.length > 0)
        const answer = await engine.modelBatch(request)
        if (ops.length) draft.edited()
        return answer
      }),
    )
    // The host saw the file change (`document/fileChanged`): check it now rather than at the next poll.
    const stopFileChanged = peer.on('document/fileChanged', () => void latest.current.checkFile())
    // A co-editor saved a state this document holds (`document/held`): no conflict for it.
    const stopHeld = peer.on('document/held', (params) => {
      if (typeof params?.version === 'string') void latest.current.holdFile(params.version)
    })
    if (host.replica) {
      peer.handle('replica/version', async () => ({ version: await latest.current.replica.version() }))
      peer.handle('replica/export', ({ since }) => latest.current.replica.exportChanges(since))
      peer.handle('replica/import', async ({ changes, blobs }) => ({ damage: await latest.current.replica.importChanges(changes, blobs) }))
      peer.handle('replica/restore', async ({ snapshot, blobs, origin }) => ({ damage: await latest.current.replica.restore(snapshot, blobs, origin) }))
      peer.handle('replica/info', async () => ({ docId: await latest.current.replica.docId() }))
    }
    return () => {
      stopFileChanged()
      stopHeld()
    }
  }, [comments, edited, edits, host, manifest.kitId, menusFor, path, readOnly, run, skipUnchanged, strings])

  /** The comment commands this session runs (a commenter's; empty otherwise), for the editor's menus. */
  return { ...session, run, editedBy, comments }
}
