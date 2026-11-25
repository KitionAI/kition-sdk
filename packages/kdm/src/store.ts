/**
 * The document in memory, as the Rust store (`crates/kition-kdm/src/store`) holds it: objects by
 * id, each with its type and the fields it holds. A field it does not hold reads as empty; a
 * container field (text, list, map, tree) exists only while it holds something.
 *
 * The store applies the operations of the changes the Rust KDM exports (`change.ts`), one at a
 * time, with the Rust `Store::apply` precondition checks and messages: a failed check is a `stale`
 * error and changes nothing. Each applied operation answers how to take it back, so a change list
 * that fails part way is taken back whole.
 */
import { canonical } from './canonical'
import { checkObjectId, type Content } from './content'
import { errors } from './errors'
import type { ObjectId } from './ids'
import type { FieldDef, Schema } from './schema'
import { sortedMarks, Text, type Marks } from './text'
import { Tree } from './tree'
import type { JsonValue } from './value'

export const TYPE_KEY = '$type'

/** One field an object holds. */
export type Field =
  | { kind: 'value'; value: JsonValue }
  | { kind: 'text'; text: Text }
  | { kind: 'list'; items: ObjectId[] }
  | { kind: 'map'; entries: Map<string, JsonValue> }
  | { kind: 'tree'; tree: Tree }

const isEmpty = (field: Field): boolean => {
  switch (field.kind) {
    case 'value':
      return field.value === null
    case 'text':
      return field.text.isEmpty()
    case 'list':
      return field.items.length === 0
    case 'map':
      return field.entries.size === 0
    case 'tree':
      return field.tree.isEmpty()
  }
}

export class StoredObject {
  readonly fields = new Map<string, Field>()
  constructor(readonly ty: string) {}

  /** Sets a field; an empty one is removed. */
  put(name: string, field: Field): void {
    if (isEmpty(field)) this.fields.delete(name)
    else this.fields.set(name, field)
  }

  /** Removes the field when it became empty. */
  settle(name: string): void {
    const field = this.fields.get(name)
    if (field && isEmpty(field)) this.fields.delete(name)
  }
}

const isRecord = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A text from its content form: a string, or runs `[{"attributes":{…},"insert":"…"}]`. */
function textFromContent(value: JsonValue, bad: () => Error): Text {
  const text = new Text()
  if (typeof value === 'string') {
    text.insert(0, value, {})
    return text
  }
  if (!Array.isArray(value)) throw bad()
  for (const run of value) {
    if (!isRecord(run) || typeof run.insert !== 'string' || !Object.keys(run).every((key) => key === 'insert' || key === 'attributes')) throw bad()
    if (run.attributes !== undefined && !isRecord(run.attributes)) throw bad()
    text.insert(text.len, run.insert, sortedMarks((run.attributes as Record<string, JsonValue> | undefined) ?? {}))
  }
  return text
}

/** A tree from its content form: `[depth, "<id>"]` pairs in pre-order, roots at depth 0. */
function treeFromContent(value: JsonValue, bad: (reason: string) => Error): Tree {
  if (!Array.isArray(value)) throw bad('a tree is an array of [depth, id] pairs')
  const tree = new Tree()
  const path: ObjectId[] = []
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'number' || !Number.isSafeInteger(pair[0]) || pair[0] < 0) throw bad('a tree node is a [depth, id] pair')
    const depth = pair[0]
    const node = checkObjectId(pair[1], 'a tree node')
    if (depth > path.length) throw bad(`a tree node at depth ${depth} follows one at depth ${path.length - 1}`)
    if (tree.contains(node)) throw bad(`the tree names \`${node}\` twice`)
    path.length = depth
    const parent = depth === 0 ? null : path[depth - 1]
    tree.insert(node, parent, tree.children(parent).length)
    path.push(node)
  }
  return tree
}

