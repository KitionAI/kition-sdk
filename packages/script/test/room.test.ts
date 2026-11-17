/**
 * `openRoom` against `FakeServer` (`packages/sync/test/helpers.ts`): a script's room handle keeps
 * a KDM replica of a server room, runs batches on it, and pushes their changes; another member's
 * handle hears them as `changed`. Roles, commands through `agent/run`, and leaving the room.
 */
import { BatchError, person, Replica, Version } from '@kition/kdm'
import { SyncClient } from '@kition/sync'
import { describe, expect, it } from 'vitest'
import { FakeServer, fakeTransport } from '../../sync/test/helpers'
import './roomKit'
import { createRoom, openRoom, syncEndpoint, type RoomOptions } from '../src/room'
import { makeCollection, titles } from './roomCollection'

const SERVER = 'ws://fake.test/v1/sync'

/** A fake server with Alice's room holding a entry file of `entryTitles`. */
async function setup(entryTitles = ['Q2 plan', 'Hiring']) {
  const server = new FakeServer()
  server.identify('dev-alice', { id: 'u:alice', name: 'Alice', color: '#5645d4' })
  server.identify('dev-bob', { id: 'u:bob', name: 'Bob', color: '#0a7' })
  server.identify('dev-carol', { id: 'u:carol', name: 'Carol', color: '#c40' })
  const collection = makeCollection(entryTitles)
  const { docId, shareLink } = await createRoom({ server: SERVER, token: 'dev-alice', kit: 'kit.mockroom', name: 'Plan', document: collection.snapshot(), createTransport: fakeTransport(server).factory })
  expect(docId).toBe(collection.docId)
  expect(server.rooms.get(docId)?.owner).toBe('u:alice')
  const open = (token: string, more: Partial<RoomOptions> = {}) =>
    openRoom({ server: SERVER, token, docId: collection.docId, kit: 'kit.mockroom', createTransport: fakeTransport(server).factory, ...more })
  return { server, collection, shareLink, open }
}

