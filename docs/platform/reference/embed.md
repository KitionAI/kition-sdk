# Embedding kit editors (`@kition/embed`)

| | |
| --- | --- |
| Package | `@kition/embed` 0.5.2, in the Kition SDK 0.5.2 ([getting the SDK](../getting-the-sdk.md)) |
| Capability set | [`KitEmbed 1.3`](../sets/embed.md), with EM25's opening (1.5), EM28 (1.6), EM29 and EM30 (1.7), and EM31 (1.8); every member a minor version added is optional, so an older page works unchanged |
| Protocols | [Kit UI protocol](ui-protocol.md) `kition-kit-ui/1` to the kit |
| License | Apache-2.0 |

`@kition/embed` puts a kit's editor (Slide, Sheet, and every other kit with
an embedded UI) into any web page. The page keeps its documents in its own
storage and names its own users; the embed shows the kit's editor in an
iframe served from the kit package's origin, feeds it the document, and saves
it back through the page's `StorageProvider`. One editor edits a document;
the embed does not co-edit.

It is framework-free (no React) and bundles `@kition/kit-host` and
`@kition/kit-ui-protocol`.

The package comes with the Kition SDK ([getting the SDK](../getting-the-sdk.md)) as
ESM with `.d.ts` typings.

## 1. Quick start

Mount Slide for one of the page's files, single-user:

```ts
import { EmbedConflictError, KitionEmbed, type StorageProvider } from '@kition/embed'

const storage: StorageProvider = {
  read: async (fileId) => {
    const response = await fetch(`/api/files/${fileId}`)
    return { bytes: await response.arrayBuffer(), version: response.headers.get('etag')! }
  },
  stamp: async (fileId) => {
    const response = await fetch(`/api/files/${fileId}`, { method: 'HEAD' })
    return response.ok ? response.headers.get('etag') : null
  },
  write: async (fileId, bytes, { expectedVersion }) => {
    const response = await fetch(`/api/files/${fileId}`, {
      method: 'PUT',
      body: bytes,
      headers: expectedVersion ? { 'if-match': expectedVersion } : {},
    })
    if (response.status === 412) throw new EmbedConflictError(fileId)
    return { version: response.headers.get('etag')! }
  },
}

const editor = await KitionEmbed.mount(document.querySelector('#editor')!, {
  kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui/' },
  file: { id: 'f_123', name: 'Launch.md' },
  storage,
  locale: 'en-US',
  theme: { colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' } },
})
editor.on('changed', ({ dirty, title }) => (document.title = `${dirty ? '* ' : ''}${title}`))
editor.on('saved', ({ version }) => console.log('saved as', version))
await editor.ready()
```

The element is filled by the editor's frame; give it a size. The person
saves with the kit's own Save, or the page calls `editor.save()`.

`KitEmbed 1.1` lets the page name its people, decide what each may do, shape
the editor, and script the document in one call:

```ts
import { noteKit, type Note } from '@kition/script/kits/note'

const editor = await KitionEmbed.mount(element, {
  kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui/' },
  file: { id: 'f_123' }, // named by storage.info
  storage: { ...storage, info: (fileId) => fetchFileInfo(fileId) },
  identity: {
    user: () => ({ id: 'u_42', name: 'Alice' }),
    users: (ids) => directory.lookup(ids), // names and avatars for comment authors
    permissions: (fileId) => acl.modeFor(fileId), // { mode: 'edit' | 'comment' | 'view' }
  },
  ui: {
    disable: ['command:file.export.*'],
    add: [{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' }, icon: 'send' }],
    panels: ['comments'],
  },
})
editor.on('action', ({ id }) => id === 'submit' && submitForReview())
editor.on('comments', (threads) => renderSidebar(threads))
await editor.ready()
const doc = await editor.document<Note>(noteKit)
```

## 2. API reference

Every name below is exported from `@kition/embed`. Types are exported with
`export type *`.

### `KitionEmbed.mount(element, options): Promise<EmbedEditor>`

Creates the kit's frame in `element` and starts opening the document. The
promise resolves as soon as the editor exists; `editor.ready()` tells when
the kit shows the document. `mount` itself rejects when the kit URL is not
`http:` or `https:`.

