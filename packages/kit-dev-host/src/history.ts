/**
 * The dev host's store of what a host keeps beside a document (Kit UI protocol sections 7, 7m and
 * 7n), in memory for one page load, per workspace path: the replica (`host/replicaRead`,
 * `host/replicaWrite`), its checkpoints (`host/checkpoint*`) and the person's view state
 * (`host/viewState*`). `mountKit` checks every rule a kit can break (lengths, origin, read-only
 * documents, unknown ids, sizes) before these handlers run; the store keeps the rest: which
 * checkpoints exist and the state each keeps.
 *
 * A checkpoint keeps the snapshot and blobs of the replica write that recorded it, so
 * `host/checkpointRead` answers them whatever was written since; its `version` is the one that
 * write carries (base64, UI-R6). The store hands the stored replica over whatever its `fileStamp`
 * (UI-R1): the kit opens with it and records a file that differs as one `import` change.
 */
import { KitRpcError, KIT_CHECKPOINT_ORIGIN, type KitCheckpoint, type KitHostHandlers, type KitViewState, type StoredReplica } from '@kition/kit-host'

/** The most unlabelled checkpoints kept per document; older ones are thinned. Labelled ones are kept apart. */
export const DEV_UNLABELLED_CHECKPOINTS = 100
/** The most labelled checkpoints kept per document. */
export const DEV_LABELLED_CHECKPOINTS = 1000

type Entry = { checkpoint: KitCheckpoint; snapshot: ArrayBuffer; blobs: ArrayBuffer }

/** What a host records itself (`devHost.recordCheckpoint`): its own origin (`save`, `agent`, ...), or `kit` to play the kit's. */
export type DevCheckpointRecord = { origin: string; label?: string; description?: string; author?: string }

function refuse(reason: 'not-found' | 'conflict', message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

/** Base64 of `bytes`, as `ai/version` answers a version. */
export function base64(bytes: ArrayBuffer) {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text)
}

/** The replica, its checkpoints and the view state of every document of one dev-host page load. */
export class DevHistory {
  private replicas = new Map<string, StoredReplica>()
  private entries = new Map<string, Entry[]>()
  private views = new Map<string, KitViewState>()
  private nextId = 1
  private lastTime = 0
  /** The clock checkpoints are stamped with (milliseconds since the Unix epoch). */
  now: () => number = () => Date.now()

  private view(entry: Entry): KitCheckpoint {
    return { ...entry.checkpoint }
  }

  private time() {
    // Newest first is by time too: two checkpoints never share a millisecond.
    this.lastTime = Math.max(this.now(), this.lastTime + 1)
    return this.lastTime
  }

  /** The file at `path` was opened alone (or replaced): its replica is dropped; its checkpoints keep their states. */
  forget(path: string) {
    this.replicas.delete(path)
  }

  /** The stored replica of `path`, or `null`. */
  replica(path: string): StoredReplica | null {
    const stored = this.replicas.get(path)
    return stored ? { snapshot: stored.snapshot.slice(0), blobs: stored.blobs.slice(0), fileStamp: stored.fileStamp } : null
  }

  /** Every checkpoint of `path`, newest first. */
  checkpoints(path: string): KitCheckpoint[] {
    return [...(this.entries.get(path) ?? [])].reverse().map((entry) => this.view(entry))
  }

  /** The view state kept for `path` (`{ state: null }`: none). */
  viewState(path: string): KitViewState {
    const kept = this.views.get(path)
    return kept ? { state: structuredClone(kept.state), ...(kept.bytes ? { bytes: kept.bytes.slice(0) } : {}) } : { state: null }
  }

  /**
   * Records a checkpoint at `version` of the stored replica (UI-C1): at the version of the newest
   * checkpoint it answers that one, and a request with a label upgrades it: it takes the label and
   * description and the request's origin (a kit's request makes it the kit's, origin `kit`, so the
   * person can rename or delete it); otherwise a new one. `null` without a stored replica.
   */
  record(path: string, version: string, request: DevCheckpointRecord): KitCheckpoint | null {
    const stored = this.replicas.get(path)
    if (!stored) return null
    const list = this.entries.get(path) ?? []
    this.entries.set(path, list)
    const newest = list[list.length - 1]
    if (newest && newest.checkpoint.version === version) {
      if (request.label) {
        newest.checkpoint = { ...newest.checkpoint, origin: request.origin, label: request.label, ...(request.description !== undefined ? { description: request.description } : {}) }
        if (!newest.checkpoint.description) delete newest.checkpoint.description
      }
      return this.view(newest)
    }
    const checkpoint: KitCheckpoint = {
      id: `dev-checkpoint-${this.nextId++}`,
      time: this.time(),
      origin: request.origin,
      ...(request.author ? { author: request.author } : {}),
      ...(request.label ? { label: request.label } : {}),
      ...(request.description ? { description: request.description } : {}),
      version,
    }
    list.push({ checkpoint, snapshot: stored.snapshot.slice(0), blobs: stored.blobs.slice(0) })
    this.thin(list)
    return this.view(list[list.length - 1]!)
  }

