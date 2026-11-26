import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { KitEngine, type KitAgentStep, type KitEngineInfo, type KitToolMethod } from './kitEngine'
import type { KitModuleManifest } from './kitModule'
import type { KitCheckpoint, KitCheckpointRequest, KitHost, KitViewState } from './kitHost'
import { NOTHING, owedDamage } from './owedDamage'
import type { RasterRect } from './rasterViewport'
import { replicaToOpen, writeWithReplica } from './replica'
import { ReadOnlyError } from './readOnly'
import type { Origin } from '@kition/kdm'
import type { RestoreOrigin } from '@kition/kit-ui-protocol'

/**
 * One or more edits the canvas has not been handed yet: `revision` moves by one with each refresh,
 * and `damage` is what they owe together (`owedDamage`): the canvas repaints that area, everything
 * when it is null, nothing when it is the empty area. React may take several refreshes in one
 * render; their areas are merged, never replaced by the last one's.
 */
export type KitChange = { revision: number; damage: RasterRect | null }

/**
 * What a command refreshes once it ran:
 * - `all` (the default): the editor's state (`describe`), the engine info, and the change counter,
 *   which repaints the canvas and re-asks the editor's queries;
 * - `repaint`: only the canvas repaints (`repaints`), for a command that changes what the document
 *   shows but nothing the editor reads (a player's playhead): no describe, no queries, no host
 *   notification, and no render of the editor;
 * - `none`: nothing, for a command whose effect the editor follows itself.
 */
export type KitRefresh = 'all' | 'repaint' | 'none'
export type KitRunOptions = {
  refresh?: KitRefresh
  /**
   * With `refresh: 'all'`, a command that moved neither the engine's revision nor its `inspect()`
   * (a selection the picture does not show) refreshes the editor without repainting the canvas,
   * as an engine tool call that changed nothing does. A command that changed what `inspect()`
   * says (a playhead) still repaints.
   */
  skipUnchangedPaint?: boolean
  /**
   * The origin the command runs as (KitModel M11): `ai/run` runs its
   * steps as the agent, so they are the agent's undo steps and the person's Undo keeps them
   * (M12a). An engine that does not run commands as an origin (no `executeAs`) runs them as the
   * host's person. Unset: the host's person.
   */
  origin?: Origin
  /**
   * An agent step in the agent's own editor state (`KitAgentStep`, C3b): the person's selection,
   * part and time stay as they are, and `agent.state` follows the agent's.
   */
  agent?: KitAgentStep
  /**
   * The command runs inside the work given to `inOrder`, which holds its place among the person's
   * input: it runs at once instead of waiting behind that work (which it would wait for forever).
   */
  inOrder?: boolean
}

/** The area an engine tool's answer says its event changed (`damage`), or null: repaint everything. */
export function toolDamage(answer: unknown): RasterRect | null {
  const damage = answer !== null && typeof answer === 'object' ? (answer as { damage?: unknown }).damage : null
  if (damage === null || typeof damage !== 'object') return null
  const { x0, y0, x1, y1 } = damage as Record<string, unknown>
  const finite = [x0, y0, x1, y1].every((v) => typeof v === 'number' && Number.isFinite(v))
  return finite && (x1 as number) > (x0 as number) && (y1 as number) > (y0 as number) ? { x0: x0 as number, y0: y0 as number, x1: x1 as number, y1: y1 as number } : null
}

/**
 * One or more canvas repaints asked for without a document change, that the canvas has not
 * committed yet: `tick` moves by one with each, and `damage` is what they owe together
 * (`owedDamage`, as `KitChange`'s): the canvas repaints that area, everything when it is null,
 * nothing when it is the empty area.
 */
export type KitRepaint = { tick: number; damage: RasterRect | null }

/** A store of `KitRepaint`s the canvas subscribes to, so a repaint renders nothing else. */
export type KitRepaints = { get: () => KitRepaint; subscribe: (listener: () => void) => () => void }

/** Each session's `repaints`, to the store behind it: `repaintTaken` reaches it. */
const REPAINT_STORES = new WeakMap<KitRepaints, ReturnType<typeof repaintStore>>()

