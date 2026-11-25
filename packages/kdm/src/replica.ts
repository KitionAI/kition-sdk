/**
 * A read-only replica of a document (plan 2026-11-24, section 4). The Rust KDM is the only writer:
 * a replica here loads its content or a snapshot, follows the changes it exports, in order, and
 * reads objects with the same answers as the Rust `Replica`.
 */
import { canonical, canonicalText, compareKeys } from './canonical'
import { docIdOf, parseChangeList } from './change'
import { decodeContent, type Content } from './content'
import { errors, KdmError } from './errors'
import { nodeOf, type NodeRef, type ObjectId, type TreeEntry } from './ids'
import { readJson } from './json'
import type { TextRun } from './marks'
import { pushRun } from './marks'
import { fieldDef, hasMarks, KDM_VERSION, typeDef, type Expand, type FieldDef, type FieldKind, type Schema } from './schema'
import { opObjects, Store, StoredObject, TYPE_KEY, type Field, type Undo } from './store'
import type { Text } from './text'
import type { JsonValue } from './value'
import { Version } from './version'

/** What an import answers for changes of another line; the Rust crate says the same. */
const OTHER_LINE = "the changes continue another line of changes (another replica's history)"
/** What an import answers for changes that went another way from the same version; the Rust crate says the same. */
const DIVERGED = "the changes went another way from this replica's version"
/** The changes whose actors a replica remembers, to tell a change it has from another of the same number. */
const ACTORS_KEPT = 10_000

const isRecord = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkString(what: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new KdmError('invalid-value', `${what} must be a string, not ${value === null ? 'null' : typeof value}`)
}

/** The store of `content`, checked against `schema` (the Rust `Replica::checked_store`). */
function checkedStore(schema: Schema, content: Content): Store {
  if (content.kit !== schema.kit) throw errors.schema(`the document belongs to "${content.kit}", not \`${schema.kit}\``)
  if (content.schemaVersion > schema.schemaVersion) throw errors.newerSchema(content.schemaVersion, schema.schemaVersion)
  const store = Store.fromContent(content, schema)
  checkProjectedStorage(store, schema)
  return store
}

/** Refuses projected objects, and projected membership, in a stored document. */
function checkProjectedStorage(store: Store, schema: Schema): void {
  const projected = (ty: string | undefined) => ty !== undefined && Object.hasOwn(schema.types, ty) && schema.types[ty].projected === true
  if (!Object.values(schema.types).some((def) => def.projected)) return
  for (const object of store.objects.values()) {
    if (!Object.hasOwn(schema.types, object.ty)) continue
    const def = schema.types[object.ty]
    if (def.projected) throw errors.invalidValue(object.ty, '$type', 'projected objects are computed by the kit, never stored')
    for (const [name, field] of Object.entries(def.fields)) {
      if (projected(field.of) && object.fields.has(name)) throw errors.invalidValue(object.ty, name, 'projected membership is computed by the kit, never stored')
    }
  }
}

/** A stored object's state, comparable with `===`. */
function objectText(object: StoredObject): string {
  const fields: Record<string, unknown> = { [TYPE_KEY]: object.ty }
  for (const [name, field] of object.fields) {
    switch (field.kind) {
      case 'value':
        fields[name] = field.value
        break
      case 'text':
        fields[name] = field.text.pieces()
        break
      case 'list':
        fields[name] = field.items
        break
      case 'map':
        fields[name] = Object.fromEntries(field.entries)
        break
      case 'tree':
        fields[name] = field.tree.preorder()
        break
    }
  }
  return canonicalText(fields)
}

export class Replica {
  private store: Store
  private lineage: string | null
  private seq: number
  /** The actor of each change this replica applied, by its number (the newest `ACTORS_KEPT`). */
  private actors = new Map<number, string>()

  private constructor(
    readonly schema: Schema,
    store: Store,
    version: Version,
  ) {
    this.store = store
    this.lineage = version.lineage
    this.seq = version.seq
  }

