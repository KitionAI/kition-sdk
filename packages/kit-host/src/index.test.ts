// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KIT_UI_PROTOCOL, KitPeer, KitRpcError, fetchImageErrorReason, hostRequestErrorReason, isFetchableUrl, isHandshake, isOpenableUrl, openErrorReason, parseOpenParams, isHello, matchesShortcut, type HostPeer, type KitGeneratePurpose, type KitSidePeer } from '@kition/kit-ui-protocol'
import { LEASE_HELD_REASON, mountKit, type KitHostHandlers } from './index'

/** A message from the kit frame's window to this one, as a kit page posts it to its parent. */
function fromKit(source: unknown, data: unknown, origin = 'http://127.0.0.1:3000') {
  const event = new MessageEvent('message', { data, origin })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

/**
 * A frame whose kit page answers the host's `hello` with `ready` (as document `ids[0]`, then each
 * next id on the next hello) and hands the handshake's port to `onPort`.
 */
function fakeFrame(onPort: (port: MessagePort, data: unknown, origin: string) => void, id = 'doc-1') {
  const contentWindow = {
    postMessage: (data: unknown, origin: string, transfer?: MessagePort[]) => {
      if (isHello(data)) setTimeout(() => fromKit(contentWindow, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id }))
      else if (transfer?.[0]) onPort(transfer[0], data, origin)
    },
  }
  return { contentWindow } as unknown as HTMLIFrameElement
}

const theme = { colorScheme: 'light' as const, tokens: { '--kit-primary': '#5645d4' } }

function handlers(overrides: Partial<KitHostHandlers> = {}): KitHostHandlers {
  return {
    read: async ({ path }) => ({ bytes: new TextEncoder().encode(`file ${path}`).buffer as ArrayBuffer, version: 'v1', size: 9 }),
    stamp: async () => ({ version: 'v1' }),
    write: async ({ path }) => ({ path, version: 'v2' }),
    changed: () => undefined,
    ...overrides,
  }
}

