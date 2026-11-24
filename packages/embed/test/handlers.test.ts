import { describe, expect, it, vi } from 'vitest'
import { KitRpcError } from '@kition/kit-host'
import { createHandlers, normalizePath, type DocumentFiles } from '../src/handlers'
import { EmbedConflictError } from '../src/errors'
import { memoryReplicaStore } from '../src/replicaStore'
import { memoryStorage } from './memoryStorage'

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

function setUp(overrides: Partial<DocumentFiles> = {}) {
  const files = memoryStorage({ f1: 'hello world' })
  const onSaved = vi.fn()
  const onChanged = vi.fn()
  const version = { current: 'v1' }
  const handlers = createHandlers({ file: { id: 'f1', name: 'Launch.pptx' }, storage: files.storage, replicas: null, readOnly: false, version, onSaved, onChanged, ...overrides })
  return { files, handlers, onSaved, onChanged, version }
}

async function refusal(promise: unknown) {
  const error = await Promise.resolve(promise).then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(KitRpcError)
  return (error as KitRpcError).data as { reason: string }
}

describe('the document as the kit sees it', () => {
  it('is its file name, and reads it whole or in ranges', async () => {
    const { handlers } = setUp()
    const whole = await handlers.read({ path: 'Launch.pptx' })
    expect(decode(whole.bytes)).toBe('hello world')
    expect(whole).toMatchObject({ version: 'v1', size: 11 })
    expect(decode((await handlers.read({ path: './Launch.pptx', offset: 6, length: 5 })).bytes)).toBe('world')
    expect(await handlers.stamp({ path: 'Launch.pptx' })).toEqual({ version: 'v1' })
  })

  it('refuses reads outside the document, and stamps nothing else', async () => {
    const { handlers } = setUp()
    expect((await refusal(handlers.read({ path: 'Other.pptx' }))).reason).toBe('not-allowed')
    expect((await refusal(handlers.read({ path: '../Launch.pptx' }))).reason).toBe('not-allowed')
    expect(await handlers.stamp({ path: 'fonts/a.ttf' })).toEqual({ version: null })
  })

  it('normalizes the paths it compares', () => {
    expect(normalizePath('.\\a\\./b.txt')).toBe('a/b.txt')
    expect(normalizePath('/a//b')).toBe('a/b')
  })
})

