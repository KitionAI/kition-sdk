// @vitest-environment jsdom
/**
 * Managed co-editing (KitCollab 1.4, docs/platform/managed-collab.md) against the sync package's
 * `FakeServer`: editors mount with open tokens and no `room`, Kition Server keeps one room per file
 * generation, one editor seeds it (D1), the token's permissions and watermark reach the kit (D2),
 * and saves go through the room's save state machine (D3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeServer, fakeTransport } from '../../sync/test/helpers'
import type { OpenScope } from '../../sync/src/protocol'
import type { TransportFactory } from '../../sync/src/transport'
import { signOpenToken } from '../../sync/src/openToken'
import { mountEmbed } from '../src/mount'
import { memoryReplicaStore } from '../src/replicaStore'
import { localState, RoomRecords } from '../src/rooms'
import type { EmbedCollaboration, EmbedEditor, EmbedSaveInfo } from '../src/types'
import { Replica } from '@kition/kdm'
import { fakeKit, NOTE_SCHEMA } from './fakeKit'
import { memoryStorage } from './memoryStorage'

const wait = { timeout: 4000, interval: 10 }
const KIT = { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }
const editors: EmbedEditor[] = []
let servers = 0

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

const perms = (role: OpenScope['role']) => ({ edit: role === 'editor', comment: role !== 'viewer', download: role === 'editor', share: false, export: true })
const scope = (file: string, role: OpenScope['role'], docKey = 'k1'): OpenScope => ({ tenant: 'acme', iss: 'one.test', file, docKey, role, perms: perms(role) })

const b64 = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** An open token's shape for the fake server, which knows it by its text; its claims decode. */
function fakeToken(person: string, scoped: OpenScope, watermark: string | null = null) {
  const claims = { v: 1, typ: 'kition-open', kid: 'k', iss: 'one.test', aud: 'kition-server-test', tenant: 'acme', sub: person, name: person, file: scoped.file, version: 'v1', doc_key: scoped.docKey, perms: scoped.perms, watermark: watermark ? { text: watermark } : null, iat: 1, exp: 2 }
  return `ko1.${b64(JSON.stringify(claims))}.${b64(`${person}-${scoped.file}-${scoped.role}-${scoped.docKey}`)}`
}

function sync() {
  return { server: new FakeServer(), url: `ws://sync.test/managed/${(servers += 1)}` }
}

/**
 * What one person's browser keeps. Tests run every browser in one page, so each has its own
 * server URL suffix (`at`): a page co-edits a document in one editor only.
 */
type Browser = { replicas: ReturnType<typeof memoryReplicaStore>; state: ReturnType<typeof localState>; at: string }
let browsers = 0
const browser = (): Browser => ({ replicas: memoryReplicaStore(), state: localState(null), at: `/b${(browsers += 1)}` })

type Files = ReturnType<typeof memoryStorage>
/** Every write the storage took, with what the save said it holds. */
function recording(files: Files, delayMs = 0) {
  const writes: Array<{ fileId: string; text: string; save?: EmbedSaveInfo; expectedVersion: string | null }> = []
  /** How many writes ran at once, at most (each takes `delayMs`, as a host's would). */
  const overlap = { now: 0, most: 0 }
  const storage = {
    ...files.storage,
    write: async (fileId: string, bytes: Uint8Array, options: { expectedVersion: string | null; save?: EmbedSaveInfo }) => {
      writes.push({ fileId, text: new TextDecoder().decode(bytes), expectedVersion: options.expectedVersion, ...(options.save ? { save: options.save } : {}) })
      overlap.now += 1
      overlap.most = Math.max(overlap.most, overlap.now)
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        return await files.storage.write(fileId, bytes, options)
      } finally {
        overlap.now -= 1
      }
    },
  }
  return { storage, writes, overlap }
}