/** A field from its content form, as the schema declares it (`kind`; `undefined`: a register). */
function fieldFromContent(value: JsonValue, def: FieldDef | undefined, where: string): Field {
  const bad = (what: string) => () => errors.encoding(`a ${what} field holds ${JSON.stringify(value)} (${where})`)
  switch (def?.kind) {
    case 'text':
      return { kind: 'text', text: textFromContent(value, bad('text')) }
    case 'list':
      if (!Array.isArray(value)) throw bad('list')()
      return { kind: 'list', items: value.map((item) => checkObjectId(item, `an item of ${where}`)) }
    case 'map':
      if (!isRecord(value)) throw bad('map')()
      for (const key of Object.keys(value)) {
        if (value[key] === null) throw errors.encoding(`not KDM content: map entry \`${key}\` of ${where} holds null`)
        if (def?.of !== undefined && typeof value[key] === 'string') checkObjectId(value[key], `an entry of ${where}`)
      }
      return { kind: 'map', entries: new Map(Object.keys(value).map((key) => [key, canonical(value[key]) as JsonValue])) }
    case 'tree':
      return { kind: 'tree', tree: treeFromContent(value, (reason) => errors.encoding(`${reason} (${where})`)) }
    case 'ref':
      if (typeof value === 'string') checkObjectId(value, where)
      return { kind: 'value', value }
    default:
      return { kind: 'value', value: canonical(value) as JsonValue }
  }
}

/** An object from its content form; each field as the schema declares it, a field it does not declare as a register. */
export function objectFromContent(fields: Record<string, JsonValue>, schema: Schema, id: string): StoredObject {
  const ty = fields[TYPE_KEY]
  if (typeof ty !== 'string') throw errors.encoding('an object has no `$type`')
  const def = Object.hasOwn(schema.types, ty) ? schema.types[ty] : undefined
  const object = new StoredObject(ty)
  for (const name of Object.keys(fields)) {
    const value = fields[name]
    if (name === TYPE_KEY) continue
    if (value === null) throw errors.encoding(`not KDM content: field \`${name}\` of \`${id}\` holds null (a field without a value is left out)`)
    object.put(name, fieldFromContent(value, def && Object.hasOwn(def.fields, name) ? def.fields[name] : undefined, `${id}.${name}`))
  }
  return object
}

/** A node's place in a tree field of an object. */
export type TreePlace = { owner: ObjectId; field: string; parent: ObjectId | null; index: number }

/** One operation of a change, as the Rust `store::op::Op` (the parts this reader applies). */
export type Op =
  | { op: 'create'; id: ObjectId; object: StoredObject; trees: TreePlace[] }
  | { op: 'delete'; id: ObjectId; wasType: string | null; wasOwners: ObjectId[] }
  | { op: 'set'; id: ObjectId; field: string; value: JsonValue }
  | { op: 'textInsert'; id: ObjectId; field: string; index: number; text: string; marks: Marks | null }
  | { op: 'textDelete'; id: ObjectId; field: string; index: number; count: number }
  | { op: 'textMark'; id: ObjectId; field: string; start: number; end: number; key: string; value: JsonValue }
  | { op: 'listInsert'; id: ObjectId; field: string; index: number; item: ObjectId }
  | { op: 'listRemove'; id: ObjectId; field: string; index: number; item: ObjectId | null }
  | { op: 'listMove'; id: ObjectId; field: string; from: number; to: number; item: ObjectId | null }
  | { op: 'mapSet'; id: ObjectId; field: string; key: string; value: JsonValue }
  | { op: 'treeCreate'; id: ObjectId; field: string; node: ObjectId; parent: ObjectId | null; index: number | null }
  | { op: 'treeMove'; id: ObjectId; field: string; node: ObjectId; parent: ObjectId | null; index: number | null }
  | { op: 'treeDelete'; id: ObjectId; field: string; node: ObjectId }
  | { op: 'raiseSchema'; version: number }

