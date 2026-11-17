/**
 * Shallow starts (protocol 1.8): a client with no replica of a large document starts from a
 * shallow snapshot of the room's latest state (standard 2.0 rule M16a), edits and syncs it like a
 * full replica, and reads older history from the server. Real KDM replicas on both sides;
 * `FakeServer.shallow` builds the shallow snapshot from the room's stored snapshot and changes, as
 * a server does from its own copy.
 */
import { describe, expect, it, vi } from 'vitest'
import { newDocId, parseSchema, person, Replica } from '@kition/kdm'
import { SyncClient, type SyncClientOptions } from '../src/client'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const schema = parseSchema({ kdm: 1, kit: 'kit.collab-test', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' }, count: { kind: 'number', optional: true } } } } })
const owner: Identity = { id: 'pA', name: 'Ash', color: '#f00' }
const joiner: Identity = { id: 'pB', name: 'Bo', color: '#00f' }

function connectClient(server: FakeServer, token: string, identity: Identity, overrides: Partial<SyncClientOptions> = {}) {
  server.identify(token, identity)
  const { factory, sockets } = fakeTransport(server)
  return { client: new SyncClient({ createTransport: factory, ...overrides }), sockets }
}

/** The room's document as the server has it: its snapshot and every change after it. */
function serverCopy(server: FakeServer, docId: string): Replica {
  const room = server.rooms.get(docId)!
  const replica = Replica.load(schema, room.snapshot, 99n)
  for (const change of room.changes) replica.importChanges(change.bytes)
  return replica
}

/** A room whose owner has made a long history: `edits` pushes to one note. */
async function busyRoom(server: FakeServer, edits: number) {
  const { client } = connectClient(server, 'tokenA', owner)
  await client.connect('ws://test', 'tokenA')
  const docId = newDocId()
  const replica = Replica.create(schema, docId, 1n)
  await client.createRoom(docId, replica.snapshot(), 'Notes', 'kit.collab-test')
  await client.join(docId, null)
  // The note goes with the first push.
  let sent = replica.version()
  const note = replica.transact(person('user:a'), (tx) => tx.create('Note', {}))
  for (let count = 0; count < edits; count++) {
    replica.transact(person('user:a'), (tx) => tx.set(note, 'count', count))
    await client.push(docId, replica.exportChanges(sent))
    sent = replica.version()
  }
  return { client, replica, docId, note }
}

function shallowServer(large = () => true): FakeServer {
  const server = new FakeServer()
  server.shallow = {
    snapshot: (docId) => {
      const copy = serverCopy(server, docId)
      return copy.shallowSnapshot(copy.version())
    },
    large,
  }
  return server
}

describe('shallow starts', () => {
  it('join a large room from a shallow snapshot, then sync with full replicas both ways', async () => {
    const server = shallowServer()
    const a = await busyRoom(server, 30)
    const { client: b } = connectClient(server, 'tokenB', joiner, { start: { shallow: true } })
    await b.connect('ws://test', 'tokenB')
    const joined = await b.join(a.docId, null)
    expect(joined.snapshot).toBe(true)
    expect(joined.shallow).toBe(true)
    expect(joined.changes).toHaveLength(1)
    expect(joined.seq).toBe(30)
    const replica = Replica.load(schema, joined.changes[0], 2n)
    expect(replica.isShallow()).toBe(true)
    expect(replica.stateText()).toBe(a.replica.stateText())

    // B edits its shallow replica and pushes; A imports it, and the other way around.
    const fromA: Uint8Array[] = []
    a.client.onChanges(a.docId, (notice) => fromA.push(notice.changes))
    const fromB: Uint8Array[] = []
    b.onChanges(a.docId, (notice) => fromB.push(notice.changes))
    let sentB = replica.version()
    replica.transact(person('user:b'), (tx) => tx.textInsert(a.note, 'body', 0, 'from B'))
    await b.push(a.docId, replica.exportChanges(sentB))
    sentB = replica.version()
    const sentA = a.replica.version()
    a.replica.transact(person('user:a'), (tx) => tx.set(a.note, 'count', 100))
    await a.client.push(a.docId, a.replica.exportChanges(sentA))
    await vi.waitFor(() => expect(fromA).toHaveLength(1))
    await vi.waitFor(() => expect(fromB).toHaveLength(1))
    a.replica.importChanges(fromA[0])
    replica.importChanges(fromB[0])
    expect(replica.stateText()).toBe(a.replica.stateText())
    expect(serverCopy(server, a.docId).stateText()).toBe(replica.stateText())
    expect(replica.text(a.note, 'body')).toBe('from B')
    expect(replica.get(a.note, 'count')).toBe(100)
  })

  it('get a shallow snapshot, then join from its seq', async () => {
    const server = shallowServer()
    const a = await busyRoom(server, 12)
    const { client: b } = connectClient(server, 'tokenB', joiner)
    await b.connect('ws://test', 'tokenB')
    const got = await b.snapshot(a.docId, { shallow: true })
    expect(got.shallow).toBe(true)
    expect(got.seq).toBe(12)
    const replica = Replica.load(schema, got.snapshot, 2n)
    expect(replica.isShallow()).toBe(true)
    const joined = await b.join(a.docId, got.seq)
    expect(joined.changes).toHaveLength(0)
    expect(joined.shallow).toBeUndefined()
    const sent = server.calls.filter((call) => call.method === 'room/join').at(-1)!
    expect(sent.params).toEqual({ docId: a.docId, since: 12 })
    expect(server.calls.filter((call) => call.method === 'snapshot/get').at(-1)!.params).toEqual({ docId: a.docId, shallow: true })
  })

  it('let the server choose: prefer shallow starts shallow only for a large document', async () => {
    let large = false
    const server = shallowServer(() => large)
    const a = await busyRoom(server, 3)
    const { client: b } = connectClient(server, 'tokenB', joiner, { start: { prefer: 'shallow' } })
    await b.connect('ws://test', 'tokenB')
    const small = await b.snapshot(a.docId)
    expect(small.shallow).toBeUndefined()
    expect(Replica.load(schema, small.snapshot, 2n).isShallow()).toBe(false)
    expect(server.calls.at(-1)!.params).toEqual({ docId: a.docId, prefer: 'shallow' })
    large = true
    const big = await b.join(a.docId, null)
    expect(big.shallow).toBe(true)
    expect(Replica.load(schema, big.changes[0], 3n).isShallow()).toBe(true)
  })

  it('ask a 1.7 server, which answers full snapshots; rejoins never ask', async () => {
    const server = new FakeServer()
    const a = await busyRoom(server, 2)
    const { client: b, sockets } = connectClient(server, 'tokenB', joiner, { start: { shallow: true }, setTimeout: (run) => run(), clearTimeout: () => undefined, random: () => 0 })
    await b.connect('ws://test', 'tokenB')
    const got = await b.snapshot(a.docId)
    expect(got.shallow).toBeUndefined()
    expect(got.seq).toBe(0)
    const joined = await b.join(a.docId, null)
    expect(joined.shallow).toBeUndefined()
    expect(joined.changes).toHaveLength(2)
    expect(server.calls.filter((call) => call.method === 'room/join').at(-1)!.params).toEqual({ docId: a.docId, since: null, shallow: true })
    // A reconnect re-joins from the last seq it saw, with no shallow start.
    const joins = () => server.calls.filter((call) => call.method === 'room/join')
    const before = joins().length
    sockets[0].close()
    await vi.waitFor(() => expect(joins()).toHaveLength(before + 1))
    expect(joins().at(-1)!.params).toEqual({ docId: a.docId, since: 2 })
  })
})