/** A transport whose `room/join` waits for `gate`: the editor opens and the kit mounts, but the room is not joined yet. */
function holdingRooms(factory: TransportFactory, gate: Promise<void>): TransportFactory {
  return (...args) => {
    const socket = factory(...args)
    const send = socket.send.bind(socket)
    socket.send = (data) => {
      if (typeof data === 'string' && /"method":"room\/join"/.test(data)) void gate.then(() => send(data))
      else send(data)
    }
    return socket
  }
}

type OpenOptions = { kept?: Browser; token?: string; collaboration?: Partial<EmbedCollaboration>; writes?: ReturnType<typeof recording>; wait?: boolean; joinGate?: Promise<void>; transport?: ReturnType<typeof fakeTransport>; rewrites?: boolean; rebuildsOnOpen?: boolean }

/** One editor of `scoped.file` in `person`'s browser, with an open token for `scoped`. */
async function open(at: ReturnType<typeof sync>, person: { id: string; name: string }, scoped: OpenScope, files: Files, options: OpenOptions = {}) {
  const kept = options.kept ?? browser()
  const token = options.token ?? fakeToken(person.id, scoped)
  at.server.identifyOpen(token, { id: `t:acme:${person.id}`, name: person.name, color: '#5645d4' }, scoped)
  const kit = fakeKit(undefined, undefined, { rebuildsOnOpen: options.rebuildsOnOpen })
  // A kit that rewrites what it opened (Doc, Sheet): unsaved changes from the moment it opens.
  const mountKit: typeof kit.mountKit = options.rewrites ? async (...args) => { const connection = await kit.mountKit(...args); kit.last().dirty = true; return connection } : kit.mountKit
  const element = document.createElement('div')
  document.body.append(element)
  const tokens = vi.fn(async () => token)
  const recorded = options.writes ?? recording(files)
  const editor = await mountEmbed(
    element,
    {
      kit: KIT,
      file: { id: scoped.file, name: `${scoped.file}.note` },
      storage: { ...recorded.storage, replica: kept.replicas, state: kept.state },
      identity: { token: tokens, user: () => person },
      collaboration: { server: `${at.url}${kept.at}`, open: true, ...options.collaboration },
    },
    { mountKit, replicaStore: memoryReplicaStore, createTransport: options.joinGate ? holdingRooms((options.transport ?? fakeTransport(at.server)).factory, options.joinGate) : (options.transport ?? fakeTransport(at.server)).factory },
  )
  editors.push(editor)
  const errors: Error[] = []
  editor.on('error', (error) => errors.push(error))
  if (options.wait !== false) await editor.ready()
  return { editor, kit, errors, tokens, kept, writes: recorded.writes, overlap: recorded.overlap }
}

async function online(side: Awaited<ReturnType<typeof open>>, role: string) {
  await vi.waitFor(() => expect(side.editor.collab.state).toMatchObject({ status: 'online', role }), wait)
}

