/**
 * Protocol 1.10 saves (D3) against `FakeServer`: one save at a time across editors, one version per
 * save with the authors the server's log names, and must-save handed to the next editor.
 */
import { describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import { runSave } from '../src/saveRun'
import type { SaveState } from '../src/saveMachine'
import { FakeServer, fakeTransport, type Identity } from './helpers'

const ann: Identity = { id: 'ann', name: 'Ann', color: '#f00' }
const bob: Identity = { id: 'bob', name: 'Bob', color: '#00f' }

async function editor(server: FakeServer, identity: Identity) {
  server.identify(identity.id, identity)
  const client = new SyncClient({ createTransport: fakeTransport(server).factory })
  await client.connect('ws://test', identity.id)
  return client
}

describe('saving a co-edited room (protocol 1.10, D3)', () => {
  it('writes one version per save with the authors of its changes, and every editor hears the state', async () => {
    const server = new FakeServer()
    const a = await editor(server, ann)
    const b = await editor(server, bob)
    await a.createRoom('doc', new Uint8Array([0]), 'Plan.docx', 'kit.doc')
    await a.join('doc')
    await b.join('doc')
    const heard: SaveState[] = []
    b.onSave('doc', (save) => heard.push(save))
    await a.push('doc', new Uint8Array([1]))
    await b.push('doc', new Uint8Array([2]))
    const versions: Array<{ seq: number; authors: string[]; trigger: string }> = []
    const checkpoints: Array<{ seq: number; version: string }> = []
    const run = await runSave({
      client: a,
      docId: 'doc',
      trigger: 'user',
      write: async ({ seq, authors, trigger }) => {
        versions.push({ seq, authors: authors.map((author) => author.name).sort(), trigger })
        return 'v2'
      },
      checkpoint: async (save) => {
        checkpoints.push(save)
      },
    })
    expect(run).toMatchObject({ status: 'saved', version: 'v2', seq: 2, checkpointed: true })
    expect(versions).toEqual([{ seq: 2, authors: ['Ann', 'Bob'], trigger: 'user' }])
    expect(checkpoints).toEqual([{ seq: 2, version: 'v2' }])
    await vi.waitFor(() => expect(heard.at(-1)).toMatchObject({ status: 'editing', dirty: false, savedSeq: 2, version: 'v2' }))
    expect(heard.some((save) => save.status === 'force-save' && save.by === 'ann')).toBe(true)
    // Clean now: the timer saves nothing.
    expect(await runSave({ client: b, docId: 'doc', trigger: 'timer', write: async () => 'never' })).toEqual({ status: 'clean' })
  })

  it('lets one session save at a time, and keeps the edits dirty when the host refuses the version', async () => {
    const server = new FakeServer()
    const a = await editor(server, ann)
    const b = await editor(server, bob)
    await a.createRoom('doc', new Uint8Array([0]), 'Plan.docx', 'kit.doc')
    await a.join('doc')
    await b.join('doc')
    await a.push('doc', new Uint8Array([1]))
    let release: () => void = () => undefined
    const slow = runSave({ client: a, docId: 'doc', trigger: 'timer', write: () => new Promise((resolve) => (release = () => resolve('v2'))) })
    await vi.waitFor(() => expect(server.rooms.get('doc')?.save.status).toBe('force-save'))
    expect(await runSave({ client: b, docId: 'doc', trigger: 'user', write: async () => 'v9' })).toEqual({ status: 'busy' })
    release()
    expect(await slow).toMatchObject({ status: 'saved', version: 'v2' })

    await b.push('doc', new Uint8Array([2]))
    const refused = await runSave({ client: b, docId: 'doc', trigger: 'user', write: async () => Promise.reject(Object.assign(new Error('stale'), { code: 'conflict' })) })
    expect(refused).toMatchObject({ status: 'failed', error: 'conflict' })
    expect(server.rooms.get('doc')?.save).toMatchObject({ status: 'editing', dirty: true, reason: 'conflict', savedSeq: 1 })
  })

  it('reports a failed write as failed when the connection drops during it (no save/end to send)', async () => {
    const server = new FakeServer()
    server.identify(ann.id, ann)
    const { factory, sockets } = fakeTransport(server)
    // No reconnect during the test: the backoff timer never fires.
    const a = new SyncClient({ createTransport: factory, setTimeout: () => 0, clearTimeout: () => undefined })
    await a.connect('ws://test', ann.id)
    await a.createRoom('doc', new Uint8Array([0]), 'Plan.docx', 'kit.doc')
    await a.join('doc')
    await a.push('doc', new Uint8Array([1]))
    const run = await runSave({
      client: a,
      docId: 'doc',
      trigger: 'user',
      write: async () => {
        // The host refuses the write (an expired sign-in), and the open token's revocation closes the connection.
        sockets[0].close()
        await vi.waitFor(() => expect(a.state).toBe('offline'))
        throw new Error('401')
      },
    })
    expect(run).toMatchObject({ status: 'failed', error: 'failed' })
  })

  it('hands an unsaved room to the next editor (must-save, SV4)', async () => {
    const server = new FakeServer()
    const a = await editor(server, ann)
    await a.createRoom('doc', new Uint8Array([0]), 'Plan.docx', 'kit.doc')
    await a.join('doc')
    await a.push('doc', new Uint8Array([1]))
    a.leave('doc')
    await vi.waitFor(() => expect(server.rooms.get('doc')?.save.status).toBe('must-save'))
    const b = await editor(server, bob)
    await b.join('doc')
    expect(server.rooms.get('doc')?.save.status).toBe('must-save')
    expect(await runSave({ client: b, docId: 'doc', trigger: 'command', write: async () => 'v2' })).toMatchObject({ status: 'saved', authors: [{ principalId: 'ann', name: 'Ann' }] })
    b.leave('doc')
    await vi.waitFor(() => expect(server.rooms.get('doc')?.save.status).toBe('closed'))
  })
})
