/**
 * The Kit UI protocol's host calls (`host/*`) answered with the integrator's providers. The kit
 * sees one file, its document, under the file's name: it reads, stamps, and saves only that
 * (UI-H2); what it writes under another name (an export, a new file) becomes a new file through
 * `storage.create`; and it keeps its replica (capability `replica`) only when the editor serves one.
 */
import { isOpenableUrl, KitRpcError, type KitHostHandlers, type StoredReplica } from '@kition/kit-host'
import { EmbedConflictError } from './errors'
import type { DocumentChange, EmbedNotice, ReplicaStore, StorageProvider } from './types'

/** The document once named: by the page, or by the storage's `info`. */
export type NamedFile = { id: string; name: string }

export type DocumentFiles = {
  file: NamedFile
  storage: StorageProvider
  /** Where the document's replica is kept; `null`: the editor serves no `replica` capability. */
  replicas: ReplicaStore | null
  readOnly: boolean
  /** The file's version as the editor last read or wrote it, shared by every mount of the editor. */
  version: DocumentVersion
  onSaved: (version: string) => void
  onChanged: (change: DocumentChange) => void
  onNotify?: (notice: EmbedNotice) => void
  /** A save was refused: the file changed elsewhere since it was read. */
  onConflict?: (error: EmbedConflictError) => void
  /**
   * Whether the person just made a gesture in the kit (OP1, OP6). Default: the page's transient
   * user activation, which a click in the kit's frame gives its parent too; true where the browser
   * does not tell.
   */
  gesture?: () => boolean
}

const userActivation = () => (globalThis.navigator as (Navigator & { userActivation?: { isActive: boolean } }) | undefined)?.userActivation?.isActive ?? true

/**
 * The document's version as the editor knows it, shared by every mount of the editor. Saves go to
 * the storage one after another (`saving`), each over the version the one before it wrote, and
 * the bytes the last one wrote are kept (`written`), so the same bytes again are not written again.
 */
export type DocumentVersion = {
  current: string | null
  /** The save in progress; the next one waits for it. */
  saving?: Promise<unknown>
  /** What the last save wrote, and the version the storage answered for it. */
  written?: { version: string; bytes: Uint8Array } | null
  /** The bytes the file is known to hold: what the editor read, or the last save wrote. */
  known?: Uint8Array | null
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false
  return true
}

/** A kit's path as the editor compares it: `/`-separated, without empty or `.` segments. */
export function normalizePath(path: string) {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
}

function refuse(reason: 'not-allowed' | 'conflict' | 'not-found' | 'no-gesture', message: string): never {
  throw new KitRpcError(-32000, message, { reason })
}

export function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.slice().buffer as ArrayBuffer
}

/** The file's version without its bytes: `storage.stamp`, else the version `storage.info` tells. */
export async function stampOf(storage: StorageProvider, fileId: string): Promise<string | null> {
  if (storage.stamp) return storage.stamp(fileId)
  if (storage.info) return (await storage.info(fileId))?.version ?? null
  throw new Error('the storage answers neither stamp nor info')
}

function storedReplica(replica: StoredReplica): StoredReplica {
  return { snapshot: toArrayBuffer(replica.snapshot), blobs: toArrayBuffer(replica.blobs), fileStamp: replica.fileStamp }
}

