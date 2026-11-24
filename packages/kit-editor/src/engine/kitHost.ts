import type { KitCheckpoint, KitCheckpointRequest, KitViewState } from '@kition/kit-ui-protocol'

export type { KitCheckpoint, KitCheckpointRequest, KitViewState }

/** A document's KDM replica (snapshot and blobs) and the stamp of the file it was saved with. */
export type KitStoredReplica = { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }

/** A replica as a save writes it: the stored replica and `version`, the replica version its snapshot holds, taken with it (UI-R6). */
export type KitWrittenReplica = KitStoredReplica & { version: ArrayBuffer }

/** The host's checkpoints of a document (the Kit UI protocol's `checkpoints` capability, section 7m). */
export type KitCheckpoints = {
  list: (path: string, options?: { labelled?: boolean; before?: string; limit?: number }) => Promise<{ checkpoints: KitCheckpoint[]; more: boolean }>
  update: (path: string, id: string, fields: { label?: string; description?: string }) => Promise<KitCheckpoint>
  delete: (path: string, id: string) => Promise<void>
  read: (path: string, id: string, options?: { state?: boolean }) => Promise<{ checkpoint: KitCheckpoint; blobs: ArrayBuffer; snapshot?: ArrayBuffer }>
}

/** The person's view state of a document, kept by the host outside the document (the `view-state` capability, section 7n). */
export type KitViewStates = {
  read: (path: string) => Promise<KitViewState>
  write: (path: string, value: KitViewState) => Promise<void>
}

/**
 * How a kit editor reaches the file it edits. Kition reads workspace files
 * over its loopback API and writes them through `PUT /v1/kits/files`; another
 * host supplies its own. Version stamps (an `etag`, or time and size) let the
 * editor notice when something else, such as an agent, replaced the file.
 */
export type KitHost = {
  /** The file's bytes and the stamp of that version. */
  read: (path: string) => Promise<{ bytes: ArrayBuffer; stamp: string | null }>
  /** The stamp of the file's current version, or null when it cannot tell. */
  stamp: (path: string) => Promise<string | null>
  /** Replaces the file with `bytes` only if `expected` still matches; answers the new stamp. */
  write: (path: string, bytes: Uint8Array, expected?: string | null) => Promise<string | null | void>
  /**
   * The document's replica as the host stored it with the file it was saved with (the Kit UI
   * protocol's `replica` capability), or null. Absent: the host keeps no replicas.
   */
  replicaRead?: (path: string) => Promise<KitStoredReplica | null>
  /**
   * Stores the document's replica with the stamp of the file it belongs to; with `checkpoint` (and
   * `checkpoints`) records a checkpoint at `replica.version` (the version its snapshot holds) in
   * the same step and answers it.
   */
  replicaWrite?: (path: string, replica: KitWrittenReplica, checkpoint?: KitCheckpointRequest) => Promise<KitCheckpoint | null | void>
  /** The host's checkpoints of the document. Absent: the host keeps none (the kit keeps versions for the session only). */
  checkpoints?: KitCheckpoints
  /** The person's view state of the document. Absent: the host keeps none (the kit keeps it for the session only). */
  viewState?: KitViewStates
  /**
   * Where the document at `path` may read the other files it names (lent files): an absolute
   * URL of the workspace root that serves ranged reads, and the document's folder in it. Absent:
   * documents read no other files.
   */
  lend?: (path: string) => { root: string; folder: string } | null
}

/** A version stamp from HTTP headers: the validator, or the time and size. */
export function stampFromHeaders(headers: Headers) {
  return headers.get('etag') || [headers.get('last-modified'), headers.get('content-length')].filter(Boolean).join('|') || null
}
