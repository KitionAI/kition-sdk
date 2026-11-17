// @vitest-environment jsdom
import { KitPeer, KitRpcError, LEASE_HELD_REASON, type HostPeer, type KitLease, type KitSidePeer } from '@kition/kit-ui-protocol'
import { describe, expect, it, vi } from 'vitest'
import { parseConflicts, reportConflicts } from './conflicts'
import type { HostConnection } from './host'
import { kitLeases, leaseHeldByOther, scopesCollide } from './lease'

const alice: KitLease = { scope: 'layer-1', holder: { principalId: 'p1', name: 'Alice', self: false } }
const mine: KitLease = { scope: 'layer-2', holder: { principalId: 'p2', name: 'Bob', self: true } }

/** A kit's host connection over a real channel, and the host's end of it. */
function connection(capabilities: string[], readOnly = false) {
  const channel = new MessageChannel()
  const peer: KitSidePeer = new KitPeer(channel.port1, 'k')
  const host: HostPeer = new KitPeer(channel.port2, 'h')
  const kit = { peer, init: { capabilities }, readOnly } as unknown as HostConnection
  return { kit, host }
}

describe('leaseHeldByOther', () => {
  it('finds another session\'s lease on the scope or the whole document', () => {
    expect(leaseHeldByOther([alice, mine], 'layer-1')).toBe(alice)
    expect(leaseHeldByOther([alice, mine], 'layer-2')).toBeNull()
    expect(leaseHeldByOther([{ ...alice, scope: '*' }], 'layer-9')?.holder.name).toBe('Alice')
    expect(scopesCollide('*', 'x')).toBe(true)
  })
})

describe('kitLeases', () => {
  it('grants every acquire without a lease when the host serves none', async () => {
    const { kit } = connection([])
    const leases = kitLeases(kit)
    expect(leases.available).toBe(false)
    expect(await leases.acquire('layer-1')).toEqual({ granted: true, lease: null })
    expect(leases.list()).toEqual([])
  })

  it('refuses on a read-only document', async () => {
    const { kit } = connection(['lease'], true)
    expect(await kitLeases(kit).acquire('layer-1')).toEqual({ granted: false, reason: 'read-only', holder: null })
  })

  it('reads the leases, follows changes, and takes, refuses, and releases leases through the host', async () => {
    const { kit, host } = connection(['lease'])
    const released: string[] = []
    host.handle('host/leases', () => ({ leases: [alice] }))
    host.handle('host/leaseAcquire', ({ scope }) => {
      if (scope === 'layer-1') throw new KitRpcError(-32000, 'held', { reason: LEASE_HELD_REASON, lease: alice })
      if (scope === 'offline') throw new KitRpcError(-32000, 'the sync server cannot be reached')
      return { lease: { scope, holder: mine.holder } }
    })
    host.handle('host/leaseRelease', ({ scope }) => {
      released.push(scope)
      return {}
    })
    const leases = kitLeases(kit)
    expect(kitLeases(kit)).toBe(leases)
    const heard = vi.fn()
    leases.subscribe(heard)
    await vi.waitFor(() => expect(leases.list()).toEqual([alice]))
    expect(leases.heldByOther('layer-1')).toEqual(alice)

    expect(await leases.acquire('layer-1')).toEqual({ granted: false, reason: 'held', holder: alice.holder })
    expect(await leases.acquire('layer-2', 5_000)).toEqual({ granted: true, lease: { scope: 'layer-2', holder: mine.holder } })
    // A host that cannot reach anyone leaves nobody to coordinate with: the edit goes ahead.
    expect(await leases.acquire('offline')).toEqual({ granted: true, lease: null })
    await leases.release('layer-2')
    expect(released).toEqual(['layer-2'])

    host.notify('lease/changed', { leases: [mine] })
    await vi.waitFor(() => expect(leases.list()).toEqual([mine]))
    expect(leases.heldByOther('layer-1')).toBeNull()
    expect(heard).toHaveBeenCalledTimes(2)
    host.notify('lease/changed', { leases: [] })
    await vi.waitFor(() => expect(leases.list()).toEqual([]))
  })
})

describe('conflicts', () => {
  it('parses an engine\'s list and reports it only when it changed', async () => {
    expect(parseConflicts('not json')).toEqual([])
    expect(parseConflicts(JSON.stringify([{ id: 'b', kind: 'k', summary: 's', extra: 1 }, { id: 'a', kind: 'k', summary: 't' }, { id: 3 }]))).toEqual([
      { id: 'a', kind: 'k', summary: 't' },
      { id: 'b', kind: 'k', summary: 's' },
    ])
    const { kit, host } = connection([])
    const heard: unknown[] = []
    host.on('document/conflicts', (params) => heard.push(params))
    const one = [{ id: 'a', kind: 'pdf.droppedEdit', summary: 'An edit was dropped' }]
    reportConflicts(kit, [])
    reportConflicts(kit, one)
    reportConflicts(kit, one)
    reportConflicts(kit, [])
    await vi.waitFor(() => expect(heard).toEqual([{ conflicts: one }, { conflicts: [] }]))
  })
})