describe('the Kit UI protocol', () => {
  it('answers requests, carries notifications, and reports errors', async () => {
    const channel = new MessageChannel()
    const host: HostPeer = new KitPeer(channel.port1, 'h')
    const kit: KitSidePeer = new KitPeer(channel.port2, 'k')
    kit.handle('document/state', () => ({ dirty: true, revision: 3, title: 'Slide' }))
    kit.handle('document/save', () => {
      throw new Error('disk full')
    })
    const heard: unknown[] = []
    host.on('document/changed', (state) => heard.push(state))
    expect(await host.request('document/state', {})).toEqual({ dirty: true, revision: 3, title: 'Slide' })
    await expect(host.request('document/save', {})).rejects.toMatchObject({ code: -32000, message: 'disk full' })
    await expect(host.request('ai/inspect', {})).rejects.toBeInstanceOf(KitRpcError)
    kit.notify('document/changed', { dirty: false, revision: 4, title: 'Slide', by: 'agent' })
    await vi.waitFor(() => expect(heard).toEqual([{ dirty: false, revision: 4, title: 'Slide', by: 'agent' }]))
    host.close()
    kit.close()
  })

  it('transfers request buffers only when asked, and copies answers', async () => {
    const channel = new MessageChannel()
    const host: HostPeer = new KitPeer(channel.port1, 'h')
    const kit: KitSidePeer = new KitPeer(channel.port2, 'k')
    const cached = new Uint8Array([1, 2, 3]).buffer
    host.handle('host/read', () => ({ bytes: cached, version: 'v', size: 3 }))
    const read = await kit.request('host/read', { path: 'a' })
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(cached.byteLength, 'the answering side keeps what it answered').toBe(3)
    let written = 0
    host.handle('host/write', ({ bytes, path }) => {
      written = bytes.byteLength
      return { path, version: 'v2' }
    })
    const out = new Uint8Array([9, 9]).buffer
    await kit.request('host/write', { path: 'a', bytes: out, mode: 'save' }, { transfer: true })
    expect(written).toBe(2)
    expect(out.byteLength, 'a transferred buffer leaves the sender').toBe(0)
    host.close()
    kit.close()
  })

  it('matches host shortcuts with Cmd as Meta on macOS and Control elsewhere', () => {
    const key = { key: 'w', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    expect(matchesShortcut('Cmd+W', key, true)).toBe(true)
    expect(matchesShortcut('Cmd+W', key, false)).toBe(false)
    expect(matchesShortcut('Cmd+W', { ...key, metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(matchesShortcut('Cmd+Shift+W', key, true)).toBe(false)
  })
})

describe('mountKit', () => {
  it('hands the kit its port, initializes it, and serves its file calls', async () => {
    let kit: KitSidePeer | null = null
    let handshake: unknown
    let origin = ''
    const changes: unknown[] = []
    const frame = fakeFrame((port, data, target) => {
      handshake = data
      origin = target
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async (init) => {
        // The kit reads a lent file through the host before it answers.
        const read = await kit!.request('host/read', { path: 'talks/logo.png' })
        expect(new TextDecoder().decode(read.bytes)).toBe('file talks/logo.png')
        expect(init.document.path).toBe('talks/Launch.pptx')
        expect(init.shortcuts).toContain('Cmd+W')
        expect(init.capabilitySets).toEqual(['KitModel 1.0', 'KitCollab 1.0'])
        return { kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: ['ai'] }
      })
      kit.handle('ai/preview', ({ maxSize }) => ({ png: `png ${maxSize}` }))
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'talks/Launch.pptx', name: 'Launch.pptx', bytes: new ArrayBuffer(4), version: 'v1' },
      theme,
      locale: 'zh-CN',
      shortcuts: ['Cmd+W'],
      capabilitySets: ['KitModel 1.0', 'KitCollab 1.0'],
      handlers: handlers({ changed: (state) => changes.push(state) }),
    })
    expect(isHandshake(handshake)).toBe(true)
    expect(handshake).toMatchObject({ protocol: KIT_UI_PROTOCOL, id: 'doc-1' })
    expect(origin).toBe('http://127.0.0.1:3000')
    expect(connection.kit.id).toBe('kit.slide')
    expect(await connection.ai.preview(256)).toEqual({ png: 'png 256' })
    kit!.notify('document/changed', { dirty: true, revision: 2, title: 'Launch.pptx', by: 'person' })
    await vi.waitFor(() => expect(changes).toEqual([{ dirty: true, revision: 2, title: 'Launch.pptx', by: 'person' }]))
    // A host without a picker refuses `host/pick`.
    await expect(kit!.request('host/pick', { purpose: 'picture', accept: ['png'] })).rejects.toMatchObject({ code: -32601 })
    connection.close()
  })

  it('reaches the agent\'s draft of a kit that declares it, and hears it change', async () => {
    let kit: KitSidePeer | null = null
    const calls: Array<[string, unknown]> = []
    const heard: unknown[] = []
    const summary = { created: [{ id: 's1', type: 'Slide', fields: ['shapes'] }], changed: [], deleted: [], texts: [] }
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async () => ({ kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: ['ai', 'draft'] }))
      kit.handle('ai/run', (params) => {
        calls.push(['ai/run', params])
        return { completed: [], saved: false }
      })
      kit.handle('ai/inspect', (params) => {
        calls.push(['ai/inspect', params])
        return {}
      })
      kit.handle('draft/ready', () => ({ state: 'ready' as const, revision: 3 }))
      kit.handle('draft/compare', (params) => {
        calls.push(['draft/compare', params])
        return { summary, before: 'a', after: 'b' }
      })
      kit.handle('draft/merge', (params) => {
        calls.push(['draft/merge', params])
        return { merged: true, summary }
      })
      kit.handle('draft/discard', () => ({ state: 'none' as const, revision: null }))
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'talks/Launch.pptx', name: 'Launch.pptx', bytes: new ArrayBuffer(4), version: 'v1' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({ draftChanged: (info) => heard.push(info) }),
    })
    expect(connection.capabilities).toContain('draft')
    await connection.ai.run([{ command: 'slide.add' }], true, { draft: true })
    await connection.ai.run([{ command: 'slide.add' }], false)
    await connection.ai.inspect({ draft: true })
    expect(await connection.draft.ready()).toEqual({ state: 'ready', revision: 3 })
    expect(await connection.draft.compare({ maxSize: 64 })).toEqual({ summary, before: 'a', after: 'b' })
    expect(await connection.draft.merge({ kind: 'agent', principal: 'user:1', label: 'Merged' }, { kdm: 1 })).toEqual({ merged: true, summary })
    expect(await connection.draft.discard()).toEqual({ state: 'none', revision: null })
    expect(calls).toEqual([
      ['ai/run', { steps: [{ command: 'slide.add' }], save: true, draft: true }],
      ['ai/run', { steps: [{ command: 'slide.add' }], save: false }],
      ['ai/inspect', { draft: true }],
      ['draft/compare', { maxSize: 64 }],
      ['draft/merge', { origin: { kind: 'agent', principal: 'user:1', label: 'Merged' }, schema: { kdm: 1 } }],
    ])
    kit!.notify('draft/changed', { state: 'open', revision: 1 })
    await vi.waitFor(() => expect(heard).toEqual([{ state: 'open', revision: 1 }]))
    connection.close()
  })

  it("passes an agent step's context to the kit and asks what an agent write changed (C3b)", async () => {
    const calls: Array<[string, unknown]> = []
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async () => ({ kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: ['ai', 'context', 'changes'] }))
      kit.handle('ai/run', (params) => {
        calls.push(['ai/run', params])
        return { completed: [], saved: false }
      })
      kit.handle('ai/version', (params) => {
        calls.push(['ai/version', params])
        return { version: 'djE=' }
      })
      kit.handle('ai/changes', (params) => {
        calls.push(['ai/changes', params])
        return { changes: null, unavailable: 'replaced', version: 'djI=' }
      })
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'talks/Launch.pptx', name: 'Launch.pptx', bytes: new ArrayBuffer(4), version: 'v1' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers(),
    })
    expect(connection.capabilities).toEqual(expect.arrayContaining(['context', 'changes']))
    await connection.ai.run([{ command: 'shape.text', params: { text: 'X' }, context: { part: { slide: 2 }, on: ['s1'] } }], false)
    expect(await connection.ai.version()).toBe('djE=')
    expect(await connection.ai.changes('djE=', { types: {} })).toEqual({ changes: null, unavailable: 'replaced', version: 'djI=' })
    expect(calls).toEqual([
      ['ai/run', { steps: [{ command: 'shape.text', params: { text: 'X' }, context: { part: { slide: 2 }, on: ['s1'] } }], save: false }],
      ['ai/version', {}],
      ['ai/changes', { since: 'djE=', schema: { types: {} } }],
    ])
    connection.close()
  })

  it('forwards read-only kit premise requests through the host connection', async () => {
    const calls: unknown[] = []
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async () => ({ kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: ['ai', 'premises'] }))
      kit.handle('ai/premise', (params) => {
        calls.push(params)
        return { objects: ['s2'] }
      })
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000', host: { name: 'Test host', version: '1' },
      document: { path: 'talks/Launch.pptx', name: 'Launch.pptx', bytes: new ArrayBuffer(4), version: 'v1' },
      theme, locale: 'en-US', shortcuts: [], handlers: handlers(),
    })
    const params = { command: 'shape.text', params: {}, on: ['s2'], part: { slide: 2 } }
    expect(await connection.ai.premise('under', params)).toEqual({ objects: ['s2'] })
    expect(calls).toEqual([{ method: 'under', params }])
    connection.close()
  })

  it("sends a host's change as origin system with its label", async () => {
    const calls: unknown[] = []
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async () => ({ kit: { id: 'kit.table', version: '0.1.0' }, capabilities: ['ai'] }))
      kit.handle('ai/run', (params) => {
        calls.push(params)
        return { completed: [], saved: false }
      })
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'people.table', name: 'people.table', bytes: new ArrayBuffer(4), version: 'v1' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers(),
    })
    await connection.ai.run([{ command: 'table.records.create' }], true, { origin: 'system', originLabel: 'emailsync' })
    await connection.ai.run([{ command: 'table.records.create' }], false, { origin: 'system' })
    expect(calls).toEqual([
      { steps: [{ command: 'table.records.create' }], save: true, origin: 'system', originLabel: 'emailsync' },
      { steps: [{ command: 'table.records.create' }], save: false, origin: 'system' },
    ])
    connection.close()
  })

  it('asks a kit that checks for its diagnostics, and a kit that does not for none', async () => {
    const asked: unknown[] = []
    const diagnostic = { code: 'slide.text-overflow', severity: 'warning' as const, target: { slide: 2 }, message: 'The text does not fit its box.' }
    const mounted = (capabilities: string[]) => {
      const frame = fakeFrame((port) => {
        const kit: KitSidePeer = new KitPeer(port, 'k')
        kit.handle('ui/initialize', async () => ({ kit: { id: 'kit.slide', version: '0.1.0' }, capabilities }))
        kit.handle('document/check', (params) => {
          asked.push(params)
          return { diagnostics: [diagnostic] }
        })
      })
      return mountKit(frame, {
        origin: 'http://127.0.0.1:3000',
        host: { name: 'Test host', version: '1' },
        document: { path: 'talks/Launch.pptx', name: 'Launch.pptx', bytes: new ArrayBuffer(4), version: 'v1' },
        theme,
        locale: 'en-US',
        shortcuts: [],
        handlers: handlers(),
      })
    }
    const checking = await mounted(['ai', 'check'])
    expect(await checking.check()).toEqual([diagnostic])
    expect(await checking.check({ draft: true })).toEqual([diagnostic])
    checking.close()
    const plain = await mounted(['ai'])
    expect(await plain.check()).toEqual([])
    plain.close()
    expect(asked).toEqual([{}, { draft: true }])
  })

  it('keeps the replica of a kit that declares it, and reaches the kit\'s replica', async () => {
    let kit: KitSidePeer | null = null
    let offered: string[] = []
    const stored = new Map<string, { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }>()
    const versions: number[][] = []
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async (init) => {
        offered = init.capabilities
        // Nothing is stored yet: the answer is null, not an empty object.
        expect(await kit!.request('host/replicaRead', { path: 'art/Poster.psd' })).toBeNull()
        await kit!.request('host/replicaWrite', { path: 'art/Poster.psd', snapshot: new Uint8Array([1]).buffer, blobs: new Uint8Array([2]).buffer, fileStamp: 'v2' })
        const read = await kit!.request('host/replicaRead', { path: 'art/Poster.psd' })
        expect(read?.fileStamp).toBe('v2')
        expect(new Uint8Array(read!.snapshot)).toEqual(new Uint8Array([1]))
        return { kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: ['ai', 'replica'] }
      })
      kit.handle('replica/version', () => ({ version: new Uint8Array([4, 2]).buffer }))
      kit.handle('replica/export', ({ since }) => ({ changes: new Uint8Array([since.byteLength]).buffer, blobs: new ArrayBuffer(0) }))
      kit.handle('replica/import', ({ changes }) => ({ damage: { rects: changes.byteLength } }))
    })
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'art/Poster.psd', name: 'Poster.psd' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        replicaRead: ({ path }) => stored.get(path) ?? null,
        replicaWrite: ({ path, ...replica }) => {
          stored.set(path, replica)
        },
        replicaChanged: ({ version }) => versions.push([...new Uint8Array(version)]),
      }),
    })
    expect(offered).toContain('replica')
    expect(connection.capabilities).toContain('replica')
    expect(new Uint8Array(await connection.replica.version())).toEqual(new Uint8Array([4, 2]))
    expect(new Uint8Array((await connection.replica.exportChanges(new ArrayBuffer(3))).changes)).toEqual(new Uint8Array([3]))
    expect(await connection.replica.importChanges(new ArrayBuffer(5), new ArrayBuffer(0))).toEqual({ damage: { rects: 5 } })
    kit!.notify('replica/changed', { version: new Uint8Array([4, 3]).buffer })
    await vi.waitFor(() => expect(versions).toEqual([[4, 3]]))
    connection.close()
  })

  it('answers replica/info and lets more than one listener hear replica/changed', async () => {
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', () => ({ kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: ['ai', 'replica'] }))
      kit.handle('replica/version', () => ({ version: new Uint8Array([1]).buffer }))
      kit.handle('replica/export', ({ since }) => ({ changes: new Uint8Array([since.byteLength]).buffer, blobs: new ArrayBuffer(0) }))
      kit.handle('replica/import', () => ({ damage: null }))
      kit.handle('replica/info', () => ({ docId: 'room-9' }))
    })
    const versions: unknown[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'art/Poster.psd', name: 'Poster.psd' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({ replicaRead: () => null, replicaWrite: async () => undefined, replicaChanged: (params) => versions.push(['handler', [...new Uint8Array(params.version)]]) }),
    })
    expect(await connection.replica.info()).toBe('room-9')

    const heardByOne: number[][] = []
    const heardByTwo: number[][] = []
    const unsubscribe = connection.replica.onChanged((version) => heardByOne.push([...new Uint8Array(version)]))
    connection.replica.onChanged((version) => heardByTwo.push([...new Uint8Array(version)]))
    kit!.notify('replica/changed', { version: new Uint8Array([9, 9]).buffer })
    await vi.waitFor(() => expect(heardByOne).toEqual([[9, 9]]))
    expect(heardByTwo).toEqual([[9, 9]])
    // The handler passed to `mountKit` (for a host that keeps replicas) still hears it too.
    expect(versions).toEqual([['handler', [9, 9]]])

    // Unsubscribing stops only that listener.
    unsubscribe()
    kit!.notify('replica/changed', { version: new Uint8Array([1, 1]).buffer })
    await vi.waitFor(() => expect(heardByTwo).toEqual([[9, 9], [1, 1]]))
    expect(heardByOne).toEqual([[9, 9]])
    connection.close()
  })

  it('serves leases to a kit, tells it of changes, and hears its conflicts', async () => {
    let kit: KitSidePeer | null = null
    let offered: string[] = []
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: ['ai'] }
      })
    })
    const held: string[] = []
    const conflicts: unknown[] = []
    const schemas: unknown[] = []
    const alice = { principalId: 'p1', name: 'Alice', self: false }
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'Poster.psd', name: 'Poster.psd' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        leases: {
          acquire: ({ scope }) => {
            if (scope === 'busy') throw new KitRpcError(-32000, 'Alice is editing it', { reason: LEASE_HELD_REASON, lease: { scope, holder: alice } })
            held.push(scope)
            return { lease: { scope, holder: { principalId: 'me', name: 'Me', self: true } } }
          },
          release: ({ scope }) => void held.splice(held.indexOf(scope), 1),
          list: () => [{ scope: 'busy', holder: alice }],
        },
        conflicts: (params) => conflicts.push(params),
        schema: (params) => schemas.push(params),
      }),
    })
    expect(offered).toEqual(['lease'])
    const side = kit as unknown as KitSidePeer
    expect(await side.request('host/leaseAcquire', { scope: 'layer-1' })).toEqual({ lease: { scope: 'layer-1', holder: { principalId: 'me', name: 'Me', self: true } } })
    expect(held).toEqual(['layer-1'])
    await expect(side.request('host/leaseAcquire', { scope: 'busy' })).rejects.toMatchObject({ data: { reason: 'held', lease: { holder: { name: 'Alice' } } } })
    expect(await side.request('host/leases', {})).toEqual({ leases: [{ scope: 'busy', holder: alice }] })
    await side.request('host/leaseRelease', { scope: 'layer-1' })
    expect(held).toEqual([])

    const changes: unknown[] = []
    side.on('lease/changed', (params) => changes.push(params))
    connection.leasesChanged([{ scope: 'busy', holder: alice }])
    await vi.waitFor(() => expect(changes).toEqual([{ leases: [{ scope: 'busy', holder: alice }] }]))
    side.notify('document/conflicts', { conflicts: [{ id: 'conflict:1', kind: 'pdf.droppedEdit', summary: 'An edit was dropped' }] })
    await vi.waitFor(() => expect(conflicts).toEqual([{ conflicts: [{ id: 'conflict:1', kind: 'pdf.droppedEdit', summary: 'An edit was dropped' }] }]))
    // A newer kit edited the document (section 7f): only a well-formed report of a newer schema reaches the host.
    side.notify('document/schema', { reads: 2, newestAuthor: 2 })
    side.notify('document/schema', { reads: 1, newestAuthor: 'three' } as never)
    side.notify('document/schema', { reads: 1, newestAuthor: 3 })
    await vi.waitFor(() => expect(schemas).toEqual([{ reads: 1, newestAuthor: 3 }]))
    connection.close()
  })

  it('hears what the person shares, checked, tells the kit what the others share, and offers presence only with a handler', async () => {
    let kit: KitSidePeer | null = null
    let offered: string[] = []
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: ['ai', 'presence'] }
      })
    })
    const relayed: unknown[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'Slide.pptx', name: 'Slide.pptx' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({ presence: (presence) => relayed.push(presence) }),
    })
    expect(offered).toEqual(['presence'])
    const heard: unknown[] = []
    const stop = connection.onPresence((presence) => heard.push(presence))
    const side = kit as unknown as KitSidePeer
    side.notify('presence/set', { selection: ['shape-1', 7, 'shape-2'] as string[], caret: { object: 'para-1', field: 'text', offset: 3 }, viewport: { slide: 'slide-1' } })
    // A malformed caret and viewport are left out; the presence still goes through.
    side.notify('presence/set', { selection: 'shape-1' as unknown as string[], caret: { object: 'para-1', field: 'text', offset: -1 }, viewport: 'all' as unknown as Record<string, unknown> })
    await vi.waitFor(() => expect(relayed).toHaveLength(2))
    expect(relayed).toEqual([
      { selection: ['shape-1', 'shape-2'], caret: { object: 'para-1', field: 'text', offset: 3 }, viewport: { slide: 'slide-1' } },
      { selection: [] },
    ])
    expect(heard).toEqual(relayed)
    stop()

    const peers: unknown[] = []
    side.on('presence/peers', (params) => peers.push(params))
    const alice = { principal: 'p1', name: 'Alice', color: '#e5484d', selection: ['shape-1'] }
    connection.peersChanged([alice])
    await vi.waitFor(() => expect(peers).toEqual([{ peers: [alice] }]))
    connection.close()

    let without: string[] = ['?']
    const plain = fakeFrame((port) => {
      const other = new KitPeer(port, 'k') as KitSidePeer
      other.handle('ui/initialize', (init) => {
        without = init.capabilities
        return { kit: { id: 'kit.slide', version: '0.1.0' }, capabilities: [] }
      })
    })
    ;(await mountKit(plain, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a', name: 'a' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() })).close()
    expect(without).toEqual([])
  })

  it('opens at a view and reveals another in the open document', async () => {
    let opened: unknown
    const revealed: unknown[] = []
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', (init) => {
        opened = init.document.view
        return { kit: { id: 'kit.table', version: '0.1.0' }, capabilities: [] }
      })
      kit.on('document/reveal', (params) => revealed.push(params))
    })
    const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.ktable', name: 'a', view: { path: 'tables/2' } }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() })
    expect(opened).toEqual({ path: 'tables/2' })
    connection.reveal({ path: 'dashboards/5' })
    await vi.waitFor(() => expect(revealed).toEqual([{ view: { path: 'dashboards/5' } }]))
    connection.close()
  })

  it('offers no leases without a lease handler', async () => {
    let refused: unknown
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', async () => {
        refused = await kit.request('host/leaseAcquire', { scope: 'a' }).catch((error: unknown) => error)
        return { kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: [] }
      })
    })
    const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.psd', name: 'a.psd' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() })
    expect(refused).toMatchObject({ code: -32601 })
    connection.close()
  })

  it('runs host generation and the host actions it lists, and refuses the others', async () => {
    let offered: string[] = []
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.table', version: '0.2.0' }, capabilities: [] }
      })
    })
    const asked: unknown[] = []
    const ran: unknown[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'a.ktable', name: 'a.ktable' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        generate: (params) => {
          asked.push(params)
          if (params.purpose !== 'ai-field') throw new KitRpcError(-32000, 'not for this', { reason: 'not-allowed' })
          return { text: 'A summary', model: 'model-a', usage: { inputTokens: 3, outputTokens: 2 } }
        },
        actions: {
          'workflow.run': (params) => {
            ran.push(params)
            return { done: true, message: 'Started' }
          },
        },
      }),
    })
    expect(offered).toEqual(expect.arrayContaining(['generate', 'action:workflow.run']))
    expect(offered).not.toContain('action:design.fromRecord')
    const messages = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'Summarize' }] }]
    expect(await kit!.request('host/generate', { purpose: 'ai-field', output: 'text', model: 'hint', messages })).toEqual({ text: 'A summary', model: 'model-a', usage: { inputTokens: 3, outputTokens: 2 } })
    expect(asked).toEqual([{ purpose: 'ai-field', output: 'text', model: 'hint', messages }])
    const refusedPurpose = await kit!.request('host/generate', { purpose: 'other' as KitGeneratePurpose, output: 'text', messages }).catch((error: unknown) => error)
    expect(hostRequestErrorReason(refusedPurpose)).toBe('not-allowed')
    expect(await kit!.request('host/action', { id: 'workflow.run', params: { workflowId: 'w1', tableId: 't1', recordId: 'r1' } })).toEqual({ done: true, message: 'Started' })
    expect(ran).toEqual([{ workflowId: 'w1', tableId: 't1', recordId: 'r1' }])
    const unlisted = await kit!.request('host/action', { id: 'design.fromRecord', params: {} }).catch((error: unknown) => error)
    expect(unlisted).toMatchObject({ code: -32000 })
    expect(hostRequestErrorReason(unlisted)).toBe('not-allowed')
    connection.close()
  })

  it('passes the defined generation purposes and the kit’s own, and refuses others before the handler', async () => {
    let kit: KitSidePeer | null = null
    let early: unknown
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async () => {
        // Before the kit named itself, only the defined purposes pass.
        early = await kit!.request('host/generate', { purpose: 'note.outline', output: 'text', messages: [] }).catch((error: unknown) => error)
        return { kit: { id: 'kit.note', version: '0.1.0' }, capabilities: [] }
      })
    })
    const asked: string[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'a.md', name: 'a.md' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        generate: (params) => {
          asked.push(params.purpose)
          return { text: 'ok' }
        },
      }),
    })
    expect(hostRequestErrorReason(early)).toBe('not-allowed')
    const ask = (purpose: string) => kit!.request('host/generate', { purpose: purpose as KitGeneratePurpose, output: 'text', messages: [] }).catch((error: unknown) => error)
    expect(await ask('rewrite')).toEqual({ text: 'ok' })
    expect(await ask('ai-field')).toEqual({ text: 'ok' })
    expect(await ask('note.outline')).toEqual({ text: 'ok' })
    for (const refused of ['note-rewrite', 'table.summary', 'note.', 'note.Outline', 'other']) expect(hostRequestErrorReason(await ask(refused)), refused).toBe('not-allowed')
    expect(asked).toEqual(['rewrite', 'ai-field', 'note.outline'])
    connection.close()
  })

  it('opens files and web addresses for the kit, checked, and refuses other schemes before the handler', async () => {
    let offered: string[] = []
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.note', version: '0.1.0' }, capabilities: [] }
      })
    })
    const opened: unknown[] = []
    const urls: string[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'notes/a.md', name: 'a.md' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        open: (params) => {
          opened.push(params)
          if (params.link.name === 'Missing' && !params.create) throw new KitRpcError(-32000, 'Missing not found', { reason: 'not-found' })
          return { opened: params.link.name !== 'Declined' }
        },
        openUrl: ({ url }) => {
          urls.push(url)
          return { opened: true }
        },
      }),
    })
    expect(offered).toEqual(expect.arrayContaining(['open-file', 'open-url']))
    const open = (params: unknown) => kit!.request('host/open', params as never).catch((error: unknown) => error)
    expect(await open({ link: { name: 'Plan', extra: 1 }, view: { heading: ['Goals'], bogus: true }, beside: true })).toEqual({ opened: true })
    expect(await open({ link: { name: 'Declined' } })).toEqual({ opened: false })
    expect(openErrorReason(await open({ link: { name: 'Missing' } }))).toBe('not-found')
    expect(await open({ link: { name: 'Missing' }, create: { kit: 'kit.note' }, placement: 'beside' })).toEqual({ opened: true })
    expect(await open({ link: { path: '' } })).toMatchObject({ code: -32602 })
    expect(opened).toEqual([
      { link: { name: 'Plan' }, view: { heading: ['Goals'] }, placement: 'tab' },
      { link: { name: 'Declined' }, placement: 'tab' },
      { link: { name: 'Missing' }, placement: 'tab' },
      { link: { name: 'Missing' }, placement: 'beside', create: { kit: 'kit.note' } },
    ])
    expect(await kit!.request('host/openUrl', { url: 'https://example.com/docs' })).toEqual({ opened: true })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'docs/a.md', '']) {
      expect(openErrorReason(await kit!.request('host/openUrl', { url }).catch((error: unknown) => error)), url).toBe('not-allowed')
    }
    expect(urls).toEqual(['https://example.com/docs'])
    connection.close()
  })

  it('checks opening params and addresses', () => {
    expect(parseOpenParams({ link: { docId: 'd1' } })).toEqual({ link: { docId: 'd1' }, placement: 'tab' })
    expect(parseOpenParams({ link: {} })).toBeNull()
    expect(parseOpenParams({ link: 'a.md' })).toBeNull()
    expect(parseOpenParams(null)).toBeNull()
    expect(parseOpenParams({ link: { path: 'a.md' }, create: { kit: 3 } })).toEqual({ link: { path: 'a.md' }, placement: 'tab', create: {} })
    for (const url of ['https://example.com', 'http://a.b/c?d', 'mailto:a@example.com']) expect(isOpenableUrl(url), url).toBe(true)
    for (const url of ['javascript:void 0', 'ftp://a', '//example.com', 'example.com', 42]) expect(isOpenableUrl(url), String(url)).toBe(false)
  })

  it('fetches pictures by web address for the kit, checked, and refuses other schemes, answers that are not pictures, and read-only documents (section 7l)', async () => {
    const mount = async (readOnly: boolean, fetchImage: KitHostHandlers['fetchImage']) => {
      let offered: string[] = []
      let kit: KitSidePeer | null = null
      const frame = fakeFrame((port) => {
        kit = new KitPeer(port, 'k')
        kit.handle('ui/initialize', (init) => {
          offered = init.capabilities
          return { kit: { id: 'kit.note', version: '0.1.0' }, capabilities: [] }
        })
      })
      const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'notes/a.md', name: 'a.md', readOnly }, theme, locale: 'en-US', shortcuts: [], handlers: handlers({ fetchImage }) })
      return { offered, kit: kit! as KitSidePeer, connection }
    }
    const fetched: string[] = []
    const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer
    const { offered, kit, connection } = await mount(false, ({ url }) => {
      fetched.push(url)
      if (url.endsWith('/page.html')) return { bytes: picture, mime: 'text/html' as never }
      if (url.endsWith('/big.png')) throw new KitRpcError(-32000, 'too large', { reason: 'quota' })
      return { bytes: picture, mime: 'image/png' }
    })
    expect(offered).toContain('fetch-image')
    const fetchImage = (url: unknown) => kit.request('host/fetchImage', { url } as never).catch((error: unknown) => error)
    const answer = (await fetchImage('https://example.com/a.png?token=1')) as { bytes: ArrayBuffer; mime: string }
    expect(answer.mime).toBe('image/png')
    expect([...new Uint8Array(answer.bytes)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(fetchImageErrorReason(await fetchImage('https://example.com/page.html'))).toBe('unsupported')
    expect(fetchImageErrorReason(await fetchImage('https://example.com/big.png'))).toBe('quota')
    for (const url of ['file:///etc/passwd', 'data:image/png;base64,iVBO', 'javascript:alert(1)', 'pictures/a.png', '', 42]) {
      expect(fetchImageErrorReason(await fetchImage(url)), String(url)).toBe('not-allowed')
    }
    expect(fetched).toEqual(['https://example.com/a.png?token=1', 'https://example.com/page.html', 'https://example.com/big.png'])
    connection.close()

    const viewer = await mount(true, () => ({ bytes: picture, mime: 'image/png' }))
    expect(viewer.offered).not.toContain('fetch-image')
    expect(fetchImageErrorReason(await viewer.kit.request('host/fetchImage', { url: 'https://example.com/a.png' }).catch((error: unknown) => error))).toBe('read-only')
    viewer.connection.close()

    const without = await mount(false, undefined)
    expect(without.offered).not.toContain('fetch-image')
    expect(await without.kit.request('host/fetchImage', { url: 'https://example.com/a.png' }).catch((error: unknown) => error)).toMatchObject({ code: -32601 })
    without.connection.close()
  })

  it('checks fetchable addresses', () => {
    for (const url of ['https://example.com/a.png', 'http://a.b/c.jpg?d=1']) expect(isFetchableUrl(url), url).toBe(true)
    for (const url of ['mailto:a@example.com', 'ftp://a/b.png', '//example.com/a.png', 'a.png', 'blob:https://a/b', 42]) expect(isFetchableUrl(url), String(url)).toBe(false)
  })

  it('serves links/pick: document-relative links to files the chooser returned, never copied, nothing hidden (UI-N2 to UI-N4)', async () => {
    let offered: string[] = []
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.design', version: '0.2.0' }, capabilities: [] }
      })
    })
    const asked: unknown[] = []
    let chosen: Array<{ path: string; version: string | null }> = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 't', version: '1' },
      document: { path: 'designs/app/Home.kdesign', name: 'Home.kdesign' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        pickLinks: (params) => {
          asked.push(params)
          return chosen
        },
      }),
    })
    expect(offered).toContain('links-pick')
    const pick = (params: unknown) => kit!.request('links/pick', params as never).catch((error: unknown) => error)
    chosen = [
      { path: 'libraries/Design System.kdesign', version: 'v3' },
      { path: 'designs/app/Icons.kdesign', version: 'v1' },
    ]
    expect(await pick({ purpose: 'library', accept: ['KDESIGN', 'kdesign'] })).toEqual({ links: [{ path: '../../libraries/Design System.kdesign', name: 'Design System.kdesign', version: 'v3' }] })
    expect(asked).toEqual([{ purpose: 'library', accept: ['kdesign'], multiple: false }])
    chosen = [
      { path: 'designs/app/Home.kdesign', version: 'v1' },
      { path: '.kition/replicas/x.kdesign', version: 'v1' },
      { path: 'designs/.hidden/a.kdesign', version: 'v1' },
      { path: '/etc/a.kdesign', version: 'v1' },
      { path: '../outside.kdesign', version: 'v1' },
      { path: 'notes/a.md', version: 'v1' },
      { path: 'designs/app/parts/Icons.kdesign', version: null },
      { path: 'designs/app/parts/./Icons.kdesign', version: null },
      { path: 'designs/Shared.kdesign', version: 'v2' },
    ]
    expect(await pick({ purpose: 'library', accept: ['kdesign'], multiple: true }), 'the document, hidden paths, paths outside the workspace, and other extensions are left out').toEqual({
      links: [
        { path: 'parts/Icons.kdesign', name: 'Icons.kdesign', version: null },
        { path: '../Shared.kdesign', name: 'Shared.kdesign', version: 'v2' },
      ],
    })
    chosen = []
    expect(await pick({ purpose: 'library', accept: ['kdesign'] }), 'the person cancelled').toEqual({ links: [] })
    for (const params of [{ purpose: 'library', accept: [] }, { purpose: 'library', accept: ['.kdesign'] }, { accept: ['kdesign'] }, { purpose: 'library', accept: 'kdesign' }, null]) {
      expect(await pick(params), JSON.stringify(params)).toMatchObject({ code: -32602 })
    }
    connection.close()
  })

  it('offers no links/pick for a read-only document, and refuses it there', async () => {
    let offered: string[] = ['unset']
    let refused: unknown
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', async (init) => {
        offered = init.capabilities
        refused = await kit.request('links/pick', { purpose: 'library', accept: ['kdesign'] }).catch((error: unknown) => error)
        return { kit: { id: 'kit.design', version: '0.2.0' }, capabilities: [] }
      })
    })
    const pickLinks = vi.fn(() => [{ path: 'b.kdesign', version: 'v1' }])
    const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.kdesign', name: 'a.kdesign', readOnly: true }, theme, locale: 'en-US', shortcuts: [], handlers: handlers({ pickLinks }) })
    expect(offered).not.toContain('links-pick')
    expect(refused).toMatchObject({ code: -32000, data: { reason: 'read-only' } })
    expect(pickLinks).not.toHaveBeenCalled()
    connection.close()
  })

  it('offers no generation, actions, or opening without their handlers', async () => {
    let offered: string[] = ['unset']
    let refused: unknown
    let unopened: unknown
    let unpicked: unknown
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', async (init) => {
        offered = init.capabilities
        refused = await kit.request('host/generate', { purpose: 'ai-field', output: 'text', messages: [] }).catch((error: unknown) => error)
        unopened = await kit.request('host/open', { link: { name: 'Plan' } }).catch((error: unknown) => error)
        unpicked = await kit.request('links/pick', { purpose: 'library', accept: ['kdesign'] }).catch((error: unknown) => error)
        return { kit: { id: 'kit.table', version: '0.2.0' }, capabilities: [] }
      })
    })
    const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.ktable', name: 'a.ktable' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() })
    expect(offered).toEqual([])
    expect(refused).toMatchObject({ code: -32601 })
    expect(unopened).toMatchObject({ code: -32601 })
    expect(unpicked).toMatchObject({ code: -32601 })
    connection.close()
  })

  it('offers no replica without both replica handlers', async () => {
    let offered: string[] = ['unset']
    let refused: unknown
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', async (init) => {
        offered = init.capabilities
        refused = await kit.request('host/replicaRead', { path: 'a.psd' }).catch((error: unknown) => error)
        return { kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: ['replica'] }
      })
    })
    const connection = await mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.psd', name: 'a.psd' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers({ replicaRead: () => null }) })
    expect(offered).toEqual([])
    expect(refused).toMatchObject({ code: -32601 })
    connection.close()
  })

  it('hands its port only to the kit frame, and only from the kit origin (spoofed ready messages are ignored)', async () => {
    const handedTo: string[] = []
    const intruder = { postMessage: (data: unknown, _origin: string, transfer?: MessagePort[]) => void (transfer?.[0] && handedTo.push(`intruder:${(data as { id: string }).id}`)) }
    const contentWindow = {
      postMessage: (data: unknown, _origin: string, transfer?: MessagePort[]) => {
        if (isHello(data)) {
          // Another window (a second frame, an opener) and the right window from another origin both
          // claim to be the kit; neither may receive the channel.
          setTimeout(() => fromKit(intruder, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'intruder' }))
          setTimeout(() => fromKit(contentWindow, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'evil' }, 'http://evil.example'))
        }
        if (transfer?.[0]) handedTo.push((data as { id: string }).id)
      },
    }
    const frame = { contentWindow } as unknown as HTMLIFrameElement
    await expect(
      mountKit(frame, { origin: 'http://127.0.0.1:3000', timeoutMs: 50, host: { name: 't', version: '1' }, document: { path: 'a', name: 'a' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() }),
    ).rejects.toThrow('in time')
    expect(handedTo).toEqual([])
  })

  it('reports a kit that cannot open the document', async () => {
    const frame = fakeFrame((port) => {
      const kit = new KitPeer(port, 'k') as KitSidePeer
      kit.handle('ui/initialize', () => {
        throw new Error('not slides')
      })
    })
    await expect(
      mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a.pptx', name: 'a.pptx' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() }),
    ).rejects.toThrow('not slides')
  })

  it('connects to the page that replaced one it answered first', async () => {
    // The frame first holds a page that announces itself and then goes away (it never answers);
    // the kit page that replaces it announces itself as a new document and opens the file.
    const answered: string[] = []
    const contentWindow = {
      postMessage: (data: unknown, _origin: string, transfer?: MessagePort[]) => {
        if (isHello(data)) setTimeout(() => fromKit(contentWindow, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'old' }))
        if (!transfer?.[0]) return
        const id = (data as { id: string }).id
        answered.push(id)
        if (id === 'old') {
          // Navigated away: the new document announces itself.
          setTimeout(() => fromKit(contentWindow, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'new' }), 5)
          return
        }
        const kit = new KitPeer(transfer[0], 'k') as KitSidePeer
        kit.handle('ui/initialize', (init) => {
          expect(new Uint8Array(init.document.bytes!)).toEqual(new Uint8Array([7, 7]))
          return { kit: { id: 'kit.doc', version: '0.1.0' }, capabilities: [] }
        })
      },
    }
    const frame = { contentWindow } as unknown as HTMLIFrameElement
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 't', version: '1' },
      document: { path: 'a.docx', name: 'a.docx', bytes: new Uint8Array([7, 7]).buffer },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers(),
      timeoutMs: 2000,
    })
    expect(answered).toEqual(['old', 'new'])
    expect(connection.kit.id).toBe('kit.doc')
    connection.close()
  })

  it('ignores announcements from other windows', async () => {
    // The kit frame stays silent; another window announces itself and must get nothing.
    const frame = { contentWindow: { postMessage: () => undefined } } as unknown as HTMLIFrameElement
    const stranger: unknown[] = []
    const mounting = mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a', name: 'a' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers(), timeoutMs: 50 })
    fromKit({ postMessage: (data: unknown) => stranger.push(data) }, { kitionKitUi: 1, ready: KIT_UI_PROTOCOL, id: 'stranger' })
    await expect(mounting).rejects.toThrow('did not open the document in time')
    expect(stranger).toEqual([])
  })

  it('stops when the mount is abandoned', async () => {
    const frame = { contentWindow: { postMessage: () => undefined } } as unknown as HTMLIFrameElement
    const abandon = new AbortController()
    const mounting = mountKit(frame, { origin: '*', host: { name: 't', version: '1' }, document: { path: 'a', name: 'a' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers(), signal: abandon.signal })
    abandon.abort()
    await expect(mounting).rejects.toThrow('abandoned')
  })

  it('sends the UI configuration, keeps personal hides, hears host buttons, and reaches the catalog', async () => {
    let kit: KitSidePeer | null = null
    let initialized: { ui?: unknown; capabilities: string[] } | null = null
    const configured: unknown[] = []
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        initialized = init
        return { kit: { id: 'kit.photo', version: '0.1.0' }, capabilities: ['ai', 'ui-config'] }
      })
      kit.on('ui/configure', ({ ui }) => configured.push(ui))
      kit.handle('ui/elements', () => [{ id: 'panel:layers', kind: 'panel', label: 'Layers', parent: null, hidden: false, disabled: false }])
    })
    const kept: unknown[] = []
    const pressed: unknown[] = []
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'a.psd', name: 'a.psd', bytes: new ArrayBuffer(1), version: 'v1' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      ui: { hide: ['menu:Help'], personal: { hide: ['panel:history'] } },
      handlers: handlers({ customize: (params) => void kept.push(params), action: (params) => pressed.push(params) }),
    })
    expect(initialized!.ui).toEqual({ hide: ['menu:Help'], personal: { hide: ['panel:history'] } })
    expect(initialized!.capabilities).toContain('customize')
    expect(connection.capabilities).toContain('ui-config')
    await kit!.request('host/customize', { personal: { hide: ['tool:Brush'] } })
    expect(kept).toEqual([{ personal: { hide: ['tool:Brush'] } }])
    kit!.notify('ui/action', { id: 'submit', document: { path: 'a.psd', dirty: false, revision: 1 } })
    connection.configure({ disable: ['action:save'] })
    await vi.waitFor(() => expect(pressed).toEqual([{ id: 'submit', document: { path: 'a.psd', dirty: false, revision: 1 } }]))
    expect(configured).toEqual([{ disable: ['action:save'] }])
    expect(await connection.elements()).toEqual([{ id: 'panel:layers', kind: 'panel', label: 'Layers', parent: null, hidden: false, disabled: false }])
    connection.close()
  })
})

