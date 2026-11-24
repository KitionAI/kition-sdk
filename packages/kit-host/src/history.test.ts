// @vitest-environment jsdom
/**
 * Checkpoints and view state (Kit UI protocol sections 7m and 7n; sdk.ui.checkpoints,
 * sdk.ui.view-state): offered only with the embedder's handlers, checked before them.
 */
import { describe, expect, it } from 'vitest'
import { KIT_UI_PROTOCOL, KitPeer, isHello, type KitCheckpoint, type KitSidePeer } from '@kition/kit-ui-protocol'
import { CHECKPOINT_DESCRIPTION_LIMIT, CHECKPOINT_LABEL_LIMIT, VIEW_STATE_BYTES_LIMIT, VIEW_STATE_JSON_LIMIT, historyErrorReason, mountKit, type KitHostHandlers } from './index'

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

const theme = { colorScheme: 'light' as const, tokens: {} }
const PATH = 'art/Poster.kdesign'

/** Mounts a kit with `extra` handlers; answers the capabilities offered and the kit's end of the channel. */
async function mount(extra: Partial<KitHostHandlers>, readOnly = false) {
  let kit: KitSidePeer | null = null
  let offered: string[] = []
  const frame = fakeFrame((port) => {
    kit = new KitPeer(port, 'k')
    kit.handle('ui/initialize', (init) => {
      offered = init.capabilities
      return { kit: { id: 'kit.design', version: '0.1.0' }, capabilities: ['ai', 'replica'] }
    })
  })
  const connection = await mountKit(frame, {
    origin: '*',
    host: { name: 't', version: '1' },
    document: { path: PATH, name: 'Poster.kdesign', readOnly },
    theme,
    locale: 'en-US',
    shortcuts: [],
    handlers: {
      read: async () => ({ bytes: new ArrayBuffer(1), version: 'v1', size: 1 }),
      stamp: async () => ({ version: 'v1' }),
      write: async ({ path }) => ({ path, version: 'v2' }),
      changed: () => undefined,
      ...extra,
    },
  })
  return { offered, kit: kit! as KitSidePeer, connection }
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

/** A store of checkpoints as a host keeps them: the host's `save` one and the kit's own. */
function store() {
  const checkpoints: KitCheckpoint[] = [
    { id: 'c-save', time: 1, origin: 'save', version: 'AQ==', available: true },
    { id: 'c-kit', time: 2, origin: 'kit', label: 'Draft 1', version: 'Ag==', available: true },
    { id: 'c-gone', time: 3, origin: 'kit', label: 'Old lineage', version: 'Aw==', available: false },
  ]
  const calls: string[] = []
  const replicas: unknown[] = []
  const handlers: Partial<KitHostHandlers> = {
    replicaRead: () => null,
    replicaWrite: ({ checkpoint, ...replica }) => {
      replicas.push(replica)
      if (!checkpoint) return
      const made: KitCheckpoint = { id: `c-${checkpoints.length}`, time: 9, origin: checkpoint.origin ?? 'kit', version: 'BA==', available: true, ...(checkpoint.label ? { label: checkpoint.label } : {}), ...(checkpoint.description ? { description: checkpoint.description } : {}) }
      checkpoints.push(made)
      return { checkpoint: made }
    },
    checkpoints: {
      find: ({ id }) => checkpoints.find((checkpoint) => checkpoint.id === id) ?? null,
      list: ({ labelled, limit }) => {
        calls.push(`list ${labelled ?? false} ${limit}`)
        const all = [...checkpoints].reverse().filter((checkpoint) => !labelled || checkpoint.label)
        return { checkpoints: all.slice(0, limit), more: all.length > (limit ?? 200) }
      },
      update: ({ id, label, description }) => {
        calls.push(`update ${id}`)
        const found = checkpoints.find((checkpoint) => checkpoint.id === id)!
        Object.assign(found, label !== undefined ? { label } : {}, description !== undefined ? { description } : {})
        return { checkpoint: found }
      },
      delete: ({ id }) => {
        calls.push(`delete ${id}`)
        checkpoints.splice(checkpoints.findIndex((checkpoint) => checkpoint.id === id), 1)
      },
      read: ({ id, state }) => {
        calls.push(`read ${id} ${state ?? false}`)
        return { checkpoint: checkpoints.find((checkpoint) => checkpoint.id === id)!, blobs: new Uint8Array([5]).buffer, ...(state ? { snapshot: new Uint8Array([6]).buffer } : {}) }
      },
    },
  }
  return { checkpoints, calls, replicas, handlers }
}

const replica = () => ({ path: PATH, snapshot: new Uint8Array([1]).buffer, blobs: new Uint8Array([2]).buffer, fileStamp: 'v2', version: new Uint8Array([4]).buffer })

describe('checkpoints (capability checkpoints)', () => {
  it('is offered only with the embedder\'s handlers, and only with the replica', async () => {
    const { handlers } = store()
    const served = await mount(handlers)
    expect(served.offered).toEqual(expect.arrayContaining(['replica', 'checkpoints']))
    served.connection.close()
    const withoutReplica = await mount({ checkpoints: handlers.checkpoints })
    expect(withoutReplica.offered).not.toContain('checkpoints')
    expect(await refusal(withoutReplica.kit.request('host/checkpointList', { path: PATH }))).toBe(-32601)
    withoutReplica.connection.close()
    const plain = await mount({ replicaRead: handlers.replicaRead, replicaWrite: handlers.replicaWrite })
    expect(plain.offered).toContain('replica')
    expect(plain.offered).not.toContain('checkpoints')
    for (const method of ['host/checkpointList', 'host/checkpointUpdate', 'host/checkpointDelete', 'host/checkpointRead'] as const) {
      expect(await refusal(plain.kit.request(method, { path: PATH, id: 'c-kit' } as never)), method).toBe(-32601)
    }
    plain.connection.close()
  })

  it('records a checkpoint in the replica write, and none on a host without them', async () => {
    const { checkpoints, replicas, handlers } = store()
    const { kit, connection } = await mount(handlers)
    const answer = await kit.request('host/replicaWrite', { ...replica(), checkpoint: { label: 'Sent to print', description: 'the version the printer got' } })
    expect(answer.checkpoint).toMatchObject({ origin: 'kit', label: 'Sent to print', description: 'the version the printer got', available: true })
    expect(checkpoints).toHaveLength(4)
    expect(replicas).toHaveLength(1)
    connection.close()

    // A host without checkpoints stores the replica and never sees the request.
    let seen: unknown = 'none'
    const plain = await mount({
      replicaRead: () => null,
      replicaWrite: (params) => {
        seen = params
      },
    })
    expect(await plain.kit.request('host/replicaWrite', { ...replica(), checkpoint: { label: 'x' } })).toEqual({})
    expect(seen).not.toHaveProperty('checkpoint')
    plain.connection.close()
  })

  it('hands the handler the version the write carries, and refuses a write without one (UI-R6)', async () => {
    const { replicas, checkpoints, handlers } = store()
    const { kit, connection } = await mount(handlers)
    await kit.request('host/replicaWrite', { ...replica(), checkpoint: { label: 'Saved' } })
    expect(new Uint8Array((replicas[0] as { version: ArrayBuffer }).version)).toEqual(new Uint8Array([4]))
    // Without the version the snapshot holds, nothing is stored and no checkpoint is recorded.
    const { version: _dropped, ...unversioned } = replica()
    expect(await refusal(kit.request('host/replicaWrite', { ...unversioned, checkpoint: { label: 'Later' } } as never))).toBe(-32602)
    expect(await refusal(kit.request('host/replicaWrite', unversioned as never))).toBe(-32602)
    expect(await refusal(kit.request('host/replicaWrite', { ...replica(), version: 'BA==' } as never))).toBe(-32602)
    expect(replicas).toHaveLength(1)
    expect(checkpoints).toHaveLength(4)
    connection.close()
  })

  it('lists newest first, labelled only on request, within the limit', async () => {
    const { calls, handlers } = store()
    const { kit, connection } = await mount(handlers)
    const all = await kit.request('host/checkpointList', { path: PATH })
    expect(all.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(['c-gone', 'c-kit', 'c-save'])
    expect(all.checkpoints[0].available).toBe(false)
    const labelled = await kit.request('host/checkpointList', { path: PATH, labelled: true, limit: 1 })
    expect(labelled).toMatchObject({ checkpoints: [{ id: 'c-gone' }], more: true })
    await kit.request('host/checkpointList', { path: PATH, limit: 100_000 })
    expect(calls).toEqual(['list false 200', 'list true 1', 'list false 200'])
    connection.close()
  })

  it('refuses each reason before the handler: too-long, not-found, read-only, history-missing', async () => {
    const { calls, checkpoints, handlers } = store()
    const { kit, connection } = await mount(handlers)
    // too-long: label, description, in a record and in an update.
    expect(await refusal(kit.request('host/replicaWrite', { ...replica(), checkpoint: { label: 'x'.repeat(CHECKPOINT_LABEL_LIMIT + 1) } }))).toBe('too-long')
    expect(await refusal(kit.request('host/replicaWrite', { ...replica(), checkpoint: { description: 'x'.repeat(CHECKPOINT_DESCRIPTION_LIMIT + 1) } }))).toBe('too-long')
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', label: 'x'.repeat(CHECKPOINT_LABEL_LIMIT + 1) }))).toBe('too-long')
    expect((await kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', label: 'x'.repeat(CHECKPOINT_LABEL_LIMIT) })).checkpoint.label).toHaveLength(CHECKPOINT_LABEL_LIMIT)
    // A label counts characters, not UTF-16 units.
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', label: '😀'.repeat(CHECKPOINT_LABEL_LIMIT) }))).toBe('answered')
    // not-found
    for (const method of ['host/checkpointUpdate', 'host/checkpointDelete', 'host/checkpointRead'] as const) {
      expect(await refusal(kit.request(method, { path: PATH, id: 'c-none' } as never)), method).toBe('not-found')
    }
    // read-only: another origin's checkpoint, a record of another origin.
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'c-save', label: 'Mine now' }))).toBe('read-only')
    expect(await refusal(kit.request('host/checkpointDelete', { path: PATH, id: 'c-save' }))).toBe('read-only')
    expect(await refusal(kit.request('host/replicaWrite', { ...replica(), checkpoint: { origin: 'save' as never } }))).toBe('read-only')
    expect(checkpoints.find((checkpoint) => checkpoint.id === 'c-save')).toEqual({ id: 'c-save', time: 1, origin: 'save', version: 'AQ==', available: true })
    // history-missing: a version the store no longer reaches.
    expect(await refusal(kit.request('host/checkpointRead', { path: PATH, id: 'c-gone' }))).toBe('history-missing')
    expect(calls).toEqual(['update c-kit', 'update c-kit'])
    connection.close()
  })

  it('reads the host\'s checkpoints, and updates and deletes the kit\'s own', async () => {
    const { calls, checkpoints, handlers } = store()
    const { kit, connection } = await mount(handlers)
    const read = await kit.request('host/checkpointRead', { path: PATH, id: 'c-save' })
    expect(read.checkpoint.id).toBe('c-save')
    expect(new Uint8Array(read.blobs)).toEqual(new Uint8Array([5]))
    expect(read.snapshot).toBeUndefined()
    const state = await kit.request('host/checkpointRead', { path: PATH, id: 'c-kit', state: true })
    expect(new Uint8Array(state.snapshot!)).toEqual(new Uint8Array([6]))
    expect((await kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', description: 'with the logo' })).checkpoint).toMatchObject({ label: 'Draft 1', description: 'with the logo' })
    expect(await kit.request('host/checkpointDelete', { path: PATH, id: 'c-kit' })).toEqual({})
    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual(['c-save', 'c-gone'])
    expect(calls).toEqual(['read c-save false', 'read c-kit true', 'update c-kit', 'delete c-kit'])
    connection.close()
  })

  it('a read-only document changes and records no checkpoints, and lists and reads them', async () => {
    const { calls, handlers } = store()
    const { kit, connection } = await mount(handlers, true)
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', label: 'x' }))).toBe('read-only')
    expect(await refusal(kit.request('host/checkpointDelete', { path: PATH, id: 'c-kit' }))).toBe('read-only')
    expect(await refusal(kit.request('host/replicaWrite', { ...replica(), checkpoint: { label: 'x' } }))).toBe('read-only')
    expect((await kit.request('host/checkpointList', { path: PATH })).checkpoints).toHaveLength(3)
    expect((await kit.request('host/checkpointRead', { path: PATH, id: 'c-kit' })).checkpoint.id).toBe('c-kit')
    expect(calls).toEqual(['list false 200', 'read c-kit false'])
    connection.close()
  })

  it('passes the host\'s conflict through', async () => {
    const { handlers } = store()
    const { KitRpcError } = await import('./index')
    const { kit, connection } = await mount({
      ...handlers,
      checkpoints: {
        ...handlers.checkpoints!,
        update: () => {
          throw new KitRpcError(-32000, 'changed meanwhile', { reason: 'conflict' })
        },
      },
    })
    expect(await refusal(kit.request('host/checkpointUpdate', { path: PATH, id: 'c-kit', label: 'y' }))).toBe('conflict')
    connection.close()
  })
})

describe('view state (capability view-state)', () => {
  /** A host's view-state store: by path, whole values. */
  function viewStore() {
    const kept = new Map<string, { state: Record<string, unknown> | null; bytes?: ArrayBuffer }>()
    const handlers: Partial<KitHostHandlers> = {
      viewState: {
        read: ({ path }) => kept.get(path) ?? { state: null },
        write: ({ path, state, bytes }) => {
          if (state === null) kept.delete(path)
          else kept.set(path, bytes ? { state, bytes } : { state })
        },
      },
    }
    return { kept, handlers }
  }

  it('is offered only with the embedder\'s handlers', async () => {
    const served = await mount(viewStore().handlers)
    expect(served.offered).toContain('view-state')
    served.connection.close()
    const plain = await mount({})
    expect(plain.offered).not.toContain('view-state')
    expect(await refusal(plain.kit.request('host/viewStateRead', { path: PATH }))).toBe(-32601)
    expect(await refusal(plain.kit.request('host/viewStateWrite', { path: PATH, state: {} }))).toBe(-32601)
    plain.connection.close()
  })

  it('keeps the value whole, last write wins, null deletes, also for a read-only document', async () => {
    const { kept, handlers } = viewStore()
    const { kit, connection } = await mount(handlers, true)
    expect(await kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: null })
    await kit.request('host/viewStateWrite', { path: PATH, state: { v: 1, zoom: 2 }, bytes: new Uint8Array([7]).buffer })
    await kit.request('host/viewStateWrite', { path: PATH, state: { v: 1, zoom: 3 } })
    expect(await kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: { v: 1, zoom: 3 } })
    await kit.request('host/viewStateWrite', { path: PATH, state: null })
    expect(kept.size).toBe(0)
    connection.close()
  })

  it('refuses a value over the limits as too-large, and a malformed one, before the handler', async () => {
    const { kept, handlers } = viewStore()
    const { kit, connection } = await mount(handlers)
    expect(await refusal(kit.request('host/viewStateWrite', { path: PATH, state: { p: 'x'.repeat(VIEW_STATE_JSON_LIMIT) } }))).toBe('too-large')
    expect(await refusal(kit.request('host/viewStateWrite', { path: PATH, state: {}, bytes: new ArrayBuffer(VIEW_STATE_BYTES_LIMIT + 1) }))).toBe('too-large')
    expect(await refusal(kit.request('host/viewStateWrite', { path: PATH, state: [1, 2] as never }))).toBe(-32602)
    expect(await refusal(kit.request('host/viewStateWrite', { path: PATH, state: 'zoom' as never }))).toBe(-32602)
    expect(kept.size).toBe(0)
    // At the limit it is kept.
    await kit.request('host/viewStateWrite', { path: PATH, state: { p: 'x'.repeat(VIEW_STATE_JSON_LIMIT - 8) } })
    expect(kept.size).toBe(1)
    connection.close()
  })

  it('reads a damaged value as none', async () => {
    const { kit, connection } = await mount({ viewState: { read: () => ({ state: 'garbage' as never, bytes: new ArrayBuffer(2) }), write: () => undefined } })
    expect(await kit.request('host/viewStateRead', { path: PATH })).toEqual({ state: null })
    connection.close()
  })
})
