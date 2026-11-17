/** A `StorageProvider` in memory for tests: versions count writes, and a stale write conflicts. */
import { EmbedConflictError } from '../src/errors'
import type { StorageProvider } from '../src/types'

export function memoryStorage(initial: Record<string, string> = {}) {
  const files = new Map<string, { bytes: Uint8Array; version: number }>()
  for (const [id, text] of Object.entries(initial)) files.set(id, { bytes: new TextEncoder().encode(text), version: 1 })
  const created: Array<{ name: string; text: string }> = []
  const storage = {
    read: async (fileId: string) => {
      const file = files.get(fileId)
      if (!file) throw new Error(`no file ${fileId}`)
      return { bytes: file.bytes.slice(), version: `v${file.version}` }
    },
    stamp: async (fileId: string) => (files.has(fileId) ? `v${files.get(fileId)!.version}` : null),
    write: async (fileId: string, bytes: Uint8Array, { expectedVersion }: { expectedVersion: string | null }) => {
      const file = files.get(fileId)
      const current = file ? `v${file.version}` : null
      if (expectedVersion !== null && expectedVersion !== current) throw new EmbedConflictError(fileId, current)
      const version = (file?.version ?? 0) + 1
      files.set(fileId, { bytes: bytes.slice(), version })
      return { version: `v${version}` }
    },
    create: async (name: string, bytes: Uint8Array) => {
      created.push({ name, text: new TextDecoder().decode(bytes) })
      files.set(`new-${created.length}`, { bytes: bytes.slice(), version: 1 })
      return { fileId: `new-${created.length}`, name }
    },
  } satisfies StorageProvider
  /** Another person's write, behind the editor's back. */
  const writeElsewhere = (fileId: string, text: string) => {
    const file = files.get(fileId)
    files.set(fileId, { bytes: new TextEncoder().encode(text), version: (file?.version ?? 0) + 1 })
  }
  const text = (fileId: string) => new TextDecoder().decode(files.get(fileId)?.bytes)
  return { storage, files, created, writeElsewhere, text }
}
