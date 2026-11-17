// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { KitPeer, type HostPeer, type KitPeerPresence, type KitSidePeer } from '@kition/kit-ui-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostConnection } from './host'
import { drawPresence, kitPresence, PRESENCE_INTERVAL_MS, remoteCarets, remoteSelections, usePresence, type KitPresence } from './presence'

/** A kit's host connection over a real channel, and the host's end of it. */
function connection(capabilities: string[]) {
  const channel = new MessageChannel()
  const peer: KitSidePeer = new KitPeer(channel.port1, 'k')
  const host: HostPeer = new KitPeer(channel.port2, 'h')
  const kit = { peer, init: { capabilities }, readOnly: false } as unknown as HostConnection
  return { kit, host }
}

const alice: KitPeerPresence = { principal: 'p1', name: 'Alice', color: '#e5484d', selection: ['shape-1', 'shape-2', 'gone'], caret: { object: 'para-1', field: 'text', offset: 4 } }
const bob: KitPeerPresence = { principal: 'p2', name: 'Bob', color: '#3e63dd', selection: [] }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.useRealTimers()
})

describe('kitPresence', () => {
  it('sends nothing and hears nobody when the host serves no presence', async () => {
    const { kit, host } = connection([])
    const sent = vi.fn()
    host.on('presence/set', sent)
    const presence = kitPresence(kit)
    expect(presence.available).toBe(false)
    presence.set({ selection: ['shape-1'] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).not.toHaveBeenCalled()
    expect(presence.peers()).toEqual([])
  })

  it('shares the presence at most every interval, the last one always, and nothing twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const { kit, host } = connection(['presence'])
    const sent: unknown[] = []
    host.on('presence/set', (params) => sent.push(params))
    const presence = kitPresence(kit)
    expect(kitPresence(kit)).toBe(presence)
    presence.set({ selection: ['a'] })
    presence.set({ selection: ['b'] })
    presence.set({ selection: ['c'], caret: { object: 'c', field: 'text', offset: 1 } })
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS)
    presence.set({ selection: ['c'], caret: { object: 'c', field: 'text', offset: 1 } })
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS)
    vi.useRealTimers()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent).toEqual([{ selection: ['a'] }, { selection: ['c'], caret: { object: 'c', field: 'text', offset: 1 } }])
  })

  it('follows the peers the host tells of, checked', async () => {
    const { kit, host } = connection(['presence'])
    const presence = kitPresence(kit)
    const heard = vi.fn()
    presence.subscribe(heard)
    host.notify('presence/peers', { peers: [alice, { name: 'no principal' } as unknown as KitPeerPresence, bob] })
    await vi.waitFor(() => expect(presence.peers()).toEqual([alice, bob]))
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('usePresence', () => {
  it('shares the local presence as it changes and renders the peers', async () => {
    const { kit, host } = connection(['presence'])
    const sent: unknown[] = []
    host.on('presence/set', (params) => sent.push(params))
    function Probe({ local }: { local: KitPresence | null }) {
      const { peers } = usePresence(kit, local)
      return <ul>{peers.map((peer) => <li key={peer.principal}>{peer.name}</li>)}</ul>
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<Probe local={null} />))
    act(() => root.render(<Probe local={{ selection: ['shape-1'] }} />))
    // The same presence again, built anew: not sent twice.
    act(() => root.render(<Probe local={{ selection: ['shape-1'] }} />))
    await vi.waitFor(() => expect(sent).toEqual([{ selection: ['shape-1'] }]))
    await act(async () => {
      host.notify('presence/peers', { peers: [alice] })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.textContent).toBe('Alice')
    act(() => root.unmount())
  })
})

describe('placing and drawing the peers', () => {
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = { 'shape-1': { x: 10, y: 20, width: 30, height: 40 }, 'shape-2': { x: 50, y: 60, width: 10, height: 10 } }

  it('places the objects the kit finds, labelling each peer once, and their carets', () => {
    const selections = remoteSelections([alice, bob], (id) => boxes[id] ?? null)
    expect(selections.map(({ objectId, label, name }) => [objectId, label, name])).toEqual([
      ['shape-1', true, 'Alice'],
      ['shape-2', false, 'Alice'],
    ])
    const carets = remoteCarets([alice, bob], (caret) => (caret.object === 'para-1' ? { x: caret.offset, y: 0, width: 1, height: 12 } : null))
    expect(carets).toEqual([{ principal: 'p1', name: 'Alice', color: '#e5484d', caret: alice.caret, rect: { x: 4, y: 0, width: 1, height: 12 } }])
  })

  it('draws outlines, name tags, and carets in each peer color', () => {
    const calls: string[] = []
    const context = new Proxy(
      { measureText: () => ({ width: 30 }) } as unknown as CanvasRenderingContext2D,
      {
        get: (target, key) => (key in target ? (target as unknown as Record<string | symbol, unknown>)[key] : (...args: unknown[]) => calls.push(`${String(key)}(${args.join(',')})`)),
        set: (_target, key, value) => {
          calls.push(`${String(key)}=${String(value)}`)
          return true
        },
      },
    )
    const selections = remoteSelections([alice], (id) => boxes[id] ?? null)
    const carets = remoteCarets([alice], () => ({ x: 4, y: 0, width: 1, height: 12 }))
    drawPresence(context, { selections, carets }, (x, y) => ({ x: x * 2, y: y * 2 }))
    expect(calls).toContain('strokeStyle=#e5484d')
    expect(calls).toContain('strokeRect(18,38,64,84)')
    expect(calls.filter((call) => call.startsWith('fillText(Alice'))).toHaveLength(2)
    expect(calls).toContain('fillRect(7,0,2,24)')
  })
})