describe('managed co-editing (D1)', () => {
  it('seeds one room when two editors first-open a file at once, and both co-edit it (MC-05)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const [ann, bob] = await Promise.all([open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files), open(at, { id: 'bob', name: 'Bob' }, scope('res:1', 'editor'), files)])
    await online(ann, 'editor')
    await online(bob, 'editor')
    expect(at.server.rooms.size).toBe(1)
    expect([...at.server.bindings.values()]).toEqual([ann.editor.collab.state.docId])
    expect(bob.editor.collab.state.docId).toBe(ann.editor.collab.state.docId)
    expect(at.server.calls.filter((call) => call.method === 'room/create')).toHaveLength(1)
    ann.kit.last().edit('Hello')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello'), wait)
    bob.kit.last().edit(', Bob')
    await vi.waitFor(() => expect(ann.kit.last().text()).toBe('Hello, Bob'), wait)
    expect([...ann.errors, ...bob.errors]).toEqual([])
    // No wildcard: every hello was an exact file's open token.
    expect(at.server.calls.filter((call) => call.method === 'sync/hello').every((call) => String(call.params.token).startsWith('ko1.'))).toBe(true)
  })

  it('opens an editor of one file and a viewer of another in one page, each with its own connection and role (MC-02)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:A': '', 'res:B': '' })
    // Bob opened B earlier, so it has a room.
    const bobB = await open(at, { id: 'bob', name: 'Bob' }, scope('res:B', 'editor'), files)
    await online(bobB, 'editor')
    const page = browser()
    const annA = await open(at, { id: 'ann', name: 'Ann' }, scope('res:A', 'editor'), files, { kept: page })
    const annB = await open(at, { id: 'ann', name: 'Ann' }, scope('res:B', 'viewer'), files, { kept: { replicas: memoryReplicaStore(), state: page.state, at: page.at } })
    await online(annA, 'editor')
    await online(annB, 'viewer')
    expect(annA.editor.collab.state.docId).not.toBe(annB.editor.collab.state.docId)
    expect(annB.editor.collab.state.docId).toBe(bobB.editor.collab.state.docId)
    // Each mount's own token, on its own connection to the same server URL.
    const hellos = at.server.calls.filter((call) => call.method === 'sync/hello').map((call) => call.params.token)
    expect(hellos).toContain(fakeToken('ann', scope('res:A', 'editor')))
    expect(hellos).toContain(fakeToken('ann', scope('res:B', 'viewer')))
    bobB.kit.last().edit('from Bob')
    await vi.waitFor(() => expect(annB.kit.last().text()).toBe('from Bob'), wait)
    // Closing A leaves B's connection, token and role alone (MC-03).
    annA.editor.destroy()
    bobB.kit.last().edit('!')
    await vi.waitFor(() => expect(annB.kit.last().text()).toBe('from Bob!'), wait)
    expect(annB.editor.collab.state.role).toBe('viewer')
  })

  it('reseeds a lost room from the file`s checkpoint, keeping the document`s id (CK2)', async () => {
    const files = memoryStorage({ 'res:1': '' })
    const kept = browser()
    const first = sync()
    const ann = await open(first, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { kept })
    await online(ann, 'editor')
    const docId = ann.editor.collab.state.docId
    ann.editor.destroy()
    // Kition Server restored into fresh storage: no rooms; the host still has the checkpoint.
    const restored = sync()
    const again = await open(restored, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { kept })
    await online(again, 'editor')
    expect(again.editor.collab.state.docId).toBe(docId)
    expect([...restored.server.bindings.values()]).toEqual([docId])
    expect(again.errors).toEqual([])
  })

  it('never lets a viewer seed the room, and makes it live once an editor opens the file (MC-07)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': 'saved text' })
    const cy = await open(at, { id: 'cy', name: 'Cy' }, scope('res:1', 'viewer'), files)
    expect(at.server.rooms.size).toBe(0)
    expect(cy.editor.collab.state.docId).toBeNull()
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files)
    await online(ann, 'editor')
    await vi.waitFor(() => expect(cy.editor.collab.state).toMatchObject({ docId: ann.editor.collab.state.docId, role: 'viewer' }), wait)
    expect(at.server.calls.filter((call) => call.method === 'room/create')).toHaveLength(1)
    ann.kit.last().edit('live')
    await vi.waitFor(() => expect(cy.kit.last().text()).toBe('live'), wait)
    expect(cy.errors).toEqual([])
  })

  it('refuses a token for another file, and a token that is not an open token (I8)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const other = scope('res:2', 'editor')
    const wrong = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { token: fakeToken('ann', other), wait: false })
    at.server.identifyOpen(fakeToken('ann', other), { id: 't:acme:ann', name: 'Ann', color: '#000' }, other)
    await expect(wrong.editor.ready()).rejects.toThrow(/another file/)
    const plain = await open(at, { id: 'bo', name: 'Bo' }, scope('res:1', 'editor'), files, { token: 'ks1.not-an-open-token', wait: false })
    await expect(plain.editor.ready()).rejects.toThrow(/not an open token/)
  })
})

