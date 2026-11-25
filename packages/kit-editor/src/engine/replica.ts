/**
 * A document's KDM replica kept by the host next to its file (the Kit UI protocol's `replica`
 * capability), for files that cannot hold a replica themselves, such as PSD. The file stays the
 * document: the engine opens it with the stored replica and records a file that differs as one
 * `import` change (UI-R1); every failure here degrades to opening the file plainly, never to
 * losing or blocking it.
 */
import type { KitCheckpoint, KitCheckpointRequest, KitHost, KitViewState } from './kitHost'
import type { KitModuleReplica, KitSavedReplica } from './kitModule'

/**
 * The stored replica to open `path` with: the host's, whatever the file's stamp (UI-R1). None
 * when nothing is stored or the host failed: the file opens plainly, and the next save stores the
 * replica the engine makes. A snapshot the engine cannot read counts as none (the worker opens the
 * file plainly then).
 */
export async function replicaToOpen(host: KitHost, path: string): Promise<KitModuleReplica | null> {
  if (!host.replicaRead) return null
  try {
    const stored = await host.replicaRead(path)
    return stored ? { snapshot: stored.snapshot, blobs: stored.blobs } : null
  } catch {
    return null
  }
}

/** What a save stores beside the file: a checkpoint at the replica's version, the person's view state. */
export type SaveExtras = {
  /** Records a checkpoint with the replica write (capability `checkpoints`); without it, none is recorded. */
  checkpoint?: KitCheckpointRequest
  /** Hears the checkpoint recorded, or `null` when none was (no capability, no replica, refused). */
  recorded?: (checkpoint: KitCheckpoint | null) => void
  /** The person's view state, written after the file (capability `view-state`); a failure is only logged. */
  viewState?: KitViewState | null
}

/**
 * Writes the file, then `replica` (taken with the file's bytes, with the version its snapshot
 * holds) under the stamp the write answered, or the file's stamp after it, with
 * `extras.checkpoint` recorded in the same replica write at that version (UI-R6): edits made while
 * the writes are pending are not in it. A
 * replica the host cannot store is left out: the file is saved, and it opens plainly next time.
 * Then the view state: a failed write never fails the save. Answers the file's new stamp.
 */
export async function writeWithReplica(host: KitHost, path: string, bytes: Uint8Array, replica: KitSavedReplica | null, expected?: string | null, extras: SaveExtras = {}): Promise<string | null> {
  const written = await host.write(path, bytes, expected)
  const stamp = written || (await host.stamp(path).catch(() => null))
  let recorded: KitCheckpoint | null = null
  if (replica && stamp && host.replicaWrite) {
    try {
      const answer = await host.replicaWrite(path, { ...replica, fileStamp: stamp }, extras.checkpoint && host.checkpoints ? extras.checkpoint : undefined)
      recorded = (extras.checkpoint && answer) || null
    } catch (error) {
      console.warn('[kit] could not store the document replica', error)
    }
  }
  extras.recorded?.(recorded)
  if (extras.viewState !== undefined) await writeViewState(host, path, extras.viewState)
  return stamp
}

/** The person's view state of `path` kept by the host; `null` without the capability, when none is kept, or on any failure. */
export async function readViewState(host: KitHost, path: string): Promise<KitViewState | null> {
  if (!host.viewState) return null
  try {
    const value = await host.viewState.read(path)
    return value.state === null ? null : value
  } catch (error) {
    console.warn('[kit] could not read the view state', error)
    return null
  }
}

/**
 * Keeps the person's view state of `path` with the host (`null` deletes it); does nothing without
 * the capability. Never throws: answers whether the host kept it.
 */
export async function writeViewState(host: KitHost, path: string, value: KitViewState | null): Promise<boolean> {
  if (!host.viewState) return false
  try {
    await host.viewState.write(path, value ?? { state: null })
    return true
  } catch (error) {
    console.warn('[kit] could not keep the view state', error)
    return false
  }
}

/** The host's checkpoints of `path`, newest first; `null` without the capability. Refusals reject (`historyErrorReason`). */
export async function listCheckpoints(host: KitHost, path: string, options?: { labelled?: boolean; before?: string; limit?: number }) {
  return host.checkpoints ? host.checkpoints.list(path, options) : null
}

/** Renames or redescribes one of the kit's own checkpoints; `null` without the capability. */
export async function updateCheckpoint(host: KitHost, path: string, id: string, fields: { label?: string; description?: string }) {
  return host.checkpoints ? host.checkpoints.update(path, id, fields) : null
}

/** Deletes one of the kit's own checkpoints; answers whether the host has checkpoints at all. */
export async function deleteCheckpoint(host: KitHost, path: string, id: string) {
  if (!host.checkpoints) return false
  await host.checkpoints.delete(path, id)
  return true
}

/** One checkpoint, the snapshot it keeps and that snapshot's blobs; `null` without the capability. */
export async function readCheckpoint(host: KitHost, path: string, id: string) {
  return host.checkpoints ? host.checkpoints.read(path, id) : null
}