  /**
   * Opens content (a file's `content.json`; its version is empty, and only a snapshot imports
   * next) or a snapshot (the version it holds). Refuses (`schema`) a document of another kit or
   * of another KDM version, (`newer-schema`) one whose minimum schema version (rule M20) is newer
   * than `schema`'s, and (`encoding`) bytes that are not content.
   */
  static load(schema: Schema, bytes: Uint8Array): Replica {
    const value = readJson(bytes, 'not KDM content')
    if (isRecord(value) && value.changes !== undefined) throw errors.encoding('not a snapshot: these are changes only (load a snapshot or content)')
    const content = decodeContent(value)
    const store = checkedStore(schema, content)
    const version = content.version ? Version.at(content.version.lineage, content.version.seq) : Version.empty()
    return new Replica(schema, store, version)
  }

  get docId(): string {
    return this.store.docId
  }

  get kit(): string {
    return this.store.kit
  }

  version(): Version {
    return this.lineage === null ? Version.empty() : Version.at(this.lineage, this.seq)
  }

  /** The document's minimum schema version (rule M20). */
  minSchemaVersion(): number {
    return this.store.schemaVersion
  }

  /**
   * Applies changes or a snapshot the Rust KDM exported and answers the objects whose state
   * changed, sorted (the Rust `Replica::import_changes`).
   *
   * Changes: those this replica has already are skipped, so importing twice is harmless; the first
   * new one must follow this replica's version, else `stale` and nothing changes, as when an
   * operation's precondition does not hold. A snapshot replaces the state when it is on this
   * replica's line and not behind it (or when this replica has applied no change yet), else
   * `stale`. Bytes that are neither are `encoding`; another document's are `wrong-document`;
   * changes that raise the minimum schema version above this replica's schema are
   * `newer-schema`. A refused import changes nothing.
   */
  importChanges(bytes: Uint8Array): ObjectId[] {
    const value = readJson(bytes, 'not KDM changes')
    const docId = docIdOf(value)
    if (docId !== this.store.docId) throw errors.wrongDocument(this.store.docId, docId)
    const record = value as Record<string, JsonValue>
    if (record.changes !== undefined) return this.importChangeList(record)
    if (record.objects !== undefined) return this.importSnapshot(record)
    throw errors.encoding('not KDM changes: neither changes nor a snapshot')
  }

  private importChangeList(value: Record<string, JsonValue>): ObjectId[] {
    const list = parseChangeList(value, this.schema)
    if (list.lineage !== this.lineage) throw errors.stale(OTHER_LINE)
    if (list.after > this.seq) throw errors.stale(`the changes follow version ${list.after}; this replica is at ${this.seq}`)
    const mine = this.actors.get(list.after)
    if (list.afterActor !== null && mine !== undefined && mine !== list.afterActor) throw errors.stale(DIVERGED)
    const start = this.seq
    const undos: Undo[] = []
    const applied: number[] = []
    const changed = new Set<ObjectId>()
    const expandOf = (ty: string, field: string, key: string): Expand | undefined => {
      if (!Object.hasOwn(this.schema.types, ty)) return undefined
      const def = this.schema.types[ty].fields
      return Object.hasOwn(def, field) ? def[field].marks?.[key]?.expand : undefined
    }
    try {
      for (const change of list.changes) {
        if (change.seq <= this.seq) {
          const held = this.actors.get(change.seq)
          if (held !== undefined && held !== change.actor) throw errors.stale(DIVERGED)
          continue
        }
        if (change.seq !== this.seq + 1) throw errors.stale(`change ${change.seq} does not follow version ${this.seq}`)
        for (const op of change.ops) {
          const owners = op.op === 'delete' ? this.store.treeOwners(op.id) : []
          undos.push(this.store.apply(op, expandOf))
          for (const id of opObjects(op)) changed.add(id)
          for (const id of owners) changed.add(id)
        }
        this.seq = change.seq
        this.actors.set(change.seq, change.actor)
        applied.push(change.seq)
      }
      if (this.store.schemaVersion > this.schema.schemaVersion) throw errors.newerSchema(this.store.schemaVersion, this.schema.schemaVersion)
      checkProjectedStorage(this.store, this.schema)
    } catch (error) {
      for (const undo of undos.reverse()) undo()
      for (const seq of applied) this.actors.delete(seq)
      this.seq = start
      throw error
    }
    for (const seq of this.actors.keys()) {
      if (this.actors.size <= ACTORS_KEPT) break
      this.actors.delete(seq)
    }
    return [...changed].sort(compareKeys)
  }

