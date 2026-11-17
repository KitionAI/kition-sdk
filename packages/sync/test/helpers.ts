/**
 * An in-memory `kition-sync/1` server for tests: two `FakeSocket`s looped back to each other
 * stand in for a WebSocket, and `FakeServer` implements just enough of the protocol (hello,
 * rooms, pushes, presence, blobs, snapshots) for `SyncClient` to be tested against something
 * that actually speaks the wire format, including its binary framing.
 */
import { Decoder, Outgoing, readBin } from '../src/framing'
import { sha256Hex } from '../src/hash'
import { initialSaveState, saveTransition, type SaveEvent, type SaveState } from '../src/saveMachine'
import type { Role, OpenScope } from '../src/protocol'
import type { SyncTransport, TransportFactory } from '../src/transport'

/** One end of a loop-back pair: `send` on one side reaches the other's `onmessage`, asynchronously. */
export class FakeSocket implements SyncTransport {
  peer: FakeSocket | undefined
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  private closed = false

  send(data: string | Uint8Array): void {
    if (this.closed) return
    // `.slice()` always copies into a fresh, plain `ArrayBuffer` (never a `SharedArrayBuffer`),
    // so `.buffer` here is an `ArrayBuffer` even though `Uint8Array.buffer` is typed `ArrayBufferLike`.
    const payload: string | ArrayBuffer = typeof data === 'string' ? data : data.slice().buffer
    queueMicrotask(() => this.peer?.onmessage?.({ data: payload }))
  }

  /** Drops the connection, as a network failure would: both ends see `onclose`. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const peer = this.peer
    this.peer = undefined
    queueMicrotask(() => this.onclose?.())
    peer?.close()
  }
}

type Member = { principalId: string; name: string; color: string; role: Role; state: unknown; conn?: Connection }

type Room = {
  kit: string
  name: string
  snapshot: Uint8Array
  /** The `seq` the snapshot reflects: 0 for the creation snapshot, as on a real server. */
  snapshotSeq: number
  changes: { seq: number; bytes: Uint8Array; from: string }[]
  members: Map<string, Member>
  shareLink: string
  /** Who made the room: its owner, also after leaving and joining again. */
  owner: string
  /** A private room (protocol 1.9): no share link until its owner mints one. */
  private: boolean
  /** When it was made or last took a change (ms since the Unix epoch). */
  updated: number
  /** The save state machine (protocol 1.10, D3). */
  save: SaveState
  /** The file generation the room is bound to (protocol 1.10), when an open-token connection made it. */
  bound?: string
}

type Connection = {
  socket: SyncTransport
  decoder: Decoder
  principalId: string
  name: string
  color: string
  /** The scope of an open-token connection (protocol 1.10, managed-collab.md RM1). */
  open?: OpenScope
  /**
   * What room membership and saves know the connection by: its principal, or for an open-token
   * connection the connection itself, so its role never becomes a stored membership another
   * connection of the principal could inherit (I5).
   */
  key: string
}

export type Identity = { id: string; name: string; color: string }

/** A minimal `kition-sync/1` server: enough protocol to exercise a real client against. */
export class FakeServer {
  readonly rooms = new Map<string, Room>()
  readonly blobs = new Map<string, { mime: string; data: Uint8Array }>()
  /** Which blobs each document references (protocol 1.5): `blob/put` records one, `blob/has` and `blob/get` answer only those. */
  readonly blobRefs = new Map<string, Set<string>>()
  /** Links `room/link` minted: each names its room and the role it grants. */
  private readonly links = new Map<string, { docId: string; role: Role }>()
  private nextConn = 0
  private readonly identities = new Map<string, Identity>()
  /** Overrides the role a principal joins a room with; defaults to the room's creator as
   * `owner` and everyone else as `editor`. */
  roleOverrides = new Map<string, Role>()
  /** Acts as an integrator's tenant on Kition Cloud (KitCollab 1.3): rooms have no share links. */
  tenantRooms = false
  /** The most changes `room/join` answers in one page, for tests to exercise paging with a
   * small room instead of pushing hundreds of changes to reach the real default. */
  joinPageSize = 512
  /** Every request and notification this server has dispatched, in order, for a test to inspect
   * (for example, the `since` a reconnecting client's `room/join` carried). */
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  /** Lists the `leases` capability and serves `lease/acquire` and `lease/release` (protocol 1.5). */
  leasesEnabled = false
  /** Each room's leases by scope: the holder's principal and session. */
  readonly leases = new Map<string, Map<string, { principalId: string; name: string; session: string }>>()
  /** More capabilities `sync/hello` lists (`headless`, say). */
  capabilities: string[] = []
  /**
   * Runs `agent/run` (protocol 1.7) when set, as a headless kit would: for an owner or editor, its
   * `changes` become one change of the room from `server:agent`, sent to every member, the caller
   * too. Unset, `agent/run` echoes its params and changes nothing.
   */
  agent: ((call: { docId: string; batch: unknown; prompt?: string; principalId: string }) => { changes?: Uint8Array; result: unknown } | Promise<{ changes?: Uint8Array; result: unknown }>) | undefined