describe('managed co-editing: open tokens in the page (D2)', () => {
  it('opens the kit with the token`s display permissions and watermark', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const scoped = scope('res:1', 'commenter')
    const cy = await open(at, { id: 'cy', name: 'Cy' }, scoped, files, { token: fakeToken('cy', scoped, 'Cy 2026-11-03') })
    const document = cy.kit.last().options.document
    expect(document.permissions).toEqual({ download: false, export: true, share: false })
    expect(document.watermark).toEqual({ text: 'Cy 2026-11-03' })
    expect(document.readOnly).toBe(true)
  })

  it('verifies the token against the host`s keys when the page gives them (OT2)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const publicKey = b64(String.fromCharCode(...raw))
    const now = Math.floor(Date.now() / 1000)
    const scoped = scope('res:1', 'editor')
    const claims = { iss: 'one.test', aud: 'kition-server-test', tenant: 'acme', sub: 'ann', name: 'Ann', file: 'res:1', version: 'v1', doc_key: 'k1', perms: scoped.perms, watermark: null, iat: now, exp: now + 300 }
    const good = await signOpenToken(claims, 'k1', pair.privateKey)
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scoped, files, { token: good, collaboration: { openKeys: [{ kid: 'k1', publicKey, tenant: 'acme', iss: 'one.test' }], openAudience: 'kition-server-test' } })
    await online(ann, 'editor')
    const forged = `${good.slice(0, good.lastIndexOf('.'))}.${b64('x'.repeat(64))}`
    const bad = await open(at, { id: 'bo', name: 'Bo' }, scoped, files, { token: forged, collaboration: { openKeys: [{ kid: 'k1', publicKey, tenant: 'acme', iss: 'one.test' }], openAudience: 'kition-server-test' }, wait: false })
    await expect(bad.editor.ready()).rejects.toThrow(/does not verify/)
  })
})

