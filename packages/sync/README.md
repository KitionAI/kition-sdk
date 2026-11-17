# @kition/sync

The client for the open sync protocol `kition-sync/1`: JSON-RPC 2.0 over WebSocket, reconnect
with backoff, an offline push queue, and `startRelay`, which relays a `@kition/kdm` replica to and
from its room. An ES module with type declarations, for Node and for bundlers.
Most pages do not need it directly: `@kition/embed` co-edits through it.

```sh
npm i @kition/sync
```

```ts
import { SyncClient, type SyncTransport } from '@kition/sync'

const sync = new SyncClient({
  createTransport: (url) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    return socket as unknown as SyncTransport
  },
})
// The token comes from your server, which asks Kition Console for it.
await sync.connect('wss://sync.kition.ai/v1/t/acme', async () => (await (await fetch('/api/sync-token', { method: 'POST' })).json()).token)
await sync.join(docId)
sync.onChanges(docId, ({ changes }) => replica.importChanges(changes)) // a @kition/kdm Replica
await sync.push(docId, replica.exportChanges(sentVersion))
```

Documentation: https://developer.kition.ai/docs

License: Apache-2.0
