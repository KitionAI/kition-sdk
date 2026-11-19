/**
 * The object model over a contract 2 engine's change exchange, run in the kit's engine worker
 * (see `kitModel.ts`). Loaded on the first `model/*` request: it brings `@kition/kdm` and Loro.
 *
 * It imports no value from the worker's other modules: a bundler puts those in the worker's
 * entry chunk, and WebKit evaluates a module worker's entry script again when a chunk imports
 * it, replacing the worker's message handler with one that has no document open.
 */
import { BatchError, describeModel, diffStates, diffWithToolIds, encodeOrigin, KdmError, parseSchema, randomActor, Replica, runBatch, schemaOfDescription, Version, withLeafEdits, type BatchRequest, type BatchResult, type NodeRef, type ObjectId, type Origin, type Schema, type StateDiff, type Tx } from '@kition/kdm'
import type { ModelErrorData } from '@kition/kit-ui-protocol'
import { ToolIds } from '@kition/kdm'
import type { KitModuleDocument } from './kitModule'

const REFUSED = 'the kit refused the changes'

/** A short digest of a document's canonical state (cyrb53), to tell whether it is as a step left it. */
function digest(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}:${text.length}`
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A failure as the protocol answers it. */
export function modelErrorData(error: unknown): ModelErrorData {
  if (error instanceof BatchError) return { code: error.code, index: error.index, message: error.message }
  return { code: 'invalid-value', index: null, message: message(error) }
}

/** Runs a command of a batch as its origin, when the engine can (`executeAs`); answers its parsed result. */
export function runAs(open: KitModuleDocument, id: string, params: unknown, origin: Origin): unknown {
  const text = JSON.stringify(params ?? {})
  let answer: string
  try {
    answer = open.executeAs ? open.executeAs(id, text, encodeOrigin(origin)) : open.execute(id, text)
  } catch (error) {
    // An engine's refusal of the parameters (`kition_kit::schema::refusal`: its text, U+001E, its
    // errors as JSON; `refusal.ts`, not imported here, see above) fails the batch with its text alone.
    const at = message(error).indexOf('\u001e')
    throw at < 0 ? error : new Error(message(error).slice(0, at))
  }
  if (answer === '') return null
  try {
    return JSON.parse(answer) as unknown
  } catch {
    return answer
  }
}

/** The `Tx` writes a script step makes, by name, other than those recorded with object identities. */
const WRITES = new Set(['set', 'delete', 'textInsert', 'textDelete', 'textMark', 'textUnmark', 'listInsert', 'listMove', 'listRemove', 'mapSet', 'mapDelete'])

/**
 * One write of a script step, as it can be made again: an object the step created keeps its id,
 * and a tree node is named by the object it names (an engine step that removed and brought back
 * an object made new tree nodes).
 */
type Write =
  | { call: 'create'; type: string; fields: Record<string, unknown>; id: ObjectId }
  | { call: 'treeCreate'; id: ObjectId; field: string; parent: ObjectId | null; object: ObjectId }
  | { call: 'treeMove'; id: ObjectId; field: string; object: ObjectId; parent: ObjectId | null }
  | { call: 'write'; name: string; args: unknown[] }

/** A script step: its writes, and the objects it changed that it did not create. */
type Step = {
  origin: Origin
  writes: Write[]
  existing: ObjectId[]
  /**
   * Whether an object the step changed was gone since it was undone (an engine step removed it
   * and another brought it back): the scratch replica's own redo no longer reaches it.
   */
  stale: boolean
  /** A merged draft's changes (`ReplicaModel.merge`): made again by merging them again. */
  merge?: Uint8Array
}

/** A step in a history: the digest of the document as the step (or undoing it) left it. */
type Entry = { state: string; step: Step }

/** The object a tree node names, as `tx` sees the tree; `null` for no node (a root). */
function nodeObject(tx: Tx, id: ObjectId, field: string, node: NodeRef | null | undefined): ObjectId | null {
  if (node === null || node === undefined) return null
  const found = tx.tree(id, field).find((entry) => entry.node.equals(node))
  if (!found) throw new BatchError('not-found', null, `a node of ${id}.${field} that the tree does not hold`)
  return found.object
}

/** The node naming `object` in a tree, as `tx` sees it; `null` for none (a root). */
function objectNode(tx: Tx, id: ObjectId, field: string, object: ObjectId | null): NodeRef | null {
  if (object === null) return null
  const found = tx.tree(id, field).find((entry) => entry.object === object && tx.exists(object))
  if (!found) throw new BatchError('not-found', null, `\`${object}\` is not in ${id}.${field}`)
  return found.node
}