describe('saving', () => {
  it('writes over the version it last saw, and reports the new one', async () => {
    const { files, handlers, onSaved, version } = setUp()
    const written = await handlers.write({ path: 'Launch.pptx', bytes: encode('changed'), mode: 'save' })
    expect(written).toEqual({ path: 'Launch.pptx', version: 'v2' })
    expect(files.text('f1')).toBe('changed')
    expect(onSaved).toHaveBeenCalledWith('v2')
    expect(version.current).toBe('v2')
    // The next save is over v2.
    await handlers.write({ path: 'Launch.pptx', bytes: encode('again'), mode: 'save' })
    expect(version.current).toBe('v3')
  })

  it('refuses a save over a file changed elsewhere as a conflict, and keeps the other write', async () => {
    const onConflict = vi.fn()
    const { files, handlers, onSaved } = setUp({ onConflict })
    files.writeElsewhere('f1', 'theirs')
    expect((await refusal(handlers.write({ path: 'Launch.pptx', bytes: encode('mine'), mode: 'save' }))).reason).toBe('conflict')
    expect(files.text('f1')).toBe('theirs')
    expect(onSaved).not.toHaveBeenCalled()
    expect(onConflict).toHaveBeenCalledWith(expect.any(EmbedConflictError))
  })

  it('takes the version the kit names over the one it last saw', async () => {
    const { files, handlers } = setUp()
    files.writeElsewhere('f1', 'theirs')
    await handlers.write({ path: 'Launch.pptx', bytes: encode('mine'), mode: 'save', expected: 'v2' })
    expect(files.text('f1')).toBe('mine')
  })

  /**
   * A storage that commits a write at once but answers it only after `delay` ms, as a server whose
   * response is still on its way: a second write sent in that time over the version the editor
   * last saw is stale.
   */
  function slowAnswers(files: ReturnType<typeof memoryStorage>, delay = 30) {
    const calls: Array<{ text: string; expectedVersion: string | null }> = []
    const write: typeof files.storage.write = async (fileId, bytes, options) => {
      calls.push({ text: new TextDecoder().decode(bytes), expectedVersion: options.expectedVersion })
      const written = await files.storage.write(fileId, bytes, options)
      await new Promise((resolve) => setTimeout(resolve, delay))
      return written
    }
    return { calls, storage: { ...files.storage, write } }
  }

  it('makes a second save wait for the first, over the version the first wrote', async () => {
    const onConflict = vi.fn()
    const files = memoryStorage({ f1: 'hello world' })
    const slow = slowAnswers(files)
    const { handlers } = setUp({ storage: slow.storage, onConflict })
    const [first, second] = await Promise.all([
      handlers.write({ path: 'Launch.pptx', bytes: encode('one'), mode: 'save' }),
      handlers.write({ path: 'Launch.pptx', bytes: encode('two'), mode: 'save' }),
    ])
    expect(first.version).toBe('v2')
    expect(second.version).toBe('v3')
    expect(slow.calls).toEqual([
      { text: 'one', expectedVersion: 'v1' },
      { text: 'two', expectedVersion: 'v2' },
    ])
    expect(files.text('f1')).toBe('two')
    expect(onConflict).not.toHaveBeenCalled()
  })

  it('does not write the same bytes twice in a row: the second save answers the version the first wrote', async () => {
    const onConflict = vi.fn()
    const files = memoryStorage({ f1: 'hello world' })
    const slow = slowAnswers(files)
    const { handlers, onSaved } = setUp({ storage: slow.storage, onConflict })
    const [first, second] = await Promise.all([
      handlers.write({ path: 'Launch.pptx', bytes: encode('same'), mode: 'save' }),
      handlers.write({ path: 'Launch.pptx', bytes: encode('same'), mode: 'save' }),
    ])
    expect(first.version).toBe('v2')
    expect(second.version).toBe('v2')
    expect(slow.calls).toHaveLength(1)
    expect(onSaved).toHaveBeenCalledWith('v2')
    expect(onConflict).not.toHaveBeenCalled()
  })

  it('still refuses the same bytes again as a conflict when the file changed elsewhere in between', async () => {
    const onConflict = vi.fn()
    const { files, handlers } = setUp({ onConflict })
    await handlers.write({ path: 'Launch.pptx', bytes: encode('same'), mode: 'save' })
    files.writeElsewhere('f1', 'theirs')
    expect((await refusal(handlers.write({ path: 'Launch.pptx', bytes: encode('same'), mode: 'save' }))).reason).toBe('conflict')
    expect(files.text('f1')).toBe('theirs')
    expect(onConflict).toHaveBeenCalledWith(expect.any(EmbedConflictError))
  })

  it('refuses a queued save as a conflict when the file changed elsewhere while the first was written', async () => {
    const onConflict = vi.fn()
    const files = memoryStorage({ f1: 'hello world' })
    const slow = slowAnswers(files)
    const { handlers } = setUp({ storage: slow.storage, onConflict })
    const first = handlers.write({ path: 'Launch.pptx', bytes: encode('one'), mode: 'save' })
    const second = handlers.write({ path: 'Launch.pptx', bytes: encode('two'), mode: 'save' })
    // Another person writes after the first save landed, before its answer came back.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slow.calls).toHaveLength(1)
    files.writeElsewhere('f1', 'theirs')
    expect((await first).version).toBe('v2')
    expect((await refusal(second)).reason).toBe('conflict')
    expect(files.text('f1')).toBe('theirs')
    expect(onConflict).toHaveBeenCalledTimes(1)
  })

  it('keeps saving after a refused save', async () => {
    const { files, handlers, version } = setUp()
    files.writeElsewhere('f1', 'theirs')
    await refusal(handlers.write({ path: 'Launch.pptx', bytes: encode('mine'), mode: 'save' }))
    // The kit reads the file again, then saves over it.
    await handlers.read({ path: 'Launch.pptx' })
    expect(version.current).toBe('v2')
    expect((await handlers.write({ path: 'Launch.pptx', bytes: encode('mine'), mode: 'save' })).version).toBe('v3')
  })

  it('refuses saves when read-only, and saves under another name', async () => {
    expect((await refusal(setUp({ readOnly: true }).handlers.write({ path: 'Launch.pptx', bytes: encode('x'), mode: 'save' }))).reason).toBe('not-allowed')
    expect((await refusal(setUp().handlers.write({ path: 'Copy.pptx', bytes: encode('x'), mode: 'save' }))).reason).toBe('not-allowed')
  })
})

