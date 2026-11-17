/**
 * Protocol 1.10 against `FakeServer`: open-token connections reach exactly one file
 * generation's room (managed-collab.md RM1 to RM6), and one editor at a time holds the seed claim.
 */
import { describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import { SyncRpcError, type OpenScope } from '../src/protocol'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const ann: Identity = { id: 't:acme:ann', name: 'Ann', color: '#f00' }
const bob: Identity = { id: 't:acme:bob', name: 'Bob', color: '#00f' }
const perms = (edit: boolean) => ({ edit, comment: edit, download: true, share: false, export: true })
const scope = (file: string, role: OpenScope['role'], docKey = 'k1'): OpenScope => ({ tenant: 'acme', iss: 'one.test', file, docKey, role, perms: perms(role === 'editor') })

async function open(server: FakeServer, token: string, identity: Identity, scoped: OpenScope) {
  server.identifyOpen(token, identity, scoped)
  const client = new SyncClient({ createTransport: fakeTransport(server).factory })
  await client.connect('ws://test', token)
  return client
}

async function refused(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    if (error instanceof SyncRpcError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('open-token rooms (protocol 1.10, D1)', () => {
  it('names the connection`s scope from the handshake', async () => {
    const server = new FakeServer()
    const client = await open(server, 'a', ann, scope('res:A', 'editor'))
    expect(client.open).toEqual(scope('res:A', 'editor'))
    expect(client.capabilities).toContain('open-rooms')
    expect(client.supports('KitCollab 1.4')).toBe(true)
  })

  it('gives the seed claim to one editor, never a viewer, and tells everyone when the room appears', async () => {
    const server = new FakeServer()
    const first = await open(server, 'a', ann, scope('res:A', 'editor'))
    const second = await open(server, 'b', bob, scope('res:A', 'editor'))
    const viewer = await open(server, 'v', { id: 't:acme:cy', name: 'Cy', color: '#0f0' }, scope('res:A', 'viewer'))
    expect(await first.resolveRoom(true)).toMatchObject({ docId: null, claimed: true })
    expect(await second.resolveRoom(true)).toMatchObject({ docId: null, claimed: false })
    expect(await viewer.resolveRoom(true)).toMatchObject({ docId: null, claimed: false })
    // The holder renews it.
    expect(await first.resolveRoom(true)).toMatchObject({ docId: null, claimed: true })

    const heard: string[] = []
    second.onRoomResolved((docId) => heard.push(docId))
    await first.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    await vi.waitFor(() => expect(heard).toEqual(['doc-a']))
    expect(await second.resolveRoom(true)).toMatchObject({ docId: 'doc-a', claimed: false })
    expect(await viewer.resolveRoom()).toMatchObject({ docId: 'doc-a', claimed: false })
    expect((await viewer.resolveRoom()).save).toMatchObject({ status: 'editing', dirty: false })
  })

  it('refuses a second room for the generation, naming the first (RM6)', async () => {
    const server = new FakeServer()
    const first = await open(server, 'a', ann, scope('res:A', 'editor'))
    const second = await open(server, 'b', bob, scope('res:A', 'editor'))
    await first.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    const error = await refused(second.createRoom('doc-other', new Uint8Array([2]), 'A.docx', 'kit.doc'))
    expect(error.reason).toBe('conflict')
    expect(error.boundDocId).toBe('doc-a')
  })

  it('keeps each token to its own file`s room, at its own role (RM2, RM3, MC-02)', async () => {
    const server = new FakeServer()
    const editorA = await open(server, 'ann-a', ann, scope('res:A', 'editor'))
    const editorB = await open(server, 'bob-b', bob, scope('res:B', 'editor'))
    await editorA.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    await editorB.createRoom('doc-b', new Uint8Array([2]), 'B.docx', 'kit.doc')
    // Ann views B in the same page: another connection, another token.
    const viewerB = await open(server, 'ann-b', ann, scope('res:B', 'viewer'))
    expect((await refused(editorA.join('doc-b'))).reason).toBe('not-found')
    expect((await refused(viewerB.snapshot('doc-a'))).reason).toBe('not-found')
    expect((await viewerB.join('doc-b')).role).toBe('viewer')
    expect((await refused(viewerB.push('doc-b', new Uint8Array([9])))).reason).toBe('forbidden')
    expect((await editorA.join('doc-a')).role).toBe('editor')
    expect(await editorA.push('doc-a', new Uint8Array([3]))).toEqual({ seq: 1 })
    // A UUID bound to another file cannot be taken for this one.
    expect((await refused(viewerB.createRoom('doc-a', new Uint8Array([1]), 'x', 'kit.doc'))).reason).toBe('forbidden')
    expect((await refused(editorB.createRoom('doc-c', new Uint8Array([1]), 'x', 'kit.doc'))).boundDocId).toBe('doc-b')
    // A new generation of A is a new room: the old room stays out of reach.
    const nextA = await open(server, 'ann-a2', ann, scope('res:A', 'editor', 'k2'))
    expect(await nextA.resolveRoom()).toMatchObject({ docId: null, claimed: false })
    expect((await refused(nextA.join('doc-a'))).reason).toBe('not-found')
  })

  it('lets only the claim holder upload blobs before the room exists (RM7, MC-29)', async () => {
    const server = new FakeServer()
    const holder = await open(server, 'a', ann, scope('res:A', 'editor'))
    const other = await open(server, 'b', bob, scope('res:A', 'editor'))
    await holder.resolveRoom(true)
    await other.resolveRoom(true)
    expect(await holder.blobs.put('doc-a', new Uint8Array([7, 7]), 'image/png')).toHaveProperty('hash')
    expect((await refused(other.blobs.put('doc-a', new Uint8Array([8]), 'image/png'))).reason).toBe('not-found')
    expect((await refused(other.blobs.has('doc-a', ['x']))).reason).toBe('not-found')
  })

  it('forbids share links and member administration (as CS6)', async () => {
    const server = new FakeServer()
    const client = await open(server, 'a', ann, scope('res:A', 'editor'))
    await client.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    expect((await refused(client.createLink('doc-a', 'viewer'))).reason).toBe('forbidden')
    expect((await refused(client.openRoom('https://fake.test/s/doc-a'))).reason).toBe('forbidden')
    expect((await refused(client.members('doc-a'))).reason).toBe('forbidden')
  })

  it('keeps bound rooms from sync-token connections, even of the same principal, and their roles from becoming memberships', async () => {
    const server = new FakeServer()
    const editor = await open(server, 'a', ann, scope('res:A', 'editor'))
    await editor.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    await editor.join('doc-a')
    server.identify('ks1-ann', ann)
    const plain = new SyncClient({ createTransport: fakeTransport(server).factory })
    await plain.connect('ws://test', 'ks1-ann')
    expect((await refused(plain.join('doc-a'))).reason).toBe('not-found')
    expect((await refused(plain.snapshot('doc-a'))).reason).toBe('not-found')
    expect((await refused(plain.push('doc-a', new Uint8Array([2])))).reason).toBe('not-found')
    expect((await plain.listRooms()).rooms).toEqual([])
  })

  it('makes the room only for the claim holder, and pushes and saves with the connection`s own role (I5)', async () => {
    const server = new FakeServer()
    const holder = await open(server, 'a', ann, scope('res:A', 'editor'))
    const other = await open(server, 'b', bob, scope('res:A', 'editor'))
    await holder.resolveRoom(true)
    expect((await refused(other.createRoom('doc-x', new Uint8Array([1]), 'A.docx', 'kit.doc'))).reason).toBe('conflict')
    await holder.createRoom('doc-a', new Uint8Array([1]), 'A.docx', 'kit.doc')
    // Bob's viewer token in another tab: same principal as his editor, its own role.
    const viewer = await open(server, 'b-view', bob, scope('res:A', 'viewer'))
    await other.join('doc-a')
    await viewer.join('doc-a')
    expect((await refused(viewer.push('doc-a', new Uint8Array([2])))).reason).toBe('forbidden')
    expect((await refused(viewer.saveBegin('doc-a', 'user'))).reason).toBe('forbidden')
    await other.push('doc-a', new Uint8Array([3]))
    const begun = await other.saveBegin('doc-a', 'user')
    expect(begun.save.by).toMatch(/^conn-/)
    expect(begun.authors).toEqual([{ principalId: 't:acme:bob', name: 'Bob' }])
    expect(begun.receipt).toMatch(/^ksr1\./)
  })

  it('keeps pre-room blobs with their file generation (RM7)', async () => {
    const server = new FakeServer()
    const a = await open(server, 'a', ann, scope('res:A', 'editor'))
    const b = await open(server, 'b', bob, scope('res:B', 'editor'))
    await a.resolveRoom(true)
    await b.resolveRoom(true)
    const { hash } = await a.blobs.put('doc-shared', new Uint8Array([5, 5]), 'image/png')
    // B's claim holder probes the same document id: A's upload is not B's.
    expect((await b.blobs.has('doc-shared', [hash])).missing).toEqual([hash])
    await a.createRoom('doc-shared', new Uint8Array([1]), 'A.docx', 'kit.doc')
    expect((await a.blobs.has('doc-shared', [hash])).missing).toEqual([])
  })
})
