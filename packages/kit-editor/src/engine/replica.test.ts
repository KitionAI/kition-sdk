import { describe, expect, it, vi } from 'vitest'
import type { KitHost, KitStoredReplica, KitWrittenReplica } from './kitHost'
import { deleteCheckpoint, listCheckpoints, readCheckpoint, readViewState, replicaToOpen, updateCheckpoint, writeViewState, writeWithReplica } from './replica'

const bytes = (...values: number[]) => new Uint8Array(values).buffer

/** A host whose file is at `stamp` and which stores replicas in `stored`. */
function fakeHost(stamp: string | null, stored: Map<string, KitStoredReplica> = new Map(), overrides: Partial<KitHost> = {}): KitHost {
  return {
    read: async () => ({ bytes: bytes(1), stamp }),
    stamp: async () => stamp,
    write: async () => 'v2',
    replicaRead: async (path) => stored.get(path) ?? null,
    replicaWrite: async (path, replica) => {
      stored.set(path, replica)
    },
    ...overrides,
  }
}

describe('replicaToOpen', () => {
  it('opens with the replica saved with the file as it is now', async () => {
    const stored = new Map([['a.psd', { snapshot: bytes(7), blobs: bytes(8), fileStamp: 'v1' }]])
    const replica = await replicaToOpen(fakeHost('v1', stored), 'a.psd', 'v1')
    expect(new Uint8Array(replica!.snapshot)).toEqual(new Uint8Array([7]))
    expect(new Uint8Array(replica!.blobs)).toEqual(new Uint8Array([8]))
  })

  it('opens plainly when the file changed since, nothing is stored, or the host fails', async () => {
    const stored = new Map([['a.psd', { snapshot: bytes(7), blobs: bytes(8), fileStamp: 'v1' }]])
    expect(await replicaToOpen(fakeHost('v9', stored), 'a.psd', 'v9')).toBeNull()
    expect(await replicaToOpen(fakeHost('v1', stored), 'b.psd', 'v1')).toBeNull()
    expect(await replicaToOpen(fakeHost('v1', stored, { replicaRead: async () => Promise.reject(new Error('gone')) }), 'a.psd', 'v1')).toBeNull()
    expect(await replicaToOpen(fakeHost('v1', stored, { replicaRead: undefined }), 'a.psd', 'v1')).toBeNull()
  })

  it('opens the stored replica whatever the stamp for an engine that merges the file (mergesFile)', async () => {
    const stored = new Map([['a.md', { snapshot: bytes(7), blobs: bytes(8), fileStamp: 'v1' }]])
    const replica = await replicaToOpen(fakeHost('v9', stored), 'a.md', 'v9', true)
    expect(new Uint8Array(replica!.snapshot)).toEqual(new Uint8Array([7]))
    expect(await replicaToOpen(fakeHost('v9', stored), 'b.md', 'v9', true)).toBeNull()
  })

  it('asks the host for the stamp when the read had none', async () => {
    const stored = new Map([['a.psd', { snapshot: bytes(7), blobs: bytes(8), fileStamp: 'v1' }]])
    expect(await replicaToOpen(fakeHost('v1', stored), 'a.psd', null)).not.toBeNull()
    expect(await replicaToOpen(fakeHost(null, stored), 'a.psd', null)).toBeNull()
  })
})

