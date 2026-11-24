// @vitest-environment jsdom
/**
 * The dev host's replica, checkpoints and view state (Kit UI protocol sections 7, 7m and 7n;
 * sdk.dev-host.history): the store's handlers behind the real `mountKit`, driven by a fake kit
 * over the protocol as a kit's editor would.
 */
import { describe, expect, it } from 'vitest'
import { KIT_UI_PROTOCOL, KitPeer, isHello, type KitSidePeer } from '@kition/kit-ui-protocol'
import { CHECKPOINT_LABEL_LIMIT, VIEW_STATE_JSON_LIMIT, historyErrorReason, mountKit } from '@kition/kit-host'
import { DEV_UNLABELLED_CHECKPOINTS, DevHistory, base64 } from './history'

function fromKit(source: unknown, data: unknown) {
  const event = new MessageEvent('message', { data, origin: 'http://127.0.0.1:3000' })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

function fakeFrame(onPort: (port: MessagePort) => void) {
  const contentWindow = {
    postMessage: (data: unknown, _origin: string, transfer?: MessagePort[]) => {
      if (isHello(data)) setTimeout(() => fromKit(contentWindow, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'doc-1' }))
      else if (transfer?.[0]) onPort(transfer[0])
    },
  }
  return { contentWindow } as unknown as HTMLIFrameElement
}

const PATH = 'art/Poster.kdesign'
const bytes = (...values: number[]) => new Uint8Array(values).buffer

/**
 * Opens the document as the dev host does: the store's handlers for the file's `stamp`, and a fake
 * kit whose replica is at `kit.version` (what it answers to `replica/version`).
 */
async function open(history: DevHistory, stamp: string, readOnly = false) {
  const state = { version: bytes(1), offered: [] as string[] }
  let kit: KitSidePeer | null = null
  const frame = fakeFrame((port) => {
    kit = new KitPeer(port, 'k')
    kit.handle('ui/initialize', (init) => {
      state.offered = init.capabilities
      return { kit: { id: 'kit.design', version: '0.1.0' }, capabilities: ['replica'] }
    })
    kit.handle('replica/version', () => ({ version: state.version.slice(0) }))
  })
  let mine: Awaited<ReturnType<typeof mountKit>> | null = null
  const kept = history.handlers(PATH, stamp, async () => (mine ? mine.replica.version() : null))
  mine = await mountKit(frame, {
    origin: '*',
    host: { name: 't', version: '1' },
    document: { path: PATH, name: 'Poster.kdesign', readOnly },
    theme: { colorScheme: 'light', tokens: {} },
    locale: 'en-US',
    shortcuts: [],
    handlers: { read: async () => ({ bytes: bytes(0), version: stamp, size: 1 }), stamp: async () => ({ version: stamp }), write: async ({ path }) => ({ path, version: stamp }), changed: () => undefined, ...kept },
  })
  return { state, kit: kit! as KitSidePeer, connection: mine }
}

/** The reason of a refused request, or its code when it has none. */
async function refusal(request: Promise<unknown>) {
  try {
    await request
  } catch (error) {
    return historyErrorReason(error) ?? (error as { code?: number }).code
  }
  return 'answered'
}

/** The kit's save: the replica taken with the file, under the stamp the write answered, maybe with a checkpoint. */
const save = (kit: KitSidePeer, fileStamp: string, snapshot: number, checkpoint?: { label?: string; description?: string; author?: string }) =>
  kit.request('host/replicaWrite', { path: PATH, snapshot: bytes(snapshot), blobs: bytes(snapshot, 0), fileStamp, ...(checkpoint ? { checkpoint } : {}) })