/** `tx`, recording each write made through it in `step`. */
function recording(tx: Tx, step: { writes: Write[]; touched: Set<ObjectId>; created: Set<ObjectId> }): Tx {
  return new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      if (prop === 'create') {
        return (type: string, fields: Record<string, unknown>, options?: { id?: string }) => {
          const id = target.create(type, fields, options)
          step.writes.push({ call: 'create', type, fields, id })
          step.created.add(id)
          return id
        }
      }
      if (prop === 'treeCreate') {
        return (id: ObjectId, field: string, parent: NodeRef | null, object: ObjectId) => {
          const parentObject = nodeObject(target, id, field, parent)
          const node = target.treeCreate(id, field, parent, object)
          step.writes.push({ call: 'treeCreate', id, field, parent: parentObject, object })
          step.touched.add(id)
          return node
        }
      }
      if (prop === 'treeMove') {
        return (id: ObjectId, field: string, node: NodeRef, parent: NodeRef | null) => {
          const object = nodeObject(target, id, field, node) as ObjectId
          const parentObject = nodeObject(target, id, field, parent)
          target.treeMove(id, field, node, parent)
          step.writes.push({ call: 'treeMove', id, field, object, parent: parentObject })
          step.touched.add(id)
        }
      }
      if (typeof prop === 'string' && WRITES.has(prop)) {
        return (...args: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, args)
          step.writes.push({ call: 'write', name: prop, args })
          step.touched.add(args[0] as ObjectId)
          return result
        }
      }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  })
}

/** Makes a step's writes again, by object identity, in one transaction of `tx`. */
function replay(tx: Tx, step: Step) {
  for (const write of step.writes) {
    switch (write.call) {
      case 'create':
        tx.create(write.type, write.fields, { id: write.id })
        break
      case 'treeCreate':
        tx.treeCreate(write.id, write.field, objectNode(tx, write.id, write.field, write.parent), write.object)
        break
      case 'treeMove':
        tx.treeMove(write.id, write.field, objectNode(tx, write.id, write.field, write.object) as NodeRef, objectNode(tx, write.id, write.field, write.parent))
        break
      default:
        ;(tx[write.name as keyof Tx] as (...args: unknown[]) => unknown).apply(tx, write.args)
    }
  }
}

/**
 * The object model of an engine that exchanges changes but does not answer it itself. A scratch
 * replica of the document (its own actor) is caught up with the engine's changes before every
 * read and write; each run of a batch's model operations is one transaction on it, whose changes
 * the engine imports. Its commands run in the engine as the batch's origin.
 *
 * The engine takes those changes as a collaborator's, outside its own undo history, so the script
 * steps are kept here: each is undone and redone through the scratch replica's own undo (which
 * keeps everything else that changed since), and the engine's Undo reaches them in order. A step
 * is the next to undo when the document is as it left it (its state's digest), or when the engine
 * has nothing left to undo; otherwise the engine's own last step goes first. The same holds for
 * Redo. An edit of the person's own drops the steps to redo.
 *
 * Each step also records its writes by object identity. When an engine step removed an object a
 * step undone had changed and another brought it back (Undo past the command that made it, then
 * Redo), the object is a new one to the scratch replica's history, which no longer reaches it:
 * Redo then makes the step's writes again, as a new transaction (whose Undo is the scratch
 * replica's again).
 */
export class ReplicaModel {
  private scratch: Replica | null = null
  private schema: Schema | null = null
  private schemaText: string | null = null
  /** The script steps to undo, each with the digest of the document as it left it, oldest first. */
  private undoSteps: Entry[] = []
  /** The steps undone, each with the digest of the document as undoing it left it, the next to redo last. */
  private redoSteps: Entry[] = []

  constructor(private readonly open: KitModuleDocument) {}

  /** Translate replies using the native model description or the host-supplied schema. */
  reply(value: unknown): unknown {
    if (!this.schema && this.open.modelDescribe) {
      // The description names a text field's marks by key (OM1), not as the schema declares them.
      try {
        this.schema = schemaOfDescription(JSON.parse(this.open.modelDescribe()) as object)
      } catch (error) {
        throw new BatchError('invalid-op', null, `the schema does not parse: ${message(error)}`)
      }
      this.forget()
    }
    return this.schema ? ToolIds.ofReplica(this.catchUp()).showJson(value) : value
  }

  canUndo(): boolean {
    return this.undoSteps.length > 0
  }

  canRedo(): boolean {
    return this.redoSteps.length > 0
  }