### `EmbedOptions`

| Member | Type | Meaning |
| --- | --- | --- |
| `kit` | `EmbedKit` | The kit package to show |
| `file` | `EmbedFile` | The document |
| `storage` | `StorageProvider` | Where the page keeps documents |
| `identity` | `IdentityProvider`, optional | Who the person is, who others are, and what the person may do |
| `locale` | `string`, optional | A BCP 47 tag; the browser's language by default |
| `theme` | `EmbedTheme`, optional | Light with the default tokens by default |
| `permissions` | `EmbedPermissions`, optional | `{ mode: 'edit' }` by default. The stricter of it and `identity.permissions` applies |
| `ui` | `EmbedUi`, optional (1.1) | What the kit's editor shows and allows; everything by default |
| `timeoutMs` | `number`, optional | How long the kit may take to open the document; two minutes by default |
| `model` | `boolean`, optional | Lets the page edit the document through the object model (`editor.modelPort()`, `@kition/script`): the kit keeps a replica, in memory when `storage` has no `replica` store |
| `shortcuts` | `string[]`, optional (1.6) | The page's own shortcuts, as `Cmd+S`: the kit forwards them instead of handling them, heard as the `shortcut` event (EM28). Listing `Cmd+S` leaves saving to the page (`editor.save()`). None by default |
| `services` | `EmbedServices`, optional (1.7) | The page's host services by id (Kit UI protocol section 7k, `KitEmbed 1.7` EM29): `{ 'people.mention': ({ query, limit }) => ({ people }), 'comment.create': ({ anchor, text }) => ({ thread }), … }`. Each is offered to the kit only when the document's permissions allow it (UI-V4); params arrive checked. Refuse by throwing an error with a `reason` of `SERVICE_ERROR_REASONS`; any other error answers `failed` |
| `comments` | `{ activated(threadId: string): void }`, optional (1.7) | The page keeps comment threads itself and the kit anchors them (capability `comment-anchors`, EM30): a new thread arrives as `comment.create` (`services`), `editor.comments.show` marks them, and `activated` hears the person click a marker |

- **`EmbedKit`** `{ id, url, entry? }`: `id` is the kit's id (`kit.json`
  `id`, for example `kit.note`); `url` the kit package's base URL
  (`https://kits.example.com/note-ui/`), whose origin becomes the editor's
  (a relative URL resolves against the page); `entry` the UI entry inside the
  package, `index.html` by default. A frame that turns out to hold another
  kit fails `ready()`.
- **`EmbedFile`** `{ id, name? }`: the page's id for the document, and the
  file name the kit sees. The kit picks the format from the name's extension.
  Without `name` (1.1), `storage.info(id)` names the file before the kit
  opens; `mount` rejects when there is neither.
- **`EmbedTheme`** `{ colorScheme: 'light' | 'dark', tokens?, brand? }`:
  `tokens` are the `--kit-*` custom properties to change ([UI protocol
  section 4](ui-protocol.md)); every other token keeps its default for the
  scheme. `brand` is the protocol's `'kit' | 'host'`.
- **`EmbedPermissions`** `{ mode: 'edit' | 'comment' | 'view' }`: `view`
  opens the document read-only: the kit refuses edits on screen and offers no
  Save, and the embed refuses any write. `comment` (1.1) opens it read-only
  for its content too, while the person still writes comment threads (UI
  protocol `document.comments.canComment`, [`KitModel 1.0`](../sets/model.md) rule M23); the kit
  runs only its comment commands, and nothing is saved.
- **`EmbedUi`** (1.1) is the UI protocol's configuration (section 9) and
  two shorthands, sent with `ui/initialize` and, after
  `editor.configure(ui)`, with `ui/configure`:
  - `hide`, `disable`, `add`, `personal`: as the protocol defines them.
    `hide` and `disable` refuse a command on every path; `add` places the
    page's own buttons (pressed: the `action` event).
  - `toolbar: 'none'` hides the ribbon tabs (`tab:*`); `'full'`, the
    default, hides nothing.
  - `panels: string[]`: the only panels to show, by `panel:` id or name
    (`comments`); once the kit has opened, the embed lists its elements
    (`ui/elements`) and hides its other panels.
  - `customize(personal)`: with it, the kit offers "Customize interface…"
    (capability `customize`) and the person's own hides reach the page as
    `{ hide }` (also the `customize` event). The page keeps them and passes
    them back as `personal` on later mounts; the editor passes the latest
    ones to a kit it opens again.

