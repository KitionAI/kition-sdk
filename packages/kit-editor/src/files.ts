/**
 * The kit's side of KitFiles 1.0 (Kition platform `docs/platform/sets/files.md`; Kit UI protocol section 7g):
 * files beyond the document, through the handles the host grants. The kit never names a path: it
 * asks the host to pick or create a file, and reads and writes the handle it answers.
 */
import type { KitFileStat, KitFilesPickParams, KitSidePeer } from '@kition/kit-ui-protocol'

/** Bytes per `files/write` chunk: bounded memory on both sides, under the headless binding's 8 MiB. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024

/** A file an engine command produced (standard E16): the binding takes its bytes with `takeOutput(id)`. */
export type KitEngineOutput = { id: string; suggestedName: string; mime?: string }

export type KitFilesClient = {
  /** The host serves `files` (create, read, write, …); hide what needs it otherwise (UI-F3). */
  served: boolean
  /** The host shows a picker (`files-pick`). */
  canPick: boolean
  /** The host prints (`print`). */
  canPrint: boolean
  /** Shows the host's picker; send it only from a click or key handler (FA6). Empty when the person cancels. */
  pick: (params: KitFilesPickParams) => Promise<KitFileStat[]>
  /** A new file beside the document, or in a folder handle with right `create`; the host picks an unused name (FA7). */
  create: (suggestedName: string, options?: { mime?: string; folder?: string }) => Promise<KitFileStat>
  stat: (handle: string) => Promise<KitFileStat>
  /** One ranged read; the host may answer fewer bytes than asked. */
  read: (handle: string, range?: { offset?: number; length?: number }) => Promise<{ bytes: ArrayBuffer; version: string; size: number }>
  /** The whole file, read on until its size. */
  readAll: (handle: string) => Promise<{ bytes: Uint8Array; version: string }>
  list: (folder: string) => Promise<KitFileStat[]>
  /**
   * Writes `bytes` to a handle in staged chunks and commits them (FA9); answers the new version.
   * Replacing an existing file (right `write`) needs the version it replaces (`expected`).
   */
  write: (handle: string, bytes: Uint8Array, options?: { expected?: string; chunkBytes?: number }) => Promise<string>
  release: (handles: string[]) => Promise<void>
  /** Prints a PDF through the system's dialog (FA11), from a gesture; answers whether the person printed. */
  print: (source: { bytes: Uint8Array; title: string } | { handle: string; title: string }) => Promise<boolean>
  /**
   * Writes an engine command's outputs (E16) to handles: the one `targets` names for an output, or a
   * new file `create` makes (in `folder` when given). Answers each written file's stat.
   */
  writeOutputs: (outputs: KitEngineOutput[], takeOutput: (id: string) => Uint8Array | Promise<Uint8Array>, options?: { targets?: Record<string, string>; folder?: string }) => Promise<KitFileStat[]>
  /** Hears `files/revoked`: the host revoked handles, or they expired (FA4). Answers an unsubscribe. */
  onRevoked: (listener: (handles: string[]) => void) => () => void
}

const toBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/** The `files/*` client on a kit's connection; `capabilities` are the host's (`ui/initialize`). */
export function createFilesClient(peer: KitSidePeer, capabilities: readonly string[]): KitFilesClient {
  const stat = (handle: string) => peer.request('files/stat', { handle })
  const write: KitFilesClient['write'] = async (handle, bytes, options = {}) => {
    const size = Math.max(1, options.chunkBytes ?? FILE_CHUNK_BYTES)
    let offset = 0
    for (;;) {
      const end = Math.min(bytes.byteLength, offset + size)
      const final = end === bytes.byteLength
      const chunk = toBuffer(bytes.subarray(offset, end))
      const params = final && options.expected !== undefined ? { handle, bytes: chunk, offset, final, expected: options.expected } : { handle, bytes: chunk, offset, final }
      const answer = await peer.request('files/write', params, { transfer: true })
      if (final) return answer.version ?? ''
      offset = end
    }
  }
  const client: KitFilesClient = {
    served: capabilities.includes('files'),
    canPick: capabilities.includes('files-pick'),
    canPrint: capabilities.includes('print'),
    pick: async (params) => (await peer.request('files/pick', params)).files,
    create: (suggestedName, options = {}) => peer.request('files/create', { suggestedName, ...options }),
    stat,
    read: (handle, range = {}) => peer.request('files/read', { handle, ...range }),
    readAll: async (handle) => {
      const parts: Uint8Array[] = []
      let at = 0
      let version = ''
      for (;;) {
        const answer = await peer.request('files/read', { handle, offset: at })
        version = answer.version
        parts.push(new Uint8Array(answer.bytes))
        at += answer.bytes.byteLength
        if (at >= answer.size || answer.bytes.byteLength === 0) break
      }
      const bytes = new Uint8Array(at)
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.byteLength
      }
      return { bytes, version }
    },
    list: async (folder) => (await peer.request('files/list', { handle: folder })).files,
    write,
    release: async (handles) => {
      if (handles.length) await peer.request('files/release', { handles })
    },
    print: async (source) => {
      const params = 'handle' in source ? { handle: source.handle, title: source.title } : { bytes: toBuffer(source.bytes), mime: 'application/pdf' as const, title: source.title }
      return (await peer.request('files/print', params, { transfer: true })).printed === true
    },
    writeOutputs: async (outputs, takeOutput, options = {}) => {
      const written: KitFileStat[] = []
      for (const output of outputs) {
        const target = options.targets?.[output.id]
        const file = target ? await stat(target) : await client.create(output.suggestedName, { ...(output.mime ? { mime: output.mime } : {}), ...(options.folder ? { folder: options.folder } : {}) })
        const bytes = await takeOutput(output.id)
        // A target the kit may replace commits over the version it has now (FA9).
        const version = await write(file.handle, bytes, file.rights.includes('create') || file.version === null ? {} : { expected: file.version })
        written.push({ ...file, version, size: bytes.byteLength })
      }
      return written
    },
    onRevoked: (listener) => peer.on('files/revoked', (params) => listener(Array.isArray(params?.handles) ? params.handles : [])),
  }
  return client
}
