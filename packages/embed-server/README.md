# @kition/embed-server

The embed server, for URL embedding: your page frames a URL your server minted, and the
server shows a Kition kit editor there (the Note, Table and HTML kits today; other kits are not published yet), reading and
writing the file through HMAC-signed HTTP callbacks to your server. It keeps no document.
Single-user; for co-editing see `@kition/embed`. An ES module with type declarations, for Node 20.6
or later, and a `kition-embed-server` command.

```sh
npm i @kition/embed-server
```

```ts
import { startEmbedServer } from '@kition/embed-server'

const service = await startEmbedServer({
  id: 'docs-example',                     // the `aud` your open tokens name
  secret: process.env.DOC_SESSION_SECRET!, // at least 32 characters, signs the page's sessions
  integrators: [{
    iss: 'acme.app',                       // the `iss` your open tokens name
    keys: [{ kid: 'acme-1', publicKey: '<base64url Ed25519>', tenant: 'acme', iss: 'acme.app' }],
    callbackUrl: 'https://app.acme.com/kition',
    secret: process.env.ACME_CALLBACK_SECRET!, // shared with your server; signs every callback
    origins: ['https://app.acme.com'],     // who may frame the editor
  }],
  kits: [{ id: 'kit.note', path: 'note-ui/', extensions: ['.md'] }], // one entry per kit package you serve
  kitsUrl: 'https://kits.example.com/',    // the kit packages, on another origin (or kitsDir and kitsPort)
  host: '0.0.0.0',                         // default 127.0.0.1
  port: 8080,
})
console.log(service.url)
```

`createEmbedServer(config)` is the same as a Node `http` handler for your own server. The editor
page's module is the installed `@kition/embed` (a dependency); `embedDir` points elsewhere.

Or run it from a config file with those options (`.json`, or a module whose default export they are):

```sh
npx @kition/embed-server ./embed-server.config.mjs
```

Your server signs the iframe URL's open token with `signOpenToken` from `@kition/sync/openToken`,
and checks each callback with `verifyCallback` from `@kition/embed-server/callbacks` (it needs only
`node:crypto`). TypeScript projects need `@types/node`.

Documentation: https://developer.kition.ai/url

License: Apache-2.0
