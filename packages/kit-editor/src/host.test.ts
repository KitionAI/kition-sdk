// @vitest-environment jsdom
import { KIT_UI_PROTOCOL, KitPeer, type HostPeer, type KitUiConfig } from '@kition/kit-ui-protocol'
import { describe, expect, it, vi } from 'vitest'
import { applyTheme, connectHost } from './host'

const brand = { light: '#2b5fd9', dark: '#6b9bff' }

describe('applyTheme', () => {
  it('puts the kit brand over the host primary unless the host keeps its own', () => {
    const root = document.createElement('div')
    applyTheme({ colorScheme: 'dark', tokens: { '--kit-primary': '#5645d4', '--kit-surface': '#1b1e23' } }, brand, root)
    expect(root.style.getPropertyValue('--kit-primary')).toBe('#6b9bff')
    expect(root.style.getPropertyValue('--kit-primary-text')).toBe('#000000')
    expect(root.style.getPropertyValue('--kit-surface')).toBe('#1b1e23')
    expect(root.dataset.brand).toBe('kit')
    applyTheme({ colorScheme: 'light', tokens: { '--kit-primary': '#3a2bb8', '--kit-primary-text': '#ffffff' }, brand: 'host' }, brand, root)
    expect(root.style.getPropertyValue('--kit-primary')).toBe('#3a2bb8')
    expect(root.dataset.brand).toBe('host')
  })

  it('keeps the host primary for a kit without a brand', () => {
    const root = document.createElement('div')
    applyTheme({ colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' } }, null, root)
    expect(root.style.getPropertyValue('--kit-primary')).toBe('#5645d4')
    expect(root.dataset.brand).toBe('host')
  })

  it('clears stale brand tokens when a later theme has the host keep its own', () => {
    const root = document.createElement('div')
    applyTheme({ colorScheme: 'dark', tokens: {} }, brand, root)
    applyTheme({ colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' }, brand: 'host' }, brand, root)
    expect(root.style.getPropertyValue('--kit-primary')).toBe('#5645d4')
    expect(root.style.getPropertyValue('--kit-primary-text')).toBe('')
    expect(root.style.getPropertyValue('--kit-primary-soft')).toBe('')
  })
})

/** Opens the handshake and sends `ui/initialize`, as a host embedding a kit would. */
function connectForTest(kit: Parameters<typeof connectHost>[0], capabilities: string[] = ['customize'], ui?: KitUiConfig, documentExtra: Record<string, unknown> = {}) {
  const channel = new MessageChannel()
  const hostPeer = new KitPeer(channel.port1, 'h') as HostPeer
  const connectionPromise = connectHost(kit)
  window.dispatchEvent(new MessageEvent('message', { source: window, data: { kitionKitUi: 1, protocol: KIT_UI_PROTOCOL }, ports: [channel.port2] }))
  const initPromise = hostPeer.request('ui/initialize', {
    protocol: KIT_UI_PROTOCOL,
    host: { name: 'host', version: '1' },
    document: { path: 'a.psd', name: 'a.psd', bytes: new ArrayBuffer(1), version: 'v1', ...documentExtra },
    theme: { colorScheme: 'light', tokens: {} },
    locale: 'en-US',
    shortcuts: [],
    capabilities,
    ...(ui ? { ui } : {}),
  })
  return { hostPeer, connectionPromise, initPromise }
}

describe('connectHost', () => {
  it('offers checkpoints and view state only when the host lists them (Kit UI protocol sections 7m, 7n)', async () => {
    const plain = connectForTest({ id: 'kit.test', version: '2', capabilities: ['ai', 'replica'] }, ['replica'])
    const without = await plain.connectionPromise
    without.opened()
    await plain.initPromise
    expect(without.files.checkpoints).toBeUndefined()
    expect(without.files.viewState).toBeUndefined()
    without.close()
    plain.hostPeer.close()

    // Checkpoints only for a kit that keeps its replica with the host.
    const noReplica = connectForTest({ id: 'kit.test', version: '2', capabilities: ['ai'] }, ['replica', 'checkpoints', 'view-state'])
    const partial = await noReplica.connectionPromise
    partial.opened()
    await noReplica.initPromise
    expect(partial.files.checkpoints).toBeUndefined()
    expect(partial.files.viewState).toBeDefined()
    partial.close()
    noReplica.hostPeer.close()

    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '2', capabilities: ['ai', 'replica'] }, ['replica', 'checkpoints', 'view-state'])
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    const checkpoint = { id: 'c1', time: 1, origin: 'kit', label: 'Sent', version: 'AQ==' }
    const asked: unknown[] = []
    const versions: number[][] = []
    hostPeer.handle('host/replicaWrite', (params) => {
      versions.push([...new Uint8Array(params.version)])
      asked.push(params.checkpoint)
      return params.checkpoint ? { checkpoint } : {}
    })
    hostPeer.handle('host/checkpointList', (params) => {
      asked.push(params)
      return { checkpoints: [checkpoint], more: false }
    })
    hostPeer.handle('host/checkpointRead', (params) => {
      asked.push(params)
      return { checkpoint, blobs: new Uint8Array([5]).buffer, snapshot: new Uint8Array([6]).buffer }
    })
    let kept: { state: Record<string, unknown> | null; bytes?: ArrayBuffer } = { state: null }
    hostPeer.handle('host/viewStateRead', () => kept)
    hostPeer.handle('host/viewStateWrite', ({ state, bytes }) => {
      kept = bytes ? { state, bytes } : { state }
      return {}
    })
    try {
      const replica = { snapshot: new ArrayBuffer(1), blobs: new ArrayBuffer(1), fileStamp: 'v2', version: new Uint8Array([7]).buffer }
      expect(await connection.files.replicaWrite!('a.psd', replica, { label: 'Sent' })).toEqual(checkpoint)
      expect(await connection.files.replicaWrite!('a.psd', { snapshot: new ArrayBuffer(1), blobs: new ArrayBuffer(1), fileStamp: 'v3', version: new Uint8Array([8]).buffer })).toBeNull()
      // The version taken with the snapshot travels with the write (UI-R6).
      expect(versions).toEqual([[7], [8]])
      expect(await connection.files.checkpoints!.list('a.psd', { labelled: true })).toEqual({ checkpoints: [checkpoint], more: false })
      // A read answers the snapshot the checkpoint keeps.
      const read1 = await connection.files.checkpoints!.read('a.psd', 'c1')
      expect([...new Uint8Array(read1.snapshot)]).toEqual([6])
      expect(asked).toEqual([{ label: 'Sent' }, undefined, { path: 'a.psd', labelled: true }, { path: 'a.psd', id: 'c1' }])
      expect(await connection.files.viewState!.read('a.psd')).toEqual({ state: null })
      await connection.files.viewState!.write('a.psd', { state: { zoom: 2 }, bytes: new Uint8Array([4]).buffer })
      const read = await connection.files.viewState!.read('a.psd')
      expect(read.state).toEqual({ zoom: 2 })
      expect(new Uint8Array(read.bytes!)).toEqual(new Uint8Array([4]))
    } finally {
      connection.close()
      hostPeer.close()
    }
  })

  it('forwards the saved file version to a third-party host without refreshing it', async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '2' }, [])
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    const writes: unknown[] = []
    hostPeer.handle('host/write', (params) => {
      writes.push(params.expected)
      if (params.expected !== 'v1') throw new Error('missing or stale expected version')
      return { path: params.path, version: 'v2' }
    })
    try {
      const file = await connection.files.read('a.psd')
      await expect(connection.files.write('a.psd', new Uint8Array([2]), file.stamp)).resolves.toBe('v2')
      expect(writes).toEqual(['v1'])
    } finally {
      connection.close()
      hostPeer.close()
    }
  })

  it("names the kit and its default display mode, and takes the host's modes", async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '2', display: 'classic' }, [], { modes: { allowed: ['menus', 'classic'], default: 'menus' } })
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    expect(connection.kit).toEqual({ id: 'kit.test', version: '2' })
    expect(connection.display).toBe('classic')
    expect(connection.ui.get().modes).toEqual({ allowed: ['menus', 'classic'], default: 'menus' })
    connection.close()
    hostPeer.close()
  })

  it('allows everything and draws no watermark when the host withholds nothing', async () => {
    const { connectionPromise } = connectForTest({ id: 'kit.test', version: '2' }, [])
    const connection = await connectionPromise
    expect(connection.permissions).toEqual({ download: true, export: true, share: true })
    expect(connection.watermark).toBeNull()
  })

  it("takes the open token's display permissions and watermark, checked (D2)", async () => {
    const { connectionPromise } = connectForTest({ id: 'kit.test', version: '2' }, [], undefined, { permissions: { download: false, export: 'yes', share: true }, watermark: { text: '  Alice 2026-11-03 ' } })
    const connection = await connectionPromise
    expect(connection.permissions).toEqual({ download: false, export: false, share: true })
    expect(connection.watermark).toEqual({ text: 'Alice 2026-11-03' })
  })

  it('asks the host only for the services it lists, and relays comment anchors (D4)', async () => {
    const { hostPeer, connectionPromise } = connectForTest({ id: 'kit.doc', version: '2' }, ['service:people.mention', 'comment-anchors'])
    const connection = await connectionPromise
    hostPeer.handle('host/service', (params) => ({ people: [{ id: 'u1', name: `found ${(params.params as { query: string }).query}` }] }) as never)
    expect(connection.hasService('people.mention')).toBe(true)
    expect(connection.hasService('share.open')).toBe(false)
    expect(await connection.service('people.mention', { query: 'an' })).toEqual({ people: [{ id: 'u1', name: 'found an' }] })
    await expect(connection.service('share.open', {})).rejects.toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
    expect(connection.commentAnchors).toBe(true)

    const shown: unknown[] = []
    connection.onComments((threads) => shown.push(threads))
    hostPeer.notify('comments/show', { threads: [{ id: 't1', anchor: { ids: ['p1'] }, resolved: true, count: 3 }, { id: 't2', anchor: { ids: [] } as never, resolved: false, count: 1 }] })
    await vi.waitFor(() => expect(shown).toEqual([[{ id: 't1', anchor: { ids: ['p1'] }, resolved: true, count: 3 }]]))
    connection.locateComments((anchors) => anchors.map((anchor) => anchor.ids[0] === 'p1'))
    expect(await hostPeer.request('comments/locate', { anchors: [{ ids: ['p1'] }, { ids: [] } as never, { ids: ['x'] }] })).toEqual({ found: [true, false, false] })
    const activated: unknown[] = []
    hostPeer.on('comments/activated', (params) => activated.push(params))
    connection.activateComment('t1')
    await vi.waitFor(() => expect(activated).toEqual([{ id: 't1' }]))
  })

  it('opens at no view by default, and hears checked reveals', async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '2' }, [])
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    expect(connection.view).toBeNull()
    const heard: unknown[] = []
    const stop = connection.onReveal((view) => heard.push(view))
    hostPeer.notify('document/reveal', { view: { path: 'tables/2', extra: 1 } as never })
    hostPeer.notify('document/reveal', { view: 'tables/3' as never })
    await vi.waitFor(() => expect(heard).toEqual([{ path: 'tables/2' }]))
    stop()
    connection.close()
    hostPeer.close()
  })

  it('ignores a default kit.json cannot name', async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '2', display: 'focus' }, [])
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    expect(connection.display).toBeNull()
    connection.close()
    hostPeer.close()
  })

  it('wires the host connection: brand, declared UI, configuration, personal hides, and host actions', async () => {
    const brand = { light: '#2b5fd9', dark: '#6b9bff' }
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '1', brand, ui: { panels: [] } }, ['customize'], { hide: ['menu:Help'] })

    const connection = await connectionPromise
    expect(connection.brand).toEqual(brand)
    expect(connection.declaration).toEqual({ panels: [] })
    expect(connection.ui.get().hide).toEqual(['menu:Help'])
    expect(connection.ui.customizable).toBe(true)
    expect(document.documentElement.dataset.brand).toBe('kit')

    connection.opened()
    const answer = await initPromise
    expect(answer.capabilities).toContain('ui-config')

    hostPeer.notify('ui/configure', { ui: { disable: ['action:save'] } })
    await vi.waitFor(() => expect(connection.ui.get().disable).toEqual(['action:save']))
    // Malformed params configure nothing instead of throwing.
    hostPeer.notify('ui/configure', null as never)
    await vi.waitFor(() => expect(connection.ui.get().disable).toEqual([]))

    const customizeCalls: unknown[] = []
    hostPeer.handle('host/customize', (params) => {
      customizeCalls.push(params)
      return {}
    })
    await connection.ui.setPersonal(['tool:Brush'])
    expect(customizeCalls).toEqual([{ personal: { hide: ['tool:Brush'] } }])

    const actions: unknown[] = []
    hostPeer.on('ui/action', (params) => actions.push(params))
    connection.ui.action({ id: 'x', document: { path: 'a.psd', dirty: false, revision: 0 } })
    await vi.waitFor(() => expect(actions).toEqual([{ id: 'x', document: { path: 'a.psd', dirty: false, revision: 0 } }]))

    connection.close()
    hostPeer.close()
  })

  it('does not announce ui-config without a declared UI', async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '1' }, [])

    const connection = await connectionPromise
    connection.opened()
    const answer = await initPromise
    expect(answer.capabilities).not.toContain('ui-config')

    connection.close()
    hostPeer.close()
  })

  it('offers the files client the host\'s capabilities name', async () => {
    const { hostPeer, connectionPromise, initPromise } = connectForTest({ id: 'kit.test', version: '1' }, ['files', 'print'])
    const connection = await connectionPromise
    connection.opened()
    await initPromise
    expect({ served: connection.kitFiles.served, canPick: connection.kitFiles.canPick, canPrint: connection.kitFiles.canPrint }).toEqual({ served: true, canPick: false, canPrint: true })
    hostPeer.handle('files/create', ({ suggestedName }) => ({ handle: 'fh_1', name: suggestedName, kind: 'file', version: null, rights: ['create'] }))
    expect(await connection.kitFiles.create('Out.pdf')).toMatchObject({ handle: 'fh_1', name: 'Out.pdf' })
    connection.close()
    hostPeer.close()
  })
})
