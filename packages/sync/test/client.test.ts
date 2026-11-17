/**
 * `SyncClient` against `FakeServer`: a real client exchanging real `kition-sync/1` frames with
 * enough of a server to join rooms, push and pull changes, carry presence, keep blobs, and open a
 * room by its share link. `fakeTransport` wires each client's socket to the shared `FakeServer`.
 * Catch-up throughout is by the room's own server sequence (`seq`/`since`), never a KDM version,
 * so `FakeServer` never needs a replica of its own.
 */
import { describe, expect, it, vi } from 'vitest'
import { SyncClient, type SyncClientOptions } from '../src/client'
import { SyncRpcError, type Presence } from '../src/protocol'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const identityA: Identity = { id: 'pA', name: 'Ash', color: '#f00' }
const identityB: Identity = { id: 'pB', name: 'Bo', color: '#00f' }

/** A client identified as `identity`, over its own loop-back transport into `server`. */
function connectClient(server: FakeServer, token: string, identity: Identity, overrides: Partial<SyncClientOptions> = {}) {
  server.identify(token, identity)
  const { factory, sockets } = fakeTransport(server)
  const client = new SyncClient({ createTransport: factory, ...overrides })
  return { client, sockets }
}

/** A `setTimeout`/`clearTimeout` pair the test drives itself, instead of real or faked wall time. */
function manualTimer() {
  const scheduled: Array<() => void> = []
  return {
    setTimeout: (run: () => void) => {
      scheduled.push(run)
      return scheduled.length
    },
    clearTimeout: () => undefined,
    get pending() {
      return scheduled.length
    },
    run: () => scheduled.shift()?.(),
  }
}