/** An operation from its JSON (the Rust `Op::from_json`). A `mapSet` of `null` deletes the key. */
export function parseOp(value: JsonValue, schema: Schema): Op {
  const bad = (what: string) => errors.encoding(`a change's operation has no valid \`${what}\``)
  if (!isRecord(value)) throw bad('op')
  const string = (key: string): string => {
    const held = value[key]
    if (typeof held !== 'string') throw bad(key)
    return held
  }
  const number = (key: string): number => {
    const held = value[key]
    if (typeof held !== 'number' || !Number.isSafeInteger(held) || held < 0) throw bad(key)
    return held
  }
  const optionId = (key: string): ObjectId | null => {
    const held = value[key]
    if (held === undefined || held === null) return null
    if (typeof held !== 'string') throw bad(key)
    return held
  }
  const optionIndex = (): number | null => (value.index === undefined || value.index === null ? null : number('index'))
  const any = (key: string): JsonValue => (value[key] === undefined ? null : (value[key] as JsonValue))
  const id = () => string('id')
  const field = () => string('field')
  const kind = string('op')
  switch (kind) {
    case 'create': {
      const object = value.object
      if (!isRecord(object)) throw bad('object')
      const trees: TreePlace[] = []
      if (value.trees !== undefined) {
        if (!Array.isArray(value.trees)) throw bad('trees')
        for (const place of value.trees) {
          if (!isRecord(place) || typeof place.id !== 'string' || typeof place.field !== 'string') throw bad('trees')
          const index = place.index
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw bad('trees')
          trees.push({ owner: place.id, field: place.field, parent: typeof place.parent === 'string' ? place.parent : null, index })
        }
      }
      const at = id()
      return { op: 'create', id: at, object: objectFromContent(object, schema, at), trees }
    }
    case 'delete': {
      const was = value.was
      if (was !== undefined && !isRecord(was)) throw bad('was')
      const owners = Array.isArray(value.trees) ? value.trees.flatMap((place) => (isRecord(place) && typeof place.id === 'string' ? [place.id] : [])) : []
      return { op: 'delete', id: id(), wasType: was && typeof was[TYPE_KEY] === 'string' ? (was[TYPE_KEY] as string) : null, wasOwners: owners }
    }
    case 'set':
      return { op: 'set', id: id(), field: field(), value: canonical(any('value')) as JsonValue }
    case 'textInsert': {
      let marks: Marks | null = null
      if (value.marks !== undefined) {
        if (!isRecord(value.marks)) throw bad('marks')
        marks = sortedMarks(value.marks)
      }
      return { op: 'textInsert', id: id(), field: field(), index: number('index'), text: string('text'), marks }
    }
    case 'textDelete':
      return { op: 'textDelete', id: id(), field: field(), index: number('index'), count: number('count') }
    case 'textMark':
      return { op: 'textMark', id: id(), field: field(), start: number('start'), end: number('end'), key: string('key'), value: canonical(any('value')) as JsonValue }
    case 'listInsert':
      return { op: 'listInsert', id: id(), field: field(), index: number('index'), item: string('item') }
    case 'listRemove':
      return { op: 'listRemove', id: id(), field: field(), index: number('index'), item: optionId('item') }
    case 'listMove':
      return { op: 'listMove', id: id(), field: field(), from: number('from'), to: number('to'), item: optionId('item') }
    case 'mapSet':
    case 'mapDelete':
      return { op: 'mapSet', id: id(), field: field(), key: string('key'), value: kind === 'mapSet' ? (canonical(any('value')) as JsonValue) : null }
    case 'treeCreate':
      return { op: 'treeCreate', id: id(), field: field(), node: string('node'), parent: optionId('parent'), index: optionIndex() }
    case 'treeMove':
      return { op: 'treeMove', id: id(), field: field(), node: string('node'), parent: optionId('parent'), index: optionIndex() }
    case 'treeDelete':
      return { op: 'treeDelete', id: id(), field: field(), node: string('node') }
    case 'raiseSchema':
      return { op: 'raiseSchema', version: number('version') }
    default:
      throw errors.encoding(`unknown operation \`${kind}\``)
  }
}

