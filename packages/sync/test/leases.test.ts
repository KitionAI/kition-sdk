/**
 * `SyncClient.leases` (protocol 1.5, section 8) against `FakeServer`: taking, refusing, releasing,
 * and holding leases, and every room member hearing the lease list.
 */
import { describe, expect, it } from 'vitest'
import { SyncClient } from '../src/client'
import { DocumentLeases, leaseHolder, scopesCollide, SyncLeases } from '../src/leases'
import type { Lease } from '../src/protocol'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const ash: Identity = { id: 'pA', name: 'Ash', color: '#f00' }
const bo: Identity = { id: 'pB', name: 'Bo', color: '#00f' }

async function connected(server: FakeServer, token: string, identity: Identity) {
  server.identify(token, identity)
  const { factory, sockets } = fakeTransport(server)
  const client = new SyncClient({ createTransport: factory })
  await client.connect('ws://fake', token)
  return { client, sockets }
}

async function room(leasesEnabled = true) {
  const server = new FakeServer()
  server.leasesEnabled = leasesEnabled
  const a = await connected(server, 'a', ash)
  const b = await connected(server, 'b', bo)
  await a.client.createRoom('doc1', new Uint8Array([1]), 'Poster', 'kit.photo')
  await a.client.join('doc1')
  await b.client.join('doc1')
  return { server, a: a.client, b: b.client, bSockets: b.sockets }
}

/** Resolves with the next lease list `client` hears for doc1. */
const nextList = (client: SyncClient) => new Promise<Lease[]>((resolve) => {
  const off = client.leases.onChanged('doc1', (leases) => {
    off()
    resolve(leases)
  })
})

describe('SyncClient leases', () => {
  it('is available only against a server that keeps leases', async () => {
    const { a } = await room(false)
    expect(a.leases.available).toBe(false)
    const { a: withLeases } = await room(true)
    expect(withLeases.leases.available).toBe(true)
  })

  it('takes a lease, tells everyone, refuses another session, and frees it on release', async () => {
    const { a, b } = await room()
    const heardByB = nextList(b)
    const lease = await a.leases.acquire('doc1', 'layer-1')
    expect(lease).toMatchObject({ scope: 'layer-1', principalId: 'pA', name: 'Ash' })
    expect(a.leases.mine(lease)).toBe(true)
    expect(await heardByB).toEqual([expect.objectContaining({ scope: 'layer-1', name: 'Ash' })])
    expect(b.leases.list('doc1')).toHaveLength(1)
    expect(b.leases.mine(b.leases.list('doc1')[0])).toBe(false)

    const refused = await b.leases.acquire('doc1', 'layer-1').catch((error: unknown) => error)
    expect(leaseHolder(refused)).toMatchObject({ scope: 'layer-1', name: 'Ash' })
    expect(leaseHolder(new Error('other'))).toBeUndefined()

    const freed = nextList(b)
    await a.leases.release('doc1', 'layer-1')
    expect(await freed).toEqual([])
    await expect(b.leases.acquire('doc1', 'layer-1')).resolves.toMatchObject({ name: 'Bo' })
  })

  it('forgets the lists and loses its holds when the connection drops', async () => {
    const { a, b, bSockets } = await room()
    await a.leases.acquire('doc1', 'page')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(b.leases.list('doc1')).toHaveLength(1)
    await b.leases.acquire('doc1', 'other')
    const hold = await b.leases.hold('doc1', 'third')
    let lost = false
    hold.onLost(() => {
      lost = true
    })
    const emptied = nextList(b)
    bSockets.at(-1)!.close()
    expect(await emptied).toEqual([])
    expect(lost).toBe(true)
    expect(b.leases.list('doc1')).toEqual([])
  })
})

