import { describe, expect, it, vi } from 'vitest'
import type { KitHost, KitStoredReplica } from './kitHost'
import { replicaToOpen, writeWithReplica } from './replica'

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
    const replica = { snapshot: bytes(7), blobs: bytes(8) }
    await expect(writeWithReplica(host, 'a.psd', new Uint8Array([1]), replica, 'v1')).rejects.toThrow('stale')
    expect(stored.size).toBe(0)
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), replica, 'v2')).toBe('v3')
    expect(stored.get('a.psd')?.fileStamp).toBe('v3')
  })

  it('stores the replica under the stamp the write answered', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v1', stored)
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8) })).toBe('v2')
    expect(stored.get('a.psd')?.fileStamp).toBe('v2')
  })

  it('takes the file stamp after the write when the write answers none', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v3', stored, { write: async () => undefined })
    expect(await writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8) })).toBe('v3')
    expect(stored.get('a.psd')?.fileStamp).toBe('v3')
  })

  it('keeps the saved file when the replica cannot be stored, and stores nothing without one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = fakeHost('v1', new Map(), { replicaWrite: async () => Promise.reject(new Error('disk full')) })
    expect(await writeWithReplica(failing, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8) })).toBe('v2')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    const stored = new Map<string, KitStoredReplica>()
    await writeWithReplica(fakeHost('v1', stored), 'a.psd', new Uint8Array([1]), null)
    expect(stored.size).toBe(0)
  })

  it('fails as the file write fails, before any replica is stored', async () => {
    const stored = new Map<string, KitStoredReplica>()
    const host = fakeHost('v1', stored, { write: async () => Promise.reject(new Error('conflict')) })
    await expect(writeWithReplica(host, 'a.psd', new Uint8Array([1]), { snapshot: bytes(7), blobs: bytes(8) })).rejects.toThrow('conflict')
    expect(stored.size).toBe(0)
  })
})