export function createHandlers(files: DocumentFiles): KitHostHandlers {
  const { file, storage, replicas, version } = files
  const documentPath = normalizePath(file.name)
  const isDocument = (path: string) => normalizePath(path) === documentPath
  const ownDocument = (path: string) => {
    if (!isDocument(path)) refuse('not-allowed', `${path} is not this editor's document`)
  }

  async function save(data: Uint8Array, expected: string | null | undefined) {
    const expectedVersion = expected === undefined ? version.current : expected
    const last = version.written
    // The bytes the last save wrote, over the version it wrote: nothing to write, as long as the
    // file is still that version. A file changed elsewhere since is written, and refused.
    if (last && expectedVersion === last.version && version.current === last.version && sameBytes(last.bytes, data)) {
      const stamp = await stampOf(storage, file.id).catch(() => null)
      if (stamp === last.version) {
        files.onSaved(last.version)
        return last.version
      }
    }
    let written: { version: string }
    try {
      written = await storage.write(file.id, data, { expectedVersion })
    } catch (error) {
      if (error instanceof EmbedConflictError) {
        files.onConflict?.(error)
        refuse('conflict', error.message)
      }
      throw error
    }
    version.current = written.version
    version.written = { version: written.version, bytes: data }
    version.known = data
    files.onSaved(written.version)
    return written.version
  }

  const handlers: KitHostHandlers = {
    read: async ({ path, offset, length }) => {
      ownDocument(path)
      const read = await storage.read(file.id)
      version.current = read.version
      version.known = read.bytes instanceof Uint8Array ? read.bytes : new Uint8Array(read.bytes)
      const whole = toArrayBuffer(read.bytes)
      const start = offset ?? 0
      const bytes = offset != null || length != null ? whole.slice(start, length != null ? start + length : undefined) : whole
      return { bytes, version: read.version, size: whole.byteLength }
    },
    stamp: async ({ path }) => ({ version: isDocument(path) ? await stampOf(storage, file.id) : null }),
    write: async ({ path, bytes, mode, expected }) => {
      const data = new Uint8Array(bytes)
      if (mode === 'save') {
        ownDocument(path)
        if (files.readOnly) refuse('not-allowed', `${file.name} is open read-only`)
        // One save at a time: a save made while another is being written (the page's
        // `editor.save()` while the kit saves) waits for it, then goes over the version it wrote
        // rather than the one both started from.
        const saved = (version.saving ?? Promise.resolve()).then(() => save(data, expected))
        version.saving = saved.catch(() => undefined)
        return { path: file.name, version: await saved }
      }
      // `export` and `create` only ever make new files (H5).
      if (!storage.create) refuse('not-allowed', 'this page does not take new files')
      const name = normalizePath(path).split('/').pop() || file.name
      const created = await storage.create(name, data)
      return { path: created.name ?? name, version: created.version ?? '' }
    },
    changed: (state) => files.onChanged(state),
    notify: ({ level, title, description }) => files.onNotify?.({ level, message: title, ...(description ? { description } : {}) }),
  }
  // Opening (EM25): offered only for the callbacks the page has, and only from a gesture (OP1, OP6).
  const gesture = files.gesture ?? userActivation
  const { resolveLink, open, openUrl } = storage
  if (resolveLink && open) {
    handlers.open = async ({ link, view }) => {
      if (!gesture()) refuse('no-gesture', 'opening a linked file needs a person’s gesture in the kit')
      const target = await resolveLink(file.id, link)
      if (!target) refuse('not-found', `${link.path ?? link.name ?? link.docId} is not a file this page opens`)
      return open(target.fileId, view)
    }
  }
  if (openUrl) {
    handlers.openUrl = async ({ url }) => {
      if (!isOpenableUrl(url)) refuse('not-allowed', 'only https:, http:, and mailto: addresses open')
      if (!gesture()) refuse('no-gesture', 'opening an address needs a person’s gesture in the kit')
      return openUrl(url)
    }
  }
  const viewStates = storage.viewState
  if (viewStates) {
    handlers.viewState = {
      read: async ({ path }) => {
        ownDocument(path)
        return viewStates.read(file.id)
      },
      write: async ({ path, ...value }) => {
        ownDocument(path)
        await viewStates.write(file.id, value.state !== null && value.bytes ? { state: value.state, bytes: toArrayBuffer(value.bytes) } : { state: value.state })
      },
    }
  }
  if (replicas) {
    handlers.replicaRead = async ({ path }) => {
      ownDocument(path)
      // The stored replica whatever its stamp (UI-R1): the kit opens with it.
      const stored = await replicas.read(file.id)
      return stored ? storedReplica(stored) : null
    }
    handlers.replicaWrite = async ({ path, ...replica }) => {
      ownDocument(path)
      await replicas.write(file.id, storedReplica(replica))
    }
  }
  return handlers
}