describe('dev host checkpoints (capability checkpoints)', () => {
  it('records a checkpoint at the kit\'s replica version in the replica write, and reads it back after later saves and a reload', async () => {
    const history = new DevHistory()
    const first = await open(history, '1')
    expect(first.state.offered).toEqual(expect.arrayContaining(['replica', 'checkpoints', 'view-state']))
    // The first save: a new replica, and the person names the version.
    first.state.version = bytes(7)
    const named = await save(first.kit, '2', 10, { label: 'Sent to print', description: 'the printer got this one' })
    expect(named.checkpoint).toMatchObject({ origin: 'kit', label: 'Sent to print', description: 'the printer got this one', version: base64(bytes(7)), available: true })
    // A later save without one records nothing, and moves the stored replica on.
    first.state.version = bytes(8)
    expect(await save(first.kit, '3', 11)).toEqual({})
    expect(new Uint8Array(history.replica(PATH)!.snapshot)).toEqual(new Uint8Array([11]))
    // checkpointRead answers the blobs of the version, and its snapshot with state.
    const read = await first.kit.request('host/checkpointRead', { path: PATH, id: named.checkpoint!.id, state: true })
    expect(new Uint8Array(read.blobs)).toEqual(new Uint8Array([10, 0]))
    expect(new Uint8Array(read.snapshot!)).toEqual(new Uint8Array([10]))
    first.connection.close()
    // Reloaded on the file the replica was saved with: the same lineage, the checkpoint is there.
    const again = await open(history, '3')
    const listed = await again.kit.request('host/checkpointList', { path: PATH })
    expect(listed).toEqual({ checkpoints: [{ ...named.checkpoint, available: true }], more: false })
    expect((await again.kit.request('host/checkpointRead', { path: PATH, id: named.checkpoint!.id })).checkpoint.label).toBe('Sent to print')
    expect(await again.kit.request('host/replicaRead', { path: PATH })).toMatchObject({ fileStamp: '3' })
    again.connection.close()
  })

  it('answers the newest checkpoint at its version, and a labelled request upgrades the host\'s to the kit\'s', async () => {
    const history = new DevHistory()
    const { state, kit, connection } = await open(history, '1')
    state.version = bytes(3)
    await save(kit, '2', 1)
    // The host's own save checkpoint at the version the replica holds.
    const host = history.record(PATH, base64(bytes(3)), { origin: 'save' })!
    expect(host).toMatchObject({ origin: 'save', available: true })
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: host.id, label: 'Mine' }))).toBe('read-only')
    expect(await refusal(kit.request('host/checkpointDelete', { path: PATH, id: host.id }))).toBe('read-only')
    // At the same version without a label: that checkpoint, unchanged.
    expect((await save(kit, '2', 1, {})).checkpoint).toEqual(host)
    // With a label: the same checkpoint takes it and becomes the kit's, so the person can rename or delete it.
    const upgraded = (await save(kit, '2', 1, { label: 'Final', description: 'approved' })).checkpoint!
    expect(upgraded).toEqual({ ...host, origin: 'kit', label: 'Final', description: 'approved' })
    expect(history.checkpoints(PATH)).toHaveLength(1)
    expect((await kit.request('host/checkpointUpdate', { path: PATH, id: host.id, label: 'Final 2' })).checkpoint).toMatchObject({ origin: 'kit', label: 'Final 2', description: 'approved' })
    await kit.request('host/checkpointDelete', { path: PATH, id: host.id })
    expect(history.checkpoints(PATH)).toEqual([])
    expect(await refusal(kit.request('host/checkpointRead', { path: PATH, id: host.id }))).toBe('not-found')
    connection.close()
  })

  it('lists newest first, labelled only, before a checkpoint, at most limit, and thins only unlabelled ones', async () => {
    const history = new DevHistory()
    const { state, kit, connection } = await open(history, '1')
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      state.version = bytes(20 + index)
      ids.push((await save(kit, '2', index, index % 2 === 0 ? { label: `L${index}` } : {})).checkpoint!.id)
    }
    const all = await kit.request('host/checkpointList', { path: PATH })
    expect(all.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([...ids].reverse())
    expect(all.checkpoints.map((checkpoint) => checkpoint.time)).toEqual([...all.checkpoints.map((checkpoint) => checkpoint.time)].sort((a, b) => b - a))
    expect((await kit.request('host/checkpointList', { path: PATH, labelled: true })).checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['L4', 'L2', 'L0'])
    expect(await kit.request('host/checkpointList', { path: PATH, before: ids[3], limit: 2 })).toMatchObject({ checkpoints: [{ id: ids[2] }, { id: ids[1] }], more: true })
    expect(await kit.request('host/checkpointList', { path: PATH, labelled: true, before: ids[2], limit: 1 })).toMatchObject({ checkpoints: [{ id: ids[0] }], more: false })
    expect(await refusal(kit.request('host/checkpointList', { path: PATH, before: 'dev-checkpoint-unknown' }))).toBe('not-found')
    // Unlabelled ones are thinned past their limit; labelled ones never make room for them.
    for (let index = 0; index < DEV_UNLABELLED_CHECKPOINTS + 5; index += 1) {
      state.version = bytes(100, index)
      await save(kit, '2', 9, {})
    }
    const kept = history.checkpoints(PATH)
    expect(kept.filter((checkpoint) => !checkpoint.label)).toHaveLength(DEV_UNLABELLED_CHECKPOINTS)
    expect(kept.filter((checkpoint) => checkpoint.label).map((checkpoint) => checkpoint.label)).toEqual(['L4', 'L2', 'L0'])
    connection.close()
  })

  it('updates keep absent fields and drop empty ones; too-long, unknown ids and read-only documents are refused', async () => {
    const history = new DevHistory()
    const { state, kit, connection } = await open(history, '1')
    state.version = bytes(5)
    const made = (await save(kit, '2', 1, { label: 'Draft', description: 'first' })).checkpoint!
    const updated = (await kit.request('host/checkpointUpdate', { path: PATH, id: made.id, description: '' })).checkpoint
    expect(updated).toMatchObject({ id: made.id, origin: 'kit', label: 'Draft', version: made.version })
    expect(updated).not.toHaveProperty('description')
    expect(history.checkpoints(PATH)[0]).not.toHaveProperty('description')
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: made.id, label: 'x'.repeat(CHECKPOINT_LABEL_LIMIT + 1) }))).toBe('too-long')
    expect(await refusal(save(kit, '2', 1, { label: 'x'.repeat(CHECKPOINT_LABEL_LIMIT + 1) }))).toBe('too-long')
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'dev-checkpoint-unknown', label: 'A' }))).toBe('not-found')
    expect(history.checkpoints(PATH)).toHaveLength(1)
    connection.close()
    const viewer = await open(history, '2', true)
    expect(await refusal(viewer.kit.request('host/checkpointUpdate', { path: PATH, id: made.id, label: 'A' }))).toBe('read-only')
    expect(await refusal(viewer.kit.request('host/checkpointDelete', { path: PATH, id: made.id }))).toBe('read-only')
    expect(await refusal(save(viewer.kit, '2', 1, { label: 'B' }))).toBe('read-only')
    // A read-only document still lists and reads them.
    expect((await viewer.kit.request('host/checkpointList', { path: PATH })).checkpoints).toHaveLength(1)
    viewer.connection.close()
  })

  it('marks every earlier checkpoint unavailable when the replica is replaced by another lineage or the file is opened alone', async () => {
    const history = new DevHistory()
    const first = await open(history, '1')
    first.state.version = bytes(9)
    const made = (await save(first.kit, '2', 1, { label: 'Kept' })).checkpoint!
    first.connection.close()
    // The file changed under the replica (stamp 5, the replica was saved under 2): the kit opens it
    // plainly and its next replica is another lineage.
    const stale = await open(history, '5')
    expect((await stale.kit.request('host/checkpointList', { path: PATH })).checkpoints[0]!.available).toBe(true)
    await save(stale.kit, '6', 2)
    expect((await stale.kit.request('host/checkpointList', { path: PATH })).checkpoints).toEqual([{ ...made, available: false }])
    expect(await refusal(stale.kit.request('host/checkpointRead', { path: PATH, id: made.id }))).toBe('history-missing')
    // The labelled one stays listed, and its label can still be changed.
    expect((await stale.kit.request('host/checkpointUpdate', { path: PATH, id: made.id, label: 'Old' })).checkpoint).toMatchObject({ label: 'Old', available: false })
    // A new one in the new lineage is available; opening the file alone drops the replica.
    stale.state.version = bytes(9)
    const fresh = (await save(stale.kit, '6', 2, { label: 'New' })).checkpoint!
    expect(fresh.id).not.toBe(made.id)
    expect(fresh.available).toBe(true)
    stale.connection.close()
    history.forget(PATH)
    expect(history.replica(PATH)).toBeNull()
    expect(history.checkpoints(PATH).map((checkpoint) => checkpoint.available)).toEqual([false, false])
  })
})