describe('new files', () => {
  it('turns an export or a new file into storage.create, under the path’s file name', async () => {
    const { files, handlers } = setUp({ readOnly: true })
    expect(await handlers.write({ path: 'exports/Launch.pdf', bytes: encode('pdf'), mode: 'export' })).toEqual({ path: 'Launch.pdf', version: '' })
    expect(files.created).toEqual([{ name: 'Launch.pdf', text: 'pdf' }])
  })

  it('refuses them without storage.create', async () => {
    const { files } = setUp()
    const { create: _create, ...withoutCreate } = files.storage
    const handlers = createHandlers({ file: { id: 'f1', name: 'Launch.pptx' }, storage: withoutCreate, replicas: null, readOnly: false, version: { current: 'v1' }, onSaved: () => undefined, onChanged: () => undefined })
    expect((await refusal(handlers.write({ path: 'Launch.pdf', bytes: encode('pdf'), mode: 'export' }))).reason).toBe('not-allowed')
  })
})

describe('capabilities', () => {
  it('serves no replica without a replica store, and only the document’s with one', async () => {
    expect(setUp().handlers.replicaRead).toBeUndefined()
    expect(setUp().handlers.replicaWrite).toBeUndefined()
    expect(setUp().handlers.pick).toBeUndefined()
    expect(setUp().handlers.openAgent).toBeUndefined()

    const replicas = memoryReplicaStore()
    const { handlers } = setUp({ replicas })
    expect(await handlers.replicaRead!({ path: 'Launch.pptx' })).toBeNull()
    await handlers.replicaWrite!({ path: 'Launch.pptx', snapshot: encode('s'), blobs: new ArrayBuffer(0), fileStamp: 'v1', version: new ArrayBuffer(1) })
    expect(await replicas.read('f1')).toMatchObject({ fileStamp: 'v1' })
    expect(decode((await handlers.replicaRead!({ path: 'Launch.pptx' }))!.snapshot)).toBe('s')
    expect((await refusal(handlers.replicaRead!({ path: 'Other.pptx' }))).reason).toBe('not-allowed')
  })

  it('in a managed room, serves no replica of an earlier version of the file (a new generation, 1.3)', async () => {
    const replicas = memoryReplicaStore()
    const { handlers, files } = setUp({ replicas, managedRoom: () => true })
    await handlers.replicaWrite!({ path: 'Launch.pptx', snapshot: encode('s'), blobs: new ArrayBuffer(0), fileStamp: 'v1', version: new ArrayBuffer(1) })
    expect(decode((await handlers.replicaRead!({ path: 'Launch.pptx' }))!.snapshot)).toBe('s')
    // Changed outside the room (an upload): the replica is the earlier generation's document, and
    // a kit that merges the file into it would open that document, whose room is not this one.
    files.writeElsewhere('f1', 'uploaded')
    expect(await handlers.replicaRead!({ path: 'Launch.pptx' })).toBeNull()
  })

  it('reports the document’s changes', () => {
    const { handlers, onChanged } = setUp()
    handlers.changed({ dirty: true, revision: 3, title: 'Launch', by: 'agent' })
    expect(onChanged).toHaveBeenCalledWith({ dirty: true, revision: 3, title: 'Launch', by: 'agent' })
  })
})

describe('view state (Kit UI protocol section 7n)', () => {
  it('passes through to the storage\'s view-state store by file id, for the document only, and is absent without it', async () => {
    const files = memoryStorage({ f1: 'hello world' })
    expect(setUp().handlers.viewState).toBeUndefined()
    const kept = new Map<string, { state: Record<string, unknown> | null; bytes?: ArrayBuffer }>()
    const storage = { ...files.storage, viewState: { read: async (id: string) => kept.get(id) ?? { state: null }, write: async (id: string, value: { state: Record<string, unknown> | null }) => void kept.set(id, value) } }
    const { handlers } = setUp({ storage })
    expect(handlers.checkpoints).toBeUndefined()
    await handlers.viewState!.write({ path: 'Launch.pptx', state: { slide: 3 } })
    expect(kept.get('f1')).toEqual({ state: { slide: 3 } })
    expect(await handlers.viewState!.read({ path: 'Launch.pptx' })).toEqual({ state: { slide: 3 } })
    expect((await refusal(handlers.viewState!.read({ path: 'Other.pptx' }))).reason).toBe('not-allowed')
  })
})
