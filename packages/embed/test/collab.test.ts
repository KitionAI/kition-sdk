// @vitest-environment jsdom
/**
 * Editors co-editing through the real `SyncClient` and relay against the sync package's
 * `FakeServer` (over its loop-back transport), each page with its own storage, replica store,
 * room records, and kit (`fakeKit`, a real KDM replica).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newDocId, person, Replica } from '@kition/kdm'
import { FakeServer, fakeTransport } from '../../sync/test/helpers'
import { mountEmbed } from '../src/mount'
import { memoryReplicaStore } from '../src/replicaStore'
import { localState, RoomRecords } from '../src/rooms'
import { EmbedError } from '../src/errors'
import type { CollabState, EmbedEditor, EmbedLeases, IdentityProvider, Presence } from '../src/types'
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

function room() {
  const server = new FakeServer()
  // Each test (and each page) has its own server URL, so pages do not share a client.
  const url = `ws://sync.test/${(servers += 1)}`
  return { server, url }
}

type Kept = { files: ReturnType<typeof memoryStorage>; state: ReturnType<typeof localState>; replicas: ReturnType<typeof memoryReplicaStore> }

/** A page of `person`'s; `kept` is what an earlier page left in the browser and storage (a reload). */
async function page(sync: ReturnType<typeof room>, person: { id: string; name: string }, joining?: string, kept?: Kept, server = `${sync.url}/${person.id}`, users?: IdentityProvider['users']) {
  sync.server.identify(`token-${person.id}`, { id: person.id, name: person.name, color: '#5645d4' })
  const files = kept?.files ?? memoryStorage({ f1: '' })
  const state = kept?.state ?? localState(null)
  const replicas = kept?.replicas ?? memoryReplicaStore()
  const kit = fakeKit()
  const transport = fakeTransport(sync.server)
  const token = vi.fn(async () => `token-${person.id}`)
  const element = document.createElement('div')
  document.body.append(element)
  const editor = await mountEmbed(
    element,
    {
      kit: KIT,
      file: { id: 'f1', name: 'Notes.note' },
      storage: { ...files.storage, replica: replicas, state },
      identity: { token, user: () => person, ...(users ? { users } : {}) },
      collaboration: { server, room: joining },
    },
    { mountKit: kit.mountKit, replicaStore: memoryReplicaStore, createTransport: transport.factory },
  )
  editors.push(editor)
  const collab: CollabState[] = []
  const presence: Presence[][] = []
  const errors: Error[] = []
  editor.on('collab', (next) => collab.push(next))
  editor.on('presence', (peers) => presence.push(peers))
  editor.on('error', (error) => errors.push(error))
  await editor.ready()
  return { editor, files, kit, state, records: new RoomRecords(state), replicas, token, transport, collab, presence, errors }
}

/** Waits until the editor is in its room and the relay has joined it. */
async function joined(side: Awaited<ReturnType<typeof page>>, role = 'editor') {
  await vi.waitFor(() => expect(side.editor.collab.state).toMatchObject({ status: 'online', role }), wait)
  await vi.waitFor(() => expect(side.presence.length).toBeGreaterThan(0), wait)
}

