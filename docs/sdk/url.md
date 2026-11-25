# URL embedding: a kit editor in an iframe (`@kition/embed-server`)

For integrators that cannot run [`@kition/embed`](embed.md) in their own page:
your server mints a URL, your page frames it, and the **embed server**
(`@kition/embed-server`) shows the kit's editor and reads and writes the document through
HTTP callbacks to your server. Single-user. Design: [url-embedding.md](../platform/url-embedding.md).
A runnable example is `examples/url-embed` (`node examples/url-embed/serve.mjs`).

```html
<iframe src="https://docs.example.com/v1/open?token=ko1.…" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
```

## 1. Run the embed server

```sh
npm i @kition/embed-server
```

It needs Node 20.6 or later, and brings `@kition/embed` (the editor page's
module) and `@kition/sync` with it.

```ts
import { startEmbedServer } from '@kition/embed-server'

await startEmbedServer({
  id: 'docs-example',                   // the `aud` your tokens name
  secret: process.env.DOC_SESSION_SECRET, // ≥ 32 characters, signs the page's sessions
  integrators: [{
    iss: 'acme.app',                     // the `iss` your tokens name
    keys: [{ kid: 'acme-1', publicKey: '<base64url Ed25519>', tenant: 'acme', iss: 'acme.app' }],
    callbackUrl: 'https://app.acme.com/kition',
    secret: process.env.ACME_CALLBACK_SECRET, // shared with you; signs every callback
    origins: ['https://app.acme.com'],   // who may frame the editor
  }],
  kits: [{ id: 'kit.note', path: 'note-ui/', extensions: ['.md'] }], // one entry per kit package you serve
  kitsUrl: 'https://kits.example.com/',  // kit packages, on another origin (or kitsDir + kitsPort)
  host: '0.0.0.0',                       // default 127.0.0.1
  port: 8080,
})
```

`createEmbedServer(config)` gives the same as a Node `http` handler for your
own server. The editor page's module is the installed `@kition/embed`'s
`dist`; `embedDir` names another.

Or run it with no code of your own, from a file holding those options (`.json`,
or a module whose default export they are, so secrets can come from
`process.env`):

```sh
npx @kition/embed-server ./embed-server.config.mjs   # or kition-embed-server, once installed
```

## 2. Mint the iframe URL

On your server, for a person you signed in and a file they may open, sign an
open token (`ko1.`, the same as managed co-editing,
[managed-collab.md](../platform/managed-collab.md) section 1) with
`signOpenToken` from `@kition/sync/openToken` (or the Rust crate
`kition-open-token`):

```ts
const token = await signOpenToken({
  iss: 'acme.app', aud: 'docs-example', tenant: 'acme',
  sub: user.id, name: user.name,
  file: 'res-42',            // your immutable file id
  version: 'v7',             // the version you open
  doc_key: 'res-42.g3',      // the file's generation: change it when the file is replaced
  perms: { edit: true, comment: true, download: true, share: false, export: true },
  watermark: null,           // or { text: 'Ann · Confidential' }
  iat: now, exp: now + 300,  // at most an hour; a few minutes is enough
}, 'acme-1', privateKey)
const src = `https://docs.example.com/v1/open?token=${encodeURIComponent(token)}`
```

Decide `perms` from your own ACL at that moment. The token only opens the
page: the page then works on a session the embed server signed (8 hours by
default), and drops the token from its address.

| `perms` | The editor |
| --- | --- |
| `edit` | Edits and saves |
| `comment` (without `edit`) | Read-only content, comments, saves the comments |
| neither | View only; the embed server refuses its writes (`403`) |
| `download`, `export`, `share` | Shows Download, Export and Print, Share only when true |
| `watermark` | Drawn over the document |

## 3. Answer the callbacks

The embed server calls, under your `callbackUrl`:

| Request | Answer |
| --- | --- |
| `HEAD /files/{file}` | `200` with `X-Kition-Version` and `X-Kition-Name` (the file name picks the kit); `404` |
| `GET /files/{file}` | `200` with the bytes and `X-Kition-Version`; `404` |
| `PUT /files/{file}` with `If-Match: <version>` | `200 {"version": "<new>"}`; `409` with `X-Kition-Version` when the file moved on or `X-Kition-Doc-Key` is not its generation |
| `GET /files/{file}/replica` | `200` with the stored replica and `X-Kition-File-Stamp`; `404` none; `501` not kept |
| `PUT /files/{file}/replica` with `X-Kition-File-Stamp` | `200`; `501` not kept |

Every request carries `X-Kition-Timestamp`, `X-Kition-Subject` (the token's
`sub`), `X-Kition-Doc-Key`, and `X-Kition-Signature: v1=<hex>`, the
HMAC-SHA256 with your callback secret of

```text
METHOD "\n" path-and-query "\n" timestamp "\n" hex(SHA-256(body))
```

Verify it before anything else, and refuse a timestamp more than 300 s off:

```ts
import { verifyCallback } from '@kition/embed-server/callbacks'
if (!verifyCallback(secret, { method: req.method, path: req.url, headers: req.headers, body })) return res.writeHead(401).end()
```

Versions are yours (opaque strings that change on every write). Never accept
a write without checking `If-Match` against the current version: that is what
keeps two open tabs, or a stale one, from writing over each other.

## 4. Hear the editor

The page posts `{ kitionDocument: 1, event: 'ready' }` and
`{ kitionDocument: 1, event: 'saved', version }` to its parent.

## Security notes

- The embed server keeps no document: every read and write is a callback to you.
- The page's content security policy allows only the embed server's scripts, only
  `kitsUrl` frames, and only your `origins` as framers.
- Display permissions (`download`, `export`, `share`, `watermark`) are what
  the editor shows; they do not stop a person who can read a document from
  copying it.