/** The object an operation changes, and the tree owners a creation or deletion changes with it. */
export function opObjects(op: Op): ObjectId[] {
  if (op.op === 'raiseSchema') return []
  if (op.op === 'create') return [op.id, ...op.trees.map((place) => place.owner)]
  return [op.id]
}

/** Takes an applied operation back. */
export type Undo = () => void

const stale = errors.stale

export class Store {
  readonly objects = new Map<ObjectId, StoredObject>()
  /** For each object that is a node of a tree, the trees (owner, field) holding it. */
  private readonly holders = new Map<ObjectId, Array<[ObjectId, string]>>()

  constructor(
    readonly docId: string,
    readonly kit: string,
    /** The minimum schema version (rule M20). */
    public schemaVersion: number,
  ) {}

  /**
   * The state content holds, its fields read as `schema` declares them. Refuses (`encoding`) a
   * file's content (no version) whose list or tree names an object it does not hold; a snapshot
   * holds the state exactly, such entries included (rule C13).
   */
  static fromContent(content: Content, schema: Schema): Store {
    const store = new Store(content.docId, content.kit, content.schemaVersion)
    for (const [id, fields] of content.objects) {
      const object = objectFromContent(fields, schema, id)
      store.objects.set(id, object)
      store.indexTrees(id, object, true)
    }
    if (content.version !== null) return store
    for (const [id, object] of store.objects) {
      for (const [name, field] of object.fields) {
        const named = field.kind === 'list' ? field.items : field.kind === 'tree' ? [...field.tree.nodes()] : []
        for (const item of named) {
          if (!store.objects.has(item)) throw errors.encoding(`not KDM content: ${id}.${name} names \`${item}\`, which is no object of the document`)
        }
      }
    }
    return store
  }

  /** The objects whose tree fields hold `id` as a node. */
  treeOwners(id: ObjectId): ObjectId[] {
    return (this.holders.get(id) ?? []).map(([owner]) => owner)
  }

  private indexTrees(owner: ObjectId, object: StoredObject, add: boolean): void {
    for (const [field, held] of object.fields) {
      if (held.kind !== 'tree') continue
      for (const node of held.tree.nodes()) {
        if (add) this.index(node, owner, field)
        else this.unindex(node, owner, field)
      }
    }
  }

  private index(node: ObjectId, owner: ObjectId, field: string): void {
    const holders = this.holders.get(node)
    if (holders) holders.push([owner, field])
    else this.holders.set(node, [[owner, field]])
  }

  private unindex(node: ObjectId, owner: ObjectId, field: string): void {
    const holders = this.holders.get(node)
    if (!holders) return
    const kept = holders.filter(([held, name]) => !(held === owner && name === field))
    if (kept.length) this.holders.set(node, kept)
    else this.holders.delete(node)
  }

  private object(id: ObjectId): StoredObject {
    const object = this.objects.get(id)
    if (!object) throw stale(`object \`${id}\` does not exist`)
    return object
  }

  /** The tree field `field` of `id`: `null` when the object holds none. */
  private tree(id: ObjectId, field: string): Tree | null {
    const held = this.object(id).fields.get(field)
    if (!held) return null
    if (held.kind !== 'tree') throw stale(`${id}.${field} is not a tree`)
    return held.tree
  }

  /** Checks that `node` can go to `place`. */
  private checkPlace(place: TreePlace, node: ObjectId): void {
    const tree = this.tree(place.owner, place.field)
    let siblings = 0
    if (tree) {
      if (tree.contains(node)) throw stale(`\`${node}\` is in ${place.owner}.${place.field} already`)
      if (place.parent !== null && !tree.contains(place.parent)) throw stale(`no node \`${place.parent}\` in ${place.owner}.${place.field}`)
      siblings = tree.children(place.parent).length
    } else if (place.parent !== null) throw stale(`no node \`${place.parent}\` in ${place.owner}.${place.field}`)
    if (place.index > siblings) throw stale(`index ${place.index} is beyond ${siblings} siblings`)
  }