  /**
   * Answers shallow starts (protocol 1.8) when set: the shallow snapshot of a room's latest state,
   * for `snapshot/get` and a `since: null` `room/join` that ask `shallow: true`, or `prefer:
   * 'shallow'` when `large` says the room is past the server's threshold. Unset, the server answers
   * full snapshots as a 1.7 server does.
   */
  shallow: { snapshot: (docId: string) => Uint8Array; large: (docId: string) => boolean } | undefined

  /** Whether a request's 1.8 params ask for a shallow start this server gives. */
  private wantsShallow(params: Record<string, unknown>): boolean {
    if (!this.shallow) return false
    return params.shallow === true || (params.prefer === 'shallow' && this.shallow.large(params.docId as string))
  }

  /** Each principal's name as it last said hello, for a save's authors. */
  private readonly principalNames = new Map<string, string>()
  /** Open tokens (protocol 1.10): each token's scope, set by `identifyOpen`. */
  private readonly openScopes = new Map<string, OpenScope>()
  /** One room per file generation (RM6): `file docKey` to the room's docId. */
  readonly bindings = new Map<string, string>()
  /** The seed claim of each unbound file generation (RM5): the connection holding it. */
  private readonly seedClaims = new Map<string, Connection>()

  /** `token` hellos as `identity` with an open token's `scope` (protocol 1.10). */
  identifyOpen(token: string, identity: Identity, scope: OpenScope): void {
    this.identities.set(token, identity)
    this.openScopes.set(token, scope)
  }

  /**
   * Whether `conn` reaches `docId`'s room (RM2): an open-token connection only its own
   * generation's room; any other connection never a room bound to a generation.
   */
  private reaches(conn: Connection, docId: string): boolean {
    if (conn.open) return this.bindings.get(openKey(conn.open)) === docId
    return !this.rooms.get(docId)?.bound
  }

  /** Pre-room blob references (RM7), per file generation: only that generation's room ever gets them. */
  private readonly preRoomRefs = new Map<string, Map<string, Set<string>>>()

  /** `token` hellos as `identity` from here on. */
  identify(token: string, identity: Identity): void {
    this.identities.set(token, identity)
  }

  setRole(docId: string, principalId: string, role: Role): void {
    this.roleOverrides.set(`${docId}:${principalId}`, role)
  }

  connect(socket: SyncTransport): void {
    const conn: Connection = { socket, decoder: new Decoder(), principalId: '', name: '', color: '', key: '' }
    socket.onmessage = (event) => this.handleFrame(conn, event.data)
    // A session that disconnects ends its leases, as a real server does.
    socket.onclose = () => {
      for (const [key, holder] of [...this.seedClaims]) if (holder === conn) this.seedClaims.delete(key)
      // An open-token connection that goes away leaves its room (and its saves see it leave).
      for (const [docId, room] of this.rooms) {
        const member = room.members.get(conn.key)
        if (!member || member.conn !== conn) continue
        room.members.delete(conn.key)
        if (member.role !== 'viewer' && member.role !== 'commenter') this.applySave(docId, { type: 'left', by: conn.key, last: ![...room.members.values()].some((other) => other.role !== 'viewer' && other.role !== 'commenter') })
      }
      if (!conn.principalId || this.connectionsByPrincipal.get(conn.principalId) !== conn) return
      const session = `s-${conn.principalId}`
      for (const [docId, held] of this.leases) {
        const before = held.size
        for (const [scope, entry] of [...held]) if (entry.session === session) held.delete(scope)
        if (held.size !== before) this.broadcastLeases(docId)
      }
    }
  }

  private handleFrame(conn: Connection, data: string | ArrayBuffer): void {
    let decoded: { message: Record<string, unknown>; bins: Uint8Array[] } | undefined
    try {
      decoded = conn.decoder.feed(typeof data === 'string' ? data : new Uint8Array(data))
    } catch {
      return
    }
    if (!decoded) return
    void this.dispatch(conn, decoded.message, decoded.bins)
  }