describe('collaboration', () => {
  it('makes the document’s room, and a page opening its link co-edits it both ways', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    expect(sync.server.rooms.get(docId!)?.kit).toBe('kit.note')
    // Saved before the room was made, so the stored replica carries the room's id.
    expect(await alice.replicas.read('f1')).not.toBeNull()
    expect(await alice.records.read(docId!)).toMatchObject({ role: 'owner', fileId: 'f1', kit: 'kit.note' })
    alice.kit.last().edit('Hello')

    const link = await alice.editor.collab.shareLink('editor')
    expect(link).toBe(sync.server.rooms.get(docId!)?.shareLink)
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, link)
    await joined(bob)
    // Bob's kit opened the room's document (its snapshot as the stored replica), then caught up
    // from the seq the snapshot was taken at: the room's creation, before Alice's edit.
    expect(bob.editor.collab.state.docId).toBe(docId)
    expect(sync.server.calls.filter((call) => call.method === 'room/join').at(-1)?.params.since).toBe(0)
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Hello'), wait)
    bob.kit.last().edit(', Bob')
    await vi.waitFor(() => expect(alice.kit.last().text()).toBe('Hello, Bob'), wait)
    await vi.waitFor(() => expect(alice.presence.at(-1)?.map((peer) => peer.name).sort()).toEqual(['Alice', 'Bob']), wait)
    expect(alice.presence.at(-1)?.find((peer) => peer.name === 'Bob')?.state).toEqual({ kit: 'kit.note', user: { id: 'bob', name: 'Bob' } })
    await vi.waitFor(async () => expect((await bob.records.read(docId!))?.seen?.seq).toBeGreaterThan(0), wait)
    expect(alice.errors).toEqual([])
    expect(bob.errors).toEqual([])
  })

  it('co-edits an integrator\'s room, which has no share links (KitCollab 1.3)', async () => {
    const sync = room()
    sync.server.tenantRooms = true
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    const record = await alice.records.read(docId!)
    expect(record).not.toHaveProperty('shareLink')
    await expect(alice.editor.collab.shareLink('editor')).rejects.toMatchObject({ code: 'read-only' })
    await expect(alice.editor.collab.shareLink('editor')).rejects.toBeInstanceOf(EmbedError)
    expect(alice.errors).toEqual([])
  })

  it('serves the kit leases on the room\'s scopes and tells each kit who holds what', async () => {
    const sync = room()
    sync.server.leasesEnabled = true
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob)
    const aliceLeases = alice.kit.last().options.handlers.leases!
    const bobLeases = bob.kit.last().options.handlers.leases!
    expect(await aliceLeases.acquire({ scope: 'layer-1' })).toEqual({ lease: { scope: 'layer-1', holder: { principalId: 'alice', name: 'Alice', self: true } } })
    await vi.waitFor(() => expect(bob.kit.last().leaseLists.at(-1)).toEqual([{ scope: 'layer-1', holder: { principalId: 'alice', name: 'Alice', self: false } }]), wait)
    expect(await bobLeases.list()).toEqual([{ scope: 'layer-1', holder: { principalId: 'alice', name: 'Alice', self: false } }])
    await expect(Promise.resolve().then(() => bobLeases.acquire({ scope: 'layer-1' }))).rejects.toMatchObject({ data: { reason: 'held', lease: { holder: { name: 'Alice', self: false } } } })
    await aliceLeases.release({ scope: 'layer-1' })
    await vi.waitFor(() => expect(bob.kit.last().leaseLists.at(-1)).toEqual([]), wait)
    expect(await bobLeases.acquire({ scope: 'layer-1' })).toMatchObject({ lease: { holder: { name: 'Bob', self: true } } })
    // Closing an editor releases what its kit still holds.
    bob.editor.destroy()
    await vi.waitFor(() => expect(alice.kit.last().leaseLists.at(-1)).toEqual([]), wait)
  })

  it('reports the kit\'s conflict objects to the page', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    const heard: unknown[] = []
    alice.editor.on('mergeConflicts', (conflicts) => heard.push(conflicts))
    alice.kit.last().options.handlers.conflicts?.({ conflicts: [{ id: 'c1', kind: 'pdf.droppedEdit', summary: 'An edit was dropped' }] })
    expect(heard).toEqual([[{ id: 'c1', kind: 'pdf.droppedEdit', summary: 'An edit was dropped' }]])
  })

  it('keeps an unedited document’s room snapshot as its replica, so a reload opens the same room', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    // Nothing was edited: the kit's save wrote nothing, and the file is as it was.
    expect(alice.files.text('f1')).toBe('')
    expect(await alice.files.storage.stamp('f1')).toBe('v1')
    const stored = await alice.replicas.read('f1')
    expect(stored?.fileStamp).toBe('v1')
    expect(new Uint8Array(stored!.snapshot)).toEqual(sync.server.rooms.get(docId!)?.snapshot)
    alice.editor.destroy()

    const again = await page(sync, { id: 'alice', name: 'Alice' }, undefined, alice)
    await joined(again, 'owner')
    expect(again.editor.collab.state.docId).toBe(docId)
    expect(sync.server.rooms.size).toBe(1)
    expect(sync.server.calls.filter((call) => call.method === 'room/create')).toHaveLength(1)
    expect(again.errors).toEqual([])
  })

  it('refuses a second editor of a document on the page, and shares the page’s connection between documents', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    const server = `${sync.url}/alice`

    // The same file again (its stored replica names the same document), and the room by its id.
    const again = page(sync, { id: 'alice', name: 'Alice' }, undefined, alice, server)
    const refusal = await again.catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(EmbedError)
    expect(refusal).toMatchObject({ code: 'document-open' })
    expect((refusal as Error).message).toContain(docId!)
    await expect(page(sync, { id: 'alice', name: 'Alice' }, docId!, undefined, server)).rejects.toMatchObject({ code: 'document-open' })
    // Only Alice's first frame is left.
    expect(document.querySelectorAll('iframe')).toHaveLength(1)

    // Another document on the same server, with a sync token, rides the first editor's connection:
    // only sync-token editors share one. It asks for its token first (to tell an open token, which
    // never shares, from a sync token), and connects with nothing of its own.
    const other = await page(sync, { id: 'alice', name: 'Alice' }, undefined, undefined, server)
    await joined(other, 'owner')
    expect(other.editor.collab.state.docId).not.toBe(docId)
    expect(other.transport.sockets).toHaveLength(0)
    expect(other.token).toHaveBeenCalledTimes(1)
    expect(sync.server.calls.filter((call) => call.method === 'sync/hello')).toHaveLength(1)

    // Once the first editor closes, its document can open in another.
    alice.editor.destroy()
    const reopened = await page(sync, { id: 'alice', name: 'Alice' }, undefined, alice, server)
    await joined(reopened, 'owner')
    expect(reopened.editor.collab.state.docId).toBe(docId)
  })

  it('opens a view-only link read-only, and reopens read-only when the room makes an editor a viewer', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    alice.kit.last().edit('Draft')
    const { docId } = alice.editor.collab.state

    const viewer = await page(sync, { id: 'carol', name: 'Carol' }, await alice.editor.collab.shareLink('viewer'))
    expect(viewer.kit.editors).toHaveLength(1)
    expect(viewer.kit.last().options.document.readOnly).toBe(true)
    await joined(viewer, 'viewer')
    await vi.waitFor(() => expect(viewer.kit.last().text()).toBe('Draft'), wait)

    // Dave joins by the document id, as an editor would; the room says viewer.
    sync.server.setRole(docId!, 'dave', 'viewer')
    const dave = await page(sync, { id: 'dave', name: 'Dave' }, docId!.toUpperCase())
    await vi.waitFor(() => expect(dave.kit.editors).toHaveLength(2), wait)
    const [first, second] = dave.kit.editors
    expect(first.options.document.readOnly).toBeUndefined()
    expect(first.closed).toBe(true)
    expect(second.options.document.readOnly).toBe(true)
    // The first kit's replica came along before the second relayed anything.
    expect(second.imports.length).toBeGreaterThan(0)
    await joined(dave, 'viewer')
    await vi.waitFor(() => expect(second.text()).toBe('Draft'), wait)
    expect(await dave.records.read(docId!)).toMatchObject({ role: 'viewer' })
  })

  it('takes a role that changed while it was offline: made a viewer, it reopens the kit read-only after reconnecting', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob, 'editor')
    expect(bob.kit.last().options.document.readOnly).toBeUndefined()
    // Bob's connection drops (a revoked token); while it is down the room makes him a viewer, so
    // only the re-join can tell him.
    const sockets = bob.transport.sockets.length
    bob.transport.sockets.at(-1)!.close()
    sync.server.setRole(docId!, 'bob', 'viewer')
    await vi.waitFor(() => expect(bob.transport.sockets.length).toBeGreaterThan(sockets), wait)
    await vi.waitFor(() => expect(bob.editor.collab.state.role).toBe('viewer'), wait)
    await vi.waitFor(() => expect(bob.kit.last().options.document.readOnly).toBe(true), wait)
    expect(await bob.records.read(docId!)).toMatchObject({ role: 'viewer' })
  })

  it('opens the kit again from the replica it replaces when the stored one is gone, importing nothing into another', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    alice.kit.last().edit('Draft')
    const { docId } = alice.editor.collab.state

    // Dave's stored replica is gone by the time the room makes him a viewer (the joining and
    // the first kit read it; another tab cleared the store), so the kit opened again reads none.
    sync.server.setRole(docId!, 'dave', 'viewer')
    const store = memoryReplicaStore()
    let reads = 0
    const replicas = { read: async (fileId: string) => ((reads += 1) > 2 ? null : store.read(fileId)), write: store.write }
    const dave = await page(sync, { id: 'dave', name: 'Dave' }, docId!, { files: memoryStorage({ f1: '' }), state: localState(null), replicas })
    await vi.waitFor(() => expect(dave.kit.editors).toHaveLength(3), wait)
    const [first, second, third] = dave.kit.editors
    expect(first.closed).toBe(true)
    // The second kit made a new replica from the file: closed without the first's changes.
    expect(second.options.document.readOnly).toBe(true)
    expect(second.imports).toHaveLength(0)
    expect(second.closed).toBe(true)
    // The third opened from the first's replica alone, as the same document.
    expect(third.options.document.readOnly).toBe(true)
    expect(third.options.document.bytes?.byteLength).toBe(0)
    await joined(dave, 'viewer')
    expect(dave.editor.collab.state.docId).toBe(docId)
    await vi.waitFor(() => expect(third.text()).toBe('Draft'), wait)
    expect(dave.errors).toEqual([])
  })

  it('keeps edits made offline, converges once back, and asks for a fresh token to reconnect', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob)
    expect(bob.token).toHaveBeenCalledTimes(1)

    bob.transport.sockets[0].close()
    await vi.waitFor(() => expect(bob.editor.collab.state.status).toBe('offline'), wait)
    bob.kit.last().edit('offline ')
    alice.kit.last().edit('online')
    await vi.waitFor(() => expect(bob.editor.collab.state.status).toBe('online'), wait)
    expect(bob.token).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(alice.kit.last().text()).toBe(bob.kit.last().text()), wait)
    expect(alice.kit.last().text()).toContain('offline ')
    expect(alice.kit.last().text()).toContain('online')
    expect(bob.collab.map((state) => state.status)).toContain('offline')
  })

  it('tells the page who took and gave up the room’s leases', async () => {
    const sync = room()
    sync.server.leasesEnabled = true
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob)
    const heard: EmbedLeases[] = []
    bob.editor.on('leases', (leases) => heard.push(leases))
    const held = { scope: 'layer-1', holder: { principalId: 'alice', name: 'Alice', self: false } }
    await alice.kit.last().options.handlers.leases!.acquire({ scope: 'layer-1' })
    await vi.waitFor(() => expect(heard.at(-1)).toEqual({ leases: [held], held: [held], released: [] }), wait)
    await alice.kit.last().options.handlers.leases!.release({ scope: 'layer-1' })
    await vi.waitFor(() => expect(heard.at(-1)).toEqual({ leases: [], held: [], released: [held] }), wait)
  })

  it('names the room’s people as the page knows them (identity.users)', async () => {
    const sync = room()
    const users = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, name: `${id} (directory)`, avatar: `https://example.com/${id}.png` })))
    const alice = await page(sync, { id: 'alice', name: 'Alice' }, undefined, undefined, undefined, users)
    await joined(alice, 'owner')
    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob)
    await vi.waitFor(() => expect(alice.presence.at(-1)?.map((peer) => peer.name).sort()).toEqual(['alice (directory)', 'bob (directory)']), wait)
    expect(alice.presence.at(-1)?.find((peer) => peer.principalId === 'bob')).toMatchObject({ user: { id: 'bob', avatar: 'https://example.com/bob.png' } })
    // Bob's page names no one: the server's names, and the user each presence carries.
    await vi.waitFor(() => expect(bob.presence.at(-1)?.map((peer) => peer.name).sort()).toEqual(['Alice', 'Bob']), wait)
    expect(bob.presence.at(-1)?.find((peer) => peer.principalId === 'alice')).toMatchObject({ user: { id: 'alice', name: 'Alice' } })
  })

  it('shows the agent working for the person while an agent port is open (KitAgent A20)', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    const stateOf = () => sync.server.rooms.get(docId!)?.members.get('alice')?.state as { agent?: unknown } | null | undefined
    expect(stateOf()?.agent).toBeUndefined()
    const port = alice.editor.agentPort({ label: 'Writer' })
    await vi.waitFor(() => expect(stateOf()?.agent).toEqual({ name: 'Writer', origin: 'agent' }), wait)
    port.close()
    await vi.waitFor(() => expect(stateOf()?.agent).toBeUndefined(), wait)
  })

  it('reopens for comments only when the room makes an editor a commenter, and the comments reach the room', async () => {
    const sync = room()
    const alice = await page(sync, { id: 'alice', name: 'Alice' })
    await joined(alice, 'owner')
    alice.kit.last().edit('Draft')
    const { docId } = alice.editor.collab.state
    sync.server.setRole(docId!, 'erin', 'commenter')
    const erin = await page(sync, { id: 'erin', name: 'Erin' }, docId!)
    await vi.waitFor(() => expect(erin.kit.editors).toHaveLength(2), wait)
    const second = erin.kit.last()
    expect(second.options.document.readOnly).toBe(true)
    expect(second.options.document.comments).toEqual({ me: 'erin', name: 'Erin', canComment: true, othersReadOnly: false })
    expect(erin.editor.mode).toBe('comment')
    await joined(erin, 'commenter')
    await vi.waitFor(() => expect(second.text()).toBe('Draft'), wait)
    second.comment('Nice draft')
    const threads: string[][] = []
    alice.editor.on('comments', (list) => threads.push(list.flatMap((thread) => thread.comments.map((comment) => `${comment.author}: ${comment.body}`))))
    await vi.waitFor(() => expect(threads.at(-1)).toEqual(['erin: Nice draft']), wait)
  })

  it('reports a kit that keeps no replica', async () => {
    const sync = room()
    sync.server.identify('token-erin', { id: 'erin', name: 'Erin', color: '#000' })
    const kit = fakeKit('kit.note', ['ai'])
    const editor = await mountEmbed(
      document.body.appendChild(document.createElement('div')),
      { kit: KIT, file: { id: 'f1', name: 'Notes.note' }, storage: { ...memoryStorage({ f1: '' }).storage, state: localState(null) }, identity: { token: () => 'token-erin', user: () => ({ id: 'erin', name: 'Erin' }) }, collaboration: { server: `${sync.url}/erin` } },
      { mountKit: kit.mountKit, replicaStore: memoryReplicaStore, createTransport: fakeTransport(sync.server).factory },
    )
    editors.push(editor)
    const errors: Error[] = []
    editor.on('error', (error) => errors.push(error))
    await editor.ready()
    await vi.waitFor(() => expect(errors[0]?.message).toMatch(/cannot be co-edited/), wait)
  })

  it('makes the room when the page saves while the room is being made, without a conflict', async () => {
    const sync = room()
    sync.server.identify('token-alice', { id: 'alice', name: 'Alice', color: '#5645d4' })
    const files = memoryStorage({ f1: '' })
    // The storage answers each write 30 ms after it landed, as a server whose response is on its
    // way; a write sent in that time over the version the editor last saw would be stale.
    const writes: Array<string | null> = []
    const storage = {
      ...files.storage,
      write: async (fileId: string, bytes: Uint8Array, options: { expectedVersion: string | null }) => {
        writes.push(options.expectedVersion)
        const written = await files.storage.write(fileId, bytes, options)
        await new Promise((resolve) => setTimeout(resolve, 30))
        return written
      },
    }
    // A kit that writes its document on every save, as the kits do, even with nothing new.
    const kit = fakeKit()
    const mountKit: typeof kit.mountKit = async (frame, options) => {
      const connection = await kit.mountKit(frame, options)
      const save = connection.save
      connection.save = () => {
        kit.last().dirty = true
        return save()
      }
      return connection
    }
    const element = document.createElement('div')
    document.body.append(element)
    const editor = await mountEmbed(
      element,
      {
        kit: KIT,
        file: { id: 'f1', name: 'Notes.note' },
        storage: { ...storage, replica: memoryReplicaStore(), state: localState(null) },
        identity: { token: async () => 'token-alice', user: () => ({ id: 'alice', name: 'Alice' }) },
        collaboration: { server: `${sync.url}/alice` },
      },
      { mountKit, replicaStore: memoryReplicaStore, createTransport: fakeTransport(sync.server).factory },
    )
    editors.push(editor)
    const errors: Error[] = []
    const conflicts: Error[] = []
    editor.on('error', (error) => errors.push(error))
    editor.on('conflict', (error) => conflicts.push(error))
    await editor.ready()
    // The page's first save, while the editor makes the document's room (which saves too).
    await expect(editor.save()).resolves.toMatchObject({ saved: true })
    await vi.waitFor(() => expect(editor.collab.state).toMatchObject({ status: 'online', role: 'owner' }), wait)
    expect(sync.server.rooms.get(editor.collab.state.docId!)?.kit).toBe('kit.note')
    expect(conflicts).toEqual([])
    expect(errors).toEqual([])
    // Every write went over the version the one before it wrote.
    expect(writes).toEqual(writes.map((_, index) => `v${index + 1}`))
  })
})

