/**
 * Presence, as a kit's editor uses it (Kit UI protocol section 7e, capability `presence`): the kit
 * shares what the person has selected (KDM object ids), where their caret is, and what they look
 * at; the host carries it to the other people in the document and tells the kit what they share.
 * The kit then draws each peer's selection and caret in the peer's color, with their name, over
 * its own canvas (UI-P2): `useRemoteSelections` and `useRemoteCarets` place them, and
 * `drawPresence` draws them on a 2D canvas for a kit that draws its overlays there.
 *
 * With a host that does not serve `presence` (no co-editing), nothing is sent and nobody is there.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { parsePeers, parsePresence, type KitPeerPresence, type KitPresence, type KitPresenceCaret } from '@kition/kit-ui-protocol'
import type { HostConnection } from './host'

export type { KitPeerPresence, KitPresence, KitPresenceCaret }

/** How often at most a kit shares its presence while it changes (UI-P1), in milliseconds. */
export const PRESENCE_INTERVAL_MS = 100

/** A document's presence, seen from its kit. */
export type KitPresenceStore = {
  /** The host serves presence (the document may be co-edited). */
  readonly available: boolean
  /** The other people in the document, as last heard. */
  peers: () => KitPeerPresence[]
  subscribe: (listener: () => void) => () => void
  /**
   * Shares `presence`: at once, or, while it changes faster than every `PRESENCE_INTERVAL_MS`,
   * the last one when the interval ends. A presence equal to the last one shared is not sent again.
   */
  set: (presence: KitPresence) => void
}

const EMPTY: KitPeerPresence[] = []
const stores = new WeakMap<HostConnection, KitPresenceStore>()

function make(host: HostConnection): KitPresenceStore {
  const available = host.init.capabilities.includes('presence')
  let peers: KitPeerPresence[] = EMPTY
  const listeners = new Set<() => void>()
  if (available) {
    host.peer.on('presence/peers', (params) => {
      const next = parsePeers(params?.peers)
      peers = next.length ? next : EMPTY
      for (const listener of [...listeners]) listener()
    })
  }
  let sent = ''
  let lastAt = Number.NEGATIVE_INFINITY
  let waiting: KitPresence | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const send = (presence: KitPresence) => {
    const text = JSON.stringify(presence)
    if (text === sent) return
    sent = text
    lastAt = Date.now()
    host.peer.notify('presence/set', presence)
  }
  return {
    available,
    peers: () => peers,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (presence) => {
      if (!available) return
      const checked = parsePresence(presence)
      if (!checked) return
      const wait = lastAt + PRESENCE_INTERVAL_MS - Date.now()
      if (wait <= 0 && !timer) {
        send(checked)
        return
      }
      waiting = checked
      timer ??= setTimeout(
        () => {
          timer = null
          const next = waiting
          waiting = null
          if (next) send(next)
        },
        Math.max(wait, 0),
      )
    },
  }
}

/** The presence of the document the kit connected through `host` (one store per connection). */
export function kitPresence(host: HostConnection): KitPresenceStore {
  let store = stores.get(host)
  if (!store) stores.set(host, (store = make(host)))
  return store
}

/**
 * The other people in the document, following changes, and this session's presence shared as
 * `local` changes (`null` or absent: nothing shared from here yet). `local` is compared by value,
 * so a kit may build it anew on every render.
 */
export function usePresence(host: HostConnection, local?: KitPresence | null) {
  const store = kitPresence(host)
  const peers = useSyncExternalStore(store.subscribe, store.peers, store.peers)
  const key = local ? JSON.stringify(local) : null
  useEffect(() => {
    if (key !== null) store.set(JSON.parse(key) as KitPresence)
  }, [store, key])
  return { available: store.available, peers, setPresence: store.set }
}

/** A rectangle in the kit's own coordinates (document points, or the canvas's), as the kit places objects. */
export type PresenceRect = { x: number; y: number; width: number; height: number }

/** One object a peer has selected, where the kit found it. `label` is true for the first of the peer's objects: draw their name there. */
export type RemoteSelection = { principal: string; name: string; color: string; objectId: string; rect: PresenceRect; label: boolean }