### `StorageProvider`

Versions are opaque, non-empty strings that change on every write. The editor
passes back the version it last saw, so a write over someone else's is
refused rather than lost.

| Member | Signature | Meaning |
| --- | --- | --- |
| `read` | `(fileId) => Promise<{ bytes: ArrayBuffer \| Uint8Array; version: string }>` | The file and its version |
| `stamp` | `(fileId) => Promise<string \| null>` | The file's current version without its bytes (a cheap change check); `null` when it is gone. Optional (1.1) when `info` is given, whose `version` answers it |
| `info` | optional (1.1), `(fileId) => Promise<{ name; version; size?; mime? } \| null>` | The file without its bytes: names a file given without `name`, and answers stamps without `stamp`. `null` when it is gone |
| `write` | `(fileId, bytes: Uint8Array, { expectedVersion: string \| null }) => Promise<{ version: string }>` | Replaces the file. MUST throw `EmbedConflictError` when the file's version is no longer `expectedVersion` |
| `create` | optional, `(name, bytes: Uint8Array) => Promise<{ fileId; name?; version? }>` | Makes a new file: a kit's export or saved copy. Without it, the kit's exports are refused |
| `replica` | optional, `ReplicaStore` | Keeps the document's replica next to its file |
| `blob` | optional (1.1), `BlobStore` | Keeps the replica's blobs by hash, instead of inside the stored replica |
| `lend` | optional (1.1), `(fileId) => string \| URL \| null \| Promise<…>` | The URL the files the document links (media, linked pictures, fonts) are read from in ranges |
| `resolveLink` | optional (1.5), `(fromFileId, link: { path?; name?; docId? }) => Promise<{ fileId; name; kitId; version; path } \| null>` | The file a link in the document names, as the page resolves it (`path` relative to the linking file); `null` when it names none. With `open`, the kit offers opening linked files (capability `open-file`) |
| `open` | optional (1.5), `(fileId, view?) => Promise<{ opened: boolean }>` | Opens the file in the page's own UI, at `view` when given (OP2, OP3); `opened: false` when the person cancelled. A link `resolveLink` answers `null` for is refused as `not-found`; `create` (OP4) is not served |
| `openUrl` | optional (1.5), `(url) => Promise<{ opened: boolean }>` | Opens a web address in the system's browser or mail client after the page showed the person the full address and they confirmed (OP8); `opened: false` when they declined. Offered as capability `open-url` |

- **Opening (1.5, EM25).** The embed calls `resolveLink` and `open`, or
  `openUrl`, only for a request the kit sent from a person's gesture (the
  page's transient user activation; OP1, OP6), refusing it otherwise as
  `no-gesture`, and passes `openUrl` only `https:`, `http:`, and `mailto:`
  addresses, refusing others as `not-allowed` (OP7). Both work in a
  read-only document (OP5). The page shows the confirmation of OP8 and tells
  the kit nothing but `opened` (OP9).
- **Conflicts.** When `write` throws `EmbedConflictError`, the embed answers
  the kit's save with the protocol's `conflict` reason, and the kit shows its
  "changed elsewhere" flow. Any other error fails the save as is.