describe('collaboration on a copy made as a new document', () => {
  /** A note with text and history, as a template or a file copied from. */
  function sourceNote(text: string) {
    const { replica } = Replica.createWith(NOTE_SCHEMA, newDocId(), 900n, person('user:kit'), (tx) => tx.create('Note', {}))
    const note = replica.objectsOfType('Note')[0]
    replica.transact(person('user:kit'), (tx) => tx.textInsert(note, 'body', 0, `${text} DROPPED`))
    replica.transact(person('user:kit'), (tx) => tx.textDelete(note, 'body', text.length, ' DROPPED'.length))
    return replica
  }

  /** What a host keeps for a file whose replica is `snapshot` (as `document.fork` writes it). */
  async function keptWith(snapshot: Uint8Array): Promise<Kept> {
    const kept = { files: memoryStorage({ f1: '' }), state: localState(null), replicas: memoryReplicaStore() }
    await kept.replicas.write('f1', { snapshot: snapshot.slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0), fileStamp: 'v1' })
    return kept
  }

  it('makes the copy its own room, which a joiner catches up on, both edit, reconnect, reload and converge', async () => {
    const sync = room()
    const source = sourceNote('Template')
    const fork = source.copyAsNewDocument(newDocId(), 901n)
    const kept = await keptWith(fork.snapshot())
    const alice = await page(sync, { id: 'alice', name: 'Alice' }, undefined, kept)
    await joined(alice, 'owner')
    const { docId } = alice.editor.collab.state
    expect(docId).toBe(fork.docId)
    const made = sync.server.rooms.get(docId!)!
    // The room's first state is the copy, rooted at its birth: shallow, with its whole history.
    expect(Replica.load(NOTE_SCHEMA, made.snapshot, 902n).isShallow()).toBe(true)
    expect(Replica.snapshotCarriesWholeHistory(made.snapshot)).toBe(true)
    expect(alice.kit.last().text()).toBe('Template')
    alice.kit.last().edit(' by Alice')

    const bob = await page(sync, { id: 'bob', name: 'Bob' }, await alice.editor.collab.shareLink('editor'))
    await joined(bob)
    expect(bob.editor.collab.state.docId).toBe(docId)
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe('Template by Alice'), wait)
    bob.kit.last().edit(', Bob')
    await vi.waitFor(() => expect(alice.kit.last().text()).toBe('Template by Alice, Bob'), wait)

    // Offline edits on both sides converge after Bob reconnects.
    bob.transport.sockets[0].close()
    await vi.waitFor(() => expect(bob.editor.collab.state.status).toBe('offline'), wait)
    bob.kit.last().edit(' offline')
    alice.kit.last().edit(' online')
    await vi.waitFor(() => expect(bob.editor.collab.state.status).toBe('online'), wait)
    await vi.waitFor(() => expect(alice.kit.last().text()).toBe(bob.kit.last().text()), wait)
    expect(alice.kit.last().text()).toContain(' offline')
    expect(alice.kit.last().text()).toContain(' online')

    // Saved, Alice's stored replica is the copy still rooted at its birth; a reload opens the
    // same room from it and goes on.
    await expect(alice.editor.save()).resolves.toMatchObject({ saved: true })
    const stored = await alice.replicas.read('f1')
    expect(Replica.snapshotCarriesWholeHistory(new Uint8Array(stored!.snapshot))).toBe(true)
    alice.editor.destroy()
    const again = await page(sync, { id: 'alice', name: 'Alice' }, undefined, alice)
    await joined(again, 'owner')
    expect(again.editor.collab.state.docId).toBe(docId)
    again.kit.last().edit('!')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe(again.kit.last().text()), wait)
    expect(sync.server.rooms.size).toBe(1)
    expect(sync.server.calls.filter((call) => call.method === 'room/create')).toHaveLength(1)

    // Reopened where its room record is gone (another browser, cleared site data) but its replica
    // is kept: the room exists, so it joins it knowing nothing it sent, and its edits still reach
    // the room as changes.
    again.editor.destroy()
    const elsewhere = await page(sync, { id: 'alice', name: 'Alice' }, undefined, { files: alice.files, state: localState(null), replicas: alice.replicas })
    await joined(elsewhere, 'owner')
    expect(elsewhere.editor.collab.state.docId).toBe(docId)
    await vi.waitFor(() => expect(elsewhere.kit.last().text()).toBe(bob.kit.last().text()), wait)
    elsewhere.kit.last().edit('?')
    await vi.waitFor(() => expect(bob.kit.last().text()).toBe(elsewhere.kit.last().text()), wait)
    for (const side of [alice, bob, again, elsewhere]) expect(side.errors).toEqual([])
  })

  it('tells the page a replica truncated after its birth makes no room, before asking the server', async () => {
    const sync = room()
    const source = sourceNote('Truncated')
    const kept = await keptWith(source.shallowSnapshot(source.version()))
    const alice = await page(sync, { id: 'alice', name: 'Alice' }, undefined, kept)
    await vi.waitFor(() => expect(alice.errors[0]?.message).toMatch(/does not carry the document's whole history/), wait)
    expect(sync.server.calls.filter((call) => call.method === 'room/create')).toHaveLength(0)
    expect(sync.server.rooms.size).toBe(0)
  })
})
