# @kition/embed

Kition's kit editors in any web page (the Note, Table and HTML kits are published; other kits are not published yet).
`KitionEmbed.mount` shows a kit's editor in an iframe, reads and saves the document through your
own storage, and, with `collaboration`, co-edits it with others through a `kition-sync/1` server.
Framework-free; Loro's WebAssembly is inlined, so no bundler setup is needed.

```sh
npm i @kition/embed
```

```ts
import { KitionEmbed } from '@kition/embed'

const editor = await KitionEmbed.mount(element, {
  kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }, // the kit package you host
  file: { id: 'plan-2026', name: 'Plan.md' },
  storage,             // your StorageProvider: read, stamp, write (versioned), create
  identity,            // your IdentityProvider: token, user, users, permissions
  collaboration: { server: 'wss://sync.example.com/v1/sync' }, // optional: co-editing
})
```

Documentation: https://developer.kition.ai/docs

License: Apache-2.0