  private async dispatch(conn: Connection, message: Record<string, unknown>, bins: Uint8Array[]): Promise<void> {
    const method = message.method as string
    const params = (message.params ?? {}) as Record<string, unknown>
    const id = message.id as string | number | undefined
    this.calls.push({ method, params })

    if (conn.open) {
      // RM1 to RM3: an open-token connection reaches its one room, and nothing that shares or administers rooms.
      if (['room/open', 'room/link', 'room/setRole', 'room/removeMember', 'room/revokeLink', 'room/members'].includes(method)) return this.fail(conn, id, 'forbidden', 'open-token rooms have no links or members to manage')
      const docId = params.docId as string | undefined
      const key = openKey(conn.open)
      const preRoomBlob = (method === 'blob/has' || method === 'blob/put') && docId !== undefined && !this.rooms.has(docId) && this.seedClaims.get(key) === conn
      if (preRoomBlob) {
        let refs = this.preRoomRefs.get(key)
        if (!refs) this.preRoomRefs.set(key, (refs = new Map()))
        const held = refs.get(docId!) ?? new Set<string>()
        refs.set(docId!, held)
        if (method === 'blob/has') return this.reply(conn, id, { missing: (params.hashes as string[]).filter((hash) => !held.has(hash) || !this.blobs.has(hash)) })
        const data = readBin(params.data, bins)
        if ((await sha256Hex(data)) !== params.hash) return this.fail(conn, id, 'invalid', 'the data does not hash to its hash')
        this.blobs.set(params.hash as string, { mime: params.mime as string, data })
        held.add(params.hash as string)
        return this.reply(conn, id, {})
      }
      if (docId !== undefined && method !== 'room/create' && !this.reaches(conn, docId)) return this.fail(conn, id, 'not-found', `no such room: ${docId}`)
    } else {
      const docId = params.docId as string | undefined
      if (docId !== undefined && !this.reaches(conn, docId)) return this.fail(conn, id, 'not-found', `no such room: ${docId}`)
    }

    switch (method) {
      case 'save/begin':
      case 'save/end': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        const member = room?.members.get(conn.key)
        if (!room || !member) return this.fail(conn, id, 'not-found', 'join the room first')
        const saverRole = conn.open?.role ?? member.role
        if (saverRole === 'viewer' || saverRole === 'commenter') return this.fail(conn, id, 'forbidden', 'only an editor saves')
        const event: SaveEvent =
          method === 'save/begin'
            ? { type: 'begin', by: conn.key, trigger: params.trigger as 'user' }
            : { type: 'end', by: conn.key, seq: params.seq as number, version: (params.version ?? null) as string | null, ...(params.error ? { error: params.error as 'failed' } : {}) }
        const before = room.save
        const refused = this.applySave(docId, event)
        if (refused) return this.fail(conn, id, refused, `save refused: ${refused}`)
        if (method === 'save/end') return this.reply(conn, id, {})
        const seq = room.save.savingSeq ?? room.save.headSeq
        const names = new Map<string, string>()
        for (const change of room.changes) if (change.seq > before.savedSeq && change.seq <= seq) names.set(change.from, this.principalNames.get(change.from) ?? change.from)
        const authors = [...names].map(([principalId, name]) => ({ principalId, name }))
        // The server's signed statement of what the save holds (I6): the host stores the authors from it, never from the page.
        const receipt = `ksr1.${btoa(JSON.stringify({ docId, seq, authors, trigger: room.save.trigger, file: room.bound ?? null })).replace(/=+$/, '')}.fake`
        return this.reply(conn, id, { save: room.save, seq, authors, receipt })
      }
      case 'room/resolve': {
        if (!conn.open) return this.fail(conn, id, 'forbidden', 'room/resolve needs an open token')
        const key = openKey(conn.open)
        const bound = this.bindings.get(key) ?? null
        if (bound) return this.reply(conn, id, { docId: bound, claimed: false, save: this.rooms.get(bound)?.save ?? null })
        const holder = this.seedClaims.get(key)
        const claimed = params.claim === true && conn.open.role === 'editor' && (!holder || holder === conn)
        if (claimed) this.seedClaims.set(key, conn)
        return this.reply(conn, id, { docId: null, claimed, save: null })
      }
      case 'sync/hello': {
        this.nextConn += 1
        const identity = this.identities.get(params.token as string) ?? { id: `p${this.nextConn}`, name: `Guest ${this.nextConn}`, color: '#888888' }
        conn.principalId = identity.id
        conn.name = identity.name
        conn.color = identity.color
        conn.open = this.openScopes.get(params.token as string)
        conn.key = conn.open ? `conn-${this.nextConn}` : identity.id
        this.principalNames.set(identity.id, identity.name)
        this.connectionsByPrincipal.set(identity.id, conn)
        if (!this.connectionsOf.has(identity.id)) this.connectionsOf.set(identity.id, new Set())
        this.connectionsOf.get(identity.id)!.add(conn)
        this.reply(conn, id, { server: { name: 'fake-sync-server', version: '0.0.0' }, principal: { id: identity.id, name: identity.name }, capabilities: [...(this.leasesEnabled ? ['leases'] : []), ...(conn.open ? ['open-rooms', 'KitCollab 1.4'] : []), ...this.capabilities], ...(conn.open ? { open: conn.open } : {}) })
        return
      }
      case 'lease/acquire':
      case 'lease/release': {
        const docId = params.docId as string
        const scope = params.scope as string
        const room = this.rooms.get(docId)
        const role = room?.members.get(conn.key)?.role
        if (!room || !role) return this.fail(conn, id, 'not-found', 'join the room first')
        if (role === 'viewer') return this.fail(conn, id, 'forbidden', 'viewers cannot take leases')
        let held = this.leases.get(docId)
        if (!held) this.leases.set(docId, (held = new Map()))
        const session = `s-${conn.principalId}`
        const lease = (entryScope: string, entry: { principalId: string; name: string; session: string }) => ({ scope: entryScope, ...entry, ttl: 30_000 })
        if (method === 'lease/release') {
          const changed = held.get(scope)?.session === session && held.delete(scope)
          this.reply(conn, id, {})
          if (changed) this.broadcastLeases(docId)
          return
        }
        const blocking = [...held].find(([other, entry]) => entry.session !== session && (other === scope || other === '*' || scope === '*'))
        if (blocking) {
          for (const frame of new Outgoing().finish({ jsonrpc: '2.0', id, error: { code: -32000, message: 'held', data: { code: 'conflict', lease: lease(...blocking) } } })) conn.socket.send(frame)
          return
        }
        const fresh = !held.has(scope)
        held.set(scope, { principalId: conn.principalId, name: conn.name, session })
        this.reply(conn, id, { lease: lease(scope, held.get(scope)!) })
        if (fresh) this.broadcastLeases(docId)
        return
      }
      case 'room/join': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${docId}`)
          return
        }
        // `since: null` (or absent) means "everything, from the room's snapshot" -- its seq.
        const since = (params.since as number | null | undefined) ?? room.snapshotSeq
        const requested = (params.limit as number | undefined) ?? this.joinPageSize
        const pageSize = Math.min(requested, this.joinPageSize)
        // An open token's role holds whatever the room remembers (RM3).
        const role = conn.open?.role ?? this.roleOverrides.get(`${docId}:${conn.principalId}`) ?? (room.owner === conn.principalId ? 'owner' : undefined) ?? room.members.get(conn.key)?.role ?? 'editor'
        const joining = room.members.get(conn.key)?.role !== role
        room.members.set(conn.key, { principalId: conn.principalId, name: conn.name, color: conn.color, role, state: null, ...(conn.open ? { conn } : {}) })
        if (joining && !conn.open) this.roomsChanged(docId, conn.principalId)
        if (role !== 'viewer' && role !== 'commenter') this.applySave(docId, { type: 'joined', by: conn.key })
        if (params.since == null && this.shallow && this.wantsShallow(params)) {
          const out = new Outgoing()
          const presence = [...room.members.values()].map((member) => ({ principalId: member.principalId, name: member.name, color: member.color, state: member.state }))
          const changes = [out.bin(this.shallow.snapshot(docId))]
          this.reply(conn, id, { changes, seq: room.changes.length, more: false, presence, role, snapshot: true, shallow: true }, out)
          return
        }
        const pending = room.changes.filter((change) => change.seq > since)
        const page = pending.slice(0, pageSize)
        const more = pending.length > page.length
        const out = new Outgoing()
        const changes = page.map((change) => out.bin(change.bytes))
        const seq = more ? (page.at(-1)?.seq ?? since) : room.changes.length
        const presence = [...room.members.values()].map((member) => ({ principalId: member.principalId, name: member.name, color: member.color, state: member.state }))
        this.reply(conn, id, { changes, seq, more, presence, role }, out)
        return
      }
      case 'changes/push': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${docId}`)
          return
        }
        // An open-token connection pushes with its token's role, never a stored one (I5).
        const role = conn.open?.role ?? room.members.get(conn.key)?.role ?? 'viewer'
        if (role === 'viewer') {
          this.fail(conn, id, 'forbidden', 'viewers cannot push changes')
          return
        }
        const bytes = readBin(params.changes, bins)
        const seq = room.changes.length + 1
        room.changes.push({ seq, bytes, from: conn.principalId })
        room.updated = Date.now()
        this.reply(conn, id, { seq })
        this.applySave(docId, { type: 'change', seq, by: conn.key })
        for (const member of room.members.values()) {
          if (member.conn ? member.conn === conn : member.principalId === conn.principalId) continue
          const out = new Outgoing()
          this.notify(member, 'changes/pull', { docId, changes: out.bin(bytes), seq, from: conn.principalId }, out)
        }
        return
      }
      case 'presence/set': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        const member = room?.members.get(conn.key)
        if (!room || !member) return
        member.state = params.state
        const peers = [...room.members.values()].map((other) => ({ principalId: other.principalId, name: other.name, color: other.color, state: other.state }))
        for (const other of room.members.values()) {
          const out = new Outgoing()
          this.notify(other, 'presence/update', { docId, peers }, out)
        }
        return
      }
      case 'room/leave': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        const wasEditor = Boolean(room?.members.get(conn.key)) && !['viewer', 'commenter'].includes(room!.members.get(conn.key)!.role)
        room?.members.delete(conn.key)
        if (room && wasEditor) this.applySave(docId, { type: 'left', by: conn.key, last: ![...room.members.values()].some((member) => member.role !== 'viewer' && member.role !== 'commenter') })
        // A session that leaves ends its leases there.
        const held = this.leases.get(docId)
        const session = `s-${conn.principalId}`
        const before = held?.size ?? 0
        for (const [scope, entry] of [...(held ?? [])]) if (entry.session === session) held!.delete(scope)
        if ((held?.size ?? 0) !== before) this.broadcastLeases(docId)
        return
      }
      case 'blob/has': {
        const hashes = params.hashes as string[]
        const refs = this.blobRefs.get(params.docId as string)
        this.reply(conn, id, { missing: hashes.filter((hash) => !this.blobs.has(hash) || !refs?.has(hash)) })
        return
      }
      case 'blob/put': {
        const data = readBin(params.data, bins)
        const actual = await sha256Hex(data)
        if (actual !== params.hash) {
          this.fail(conn, id, 'invalid', `declared hash ${String(params.hash)} does not match the data's ${actual}`)
          return
        }
        this.blobs.set(params.hash as string, { mime: params.mime as string, data })
        const docId = params.docId as string
        if (!this.blobRefs.has(docId)) this.blobRefs.set(docId, new Set())
        this.blobRefs.get(docId)!.add(params.hash as string)
        this.reply(conn, id, {})
        return
      }
      case 'blob/get': {
        if (!this.blobRefs.get(params.docId as string)?.has(params.hash as string)) {
          this.fail(conn, id, 'forbidden', `the document does not reference ${String(params.hash)}`)
          return
        }
        const stored = this.blobs.get(params.hash as string)
        if (!stored) {
          this.fail(conn, id, 'not-found', `no such blob: ${String(params.hash)}`)
          return
        }
        const out = new Outgoing()
        this.reply(conn, id, { data: out.bin(stored.data), mime: stored.mime }, out)
        return
      }
      case 'history/list': {
        const room = this.rooms.get(params.docId as string)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${String(params.docId)}`)
          return
        }
        // One checkpoint per change, newest first: enough for a client to page through.
        const before = (params.before as number | undefined) ?? Number.MAX_SAFE_INTEGER
        const older = room.changes.filter((change) => change.seq < before).reverse()
        const limit = (params.limit as number | undefined) ?? 100
        const checkpoints = older.slice(0, limit).map((change) => ({ seq: change.seq, firstSeq: change.seq, time: 1_000 * change.seq, principalId: change.from, changes: 1, kind: 'changes' }))
        this.reply(conn, id, { checkpoints, more: older.length > limit })
        return
      }
      case 'history/get': {
        const room = this.rooms.get(params.docId as string)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${String(params.docId)}`)
          return
        }
        // The fake keeps no states: the snapshot stands in for every one.
        const out = new Outgoing()
        this.reply(conn, id, { snapshot: out.bin(room.snapshot), seq: params.seq as number }, out)
        return
      }
      case 'preview/get':
      case 'export/get': {
        const room = this.rooms.get(params.docId as string)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${String(params.docId)}`)
          return
        }
        // The fake runs no kit: a few bytes stand in for the picture or the file.
        const seq = room.changes.length
        const out = new Outgoing()
        if (method === 'preview/get') {
          this.reply(conn, id, { image: out.bin(new Uint8Array([0x89, 0x50])), mimeType: 'image/png', width: params.size ?? 64, height: 32, seq }, out)
        } else {
          const format = (params.format as string | undefined) ?? 'native'
          this.reply(conn, id, { data: out.bin(new Uint8Array([1, 2, 3])), name: `doc.${format}`, format, seq }, out)
        }
        return
      }
      case 'agent/run': {
        const room = this.rooms.get(params.docId as string)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${String(params.docId)}`)
          return
        }
        if (!this.agent) {
          this.reply(conn, id, { seq: null, result: { refs: {}, results: [], loaded: [], prompt: params.prompt ?? null, batch: params.batch } })
          return
        }
        const docId = params.docId as string
        const role = room.members.get(conn.key)?.role
        if (role !== 'owner' && role !== 'editor') return this.fail(conn, id, 'forbidden', 'only an owner or an editor runs agents')
        const ran = await this.agent({ docId, batch: params.batch, prompt: params.prompt as string | undefined, principalId: conn.principalId })
        if (!ran.changes) {
          this.reply(conn, id, { seq: null, result: ran.result })
          return
        }
        const seq = room.changes.length + 1
        room.changes.push({ seq, bytes: ran.changes, from: 'server:agent' })
        this.reply(conn, id, { seq, result: ran.result })
        for (const member of room.members.values()) {
          const out = new Outgoing()
          this.notify(member, 'changes/pull', { docId, changes: out.bin(ran.changes), seq, from: 'server:agent' }, out)
        }
        return
      }
      case 'snapshot/get': {
        const room = this.rooms.get(params.docId as string)
        if (!room) {
          this.fail(conn, id, 'not-found', `no such room: ${String(params.docId)}`)
          return
        }
        // The snapshot with the seq it was taken at (sync-protocol `snapshot/get`), not the room's
        // latest: a client joining from it must still be sent every change after it.
        const out = new Outgoing()
        if (this.shallow && this.wantsShallow(params)) {
          this.reply(conn, id, { snapshot: out.bin(this.shallow.snapshot(params.docId as string)), seq: room.changes.length, shallow: true }, out)
          return
        }
        this.reply(conn, id, { snapshot: out.bin(room.snapshot), seq: room.snapshotSeq }, out)
        return
      }
      case 'room/create': {
        const docId = params.docId as string
        if (conn.open) {
          // RM6: one room per file generation, made by an editor, bound to it; never owned.
          if (conn.open.role !== 'editor') return this.fail(conn, id, 'forbidden', 'only an editor makes the room')
          const key = openKey(conn.open)
          const bound = this.bindings.get(key)
          if (bound) {
            for (const frame of new Outgoing().finish({ jsonrpc: '2.0', id, error: { code: -32000, message: 'the file already has a room', data: { code: 'conflict', docId: bound } } })) conn.socket.send(frame)
            return
          }
          if (this.rooms.has(docId)) return this.fail(conn, id, 'conflict', `room already exists: ${docId}`)
          // Only the seed claim's holder, or anyone while nobody holds it, makes the room (I5).
          const holder = this.seedClaims.get(key)
          if (holder && holder !== conn) return this.fail(conn, id, 'conflict', 'another editor is making the room')
          const room: Room = { kit: params.kit as string, name: params.name as string, snapshot: readBin(params.snapshot, bins), snapshotSeq: 0, changes: [], members: new Map(), shareLink: '', owner: '', private: true, updated: Date.now(), save: initialSaveState(), bound: key }
          room.members.set(conn.key, { principalId: conn.principalId, name: conn.name, color: conn.color, role: conn.open.role, state: null, conn })
          this.rooms.set(docId, room)
          this.bindings.set(key, docId)
          this.seedClaims.delete(key)
          const prepared = this.preRoomRefs.get(key)?.get(docId)
          if (prepared) this.blobRefs.set(docId, new Set(prepared))
          this.preRoomRefs.delete(key)
          this.reply(conn, id, { shareLink: null })
          for (const other of this.allConnections()) if (other.open && openKey(other.open) === key) this.send(other, 'room/resolved', { docId })
          return
        }
        if (this.rooms.has(docId)) {
          this.fail(conn, id, 'conflict', `room already exists: ${docId}`)
          return
        }
        const isPrivate = params.private === true || this.tenantRooms
        const shareLink = isPrivate ? '' : `https://fake.test/s/${docId}`
        const room: Room = { kit: params.kit as string, name: params.name as string, snapshot: readBin(params.snapshot, bins), snapshotSeq: 0, changes: [], members: new Map(), shareLink, owner: conn.principalId, private: isPrivate, updated: Date.now(), save: initialSaveState() }
        room.members.set(conn.key, { principalId: conn.principalId, name: conn.name, color: conn.color, role: 'owner', state: null })
        this.rooms.set(docId, room)
        this.reply(conn, id, { shareLink: shareLink || null })
        this.roomsChanged(docId, conn.principalId)
        return
      }
      case 'rooms/list': {
        const mine = [...this.rooms]
          .filter(([, room]) => room.members.has(conn.principalId))
          .map(([docId]) => this.listing(docId, conn.principalId)!)
          .sort((a, b) => b.updated - a.updated || a.docId.localeCompare(b.docId))
        const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0
        const limit = typeof params.limit === 'number' ? params.limit : 100
        const page = mine.slice(start, start + limit)
        this.reply(conn, id, { rooms: page, cursor: start + limit < mine.length ? String(start + limit) : null })
        return
      }
      case 'account/settings': {
        this.reply(conn, id, this.settingsOf(conn.principalId))
        return
      }
      case 'account/update': {
        const settings = this.settingsOf(conn.principalId)
        if (typeof params.syncAll === 'boolean') settings.syncAll = params.syncAll
        this.settings.set(conn.principalId, settings)
        this.reply(conn, id, { ...settings })
        for (const other of this.connectionsOf.get(conn.principalId) ?? []) this.send(other, 'account/changed', { ...settings })
        return
      }
      case 'room/link': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        const own = room?.members.get(conn.key)?.role
        if (!room || !own) {
          this.fail(conn, id, 'not-found', `no such room: ${docId}`)
          return
        }
        const role = params.role as Role
        if (this.tenantRooms || role === 'owner' || (own === 'viewer' && role !== 'viewer')) {
          this.fail(conn, id, 'forbidden', `a link cannot grant ${role}`)
          return
        }
        const shareLink = `https://fake.test/s/${docId}/${role}/${this.links.size + 1}`
        this.links.set(shareLink, { docId, role })
        this.reply(conn, id, { shareLink })
        if (room.private && own === 'owner') {
          room.private = false
          this.roomsChanged(docId, conn.principalId)
        }
        return
      }
      case 'room/members': {
        const room = this.rooms.get(params.docId as string)
        const own = room?.members.get(conn.key)?.role
        if (!room || !own) return this.fail(conn, id, 'not-found', 'no such room')
        if (own !== 'owner' && own !== 'editor') return this.fail(conn, id, 'forbidden', 'only the owner and editors see the members')
        const members = [...room.members.values()].map((member) => ({ principalId: member.principalId, name: member.name, role: member.role }))
        const links = [...this.links].filter(([, link]) => link.docId === params.docId).map(([shareLink, link]) => ({ shareLink, role: link.role, createdBy: room.owner }))
        this.reply(conn, id, { members, links })
        return
      }
      case 'room/setRole':
      case 'room/removeMember':
      case 'room/revokeLink': {
        const docId = params.docId as string
        const room = this.rooms.get(docId)
        if (!room) return this.fail(conn, id, 'not-found', 'no such room')
        if (room.owner !== conn.principalId) return this.fail(conn, id, 'forbidden', 'only the owner administers members')
        if (method === 'room/revokeLink') {
          if (!this.links.delete(params.shareLink as string)) return this.fail(conn, id, 'not-found', 'no such share link')
          this.reply(conn, id, {})
          return
        }
        const target = room.members.get(params.principalId as string)
        if (!target || target.principalId === conn.principalId) return this.fail(conn, id, target ? 'invalid' : 'not-found', 'not another member')
        const role = method === 'room/setRole' ? (params.role as Role) : null
        if (role) {
          target.role = role
          this.roleOverrides.set(`${docId}:${target.principalId}`, role)
        } else {
          room.members.delete(target.principalId)
          this.roleOverrides.delete(`${docId}:${target.principalId}`)
        }
        this.reply(conn, id, {})
        this.notify(target, 'room/access', { docId, role }, new Outgoing())
        return
      }
      case 'room/open': {
        const shareLink = params.shareLink as string
        const minted = this.links.get(shareLink)
        const entry = minted
          ? ([minted.docId, this.rooms.get(minted.docId)] as const)
          : [...this.rooms.entries()].find(([, room]) => room.shareLink === shareLink)
        if (!entry?.[1]) {
          this.fail(conn, id, 'not-found', `no such share link: ${shareLink}`)
          return
        }
        const [docId, room] = entry
        const role = this.roleOverrides.get(`${docId}:${conn.principalId}`) ?? (room.owner === conn.principalId ? 'owner' : undefined) ?? room.members.get(conn.key)?.role ?? minted?.role ?? 'editor'
        // The next `room/join` makes the caller a member with the role the link grants.
        if (minted && !room.members.has(conn.principalId)) this.roleOverrides.set(`${docId}:${conn.principalId}`, role)
        this.reply(conn, id, { docId, name: room.name, kit: room.kit, role })
        return
      }
      default:
        this.fail(conn, id, 'invalid', `unknown method: ${method}`)
    }
  }

  private reply(conn: Connection, id: string | number | undefined, result: Record<string, unknown>, out: Outgoing = new Outgoing()): void {
    if (id === undefined) return
    for (const frame of out.finish({ jsonrpc: '2.0', id, result })) conn.socket.send(frame)
  }

  private fail(conn: Connection, id: string | number | undefined, code: string, message: string): void {
    if (id === undefined) return
    const out = new Outgoing()
    for (const frame of out.finish({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { code } } })) conn.socket.send(frame)
  }

  private broadcastLeases(docId: string): void {
    const room = this.rooms.get(docId)
    const leases = [...(this.leases.get(docId) ?? [])].map(([scope, entry]) => ({ scope, ...entry, ttl: 30_000 }))
    for (const member of room?.members.values() ?? []) this.notify(member, 'lease/changed', { docId, leases }, new Outgoing())
  }

  /** Account settings per principal (protocol 1.9). */
  readonly settings = new Map<string, { syncAll: boolean }>()

  private settingsOf(principalId: string) {
    return { syncAll: this.settings.get(principalId)?.syncAll ?? false }
  }

  /** `docId`'s entry in `principalId`'s document list (protocol 1.9), or `null` for a non-member. */
  private listing(docId: string, principalId: string) {
    const room = this.rooms.get(docId)
    const member = room?.members.get(principalId)
    if (!room || !member) return null
    const size = room.snapshot.length + room.changes.reduce((total, change) => total + change.bytes.length, 0)
    return { docId, name: room.name, kit: room.kit, role: member.role, updated: room.updated, size, private: room.private }
  }

  /** Tells every connection of `principalId` its list entry for `docId` changed (`rooms/changed`). */
  private roomsChanged(docId: string, principalId: string): void {
    const room = this.listing(docId, principalId)
    for (const conn of this.connectionsOf.get(principalId) ?? []) this.send(conn, 'rooms/changed', { docId, room })
  }

  private send(conn: Connection, method: string, params: Record<string, unknown>): void {
    for (const frame of new Outgoing().finish({ jsonrpc: '2.0', method, params })) conn.socket.send(frame)
  }

  /** Applies `event` to `docId`'s save state and tells the members; answers the refusal, if any. */
  private applySave(docId: string, event: SaveEvent): string | undefined {
    const room = this.rooms.get(docId)
    if (!room) return 'not-found'
    const result = saveTransition(room.save, event)
    if (result.refused) return result.refused
    room.save = result.state
    if (result.changed) for (const member of room.members.values()) this.notify(member, 'save/changed', { docId, save: room.save }, new Outgoing())
    return undefined
  }

  private allConnections(): Connection[] {
    return [...this.connectionsOf.values()].flatMap((set) => [...set])
  }

  private notify(member: Member, method: string, params: Record<string, unknown>, out: Outgoing): void {
    const conn = member.conn ?? this.connectionsByPrincipal.get(member.principalId)
    if (!conn) return
    for (const frame of out.finish({ jsonrpc: '2.0', method, params })) conn.socket.send(frame)
  }

  /** Tracks the live connection for each principal, so a notification reaches the right socket
   * even though `Member` (room state) does not itself hold one. */
  private readonly connectionsByPrincipal = new Map<string, Connection>()
  /** Every connection each principal has had (several devices), for `rooms/changed` and `account/changed`. */
  private readonly connectionsOf = new Map<string, Set<Connection>>()
}

/** A `TransportFactory` wired to `server`; `sockets` grows with each connection attempt, so a
 * test can reach in and drop one to simulate a network failure. */
export function fakeTransport(server: FakeServer): { factory: TransportFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const factory: TransportFactory = () => {
    const client = new FakeSocket()
    const serverSide = new FakeSocket()
    client.peer = serverSide
    serverSide.peer = client
    server.connect(serverSide)
    sockets.push(client)
    queueMicrotask(() => client.onopen?.())
    return client
  }
  return { factory, sockets }
}

/** A file generation's key (protocol 1.10): one room per `(file, docKey)`. */
function openKey(scope: OpenScope) {
  return [scope.tenant, scope.iss, scope.file, scope.docKey].join('\u0000')
}