describe('writeWithReplica', () => {
  it('keeps the expected version across serialization and refuses stale replica writes', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v2', stored, {
      write: async (_path, _bytes, expected) => {
        if (expected !== 'v2') throw new Error('stale')
        return 'v3'
      },
    })
    const replica = { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) }
    await expect(writeWithReplica(host, 'a.psd', new Uint8Array([1]), replica, 'v1')).rejects.toThrow('stale')
    expect(stored.size).toBe(0)
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), replica, 'v2')).toBe('v3')
    expect(stored.get('a.psd')?.fileStamp).toBe('v3')
  })

  it('stores the replica under the stamp the write answered', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v1', stored)
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) })).toBe('v2')
    expect(stored.get('a.psd')?.fileStamp).toBe('v2')
  })

  it('takes the file stamp after the write when the write answers none', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v3', stored, { write: async () => undefined })
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) })).toBe('v3')
    expect(stored.get('a.psd')?.fileStamp).toBe('v3')
  })

  it('keeps the saved file when the replica cannot be stored, and stores nothing without one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = fakeHost('v1', new Map(), { replicaWrite: async () => Promise.reject(new Error('disk full')) })
    expect(await writeWithReplica(failing, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) })).toBe('v2')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    const stored = new Map<string, KitStoredReplica>()
    await writeWithReplica(fakeHost('v1', stored), 'a.psd', new Uint8Array([1]), null)
    expect(stored.size).toBe(0)
  })

  it('fails as the file write fails, before any replica is stored', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v1', stored, { write: async () => Promise.reject(new Error('conflict')) })
    await expect(writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) })).rejects.toThrow('conflict')
    expect(stored.size).toBe(0)
  })
})