/** A peer's caret, where the kit found it (a thin rectangle at the caret's position). */
export type RemoteCaret = { principal: string; name: string; color: string; caret: KitPresenceCaret; rect: PresenceRect }

/**
 * The peers' selected objects the kit can place: `locate` answers an object's rectangle, or
 * `null` for one it does not show now (on another page, deleted meanwhile), which is left out.
 */
export function remoteSelections(peers: readonly KitPeerPresence[], locate: (objectId: string) => PresenceRect | null): RemoteSelection[] {
  const out: RemoteSelection[] = []
  for (const peer of peers) {
    let labelled = false
    for (const objectId of peer.selection) {
      const rect = locate(objectId)
      if (!rect) continue
      out.push({ principal: peer.principal, name: peer.name, color: peer.color, objectId, rect, label: !labelled })
      labelled = true
    }
  }
  return out
}

/** The peers' carets the kit can place (`locate` answers `null` for one it does not show now). */
export function remoteCarets(peers: readonly KitPeerPresence[], locate: (caret: KitPresenceCaret) => PresenceRect | null): RemoteCaret[] {
  const out: RemoteCaret[] = []
  for (const peer of peers) {
    if (!peer.caret) continue
    const rect = locate(peer.caret)
    if (rect) out.push({ principal: peer.principal, name: peer.name, color: peer.color, caret: peer.caret, rect })
  }
  return out
}

/** `remoteSelections`, kept while `peers` and `locate` stay the same (memoize `locate`). */
export function useRemoteSelections(peers: readonly KitPeerPresence[], locate: (objectId: string) => PresenceRect | null): RemoteSelection[] {
  return useMemo(() => remoteSelections(peers, locate), [peers, locate])
}

/** `remoteCarets`, kept while `peers` and `locate` stay the same (memoize `locate`). */
export function useRemoteCarets(peers: readonly KitPeerPresence[], locate: (caret: KitPresenceCaret) => PresenceRect | null): RemoteCaret[] {
  return useMemo(() => remoteCarets(peers, locate), [peers, locate])
}

/** A peer's color, or a neutral one when the host named none. */
export const peerColor = (color: string) => (/^#[0-9a-f]{3,8}$/i.test(color) || /^(rgb|hsl)a?\(/i.test(color) ? color : '#6b7280')

/**
 * Draws the peers' selections (an outline in each peer's color, their name in a tag above the
 * first object) and carets on a 2D canvas, for a kit that draws its overlays there. `toScreen`
 * maps the kit's coordinates to the canvas's, as kit-editor's `RasterDecoration` hands it.
 */
export function drawPresence(context: CanvasRenderingContext2D, items: { selections?: readonly RemoteSelection[]; carets?: readonly RemoteCaret[] }, toScreen: (x: number, y: number) => { x: number; y: number }) {
  context.save()
  context.font = '600 11px system-ui, sans-serif'
  context.textBaseline = 'middle'
  const tag = (name: string, color: string, x: number, y: number) => {
    const width = context.measureText(name).width + 10
    context.fillStyle = color
    context.beginPath()
    context.roundRect(x, y - 16, width, 16, 4)
    context.fill()
    context.fillStyle = '#ffffff'
    context.fillText(name, x + 5, y - 8)
  }
  for (const item of items.selections ?? []) {
    const color = peerColor(item.color)
    const a = toScreen(item.rect.x, item.rect.y)
    const b = toScreen(item.rect.x + item.rect.width, item.rect.y + item.rect.height)
    context.strokeStyle = color
    context.lineWidth = 2
    context.strokeRect(a.x - 2, a.y - 2, b.x - a.x + 4, b.y - a.y + 4)
    if (item.label) tag(item.name, color, a.x - 2, a.y - 3)
  }
  for (const item of items.carets ?? []) {
    const color = peerColor(item.color)
    const a = toScreen(item.rect.x, item.rect.y)
    const b = toScreen(item.rect.x + item.rect.width, item.rect.y + item.rect.height)
    context.fillStyle = color
    context.fillRect(a.x - 1, a.y, Math.max(2, b.x - a.x), Math.max(2, b.y - a.y))
    tag(item.name, color, a.x - 1, a.y)
  }
  context.restore()
}
