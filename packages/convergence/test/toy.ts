/**
 * A toy contract 2 kit in TypeScript (notes on a board, in a list and an outline tree, with text
 * and pictures) and its adapter: the twin of the Rust suite's `tests/toy.rs`, command for command
 * and random draw for random draw, so the two runners can be compared on it. Actors, the document
 * id, and object ids are deterministic (counters reset by `create`), as they are in the Rust toy.
 */
import { createHash } from 'node:crypto'
import { parseSchema, Replica, system, type ObjectId, type Origin, type Tx } from '@kition/kdm'
import { kitEngineClass, type KitModel } from '@kition/kit-engine'
import { decodeBlobBundle, encodeBlobBundle, KitEngineAdapter, utf16Index, type Blobs, type EngineDocument, type Rng, type Script } from '../src/index'

export const SCHEMA = `{
  "kdm": 1, "kit": "kit.notes", "schemaVersion": 1, "root": "Board",
  "types": {
    "Board": { "fields": {
      "notes": { "kind": "list", "of": "Note" },
      "outline": { "kind": "tree", "of": "Note" }
    } },
    "Note": { "fields": {
      "x": { "kind": "number" },
      "color": { "kind": "string" },
      "body": { "kind": "text" },
      "picture": { "kind": "blob", "optional": true }
    } }
  }
}`

const schema = parseSchema(JSON.parse(SCHEMA))
const BOARD = 'board'
/** Every toy document has this id, so both runners' states match. */
const DOC_ID = '0190f5c2-0000-7000-8000-000000000001'

/** Ids and actors, deterministic: `create` restarts both. */
const counters = { object: 0, actor: 0n }
const nextId = () => {
  counters.object += 1
  return `note-${counters.object}`
}
const nextActor = () => {
  counters.actor += 1n
  return counters.actor
}

/** The broken variant: the repair does nothing. */
export const broken = { repair: false }

export type Notes = { notes: Array<[ObjectId, string]>; blobs: Blobs }

function load(replica: Replica): Array<[ObjectId, string]> {
  return replica.list(BOARD, 'notes').filter((id) => replica.exists(id)).map((id) => [id, replica.text(id, 'body')])
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The toy's commands, each one transaction. */
function command(view: Notes, replica: Replica, id: string, params: Record<string, unknown>, origin: Origin): unknown {
  const target = String(params.id ?? '')
  const write = (f: (tx: Tx) => void) => replica.transact(origin, f)
  switch (id) {
    case 'note.set':
      return write((tx) => tx.set(target, String(params.field), params.value))
    case 'note.create':
      return write((tx) => {
        const note = tx.create('Note', { x: 0, color: 'new' }, { id: nextId() })
        tx.listInsert(BOARD, 'notes', view.notes.length, note)
        tx.treeCreate(BOARD, 'outline', null, note)
      })
    case 'note.delete':
      return write((tx) => {
        const index = tx.listItems(BOARD, 'notes').indexOf(target)
        tx.delete(target)
        // The list entry stays when the repair is broken: the delete relies on it.
        if (index >= 0 && !broken.repair) tx.listRemove(BOARD, 'notes', index)
      })
    case 'note.duplicate':
      return write((tx) => {
        const note = tx.create('Note', { x: tx.get(target, 'x'), color: tx.get(target, 'color') }, { id: nextId() })
        tx.listInsert(BOARD, 'notes', 0, note)
      })
    case 'note.reorder':
      return write((tx) => tx.listMove(BOARD, 'notes', Number(params.from), tx.listItems(BOARD, 'notes').length - 1))
    case 'note.reparent':
      return write((tx) => {
        const tree = tx.tree(BOARD, 'outline')
        const node = (object: unknown) => tree.find((entry) => entry.object === object)?.node
        const child = node(params.child)
        const parent = node(params.parent)
        if (child && parent) tx.treeMove(BOARD, 'outline', child, parent)
      })
    case 'text.insert':
      return write((tx) => tx.textInsert(target, 'body', utf16Index(tx.text(target, 'body'), Number(params.at)), String(params.text)))
    case 'text.delete':
      return write((tx) => {
        const text = tx.text(target, 'body')
        const start = utf16Index(text, Number(params.at))
        tx.textDelete(target, 'body', start, utf16Index(text, Number(params.at) + Number(params.len)) - start)
      })
    case 'note.picture': {
      const bytes = new TextEncoder().encode(String(params.bytes))
      const hash = sha256(bytes)
      view.blobs.set(hash, bytes)
      return write((tx) => tx.set(target, 'picture', { hash, mime: 'image/png', size: bytes.length }))
    }
    default:
      throw new Error(`the toy has no command ${id}`)
  }
}

export const notesModel: KitModel<Notes> = {
  schema,
  load: (replica) => ({ notes: load(replica), blobs: new Map() }),
  apply(view, replica) {
    view.notes = load(replica)
    return { kind: 'full' }
  },
  command,
  commands: () => [],
  validate(tx) {
    if (broken.repair) return false
    let wrote = false
    const items = tx.listItems(BOARD, 'notes')
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const id = items[index]
      if (!tx.exists(id) || items.slice(0, index).includes(id)) {
        tx.listRemove(BOARD, 'notes', index)
        wrote = true
      }
    }
    return wrote
  },
  import(_name, _bytes, actor) {
    return Replica.createWith(schema, DOC_ID, actor, system('create'), (tx) => {
      tx.create('Board', {}, { id: BOARD })
      const seeds: Array<[number, string, string]> = [[1, 'red', 'hello'], [2, 'blue', 'world'], [3, 'green', 'notes']]
      seeds.forEach(([x, color, body], index) => {
        const id = tx.create('Note', { x, color }, { id: nextId() })
        tx.textInsert(id, 'body', 0, body)
        tx.listInsert(BOARD, 'notes', index, id)
        tx.treeCreate(BOARD, 'outline', null, id)
      })
    }).replica
  },
  export: (view) => new TextEncoder().encode(JSON.stringify(view.notes.map(([, body]) => body))),
  blobs: (view) => encodeBlobBundle(view.blobs),
  addBlobs(view, _replica, bundle) {
    for (const [hash, bytes] of decodeBlobBundle(bundle)) view.blobs.set(hash, bytes)
  },
}

