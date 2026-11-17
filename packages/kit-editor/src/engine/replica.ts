/**
 * A document's KDM replica kept by the host next to its file (the Kit UI protocol's `replica`
 * capability), for files that cannot hold a replica themselves, such as PSD. The file stays the
 * document: a replica only counts while the file is the one it was saved with, so every failure
 * here degrades to opening the file plainly, never to losing or blocking it.
 */
import type { KitHost } from './kitHost'
import type { KitModuleReplica } from './kitModule'

/**
 * The stored replica to open `path` with: the host's, when it was saved with the file as it is
 * now (`stamp`, the stamp of the bytes being opened; the host's current stamp when that is
 * unknown). Otherwise (nothing stored, the file changed elsewhere since, the host failed) none:
 * the file opens plainly, its replica is made anew on the first edit, and the next save replaces
 * the stored one. `mergesFile` is for an engine that merges what the file holds into an older
 * replica when it opens: the stored replica opens whatever the file's stamp.
 */
export async function replicaToOpen(host: KitHost, path: string, stamp: string | null, mergesFile = false): Promise<KitModuleReplica | null> {
  if (!host.replicaRead) return null
  try {
    const stored = await host.replicaRead(path)
    if (!stored) return null
    if (mergesFile) return { snapshot: stored.snapshot, blobs: stored.blobs }
    const current = stamp ?? (await host.stamp(path))
    return current && stored.fileStamp === current ? { snapshot: stored.snapshot, blobs: stored.blobs } : null
  } catch {
    return null
  }
}

/**
 * Writes the file, then `replica` (taken with the file's bytes) under the stamp the write answered,
 * or the file's stamp after it. A replica the host cannot store is left out: the file is saved,
 * and it opens plainly next time. Answers the file's new stamp.
 */
export async function writeWithReplica(host: KitHost, path: string, bytes: Uint8Array, replica: KitModuleReplica | null, expected?: string | null): Promise<string | null> {
  const written = await host.write(path, bytes, expected)
  const stamp = written || (await host.stamp(path).catch(() => null))
  if (replica && stamp && host.replicaWrite) {
    try {
      await host.replicaWrite(path, { ...replica, fileStamp: stamp })
    } catch (error) {
      console.warn('[kit] could not store the document replica', error)
    }
  }
  return stamp
}