  /** Puts `node` at `place` (checked). */
  private attach(place: TreePlace, node: ObjectId): void {
    const object = this.objects.get(place.owner)
    if (!object) return
    let held = object.fields.get(place.field)
    if (!held) {
      held = { kind: 'tree', tree: new Tree() }
      object.fields.set(place.field, held)
    }
    if (held.kind === 'tree') held.tree.insert(node, place.parent, place.index)
    this.index(node, place.owner, place.field)
  }

  /** Takes `node` out of the tree at (`owner`, `field`); answers its place. */
  private detach(owner: ObjectId, field: string, node: ObjectId): [ObjectId | null, number] | null {
    const object = this.objects.get(owner)
    const held = object?.fields.get(field)
    if (!object || held?.kind !== 'tree') return null
    const place = held.tree.detach(node)
    object.settle(field)
    this.unindex(node, owner, field)
    return place
  }

  /**
   * Applies one operation, or changes nothing and throws `stale` when its preconditions do not
   * hold (the Rust `Store::apply`). Answers how to take it back.
   */
  apply(op: Op, expandOf: (ty: string, field: string, key: string) => 'after' | 'before' | 'both' | 'none' | undefined): Undo {
    switch (op.op) {
      case 'create': {
        const { id, trees } = op
        if (this.objects.has(id)) throw stale(`object \`${id}\` exists already`)
        const object = copyObject(op.object)
        this.objects.set(id, object)
        this.indexTrees(id, object, true)
        try {
          for (const place of trees) this.checkPlace(place, id)
        } catch (error) {
          this.indexTrees(id, object, false)
          this.objects.delete(id)
          throw error
        }
        for (const place of trees) this.attach(place, id)
        return () => {
          for (const place of [...trees].reverse()) this.detach(place.owner, place.field, id)
          this.indexTrees(id, object, false)
          this.objects.delete(id)
        }
      }
      case 'delete': {
        const { id } = op
        if (!this.objects.has(id)) throw stale(`object \`${id}\` does not exist`)
        const holders = [...(this.holders.get(id) ?? [])]
        for (const [owner, field] of holders) {
          if (this.tree(owner, field)?.children(id).length) throw stale(`\`${id}\` has children in ${owner}.${field}`)
        }
        const places: TreePlace[] = []
        for (const [owner, field] of holders) {
          const place = this.detach(owner, field, id)
          if (place) places.push({ owner, field, parent: place[0], index: place[1] })
        }
        this.holders.delete(id)
        const object = this.objects.get(id) as StoredObject
        this.objects.delete(id)
        this.indexTrees(id, object, false)
        return () => {
          this.objects.set(id, object)
          this.indexTrees(id, object, true)
          for (const place of [...places].reverse()) this.attach(place, id)
        }
      }
      case 'set': {
        const object = this.object(op.id)
        const was = object.fields.get(op.field)
        if (was && was.kind !== 'value') throw stale(`${op.id}.${op.field} is a container`)
        object.put(op.field, { kind: 'value', value: op.value })
        return () => restoreField(object, op.field, was)
      }
      case 'textInsert': {
        const object = this.object(op.id)
        const held = heldAs(object, op.id, op.field, 'text', 'is not a text')
        const len = held ? held.text.len : 0
        if (op.index > len) throw stale(`index ${op.index} is beyond ${op.id}.${op.field}'s ${len} characters`)
        const marks = op.marks ?? (held ? held.text.insertedMarks(op.index, (key) => expandOf(object.ty, op.field, key)) : {})
        if (op.text === '') return () => {}
        let text: Text
        if (held) text = held.text
        else {
          text = new Text()
          object.fields.set(op.field, { kind: 'text', text })
        }
        const before = text.len
        text.insert(op.index, op.text, marks)
        const count = text.len - before
        return () => {
          text.delete(op.index, count)
          object.settle(op.field)
        }
      }
      case 'textDelete': {
        const object = this.object(op.id)
        const held = heldAs(object, op.id, op.field, 'text', 'is not a text')
        const len = held ? held.text.len : 0
        if (op.index + op.count > len) throw stale(`${op.index}+${op.count} is beyond ${op.id}.${op.field}'s ${len} characters`)
        if (!held || op.count === 0) return () => {}
        const text = held.text
        const removed = text.delete(op.index, op.count)
        object.settle(op.field)
        return () => {
          if (!object.fields.has(op.field)) object.fields.set(op.field, { kind: 'text', text })
          let at = op.index
          for (const run of removed) {
            const before = text.len
            text.insert(at, run.insert, run.attributes)
            at += text.len - before
          }
        }
      }
      case 'textMark': {
        const object = this.object(op.id)
        const held = heldAs(object, op.id, op.field, 'text', 'is not a text')
        const len = held ? held.text.len : 0
        if (op.start > op.end || op.end > len) throw stale(`${op.start}..${op.end} is not within ${op.id}.${op.field}'s ${len} characters`)
        if (!held || op.start >= op.end) return () => {}
        const text = held.text
        const was = text.mark(op.start, op.end, op.key, op.value)
        return () => {
          for (const [start, end, value] of was) text.mark(start, end, op.key, value)
        }
      }
      case 'listInsert': {
        const object = this.object(op.id)
        const held = heldAs(object, op.id, op.field, 'list', 'is not a list')
        const len = held ? held.items.length : 0
        if (op.index > len) throw stale(`index ${op.index} is beyond ${op.id}.${op.field}'s ${len} items`)
        let items: ObjectId[]
        if (held) items = held.items
        else {
          items = []
          object.fields.set(op.field, { kind: 'list', items })
        }
        items.splice(op.index, 0, op.item)
        return () => {
          items.splice(op.index, 1)
          object.settle(op.field)
        }
      }
      case 'listRemove': {
        const object = this.object(op.id)
        const held = object.fields.get(op.field) as Field | undefined
        if (held === undefined || held.kind !== 'list' || op.index >= held.items.length) throw stale(`${op.id}.${op.field} holds no item ${op.index}`)
        const found = held.items[op.index]
        if (op.item !== null && op.item !== found) throw stale(`item ${op.index} of ${op.id}.${op.field} is \`${found}\`, not the one named`)
        const items = held.items
        items.splice(op.index, 1)
        object.settle(op.field)
        return () => {
          if (!object.fields.has(op.field)) object.fields.set(op.field, { kind: 'list', items })
          items.splice(op.index, 0, found)
        }
      }
      case 'listMove': {
        const object = this.object(op.id)
        const held = object.fields.get(op.field) as Field | undefined
        if (held === undefined || held.kind !== 'list') throw stale(`${op.id}.${op.field} holds no item ${op.from}`)
        const items = held.items
        if (op.to >= items.length) throw stale(`index ${op.to} is beyond ${op.id}.${op.field}'s ${items.length} items`)
        if (op.from >= items.length) throw stale(`${op.id}.${op.field} holds no item ${op.from}`)
        const found = items[op.from]
        if (op.item !== null && op.item !== found) throw stale(`item ${op.from} of ${op.id}.${op.field} is \`${found}\`, not the one named`)
        items.splice(op.from, 1)
        items.splice(op.to, 0, found)
        return () => {
          items.splice(op.to, 1)
          items.splice(op.from, 0, found)
        }
      }
      case 'mapSet': {
        const object = this.object(op.id)
        const held = heldAs(object, op.id, op.field, 'map', 'is not a map')
        let entries: Map<string, JsonValue>
        if (held) entries = held.entries
        else {
          if (op.value === null) return () => {}
          entries = new Map()
          object.fields.set(op.field, { kind: 'map', entries })
        }
        const had = entries.has(op.key)
        const was = entries.get(op.key) as JsonValue
        if (op.value === null) entries.delete(op.key)
        else entries.set(op.key, op.value)
        object.settle(op.field)
        return () => {
          if (!object.fields.has(op.field)) object.fields.set(op.field, { kind: 'map', entries })
          if (had) entries.set(op.key, was)
          else entries.delete(op.key)
          object.settle(op.field)
        }
      }
      case 'treeCreate': {
        const { id, field, node, parent } = op
        const tree = this.tree(id, field)
        let siblings = 0
        if (tree) {
          if (tree.contains(node)) throw stale(`\`${node}\` is in ${id}.${field} already`)
          if (parent !== null && !tree.contains(parent)) throw stale(`no parent node in ${id}.${field}`)
          siblings = tree.children(parent).length
        } else if (parent !== null) throw stale(`no parent node in ${id}.${field}`)
        const index = op.index ?? siblings
        if (index > siblings) throw stale(`index ${index} is beyond ${siblings} siblings`)
        this.attach({ owner: id, field, parent, index }, node)
        return () => {
          this.detach(id, field, node)
        }
      }
      case 'treeMove': {
        const { id, field, node, parent } = op
        const tree = this.tree(id, field)
        const was = tree?.place(node)
        if (!tree || !was) throw stale(`no node \`${node}\` in ${id}.${field}`)
        if (parent !== null) {
          if (!tree.contains(parent)) throw stale(`no parent node \`${parent}\` in ${id}.${field}`)
          if (tree.wouldCycle(node, parent)) throw errors.cycle()
        }
        const siblings = tree.children(parent).length - (was[0] === parent ? 1 : 0)
        const index = op.index ?? siblings
        if (index > siblings) throw stale(`index ${index} is beyond ${siblings} siblings`)
        tree.detach(node)
        tree.insert(node, parent, index)
        return () => {
          tree.detach(node)
          tree.insert(node, was[0], was[1])
        }
      }
      case 'treeDelete': {
        const { id, field, node } = op
        const tree = this.tree(id, field)
        if (!tree || !tree.contains(node)) throw stale(`no node \`${node}\` in ${id}.${field}`)
        if (tree.children(node).length) throw stale(`\`${node}\` has children in ${id}.${field}`)
        const was = this.detach(id, field, node) as [ObjectId | null, number]
        return () => this.attach({ owner: id, field, parent: was[0], index: was[1] }, node)
      }
      case 'raiseSchema': {
        const was = this.schemaVersion
        this.schemaVersion = op.version
        return () => {
          this.schemaVersion = was
        }
      }
    }
  }
}

