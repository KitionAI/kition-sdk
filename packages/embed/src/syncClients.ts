/**
 * The page's connections to sync servers, connected while an editor uses them; the token is asked
 * for on every connection, so it can be refreshed.
 *
 * - Editors with sync tokens share one `SyncClient` per server URL; the first editor's identity
 *   answers its token.
 * - An editor with an open token (KitCollab 1.4) has a client of its identity provider's
 *   (`owner`): a host opens each file with its own provider, whose token names that file, so
 *   each file has its own connection, reconnecting with its own token and role, and closing one
 *   never hands its callback to another (managed-collab.md RM8, MC-02 to MC-04).
 */
import { SyncClient, type SyncTransport, type TransportFactory } from '@kition/sync'
import { EMBED_VERSION } from './version'

type Shared = { client: SyncClient; users: number }

const clients = new Map<string, Shared>()
/** A number per identity provider, for the `clients` key; forgotten with the provider. */
const owners = new WeakMap<object, number>()
let nextOwner = 0

function ownerId(owner: object) {
  let id = owners.get(owner)
  if (id === undefined) owners.set(owner, (id = (nextOwner += 1)))
  return id
}

function webSocketTransport(url: string): SyncTransport {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket as unknown as SyncTransport
}

/**
 * The page's client for `server` (or, with `owner`, that identity provider's own client for it and
 * the open token's `file`),
 * connecting it on first use with `token`; `release` when done with it.
 */
export function acquireSyncClient(server: string, token: () => string | Promise<string>, createTransport: TransportFactory = webSocketTransport, owner?: object, file = '') {
  const key = owner ? `owner ${ownerId(owner)} ${file} ${server}` : `url ${server}`
  let shared = clients.get(key)
  if (!shared) {
    const client = new SyncClient({ createTransport, client: { name: '@kition/embed', version: EMBED_VERSION } })
    shared = { client, users: 0 }
    clients.set(key, shared)
    // A first attempt that fails keeps retrying with backoff; editors follow the client's state.
    client.connect(server, token).catch(() => undefined)
  }
  shared.users += 1
  const entry = shared
  let released = false
  return {
    client: entry.client,
    release: () => {
      if (released) return
      released = true
      entry.users -= 1
      if (entry.users > 0 || clients.get(key) !== entry) return
      clients.delete(key)
      entry.client.close()
    },
  }
}

/** The client editors with sync tokens share for `server`, acquired, when one is open; else `null`. */
export function sharedSyncClient(server: string) {
  return clients.has(`url ${server}`) ? acquireSyncClient(server, () => Promise.reject(new Error('unused'))) : null
}

/** Resolves once `client` is online; rejects when `signal` aborts first. */
export function whenOnline(client: SyncClient, signal?: AbortSignal): Promise<void> {
  if (client.state === 'online') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => {
      off()
      signal?.removeEventListener('abort', aborted)
    }
    const aborted = () => {
      done()
      reject(new Error('the editor was closed'))
    }
    const off = client.onState((state) => {
      if (state !== 'online') return
      done()
      resolve()
    })
    if (signal?.aborted) aborted()
    else signal?.addEventListener('abort', aborted)
  })
}