describe('SyncLeases.mine', () => {
  it('tells listeners again once the first acquire names this session, since the list came first', async () => {
    let session = ''
    const leases = new SyncLeases({
      request: async (_method, params) => {
        // As a real server does: the room hears the new lease before the acquire is answered.
        leases.receive({ docId: 'doc1', leases: [{ scope: params.scope, principalId: 'p', name: 'P', session: 's9', ttl: 1 }] })
        return { lease: { scope: params.scope, principalId: 'p', name: 'P', session: 's9', ttl: 1 } }
      },
      available: () => true,
    })
    const heard: boolean[] = []
    leases.onChanged('doc1', (list) => heard.push(leases.mine(list[0])))
    session = (await leases.acquire('doc1', 'x')).session
    expect(session).toBe('s9')
    expect(heard).toEqual([false, true])
  })
})

describe('SyncLeases.hold', () => {
  it('renews at half the ttl until released', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const timers: Array<() => void> = []
    const leases = new SyncLeases({
      request: async (method, params) => {
        calls.push({ method, params })
        return method === 'lease/acquire' ? { lease: { scope: params.scope, principalId: 'p', name: 'P', session: 's1', ttl: 10_000 } } : {}
      },
      available: () => true,
      setTimeout: (run) => timers.push(run),
      clearTimeout: () => undefined,
    })
    const hold = await leases.hold('doc1', 'x', 10_000)
    expect(calls).toEqual([{ method: 'lease/acquire', params: { docId: 'doc1', scope: 'x', ttl: 10_000 } }])
    timers.shift()!()
    await Promise.resolve()
    expect(calls.map((call) => call.method)).toEqual(['lease/acquire', 'lease/acquire'])
    await hold.release()
    // A renewal timer that fires after the release sends nothing.
    for (const run of timers.splice(0)) run()
    await Promise.resolve()
    expect(calls.map((call) => call.method)).toEqual(['lease/acquire', 'lease/acquire', 'lease/release'])
  })

  it('is lost when a renewal is refused', async () => {
    const timers: Array<() => void> = []
    let refuse = false
    const leases = new SyncLeases({
      request: async (_method, params) => {
        if (refuse) throw new Error('held')
        return { lease: { scope: params.scope, principalId: 'p', name: 'P', session: 's1', ttl: 10_000 } }
      },
      available: () => true,
      setTimeout: (run) => timers.push(run),
      clearTimeout: () => undefined,
    })
    const hold = await leases.hold('doc1', 'x')
    let lost = false
    hold.onLost(() => {
      lost = true
    })
    refuse = true
    timers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lost).toBe(true)
    expect(timers).toHaveLength(0)
  })
})

describe('DocumentLeases', () => {
  it('holds scopes for an editor, goes ahead without a server that keeps leases, and releases on dispose', async () => {
    const { a, b, server } = await room()
    const editorA = new DocumentLeases(a.leases, 'doc1')
    const editorB = new DocumentLeases(b.leases, 'doc1')
    expect(await editorA.acquire('layer-1')).toMatchObject({ scope: 'layer-1', name: 'Ash' })
    await expect(editorB.acquire('layer-1')).rejects.toSatisfy((error: unknown) => leaseHolder(error)?.name === 'Ash')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(editorB.list().map((lease) => [lease.scope, editorB.mine(lease)])).toEqual([['layer-1', false]])
    expect(editorA.mine(editorA.list()[0])).toBe(true)
    editorA.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(server.leases.get('doc1')?.size).toBe(0)
    expect(await editorB.acquire('layer-1')).toMatchObject({ name: 'Bo' })
    await editorB.release('layer-1')
    expect(server.leases.get('doc1')?.size).toBe(0)

    const { a: plain } = await room(false)
    expect(await new DocumentLeases(plain.leases, 'doc1').acquire('layer-1')).toBeNull()
  })
})

describe('scopesCollide', () => {
  it('collides equal scopes and the whole document with everything', () => {
    expect(scopesCollide('a', 'a')).toBe(true)
    expect(scopesCollide('a', 'b')).toBe(false)
    expect(scopesCollide('*', 'b')).toBe(true)
    expect(scopesCollide('a', '*')).toBe(true)
  })
})