- **One save at a time.** The editor's saves reach `write` one after another:
  a save made while another is still being written (the page's
  `editor.save()` while the kit's own Save is written) waits for it, then goes over the version it wrote, never the one both started
  from. A save of the very bytes the last save wrote, over the version it
  wrote, is not written again: the editor checks `stamp` (or `info`) and
  answers that version while the file is still at it, and writes (so the
  storage refuses it as a conflict) when the file changed elsewhere since.
  The storage never needs to accept a stale write of identical bytes.
- **Paths.** The kit sees one file, its document, under `file.name`. It
  reads, stamps, and saves only that; reads of any other path are refused and
  stamps of other paths answer `null`. What the kit writes under another name
  (an export, a new file) becomes `storage.create(name, bytes)`, with the last
  segment of the kit's path as `name`.
- **`ReplicaStore`** `{ read(fileId): Promise<StoredReplica | null>,
  write(fileId, replica): Promise<void> }`, where `StoredReplica` is the UI
  protocol's `{ snapshot, blobs, fileStamp }` (its section 7). An editor
  needs none; with one, the kit keeps the document's identity, history and
  checkpoints across saves.
- **`BlobStore`** (1.1) `{ read(hash): Promise<ArrayBuffer | Uint8Array |
  null>, write(hash, bytes: Uint8Array): Promise<void> }`, by lowercase hex
  SHA-256. A replica's blobs (pictures, media) are then written there, each
  once per editor, and the stored replica (in `storage.replica`, or this
  browser's IndexedDB) keeps only their hashes; reading it fills them in
  again, leaving out a blob the store lacks or answers with other bytes (the
  embed checks the hash where the page has Web Crypto). A replica stored
  before the page had a blob store reads as it was.
- **`lend`** (1.1) answers an http(s) URL; the kit gets it as the UI
  protocol's `document.lend` (`{ root: <url>/, folder: '' }`) and its engine
  reads `<url>/<path>` (paths the document names, relative to its folder,
  never above the root) with synchronous `HEAD` and ranged `GET` requests
  from its worker, on the kit's origin. The server answers CORS for the kit
  origin and serves `Range`; the kit origin's `connect-src` lists the URL's
  origin. Without `lend`, the kit is lent no files.
### `IdentityProvider`

Every member is optional.

| Member | Signature | Meaning |
| --- | --- | --- |
| `user` | `() => EmbedUser \| Promise<EmbedUser>` | The person, `{ id, name, avatar? }` (the architecture's `currentUser`): the author of their comments (`document.comments.me`, `name`) |
| `users` | optional (1.1), `(ids: string[]) => EmbedUser[] \| Promise<EmbedUser[]>` | Other people by id, for names and avatars of comment authors. Answers the ones it knows; each id is asked for once per editor |
| `permissions` | optional (1.1), `(fileId) => { mode } \| Promise<{ mode }>` | What the person may do with the file (`edit`, `comment`, or `view`), asked for each time the editor opens it; the stricter of it and the `permissions` option applies |

With an identity (or in `comment` mode) the kit is told who comments
(`document.comments`): `me` is `user().id`, `name` its name, `canComment`
false only in `view` mode, and `othersReadOnly` true (the
threads others wrote are read-only history, [`KitModel 1.0`](../sets/model.md) rule M23).

### `EmbedEditor`

| Member | Meaning |
| --- | --- |
| `ready(): Promise<void>` | Resolves when the kit has rendered the document; rejects when it could not open it |
| `save(): Promise<{ saved: boolean; version: string \| null }>` | Saves as the kit's own Save does; `saved` is false when there was nothing to write |
| `on(event, listener): () => void` | Listens to an event (below); returns a function that stops listening |
| `setTheme(theme: EmbedTheme): void` | Changes the theme; a change made while the kit opens is sent once it has |
| `setLocale(locale: string): void` | Changes the language, likewise |
| `modelPort(): EmbedModelPort` | The document for the object model: `openDocument(editor)` of `@kition/script` calls it ([object-model.md](object-model.md)). Needs a replica: mount with `model: true` (kept in memory) or `storage.replica` |
| `document<Root>(kit, { origin? }?): Promise<ModelDocument<Root>>` | (1.1) `@kition/script`'s `openDocument` over `modelPort()` in one call, the object model bundled in this package (loaded on the first call). `kit` is the kit's typings (`noteKit` from `@kition/script/kits/note`, whose types give `Root`); typings of another kit are refused. Needs a replica, as `modelPort` does |
| `configure(ui: EmbedUi): void` | (1.1) Replaces the `ui` option |
| `mode: 'edit' \| 'comment' \| 'view'` | (1.1) What the person may do now: the stricter of the `permissions` option and `identity.permissions` |
| `commands.list(query?): Promise<EmbedCommand[]>` | The kit's commands, through its Kit AI bridge (`ai/commands`): `{ id, title, description?, enabled, schema? }` |
| `commands.run(id, params?, { save?, origin?, originLabel? }?)` | Runs one command (`ai/run`); resolves to `{ command, changed, result }`. With `save: true` the kit saves afterwards. Without `origin` the command is the agent's step. (1.8, EM31) With `origin: 'system'` it is the page's own change on the person's behalf (a sync feature writing into the open document), as Kit Process Protocol's `command.execute` with origin `system` on a closed one: no undo step in any history (neither the person's Undo nor the agent's takes it back), recorded under the KDM `system` origin with `originLabel`, the page's feature (`emailsync`: 1 to 64 letters, digits, `.`, `_`, `-`; `host` when absent). The editor's status line says the app edited the document, and `changed` says `by: 'system'`. Rejects with the kit's error: `-32602` for a malformed `originLabel`, reason `unsupported` from a kit whose engine cannot keep a change out of its undo history (nothing changes), and reason `invalid-params` with `data.errors` (`[{ path, message, expected? }]`) when the kit's engine refused the parameters, the message its text alone |
| `replicaVersion(): Promise<Uint8Array \| null>` | The document's replica version (its KDM version's bytes), or `null` when the kit keeps no replica (an editor without `model` or `storage.replica`). Equal versions are equal bytes and name one state |
| `check({ draft? }?): Promise<KitDiagnostic[]>` | The kit's diagnostics on the open document, or on the agent's draft with `draft: true` (`KitEmbed 1.2`, EM13; 1.3, EM16; A21), errors first; none from a kit that does not check |
| `draft` | (1.3) Reviewing the agent's draft: `state`, `compare`, `merge`, `discard` ([below](#drafts-and-agents-kitembed-13)) |
| `agentPort(options?): AgentPort` | (1.3) An MCP server over this editor for the page's agent ([below](#drafts-and-agents-kitembed-13)) |
| `comments.show(threads): void` | (1.7) With the `comments` option: the threads the kit marks, the whole list each time, `[{ id, anchor, resolved, count }]` (EM30); sent again to a kit opened again. Ignored by a kit without `comment-anchors` |
| `comments.locate(anchors): Promise<boolean[]>` | (1.7) Whether the kit finds each anchor now; all `false` from a kit without `comment-anchors` |
| `destroy(): void` | Closes the editor and its frame. Unsaved edits are dropped |

`commands` is the quick automation surface; the object model (`document`,
`modelPort`) and the agent port (`agentPort`, below) are the full ones.

### Events

| Event | Value | When |
| --- | --- | --- |
| `saved` | `{ version }` | The document was written to the storage |
| `changed` | `{ dirty, revision, title, by: 'person' \| 'agent' \| 'system', originLabel? }` | The document changed: an edit, an undo, a save. (1.8) `by: 'system'` is the page's own change (`commands.run` with `origin: 'system'`), with the `originLabel` it ran under |
| `error` | `Error` | Something failed after the editor opened: the kit reopening |
| `conflict` | `EmbedConflictError` | A save was refused: the file changed elsewhere since the editor read it (the storage's `write` threw `EmbedConflictError`); nothing was overwritten |
| `notify` | `{ level: 'info' \| 'success' \| 'warning' \| 'error'; message; description? }` | A message the kit asks the page to show (UI protocol `host/notify`) |
| `newerKit` | `{ reads, newestAuthor }` | A newer version of the kit edited the document (UI protocol `document/schema`, `KitModel 1.0` M5a): the editor keeps working; tell the person and offer the newer kit |
| `comments` | `EmbedCommentThread[]` (1.1) | The document's comment threads, oldest first, whenever they change, and first when a listener is added: `{ id, anchor, resolved, comments: [{ id, author, name?, body, created, user? }] }`, `user` as `identity.users` names the author. Read from the kit's replica (the reserved `CommentThread` and `Comment` objects, `KitModel 1.0` M23), so heard only from an editor that keeps one (`model` or `storage.replica`) |
| `draft` | `{ state: 'none' \| 'open' \| 'ready'; revision }` (1.1) | The agent's draft opened, changed, became ready, or closed (UI protocol `draft/changed`) |
| `action` | `{ id, document: { path, dirty, revision } }` (1.1) | One of the page's own buttons (`ui.add`) was pressed (UI protocol `ui/action`) |
| `customize` | `{ hide: string[] }` (1.1) | The person changed what they hide (with `ui.customize`) |
| `shortcut` | `{ key, code, meta, ctrl, shift, alt }` (1.6) | One of the page's `shortcuts` was pressed in the kit (UI protocol `host/shortcut`) |

A listener that throws is logged and does not stop the others.

### Errors

- **`EmbedError`** extends `Error`, with `code`:
  - `conflict`: see `EmbedConflictError`.
- **`EmbedConflictError`** extends `EmbedError` (`code` `conflict`), with
  `fileId` and optional `currentVersion`. The page's `StorageProvider.write`
  throws it: `new EmbedConflictError(fileId, currentVersion?)`.

Other failures are plain `Error`s: from `ready()` before the document shows,
as `error` events after.

### Constants

| Name | Value |
| --- | --- |
| `FRAME_SANDBOX` | `allow-scripts allow-same-origin allow-forms allow-downloads allow-popups` |
| `FRAME_ALLOW` | `clipboard-read; clipboard-write; fullscreen` |
| `EMBED_VERSION` | `0.5.2`, as hosts are told it |
| `EMBED_CAPABILITY_SETS` | `['KitModel 1.0', 'KitObjectModel 1.0', 'KitEmbed 1.3']`, sent to the kit as `capabilitySets` (what the kit relies on from its host) |

### Drafts and agents (`KitEmbed 1.3`)

Types used below: `KitDiagnostic` is a diagnostic of [A21](../sets/agent.md#5-verify)
(`{ code, severity, target, message, fix? }`); a draft comparison's `summary`
counts the objects of [A13](../sets/agent.md#6-recover) (`created`, `changed`, `deleted`,
`texts`); `JsonRpcMessage` is one JSON-RPC 2.0 message of MCP; `AgentTool` is
an MCP tool definition (`name`, `description`, `inputSchema`).

```ts
type EmbedKit = { id: string; url: string; entry?: string; schema?: object }   // schema: EM15

editor.check(options?: { draft?: boolean }): Promise<KitDiagnostic[]>         // EM16

editor.draft: {                                                                // EM17
  state(): Promise<DraftInfo>            // { state: 'none' | 'open' | 'ready', revision: number | null }
  compare(options?: { maxSize?: number }): Promise<{
    summary: { created; changed; moved; deleted; texts }, before: string | null, after: string | null }>
  merge(options?: { label?: string }): Promise<{ merged: boolean; summary }>
  discard(): Promise<DraftInfo>
}
// EmbedError codes: 'unsupported' (no drafts in this kit), 'read-only', 'no-draft'

editor.agentPort(options?: { draft?: boolean; principal?: string; label?: string }): AgentPort  // EM18
// path: the open file's name (file.name); principal: defaults to identity.user().id (A11)
type AgentPort = {
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null>   // initialize, ping, tools/list, tools/call
  tools(): Promise<AgentTool[]>
  close(): void
}

// EM19
relayAgentPort(port: AgentPort,
  transport: { next(): Promise<JsonRpcMessage | null>; reply(message: JsonRpcMessage): Promise<void> },
  signal?: AbortSignal): Promise<void>                              // @kition/embed, in the page
createAgentRelay(): {                                               // @kition/script/node, on the server
  request(message, options?: { timeoutMs?: number }): Promise<JsonRpcMessage>
  next(options?: { waitMs?: number; signal?: AbortSignal }): Promise<JsonRpcMessage | null>
  reply(message): Promise<void>
  connected(staleMs?: number): boolean
  close(): void
}
```

An agent port's tools are those of `kition-kits-mcp`, for the open document only, with the same
arguments, results (`content`, `structuredContent`, `isError`, image previews), and error codes
([`KitAgent 1.4`](../sets/agent.md) section 1); the prefix is the kit id without `kit.`.

## 3. Hosting kit packages

A kit package is the kit's editor, its engine (WebAssembly and its
JavaScript), and its fonts, all self-contained (UI protocol UI-K1). It is
released as `kition-<kit>-<version>.tgz`, which extracts to one folder:

```text
note-ui/
  index.html        the UI entry
  kit-ui.json       { kitId, version, commit, entry, protocol }
  kit.json          the kit's manifest, as in its repository (KHP K20)
  assets/           the editor's scripts, styles, and engine worker
  engine/           the engine: <module>.js and <module>_bg.wasm
  model/schema.json the KDM schema, for a kit that lists `model.schema` (K12)
  agent/            the kit's agent catalogues (K17, A38):
    checks.json       the check catalogue; required at Agent-ready
    commands.json     the agent-facing commands with input and output schemas
    guide.md          the guide for models; required at Agent-ready complete
  fonts/
  LICENSE
  NOTICE
```

`agent/` is copied from the kit repository's `agent/` unchanged; a kit
without one ships none, and a kit at Agent-ready or above MUST ship
`agent/checks.json` ([manifest](../kits/manifest.md) K17). The files are
described with K17.

Extract the packages under one base URL on **an origin of their own**, not
the page's (for example `https://kits.example.com/note-ui/`), and pass that
folder's URL as `kit.url`. `kit-ui.json` names the entry and the kit id to
pass as `kit.id`. A kit package loads nothing from any other origin.

Serve `.wasm` as `application/wasm`, and every file of the kit origin with a
content security policy that allows the kit's own scripts, workers, and
WebAssembly and nothing from other origins (UI-H3), and that lets only the
page frame it. The example's kit origin sends:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data: blob:; connect-src 'self' data: blob:; media-src 'self' data: blob:;
  object-src 'none'; base-uri 'self'; frame-ancestors https://app.example.com
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: cross-origin
```

`frame-ancestors` names the page's origin (or origins). Do not send
`X-Frame-Options: DENY` or `SAMEORIGIN` from the kit origin. A kit fetches
only from its own origin, so its frame needs no CORS; the example also sends
`Access-Control-Allow-Origin: *` only because its packages are public.

The page's own policy lets the kit origin into frames:

```text
Content-Security-Policy: default-src 'self'; script-src 'self';
  frame-src https://kits.example.com; object-src 'none'; base-uri 'self'
```

- `frame-src`: the kit origin.

## 4. Security model

- **The frame.** The kit runs in an `<iframe>` from the kit package's origin
  with `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads
  allow-popups"` and `allow="clipboard-read; clipboard-write; fullscreen"`.
  `allow-same-origin` gives the kit its own origin (its worker, its storage);
  that is safe only because that origin is not the page's. Never serve kit
  packages from the page's origin. `allow-forms` (1.1) lets the kit's forms
  submit (kit-editor's comment composer is one); without
  `allow-top-navigation` they can only reach the frame itself.
  `KitEmbed 1.5` (EM4) drops `allow-downloads` and `allow-popups`, because
  kits never open windows or start downloads (UI-K8); this release still
  grants them, and the next one removes them.
- **The origin is pinned.** The Kit UI protocol's handshake answers only the
  frame's window and is posted to exactly the kit URL's origin, never `*`;
  after it, everything travels over a private `MessagePort`.
- **The storage stays in the page.** The storage provider and the
  identity stay in the page. The kit sees its document's
  bytes, its replica, and replica changes, and nothing else.
- **One document.** The kit cannot read, stamp, or overwrite any file but its
  document; its other writes only make new files, and only through
  `storage.create`.
- **No lost writes.** Every save carries the version the editor last saw;
  `EmbedConflictError` turns a write over a newer file into the kit's
  conflict flow.

## 5. Limits

- **The object model needs a replica.** `editor.document()` and
  `modelPort()` work on an editor that keeps one (`model: true` or
  `storage.replica`); `commands` works on every editor.
- **Lent files cross origins.** The kit reads lent files from its own
  origin, so their server must answer CORS and the kit origin's CSP must list
  it (section 3).
