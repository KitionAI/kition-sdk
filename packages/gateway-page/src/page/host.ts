/**
 * The workspace as a kit editor's host (Kit UI protocol `host/*`, Kition's `KitFrame.tsx` and
 * `kitionHost.ts`), through the gateway:
 *
 * - `host/read`, `host/stamp`: `GET`/`HEAD /kit-files/<path>` (a stamp is one `HEAD`, the file's
 *   `ETag`; the kit asks every two seconds), for its document and the files beside it a kit may
 *   read: never a hidden path (`.kition/`, rule LR2);
 * - `host/write`: a save writes its own document only, through `PUT /api/v1/kits/files`, atomically
 *   and only over the version the editor holds (`expected`), answering the new version; a new file
 *   or an export goes under a name not taken yet;
 * - `host/replicaRead`, `host/replicaWrite`: the replica the editor keeps beside its document
 *   (`/api/v1/kits/replicas`); the gateway keeps no checkpoints (no capability `checkpoints`);
 * - `host/viewStateRead`, `host/viewStateWrite`: the person's view state of the document, in the
 *   gateway's own data outside the workspace (`/api/v1/kits/view-state`).
 */
import { KitRpcError, type KitHostHandlers, type KitViewState, type StoredReplica } from '@kition/kit-host'
import { cleanPath, encodePath, type Gateway, GatewayError, read } from './gateway'

/** A version stamp from an answer's headers: its `ETag`, or its time and size. */
export function stampOf(headers: Headers) {
  return headers.get('etag') || [headers.get('last-modified'), headers.get('content-length')].filter(Boolean).join('|') || null
}

/** `wanted`, checked: a workspace path the kit editing `document` may read (its own, or a visible one). */
export function readable(wanted: string, document: string) {
  const path = cleanPath(wanted)
  if (!path) throw new Error(`${wanted} is outside the workspace`)
  if (path !== document && path.split('/').some((part) => part.startsWith('.'))) throw new Error(`${wanted} is not readable by a kit`)
  return path
}

/** The workspace file `path`: its bytes and stamp; `null` when it is not there. */
export async function readFile(gateway: Gateway, path: string, range?: { offset: number; length?: number }) {
  const headers: Record<string, string> = {}
  if (range && (range.offset > 0 || range.length !== undefined)) headers.Range = `bytes=${range.offset}-${range.length !== undefined ? range.offset + range.length - 1 : ''}`
  const response = await gateway.fetch(`kit-files/${encodePath(path)}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) throw new GatewayError(`could not read ${path} (${response.status})`, response.status, null)
  const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
  const bytes = await response.arrayBuffer()
  return { bytes, stamp: stampOf(response.headers), size: total ? Number(total) : bytes.byteLength }
}

/** The stamp of the workspace file `path`, `null` when it is not there. */
export async function stampFile(gateway: Gateway, path: string) {
  const response = await gateway.fetch(`kit-files/${encodePath(path)}`, { method: 'HEAD' })
  return response.ok ? stampOf(response.headers) : null
}

/** A name not taken yet: `name.ext`, then `name 2.ext`, ... (new files and exports never replace one). */
export async function unusedPath(gateway: Gateway, path: string) {
  if ((await stampFile(gateway, path)) === null) return path
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  const [stem, extension] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${stem} ${number}${extension}`
    if ((await stampFile(gateway, candidate)) === null) return candidate
  }
  throw new Error(`no free name for ${path}`)
}