  private importSnapshot(value: Record<string, JsonValue>): ObjectId[] {
    const content = decodeContent(value)
    const version = content.version
    if (!version) throw errors.stale('content without a version continues no line of changes')
    const fresh = this.seq === 0 && this.actors.size === 0
    if (!(fresh || (version.lineage === this.lineage && version.seq >= this.seq))) {
      throw errors.stale(`the snapshot is not ahead of this replica on its line (it is at ${version.seq})`)
    }
    if (version.lineage === this.lineage && version.seq === this.seq) return []
    const store = checkedStore(this.schema, content)
    const changed = new Set<ObjectId>()
    for (const [id, object] of this.store.objects) {
      const next = store.objects.get(id)
      if (!next || objectText(next) !== objectText(object)) changed.add(id)
    }
    for (const id of store.objects.keys()) if (!this.store.objects.has(id)) changed.add(id)
    this.store = store
    this.lineage = version.lineage
    this.seq = version.seq
    this.actors = new Map()
    return [...changed].sort(compareKeys)
  }

  exists(id: ObjectId): boolean {
    checkString('an object id', id)
    return this.store.objects.has(id)
  }

  objectType(id: ObjectId): string {
    checkString('an object id', id)
    const object = this.store.objects.get(id)
    if (!object) throw errors.notFound(id)
    return object.ty
  }

  /** The object and field `field` of `id`, checked against the schema to be of `kind` (`null`: a register). */
  private field(id: ObjectId, field: string, kind: FieldKind | null): { object: StoredObject; def: FieldDef; held: Field | undefined } {
    checkString('an object id', id)
    checkString('a field name', field)
    const object = this.store.objects.get(id)
    if (!object) throw errors.notFound(id)
    const def = fieldDef(this.schema, object.ty, field)
    if (kind === null) {
      if (def.kind === 'text' || def.kind === 'list' || def.kind === 'map' || def.kind === 'tree') {
        throw errors.invalidValue(object.ty, field, 'is a container; read it with its accessor')
      }
    } else if (def.kind !== kind) throw errors.invalidValue(object.ty, field, `is not a ${kind} field`)
    const held = object.fields.get(field)
    if (held && kind !== null && held.kind !== kind) throw errors.engine(`${id}.${field} holds the wrong kind of value`)
    return { object, def, held }
  }

  get(id: ObjectId, field: string): unknown {
    const { held } = this.field(id, field, null)
    return held?.kind === 'value' ? canonical(held.value) : null
  }

  private textOf(id: ObjectId, field: string): { text: Text | null; def: FieldDef } {
    const { held, def } = this.field(id, field, 'text')
    return { text: held?.kind === 'text' ? held.text : null, def }
  }

  text(id: ObjectId, field: string): string {
    return this.textOf(id, field).text?.string() ?? ''
  }

  /**
   * A text field as runs of characters with equal marks (rule M19), in order: adjacent runs differ
   * in their marks, no run is empty, and only the field's declared marks appear. A field that
   * declares no marks reads as one unmarked run (none when empty). Positions here are UTF-16 code
   * units (`insert.length`).
   */
  textDelta(id: ObjectId, field: string): TextRun[] {
    const { text, def } = this.textOf(id, field)
    return text ? runsOf(text, def) : []
  }

  /** The length of a text field in UTF-16 code units. */
  textLength(id: ObjectId, field: string): number {
    return this.text(id, field).length
  }

  list(id: ObjectId, field: string): ObjectId[] {
    const { held } = this.field(id, field, 'list')
    return held?.kind === 'list' ? [...held.items] : []
  }

  /** One key of a map field, or `null`. */
  mapGet(id: ObjectId, field: string, key: string): unknown {
    checkString('a map key', key)
    const { held } = this.field(id, field, 'map')
    return held?.kind === 'map' && held.entries.has(key) ? canonical(held.entries.get(key)) : null
  }