function repaintStore() {
  const owed = owedDamage()
  let current: KitRepaint = { tick: 0, damage: null }
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    bump(damage: RasterRect | null) {
      const tick = owed.add(damage)
      current = { tick, damage: owed.total() }
      for (const listener of listeners) listener()
    },
    taken(tick: number) {
      owed.paid(tick)
    },
  }
}

/**
 * The canvas committed `repaints`' repaint numbered `tick` (`KitDocumentCanvas`, a layout effect):
 * the areas it holds are no longer owed. A store that is not a session's is left alone.
 */
export function repaintTaken(repaints: KitRepaints, tick: number) {
  REPAINT_STORES.get(repaints)?.taken(tick)
}

/**
 * Runs `work` (a command) after the engine tool events still waiting on the page: see
 * `orderCommands`. With `hold`, everything sent after it (tool events, keys, commands) waits until
 * `work` is done: a decision that needs more than one engine answer (`inOrder`).
 */
export type CommandOrder = <T>(work: () => Promise<T>, hold?: boolean) => Promise<T>

/** Each document's slot for its tools' `CommandOrder`, by the document's `tool` call. */
const COMMAND_ORDER = new WeakMap<object, { current: CommandOrder | null }>()

/**
 * Lets the engine tools driven by `tool` (a document's `tool` call) order that document's
 * commands: a shortcut pressed right after fast keys (Shift+Arrow) must run after them, but the
 * tools send their events one at a time and the others wait on the page. Answers how to stop.
 */
export function orderCommands(tool: object, order: CommandOrder): () => void {
  const slot = COMMAND_ORDER.get(tool)
  if (!slot) return () => undefined
  slot.current = order
  return () => {
    if (slot.current === order) slot.current = null
  }
}

/** How a document follows its file and its stored replica (`useKitDocument`). */
export type KitDocumentOptions = {
  readOnly?: boolean
  canComment?: boolean
  /**
   * The file changed on disk while the document has no unsaved edits. Answers `true` when the kit
   * took the change in itself (the open engine merged the file, keeping its undo history and the
   * editor's scroll position; the engine's `info` is read again after); `false`, or a failure, reopens the document from the file as
   * without it. Not asked while there are unsaved edits, which raise `conflict`.
   */
  followFile?: (engine: KitEngine, stamp: string) => boolean | Promise<boolean>
  /**
   * The person's view state to keep with the host after each save (Kit UI protocol section 7n,
   * capability `view-state`): never in the file or the replica. A failed write never fails the
   * save; without the capability nothing is written. Read it back with `readViewState`.
   */
  viewState?: () => KitViewState | null | undefined
}

/**
 * A save refused because the file changed on disk since the document read or wrote it: writing
 * would replace that change. The document raises `conflict`; the person merges the change or keeps
 * theirs (`keepMine`), and saves again.
 */
export class FileChangedError extends Error {
  constructor(path: string) {
    super(`${path} changed on disk since it was opened; merge the change or keep yours before saving`)
    this.name = 'FileChangedError'
  }
}

export function isFileChangedError(error: unknown): error is FileChangedError {
  return error instanceof Error && error.name === 'FileChangedError'
}

/** How often an active tab checks whether something else (the agent) replaced the file. */
const FILE_CHECK_MS = 2000

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One workspace file opened in a kit's in-page engine: starts the engine
 * worker with the file's bytes, runs commands, and saves the file back in
 * place. `change` moves with every edit so the canvas knows what to repaint.
 * While the tab is active it follows the file: when the agent saves a new
 * version the document reloads, unless there are unsaved edits, which raise
 * `conflict`. `describe` turns the engine's `inspect()` JSON into what the
 * kit's editor shows; `host` reads and writes the file, and keeps its replica when it can
 * (`replicaRead`, `replicaWrite`): the document then opens with the stored replica (UI-R1).
 * `options.readOnly` opens it for viewing: the engine refuses edits and `save` refuses to write;
 * `options.canComment` (a commenter) lets the manifest's `commentCommands` through all the same.
 * See `KitDocumentOptions` for the rest.
 */