  /** The person edited the document: the script steps undone so far cannot be redone. */
  dropRedo() {
    if (!this.redoSteps.length) return
    this.redoSteps = []
    this.scratch?.clearRedo()
  }

  /** `model/describe`: the schema, the root's id, and the engine's commands. */
  forkForPremises(open: KitModuleDocument): ReplicaModel {
    this.reply(null)
    if (!this.schema) throw new Error('premise planning requires the object model schema')
    const copy = new ReplicaModel(open)
    copy.schema = this.schema
    copy.schemaText = this.schemaText
    return copy
  }

  /** `model/describe`: the schema, the root's id, and the engine's commands. */
  describe(schema: object | null | undefined): Record<string, unknown> {
    this.useSchema(schema)
    return { ...describeModel(this.catchUp()), commands: JSON.parse(this.open.commands()) as unknown }
  }

  /** `model/batch`. */
  async batch(request: BatchRequest, schema: object | null | undefined, readOnly: boolean): Promise<BatchResult> {
    this.useSchema(schema)
    try {
      return await runBatch(
        {
          replica: () => this.catchUp(),
          projectedObjects: () => {
            if (!this.open.premiseRead) throw new BatchError('invalid-value', null, 'this engine cannot read declared projected objects')
            return JSON.parse(this.open.premiseRead('projected', '{}'))
          },
          transact: (origin, write) => this.step(origin, write),
          command: (id, params, origin) => {
            const result = runAs(this.open, id, params, origin)
            this.dropRedo()
            return result
          },
          readOnly: () => readOnly,
        },
        request,
      )
    } catch (error) {
      // The engine has not taken what the scratch replica holds: start again from the engine.
      if (error instanceof BatchError && error.message.startsWith(REFUSED)) this.forget()
      throw error
    }
  }

  /**
   * Takes an agent's draft into the document (Kit UI protocol section 7d): its changes since it
   * was forked are merged into the scratch replica as one transaction of `origin`, which the
   * engine imports. It is a script step: the editor's Undo takes the whole merge back. Answers
   * what it changed.
   */
  merge(changes: Uint8Array, origin: Origin, schema: object | null | undefined): StateDiff {
    this.useSchema(schema)
    const replica = this.catchUp()
    const before = replica.version()
    const was = replica.stateJson()
    try {
      replica.mergeChanges(changes, origin)
    } catch (error) {
      throw new BatchError('invalid-value', null, `the draft does not merge: ${message(error)}`)
    }
    if (replica.version().equals(before)) return diffStates(was, was)
    const summary = diffStates(was, replica.stateJson())
    try {
      this.open.importChanges!(replica.exportChanges(before))
    } catch (error) {
      // The engine has not taken what the scratch replica holds: start again from the engine.
      this.forget()
      throw new BatchError('invalid-value', null, `${REFUSED}: ${message(error)}`)
    }
    this.redoSteps = []
    this.undoSteps.push({ state: this.state(), step: { origin, writes: [], existing: [], stale: false, merge: changes.slice() } })
    return summary
  }

  /**
   * What changed in the document since the replica version `since` (C3b, as Kit Process Protocol's
   * `model.changes`): the change set `@kition/kdm`'s `changesSince` answers, or no change set and
   * why when the replica's history does not hold `since` (never an empty one in its place).
   */
  changesSince(since: Uint8Array, schema: object | null | undefined): { changes: StateDiff } | { changes: null; unavailable: string } {
    this.useSchema(schema)
    const replica = this.catchUp()
    try {
      return { changes: replica.changesSince(Version.decode(since)) }
    } catch (error) {
      if (error instanceof KdmError) return { changes: null, unavailable: error.message }
      throw error
    }
  }

  checkpointForPremises() {
    const replica = this.catchUp()
    return { document: replica.docId, version: replica.version().encode(), state: replica.stateJson() }
  }

  changesForPremises(before: ReturnType<ReplicaModel['checkpointForPremises']>): StateDiff {
    const replica = this.catchUp()
    if (replica.docId === before.document) return replica.changesSince(Version.decode(before.version))
    const now = replica.stateJson()
    const diff = diffStates(before.state, now)
    delete diff.texts
    return diffWithToolIds(withLeafEdits(diff, this.schema!), this.schema!, ToolIds.ofState(this.schema!, before.state), ToolIds.ofReplica(replica))
  }

  /** What merging a draft's `changes` would change in the document now, without merging them. */
  compare(changes: Uint8Array, schema: object | null | undefined): StateDiff {
    this.useSchema(schema)
    const replica = this.catchUp()
    try {
      return diffStates(replica.stateJson(), replica.mergedState(changes))
    } catch (error) {
      throw new BatchError('invalid-value', null, `the draft does not merge: ${message(error)}`)
    }
  }