/** Settles once `check` holds (the fake server answers on microtasks). */
async function until(check: () => boolean) {
  for (let turn = 0; turn < 200 && !check(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(check()).toBe(true)
}

describe('openRoom', () => {
  it("runs a script's batches on the room, and another member hears them", async () => {
    const { server, collection, open } = await setup()
    const script = await open('dev-alice')
    const watcher = await open('dev-bob')
    expect(script.role).toBe('owner')
    expect(watcher.role).toBe('editor')
    expect(await titles(watcher)).toEqual(['Q2 plan', 'Hiring'])

    const heard: string[] = []
    const local: string[] = []
    watcher.on('changed', (event) => heard.push(event.origin))
    script.on('changed', (event) => local.push(event.origin))
    expect(await titles(script, (title, index) => `${index + 1}. ${title.toUpperCase()}`)).toEqual(['1. Q2 PLAN', '2. HIRING'])
    expect(local).toContain('local')
    expect(local).not.toContain('kit')

    // One change per run of model operations, pushed by Alice, relayed to Bob.
    const room = server.rooms.get(collection.docId)!
    expect(room.changes.map((change) => change.from)).toEqual(['u:alice'])
    await until(() => heard.length > 0)
    expect(heard.every((origin) => origin === 'kit')).toBe(true)
    expect(await titles(watcher)).toEqual(['1. Q2 PLAN', '2. HIRING'])

    // Someone who opens the room later catches up from its snapshot and changes.
    const late = await open('dev-carol')
    expect(await titles(late)).toEqual(['1. Q2 PLAN', '2. HIRING'])
    for (const doc of [script, watcher, late]) doc.close()
  })

  it('opens a room by its share link, which names the kit', async () => {
    const { shareLink, server } = await setup(['Only'])
    const doc = await openRoom({ server: SERVER, token: 'dev-bob', shareLink, createTransport: fakeTransport(server).factory })
    expect(doc.kitId).toBe('kit.mockroom')
    expect(await titles(doc)).toEqual(['Only'])
    doc.close()
    await expect(openRoom({ server: SERVER, tokenProvider: () => 'dev-bob', shareLink, kit: 'kit.doc', createTransport: fakeTransport(server).factory })).rejects.toThrow(/kit\.mockroom room, not kit\.doc/)
    await expect(openRoom({ server: SERVER, token: 'dev-bob', docId: 'x' } as RoomOptions)).rejects.toThrow(/kit too/)
    await expect(openRoom({ server: SERVER, token: 'dev-bob', docId: 'x', shareLink, kit: 'kit.mockroom' })).rejects.toThrow(/docId or a shareLink/)
  })

  it("keeps a viewer's handle read-only", async () => {
    const { server, collection, open } = await setup()
    server.setRole(collection.docId, 'u:bob', 'viewer')
    const viewer = await open('dev-bob')
    expect(viewer.role).toBe('viewer')
    expect(await titles(viewer)).toEqual(['Q2 plan', 'Hiring'])
    const refused = await titles(viewer, () => 'Mine').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BatchError)
    expect((refused as BatchError).code).toBe('read-only')
    expect(server.rooms.get(collection.docId)!.changes).toEqual([])
    viewer.close()
  })

  it("lets a commenter's handle change comments only", async () => {
    const { server, collection, open } = await setup()
    server.setRole(collection.docId, 'u:bob', 'commenter')
    const commenter = await open('dev-bob')
    expect(commenter.role).toBe('commenter')
    const refused = await titles(commenter, () => 'Mine').catch((error: unknown) => error)
    expect((refused as BatchError).code).toBe('read-only')
    expect((refused as BatchError).message).toMatch(/only comments/)
    expect(server.rooms.get(collection.docId)!.changes).toEqual([])

    const result = await commenter.batch({
      ops: [
        { op: 'create', type: 'CommentThread', ref: '$thread', fields: { anchor: { object: 'root' }, resolved: false } },
        { op: 'create', type: 'Comment', ref: '$comment', in: '$thread.comments', fields: { author: 'u:bob', created: '2026-10-19T09:00:00Z' } },
        { op: 'text.insert', target: '$comment', field: 'body', index: 0, text: 'Check the numbers' },
      ],
      load: [{ target: '$comment', fields: ['author', 'body'] }],
    })
    expect(result.loaded[0].fields).toMatchObject({ author: 'u:bob', body: 'Check the numbers' })
    expect(server.rooms.get(collection.docId)!.changes.map((change) => change.from)).toEqual(['u:bob'])
    // Commands are an editor's: the server runs them for an owner or an editor only.
    await expect(commenter.commands.run('entry.new', {})).rejects.toThrow(/commenter may not run commands/)
    commenter.close()
  })

  it('keeps nothing of a change the server refuses', async () => {
    const { server, collection, open } = await setup()
    const doc = await open('dev-bob')
    expect(doc.role).toBe('editor')
    // The server has Bob as a viewer; the handle has not heard yet.
    server.rooms.get(collection.docId)!.members.get('u:bob')!.role = 'viewer'
    const refused = await titles(doc, () => 'Mine').catch((error: unknown) => error)
    expect((refused as BatchError).code).toBe('read-only')
    expect((refused as BatchError).message).toMatch(/the room refused the changes: viewers cannot push/)
    expect(await titles(doc)).toEqual(['Q2 plan', 'Hiring'])
    doc.close()
  })

  it("follows the owner's role changes", async () => {
    const { collection, open } = await setup()
    const owner = await open('dev-alice')
    const doc = await open('dev-bob')
    const roles: Array<string | null> = []
    doc.onRole((role) => roles.push(role))
    await owner.sync.setRole(collection.docId, 'u:bob', 'viewer')
    await until(() => roles.length === 1)
    expect(doc.role).toBe('viewer')
    await expect(titles(doc, () => 'Mine')).rejects.toThrow(/read-only/)
    await owner.sync.removeMember(collection.docId, 'u:bob')
    await until(() => roles.length === 2)
    expect(roles).toEqual(['viewer', null])
    expect(doc.role).toBe(null)
    // Removed: the handle still reads what it holds.
    expect(await titles(doc)).toEqual(['Q2 plan', 'Hiring'])
    owner.close()
    doc.close()
  })

  it('refuses commands on a server that runs no kits', async () => {
    const { open } = await setup()
    const doc = await open('dev-alice')
    expect(doc.runsCommands).toBe(false)
    expect(await doc.commands.list()).toEqual([])
    const refused = await doc.commands.run('entry.new', { title: 'More' }).catch((error: unknown) => error)
    expect((refused as BatchError).code).toBe('command-failed')
    expect((refused as BatchError).message).toMatch(/needs the kit's engine.*headless/)
    doc.close()
  })

  it("runs commands through the server's agent/run, and reads what they changed", async () => {
    const { server, collection, open } = await setup(['One'])
    server.capabilities = ['headless']
    const calls: unknown[] = []
    server.agent = ({ docId, batch }) => {
      calls.push(batch)
      // The server's headless kit: the room's document, one more entry.
      const room = server.rooms.get(docId)!
      const kit = Replica.load(collection.schema, room.snapshot, 77n)
      for (const change of room.changes) kit.importChanges(change.bytes)
      const before = kit.version()
      const root = kit.objectsOfType('Collection')[0]
      kit.transact({ kind: 'agent', principal: 'u:alice', label: 'Server agent' }, (tx) => {
        tx.listInsert(root, 'entries', tx.listItems(root, 'entries').length, tx.create('Entry', {}))
      })
      return { changes: kit.exportChanges(before), result: { refs: {}, results: [{ index: 1 }], loaded: [] } }
    }
    const doc = await open('dev-alice')
    expect(doc.runsCommands).toBe(true)
    const counted = await doc.run(async (context) => {
      const added = context.commands.run('entry.new', { title: 'Two' })
      context.root.load(['entries'])
      await context.sync()
      return { added: added.value, entries: (context.root as unknown as { entries: { length: number } }).entries.length }
    })
    expect(counted).toEqual({ added: { index: 1 }, entries: 2 })
    expect(calls).toEqual([{ ops: [{ op: 'command', id: 'entry.new', params: { title: 'Two' } }] }])
    doc.close()
  })

  it('leaves the room on close', async () => {
    const { server, collection, open } = await setup()
    const doc = await open('dev-bob')
    expect(server.rooms.get(collection.docId)!.members.has('u:bob')).toBe(true)
    doc.close()
    await until(() => !server.rooms.get(collection.docId)!.members.has('u:bob'))
    expect(server.calls.some((call) => call.method === 'room/leave')).toBe(true)
    await expect(titles(doc)).rejects.toThrow(/closed/)
  })

  it('fires changed for a change pushed by a plain sync client', async () => {
    const { server, collection, open } = await setup(['Before'])
    const doc = await open('dev-alice')
    const versions: Array<Uint8Array | null> = []
    doc.on('changed', (event) => versions.push(event.version))
    // Bob edits with the KDM and a SyncClient, as a kit editor's relay would.
    const bob = new SyncClient({ createTransport: fakeTransport(server).factory })
    await bob.connect(SERVER, 'dev-bob')
    await bob.join(collection.docId, null)
    const replica = Replica.load(collection.schema, collection.snapshot(), 55n)
    const before = replica.version()
    const paragraph = replica.objectsOfType('Paragraph')[0]
    replica.transact(person('u:bob'), (tx) => {
      tx.textDelete(paragraph, 'text', 0, tx.textLength(paragraph, 'text'))
      tx.textInsert(paragraph, 'text', 0, 'After')
    })
    await bob.push(collection.docId, replica.exportChanges(before))
    await until(() => versions.length === 1)
    expect(Version.decode(versions[0]!).equals(replica.version())).toBe(true)
    expect(await titles(doc)).toEqual(['After'])
    bob.close()
    doc.close()
  })
})

describe('syncEndpoint', () => {
  it('takes a WebSocket URL as it is, and a server address as its /v1/sync', () => {
    expect(syncEndpoint('wss://sync.kition.ai/v1/sync')).toBe('wss://sync.kition.ai/v1/sync')
    expect(syncEndpoint('http://127.0.0.1:18300')).toBe('ws://127.0.0.1:18300/v1/sync')
    expect(syncEndpoint('https://sync.kition.ai/')).toBe('wss://sync.kition.ai/v1/sync')
    expect(syncEndpoint('https://example.test/custom/sync')).toBe('wss://example.test/custom/sync')
    expect(() => syncEndpoint('ftp://example.test')).toThrow(/no sync server address/)
  })
})
