/**
 * An editor's collaboration session: its document's replica relayed to and from a room on a
 * `kition-sync/1` server (`startRelay`), through the page's shared `SyncClient`. Loaded only when
 * an editor co-edits, since it loads the CRDT engine for the relay's version handling.
 *
 * - **Before the kit opens** (`openCollabSession`): with a `room` (a document id or a share link),
 *   the room is resolved, and unless the replica stored with the file already is the room's for
 *   the file's current stamp (with or without this page's record of the room), the room's state
 *   and its blobs become the stored replica, under that stamp, so the kit opens the room's
 *   document (UI-R1) and its edits are the room's: its snapshot, brought up to the file's last
 *   save in a managed room, so it is never older than the file. A `viewer` role opens the kit
 *   read-only.
 * - **Once it has opened** (`attach`): the kit's replica id names the room. Without a record of
 *   it, the room is made from the document's whole history (after a save, so the stored replica
 *   keeps the id; an unedited document, with nothing to save, keeps the room's creation snapshot
 *   as its replica instead); then the relay starts, and presence follows the room. A role that turns out to
 *   be `viewer` reopens the kit read-only (the host's `reopenReadOnly`).
 */
import { openEnvelope, randomActor, Replica } from '@kition/kdm'
import { KitRpcError, LEASE_HELD_REASON, type KitConnection, type KitLease } from '@kition/kit-host'
import {
  DocumentLeases,
  SyncRpcError,
  leaseHolder,
  blobHashCandidates,
  decodeBlobSection,
  encodeBlobSection,
  startRelay,
  runSave,
  type SaveRun,
  type BlobEntry,
  type SaveState,
  type SaveTrigger,
  type Lease,
  type Presence,
  type Relay,
  type RelayReplica,
  type ReplicaVersions,
  type SyncClient,
  type TransportFactory,
} from '@kition/sync'
import { decodeOpenToken, isOpenToken, verifyOpenToken, type OpenTokenClaims } from '@kition/sync/openToken'
import { LORO_REPLICA_VERSIONS } from '@kition/sync/replicaVersions'
import { commentSchema } from './comments'
import { EmbedError } from './errors'
import { stampOf, toArrayBuffer, type NamedFile } from './handlers'
import { RoomRecords, fromHex, localState, toHex, type RoomRecord } from './rooms'
import { acquireSyncClient, sharedSyncClient, whenOnline } from './syncClients'
import type { BlobStore, CollabState, EmbedSaveInfo, EmbedCollaboration, EmbedEvents, EmbedKit, EmbedUser, IdentityProvider, PermissionMode, ReplicaStore, StorageProvider } from './types'

/** How long a session waits for the host to start the generation its kept copy made (SV5). */
const NEXT_GENERATION_WAIT_MS = 15_000
const BLOB_MIME = 'application/octet-stream'
/** How often a session holding a room's seed claim renews it while the kit opens (it lasts 60 s, RM5). */
const CLAIM_RENEW_MS = 20_000
/** How long an editor waits for another editor's seeding before it gives up (managed-collab.md section 2.2, step 4). */
const SEED_WAIT_MS = 30_000
const SEED_POLL_MS = 2_000
/** How often a managed room autosaves while it has unsaved changes (SV2). */
const AUTOSAVE_MS = 30_000
/** How long a save waits for another session's save of the room to end before it gives up. */
const SAVE_WAIT_MS = 30_000
/** How long a save waits between attempts while the room is being joined again after a reconnect. */
const REJOIN_RETRY_MS = 200

/** A save that could not begin because the connection dropped or the room is not joined again yet. */
function rejoining(error: unknown) {
  return error instanceof SyncRpcError && (error.message === 'disconnected' || error.reason === 'not-found' || error.reason === 'unavailable')
}
/** How often, and how many times, a `must-save` save is asked again while the kit has nothing to save yet. */
const MUST_SAVE_RETRY_MS = 250
const MUST_SAVE_TRIES = 20

/**
 * The documents co-edited on this page, each by one session, keyed by sync server and document
 * id: the page's client for a server joins a room once, so a second editor of the same document
 * is refused rather than left to fight the first over it.
 */
const openDocuments = new Map<string, CollabSession>()
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export type CollabHost = {
  kit: EmbedKit
  file: NamedFile
  storage: StorageProvider
  identity: IdentityProvider
  collaboration: EmbedCollaboration
  replicas: ReplicaStore
  emit: <E extends keyof EmbedEvents>(event: E, value: EmbedEvents[E]) => void
  /** Opens the kit again read-only (`comment`: still taking comments), carrying its unsaved changes. */
  reopenReadOnly: (mode: Exclude<PermissionMode, 'edit'>) => void
  /**
   * Opens the kit again from the stored file and replica, carrying nothing: a viewer that opened
   * a managed file before it had a room opens the room's document once it has one.
   */
  reopen?: () => void
  /** The file's version moved: another session of the room saved it (D3), so this editor's saves go over it. */
  onVersion?: (version: string) => void
  signal: AbortSignal
  createTransport?: TransportFactory
  versions?: ReplicaVersions
}

/** A document id as the editor compares them: lowercase hex, no hyphens. */
const sameDocId = (a: string, b: string) => a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase()

