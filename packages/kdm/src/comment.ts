/**
 * Comments (KitModel rule M23), as the `kition-kdm` crate's `comment` module.
 *
 * People discuss a document in comment threads anchored to its objects. A thread is an object of
 * the reserved type `CommentThread`: its `anchor` (an object, and optionally a field and a range in
 * it), whether it is `resolved`, and its `comments` in order. A comment is an object of the
 * reserved type `Comment`: its `author` (a principal id; a file's own author name for comments
 * imported from a file), their display `name` when it was written, its `body` text, and when it was
 * `created` (ISO 8601 UTC).
 *
 * Comments live beside the content, never inside it, so a principal that may only comment (the
 * sync protocol's `commenter` role, 1.6) changes only these two types, which a server checks
 * without knowing the kit. A kit that keeps comments declares both types in its schema as
 * `COMMENT_THREAD_TYPE_DEF` and `COMMENT_TYPE_DEF` (it may add optional register fields of its own).
 * Both types declare direct raw batches: field replacements hold the written field, list edits
 * hold their insertion/removal place, and deletion holds the object's identity. A missing thread
 * refuses a reply as `deleted`; the contract needs no kit command name.
 */
import { KdmError } from './errors'
import type { ObjectId } from './ids'
import type { Replica } from './replica'

export const COMMENT_THREAD_TYPE = 'CommentThread'
export const COMMENT_TYPE = 'Comment'

/** The `CommentThread` type's definition, as a kit adds it to its schema's `types`. */
export const COMMENT_THREAD_TYPE_DEF = {
  fields: { anchor: { kind: 'json' }, resolved: { kind: 'boolean', optional: true }, comments: { kind: 'list', of: COMMENT_TYPE } },
  batchOps: { '*': { direct: true } },
} as const

/** The `Comment` type's definition, as a kit adds it to its schema's `types`. */
export const COMMENT_TYPE_DEF = {
  fields: { author: { kind: 'string' }, name: { kind: 'string', optional: true }, body: { kind: 'text' }, created: { kind: 'string' } },
  batchOps: { '*': { direct: true } },
} as const

/** Whether `ty` is one of the comment types: the only types a commenter's change may touch. */
export function isCommentType(ty: string): boolean {
  return ty === COMMENT_THREAD_TYPE || ty === COMMENT_TYPE
}

/**
 * Where a thread is anchored: an object, and optionally a field of it and a range in that field
 * (character offsets in a `text` field when the thread was made; `quote` is the text the range held
 * then, so an editor can find it again after edits around it). Kits may add keys of their own.
 */
export type CommentAnchor = {
  object: string
  field?: string
  range?: { start: number; end: number }
  quote?: string
  [key: string]: unknown
}

export type Comment = { id: ObjectId; author: string; name?: string; body: string; created: string }

export type CommentThread = { id: ObjectId; anchor: CommentAnchor | null; resolved: boolean; comments: Comment[] }

function asAnchor(value: unknown): CommentAnchor | null {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { object?: unknown }).object === 'string' ? (value as CommentAnchor) : null
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)

/**
 * The document's comment threads, oldest first (by their first comment's `created`, then id), with
 * their live comments in order. Empty for a schema without the comment types.
 */
export function commentThreads(replica: Replica): CommentThread[] {
  const types = replica.schema.types
  if (!Object.hasOwn(types, COMMENT_THREAD_TYPE) || !Object.hasOwn(types, COMMENT_TYPE)) return []
  const threads: CommentThread[] = []
  for (const id of replica.objectsOfType(COMMENT_THREAD_TYPE)) {
    const comments: Comment[] = []
    for (const item of replica.list(id, 'comments')) {
      // A deleted comment a list still names is not shown.
      if (!replica.exists(item) || replica.objectType(item) !== COMMENT_TYPE) continue
      const name = optionalString(replica.get(item, 'name'))
      comments.push({
        id: item,
        author: optionalString(replica.get(item, 'author')) ?? '',
        ...(name === undefined ? {} : { name }),
        body: replica.text(item, 'body'),
        created: optionalString(replica.get(item, 'created')) ?? '',
      })
    }
    threads.push({ id, anchor: asAnchor(replica.get(id, 'anchor')), resolved: replica.get(id, 'resolved') === true, comments })
  }
  const opened = (thread: CommentThread) => thread.comments[0]?.created ?? ''
  return threads.sort((a, b) => (opened(a) < opened(b) ? -1 : opened(a) > opened(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
