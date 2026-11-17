/**
 * Protocol 1.9 against `FakeServer`: a person's document list (`rooms/list`, `rooms/changed`),
 * private rooms, and account settings, with two clients as the same person on two devices.
 */
import { describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import type { AccountSettings, RoomListing } from '../src/protocol'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const ash: Identity = { id: 'pA', name: 'Ash', color: '#f00' }
const bo: Identity = { id: 'pB', name: 'Bo', color: '#00f' }

async function device(server: FakeServer, token: string, identity: Identity) {
  server.identify(token, identity)
  const client = new SyncClient({ createTransport: fakeTransport(server).factory })
  await client.connect('ws://test', token)
  return client
}

describe('a person\'s documents (protocol 1.9)', () => {
  it('makes a private room with no link, lists it on the other device, and tells it when it is made', async () => {
    const server = new FakeServer()
    const laptop = await device(server, 'ash-1', ash)
    const desktop = await device(server, 'ash-2', ash)
    const heard: Array<[string, RoomListing | null]> = []
    desktop.onRoomsChanged((docId, room) => heard.push([docId, room]))

    const made = await laptop.createPrivateRoom('doc1', new Uint8Array([1, 2, 3]), 'Plan.kslide', 'kit.slide')
    expect(made.shareLink).toBeNull()
    expect(server.calls.find((call) => call.method === 'room/create')?.params.private).toBe(true)
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    expect(heard[0][0]).toBe('doc1')
    expect(heard[0][1]).toMatchObject({ docId: 'doc1', name: 'Plan.kslide', kit: 'kit.slide', role: 'owner', private: true, size: 3 })

    const listed = await desktop.listRooms()
    expect(listed.cursor).toBeNull()
    expect(listed.rooms.map((room) => room.docId)).toEqual(['doc1'])
    // Another person's list does not have it.
    const other = await device(server, 'bo', bo)
    expect((await other.listRooms()).rooms).toEqual([])

    // Minting a link shares it.
    await laptop.createLink('doc1', 'editor')
    await vi.waitFor(() => expect(heard.at(-1)?.[1]?.private).toBe(false))
  })

  it('pages the list with its cursor and keys it by docId', async () => {
    const server = new FakeServer()
    const client = await device(server, 'ash', ash)
    for (const n of [1, 2, 3, 4, 5]) await client.createRoom(`doc${n}`, new Uint8Array([n]), `Doc ${n}`, 'kit.sheet')
    const first = await client.listRooms({ limit: 2 })
    expect(first.rooms).toHaveLength(2)
    expect(first.cursor).not.toBeNull()
    const second = await client.listRooms({ cursor: first.cursor!, limit: 2 })
    expect(second.rooms.map((room) => room.docId)).not.toContain(first.rooms[0].docId)
    expect((await client.listAllRooms()).map((room) => room.docId).sort()).toEqual(['doc1', 'doc2', 'doc3', 'doc4', 'doc5'])
  })

  it('reads and changes the account settings, and every device hears the change', async () => {
    const server = new FakeServer()
    const laptop = await device(server, 'ash-1', ash)
    const desktop = await device(server, 'ash-2', ash)
    expect(await desktop.accountSettings()).toEqual({ syncAll: false })
    const heard: AccountSettings[] = []
    desktop.onAccountChanged((settings) => heard.push(settings))
    expect(await laptop.updateAccountSettings({ syncAll: true })).toEqual({ syncAll: true })
    await vi.waitFor(() => expect(heard).toEqual([{ syncAll: true }]))
    expect(await desktop.accountSettings()).toEqual({ syncAll: true })
  })
})