describe('checkpoints and view state (Kit UI protocol sections 7m, 7n)', () => {
  const replica = { snapshot: bytes(7), blobs: bytes(8), version: bytes(9) }
  const checkpoint = { id: 'c1', time: 1, origin: 'kit', label: 'Sent', version: 'AQ==', available: true }

  it('without the capabilities, the helpers answer null and do nothing', async () => {
    const host = fakeHost('v1')
    expect(await listCheckpoints(host, 'a.kdesign')).toBeNull()
    expect(await updateCheckpoint(host, 'a.kdesign', 'c1', { label: 'x' })).toBeNull()
    expect(await deleteCheckpoint(host, 'a.kdesign', 'c1')).toBe(false)
    expect(await readCheckpoint(host, 'a.kdesign', 'c1')).toBeNull()
    expect(await readViewState(host, 'a.kdesign')).toBeNull()
    expect(await writeViewState(host, 'a.kdesign', { state: { zoom: 2 } })).toBe(false)
  })

  it('a save without checkpoints records none and asks for none', async () => {
    const asked: unknown[] = []
    const host = fakeHost('v1', new Map(), {
      replicaWrite: async (_path, _replica, request) => {
        asked.push(request)
      },
    })
    const recorded: unknown[] = []
    expect(await writeWithReplica(host, 'a.kdesign', new Uint8Array([1]), replica, 'v1', { checkpoint: { label: 'Sent' }, recorded: (made) => recorded.push(made) })).toBe('v2')
    expect(asked).toEqual([undefined])
    expect(recorded).toEqual([null])
  })

  it('records the checkpoint in the replica write and hears it', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const requests: unknown[] = []
    const host = fakeHost('v1', stored, {
      replicaWrite: async (path, written, request) => {
        stored.set(path, written)
        requests.push(request)
        return checkpoint
      },
      checkpoints: { list: async () => ({ checkpoints: [checkpoint], more: false }), update: async () => checkpoint, delete: async () => undefined, read: async () => ({ checkpoint, blobs: bytes(5) }) },
    })
    const recorded: unknown[] = []
    await writeWithReplica(host, 'a.kdesign', new Uint8Array([1]), replica, 'v1', { checkpoint: { label: 'Sent' }, recorded: (made) => recorded.push(made) })
    expect(requests).toEqual([{ label: 'Sent' }])
    expect(recorded).toEqual([checkpoint])
    expect(stored.get('a.kdesign')?.fileStamp).toBe('v2')
    // The checkpoint is asked at the version taken with the saved bytes (UI-R6).
    expect(new Uint8Array((stored.get('a.kdesign') as KitWrittenReplica).version)).toEqual(new Uint8Array([9]))
    expect(await listCheckpoints(host, 'a.kdesign')).toEqual({ checkpoints: [checkpoint], more: false })
    expect(await deleteCheckpoint(host, 'a.kdesign', 'c1')).toBe(true)
  })

  it('a refused checkpoint does not fail the save', async () => {
    const host = fakeHost('v1', new Map(), {
      replicaWrite: async () => Promise.reject(new Error('too-long')),
      checkpoints: { list: async () => ({ checkpoints: [], more: false }), update: async () => checkpoint, delete: async () => undefined, read: async () => ({ checkpoint, blobs: bytes(5) }) },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recorded: unknown[] = []
    expect(await writeWithReplica(host, 'a.kdesign', new Uint8Array([1]), replica, 'v1', { checkpoint: { label: 'x' }, recorded: (made) => recorded.push(made) })).toBe('v2')
    expect(recorded).toEqual([null])
    warn.mockRestore()
  })

  it('writes the view state after the file, and a failed write does not fail the save', async () => {
    const order: string[] = []
    const written: unknown[] = []
    const host = fakeHost('v1', new Map(), {
      write: async () => {
        order.push('file')
        return 'v2'
      },
      viewState: {
        read: async () => ({ state: null }),
        write: async (_path, value) => {
          order.push('view')
          written.push(value)
        },
      },
    })
    expect(await writeWithReplica(host, 'a.kdesign', new Uint8Array([1]), replica, 'v1', { viewState: { state: { v: 1, zoom: 2 } } })).toBe('v2')
    expect(order).toEqual(['file', 'view'])
    expect(written).toEqual([{ state: { v: 1, zoom: 2 } }])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = fakeHost('v1', new Map(), { viewState: { read: async () => Promise.reject(new Error('gone')), write: async () => Promise.reject(new Error('disk full')) } })
    expect(await writeWithReplica(failing, 'a.kdesign', new Uint8Array([1]), replica, 'v1', { viewState: { state: { zoom: 2 } } })).toBe('v2')
    expect(await writeViewState(failing, 'a.kdesign', { state: { zoom: 2 } })).toBe(false)
    expect(await readViewState(failing, 'a.kdesign')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reads none kept as null, and null deletes', async () => {
    const kept: unknown[] = []
    const host = fakeHost('v1', new Map(), { viewState: { read: async () => ({ state: null }), write: async (_path, value) => void kept.push(value) } })
    expect(await readViewState(host, 'a.kdesign')).toBeNull()
    expect(await writeViewState(host, 'a.kdesign', null)).toBe(true)
    expect(kept).toEqual([{ state: null }])
  })
})

describe('view state stays out of the document (regressions/issue-view-state-outside-content)', () => {
  it('a save with view state writes it only to the view-state store, never into the file bytes or the replica', async () => {
    const marker = 'VIEWSTATE-MARKER'
    const text = (buffer: ArrayBuffer | Uint8Array) => new TextDecoder().decode(buffer)
    const files: string[] = []
    const replicas: string[] = []
    const views: string[] = []
    const host = fakeHost('v1', new Map(), {
      write: async (_path, written) => {
        files.push(text(written))
        return 'v2'
      },
      replicaWrite: async (_path, replica) => {
        replicas.push(text(replica.snapshot) + text(replica.blobs) + replica.fileStamp)
      },
      viewState: { read: async () => ({ state: null }), write: async (_path, value) => void views.push(JSON.stringify(value.state) + text(value.bytes ?? new ArrayBuffer(0))) },
    })
    const content = new TextEncoder().encode('content')
    const replica = { snapshot: new TextEncoder().encode('snapshot').buffer as ArrayBuffer, blobs: new TextEncoder().encode('blobs').buffer as ArrayBuffer, version: new ArrayBuffer(0) }
    await writeWithReplica(host, 'a.kphoto', content, replica, 'v1', { viewState: { state: { v: 1, marker }, bytes: new TextEncoder().encode(marker).buffer as ArrayBuffer } })
    expect(files).toEqual(['content'])
    expect(replicas).toEqual(['snapshotblobsv2'])
    expect(views.join('')).toContain(marker)
    for (const kept of [...files, ...replicas]) expect(kept).not.toContain(marker)
  })
})