  /** A map field's keys and values, sorted by key (code point order, as in the canonical state). */
  mapEntries(id: ObjectId, field: string): Array<[string, unknown]> {
    const { held } = this.field(id, field, 'map')
    if (held?.kind !== 'map') return []
    return [...held.entries.keys()].sort(compareKeys).map((key) => [key, canonical(held.entries.get(key))])
  }

  /**
   * The tree's nodes in pre-order (each parent before its children, siblings in order). A node
   * naming an object the document does not hold is skipped with its subtree, as in `stateJson`.
   */
  tree(id: ObjectId, field: string): TreeEntry[] {
    const { held } = this.field(id, field, 'tree')
    if (held?.kind !== 'tree') return []
    const out: TreeEntry[] = []
    const tree = held.tree
    const stack: Array<{ node: ObjectId; parent: NodeRef | null }> = [...tree.children(null)].reverse().map((node) => ({ node, parent: null }))
    while (stack.length) {
      const { node, parent } = stack.pop()!
      if (!this.store.objects.has(node)) continue
      const ref = nodeOf(node)
      out.push({ node: ref, object: node, parent })
      const children = tree.children(node)
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], parent: ref })
    }
    return out
  }

  /** Ids of the objects of type `ty`, sorted. One pass over the objects. */
  objectsOfType(ty: string): ObjectId[] {
    checkString('a type name', ty)
    const out: ObjectId[] = []
    for (const [id, object] of this.store.objects) if (object.ty === ty) out.push(id)
    return out.sort(compareKeys)
  }

  /** The whole document in canonical form (`{meta, objects}`), as the Rust `state_json`; see `stateText`. */
  stateJson(): unknown {
    const objects: Record<string, unknown> = {}
    for (const id of [...this.store.objects.keys()].sort(compareKeys)) objects[id] = this.objectJson(id)
    return {
      meta: { docId: this.store.docId, kdm: KDM_VERSION, kit: this.store.kit, schemaVersion: this.store.schemaVersion },
      objects,
    }
  }

  /** The canonical state as text; equal to the Rust `state_json().to_string()` for the same document. */
  stateText(): string {
    return canonicalText(this.stateJson())
  }

  /** One object in canonical form: `$type` and every schema field (an object of a type the schema does not declare: its `$type` only). */
  private objectJson(id: ObjectId): Record<string, unknown> {
    const object = this.store.objects.get(id) as StoredObject
    const out: Record<string, unknown> = { [TYPE_KEY]: object.ty }
    if (!Object.hasOwn(this.schema.types, object.ty)) return out
    const def = typeDef(this.schema, object.ty)
    for (const name of Object.keys(def.fields)) {
      const field = def.fields[name]
      const held = object.fields.get(name)
      let value: unknown
      switch (field.kind) {
        case 'text': {
          const text = held?.kind === 'text' ? held.text : null
          value = hasMarks(field) ? (text ? runsOf(text, field) : []) : (text?.string() ?? '')
          break
        }
        case 'list':
          value = held?.kind === 'list' ? [...held.items] : []
          break
        case 'tree':
          value = held?.kind === 'tree' ? held.tree.toJson((node) => this.store.objects.has(node)) : []
          break
        case 'map':
          value = held?.kind === 'map' ? Object.fromEntries(held.entries) : {}
          break
        default:
          value = held?.kind === 'value' ? held.value : null
      }
      Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true })
    }
    return out
  }
}

/** The runs of a text as field `def` reads them: only its declared marks; one unmarked run for a field that declares none. */
function runsOf(text: Text, def: FieldDef): TextRun[] {
  const out: TextRun[] = []
  if (!hasMarks(def)) {
    pushRun(out, text.string(), undefined)
    return out
  }
  const declared = def.marks ?? {}
  for (const piece of text.pieces()) {
    let attributes: Record<string, JsonValue> | undefined
    for (const key of Object.keys(piece.attributes)) {
      if (!Object.hasOwn(declared, key)) continue
      attributes ??= {}
      Object.defineProperty(attributes, key, { value: canonical(piece.attributes[key]), enumerable: true, writable: true, configurable: true })
    }
    pushRun(out, piece.insert, attributes)
  }
  return out
}
