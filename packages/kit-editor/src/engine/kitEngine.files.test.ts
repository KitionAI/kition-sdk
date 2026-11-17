// @vitest-environment jsdom
/**
 * Files through the engine worker (engine contract E15, E16): the bytes of a granted file the binding lends
 * reach the engine's synchronous `kitionHost` reads under its handle, never as a lent path, and
 * end with the document; a command's outputs come out with `takeOutput` in chunks.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

type Host = { size: (file: string) => number; readRange: (file: string, offset: number, length: number) => Uint8Array }
const host = () => (globalThis as unknown as { kitionHost: Host }).kitionHost

/** A document whose engine reads files through `kitionHost` and keeps one output, as the SDK's `Outputs` does. */
function fakeDocument({ outputs = true } = {}) {
  let output: Uint8Array | null = null
  fake.doc = {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string, params: string) => {
      const { file } = JSON.parse(params) as { file?: string }
      if (command === 'read') return JSON.stringify({ size: host().size(file!), head: [...host().readRange(file!, 0, 3)] })
      output = new TextEncoder().encode('P5\n1 1\n255\n\u0000')
      return JSON.stringify({ outputs: [{ id: 'out-1', suggestedName: 'a.pgm', mime: 'image/x-portable-graymap', size: output.byteLength }] })
    },
    inspect: () => '{}',
    commands: () => '[]',
    save: () => new Uint8Array(),
    markSaved: () => undefined,
    free: () => undefined,
    ...(outputs
      ? {
          takeOutput: (id: string, max?: number) => {
            if (id !== 'out-1' || !output) throw new Error(`there is no output ${id}`)
            const chunk = output.slice(0, max ?? output.byteLength)
            output = output.byteLength > chunk.byteLength ? output.slice(chunk.byteLength) : null
            return chunk
          },
        }
      : {}),
  }
}

async function open(lent: { root: string; folder: string } | null = null) {
  await handle({ method: 'open', manifest: { kitId: 'kit.test' } as KitModuleManifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent })
}

describe('files through the engine worker', () => {
  it('serves a granted file’s lent bytes under its handle, and only while that document is open', async () => {
    fakeDocument()
    await open()
    await handle({ method: 'lendHandle', handle: 'fh_1', bytes: new TextEncoder().encode('a,b\n1,2\n').buffer })
    const read = await handle({ method: 'execute', command: 'read', params: { file: 'fh_1' } })
    expect(JSON.parse((read.value as { result: string }).result)).toEqual({ size: 8, head: [97, 44, 98] })
    expect(() => host().readRange('fh_2', 0, 1)).toThrow(/not granted/)
    // Taken back, or another document opened: the handle reads nothing.
    await handle({ method: 'lendHandle', handle: 'fh_1', bytes: null })
    expect(() => host().size('fh_1')).toThrow(/not granted/)
    await handle({ method: 'lendHandle', handle: 'fh_1', bytes: new Uint8Array([1]).buffer })
    await open()
    expect(() => host().size('fh_1')).toThrow(/not granted/)
    // Only handles are lent this way.
    await expect(handle({ method: 'lendHandle', handle: 'media/a.csv', bytes: new Uint8Array([1]).buffer })).rejects.toThrow(/not a file handle/)
  })

  it('a handle never reads a lent file of the same name', async () => {
    fakeDocument()
    await open({ root: 'https://files.test/', folder: '' })
    expect(() => host().size('fh_lent')).toThrow(/not granted/)
  })

  it('takes a command’s output in chunks; the engine forgets it once taken', async () => {
    fakeDocument()
    await open()
    const exported = (await handle({ method: 'execute', command: 'export', params: {} })).value as { result: string }
    const answer = JSON.parse(exported.result) as { outputs: Array<{ id: string; size: number }> }
    const [{ id, size }] = answer.outputs
    const chunks: Uint8Array[] = []
    for (let taken = 0; taken < size; ) {
      const chunk = new Uint8Array((await handle({ method: 'takeOutput', id, max: 5 })).value as ArrayBuffer)
      chunks.push(chunk)
      taken += chunk.byteLength
    }
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([5, 5, 2])
    expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe('P5\n1 1\n255\n\u0000')
    await expect(handle({ method: 'takeOutput', id })).rejects.toThrow(/no output/)
    // `takeOutput` is the contract's: an editor cannot reach it through `invoke`.
    await expect(handle({ method: 'invoke', name: 'takeOutput', args: [id] })).rejects.toThrow(/no method takeOutput/)
  })

  it('an engine without outputs refuses every id', async () => {
    fakeDocument({ outputs: false })
    await open()
    await expect(handle({ method: 'takeOutput', id: 'out-1' })).rejects.toThrow(/no output out-1/)
  })
})