describe('mountKit with files', () => {
  it('lists files capabilities, serves files/* over the port, tells the kit of revoked handles, and ends the grants with the kit', async () => {
    let kit: KitSidePeer | null = null
    let capabilities: string[] = []
    const revoked: string[][] = []
    const disk = new Map<string, ArrayBuffer>([['in/a.pdf', new TextEncoder().encode('%PDF').buffer as ArrayBuffer]])
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.on('files/revoked', ({ handles }) => revoked.push(handles))
      kit.handle('ui/initialize', async (init) => {
        capabilities = init.capabilities
        return { kit: { id: 'kit.pdf', version: '0.1.0' }, capabilities: ['ai'] }
      })
    })
    const connection = await mountKit(frame, {
      origin: 'http://127.0.0.1:3000',
      host: { name: 'Test host', version: '1' },
      document: { path: 'talks/Launch.pdf', name: 'Launch.pdf', bytes: new ArrayBuffer(4), version: 'v1' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers(),
      files: {
        kit: 'kit.pdf',
        principal: 'alice',
        manifest: { read: ['pdf'], create: ['pdf'] },
        pick: async () => ['in/a.pdf'],
        gesture: () => true,
        storage: {
          stat: (ref) => (disk.has(ref) ? { kind: 'file', version: 'v1', size: disk.get(ref)!.byteLength } : null),
          read: async (ref, offset) => ({ bytes: disk.get(ref)!.slice(offset), version: 'v1', size: disk.get(ref)!.byteLength }),
          list: () => [],
          child: (folder, name) => `${folder ?? 'talks'}/${name}`,
          commit: async (ref, bytes) => {
            disk.set(ref, bytes.slice().buffer as ArrayBuffer)
            return { version: 'v1' }
          },
        },
      },
    })
    expect(capabilities).toEqual(expect.arrayContaining(['files', 'files-pick']))
    expect(capabilities).not.toContain('print')
    const { files } = await kit!.request('files/pick', { purpose: 'Insert pages', mode: 'open', accept: ['pdf'] })
    expect(files[0]).toMatchObject({ name: 'a.pdf', rights: ['read'] })
    const read = await kit!.request('files/read', { handle: files[0]!.handle })
    expect(new TextDecoder().decode(read.bytes)).toBe('%PDF')
    const out = await kit!.request('files/create', { suggestedName: 'Export.pdf' })
    expect(await kit!.request('files/write', { handle: out.handle, bytes: new ArrayBuffer(3), offset: 0, final: true })).toEqual({ version: 'v1' })
    expect(disk.has('talks/Export.pdf')).toBe(true)
    await expect(kit!.request('files/print', { bytes: new ArrayBuffer(1), mime: 'application/pdf', title: 'x' })).rejects.toMatchObject({ code: -32000, data: { reason: 'unsupported' } })
    expect(connection.files!.grants().map((grant) => grant.flow)).toEqual(['pick', 'create'])
    await connection.files!.revoke([files[0]!.handle])
    await vi.waitFor(() => expect(revoked).toEqual([[files[0]!.handle]]))
    await expect(kit!.request('files/read', { handle: files[0]!.handle })).rejects.toMatchObject({ data: { reason: 'file-not-granted' } })
    connection.close()
    await vi.waitFor(() => expect(connection.files!.grants()).toEqual([]))
  })

  it('serves no files/* without the files option', async () => {
    let kit: KitSidePeer | null = null
    let capabilities: string[] = []
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', async (init) => {
        capabilities = init.capabilities
        return { kit: { id: 'kit.pdf', version: '0.1.0' }, capabilities: ['ai'] }
      })
    })
    const connection = await mountKit(frame, { origin: 'http://127.0.0.1:3000', host: { name: 'Test host', version: '1' }, document: { path: 'a.pdf', name: 'a.pdf' }, theme, locale: 'en-US', shortcuts: [], handlers: handlers() })
    expect(capabilities).not.toContain('files')
    expect(connection.files).toBeNull()
    await expect(kit!.request('files/create', { suggestedName: 'x.pdf' })).rejects.toMatchObject({ code: -32601 })
    connection.close()
  })

  it('serves the host services it lists and refuses the others, and relays comment anchors (D4)', async () => {
    let offered: string[] = []
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.doc', version: '0.2.0' }, capabilities: ['comment-anchors'] }
      })
    })
    const mentioned: unknown[] = []
    const activated: string[] = []
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 'One', version: '1' },
      document: { path: 'a.docx', name: 'a.docx' },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        services: {
          'people.mention': (params) => {
            mentioned.push(params)
            return { people: [{ id: 'u2', name: 'Bob' }] }
          },
          'comment.create': (params) => ({ thread: `t-${params.anchor.ids[0]}` }),
        },
        comments: { activated: (id) => activated.push(id) },
      }),
    })
    expect(offered).toEqual(expect.arrayContaining(['service:people.mention', 'service:comment.create', 'comment-anchors']))
    expect(offered).not.toContain('service:share.open')
    expect(await kit!.request('host/service', { service: 'people.mention', params: { query: 'bo' } })).toEqual({ people: [{ id: 'u2', name: 'Bob' }] })
    expect(mentioned).toEqual([{ query: 'bo' }])
    expect(await kit!.request('host/service', { service: 'comment.create', params: { anchor: { ids: ['p1'], range: { start: 2, end: 5 }, quote: 'llo' } } })).toEqual({ thread: 't-p1' })
    const unserved = await kit!.request('host/service', { service: 'share.open', params: {} }).catch((error: unknown) => error)
    expect(unserved).toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
    const malformed = await kit!.request('host/service', { service: 'comment.create', params: { anchor: { ids: [] } } }).catch((error: unknown) => error)
    expect(malformed).toMatchObject({ code: -32602 })

    const shown: unknown[] = []
    kit!.on('comments/show', (params) => shown.push(params))
    kit!.handle('comments/locate', ({ anchors }) => ({ found: anchors.map((anchor) => anchor.ids[0] === 'p1') }))
    connection.showComments([
      { id: 't1', anchor: { ids: ['p1'] }, resolved: false, count: 2 },
      { id: 'bad', anchor: { ids: [] }, resolved: false, count: 1 },
    ])
    await vi.waitFor(() => expect(shown).toEqual([{ threads: [{ id: 't1', anchor: { ids: ['p1'] }, resolved: false, count: 2 }] }]))
    expect(await connection.locateComments([{ ids: ['p1'] }, { ids: ['gone'] }])).toEqual([true, false])
    kit!.notify('comments/activated', { id: 't1' })
    await vi.waitFor(() => expect(activated).toEqual(['t1']))
    connection.close()
  })

  it('offers and serves only the services the document`s permissions allow (UI-V4)', async () => {
    let offered: string[] = []
    let kit: KitSidePeer | null = null
    const frame = fakeFrame((port) => {
      kit = new KitPeer(port, 'k')
      kit.handle('ui/initialize', (init) => {
        offered = init.capabilities
        return { kit: { id: 'kit.doc', version: '0.2.0' }, capabilities: [] }
      })
    })
    const served = vi.fn(() => ({ done: true }))
    const connection = await mountKit(frame, {
      origin: '*',
      host: { name: 'One', version: '1' },
      document: { path: 'a.docx', name: 'a.docx', readOnly: true, permissions: { download: false, export: false, share: false } },
      theme,
      locale: 'en-US',
      shortcuts: [],
      handlers: handlers({
        services: {
          'share.open': served,
          'comment.create': () => ({ thread: 't' }),
          'file.rename': () => ({ name: 'x' }),
          'access.request': () => ({ requested: true }),
        },
      }),
    })
    expect(offered.filter((name) => name.startsWith('service:'))).toEqual(['service:access.request'])
    const refused = await kit!.request('host/service', { service: 'share.open', params: {} }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
    expect(served).not.toHaveBeenCalled()
    expect(await kit!.request('host/service', { service: 'access.request', params: { perm: 'edit' } })).toEqual({ requested: true })
    connection.close()
  })
})
