/**
 * A replica store whose blobs live in the page's blob store (`StorageProvider.blob`, `KitEmbed
 * 1.1`) rather than inside each stored replica. A replica's `blobs` is a blob section (`hash`,
 * length, bytes, repeated; `@kition/sync`'s `blobSection.ts`): on `write`, each blob goes to the
 * blob store once, and the stored replica keeps a section of the same hashes with no bytes; on
 * `read`, the bytes are filled in again from the blob store. A replica stored before (its blobs
 * still inside) reads as it was.
 */
import { decodeBlobSection, encodeBlobSection, type BlobEntry } from '@kition/sync'
import { toArrayBuffer } from './handlers'
import type { BlobStore, ReplicaStore } from './types'

/** The SHA-256 of no bytes: the one blob a section may hold with no bytes of its own. */
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const HASH = /^[0-9a-f]{64}$/

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether `data` hashes to `hash`; `true` where the page has no Web Crypto to check with. */
async function matches(hash: string, data: Uint8Array) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return true
  return hex(await subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)) === hash
}

export function blobBackedReplicas(replicas: ReplicaStore, blobs: BlobStore): ReplicaStore {
  // The hashes written to the blob store by this editor, so each goes there once.
  const written = new Set<string>()
  return {
    read: async (fileId) => {
      const stored = await replicas.read(fileId)
      if (!stored) return null
      const entries = decodeBlobSection(new Uint8Array(toArrayBuffer(stored.blobs)))
      if (!entries.some((entry) => !entry.data.length && entry.hash !== EMPTY_HASH)) return stored
      const filled: BlobEntry[] = []
      for (const entry of entries) {
        if (entry.data.length || entry.hash === EMPTY_HASH) {
          filled.push(entry)
          continue
        }
        const found = await blobs.read(entry.hash)
        const data = found ? new Uint8Array(toArrayBuffer(found)) : null
        if (!data || !(await matches(entry.hash, data))) {
          console.warn(`[kition-embed] the blob store ${data ? 'answered other bytes for' : 'lacks'} blob ${entry.hash}`)
          continue
        }
        written.add(entry.hash)
        filled.push({ hash: entry.hash, data })
      }
      return { ...stored, blobs: toArrayBuffer(encodeBlobSection(filled)) }
    },
    write: async (fileId, replica) => {
      const entries = decodeBlobSection(new Uint8Array(toArrayBuffer(replica.blobs)))
      for (const entry of entries) {
        if (!entry.data.length || written.has(entry.hash) || !HASH.test(entry.hash)) continue
        await blobs.write(entry.hash, entry.data)
        written.add(entry.hash)
      }
      const references = entries.map((entry) => (HASH.test(entry.hash) ? { hash: entry.hash, data: new Uint8Array() } : entry))
      await replicas.write(fileId, { ...replica, blobs: toArrayBuffer(encodeBlobSection(references)) })
    },
  }
}