/** A document id given as a UUID, as rooms are named: lowercase and hyphenated. */
function canonicalDocId(text: string) {
  const hex = text.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/** The document id a stored replica's snapshot carries (its KDM envelope), or `null`. */
/**
 * Refuses a room's first state that does not carry the document's whole history (sync protocol
 * S20): a shallow replica truncated after the document's birth. Bytes the KDM cannot read are the
 * server's to refuse.
 */
function checkWholeHistory(snapshot: Uint8Array, name: string) {
  let whole = true
  try {
    whole = Replica.snapshotCarriesWholeHistory(snapshot)
  } catch {
    return
  }
  if (!whole) throw new Error(`${name} cannot be co-edited: its replica is a shallow one truncated after the document's birth, so it does not carry the document's whole history (sync protocol S20); open it from a full replica or a copy made as a new document`)
}

function snapshotDocId(snapshot: ArrayBuffer) {
  try {
    return toHex(openEnvelope(new Uint8Array(snapshot)).docId)
  } catch {
    return null
  }
}

/**
 * The blobs a room's snapshot references that the server holds, as a blob section: from the
 * page's blob store when it has them (`storage.blob`), else from the server.
 */
async function snapshotBlobs(client: SyncClient, docId: string, snapshot: Uint8Array, local?: BlobStore) {
  const candidates = blobHashCandidates(snapshot)
  if (!candidates.length) return new Uint8Array()
  const { missing } = await client.blobs.has(docId, candidates)
  const absent = new Set(missing)
  const entries: BlobEntry[] = []
  for (const hash of candidates) {
    if (absent.has(hash)) continue
    const kept = await local?.read(hash).catch(() => null)
    entries.push({ hash, data: kept ? new Uint8Array(toArrayBuffer(kept)) : (await client.blobs.get(docId, hash)).data })
  }
  return encodeBlobSection(entries)
}

/** Uploads a document's blobs for `docId`'s room (blobs are scoped to documents). */
async function uploadBlobs(client: SyncClient, docId: string, entries: BlobEntry[]) {
  if (!entries.length) return
  const { missing } = await client.blobs.has(docId, entries.map((entry) => entry.hash))
  const absent = new Set(missing)
  for (const entry of entries) if (absent.has(entry.hash)) await client.blobs.put(docId, entry.data, BLOB_MIME)
}

function relayReplica(connection: KitConnection): RelayReplica {
  return {
    version: () => connection.replica.version(),
    exportChanges: (since) => connection.replica.exportChanges(since),
    importChanges: (changes, blobs) => connection.replica.importChanges(changes, blobs),
    onChanged: (listener) => connection.replica.onChanged(listener),
  }
}

/** A sync lease as the kit sees it (Kit UI protocol section 7b). */
function kitLease(lease: Lease, self: boolean): KitLease {
  return { scope: lease.scope, holder: { principalId: lease.principalId, name: lease.name, self } }
}

export class CollabSession {
  /** The page's client this session co-edits through, from `connect` on (the first step of `prepare`). */
  private client!: SyncClient
  private release: () => void = () => undefined
  private readonly records: RoomRecords
  private readonly versions: ReplicaVersions
  private stopState: () => void = () => undefined
  private user: EmbedUser | null = null
  /** The agent working for the person in this editor (an open agent port), shown in presence (A20). */
  private agent: { name: string } | null = null
  private joinedDoc: string | null = null
  /** The room `adoptRoom` joined to catch its snapshot up, until a relay takes the membership over. */
  private adoptJoined: string | null = null
  /** The file generation (`doc_key`) of the room joined: the token may name a later one since (1.3). */
  private joinedDocKey: string | null = null
  private move: Promise<void> | null = null
  private record: RoomRecord | null = null
  private relay: Relay | null = null
  private stopPresence: (() => void) | null = null
  /** The kit's leases on the room's scopes, while attached (Kit UI protocol capability `lease`). */
  private leases: DocumentLeases | null = null
  private stopLeases: (() => void) | null = null
  /** The latest `attach`, which `shareLink` waits for. */
  private attached: Promise<void> = Promise.resolve()
  /** Counts `attach` calls: a start that an `attach` or `detach` replaced stops where it is. */
  private generation = 0
  private closed = false
  /** The `openDocuments` key this session holds. */
  private claimed: string | null = null
  /** Renews the seed claim of a managed room while the kit opens (RM5). */
  private claimRenewal: ReturnType<typeof setInterval> | null = null
  /** A managed editor found no room and no claim in time: it opens read-only (section 2.2, step 4). */
  private unavailable = false
  /** This session's connection is its own identity provider's: its token is an open token (KitCollab 1.4). */
  private managed = false
  /** The open token's claims, read (and with `openKeys` verified) when the session connected. */
  private claims: OpenTokenClaims | null = null
  /** The kit this session relays, while attached, and the mode it opened in. */
  private connection: KitConnection | null = null
  private mode: PermissionMode = 'view'
  /** What starts the kit's next save (D3): the person's Save unless the session asks for one itself. */
  private trigger: SaveTrigger | null = null
  private autosave: ReturnType<typeof setInterval> | null = null
  private stopSave: (() => void) | null = null
  private stopResolved: (() => void) | null = null
  private saveWaiters = new Set<() => void>()
  /** The room's changes this replica holds: every one up to `seenSeq`, and the ones it pushed after it. */
  private seenSeq = 0
  private pushedSeqs = new Set<number>()
  /** A saved version the kit is still to hear it holds (`document/held`), once the replica holds its `savedSeq`. */
  private heldPending: { version: string; seq: number } | null = null
  private heldSent: string | null = null
  state: CollabState

  constructor(private readonly host: CollabHost) {
    this.records = new RoomRecords(host.storage.state ?? localState())
    this.versions = host.versions ?? LORO_REPLICA_VERSIONS
    this.state = { status: 'offline', docId: null, role: null }
  }

  /**
   * Takes the page's client for the server. The identity provider is always asked for the token
   * first (managed-collab.md RM8, I8): an open token gets a connection of its own identity
   * provider for its file, never one another editor opened; a sync token joins the one editors
   * with sync tokens share for the server, or opens it with that token. A token that cannot be
   * had now is asked again by the client, which keeps retrying; it never joins a shared
   * connection, which could be another person's.
   */
  private async connect() {
    const { collaboration, identity, createTransport } = this.host
    const first = await Promise.resolve()
      .then(() => identity.token!())
      .catch(() => null)
    this.managed = isOpenToken(first)
    if (collaboration.open && !this.managed) throw new EmbedError('read-only', first === null ? 'no open token for this file' : 'the identity provider answered a token that is not an open token')
    if (this.managed) this.claims = await this.readClaims(first!)
    let firstUsed = first === null
    const token = () => {
      if (firstUsed) return identity.token!()
      firstUsed = true
      return first!
    }
    const acquired = this.managed
      ? acquireSyncClient(collaboration.server, token, createTransport, identity, this.claims?.file ?? this.host.file.id)
      : ((first !== null ? sharedSyncClient(collaboration.server) : null) ?? acquireSyncClient(collaboration.server, token, createTransport, first === null ? identity : undefined, this.host.file.id))
    this.client = acquired.client
    this.release = acquired.release
    this.state = { ...this.state, status: this.client.state }
    this.stopState = this.client.onState((status) => this.setState({ status }))
  }

  /** The open token's claims, verified against `collaboration.openKeys` when the page gives them (OT2). */
  private async readClaims(token: string) {
    const { openKeys: keys, openAudience } = this.host.collaboration
    if (keys?.length && !openAudience) throw new Error('collaboration.openKeys needs collaboration.openAudience, the server id open tokens name')
    if (!keys?.length || !openAudience) {
      try {
        return decodeOpenToken(token)
      } catch {
        return null
      }
    }
    try {
      return await verifyOpenToken(token, keys, openAudience)
    } catch (error) {
      throw new EmbedError('read-only', `the open token does not verify (${(error as { code?: string }).code ?? 'malformed'})`)
    }
  }

  /**
   * In a managed room: what the kit opens with from the token, with the
   * permissions as the sync server read them when it said (it verified the token), and the watermark.
   */
  get openDocument(): { permissions: { download: boolean; export: boolean; share: boolean }; watermark: { text: string } | null } | null {
    if (!this.managed) return null
    const perms = this.client.open?.perms ?? this.claims?.perms
    if (!perms) return null
    return { permissions: { download: perms.download, export: perms.export, share: perms.share }, watermark: this.claims?.watermark ? { text: this.claims.watermark.text } : null }
  }

  /** What the room lets this person do, once known: `view` for a viewer, `comment` for a commenter. */
  get roleMode(): PermissionMode | null {
    if (this.unavailable) return 'view'
    const role = this.record?.role ?? (this.managed ? this.client.open?.role : undefined)
    return role === 'viewer' ? 'view' : role === 'commenter' ? 'comment' : null
  }

  /** Before the kit opens: resolves the given room, and makes its replica the one the kit opens. */
  async prepare() {
    await this.connect()
    const { room } = this.host.collaboration
    this.user = (await this.host.identity.user?.()) ?? null
    if (!room?.trim()) {
      if (this.managed) await this.prepareManaged()
      return
    }
    const { kit, signal } = this.host
    let docId: string
    let role: RoomRecord['role'] | null = null
    let shareLink: string | undefined
    if (UUID.test(room.trim())) {
      docId = canonicalDocId(room.trim())
    } else {
      shareLink = room.trim()
      await whenOnline(this.client, signal)
      const opened = await this.client.openRoom(shareLink)
      if (opened.kit !== kit.id) throw new Error(`the room holds a ${opened.kit} document, not ${kit.id}`)
      docId = opened.docId
      role = opened.role
    }
    await this.adoptRoom(docId, role, shareLink)
  }

  /**
   * Before the kit opens, for a managed room (an open token, KitCollab 1.4; managed-collab.md
   * section 2.2): finds the room of the token's file generation, and when it has none, takes the
   * seed claim (an editor) so exactly one session seeds it, from the file's checkpoint when the
   * host keeps one for this version (CK2), else from the kit once it opens (`attach`). An editor
   * that finds another seeding waits for it.
   */
  private async prepareManaged() {
    const { signal } = this.host
    await whenOnline(this.client, signal)
    const scope = this.client.open
    if (!scope) throw new Error('the sync server does not take open tokens (KitCollab 1.4)')
    // The server's reading of the token decides; a token for another file never opens this one (I8).
    if (scope.file !== this.host.file.id) throw new EmbedError('read-only', `the open token is for another file (${scope.file}), not ${this.host.file.id}`)
    const editor = scope.role === 'editor'
    const deadline = Date.now() + SEED_WAIT_MS
    for (;;) {
      const resolved = await this.client.resolveRoom(editor)
      this.state = { ...this.state, save: resolved.save ?? null }
      if (resolved.docId) return this.adoptRoom(resolved.docId, scope.role)
      if (resolved.claimed) {
        this.renewClaim()
        const seeded = await this.seedFromCheckpoint()
        if (seeded) return this.adoptRoom(seeded, scope.role)
        // The kit opens the stored file and its replica seeds the room (`attach`).
        return
      }
      // A viewer opens the stored file, not live; an editor waits for the one seeding.
      if (!editor) return
      if (Date.now() >= deadline) {
        this.unavailable = true
        this.host.emit('error', new EmbedError('read-only', 'another editor is still preparing this document for co-editing; it is open read-only until then'))
        return
      }
      await this.roomOrPoll(signal)
    }
  }

  /** Resolves when the file generation's room appears or after a poll interval. */
  private roomOrPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        stop()
        signal.removeEventListener('abort', aborted)
      }
      const aborted = () => {
        done()
        reject(new Error('the editor was closed'))
      }
      const timer = setTimeout(() => {
        done()
        resolve()
      }, SEED_POLL_MS)
      const stop = this.client.onRoomResolved(() => {
        done()
        resolve()
      })
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted)
    })
  }

  private renewClaim() {
    this.stopClaim()
    this.claimRenewal = setInterval(() => void this.client.resolveRoom(true).catch(() => undefined), CLAIM_RENEW_MS)
  }

  private stopClaim() {
    if (this.claimRenewal) clearInterval(this.claimRenewal)
    this.claimRenewal = null
  }

  /**
   * Seeds the managed room from the file's checkpoint (the replica the host keeps with the file)
   * when it is the replica of the file as it is now (CK2): the room keeps the document's id after
   * Kition Server lost it. Answers the room's id, or `null` when there is no such checkpoint.
   */
  private async seedFromCheckpoint(): Promise<string | null> {
    const { kit, file, storage, replicas } = this.host
    const stamp = await stampOf(storage, file.id)
    const stored = await replicas.read(file.id).catch(() => null)
    if (!stamp || !stored || stored.fileStamp !== stamp) return null
    const hex = snapshotDocId(toArrayBuffer(stored.snapshot))
    if (!hex) return null
    const docId = canonicalDocId(hex)
    checkWholeHistory(new Uint8Array(toArrayBuffer(stored.snapshot)), file.name)
    await uploadBlobs(this.client, docId, decodeBlobSection(new Uint8Array(toArrayBuffer(stored.blobs))))
    try {
      await this.client.createRoom(docId, new Uint8Array(toArrayBuffer(stored.snapshot)), file.name, kit.id)
      return docId
    } catch (error) {
      if (error instanceof SyncRpcError && error.boundDocId) return error.boundDocId
      throw error
    } finally {
      this.stopClaim()
    }
  }

  /**
   * Makes `docId`'s room the one the kit opens: its state becomes the stored replica unless the
   * one stored already is the room's document for the file as it is now (its stamp).
   */
  private async adoptRoom(docId: string, role: RoomRecord['role'] | null, shareLink?: string) {
    const { kit, file, storage, replicas, signal } = this.host
    this.claim(docId)
    let record = await this.records.read(docId)
    const stamp = await stampOf(storage, file.id)
    if (!stamp) throw new Error(`${file.name} is not in the storage`)
    const stored = await replicas.read(file.id).catch(() => null)
    const storedDocId = stored ? snapshotDocId(toArrayBuffer(stored.snapshot)) : null
    // The stored replica is the room's document, kept for the file's current version (a save's
    // checkpoint, CK1, or this page's own save), whether or not this page has a record of the room.
    const current = Boolean(stored && stored.fileStamp === stamp && storedDocId && sameDocId(storedDocId, docId))
    if (current && !(record && record.fileId === file.id)) {
      // Another person's, another browser's, or a page whose site data is gone: nothing says which
      // of the room's changes the replica holds, or which of its own the room has. The first join
      // catches up from the room's snapshot (imports are idempotent), and what the room holds from
      // there tells the relay what it need not push.
      record = { docId, fileId: file.id, kit: kit.id, role: role ?? record?.role ?? 'editor', shareLink: shareLink ?? record?.shareLink }
      await this.records.write(record)
    } else if (!current) {
      // The room's document becomes this file's replica, never older than what the file holds.
      await whenOnline(this.client, signal)
      const room = await this.roomState(docId)
      const blobs = await snapshotBlobs(this.client, docId, room.snapshot, storage.blob)
      await replicas.write(file.id, { snapshot: toArrayBuffer(room.snapshot), blobs: toArrayBuffer(blobs), fileStamp: stamp })
      const version = this.versions.endOf(room.snapshot)
      // The first join catches up from `seq` (the snapshot's), as long as the replica still holds
      // its version then (`resumeSeq`).
      record = {
        docId,
        fileId: file.id,
        kit: kit.id,
        role: role ?? record?.role ?? 'editor',
        shareLink: shareLink ?? record?.shareLink,
        lastSent: version ? toHex(version) : undefined,
        seen: version ? { seq: room.seq, version: toHex(version) } : undefined,
      }
      await this.records.write(record)
    } else if (record && ((role && record.role !== role) || (shareLink && record.shareLink !== shareLink))) {
      record = { ...record, role: role ?? record.role, shareLink: shareLink ?? record.shareLink }
      await this.records.write(record)
    }
    this.record = record
    this.setState({ docId, role: record!.role })
  }

  /**
   * The room's state to store as the file's replica, and the `seq` it holds every change up to.
   * `snapshot/get` answers the room's last snapshot (its creation, or a compaction's), which can
   * be older than the file: in a managed room the file is the room's state at its last save
   * (`savedSeq`; a generation's file changes only through the room's saves, managed-collab.md
   * 1.3). Such a snapshot is brought up to the save: the room is joined from the snapshot's `seq`
   * (the relay joins it again, from the `seq` this answers, once the kit has opened) and the
   * changes up to `savedSeq` are imported into a copy of the snapshot, read with a schema of the
   * comment types alone, which reads any of the kit's documents. A catch-up that cannot be cut at
   * `savedSeq` (one the server answered from a compacted snapshot) is taken whole: the room's
   * latest state, which holds the file too.
   */
  private async roomState(docId: string): Promise<{ snapshot: Uint8Array; seq: number }> {
    const { snapshot, seq } = await this.client.snapshot(docId)
    const save = this.managed ? (await this.client.resolveRoom()).save : null
    if (!save || save.savedSeq <= seq) return { snapshot, seq }
    let replica: Replica
    try {
      replica = Replica.load(commentSchema(this.host.kit.id), snapshot, randomActor())
    } catch (error) {
      throw new Error(`the room's snapshot of ${this.host.file.name} does not load (${toError(error).message}); it is older than the file, so it is not stored as its replica`)
    }
    if (this.adoptJoined && this.adoptJoined !== docId) this.client.leave(this.adoptJoined)
    const joined = await this.client.join(docId, seq, {})
    this.adoptJoined = docId
    const cut = !joined.snapshot && joined.changes.length === joined.seq - seq
    const taken = cut ? joined.changes.slice(0, save.savedSeq - seq) : joined.changes
    for (const changes of taken) replica.importChanges(changes)
    return { snapshot: replica.exportChanges(), seq: cut ? save.savedSeq : joined.seq }
  }

  /** Once the kit has opened (again): relays its replica. Failures are reported as `error` events. */
  attach(connection: KitConnection, mode: PermissionMode) {
    this.detach()
    const generation = this.generation
    this.attached = this.start(connection, mode, () => this.closed || generation !== this.generation).catch((error: unknown) => {
      if (!this.closed) this.host.emit('error', toError(error))
    })
    return this.attached
  }

  /** Stops relaying (the kit is about to close or reopen). */
  detach() {
    this.generation += 1
    this.stopSave?.()
    this.stopSave = null
    if (this.autosave) clearInterval(this.autosave)
    this.autosave = null
    this.connection = null
    this.stopResolved?.()
    this.stopResolved = null
    // Leases first, while the room is still joined.
    this.stopLeases?.()
    this.stopLeases = null
    this.leases?.dispose()
    this.leases = null
    this.relay?.stop()
    this.relay = null
    this.stopPresence?.()
    this.stopPresence = null
  }

  /** `host/leaseAcquire`: holds `scope` in the room; `{ lease: null }` before the room is joined or while offline. */
  async acquireLease({ scope, ttl }: { scope: string; ttl?: number }): Promise<{ lease: KitLease | null }> {
    const leases = this.leases
    if (!leases) return { lease: null }
    try {
      const lease = await leases.acquire(scope, ttl)
      return { lease: lease ? kitLease(lease, true) : null }
    } catch (error) {
      const holder = leaseHolder(error)
      if (holder) throw new KitRpcError(-32000, `${holder.name} is editing it`, { reason: LEASE_HELD_REASON, lease: kitLease(holder, false) })
      if (error instanceof SyncRpcError && error.reason === 'forbidden') throw new KitRpcError(-32000, 'the document is read-only', { reason: 'read-only' })
      throw error
    }
  }

  async releaseLease({ scope }: { scope: string }) {
    await this.leases?.release(scope)
  }

  listLeases(): KitLease[] {
    const leases = this.leases
    return leases ? leases.list().map((lease) => kitLease(lease, leases.mine(lease))) : []
  }

  /**
   * Once the kit has opened: holds the document its replica names for this session, refusing it
   * (`EmbedError` `document-open`) when another editor on the page co-edits it. A kit without a
   * replica id is left for `attach` to report.
   */
  async claimOpened(connection: KitConnection) {
    if (!connection.capabilities.includes('replica')) return
    // Asking for the version makes the replica when the document has none yet.
    await connection.replica.version()
    const docId = await connection.replica.info()
    if (docId) this.claim(docId)
  }

  private claim(docId: string) {
    const key = `${this.host.collaboration.server} ${canonicalDocId(docId)}`
    if (this.claimed === key) return
    const holder = openDocuments.get(key)
    if (holder && holder !== this) throw new EmbedError('document-open', `document ${canonicalDocId(docId)} is already open in another editor on this page`)
    this.unclaim()
    openDocuments.set(key, this)
    this.claimed = key
  }

  private unclaim() {
    if (this.claimed && openDocuments.get(this.claimed) === this) openDocuments.delete(this.claimed)
    this.claimed = null
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.stopClaim()
    this.unclaim()
    this.detach()
    if (this.adoptJoined) this.client.leave(this.adoptJoined)
    this.adoptJoined = null
    this.stopState()
    this.release()
    this.setState({ status: 'off' })
  }

  /** A link to the room granting `role`: the room's own link for its owner, a new one otherwise. */
  async shareLink(role: 'editor' | 'viewer' = 'editor') {
    await this.attached
    const record = this.record
    if (!record) throw new Error('the document has no room yet')
    if (role === 'editor' && record.role === 'owner' && record.shareLink) return record.shareLink
    await whenOnline(this.client, this.host.signal)
    try {
      return (await this.client.createLink(record.docId, role)).shareLink
    } catch (error) {
      // The person's role may not share, or the room is an integrator's on Kition Cloud (KitCollab
      // 1.3), which grants access by sync token only and has no share links.
      if (error instanceof SyncRpcError && error.reason === 'forbidden') throw new EmbedError('read-only', 'this room cannot be shared by this person: their role, or a room that grants access by sync token only')
      throw error
    }
  }

  private async start(connection: KitConnection, mode: PermissionMode, replaced: () => boolean) {
    const { kit, file } = this.host
    if (!connection.capabilities.includes('replica')) throw new Error(`${kit.id} cannot be co-edited: it keeps no replica`)
    const replica = relayReplica(connection)
    // Asking for the version makes the replica when the document has none yet.
    await replica.version()
    const docId = await connection.replica.info()
    if (!docId) throw new Error(`${file.name} has no replica id to co-edit with`)
    if (this.record && !sameDocId(this.record.docId, docId)) throw new Error(`${file.name} did not open as the room's document`)
    this.claim(docId)
    // A managed room is the one `prepare` adopted, or none: a record this page kept of an earlier
    // generation's room never stands in for it (managed-collab.md section 1.3).
    const managed = this.managed
    let record = this.record ?? (managed ? null : await this.records.read(docId))
    if (!record) {
      if (managed && mode !== 'edit') {
        // It shows the saved file until an editor opens it, then opens the room's document.
        this.waitForRoom()
        return
      }
      if (mode !== 'edit') throw new Error(`${file.name} is open read-only and has no room to join`)
      record = await this.createRoom(connection, docId)
    }
    if (replaced()) return
    this.record = record
    this.setState({ docId, role: record.role })
    const since = await this.resumeSeq(record, replica)
    if (replaced()) return
    this.stopPresence = this.client.onPresence(docId, (peers: Presence[]) => this.host.emit('presence', peers))
    const leases = new DocumentLeases(this.client.leases, docId)
    this.leases = leases
    let reported: KitLease[] = []
    this.stopLeases = leases.onChanged((list) => {
      const now = list.map((lease) => kitLease(lease, leases.mine(lease)))
      connection.leasesChanged(now)
      // The page hears which scopes were taken and given up since the last list.
      const key = (lease: KitLease) => `${lease.scope}\u0000${lease.holder.principalId}`
      const before = new Set(reported.map(key))
      const after = new Set(now.map(key))
      const held = now.filter((lease) => !before.has(key(lease)))
      const released = reported.filter((lease) => !after.has(key(lease)))
      reported = now
      if (held.length || released.length) this.host.emit('leases', { leases: now, held, released })
    })
    if (managed) this.followSaves(docId, connection, mode)
    this.seenSeq = since ?? 0
    this.pushedSeqs.clear()
    const client = this.client
    // The relay's pushes, recorded: their seqs are changes this replica holds (`document/held`).
    const sync = Object.create(client) as SyncClient
    sync.push = async (pushedDoc: string, changes: Uint8Array) => {
      const pushed = await client.push(pushedDoc, changes)
      this.pushedSeqs.add(pushed.seq)
      this.offerHeld()
      return pushed
    }
    this.adoptJoined = null
    this.relay = startRelay({
      docId,
      replica,
      sync,
      versions: this.versions,
      lastSent: fromHex(record.lastSent),
      since,
      onSent: (version) => void this.records.update(docId, { lastSent: toHex(version) }),
      onSeen: ({ seq, version }) => {
        this.seenSeq = Math.max(this.seenSeq, seq)
        this.offerHeld()
        void this.records.update(docId, { seen: { seq, version: toHex(version) } })
      },
      onJoined: ({ presence, role }) => {
        this.host.emit('presence', presence)
        this.joinedDoc = docId
        this.joinedDocKey = this.client.open?.docKey ?? null
        this.takeRole(docId, role)
        this.sendPresence()
        if (!this.reopenFor(role, mode) && managed && mode === 'edit' && this.state.save?.status === 'must-save') void this.saveNow('command')
      },
      // A role changed while joined (`room/access`), or while the connection was down (the re-join
      // after reconnecting answered another): the kit opens again as the new role allows.
      onAccess: (role) => {
        if (!role) return
        this.takeRole(docId, role)
        this.reopenFor(role, mode)
      },
      onError: (error) => this.host.emit('error', toError(error)),
    })
  }

  /** Records `role` as this person's role in `docId`'s room. */
  private takeRole(docId: string, role: RoomRecord['role']) {
    if (this.record && this.record.role !== role) {
      this.record = { ...this.record, role }
      void this.records.update(docId, { role })
    }
    this.setState({ role })
  }

  /** Opens the kit again read-only when `role` allows less than the kit was opened with (`mode`). */
  private reopenFor(role: RoomRecord['role'], mode: PermissionMode): boolean {
    if (role === 'viewer' && mode !== 'view') this.host.reopenReadOnly('view')
    else if (role === 'commenter' && mode === 'edit') this.host.reopenReadOnly('comment')
    else return false
    return true
  }

  /**
   * A managed viewer whose file had no room: when an editor makes it, the room's document becomes
   * the stored replica and the kit opens it again, live.
   */
  private waitForRoom() {
    if (this.stopResolved) return
    const role = this.client.open?.role ?? 'viewer'
    const adopt = (docId: string) => {
      this.stopResolved?.()
      this.stopResolved = null
      void this.adoptRoom(docId, role)
        .then(() => {
          if (!this.closed) this.host.reopen?.()
        })
        .catch((error: unknown) => {
          if (!this.closed) this.host.emit('error', toError(error))
        })
    }
    this.stopResolved = this.client.onRoomResolved(adopt)
    // The room may have appeared between `prepare` and now.
    void this.client.resolveRoom().then((resolved) => {
      if (resolved.docId && this.stopResolved) adopt(resolved.docId)
    }, () => undefined)
  }

  /**
   * In a managed room: follows its save state (D3), moves this editor's file version along with
   * every session's saves, autosaves an editor's unsaved changes (SV2), and saves first when the
   * room waits for one (`must-save`, SV4).
   */
  private followSaves(docId: string, connection: KitConnection, mode: PermissionMode) {
    this.connection = connection
    this.mode = mode
    this.stopSave?.()
    this.stopSave = this.client.onSave(docId, (save) => this.saveChanged(save))
    // The state as it is now (a room this session just made has no change yet to announce it).
    void this.client.resolveRoom().then(
      (resolved) => {
        if (resolved.save && this.connection === connection && !this.state.save) this.setState({ save: resolved.save })
      },
      () => undefined,
    )
    if (mode !== 'edit') return
    const every = this.host.collaboration.autosaveMs ?? AUTOSAVE_MS
    if (this.autosave) clearInterval(this.autosave)
    this.autosave = setInterval(() => {
      const save = this.state.save
      if (save?.dirty && save.status === 'editing') void this.saveNow('timer')
    }, every)
  }

  /** Whether this replica holds every change of the room up to `seq`. */
  private holds(seq: number) {
    for (let next = this.seenSeq + 1; next <= seq; next += 1) if (!this.pushedSeqs.has(next)) return false
    return true
  }

  /**
   * Tells the kit a saved version holds nothing it lacks (`document/held`), once its replica holds
   * the room's changes up to the save's `seq`: a co-editor's save is no file "changed on disk".
   */
  private offerHeld() {
    const pending = this.heldPending
    const connection = this.connection
    if (!pending || !connection || !this.holds(pending.seq)) return
    this.heldPending = null
    if (this.heldSent === pending.version) return
    this.heldSent = pending.version
    connection.fileHeld(pending.version)
  }

  private saveChanged(save: SaveState) {
    this.setState({ save })
    if (save.status !== 'force-save' && save.version && !save.reason) {
      this.heldPending = { version: save.version, seq: save.savedSeq }
      this.offerHeld()
    }
    if (save.status !== 'force-save') {
      if (save.version) this.host.onVersion?.(save.version)
      for (const wake of [...this.saveWaiters]) wake()
    }
    if (save.status === 'must-save' && this.mode === 'edit') void this.saveNow('command')
  }

  /**
   * Has the kit save, as started by `trigger` (its own Save is the person's). Failures are
   * reported, never thrown. A room waiting for a save (`must-save`) whose kit has not caught up
   * with the room's changes yet (nothing to save) is asked again a few times.
   */
  async saveNow(trigger: SaveTrigger, attempt = 0): Promise<void> {
    const connection = this.connection
    if (!connection || this.mode !== 'edit' || this.trigger) return
    this.trigger = trigger
    let saved = true
    try {
      saved = (await connection.save()).saved
    } catch (error) {
      if (!this.closed) this.host.emit('error', toError(error))
    } finally {
      this.trigger = null
    }
    if (!saved && this.state.save?.status === 'must-save' && attempt < MUST_SAVE_TRIES && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, MUST_SAVE_RETRY_MS))
      if (this.connection === connection) await this.saveNow(trigger, attempt + 1)
    }
  }

  /**
   * The save coordinator the editor's handlers run every save of a managed room through
   * (managed-collab.md section 3); `null` before the room is joined or outside a managed room.
   */
  /** Whether this session co-edits a managed room (an open token's, KitCollab 1.4). */
  isManaged(): boolean {
    return this.managed
  }

  /**
   * Whether the file moved to a later co-editing generation since this session joined its room
   * (managed-collab.md 1.3): the host changed the file outside the room, and the token now names
   * the next `doc_key`. The room joined can save no more.
   */
  generationMoved(): boolean {
    const now = this.client?.open?.docKey
    return this.managed && Boolean(this.joinedDocKey && now && now !== this.joinedDocKey)
  }

  /** Whether the token's file generation has a room already (someone opened the new version live). */
  async nextGenerationHasRoom(): Promise<boolean> {
    return Boolean((await this.client.resolveRoom(false)).docId)
  }

  /**
   * After the person's copy became the file's content (SV5): waits for the host to start the
   * generation that write makes (its token names a new `doc_key`), then prepares that generation's
   * room and opens the kit on it, live.
   */
  moveToNextGeneration(before: string | null): Promise<void> {
    this.move ??= this.runMove(before).finally(() => {
      this.move = null
    })
    return this.move
  }

  /** The move to the next generation under way (SV5): saves wait for it, then go through the new room. */
  moving(): Promise<void> | null {
    return this.move
  }

  private async runMove(before: string | null) {
    const deadline = Date.now() + NEXT_GENERATION_WAIT_MS
    while (Date.now() < deadline && !this.closed && this.client.open?.docKey === before) await new Promise((resolve) => setTimeout(resolve, 100))
    if (this.closed) return
    this.detach()
    this.unclaim()
    this.record = null
    this.joinedDoc = null
    this.joinedDocKey = null
    this.setState({ docId: null, role: null, save: null })
    await this.prepareManaged()
    this.host.reopen?.()
  }

  /** The `doc_key` the token names now. */
  currentDocKey(): string | null {
    return this.client?.open?.docKey ?? null
  }

  coordinator(): ((write: (save: EmbedSaveInfo) => Promise<string>) => Promise<string>) | null {
    const docId = this.joinedDoc
    const docKey = this.client?.open?.docKey
    if (!this.managed || !docId || !docKey) return null
    return async (write) => {
      const trigger = this.trigger ?? 'user'
      const deadline = Date.now() + SAVE_WAIT_MS
      for (;;) {
        let run: SaveRun
        try {
          run = await runSave({
            client: this.client,
            docId,
            trigger,
            write: ({ seq, authors, receipt }) => write({ trigger, seq, authors, receipt, docKey, docId }),
            checkpoint: ({ version }) => this.checkpoint(version),
          })
        } catch (error) {
          // The connection is coming back (a revoked open token, a network drop) and the room is
          // not joined again yet: the save begins once it is, within the same wait (SV1).
          if (!rejoining(error) || Date.now() >= deadline) throw error
          await this.rejoined(deadline - Date.now())
          continue
        }
        if (run.status === 'saved') return run.version
        if (run.status === 'failed') throw run.cause
        const current = this.state.save?.version ?? null
        if (run.status === 'clean') {
          if (current) return current
          throw new Error('the room has nothing to save and no version yet')
        }
        // Another session saves the room now: its version holds these changes too, or the next save will.
        if (Date.now() >= deadline) throw new Error('another editor is still saving this document')
        await this.saveEnded(deadline - Date.now())
      }
    }
  }

  /** Waits until the client is online again, then a moment for its rooms to be joined again. */
  private async rejoined(ms: number) {
    const online = whenOnline(this.client, this.host.signal)
    await Promise.race([online, new Promise((resolve) => setTimeout(resolve, ms))])
    await new Promise((resolve) => setTimeout(resolve, Math.min(REJOIN_RETRY_MS, Math.max(0, ms))))
  }

  private saveEnded(ms: number) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.saveWaiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.saveWaiters.add(wake)
    })
  }

  /** CK1: after a saved version, the room's state becomes the file's checkpoint for it. */
  private async checkpoint(version: string) {
    const connection = this.connection
    if (!connection) return
    const exported = await connection.replica.exportChanges(new ArrayBuffer(0))
    await this.host.replicas.write(this.host.file.id, { snapshot: exported.changes, blobs: exported.blobs, fileStamp: version })
  }

  /** Makes the document's room from its whole history, its blobs uploaded first. */
  private async createRoom(connection: KitConnection, docId: string): Promise<RoomRecord> {
    const { kit, file, signal } = this.host
    await whenOnline(this.client, signal)
    // Saved first, so the replica stored with the file carries its id into later sessions. A
    // managed room is seeded from the file as it is (managed-collab.md 1.3): writing it here would
    // make a version over it (an upload, say) that nobody edited, so only the replica is kept.
    const { saved } = this.managed ? { saved: false } : await connection.save()
    const version = new Uint8Array(await connection.replica.version())
    const exported = await connection.replica.exportChanges(new ArrayBuffer(0))
    checkWholeHistory(new Uint8Array(exported.changes), file.name)
    // An unedited document has nothing to save, so the kit kept no replica: the room's creation
    // snapshot becomes it, under the file's current stamp, so the document opens again with the
    // same id (and room) after a reload.
    if (!saved) await this.keepReplica(docId, exported)
    await uploadBlobs(this.client, docId, decodeBlobSection(new Uint8Array(exported.blobs)))
    let record: RoomRecord
    try {
      const { shareLink } = await this.client.createRoom(docId, new Uint8Array(exported.changes), file.name, kit.id)
      // A room answered without a link is an integrator's (KitCollab 1.3): the sync token's role
      // holds there, and the join answers it; until then the person counts as an editor.
      record = shareLink
        ? { docId, fileId: file.id, kit: kit.id, role: 'owner', shareLink, lastSent: toHex(version) }
        : { docId, fileId: file.id, kit: kit.id, role: 'editor', lastSent: toHex(version) }
    } catch (error) {
      // The room exists (made by an earlier session whose record is gone): join it instead.
      if (!(error instanceof SyncRpcError) || error.reason !== 'conflict') throw error
      // A managed file generation already has another room (RM6): this replica is not its document.
      if (error.boundDocId && !sameDocId(error.boundDocId, docId)) throw new Error(`${file.name} was opened for co-editing by another editor first; open it again`)
      record = { docId, fileId: file.id, kit: kit.id, role: 'editor' }
    } finally {
      this.stopClaim()
    }
    await this.records.write(record)
    return record
  }

  /** Stores `exported` as the file's replica unless the one stored is already this document's, for the file as it is. */
  private async keepReplica(docId: string, exported: { changes: ArrayBuffer; blobs: ArrayBuffer }) {
    const { file, storage, replicas } = this.host
    const stamp = await stampOf(storage, file.id)
    if (!stamp) return
    const stored = await replicas.read(file.id).catch(() => null)
    const storedDocId = stored ? snapshotDocId(toArrayBuffer(stored.snapshot)) : null
    if (stored && stored.fileStamp === stamp && storedDocId && sameDocId(storedDocId, docId)) return
    await replicas.write(file.id, { snapshot: exported.changes, blobs: exported.blobs, fileStamp: stamp })
  }

  /**
   * The server `seq` to join from: the one an earlier session saw, if the replica still holds the
   * version it had then; otherwise from the room's snapshot.
   */
  private async resumeSeq(record: RoomRecord, replica: RelayReplica) {
    if (!record.seen) return null
    try {
      const version = new Uint8Array(await replica.version())
      return this.versions.includes(version, fromHex(record.seen.version)) ? record.seen.seq : null
    } catch {
      return null
    }
  }

  /** An agent started (a name) or stopped (`null`) working for the person here (`KitAgent 1.4` A20). */
  setAgent(agent: { name: string } | null) {
    this.agent = agent
    this.sendPresence()
  }

  private sendPresence() {
    if (!this.joinedDoc) return
    this.client.setPresence(this.joinedDoc, { kit: this.host.kit.id, user: this.user, ...(this.agent ? { agent: { name: this.agent.name, origin: 'agent' } } : {}) })
  }

  private setState(patch: Partial<CollabState>) {
    const next = { ...this.state, ...patch }
    if (next.status === this.state.status && next.docId === this.state.docId && next.role === this.state.role && next.save === this.state.save) return
    this.state = next
    this.host.emit('collab', next)
  }
}

/** Starts an editor's collaboration session, up to the point the kit may open. */
export async function openCollabSession(host: CollabHost) {
  const session = new CollabSession(host)
  try {
    await session.prepare()
    return session
  } catch (error) {
    session.close()
    throw error
  }
}