export const NotesDocument = kitEngineClass(notesModel, { actor: nextActor })

type Doc = EngineDocument<Notes>

const ids = (doc: Doc) => doc.session.view.notes.map(([id]) => id)

/**
 * The adapter. `wholeDocumentUndo` is a broken variant whose undo restores the imported values of
 * every note (and so reverts others' later changes). `recorded` collects the SHA-256 of every
 * state the suite reads, for the cross-check with the Rust runner.
 */
export class NotesKit extends KitEngineAdapter<Notes> {
  readonly recorded: string[] = []

  constructor(private readonly wholeDocumentUndo = false) {
    super({ name: 'kit.notes', schema: SCHEMA, model: notesModel, documentClass: NotesDocument, actor: nextActor, fileName: 'board.notes' })
  }

  create(): Doc {
    counters.object = 0
    counters.actor = 0n
    return NotesDocument.open('board.notes', new Uint8Array(0)) as Doc
  }

  override state(doc: Doc): unknown {
    this.recorded.push(createHash('sha256').update(doc.session.replica.stateText()).digest('hex'))
    return super.state(doc)
  }

  override undo(doc: Doc): boolean {
    if (!this.wholeDocumentUndo) return super.undo(doc)
    // Broken on purpose: puts every note's x back to its imported value.
    const done = doc.canUndo()
    ids(doc).forEach((id, index) => {
      this.run(doc, 'note.set', { id, field: 'x', value: index + 1 })
      this.run(doc, 'note.set', { id, field: 'color', value: 'reset' })
    })
    return done
  }

  private probe(doc: Doc): ObjectId {
    const first = ids(doc)[0]
    if (first === undefined) throw new Error('no note')
    return first
  }

  randomEdit(doc: Doc, rng: Rng): string | null {
    const notes = ids(doc)
    const target = rng.pick(notes)
    if (target === undefined) {
      this.script(doc, { kind: 'Create' })
      return 'create'
    }
    const value = rng.below(1000)
    let step: Script
    const pick = rng.below(7)
    if (pick === 0) step = { kind: 'Create' }
    else if (pick === 1 && notes.length > 1) step = { kind: 'Delete' }
    else if (pick === 2) step = { kind: 'Reorder', which: rng.below(2) }
    else if (pick === 3) step = { kind: 'InsertBlob', seed: value }
    else if (pick === 4) {
      const length = Array.from(doc.session.view.notes[0]?.[1] ?? '').length
      step = { kind: 'InsertText', at: rng.below(length + 1), text: `t${value}` }
    } else {
      const field = rng.chance(50) ? 'x' : 'color'
      this.run(doc, 'note.set', { id: target, field, value: field === 'x' ? value : `c${value}` })
      return `set ${field}`
    }
    return this.script(doc, step) ? step.kind : null
  }

  override script(doc: Doc, step: Script): boolean {
    const notes = ids(doc)
    switch (step.kind) {
      case 'SetField': {
        const [field, value] = step.slot === 0 ? ['x', step.value] : ['color', `c${step.value}`]
        this.run(doc, 'note.set', { id: this.probe(doc), field, value })
        return true
      }
      case 'Create':
        this.run(doc, 'note.create', {})
        return true
      case 'Delete':
        this.run(doc, 'note.delete', { id: this.probe(doc) })
        return true
      case 'Duplicate':
        this.run(doc, 'note.duplicate', { id: this.probe(doc) })
        return true
      case 'Reorder':
        if (notes.length >= 2) this.run(doc, 'note.reorder', { from: step.which % notes.length })
        return true
      case 'Reparent': {
        if (notes.length < 2) return true
        const [child, parent] = step.which === 0 ? [notes[0], notes[1]] : [notes[1], notes[0]]
        this.run(doc, 'note.reparent', { child, parent })
        return true
      }
      case 'InsertText':
        this.run(doc, 'text.insert', { id: this.probe(doc), at: step.at, text: step.text })
        return true
      case 'DeleteText':
        this.run(doc, 'text.delete', { id: this.probe(doc), at: step.at, len: step.len })
        return true
      case 'InsertBlob':
        this.run(doc, 'note.picture', { id: this.probe(doc), bytes: `picture ${step.seed}` })
        return true
      default:
        return false
    }
  }

  text(doc: Doc): string {
    return doc.session.view.notes[0]?.[1] ?? ''
  }

  checkView(doc: Doc): void {
    const fresh = load(doc.session.replica)
    if (JSON.stringify(fresh) !== JSON.stringify(doc.session.view.notes)) throw new Error('the view differs from the replica')
  }
}
