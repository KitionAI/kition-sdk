import { describe, expect, it, vi } from 'vitest'
import { KitPeer, KitRpcError, fileErrorReason, type HostPeer, type KitSidePeer } from '@kition/kit-ui-protocol'
import { createFilesClient } from './files'

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: ArrayBuffer | Uint8Array) => new TextDecoder().decode(bytes)

/** A host that serves `files/*` from memory, and the kit's client on the other end. */
function connected(capabilities = ['files', 'files-pick', 'print']) {
  const channel = new MessageChannel()
  const host: HostPeer = new KitPeer(channel.port1, 'h')
  const kit: KitSidePeer = new KitPeer(channel.port2, 'k')
  const writes: Array<{ handle: string; text: string; offset: number; final?: boolean; expected?: string | null }> = []
  const stored = new Map<string, string>([['fh_in', 'abcdefgh']])
  const staged = new Map<string, string>()
  let next = 1
  host.handle('files/pick', () => ({ files: [{ handle: 'fh_in', name: 'in.pdf', kind: 'file', version: 'v1', rights: ['read'] }] }))
  host.handle('files/create', ({ suggestedName, mime, folder }) => ({ handle: `fh_new${next++}`, name: suggestedName, kind: 'file', version: null, rights: ['create'], ...(mime ? { mime } : {}), ...(folder ? { size: 0 } : {}) }))
  host.handle('files/stat', ({ handle }) => ({ handle, name: 'target.png', kind: 'file', version: 'v7', rights: ['write'] }))
  // At most three bytes per read, as a host with a small chunk limit answers.
  host.handle('files/read', ({ handle, offset = 0 }) => {
    const text = stored.get(handle) ?? ''
    return { bytes: encode(text.slice(offset, offset + 3)).buffer as ArrayBuffer, version: 'v1', size: text.length }
  })
  host.handle('files/list', () => ({ files: [] }))
  host.handle('files/write', ({ handle, bytes, offset, final, expected }) => {
    writes.push({ handle, text: decode(bytes), offset, final, expected })
    staged.set(handle, (staged.get(handle) ?? '') + decode(bytes))
    if (!final) return {}
    stored.set(handle, staged.get(handle)!)
    return { version: 'v2' }
  })
  host.handle('files/release', () => ({}))
  host.handle('files/print', (params) => {
    if ('handle' in params) throw new KitRpcError(-32000, 'no', { reason: 'not-allowed' })
    return { printed: decode(params.bytes).startsWith('%PDF') }
  })
  return { host, files: createFilesClient(kit, capabilities), writes, stored }
}

describe('createFilesClient', () => {
  it('names what the host serves', () => {
    const { files } = connected(['files'])
    expect({ served: files.served, canPick: files.canPick, canPrint: files.canPrint }).toEqual({ served: true, canPick: false, canPrint: false })
  })

  it('picks, and reads a whole file across short reads', async () => {
    const { files } = connected()
    const [picked] = await files.pick({ purpose: 'Insert pages', mode: 'open', accept: ['pdf'] })
    expect(picked!.handle).toBe('fh_in')
    expect(decode((await files.read('fh_in', { offset: 2, length: 3 })).bytes)).toBe('cde')
    const whole = await files.readAll('fh_in')
    expect({ text: decode(whole.bytes), version: whole.version }).toEqual({ text: 'abcdefgh', version: 'v1' })
  })

  it('writes in staged chunks and commits with the final one, carrying the expected version', async () => {
    const { files, writes, stored } = connected()
    const out = await files.create('Export.pdf', { mime: 'application/pdf' })
    expect(await files.write(out.handle, encode('hello world'), { chunkBytes: 4 })).toBe('v2')
    expect(writes.map(({ text, offset, final }) => [text, offset, final])).toEqual([['hell', 0, false], ['o wo', 4, false], ['rld', 8, true]])
    expect(stored.get(out.handle)).toBe('hello world')
    writes.length = 0
    await files.write('fh_old', encode('new'), { expected: 'v1' })
    expect(writes).toEqual([{ handle: 'fh_old', text: 'new', offset: 0, final: true, expected: 'v1' }])
    writes.length = 0
    await files.write('fh_empty', new Uint8Array())
    expect(writes, 'an empty file is one final chunk').toEqual([{ handle: 'fh_empty', text: '', offset: 0, final: true }])
  })

  it('writes an engine\'s outputs (E16) to new files or to the handles named for them', async () => {
    const { files, stored } = connected()
    const taken: string[] = []
    const written = await files.writeOutputs(
      [
        { id: 'o1', suggestedName: 'Layer 1.png', mime: 'image/png' },
        { id: 'o2', suggestedName: 'Layer 2.png' },
      ],
      (id) => {
        taken.push(id)
        return encode(`bytes of ${id}`)
      },
      { targets: { o2: 'fh_target' } },
    )
    expect(taken).toEqual(['o1', 'o2'])
    expect(written.map(({ handle, name, version, size }) => ({ handle, name, version, size }))).toEqual([
      { handle: 'fh_new1', name: 'Layer 1.png', version: 'v2', size: 11 },
      { handle: 'fh_target', name: 'target.png', version: 'v2', size: 11 },
    ])
    expect(stored.get('fh_target')).toBe('bytes of o2')
  })

  it('prints, surfaces a refusal\'s reason, and hears revoked handles', async () => {
    const { files, host } = connected()
    expect(await files.print({ bytes: encode('%PDF-1.7'), title: 'Report' })).toBe(true)
    const refusal = await files.print({ handle: 'fh_in', title: 'x' }).catch((error: unknown) => error)
    expect(fileErrorReason(refusal)).toBe('not-allowed')
    expect(fileErrorReason(new Error('other'))).toBeNull()
    const heard = vi.fn()
    const stop = files.onRevoked(heard)
    host.notify('files/revoked', { handles: ['fh_in'] })
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith(['fh_in']))
    stop()
    await files.release([])
    await files.release(['fh_in'])
  })
})
