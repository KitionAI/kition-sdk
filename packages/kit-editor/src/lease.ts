/**
 * Leases for coordinated objects, as a kit's editor uses them (Kit UI protocol section 7b,
 * capability `lease`): before an edit that does not merge meaningfully (painting a layer's
 * pixels, rewriting a whole file), the kit asks the host for a lease on the object's scope; the
 * host takes it from the sync server and keeps it until the kit releases it or closes. The kit
 * hears every lease of the document, so it can show what someone else is editing and refuse to
 * edit it, before anyone has to wait for a refusal.
 *
 * With a host that does not serve `lease` (no co-editing), every acquire is granted with no lease:
 * there is nobody to coordinate with.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { KitRpcError, LEASE_HELD_REASON, type KitLease } from '@kition/kit-ui-protocol'
import type { HostConnection } from './host'
import { useKitEditor } from './editor'

export type { KitLease }

/**
 * What `acquire` answers: granted (`lease` null when nobody is there to coordinate with, which
 * includes a host that is offline: edits made then are allowed, and land as conflict objects if
 * someone else held the lease meanwhile), or refused, with who holds it when another session does.
 */
export type LeaseOutcome = { granted: true; lease: KitLease | null } | { granted: false; reason: 'held' | 'read-only'; holder: KitLease['holder'] | null }

/** A document's leases, seen from its kit. */
export type KitLeases = {
  /** The host serves leases (the document may be co-edited). */
  readonly available: boolean
  /** The document's leases as last heard. */
  list: () => KitLease[]
  subscribe: (listener: () => void) => () => void
  /** The lease another session holds on a scope colliding with `scope`, if any. */
  heldByOther: (scope: string) => KitLease | null
  acquire: (scope: string, ttl?: number) => Promise<LeaseOutcome>
  release: (scope: string) => Promise<void>
}

/** Whether two scopes collide: equal, or either is `*` (the whole document). */
export function scopesCollide(a: string, b: string) {
  return a === b || a === '*' || b === '*'
}

/** The lease in `leases` another session holds on a scope colliding with `scope`, if any. */
export function leaseHeldByOther(leases: readonly KitLease[], scope: string): KitLease | null {
  return leases.find((lease) => !lease.holder.self && scopesCollide(lease.scope, scope)) ?? null
}

const EMPTY: KitLease[] = []
const stores = new WeakMap<HostConnection, KitLeases>()

function validLeases(value: unknown): KitLease[] {
  if (!Array.isArray(value)) return EMPTY
  return value.filter((lease): lease is KitLease => Boolean(lease) && typeof lease.scope === 'string' && typeof lease.holder?.name === 'string')
}

function make(host: HostConnection): KitLeases {
  const available = host.init.capabilities.includes('lease')
  let leases: KitLease[] = EMPTY
  const listeners = new Set<() => void>()
  const set = (next: KitLease[]) => {
    leases = next.length ? next : EMPTY
    for (const listener of [...listeners]) listener()
  }
  if (available) {
    // A change heard before the first list arrives is newer than that list.
    let heard = false
    host.peer.on('lease/changed', (params) => {
      heard = true
      set(validLeases(params?.leases))
    })
    host.peer.request('host/leases', {}).then(
      (result) => {
        if (!heard) set(validLeases(result?.leases))
      },
      () => undefined,
    )
  }
  return {
    available,
    list: () => leases,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    heldByOther: (scope) => leaseHeldByOther(leases, scope),
    acquire: async (scope, ttl) => {
      if (host.readOnly) return { granted: false, reason: 'read-only', holder: null }
      if (!available) return { granted: true, lease: null }
      try {
        const { lease } = await host.peer.request('host/leaseAcquire', ttl === undefined ? { scope } : { scope, ttl })
        return { granted: true, lease: lease ?? null }
      } catch (error) {
        const data = error instanceof KitRpcError ? (error.data as { reason?: unknown; lease?: KitLease } | undefined) : undefined
        if (data?.reason === LEASE_HELD_REASON) return { granted: false, reason: 'held', holder: data.lease?.holder ?? null }
        if (data?.reason === 'read-only') return { granted: false, reason: 'read-only', holder: null }
        // Anything else (a host that lost its connection) leaves nobody to coordinate with.
        return { granted: true, lease: null }
      }
    },
    release: async (scope) => {
      if (!available) return
      await host.peer.request('host/leaseRelease', { scope }).catch(() => undefined)
    },
  }
}

/** The document's leases for the kit connected through `host` (one store per connection). */
export function kitLeases(host: HostConnection): KitLeases {
  let store = stores.get(host)
  if (!store) stores.set(host, (store = make(host)))
  return store
}

/** The document's leases, following changes (inside `KitEditorProvider`). */
export function useLeases(): KitLeases & { leases: KitLease[] } {
  const store = kitLeases(useKitEditor().host)
  const leases = useSyncExternalStore(store.subscribe, store.list, store.list)
  return useMemo(() => ({ ...store, leases }), [store, leases])
}

/**
 * One scope's lease (inside `KitEditorProvider`): `heldBy` is who else holds it (or a colliding
 * scope), `mine` whether this session does; `acquire` and `release` act on it. `scope` null
 * (nothing to coordinate) is never held.
 */
export function useLease(scope: string | null) {
  const { leases, acquire, release } = useLeases()
  const heldBy = scope ? (leaseHeldByOther(leases, scope)?.holder ?? null) : null
  const mine = scope ? leases.some((lease) => lease.holder.self && lease.scope === scope) : false
  const take = useCallback((ttl?: number) => (scope ? acquire(scope, ttl) : Promise.resolve<LeaseOutcome>({ granted: true, lease: null })), [acquire, scope])
  const drop = useCallback(() => (scope ? release(scope) : Promise.resolve()), [release, scope])
  return { heldBy, mine, acquire: take, release: drop }
}
