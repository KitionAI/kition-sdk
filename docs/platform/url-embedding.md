# URL embedding: the embed server

The embed server embeds a single-user editor. Collaborative editing uses
Kition Server through the managed-collaboration interfaces.
The integrator's guide is [docs/sdk/url.md](../sdk/url.md).

## What it is

An integrator that cannot run `@kition/embed` in its own page (a CMS, a
low-code tool, a mail client's web view) puts a kit editor in an `<iframe>`
whose URL its server minted. The **embed server** serves that
editor page and reads and writes the document through the integrator's
HTTP callbacks. It keeps nothing of the document itself.

```text
integrator server ──signs ko1 open token──▶ iframe src = https://docs.example/v1/open?token=ko1…
browser ──GET /v1/open──▶ embed server ──verifies token──▶ editor page (@kition/embed)
editor page ──/v1/file (session)──▶ embed server ──HMAC-signed callback──▶ integrator server
```

Package `@kition/embed-server` (`packages/embed-server`): `createEmbedServer(config)`
answers a Node `http` request handler; `startEmbedServer` listens. The example
integration is `examples/url-embed`.

## Contract

- **D-U1 Token.** The URL carries a `ko1.` open token (managed-collab.md
  section 1) the integrator signs: `file`, `version`, `doc_key`, `perms`,
  `watermark`, `sub`, `name`, at most an hour. `aud` is the service's id; the
  service verifies it offline with `kition-open-token`'s rules
  (`@kition/sync/openToken`): keys `{ kid, publicKey, tenant, iss }` per
  integrator.
- **D-U2 Session.** `GET /v1/open?token=…` verifies the token once and answers
  the editor page with a **session**: an HMAC-signed bearer the service makes
  (`kds1.`), bound to the token's tenant, issuer, file, `doc_key`, version and
  permissions, living at most `sessionTtl` (default 8 h). The page sends it on
  every file call, so an edit outlives the short open token, and the open
  token itself never reaches the service again. The URL's token is single use
  in spirit: the page drops it from its address (`history.replaceState`).
- **D-U3 Callbacks.** Per integrator (`iss`), a `callbackUrl` and a shared
  `secret`. The service calls:
  - `HEAD {callbackUrl}/files/{file}`: `X-Kition-Version` and `X-Kition-Name`
    (the name's extension picks the kit), asked when the page opens and for
    the page's change checks;
  - `GET  {callbackUrl}/files/{file}`: the bytes; header `X-Kition-Version`;
  - `PUT  {callbackUrl}/files/{file}` with `If-Match: <version>`: the new
    bytes; answers `{ "version" }`, or `409` when the file moved on;
  - `GET`/`PUT {callbackUrl}/files/{file}/replica`: the document's stored
    replica (optional; `404` none, `501` not kept).
  Every call carries `X-Kition-Timestamp` (Unix seconds), `X-Kition-Subject`
  (the person), `X-Kition-Doc-Key`, and `X-Kition-Signature: v1=<hex>` =
  HMAC-SHA256(secret, `METHOD \n path \n timestamp \n hex(SHA-256(body))`).
  The integrator verifies it (`verifyCallback`) and refuses a timestamp more
  than 300 s off, and refuses a write whose `X-Kition-Doc-Key` is not the
  file's current generation.
- **D-U4 Permissions.** `perms.edit` opens the editor for editing; `comment`
  alone opens it for comments, which it saves into the document; with neither
  it opens view-only and the service refuses the session's writes (`403`); `download`, `export`, `share` and `watermark` reach the kit as
  display permissions (Kit UI `document.permissions`, `document.watermark`,
  through the embed's `display` option).
- **D-U5 Origins.** The page is on the service's origin; kits load from
  `kitsUrl`, which MUST be another origin (EM4): Kition's kit host, or the
  service's second listener (`kitsDir`, `kitsPort`). The page's content
  security policy allows scripts from the service only and frames from
  `kitsUrl` only; `frame-ancestors` lists the integrator's `origins`.
- **D-U6 No collaboration.** No sync server, no rooms; one editor per URL.
  Saves are the embed's conditional writes (`If-Match`), so two open tabs
  of one file conflict rather than overwrite.

## Scope

Collaborative URL embedding (Kition Server), file creation, exports to new
files (the session refuses `create`), and a hosted deployment.
