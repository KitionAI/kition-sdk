/**
 * The document's comment threads for the page (`comments` events, `KitEmbed 1.1`), read from the
 * kit's replica. Comment threads are objects of the reserved types `CommentThread` and `Comment`
 * (KitModel rule M23), the same in every kit, so a copy of the replica read with a schema of
 * only those two types finds them without knowing the kit. The copy is read-only: it loads the
 * kit's snapshot and follows the replica's changes (`replica/export` since its version), and is
 * made only while someone listens.
 */
import { COMMENT_THREAD_TYPE, COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE, COMMENT_TYPE_DEF, Replica, commentThreads, parseSchema, type CommentThread, type Schema } from '@kition/kdm'

/** The replica as the copy reads it: the kit's `replica/export`. */
export type CommentSource = {
  exportChanges: (since: ArrayBuffer) => Promise<{ changes: ArrayBuffer }>
}

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

/**
 * A schema of the comment types alone, for `kit`'s documents of any schema version: it loads any
 * of the kit's documents and takes their changes without knowing the kit's own types.
 */
export function commentSchema(kit: string): Schema {
  return parseSchema({
    kdm: 1,
    kit,
    // A document's minimum schema version is at most this, so every version of the kit's documents opens.
    schemaVersion: 0xffff_ffff,
    root: COMMENT_THREAD_TYPE,
    types: { [COMMENT_THREAD_TYPE]: COMMENT_THREAD_TYPE_DEF, [COMMENT_TYPE]: COMMENT_TYPE_DEF },
  })
}

/** Follows one kit's replica and answers its comment threads. */
export class CommentReader {
  private readonly schema: Schema
  private copy: Replica | null = null

  constructor(kit: string) {
    this.schema = commentSchema(kit)
  }

  /** The threads as the replica holds them now. */
  async threads(source: CommentSource): Promise<CommentThread[]> {
    if (this.copy) {
      try {
        const { changes } = await source.exportChanges(buffer(this.copy.version().encode()))
        if (changes.byteLength) this.copy.importChanges(new Uint8Array(changes))
        return commentThreads(this.copy)
      } catch {
        // Another replica, or changes this copy cannot follow: start over from the kit's snapshot.
        this.copy = null
      }
    }
    const { changes } = await source.exportChanges(new ArrayBuffer(0))
    this.copy = Replica.load(this.schema, new Uint8Array(changes))
    return commentThreads(this.copy)
  }

  /** Forgets the copy, for a kit opened again. */
  reset() {
    this.copy = null
  }
}
