/**
 * Which objects a change touches, read from the KDM formats alone (no schema, no kit), as a host
 * checks a `commenter`'s change (KitModel rule M23): each operation names the object it changes
 * (and a creation or deletion the trees it goes into or leaves); a schema raise touches the
 * document itself.
 */
import { docIdOf, parseChangeList, type Change } from './change'
import { decodeContent } from './content'
import { isCommentType } from './comment'
import { errors } from './errors'
import type { ObjectId } from './ids'
import { readJson } from './json'
import type { Schema } from './schema'
import { TYPE_KEY } from './store'
import type { JsonValue } from './value'
import { Version } from './version'

/** What a change touched: each object with its type (as it was before, else after), and whether it changed the document outside its objects. */
export type Touched = { objects: Map<ObjectId, string | null>; outside: boolean }

/** Whether `touched` holds only comment threads and comments: all a commenter may write (rule M23). */
export function touchesOnlyComments(touched: Touched): boolean {
  if (touched.outside) return false
  for (const type of touched.objects.values()) if (type === null || !isCommentType(type)) return false
  return true
}

/** No types: every field of a created object reads as a register, which is all an audit looks at. */
const NO_SCHEMA: Schema = { kdm: 1, kit: '', schemaVersion: 0, root: '', types: {} }

/**
 * A copy of a document's object types that follows its changes and tells what each one touched.
 * It reads the KDM formats only, so it serves any kit's document; it never writes.
 */
export class ChangeAudit {
  private constructor(
    private readonly docId: string,
    private types: Map<ObjectId, string>,
    private lineage: string | null,
    private seq: number,
  ) {}

  /** From a snapshot (or content) of the document. */
  static load(bytes: Uint8Array): ChangeAudit {
    const content = decodeContent(readJson(bytes, 'not KDM content'))
    const types = new Map<ObjectId, string>()
    for (const [id, fields] of content.objects) types.set(id, fields[TYPE_KEY] as string)
    return new ChangeAudit(content.docId, types, content.version?.lineage ?? null, content.version?.seq ?? 0)
  }

  version(): Version {
    return this.lineage === null ? Version.empty() : Version.at(this.lineage, this.seq)
  }

  /** Takes changes the document already holds without looking at them (another replica's, an undo). */
  follow(changes: Uint8Array): void {
    this.take(changes)
  }

  /** Takes `changes` and answers what they touched. A snapshot touches the whole document. */
  touched(changes: Uint8Array): Touched {
    return this.take(changes)
  }

  private take(bytes: Uint8Array): Touched {
    const value = readJson(bytes, 'not KDM changes')
    const docId = docIdOf(value)
    if (docId !== this.docId) throw errors.wrongDocument(this.docId, docId)
    const record = value as Record<string, JsonValue>
    if (record.changes === undefined) {
      const replaced = ChangeAudit.load(bytes)
      this.types = replaced.types
      this.lineage = replaced.lineage
      this.seq = replaced.seq
      return { objects: new Map(), outside: true }
    }
    const list = parseChangeList(record, NO_SCHEMA)
    if (list.lineage !== this.lineage) throw errors.stale("the changes continue another line of changes (another replica's history)")
    if (list.after > this.seq) throw errors.stale(`the changes follow version ${list.after}; this replica is at ${this.seq}`)
    const fresh: Change[] = []
    let seq = this.seq
    for (const change of list.changes) {
      if (change.seq <= seq) continue
      if (change.seq !== seq + 1) throw errors.stale(`change ${change.seq} does not follow version ${seq}`)
      fresh.push(change)
      seq = change.seq
    }
    const objects = new Map<ObjectId, string | null>()
    let outside = false
    const touch = (id: ObjectId, type: string | null) => {
      if (!objects.has(id)) objects.set(id, this.types.get(id) ?? type)
    }
    for (const change of fresh) {
      for (const op of change.ops) {
        switch (op.op) {
          case 'raiseSchema':
            outside = true
            break
          case 'create':
            touch(op.id, op.object.ty)
            for (const place of op.trees) touch(place.owner, null)
            this.types.set(op.id, op.object.ty)
            break
          case 'delete':
            touch(op.id, op.wasType)
            for (const owner of op.wasOwners) touch(owner, null)
            this.types.delete(op.id)
            break
          default:
            touch(op.id, null)
        }
      }
    }
    this.seq = seq
    return { objects, outside }
  }
}