  /** Drops the oldest unlabelled checkpoints over their limit, and the oldest labelled ones over theirs. */
  private thin(list: Entry[]) {
    for (const [labelled, limit] of [[false, DEV_UNLABELLED_CHECKPOINTS], [true, DEV_LABELLED_CHECKPOINTS]] as const) {
      let over = list.filter((entry) => Boolean(entry.checkpoint.label) === labelled).length - limit
      for (let index = 0; over > 0 && index < list.length; ) {
        if (Boolean(list[index]!.checkpoint.label) === labelled) {
          list.splice(index, 1)
          over -= 1
        } else index += 1
      }
    }
  }

  /**
   * The `mountKit` handlers of a document. `replicaRead` answers the stored replica whatever its
   * `fileStamp` (UI-R1). A checkpoint keeps the write's snapshot and blobs, at the `version` the
   * write carries (UI-R6).
   */
  handlers(): Required<Pick<KitHostHandlers, 'replicaRead' | 'replicaWrite' | 'checkpoints' | 'viewState'>> {
    const entry = (wanted: string, id: string) => {
      const found = (this.entries.get(wanted) ?? []).find((candidate) => candidate.checkpoint.id === id)
      // mountKit found it a moment ago: gone now is someone else's change.
      if (!found) refuse('conflict', `checkpoint ${id} changed meanwhile`)
      return found
    }
    return {
      replicaRead: ({ path: wanted }) => this.replica(wanted),
      replicaWrite: ({ path: wanted, snapshot, blobs, fileStamp, version, checkpoint }) => {
        this.replicas.set(wanted, { snapshot: snapshot.slice(0), blobs: blobs.slice(0), fileStamp })
        if (!checkpoint) return
        const recorded = this.record(wanted, base64(version), { ...checkpoint, origin: KIT_CHECKPOINT_ORIGIN })
        return recorded ? { checkpoint: recorded } : {}
      },
      checkpoints: {
        find: ({ path: wanted, id }) => {
          const found = (this.entries.get(wanted) ?? []).find((candidate) => candidate.checkpoint.id === id)
          return found ? this.view(found) : null
        },
        list: ({ path: wanted, labelled, before, limit }) => {
          let all = this.checkpoints(wanted)
          if (before !== undefined) {
            const index = all.findIndex((checkpoint) => checkpoint.id === before)
            if (index < 0) refuse('not-found', `no checkpoint ${before}`)
            all = all.slice(index + 1)
          }
          if (labelled) all = all.filter((checkpoint) => checkpoint.label)
          const most = limit ?? all.length
          return { checkpoints: all.slice(0, most), more: all.length > most }
        },
        update: ({ path: wanted, id, label, description }) => {
          const found = entry(wanted, id)
          const next = { ...found.checkpoint }
          if (label !== undefined) next.label = label
          if (description !== undefined) next.description = description
          if (!next.label) delete next.label
          if (!next.description) delete next.description
          found.checkpoint = next
          return { checkpoint: this.view(found) }
        },
        delete: ({ path: wanted, id }) => {
          const found = entry(wanted, id)
          const list = this.entries.get(wanted)!
          list.splice(list.indexOf(found), 1)
        },
        read: ({ path: wanted, id }) => {
          const found = entry(wanted, id)
          return { checkpoint: this.view(found), blobs: found.blobs.slice(0), snapshot: found.snapshot.slice(0) }
        },
      },
      viewState: {
        read: ({ path: wanted }) => this.viewState(wanted),
        write: ({ path: wanted, state, bytes }) => {
          if (state === null) this.views.delete(wanted)
          else this.views.set(wanted, { state: structuredClone(state), ...(bytes ? { bytes: bytes.slice(0) } : {}) })
        },
      },
    }
  }
}