describe('dev host view state (capability view-state)', () => {
  it('keeps a whole value per document apart from the replica, deletes it with null, and refuses one too large', async () => {
    const history = new DevHistory()
    const { kit, connection } = await open(history, '1')
    expect(await kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: null })
    await kit.request('host/viewStateWrite', { path: PATH, state: { v: 1, page: 3 }, bytes: bytes(4, 5) })
    const read = await kit.request('host/viewStateRead', { path: PATH })
    expect(read.state).toEqual({ v: 1, page: 3 })
    expect(new Uint8Array(read.bytes!)).toEqual(new Uint8Array([4, 5]))
    // Written whole: the last write wins, without the bytes it did not send.
    await kit.request('host/viewStateWrite', { path: PATH, state: { v: 1, page: 4 } })
    expect(await kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: { v: 1, page: 4 } })
    expect(await kit.request('host/viewStateRead', { path: 'other.kdesign' })).toEqual({ state: null })
    expect(history.replica(PATH)).toBeNull()
    expect(await refusal(kit.request('host/viewStateWrite', { path: PATH, state: { text: 'x'.repeat(VIEW_STATE_JSON_LIMIT) } }))).toBe('too-large')
    expect(history.viewState(PATH)).toEqual({ state: { v: 1, page: 4 } })
    await kit.request('host/viewStateWrite', { path: PATH, state: null })
    expect(history.viewState(PATH)).toEqual({ state: null })
    connection.close()
    // A read-only document keeps view state too (it is the person's); it survives a reload and opening the file alone.
    const viewer = await open(history, '1', true)
    await viewer.kit.request('host/viewStateWrite', { path: PATH, state: { v: 1, zoom: 2 } })
    viewer.connection.close()
    history.forget(PATH)
    const again = await open(history, '1')
    expect(await again.kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: { v: 1, zoom: 2 } })
    again.connection.close()
  })
})