export function useKitDocument<T>(host: KitHost, manifest: KitModuleManifest, path: string, active: boolean, describe: (info: KitEngineInfo) => T, options: KitDocumentOptions = {}) {
  const readOnly = options.readOnly === true
  const canComment = readOnly && options.canComment === true
  const followRef = useRef(options.followFile)
  followRef.current = options.followFile
  const docRef = useRef<KitEngine | null>(null)
  const describeRef = useRef(describe)
  describeRef.current = describe
  const stampRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const [doc, setDoc] = useState<KitEngine | null>(null)
  const [info, setInfo] = useState<KitEngineInfo | null>(null)
  const [state, setState] = useState<T | null>(null)
  const [change, setChange] = useState<KitChange>({ revision: 0, damage: null })
  const [dirty, setDirty] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [openMs, setOpenMs] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const repaintsRef = useRef<ReturnType<typeof repaintStore> | null>(null)
  repaintsRef.current ??= repaintStore()
  const repaints = repaintsRef.current

  // The repaints owed (`owedDamage`): each refresh's area, until a change that holds it is committed.
  // A change holds every area owed when React computed it (`covered`, by the last one's number), so
  // two refreshes taken in one render repaint what both owe: a press that changed the document
  // (everything) then a release that changed nothing (the empty area) still repaints everything.
  const owedRef = useRef<ReturnType<typeof owedDamage> | null>(null)
  owedRef.current ??= owedDamage()
  const owed = owedRef.current
  const coveredRef = useRef(new WeakMap<KitChange, number>())

  const refresh = useCallback((damage: RasterRect | null = null) => {
    const current = docRef.current
    if (!current) return
    setInfo(current.info)
    setState(describeRef.current(current.info))
    setDirty(current.info.dirty)
    owed.add(damage)
    setChange((previous) => {
      // An area a change committed earlier already took: nothing is left to repaint for it.
      const next: KitChange = { revision: previous.revision + 1, damage: owed.total() }
      coveredRef.current.set(next, owed.last())
      return next
    })
  }, [owed])

  // A committed change was handed to the canvas: the areas it holds are no longer owed.
  useLayoutEffect(() => {
    const covered = coveredRef.current.get(change)
    if (covered) owed.paid(covered)
  }, [change, owed])

  /** Reads the file into a new document and swaps it in; the old one stays on screen until then. */
  const load = useCallback(async (isCurrent: () => boolean) => {
    busyRef.current = true
    try {
      const { bytes, stamp } = await host.read(path)
      if (!isCurrent()) return
      const stored = await replicaToOpen(host, path)
      if (!isCurrent()) return
      const started = performance.now()
      const name = path.split('/').filter(Boolean).pop() || path
      const next = await KitEngine.open(manifest, name, bytes, host.lend?.(path) ?? null, host.replicaWrite ? { stored, follow: true } : null, readOnly, canComment)
      setOpenMs(Math.round(performance.now() - started))
      if (!isCurrent()) {
        next.dispose()
        return
      }
      const previous = docRef.current
      docRef.current = next
      stampRef.current = stamp
      setDoc(next)
      setConflict(false)
      setFailure(null)
      refresh()
      previous?.dispose()
    } finally {
      busyRef.current = false
    }
  }, [canComment, host, manifest, path, readOnly, refresh])

  useEffect(() => {
    let current = true
    load(() => current).catch((error) => {
      if (current) setFailure(errorText(error))
    })
    return () => {
      current = false
    }
  }, [attempt, load])

  useEffect(() => () => {
    docRef.current?.dispose()
    docRef.current = null
  }, [path])

  /** Commands and tool calls sent and not answered yet: `checkFile` waits for them before it reads `dirty`. */
  const inflight = useRef(new Set<Promise<unknown>>())
  const track = useCallback(<R,>(work: Promise<R>): Promise<R> => {
    inflight.current.add(work)
    const done = () => inflight.current.delete(work)
    work.then(done, done)
    return work
  }, [])
  const settled = useCallback(async () => {
    while (inflight.current.size) await Promise.allSettled([...inflight.current])
  }, [])

  /**
   * Whether the file changed on disk since the document read or wrote it: a document without
   * unsaved edits follows it (the kit's `followFile`, or a reopen), one with them raises `conflict`.
   * `isCurrent` says the caller still wants the answer.
   */
  const checkFile = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      const open = docRef.current
      if (!open || busyRef.current || !stampRef.current) return
      try {
        const stamp = await host.stamp(path)
        if (!isCurrent() || !stamp || stamp === stampRef.current || busyRef.current || docRef.current !== open) return
        // An edit already sent may not have marked the document dirty yet: wait for it, or the
        // reload below would throw it away.
        await settled()
        if (!isCurrent() || busyRef.current || docRef.current !== open) return
        if (open.info.dirty) {
          setConflict(true)
          return
        }
        const follow = followRef.current
        if (follow) {
          busyRef.current = true
          let followed = false
          try {
            followed = (await follow(open, stamp)) === true
          } catch (error) {
            console.warn('[kit] could not follow the changed file; reopening it', error)
          } finally {
            busyRef.current = false
          }
          if (followed) {
            if (docRef.current === open) {
              stampRef.current = stamp
              // The kit took the change in around the engine's commands (an `invoke`): read its state again.
              await open.refreshInfo().catch(() => undefined)
              if (docRef.current === open) refresh()
            }
            return
          }
        }
        if (isCurrent()) await load(isCurrent)
      } catch {
        // The next check tries again.
      }
    },
    [host, load, path, refresh, settled],
  )

  useEffect(() => {
    if (!active) return undefined
    let current = true
    const timer = window.setInterval(() => void checkFile(() => current), FILE_CHECK_MS)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [active, checkFile])

  /** The engine tools' order for this document's commands (`orderCommands`). */
  const order = useRef<CommandOrder | null>(null)
  /** Without engine tools: what is sent while an `inOrder` work is out waits behind it, in order. */
  const holding = useRef<Promise<unknown> | null>(null)
  const ordered = useCallback(<R,>(work: () => Promise<R>, hold = false): Promise<R> => {
    if (order.current) return order.current(work, hold)
    const before = holding.current
    if (!before && !hold) return work()
    const done = before ? before.then(() => work()) : work()
    const tail: Promise<unknown> = done.catch(() => undefined)
    holding.current = tail
    void tail.then(() => {
      if (holding.current === tail) holding.current = null
    })
    return done
  }, [])
  /**
   * Runs `work` in the order of the person's input: after the tool events and commands sent before
   * it, and before everything sent after it, which waits until `work` is done. A key whose effect
   * needs an engine answer first (whether its shortcut can run now) is decided here, so it never
   * acts after keys pressed later. A command `work` runs passes `inOrder: true` (`KitRunOptions`).
   */
  const inOrder = useCallback(<R,>(work: () => Promise<R>) => ordered(work, true), [ordered])

  /** Runs an engine command now (see `run`). */
  const runNow = useCallback(
    async (command: string, params: Record<string, unknown>, damage: RasterRect | null, options: KitRunOptions) => {
      const open = docRef.current
      if (!open) return null
      const before = options.skipUnchangedPaint ? { revision: open.info.revision, inspected: JSON.stringify(open.info.inspected) } : null
      const result = await open.execute(command, params, options.origin, options.agent)
      if (docRef.current === open) {
        if (open.closed) {
          open.dispose()
          docRef.current = null
          setDoc(null)
          setInfo(null)
          setState(null)
          setDirty(false)
          setConflict(false)
          return result
        }
        const mode = options.refresh ?? 'all'
        const unchanged = before != null && open.info.revision === before.revision && JSON.stringify(open.info.inspected) === before.inspected
        if (mode === 'all') refresh(unchanged ? NOTHING : damage)
        else if (mode === 'repaint') repaints.bump(damage)
      }
      return result
    },
    [refresh, repaints],
  )

  /**
   * Runs an engine command, after the tool events still waiting (`orderCommands`); throws when
   * the engine refuses it. `damage` limits the repaint, and `refresh` what the editor refreshes
   * afterwards (see `KitRefresh`).
   */
  const run = useCallback(
    async (command: string, params: Record<string, unknown> = {}, damage: RasterRect | null = null, options: KitRunOptions = {}) => {
      if (!docRef.current) return null
      if (options.inOrder) return track(runNow(command, params, damage, options))
      return track(ordered(() => runNow(command, params, damage, options)))
    },
    [ordered, runNow, track],
  )

  /**
   * Calls an engine tool method (the engine-tools capability). A call that changed the document
   * repaints it; a settled one that changed nothing (a click that only selects) refreshes the
   * editor's state without repainting.
   */
  const tool = useCallback(async <R,>(name: KitToolMethod, args: unknown[] = [], settled = false) => {
    const open = docRef.current
    if (!open) return null
    const before = open.info.revision
    const { value, changed } = await track(open.tool<R>(name, args, settled))
    // An answer that names the area it changed (`damage`: a caret moved) repaints only that area.
    if (docRef.current === open && changed) refresh(open.info.revision === before ? NOTHING : toolDamage(value))
    return value
  }, [refresh, track])
  if (!COMMAND_ORDER.has(tool)) COMMAND_ORDER.set(tool, order)

  const commands = useCallback(async () => (docRef.current ? docRef.current.commands() : []), [])
  /** The commands the engine refuses now, asked after the tool events still waiting (`ordered`), as `run` is. */
  const disabledCommands = useCallback(async () => ordered(async () => (docRef.current ? docRef.current.disabledCommands() : [])), [ordered])

  /**
   * Writes the document back to its workspace file. The bytes are taken after the commands and
   * tool events still on their way (`ordered`), so they hold everything done before Save.
   */
  const viewStateRef = useRef(options.viewState)
  viewStateRef.current = options.viewState
  /** Saves; with `checkpoint`, records one with the replica write and answers it (`null` when none was). */
  const saveWith = useCallback(async (checkpoint?: KitCheckpointRequest): Promise<KitCheckpoint | null> => {
    const open = docRef.current
    if (!open) return null
    if (readOnly) throw new ReadOnlyError('Save')
    setSaving(true)
    busyRef.current = true
    try {
      // A file changed on disk since it was read or written is never replaced unseen (an autosave
      // could otherwise run before the check that follows the file): the person decides first.
      const known = stampRef.current
      const now = known ? await host.stamp(path).catch(() => null) : null
      if (known && now && now !== known) {
        setConflict(true)
        throw new FileChangedError(path)
      }
      const { bytes, replica, revision } = await ordered(async () => (host.replicaWrite ? open.saveWithReplica() : { ...(await open.serialize()), replica: null }))
      let recorded: KitCheckpoint | null = null
      const view = viewStateRef.current?.()
      stampRef.current = await writeWithReplica(host, path, bytes, replica, known, {
        ...(checkpoint ? { checkpoint, recorded: (answer: KitCheckpoint | null) => void (recorded = answer) } : {}),
        ...(view !== undefined ? { viewState: view } : {}),
      })
      // Only a file that reached the disk counts as saved, and only if nothing changed since the
      // bytes were taken: the engine compares `revision` in order with the edits sent before.
      if (docRef.current === open) await open.markSaved(revision)
      setConflict(false)
      refresh()
      return recorded
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }, [host, ordered, path, readOnly, refresh])
  /** Writes the document back to its workspace file. */
  const save = useCallback(async () => {
    await saveWith()
  }, [saveWith])
  /**
   * Saves and records a checkpoint of the version saved (a "saved version" the person named), in
   * the same replica write (Kit UI protocol section 7m), at the version taken with the saved bytes
   * (UI-R6): an edit made while the writes are pending is not in it. Answers it; `null` when the
   * host keeps no checkpoints (the file is saved all the same).
   */
  const saveCheckpoint = useCallback((checkpoint: KitCheckpointRequest = {}) => saveWith(checkpoint), [saveWith])

  /** The document's replica, for the host's `replica/*` (only when the host keeps replicas). */
  const replica = useMemo(() => {
    const opened = () => {
      if (!docRef.current) throw new Error('the document is still opening')
      return docRef.current
    }
    return {
      version: () => opened().replicaVersion(),
      exportChanges: (since: ArrayBuffer) => opened().replicaExport(since),
      importChanges: async (changes: ArrayBuffer, blobs: ArrayBuffer) => {
        const open = opened()
        const damage = await open.replicaImport(changes, blobs)
        if (docRef.current === open) refresh()
        return damage
      },
      /** Writes a stored state (a checkpoint's) over the document, one step of the person's undo (`replica/restore`). */
      restore: (snapshot: ArrayBuffer, blobs: ArrayBuffer, origin: RestoreOrigin) =>
        ordered(async () => {
          const open = opened()
          if (readOnly) throw new ReadOnlyError('the restore')
          try {
            return await open.replicaRestore(snapshot, blobs, origin)
          } finally {
            if (docRef.current === open) refresh()
          }
        }),
      docId: () => opened().replicaDocId(),
    }
  }, [ordered, readOnly, refresh])

  /**
   * The object model answered by the kit (`kitModel.ts`), for the host's `model/*`: a batch runs
   * after the tool events still waiting, and repaints what it changed.
   */
  const model = useMemo(() => {
    const opened = () => {
      if (!docRef.current) throw new Error('the document is still opening')
      return docRef.current
    }
    return {
      describe: () => opened().modelDescribe(),
      /** The replica's version (C3b), after the commands still on their way. */
      version: () => ordered(() => opened().modelVersion()),
      /** What changed since the version `since`, after the commands still on their way (C3b). */
      changes: (since: string) => ordered(() => opened().modelChanges(since)),
      batch: (request: Record<string, unknown>) =>
        ordered(async () => {
          const open = opened()
          try {
            return await open.modelBatch(request)
          } finally {
            if (docRef.current === open) refresh()
          }
        }),
    }
  }, [ordered, refresh])

  /**
   * An agent's draft of the document (Kit UI protocol section 7d): `open` starts a second engine
   * on a fork of the document's replica, `merge` takes the draft's changes into the document as one
   * undo step, and `compare` says what merging them would change. The draft engine is the caller's
   * to dispose of.
   */
  const draft = useMemo(() => {
    const opened = () => {
      if (!docRef.current) throw new Error('the document is still opening')
      return docRef.current
    }
    return {
      open: () =>
        ordered(async () => {
          const open = opened()
          if (readOnly) throw new ReadOnlyError('a draft')
          // The version first: it makes the replica of an engine that makes it lazily. An edit that
          // lands between the two is in both the draft and the document, and merges as a no-op.
          const base = await open.replicaVersion()
          const { bytes, replica } = await open.saveWithReplica()
          if (!replica) throw new Error("the kit's engine keeps no replica to draft on")
          const name = path.split('/').filter(Boolean).pop() || path
          const owned = bytes.slice().buffer as ArrayBuffer
          const engine = await KitEngine.open(manifest, name, owned, host.lend?.(path) ?? null, { stored: replica, follow: true }, false)
          return { engine, base }
        }),
      merge: (changes: ArrayBuffer, blobs: ArrayBuffer, origin: Origin) =>
        ordered(async () => {
          const open = opened()
          try {
            return await open.replicaMerge(changes, blobs, origin)
          } finally {
            if (docRef.current === open) refresh()
          }
        }),
      compare: (changes: ArrayBuffer) => opened().replicaCompare(changes),
    }
  }, [host, manifest, ordered, path, readOnly, refresh])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])

  /**
   * The file is now `stamp`, and the document already holds it (the host's `document/held`: a
   * co-editor saved a state this replica has): it becomes the stamp the document last saw, so no
   * conflict is raised for it, and one raised for it already clears. Unsaved edits stay unsaved.
   */
  const holdFile = useCallback(
    async (stamp: string) => {
      if (!stamp) return
      stampRef.current = stamp
      const now = await host.stamp(path).catch(() => null)
      if (now === stamp) setConflict(false)
    },
    [host, path],
  )

  /** Keeps the unsaved edits; the next save (once this settles) replaces the newer file. */
  const keepMine = useCallback(async () => {
    setConflict(false)
    const stamp = await host.stamp(path).catch(() => null)
    if (stamp) stampRef.current = stamp
  }, [host, path])

  const repaintView: KitRepaints = useMemo(() => {
    const view = { get: repaints.get, subscribe: repaints.subscribe }
    REPAINT_STORES.set(view, repaints)
    return view
  }, [repaints])

  return { path, manifest, doc, info, state, change, repaints: repaintView, dirty, failure, openMs, saving, conflict, run, tool, commands, disabledCommands, inOrder, save, saveCheckpoint, replica, model, draft, reopen, keepMine, checkFile, holdFile }
}