describe('managed co-editing: saves (D3)', () => {
  it('writes one version per save with its authors and trigger, and moves every editor`s version along', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const writes = recording(files)
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { writes })
    const bob = await open(at, { id: 'bob', name: 'Bob' }, scope('res:1', 'editor'), files, { writes })
    await online(ann, 'editor')
    await online(bob, 'editor')
    await vi.waitFor(() => expect(ann.editor.collab.state.save).toBeTruthy(), wait)
    ann.kit.last().edit('Hi')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hi'), wait)
    bob.kit.last().edit(' there')
    await vi.waitFor(() => expect(ann.kit.last().text()).toBe('Hi there'), wait)
    await vi.waitFor(() => expect(at.server.rooms.get(ann.editor.collab.state.docId!)?.save.headSeq).toBe(2), wait)
    const before = writes.writes.length
    await ann.editor.save()
    const saved = writes.writes.slice(before)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.save).toMatchObject({ trigger: 'user', seq: 2, docKey: 'k1', docId: ann.editor.collab.state.docId })
    // The server's signed receipt rides along for the host to verify (I6).
    expect(saved[0]!.save!.receipt).toMatch(/^ksr1\./)
    expect(saved[0]!.save!.authors.map((author) => author.name).sort()).toEqual(['Ann', 'Bob'])
    const annVersion = `v${files.files.get('res:1')!.version}`
    // Bob's kit already holds what Ann saved: it hears so, and shows no "changed on disk".
    await vi.waitFor(() => expect(bob.kit.last().held).toContain(annVersion), wait)
    await vi.waitFor(() => expect(bob.editor.collab.state.save).toMatchObject({ status: 'editing', dirty: false, savedSeq: 2, version: annVersion }), wait)
    // Bob's next save goes over the version Ann's wrote: no conflict.
    bob.kit.last().edit('!')
    await bob.editor.save()
    expect(writes.writes.at(-1)!.expectedVersion).toBe(annVersion)
    expect([...ann.errors, ...bob.errors]).toEqual([])
    expect(files.text('res:1')).toBe('Hi there!')
  })

  it('writes a kit save made before the room is joined through the room once joined, never as a plain write (SV1)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    let connect = () => {}
    const joinGate = new Promise<void>((resolve) => { connect = resolve })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { wait: false, joinGate })
    await vi.waitFor(() => expect(ann.kit.last()).toBeTruthy(), wait)
    // The kit changes and saves its file while the page has not joined the room yet (a kit that
    // rewrites what it opened): a plain write would end the room's generation for everyone.
    ann.kit.last().edit('early')
    await ann.kit.last().save()
    expect(ann.writes).toEqual([])
    connect()
    await online(ann, 'editor')
    await vi.waitFor(() => expect(ann.writes).toHaveLength(1), wait)
    expect(ann.writes[0]!.save).toMatchObject({ docKey: 'k1' })
    expect(ann.writes[0]!.save!.receipt).toMatch(/^ksr1\./)
    expect(files.text('res:1')).toBe('early')
    expect(ann.errors).toEqual([])
  })

  it('runs a Save made as the room is joined after the early save it waited for, never beside it (SV1)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    let connect = () => {}
    const joinGate = new Promise<void>((resolve) => { connect = resolve })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { wait: false, joinGate, writes: recording(files, 20) })
    await vi.waitFor(() => expect(ann.kit.last()).toBeTruthy(), wait)
    ann.kit.last().edit('early')
    await ann.kit.last().save()
    connect()
    await online(ann, 'editor')
    // The person's Save right as the room is joined: it goes after the early save, over the
    // version that one wrote, so neither is refused as a conflict.
    ann.kit.last().edit('later')
    await ann.kit.last().save()
    // The kit's edits append: the file holds both.
    await vi.waitFor(() => expect(files.text('res:1')).toBe('earlylater'), wait)
    expect(ann.overlap.most).toBe(1)
    expect(ann.errors).toEqual([])
  })

  it('refuses a Save after the file changed outside the room (a new generation), never reporting one it did not write (1.3)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const transport = fakeTransport(at.server)
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { transport })
    await online(ann, 'editor')
    ann.kit.last().edit('first')
    await ann.kit.last().save()
    await vi.waitFor(() => expect(files.text('res:1')).toBe('first'), wait)
    // An upload over the file: the host starts the next generation and closes the connection;
    // the page's next token names it.
    files.writeElsewhere('res:1', 'uploaded')
    const next = fakeToken('ann', scope('res:1', 'editor', 'k2'))
    at.server.identifyOpen(next, { id: 't:acme:ann', name: 'Ann', color: '#5645d4' }, scope('res:1', 'editor', 'k2'))
    ann.tokens.mockImplementation(async () => next)
    transport.sockets.at(-1)!.close()
    await vi.waitFor(() => expect(transport.sockets.length).toBeGreaterThan(1), wait)
    ann.kit.last().edit(' stale')
    const writes = ann.writes.length
    await expect(ann.kit.last().save()).rejects.toThrow()
    expect(files.text('res:1')).toBe('uploaded')
    expect(ann.writes.length).toBe(writes)
  })

  it('carries a kept copy into the next generation: "keep my copy" saves the draft there (SV5)', { timeout: 20_000 }, async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const transport = fakeTransport(at.server)
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { transport })
    await online(ann, 'editor')
    ann.kit.last().edit('first')
    await ann.kit.last().save()
    await vi.waitFor(() => expect(files.text('res:1')).toBe('first'), wait)
    files.writeElsewhere('res:1', 'uploaded')
    const next = fakeToken('ann', scope('res:1', 'editor', 'k2'))
    at.server.identifyOpen(next, { id: 't:acme:ann', name: 'Ann', color: '#5645d4' }, scope('res:1', 'editor', 'k2'))
    ann.tokens.mockImplementation(async () => next)
    transport.sockets.at(-1)!.close()
    await vi.waitFor(() => expect(transport.sockets.length).toBeGreaterThan(1), wait)
    const handlers = ann.kit.last().options.handlers
    const stamp = (await files.storage.stamp('res:1'))!
    // Without the person's choice (the kit's base is still the old version): refused, nothing written.
    await expect(handlers.write({ path: 'res:1.note', bytes: new TextEncoder().encode('first draft').buffer as ArrayBuffer, mode: 'save', expected: 'v2' })).rejects.toThrow()
    expect(files.text('res:1')).toBe('uploaded')
    // "Keep my copy": the kit saves over the version it now knows. The draft becomes the file's
    // content in the next generation, and the editor opens it live there.
    const kits = ann.kit.editors.length
    const saved = await handlers.write({ path: 'res:1.note', bytes: new TextEncoder().encode('first draft').buffer as ArrayBuffer, mode: 'save', expected: stamp })
    expect(saved.version).not.toBe(stamp)
    expect(files.text('res:1')).toBe('first draft')
    // The kit keeps its replica after a save; this one is the earlier generation's document, and
    // under the new version's stamp it would open there again: it is not kept.
    await handlers.replicaWrite!({ path: 'res:1.note', snapshot: new ArrayBuffer(1), blobs: new ArrayBuffer(0), fileStamp: saved.version, version: new ArrayBuffer(1) })
    expect((await ann.kept.replicas.read('res:1'))?.fileStamp).not.toBe(saved.version)
    // Saving while the editor moves (closing the tab right after "keep my copy") waits for the
    // new generation and saves there; a save the replaced kit sends meanwhile is refused.
    const closing = ann.editor.save()
    const stale = Promise.resolve(handlers.write({ path: 'res:1.note', bytes: new TextEncoder().encode('first draft').buffer as ArrayBuffer, mode: 'save' })).then(
      () => 'saved',
      (error: unknown) => String(error),
    )
    // The host starts the generation that write made, as it does for any write outside a room.
    const third = fakeToken('ann', scope('res:1', 'editor', 'k3'))
    at.server.identifyOpen(third, { id: 't:acme:ann', name: 'Ann', color: '#5645d4' }, scope('res:1', 'editor', 'k3'))
    ann.tokens.mockImplementation(async () => third)
    transport.sockets.at(-1)!.close()
    await vi.waitFor(() => expect(ann.kit.editors.length).toBeGreaterThan(kits), wait)
    await vi.waitFor(() => expect(ann.editor.collab.state).toMatchObject({ status: 'online', role: 'editor' }), wait)
    expect(ann.editor.collab.state.docId).toBeTruthy()
    expect(await stale).toMatch(/new version/)
    await expect(closing).resolves.toBeDefined()
    expect(files.text('res:1')).toBe('first draft')
    // Live again: the next edit saves through the new generation's room (the fake kit opens its
    // replica, not the file's text, so only where the save went is checked).
    const before = ann.writes.length
    ann.kit.last().edit(' more')
    await ann.kit.last().save()
    await vi.waitFor(() => expect(ann.writes.length).toBeGreaterThan(before), wait)
    expect(ann.writes.at(-1)!.save).toMatchObject({ docKey: 'k3' })
    expect(ann.errors).toEqual([])
  })

  it('saves through the room once it is joined again when the connection dropped just before the Save (SV1)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const transport = fakeTransport(at.server)
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { transport })
    await online(ann, 'editor')
    ann.kit.last().edit('typed')
    // The open token is revoked (the person changed their password): the connection drops, and the
    // Save comes before the client is online and in the room again.
    transport.sockets.at(-1)!.close()
    await vi.waitFor(() => expect(ann.editor.collab.state.status).not.toBe('online'), wait)
    await ann.kit.last().save()
    await vi.waitFor(() => expect(files.text('res:1')).toBe('typed'), wait)
    expect(ann.writes.at(-1)!.save).toMatchObject({ trigger: 'user' })
    expect(ann.errors).toEqual([])
  })

  it('seeds a file`s room without writing the file: opening never makes a version (D1, 1.3)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': 'uploaded' })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { rewrites: true })
    await online(ann, 'editor')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ann.writes).toEqual([])
    expect(await files.storage.stamp('res:1')).toBe('v1')
    expect(ann.errors).toEqual([])
  })

  it('autosaves unsaved changes on its timer (SV2)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { collaboration: { autosaveMs: 40 } })
    await online(ann, 'editor')
    ann.kit.last().edit('typed')
    await vi.waitFor(() => expect(ann.writes.some((write) => write.save?.trigger === 'timer' && write.text === 'typed')).toBe(true), wait)
    await vi.waitFor(() => expect(ann.editor.collab.state.save).toMatchObject({ dirty: false }), wait)
  })

  it('saves first when it joins a room the last editor left unsaved (must-save, SV4)', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const writes = recording(files)
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { writes })
    await online(ann, 'editor')
    const docId = ann.editor.collab.state.docId!
    ann.kit.last().edit('unsaved')
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save.dirty).toBe(true), wait)
    ann.editor.destroy()
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save.status).toBe('must-save'), wait)
    const bob = await open(at, { id: 'bob', name: 'Bob' }, scope('res:1', 'editor'), files, { writes })
    await online(bob, 'editor')
    await vi.waitFor(() => expect(writes.writes.some((write) => write.save?.trigger === 'command' && write.text === 'unsaved')).toBe(true), wait)
    const save = writes.writes.find((write) => write.save?.trigger === 'command')!.save!
    expect(save.authors).toEqual([{ principalId: 't:acme:ann', name: 'Ann' }])
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save.status).toBe('editing'), wait)
  })
})