/** Field `name` of `object` when it is of `kind`; `undefined` when not held; `stale` (`<id>.<name> <otherwise>`) when it is another kind. */
function heldAs<K extends Field['kind']>(object: StoredObject, id: ObjectId, name: string, kind: K, otherwise: string): Extract<Field, { kind: K }> | undefined {
  const field = object.fields.get(name)
  if (field === undefined) return undefined
  if (field.kind !== kind) throw stale(`${id}.${name} ${otherwise}`)
  return field as Extract<Field, { kind: K }>
}

/** Puts back a field as it was (`undefined`: not held). */
function restoreField(object: StoredObject, name: string, was: Field | undefined): void {
  if (was) object.fields.set(name, was)
  else object.fields.delete(name)
}

/** A copy of an object a change carries, so applying it twice (a refused import, then again) starts from the same fields. */
function copyObject(source: StoredObject): StoredObject {
  const object = new StoredObject(source.ty)
  for (const [name, field] of source.fields) {
    switch (field.kind) {
      case 'value':
        object.fields.set(name, field)
        break
      case 'text': {
        const text = new Text()
        for (const run of field.text.pieces()) text.insert(text.len, run.insert, run.attributes)
        object.fields.set(name, { kind: 'text', text })
        break
      }
      case 'list':
        object.fields.set(name, { kind: 'list', items: [...field.items] })
        break
      case 'map':
        object.fields.set(name, { kind: 'map', entries: new Map(field.entries) })
        break
      case 'tree': {
        const tree = new Tree()
        for (const { node, parent } of field.tree.preorder()) tree.insert(node, parent, tree.children(parent).length)
        object.fields.set(name, { kind: 'tree', tree })
        break
      }
    }
  }
  return object
}