  /** Undoes the last script step when it comes before the engine's own; answers whether it did. */
  undo(engineCanUndo: boolean): boolean {
    return this.travel(this.undoSteps, this.redoSteps, engineCanUndo, (replica) => replica.undo())
  }

  /** Redoes the last script step undone when it comes before the engine's own; answers whether it did. */
  redo(engineCanRedo: boolean): boolean {
    return this.travel(this.redoSteps, this.undoSteps, engineCanRedo, (replica, step) => {
      if (!step.stale && replica.canRedo()) return replica.redo()
      try {
        if (step.merge) replica.mergeChanges(step.merge, step.origin)
        else replica.transact(step.origin, (tx) => replay(tx, step))
      } catch {
        return false
      }
      // The scratch replica's redo history is behind the steps now: the rest are made again too.
      replica.clearRedo()
      return true
    })
  }

  /**
   * The engine undid or redid a step of its own. When it removed an object a script step undone
   * had changed, the scratch replica's redo no longer reaches that object, even once it is back.
   */
  engineMoved() {
    if (!this.redoSteps.length || !this.scratch) return
    const replica = this.catchUp()
    for (const { step } of this.redoSteps) {
      if (!step.stale && step.existing.some((id) => !replica.exists(id))) step.stale = true
    }
  }

  private travel(from: Entry[], to: Entry[], engineCan: boolean, move: (replica: Replica, step: Step) => boolean): boolean {
    if (!from.length || !this.scratch) return false
    const replica = this.catchUp()
    const { state, step } = from[from.length - 1]
    if (engineCan && digest(replica.stateText()) !== state) return false
    const before = replica.version()
    if (!move(replica, step)) {
      // The scratch replica no longer holds the step (its history was cleared), or it cannot be made again.
      from.length = 0
      replica.clearRedo()
      return false
    }
    from.pop()
    if (!replica.version().equals(before)) {
      try {
        this.open.importChanges!(replica.exportChanges(before))
      } catch (error) {
        this.forget()
        throw error
      }
    }
    step.stale = false
    to.push({ state: this.state(), step })
    return true
  }

  private useSchema(raw: object | null | undefined): Schema {
    if (raw) {
      const text = JSON.stringify(raw)
      if (text !== this.schemaText) {
        try {
          this.schema = parseSchema(raw)
        } catch (error) {
          throw new BatchError('invalid-op', null, `the schema does not parse: ${message(error)}`)
        }
        this.schemaText = text
        this.forget()
      }
    }
    if (!this.schema) throw new BatchError('invalid-op', null, "the kit's engine does not describe its schema: send `schema` with the request")
    return this.schema
  }

  private forget() {
    this.scratch = null
    this.undoSteps = []
    this.redoSteps = []
  }

  private catchUp(): Replica {
    const exportChanges = this.open.exportChanges!.bind(this.open)
    if (!this.scratch) {
      this.scratch = Replica.load(this.schema!, exportChanges(new Uint8Array(0)), randomActor())
    } else {
      const changes = exportChanges(this.scratch.version().encode())
      try {
        if (changes.byteLength > 0) this.scratch.importChanges(changes)
      } catch (error) {
        if (!(error instanceof KdmError) || error.reason !== 'wrong-document') throw error
        this.forget()
        this.scratch = Replica.load(this.schema!, exportChanges(new Uint8Array(0)), randomActor())
      }
    }
    return this.scratch
  }

  private state(): string {
    return digest(this.catchUp().stateText())
  }

  /** One run of model operations: a transaction on the scratch replica, then in the engine. */
  private step(origin: Origin, write: (tx: Tx) => void) {
    const replica = this.catchUp()
    const before: Version = replica.version()
    const record = { writes: [] as Write[], touched: new Set<ObjectId>(), created: new Set<ObjectId>() }
    replica.transact(origin, (tx) => {
      record.writes = []
      record.touched.clear()
      record.created.clear()
      write(recording(tx, record))
    })
    if (replica.version().equals(before)) return
    try {
      this.open.importChanges!(replica.exportChanges(before))
    } catch (error) {
      throw new BatchError('invalid-value', null, `${REFUSED}: ${message(error)}`)
    }
    this.redoSteps = []
    const existing = [...record.touched].filter((id) => !record.created.has(id))
    this.undoSteps.push({ state: this.state(), step: { origin, writes: record.writes, existing, stale: false } })
  }
}