describe('managed co-editing: a browser with no record of the room (CK1, CK2)', () => {
  /** The note's text in a stored replica. */
  const storedText = (snapshot: ArrayBuffer) => {
    const replica = Replica.load(NOTE_SCHEMA, new Uint8Array(snapshot), 990n)
    return replica.text(replica.objectsOfType('Note')[0], 'body')
  }

  /** Ann seeds the room, writes "Hello" and saves it: the file and its checkpoint hold seq 1. */
  async function saved() {
    const at = sync()
    const files = memoryStorage({ 'res:1': '' })
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files)
    await online(ann, 'editor')
    const docId = ann.editor.collab.state.docId!
    ann.kit.last().edit('Hello')
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save.headSeq).toBe(1), wait)
    await ann.editor.save()
    const version = `v${files.files.get('res:1')!.version}`
    expect(files.text('res:1')).toBe('Hello')
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save).toMatchObject({ savedSeq: 1, version }), wait)
    return { at, files, ann, docId, version }
  }

  it('opens the file`s checkpoint as it is, never the room`s older snapshot, and catches up without the file twice (issue-embed-adopt-checkpoint)', async () => {
    const { at, files, ann, docId, version } = await saved()
    const checkpoint = (await ann.kept.replicas.read('res:1'))!
    expect(checkpoint.fileStamp).toBe(version)
    const kept = new Uint8Array(checkpoint.snapshot).slice()
    // The host's replica store, in a browser with no record of the room (another person, another
    // browser, cleared site data); the kit records the file on top of a replica that lacks it.
    const elsewhere: Browser = { replicas: ann.kept.replicas, state: localState(null), at: browser().at }
    const bob = await open(at, { id: 'bob', name: 'Bob' }, scope('res:1', 'editor'), files, { kept: elsewhere, rebuildsOnOpen: true })
    await online(bob, 'editor')
    expect(bob.editor.collab.state.docId).toBe(docId)
    const stored = (await elsewhere.replicas.read('res:1'))!
    expect(stored.fileStamp).toBe(version)
    expect(new Uint8Array(stored.snapshot)).toEqual(kept)
    expect(bob.kit.editors[0]!.rebuilt).toBe(false)
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello'), wait)
    ann.kit.last().edit('!')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello!'), wait)
    bob.kit.last().edit('?')
    await vi.waitFor(() => expect(ann.kit.last().text()).toBe('Hello!?'), wait)
    expect(bob.kit.last().text()).toBe('Hello!?')
    expect([...ann.errors, ...bob.errors]).toEqual([])
  })

  it('stores the room`s state as the saved file holds it when the browser keeps no replica, and joins from there (issue-embed-adopt-checkpoint)', async () => {
    const { at, files, ann, docId, version } = await saved()
    // Unsaved since: the room is ahead of the file.
    ann.kit.last().edit(' there')
    await vi.waitFor(() => expect(at.server.rooms.get(docId)?.save.headSeq).toBe(2), wait)
    const fresh = browser()
    const bob = await open(at, { id: 'bob', name: 'Bob' }, scope('res:1', 'editor'), files, { kept: fresh, rebuildsOnOpen: true })
    await online(bob, 'editor')
    expect(bob.editor.collab.state.docId).toBe(docId)
    // The room's snapshot (its creation, seq 0) brought up to the save's seq: what the file holds.
    const stored = (await fresh.replicas.read('res:1'))!
    expect(stored.fileStamp).toBe(version)
    expect(storedText(stored.snapshot)).toBe('Hello')
    expect(bob.kit.editors[0]!.rebuilt).toBe(false)
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello there'), wait)
    // The relay joined from the save's seq, and the record holds what it has seen since.
    const joins = at.server.calls.filter((call) => call.method === 'room/join').map((call) => call.params.since)
    expect(joins.at(-1)).toBe(1)
    await vi.waitFor(async () => expect((await new RoomRecords(fresh.state).read(docId))?.seen?.seq).toBe(2), wait)
    ann.kit.last().edit('!')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello there!'), wait)
    bob.kit.last().edit('?')
    await vi.waitFor(() => expect(ann.kit.last().text()).toBe('Hello there!?'), wait)
    expect([...ann.errors, ...bob.errors]).toEqual([])
  })
})