describe('SyncClient against a fake server', () => {
  it('reads the capabilities and capability sets the server lists in sync/hello', async () => {
    const server = new FakeServer()
    server.capabilities = ['headless', 'KitModel 1.0', 'KitCollab 1.1', 'sync']
    const { client } = connectClient(server, 'tokenA', identityA)
    expect(client.capabilities).toEqual([])
    expect(client.supports('KitModel 1.0')).toBe(false)
    const hello = await client.connect('ws://test', 'tokenA')
    expect(hello.capabilities).toContain('KitCollab 1.1')
    expect(client.capabilities).toEqual(['headless', 'KitModel 1.0', 'KitCollab 1.1', 'sync'])
    expect(client.capabilitySets).toEqual(['KitModel 1.0', 'KitCollab 1.1'])
    expect(client.supports('KitCollab 1.0')).toBe(true)
    expect(client.supports('KitCollab 1.1')).toBe(true)
    expect(client.supports('KitCollab 1.2')).toBe(false)
    expect(client.supports('KitCollab 2.0')).toBe(false)
    expect(client.supports('headless')).toBe(false)
  })

  it('delivers a push to another member of the room, tagged with the pusher', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array([0]), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    await b.join('doc1', null)

    const received: { changes: Uint8Array; from?: string }[] = []
    b.onChanges('doc1', (notice) => received.push(notice))
    await a.push('doc1', new Uint8Array([1, 2, 3]))

    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0].changes).toEqual(new Uint8Array([1, 2, 3]))
    expect(received[0].from).toBe('pA')
  })

  it('joins with a seq and gets only the changes after it', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    await a.push('doc1', new Uint8Array([1]))
    await a.push('doc1', new Uint8Array([2]))
    await a.push('doc1', new Uint8Array([3]))

    const result = await b.join('doc1', 1)
    expect(result.changes.map((bytes) => [...bytes])).toEqual([[2], [3]])
    expect(result.seq).toBe(3)
  })

  it('joins with since: null and gets every change, as from the room\'s snapshot', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array([9]), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    await a.push('doc1', new Uint8Array([1]))
    await a.push('doc1', new Uint8Array([2]))

    // The room's only snapshot is the one it was made with, before any change: seq 0.
    const snapshot = await b.snapshot('doc1')
    expect([...snapshot.snapshot]).toEqual([9])
    expect(snapshot.seq).toBe(0)

    const result = await b.join('doc1', null)
    expect(result.changes.map((bytes) => [...bytes])).toEqual([[1], [2]])
    expect(result.seq).toBe(2)
  })

  it('queues pushes made while offline and resends them in order once reconnected, re-joining with the last seen seq', async () => {
    const server = new FakeServer()
    const timer = manualTimer()
    const { client: a, sockets: socketsA } = connectClient(server, 'tokenA', identityA, { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout })
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    await b.join('doc1', null)

    const received: Uint8Array[] = []
    b.onChanges('doc1', (notice) => received.push(notice.changes))

    // One push goes through before the disconnect, so the client's "last seen seq" is not just
    // where it started: it must move to 1, not stay at 0.
    await a.push('doc1', new Uint8Array([0]))
    await vi.waitFor(() => expect(received).toHaveLength(1))

    // A network failure: A's socket drops.
    socketsA[0].close()
    await vi.waitFor(() => expect(a.state).toBe('offline'))

    const first = a.push('doc1', new Uint8Array([1]))
    const second = a.push('doc1', new Uint8Array([2]))

    // The reconnect is scheduled (backoff), not run yet: both pushes are still queued offline.
    expect(timer.pending).toBe(1)
    expect(received).toHaveLength(1)

    // Advance the (fake) backoff timer ourselves, as a real one would once it elapsed.
    timer.run()
    await vi.waitFor(() => expect(a.state).toBe('online'))
    await Promise.all([first, second])

    await vi.waitFor(() => expect(received).toHaveLength(3))
    expect(received.map((bytes) => [...bytes])).toEqual([[0], [1], [2]])

    // The re-join (the last `room/join` A sent) carried the seq of the push A saw acked before
    // it went offline, not 0 and not a KDM version.
    const rejoins = server.calls.filter((call) => call.method === 'room/join')
    expect(rejoins.at(-1)?.params.since).toBe(1)
  })

  it('reports a role that changed while it was offline, as the re-join after reconnecting answers it', async () => {
    const server = new FakeServer()
    const timer = manualTimer()
    const { client: a, sockets } = connectClient(server, 'tokenA', identityA, { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout })
    await a.connect('ws://test', 'tokenA')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    const roles: Array<string | null> = []
    a.onAccess('doc1', (role) => roles.push(role))
    // The connection drops (a host revoked its open token); while it is down, the person becomes a
    // viewer (a new token says so). No `room/access` notice can reach a closed socket.
    sockets[0].close()
    await vi.waitFor(() => expect(a.state).toBe('offline'))
    server.setRole('doc1', 'pA', 'viewer')
    timer.run()
    await vi.waitFor(() => expect(a.state).toBe('online'))
    await vi.waitFor(() => expect(roles).toEqual(['viewer']))
    // An unchanged role on a later re-join is not reported again.
    sockets.at(-1)!.close()
    await vi.waitFor(() => expect(a.state).toBe('offline'))
    timer.run()
    await vi.waitFor(() => expect(a.state).toBe('online'))
    expect(roles).toEqual(['viewer'])
  })

  it('fails a request made while offline at once, instead of sending it into the closed socket', async () => {
    const server = new FakeServer()
    const timer = manualTimer()
    const { client: a, sockets } = connectClient(server, 'tokenA', identityA, { setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout })
    await a.connect('ws://test', 'tokenA')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    // The connection drops (a revoked open token); the reconnect waits for its backoff.
    sockets[0].close()
    await vi.waitFor(() => expect(a.state).toBe('offline'))
    // A save ending after a failed host write (its socket gone): it must fail, never wait forever.
    const ended = await Promise.race([
      a.saveEnd('doc1', 1, { error: 'failed' }).then(
        () => 'answered',
        (error: unknown) => (error instanceof SyncRpcError ? error.message : String(error)),
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
    ])
    expect(ended).toBe('disconnected')
    // Once online again, requests go through.
    timer.run()
    await vi.waitFor(() => expect(a.state).toBe('online'))
    await expect(a.saveBegin('doc1', 'user')).resolves.toBeDefined()
  })

  it('refuses a push from a viewer with a forbidden error', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    await a.connect('ws://test', 'tokenA')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    server.setRole('doc1', 'pA', 'viewer')
    await a.join('doc1', null)

    const error = await a.push('doc1', new Uint8Array([1])).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncRpcError)
    expect((error as SyncRpcError).reason).toBe('forbidden')
  })

  it('round-trips a blob through put and get, and rejects a get the server answers with the wrong bytes for', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    await a.connect('ws://test', 'tokenA')

    const data = new Uint8Array([1, 2, 3, 4])
    const { hash } = await a.blobs.put('doc1', data, 'image/png')
    const fetched = await a.blobs.get('doc1', hash)
    expect(fetched.data).toEqual(data)
    expect(fetched.mime).toBe('image/png')

    // Blobs are scoped to the document that uploaded them: another document neither has nor gets it.
    expect((await a.blobs.has('doc2', [hash])).missing).toEqual([hash])
    expect((await a.blobs.has('doc1', [hash])).missing).toEqual([])
    const refused = await a.blobs.get('doc2', hash).catch((caught: unknown) => caught)
    expect((refused as SyncRpcError).reason).toBe('forbidden')

    // The server's stored bytes no longer hash to what it promised under `hash` (corruption, or a
    // misbehaving server): the client's own check on `blob/get` catches it rather than handing the
    // caller silently wrong bytes.
    server.blobs.set(hash, { mime: 'image/png', data: new Uint8Array([9, 9, 9, 9]) })
    await expect(a.blobs.get('doc1', hash)).rejects.toThrow(/hashing to/)
  })

  it('lists a room\'s history checkpoints and reads the document at one', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    await a.connect('ws://test', 'tokenA')
    await a.createRoom('doc1', new Uint8Array([7]), 'Plan', 'kit.test')
    await a.join('doc1')
    await a.push('doc1', new Uint8Array([1]))
    await a.push('doc1', new Uint8Array([2]))

    const page = await a.history('doc1', { limit: 1 })
    expect(page.more).toBe(true)
    expect(page.checkpoints).toEqual([{ seq: 2, firstSeq: 2, time: 2_000, principalId: identityA.id, changes: 1, kind: 'changes' }])
    const older = await a.history('doc1', { before: page.checkpoints[0].firstSeq })
    expect(older.checkpoints.map((checkpoint) => checkpoint.seq)).toEqual([1])
    expect(server.calls.find((call) => call.method === 'history/list')?.params).toEqual({ docId: 'doc1', limit: 1 })

    const state = await a.historyAt('doc1', 1)
    expect(state).toEqual({ snapshot: new Uint8Array([7]), seq: 1 })
  })

  it('asks the server\'s headless kits for previews, exports, and agent runs (protocol 1.7)', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    await a.connect('ws://test', 'tokenA')
    await a.createRoom('doc1', new Uint8Array([7]), 'Slide', 'kit.slide')
    await a.join('doc1', null)
    await a.push('doc1', new Uint8Array([1]))

    const preview = await a.preview('doc1', { page: 2, size: 128 })
    expect(preview).toEqual({ image: new Uint8Array([0x89, 0x50]), mimeType: 'image/png', width: 128, height: 32, seq: 1 })
    expect(server.calls.find((call) => call.method === 'preview/get')?.params).toEqual({ docId: 'doc1', page: 2, size: 128 })

    const file = await a.exportFile('doc1', 'pptx')
    expect(file).toEqual({ data: new Uint8Array([1, 2, 3]), name: 'doc.pptx', format: 'pptx', seq: 1 })
    await a.exportFile('doc1')
    expect(server.calls.filter((call) => call.method === 'export/get').map((call) => call.params)).toEqual([{ docId: 'doc1', format: 'pptx' }, { docId: 'doc1' }])

    const batch = { ops: [{ op: 'set', target: 'root', field: 'title', value: 'Q3' }] }
    const run = await a.runAgent('doc1', batch, 'Retitle the slide file')
    expect(run.seq).toBeNull()
    expect(run.result).toMatchObject({ prompt: 'Retitle the slide file', batch })
    await expect(a.preview('nope')).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('shows one peer\'s presence to another', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)
    await b.join('doc1', null)

    const seenByB: Presence[][] = []
    b.onPresence('doc1', (peers) => seenByB.push(peers))
    a.setPresence('doc1', { cursor: 5 })

    await vi.waitFor(() => expect(seenByB.length).toBeGreaterThan(0))
    const last = seenByB[seenByB.length - 1]
    expect(last.find((peer) => peer.principalId === 'pA')?.state).toEqual({ cursor: 5 })
  })

  it('pages through a busy room\'s catch-up, combining every page into one join() result', async () => {
    const server = new FakeServer()
    server.joinPageSize = 100
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    await a.join('doc1', null)

    const total = 1300
    for (let index = 0; index < total; index++) {
      await a.push('doc1', new Uint8Array([index % 256]))
    }

    const callsBeforeJoin = server.calls.length
    const result = await b.join('doc1', null)
    expect(result.changes).toHaveLength(total)
    expect(result.changes.map((bytes) => bytes[0])).toEqual(Array.from({ length: total }, (_, index) => index % 256))
    expect(result.seq).toBe(total)

    const joins = server.calls.slice(callsBeforeJoin).filter((call) => call.method === 'room/join' && call.params.docId === 'doc1')
    // At 100 changes per page and 1300 changes, the client needed 13 `room/join` round trips.
    expect(joins).toHaveLength(13)
    expect(joins.map((call) => call.params.since)).toEqual([null, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200])
  })

  it('opens a room by its share link', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')

    const { shareLink } = await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    const opened = await b.openRoom(shareLink)
    expect(opened).toEqual({ docId: 'doc1', name: 'Sheet', kit: 'kit.sheet', role: 'editor' })
  })

  it('mints a view-only link that opens as viewer', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')

    await a.createRoom('doc1', new Uint8Array(), 'Sheet', 'kit.sheet')
    const { shareLink } = await a.createLink('doc1', 'viewer')
    expect(server.calls.find((call) => call.method === 'room/link')?.params).toEqual({ docId: 'doc1', role: 'viewer' })
    const opened = await b.openRoom(shareLink)
    expect(opened.role).toBe('viewer')
  })

  it('asks a token function again on every connection attempt, and retries one that fails', async () => {
    const server = new FakeServer()
    server.identify('fresh-1', identityA)
    server.identify('fresh-2', identityA)
    const timer = manualTimer()
    const { factory, sockets } = fakeTransport(server)
    const a = new SyncClient({ createTransport: factory, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout })
    const tokens = ['fresh-1', null, 'fresh-2']
    const token = vi.fn(async () => {
      const next = tokens.shift()
      if (!next) throw new Error('no session')
      return next
    })
    expect((await a.connect('ws://test', token)).principal.id).toBe('pA')

    sockets[0].close()
    await vi.waitFor(() => expect(a.state).toBe('offline'))
    // The second attempt gets no token: it is dropped and another is scheduled.
    timer.run()
    await vi.waitFor(() => expect(timer.pending).toBe(1))
    expect(a.state).toBe('offline')
    timer.run()
    await vi.waitFor(() => expect(a.state).toBe('online'))
    expect(token).toHaveBeenCalledTimes(3)
    expect(server.calls.filter((call) => call.method === 'sync/hello').map((call) => call.params.token)).toEqual(['fresh-1', 'fresh-2'])
  })

  it('administers members: lists them and the links, changes a role, removes one, and revokes a link (protocol 1.6)', async () => {
    const server = new FakeServer()
    const { client: a } = connectClient(server, 'tokenA', identityA)
    const { client: b } = connectClient(server, 'tokenB', identityB)
    await a.connect('ws://test', 'tokenA')
    await b.connect('ws://test', 'tokenB')
    await a.createRoom('doc1', new Uint8Array(), 'Notes', 'kit.note')
    await a.join('doc1')
    const { shareLink } = await a.createLink('doc1', 'commenter')
    expect((await b.openRoom(shareLink)).role).toBe('commenter')
    expect((await b.join('doc1')).role).toBe('commenter')

    const listed = await a.members('doc1')
    expect(listed.members).toEqual([
      { principalId: 'pA', name: 'Ash', role: 'owner' },
      { principalId: 'pB', name: 'Bo', role: 'commenter' },
    ])
    expect(listed.links).toEqual([{ shareLink, role: 'commenter', createdBy: 'pA' }])
    // A commenter may not list them, nor administer.
    await expect(b.members('doc1')).rejects.toMatchObject({ reason: 'forbidden' })
    await expect(b.setRole('doc1', 'pA', 'viewer')).rejects.toMatchObject({ reason: 'forbidden' })

    const roles: Array<string | null> = []
    b.onAccess('doc1', (role) => roles.push(role))
    await a.setRole('doc1', 'pB', 'viewer')
    await vi.waitFor(() => expect(roles).toEqual(['viewer']))
    expect(server.calls.filter((call) => call.method === 'room/setRole').at(-1)?.params).toEqual({ docId: 'doc1', principalId: 'pB', role: 'viewer' })

    await a.removeMember('doc1', 'pB')
    await vi.waitFor(() => expect(roles).toEqual(['viewer', null]))
    expect((await a.members('doc1')).members.map((member) => member.principalId)).toEqual(['pA'])

    await a.revokeLink('doc1', shareLink)
    await expect(b.openRoom(shareLink)).rejects.toMatchObject({ reason: 'not-found' })
    await expect(a.revokeLink('doc1', shareLink)).rejects.toMatchObject({ reason: 'not-found' })
  })
})
