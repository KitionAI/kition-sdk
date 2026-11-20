# The gateway's editor page

`kition gateway --workspace <folder>` ([cli.md](cli.md#the-gateway)) serves an editor page: one
workspace file in its kit's own editor, the Kit AI bridge's window for that file (so an agent's
`kit_*` calls, through a relayed `kition mcp`, run in the open editor's engine, live and in its
history), and the person's review of the agent's drafts. This page is what a host frames: a
DeepSeek Harness tab, a desktop shell, a browser tab. This document is the contract between the
page, the gateway and the host: addresses, credentials, the `postMessage` protocol, and what a
proxy in front must do.

The page is `packages/gateway-page` (`@kition/gateway-page`), built into the `kition` binary. Its
module exports the protocol's types and `gatewayPageAddress()` for hosts.

## Addresses

Everything is relative to the gateway's root, `<root>`: `http://127.0.0.1:<port>/` opened directly,
or the prefix a same-origin proxy serves the gateway under (`https://host.example/kition/`). The
page addresses everything relative to itself (it finds `<root>` as the path before its `page/`), so
any prefix works.

| Address | What |
| --- | --- |
| `<root>page/?path=<file>[&theme=light\|dark][&locale=en\|zh]` | the editor of the workspace file `<file>` (workspace-relative, `/`-separated) |
| `<root>page/review?path=<file>[&theme=…][&locale=…]` | the review of the agent's draft of `<file>` |
| `<root>kits-ui/<kit>@<version>/<file>` | a kit's editor package (the page frames `index.html`) |
| `<root>kit-files/<path>` | workspace files as kits read them |
| `<root>api/v1/...` | the gateway's API ([cli.md](cli.md#the-gateway)) |

The kit is chosen by the file's extension among the kits the gateway serves and those its kit index
offers: a kit that edits the extension wins over one that only views it (`.html` and `.htm` go to
the HTML kit, not to Doc). The editor package is the version of the kit in use (else the newest the
index offers); when it is not installed the page installs it and shows the download's progress.

The page shows a state instead of the editor when it cannot open the file, and tells the host
(`state`, below): `no-kit` (no kit opens the type), `downloading` (with `progress`),
`not-installed` (the index offers no editor package for that version, or its download failed),
`missing` (no such file), `unreachable` (the gateway does not answer, or the page's session ended),
`failed` (the kit could not open the file; `detail` says why). Each but `no-kit` offers to try again.

Below 480 CSS pixels wide the editor opens in its Focus display mode (its toolbars clip otherwise).

## Credentials

The gateway answers nothing without a credential (`GET /health` aside), and refuses any request
whose `Host` is not loopback or whose `Origin` is another origin than the `Host`'s.

**Behind a proxy (the primary deployment).** The browser holds nothing: the host's proxy adds the
gateway's token (from the gateway's lockfile, `KITION_HOME/run/<key>.json`) to every request it
forwards, the page's, the editor frame's and their workers' and fonts' alike, so every sub-resource
is authorised without a header from the browser. The page sends no credential.

**Opened directly (development, a local browser).** `kition gateway --open [<file>]` (stderr) and
`kition gateway url --workspace <folder> [<file>] [--review]` (stdout) print an address:

```text
http://127.0.0.1:<port>/_signed/<expires>.<length>.<signature>/page/?path=<file>#bootstrap=<signed path>
```

- The path is a signed URL of `/page/` (HMAC-SHA-256 with the token, good for 12 hours), so the
  page, its script and its style load without a header. It reaches nothing but `/page/`.
- The fragment's `bootstrap` is a signed URL of `/api/v1/gateway/page-session/<nonce>` good for two
  minutes and **once**: the page trades it for a page session (256 random bits, 12 hours, ended
  when the gateway stops), keeps it in the tab's `sessionStorage` (never a cookie) and removes the
  fragment from the address bar. A fragment is never sent to a server, so neither credential is in
  any request line, proxy log or server log; the address left in the history or the terminal opens
  nothing once spent (a second tab given it shows `unreachable`).
- The page sends its session in `Kition-Token`. A session reaches the kits' API, the files, the
  bridge and the editor packages, but not `/api/v1/gateway` or the agents' `POST /api/v1/mcp/kits`,
  which need the token itself.
- A frame and a worker cannot send a header: the page asks `POST /api/v1/gateway/sign` for a signed
  URL of the kit's package folder (`/kits-ui/<kit>@<version>/`) and of the workspace root its
  engine reads linked files from (`/kit-files/`), and loads the frame from there; every relative
  sub-resource is then under the signed folder. These signed URLs are the same for every request in
  a six-hour window, so the browser's cache keeps the package between page loads.

## Caching

`/kits-ui/<kit>@<version>/…` is `Cache-Control: public, max-age=31536000, immutable` with an `ETag`
(the files' names carry no content hash: the version in the path is the cache key; a version is
published once). A development build (`--kit-ui`) is `no-cache`. `/page/…` is `no-cache` with an
`ETag` of its content. The gateway compresses nothing; a proxy may. `application/wasm`, JavaScript
modules and workers as `text/javascript`, fonts as `font/*`, everything `nosniff`.

## The proxy

A host that frames the page puts a same-origin reverse proxy in front of the gateway, under a prefix
of its own (`/kition/`). `examples/gateway-page/proxy.mjs` is a working one in 20 lines. It must:

1. **Authenticate the browser itself** (the host's own login or session check) before forwarding
   anything: the gateway trusts every request that carries the token, and the proxy adds it.
2. **Forward** `<prefix><rest>` to `http://127.0.0.1:<port>/<rest>`: method, path and query as they
   are, the body streamed. `Host` must be the gateway's (`127.0.0.1:<port>`; the gateway refuses
   any other host).
3. **Add** `Kition-Token: <token>` (from the lockfile; read it again when the gateway restarts:
   the token is new for every start).
4. **Drop** `Origin` (the gateway refuses an `Origin` that is not its own address, and a page under
   the host's origin is not), `Cookie` (the host's session must never reach the gateway), and
   `Referer`. Drop or ignore any `Kition-Token` the browser sent.
5. **Stream answers without buffering**: `GET /api/v1/kits/bridge` is a server-sent event stream
   that stays open; send its headers at once (`flushHeaders`) and pass each event as it comes.
   Large `PUT` bodies (saves up to 2 GiB, replicas) and ranged `GET`s (`Range`, `206`) pass through
   as they are; keep `ETag`, `Cache-Control`, `Content-Range`, `Content-Type` and
   `X-Content-Type-Options` of the answers.
6. Not rewrite paths inside answers: everything the page and the editors address is relative.

The page's HTML carries `Content-Security-Policy: default-src 'self'; … frame-ancestors 'self'`,
so the window that frames it must be on the same origin as the proxy (as a same-origin proxy is).

## The `postMessage` protocol

When framed, the page talks to `window.parent` only; standalone it posts nothing and works alone.
Every message either way is an object `{ kitionGatewayPage: 1, type, ... }`. The page posts with its
own origin as the target and takes messages only from `window.parent` on its own origin (on a
browser that names its origin `null`, an opaque one, it posts with `*` and checks the source only).

The page tells the host:

| `type` | Fields | When |
| --- | --- | --- |
| `ready` | `view` (`editor`, `review`), `path` (`null` without a valid one) | once, when it listens |
| `state` | `path`, `title` (the file's name), `kit` (its id or `null`), `status` (see [Addresses](#addresses): `opening`, `downloading`, `open`, `missing`, `no-kit`, `not-installed`, `unreachable`, `failed`), `dirty`, `progress?` `{done, total}`, `detail?` | every change: opening, the download, each edit (`dirty`) |
| `shortcut` | `key` `{key, code, meta?, ctrl?, shift?, alt?}` | a host shortcut pressed in the editor (Cmd+N, Cmd+O, Cmd+W, Cmd+T, Cmd+,, Cmd+Q, Cmd+P, Cmd+.); the editor keeps every other key, Cmd+S included |
| `request-close` | `path`, `dirty` | the person pressed Cmd+W (Ctrl+W) in the editor: close the tab, asking first when `dirty` |
| `draft` | `path`, `draft` (`null`, or `{state: 'open'\|'ready', stale, updated}`) | the agent's headless draft of the file appeared, changed, became ready, or went |
| `reviewed` | `path`, `outcome` (`merged`, `discarded`) | the person merged or discarded the draft in the page |
| `saved` | `path`, `saved`, `error?` | the answer to `save` |

The host tells the page:

| `type` | Fields | Does |
| --- | --- | --- |
| `theme` | `theme` (`light`, `dark`) | shows that scheme, the editor's included |
| `locale` | `locale` (`en`, `zh`) | shows that language, the editor's included |
| `save` | | saves the file now; answers `saved` |
| `focus` | | gives the editor the keyboard focus |

The draft banner ("An agent drafted changes to this file — Review") opens the review over the
editor; Merge and Discard there are the person's only, never the agent's (decision R9: an agent's
draft is always a headless draft, even when the file is open). After a merge the editor takes the
merged file. A merge refused as `stale` (the file changed since the draft forked) says so and offers
"Merge and overwrite" instead. With unsaved edits in the editor, Merge is refused until they are
saved.

Leaving the page with unsaved edits asks first (`beforeunload`). A host that closes the frame
itself should ask the page to `save`, or ask the person, when the last `state` said `dirty`.

## Tests

`pnpm test:gateway:e2e` (`examples/gateway-page/`) runs the page with real kits (Table and Note
from the kit index's release assets), a real `kition gateway` and a real relayed `kition mcp`,
directly and behind `proxy.mjs`; `pnpm test:gateway:smoke` opens every kit's editor and records the
times and console errors per kit.