describe('managed co-editing: open tokens never share a sync-token connection (I8)', () => {
  it('opens its own connection even when a sync-token editor of the page already has one, without collaboration.open', async () => {
    const at = sync()
    const files = memoryStorage({ 'res:1': '', plain: '' })
    const kept = browser()
    // A sync-token editor of another file on the same URL.
    at.server.identify('ks1-bo', { id: 'bo', name: 'Bo', color: '#000' })
    const element = document.createElement('div')
    document.body.append(element)
    const plain = await mountEmbed(
      element,
      { kit: KIT, file: { id: 'plain', name: 'plain.note' }, storage: { ...files.storage, replica: kept.replicas, state: kept.state }, identity: { token: async () => 'ks1-bo', user: () => ({ id: 'bo', name: 'Bo' }) }, collaboration: { server: `${at.url}${kept.at}` } },
      { mountKit: fakeKit().mountKit, replicaStore: memoryReplicaStore, createTransport: fakeTransport(at.server).factory },
    )
    editors.push(plain)
    await plain.ready()
    const ann = await open(at, { id: 'ann', name: 'Ann' }, scope('res:1', 'editor'), files, { kept: { replicas: memoryReplicaStore(), state: kept.state, at: kept.at }, collaboration: { open: undefined } })
    await online(ann, 'editor')
    const hellos = at.server.calls.filter((call) => call.method === 'sync/hello').map((call) => String(call.params.token))
    expect(hellos).toEqual(['ks1-bo', fakeToken('ann', scope('res:1', 'editor'))])
    expect(ann.editor.collab.state.role).toBe('editor')
  })
})