/** Writes the workspace file `path`: a save of `document` over `expected`, or a new file. Answers its version. */
export async function writeFile(gateway: Gateway, path: string, bytes: ArrayBuffer, save: { document: string; expected?: string | null } | null) {
  const query = new URLSearchParams({ path })
  if (save) {
    query.set('document', save.document)
    if (save.expected) query.set('expected', save.expected)
  }
  const answer = await gateway.json<{ version?: string | null }>(`api/v1/kits/files?${query}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
  return answer?.version ?? (await stampFile(gateway, path)) ?? ''
}

/** A stored replica as the gateway keeps it: the snapshot's length (8 bytes, little-endian), the snapshot, the blobs. */
export function packReplica(replica: { snapshot: ArrayBuffer; blobs: ArrayBuffer }) {
  const out = new Uint8Array(8 + replica.snapshot.byteLength + replica.blobs.byteLength)
  new DataView(out.buffer).setBigUint64(0, BigInt(replica.snapshot.byteLength), true)
  out.set(new Uint8Array(replica.snapshot), 8)
  out.set(new Uint8Array(replica.blobs), 8 + replica.snapshot.byteLength)
  return out.buffer
}

export function unpackReplica(bytes: ArrayBuffer, fileStamp: string): StoredReplica | null {
  if (bytes.byteLength < 8) return null
  const length = Number(new DataView(bytes).getBigUint64(0, true))
  if (length > bytes.byteLength - 8) return null
  return { snapshot: bytes.slice(8, 8 + length), blobs: bytes.slice(8 + length), fileStamp }
}

/** A view state as the gateway keeps it: its JSON's length (8 bytes, little-endian), the JSON, the bytes. */
export function packViewState(value: KitViewState) {
  const json = new TextEncoder().encode(JSON.stringify(value.state))
  const bytes = value.bytes ? new Uint8Array(value.bytes) : new Uint8Array(0)
  const out = new Uint8Array(8 + json.byteLength + bytes.byteLength)
  new DataView(out.buffer).setBigUint64(0, BigInt(json.byteLength), true)
  out.set(json, 8)
  out.set(bytes, 8 + json.byteLength)
  return out.buffer
}

/** A kept view state; `{ state: null }` for a damaged one. */
export function unpackViewState(packed: ArrayBuffer): KitViewState {
  if (packed.byteLength < 8) return { state: null }
  const length = Number(new DataView(packed).getBigUint64(0, true))
  if (length > packed.byteLength - 8) return { state: null }
  let state: unknown
  try {
    state = JSON.parse(new TextDecoder().decode(new Uint8Array(packed, 8, length)))
  } catch {
    return { state: null }
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { state: null }
  const bytes = packed.slice(8 + length)
  return bytes.byteLength ? { state: state as Record<string, unknown>, bytes } : { state: state as Record<string, unknown> }
}

/** The host handlers for the kit `kit` editing `document`, read-only or not. */
export function hostHandlers(gateway: Gateway, kit: string, document: string, readOnly: boolean, held: { version: string | null }): Pick<KitHostHandlers, 'read' | 'stamp' | 'write' | 'replicaRead' | 'replicaWrite' | 'viewState'> {
  const own = (wanted: string) => {
    const path = cleanPath(wanted)
    if (path !== document) throw new Error(`${wanted} is not this editor's document`)
    return path
  }
  return {
    read: async ({ path: wanted, offset, length }) => {
      const path = readable(wanted, document)
      const file = await readFile(gateway, path, offset !== undefined || length !== undefined ? { offset: offset ?? 0, length } : undefined)
      if (!file) throw new Error(`${path} is not in the workspace`)
      // The editor (re)read its document: a save is over this version from now on.
      if (path === document && offset === undefined && length === undefined) held.version = file.stamp
      return { bytes: file.bytes, version: file.stamp ?? '', size: file.size }
    },
    stamp: async ({ path: wanted }) => ({ version: await stampFile(gateway, readable(wanted, document)) }),
    write: async ({ path: wanted, bytes, mode, expected }) => {
      if (mode === 'save') {
        if (readOnly) throw new Error(`${document} is open read-only`)
        const path = own(wanted)
        try {
          const version = await writeFile(gateway, path, bytes, { document: path, expected: expected ?? held.version })
          held.version = version
          return { path, version }
        } catch (error) {
          if (error instanceof GatewayError && error.reason === 'file_conflict') throw new Error(`${path} changed since it was opened: reload it, or save it under another name`)
          throw error
        }
      }
      const checked = cleanPath(wanted)
      if (!checked || checked.split('/').some((part) => part.startsWith('.'))) throw new Error(`${wanted} is outside the workspace`)
      const path = await unusedPath(gateway, checked)
      return { path, version: await writeFile(gateway, path, bytes, null) }
    },
    replicaRead: async ({ path: wanted }) => {
      const path = own(wanted)
      const response = await gateway.fetch(`api/v1/kits/replicas?${new URLSearchParams({ path, kit })}`)
      if (response.status === 204 || response.status === 404) return null
      if (!response.ok) await read(response)
      return unpackReplica(await response.arrayBuffer(), response.headers.get('kition-file-stamp') ?? '')
    },
    replicaWrite: async ({ path: wanted, snapshot, blobs, fileStamp }) => {
      if (readOnly) return
      const path = own(wanted)
      const response = await gateway.fetch(`api/v1/kits/replicas?${new URLSearchParams({ path, kit })}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Kition-File-Stamp': fileStamp },
        body: packReplica({ snapshot, blobs }),
      })
      await read(response)
    },
    // The person's, not the document's: kept for a read-only document too (UI-S4).
    viewState: {
      read: async ({ path: wanted }) => {
        const path = own(wanted)
        const response = await gateway.fetch(`api/v1/kits/view-state?${new URLSearchParams({ path, kit })}`)
        if (response.status === 204 || response.status === 404) return { state: null }
        if (!response.ok) await read(response)
        return unpackViewState(await response.arrayBuffer())
      },
      write: async ({ path: wanted, state, bytes }) => {
        const path = own(wanted)
        const query = new URLSearchParams({ path, kit })
        const response = await gateway.fetch(
          `api/v1/kits/view-state?${query}`,
          state === null ? { method: 'DELETE' } : { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: packViewState({ state, bytes }) },
        )
        try {
          await read(response)
        } catch (error) {
          if (error instanceof GatewayError && error.reason === 'too-large') throw new KitRpcError(-32000, error.message, { reason: 'too-large' })
          throw error
        }
      },
    },
  }
}
