/**
 * The change lists the Rust KDM exports (`Replica::export_changes`), read: `{kdm, docId, lineage,
 * after: {seq, actor}, changes: [{seq, actor, origin, ops}]}`. Each change's operations are as the
 * exporting replica applied them. A change list travels between the replicas of one session; it
 * is never written into a file.
 */
import { checkUuid } from './content'
import { errors } from './errors'
import { decodeCommit, type Origin } from './origin'
import type { Schema } from './schema'
import { parseOp, type Op } from './store'
import type { JsonValue } from './value'

/** One change: its number on the document's line, its actor (16 hex digits), its origin, and its operations. */
export type Change = { seq: number; actor: string; origin: Origin; schemaVersion: number | null; ops: Op[] }

/** A change list: the line it continues, the version it follows, and its changes. */
export type ChangeList = { lineage: string; after: number; afterActor: string | null; changes: Change[] }

const isRecord = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value)

const ACTOR = /^[0-9a-fA-F]{1,16}$/

/** An actor id as the Rust `u64::from_str_radix(hex, 16)` reads it, in its 16-digit lowercase form. */
function actorOf(value: unknown): string | null {
  if (typeof value !== 'string' || !ACTOR.test(value)) return null
  return value.toLowerCase().padStart(16, '0')
}

/** The document a change list or snapshot names (`docId`). */
export function docIdOf(value: JsonValue): string {
  if (!isRecord(value) || typeof value.docId !== 'string') throw errors.encoding('not KDM changes: no `docId`')
  return checkUuid(value.docId, '`docId`')
}

/** The change list in `value` (the Rust `Replica::import_change_list` reading). */
export function parseChangeList(value: Record<string, JsonValue>, schema: Schema): ChangeList {
  const bad = (what: string) => errors.encoding(`not KDM changes: no valid \`${what}\``)
  let lineage: string
  try {
    lineage = checkUuid(value.lineage, '`lineage`')
  } catch {
    throw bad('lineage')
  }
  const after = isRecord(value.after) ? value.after.seq : undefined
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw bad('after')
  const afterActor = isRecord(value.after) ? actorOf(value.after.actor) : null
  if (!Array.isArray(value.changes)) throw bad('changes')
  const changes = value.changes.map((change) => parseChange(change, schema))
  return { lineage, after, afterActor, changes }
}

function parseChange(value: JsonValue, schema: Schema): Change {
  const bad = (what: string) => errors.encoding(`a change has no valid \`${what}\``)
  if (!isRecord(value)) throw bad('seq')
  const seq = value.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw bad('seq')
  const actor = actorOf(value.actor)
  if (actor === null) throw bad('actor')
  if (actor === 'ffffffffffffffff') throw errors.encoding('actor id u64::MAX is reserved')
  if (value.origin === undefined) throw bad('origin')
  const commit = decodeCommit(JSON.stringify(value.origin))
  if (commit === null) throw bad('origin')
  if (!Array.isArray(value.ops)) throw bad('ops')
  return { seq, actor, origin: commit.origin, schemaVersion: commit.schemaVersion, ops: value.ops.map((op) => parseOp(op, schema)) }
}
