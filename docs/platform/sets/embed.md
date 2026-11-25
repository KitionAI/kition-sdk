# `KitEmbed 1.8`: a kit editor in any web page

For integrators who put a kit's editor into their own web page, with their own storage and users. The SDK package is `@kition/embed`.

`KitEmbed` is the host side of a kit editor embedded in a third-party page:
the page brings its storage and identity, the embed is the Kit UI protocol
([ui-protocol.md](../reference/ui-protocol.md)) host. The reference implementation is
`@kition/embed`, which serves `KitEmbed 1.3` and, of the later
versions, EM25's opening, EM28, EM29, EM30 and EM31; [the embed reference](../reference/embed.md)
documents it member by member, with every option, provider member, editor
member, and event and its TypeScript type. EM1 to EM5 are `KitEmbed 1.0`; `KitEmbed 1.1` adds EM7 to
EM12, `KitEmbed 1.2` adds EM13 and EM14, `KitEmbed 1.3` adds
EM15 to EM19, `KitEmbed 1.4` adds EM21 to EM24 (files, not yet
implemented), and `KitEmbed 1.5` adds EM25 to EM27 (links, previews, and
opening; of these only EM25's `open` and `openUrl` are implemented), and
`KitEmbed 1.6` adds EM28 (the page's shortcuts), and `KitEmbed 1.7` adds EM29
and EM30 (the page's services and comment threads the page keeps), and
`KitEmbed 1.8` adds EM31 (the page's own change through the open editor),
every new provider member and option optional, so an older page works
unchanged with a newer embed.

- **EM1** `mount(element, options)` returns an editor. `options`: `kit`
  (`id`, package base `url`, `entry`), `file` (`id`, `name`), `storage`,
  and optionally `identity`, `locale`,
  `theme`, `permissions` (`mode`: `edit`, `comment` (1.1, EM9), or `view`), `model`
  (keep a replica for the object model, EM2), `ui` (1.1, EM10), `shortcuts` (1.6, EM28),
  `services` (1.7, EM29), `comments` (1.7, EM30), `timeoutMs`.
- **EM2** The editor has `ready`, `save`, `on`, `setTheme`, `setLocale`,
  `command.list`, `commands.run`,
  `replicaVersion`, `modelPort` ([`KitObjectModel 1.0`](object-model.md), with the mount option
  `model`), and `destroy`, and emits `saved`, `changed`, `error`,
  `conflict` (a save refused because the file changed
  elsewhere), `notify`, and `shortcut` (1.6, EM28).
- **EM3** A storage provider has `read`, `stamp`, and `write` with an
  expected version, and optionally `create` and `replica`. A write
  over a version that moved on MUST be refused as a conflict and reach the
  kit as the reason `conflict`. An identity provider has `user`.
- **EM4** The kit runs in a frame from its package's origin, which MUST NOT
  be the page's, with the sandbox `allow-scripts allow-same-origin` (1.1:
  and `allow-forms`, so a kit's forms, such as a comment composer, submit);
  the handshake is bound to exactly that origin. 1.5: the frame MUST NOT
  have `allow-popups`, `allow-downloads`, or `allow-top-navigation`: a kit
  never opens windows or starts downloads itself (UI-K8); it opens files
  and web addresses through `host/open` and `host/openUrl` (EM25 to EM27)
  and writes files only through the storage (EM21 to EM24). Embeds before
  1.5 granted `allow-downloads allow-popups`; the reference implementation
  still does (`FRAME_SANDBOX`, [the embed reference](../reference/embed.md))
  until its next release. The integrator serves the package with the content security policy
  of UI-H3 ([Kit UI protocol](../reference/ui-protocol.md) section 6).
- **EM5** The identity and the storage stay in the page. The
  kit sees only its document (UI-H2, [Kit UI protocol](../reference/ui-protocol.md)
  section 6): other reads are refused, other writes
  only make new files, and view mode refuses saves. From 1.4 the kit reaches
  other files only through file handles the embed grants (EM21 to EM24).

- **EM7** (1.1) A storage provider MAY have `info(fileId)` answering `{
  name, version, size?, mime? }` or `null`; with it, `stamp` and the file's
  `name` are optional (`info` answers them). It MAY have a blob store,
  `blob.read(hash)` and `blob.write(hash, bytes)` by lowercase hex SHA-256:
  the replica's blobs are then kept there, and the stored replica keeps only
  their hashes; a blob read back MUST match its hash or be left out. It MAY
  have `lend(fileId)` answering a URL, sent to the kit as `document.lend` for
  ranged reads of the files the document links (E5,
  [engine contract](../kits/engine.md)).
- **EM8** (1.1) An identity provider's members are all optional.
  `users(ids)` names other people (`{ id, name, avatar? }`) for comment
  authors, each id
  asked for once per editor; `permissions(fileId)` answers `{ mode }`.
- **EM9** (1.1) A person's mode is `edit`, `comment`, or `view`: the
  stricter of the `permissions` option and `permissions(fileId)`. `comment` opens the document read-only
  with `document.comments.canComment` (rule M23); the kit is told who
  comments (`document.comments`) whenever the page names the person, with
  `othersReadOnly`.
- **EM10** (1.1) The `ui` option is the UI protocol's configuration
  ([Kit UI protocol](../reference/ui-protocol.md) section 9: `hide`, `disable`, `add`, `personal`) with `toolbar: 'none'`
  (hides `tab:*`), `panels` (the only panels shown, the others hidden from
  the kit's `ui/elements`), and `customize` (serves `host/customize` and hands
  the person's hides to the page); `editor.configure(ui)` replaces it with
  `ui/configure`.
- **EM11** (1.1) The editor also emits `comments` (the comment threads read
  from the kit's replica, authors named by `users`), `draft` (`draft/changed`),
  `action` (`ui/action`), and `customize`. It also has `configure`, `mode`, and `document(kit)`.
- **EM12** (1.1) `editor.document(kit)` opens the document as the object
  model ([`KitObjectModel 1.0`](object-model.md)) over `modelPort` in one call, with the kit's typings
  (its id and schema); typings of another kit are refused.

- **EM13** (1.2) `editor.check()` answers the kit's diagnostics on the open
  document (A21, through the Kit UI protocol's `document/check`), errors
  first; a kit that does not check answers none.
- **EM14** (1.2) Withdrawn: the embed is free and takes no licence key,
  so there is no `license` option, `editor.license()` or `license` event.

- **EM15** (1.3) `kit` MAY carry the kit's KDM `schema`. Draft comparison and
  merging need it; without it the embed reads the schema the kit package
  ships (`model/schema.json` next to its entry, which names the same kit),
  else loads the kit's typings, when first needed.
- **EM16** (1.3) `editor.check({ draft? })` checks the agent's draft instead
  of the document when `draft` is true.
- **EM17** (1.3) *Reviewing an agent's draft.* `editor.draft` lets the page's
  person review what an agent did (A12 to A14):
  - `state()` answers `{ state: 'none' | 'open' | 'ready', revision }`;
  - `compare({ maxSize? })` answers `{ summary: { created, changed,
    moved, deleted, texts }, before, after }` (A13; `before` and `after` are
    renderings, `null` where the kit does not render);
  - `merge({ label? })` answers `{ merged, summary }`, one undo step with the
    origin `{ kind: 'agent', principal, label? }` of the last agent port
    (A14);
  - `discard()` answers the new state.

  The `draft` event is unchanged. Failures are `EmbedError`s with the codes
  `unsupported` (the kit keeps no drafts), `read-only` (the person may not
  edit), and `no-draft`. A page MUST call `merge` and `discard` only on the
  person's explicit choice (A14).
- **EM18** (1.3) *An agent on the open editor.* `editor.agentPort({ draft?,
  principal?, label? })` answers an `AgentPort`: an MCP server over the open
  editor (`handle(message)` answers one JSON-RPC message, `tools()`,
  `close()`), serving `initialize` (server name `kition-embed`), `ping`,
  `tools/list`, and `tools/call` with the tools, arguments, results, and
  errors of [`KitAgent 1.4`](agent.md) section 1 for the open document only:
  `path` is the open file's `name` (the mount option `file.name`, such as
  `Review.pptx`), the one `enum` value of every tool's `path`; another
  `path` answers `not-open`. Writes go to the agent's draft unless
  `draft: false` is given to the port or to a call; there is no merge or
  discard tool; writes are refused as `read-only` when the person's mode is
  not `edit`. The agent's transactions carry the principal of the person who
  started it (A11): `principal` defaults to the identity provider's
  `user().id` (`'agent'` only without an identity provider). Other defaults:
  `draft: true`, `label: 'Agent'`. While co-editing, the embed publishes
  the agent in the person's presence (A20) while any agent port is open:
  `agent: { name, origin: 'agent' }`, `name` the port's `label`; it clears
  it when the last port closes.
- **EM19** (1.3) *Relaying the port.* `relayAgentPort(port, transport,
  signal?)` of `@kition/embed` carries an agent port's messages over the
  page's own transport (`next()` the next request or `null`, `reply(message)`)
  to the integrator's server, where `createAgentRelay()` of `@kition/script/node`
  offers `request(message, { timeoutMs? })`, `next({ waitMs?, signal? })`,
  `reply(message)`, `connected(staleMs?)`, and `close()`, so the integrator's
  agent reaches the person's open editor (A7):
  - one relay per agent port, that is per open editor;
  - the agent's MCP client calls `request`; the page's transport fetches
    requests with `next` (its `signal` aborted when the page's connection
    closes) and answers with `reply`; `connected(staleMs)` (default 30
    seconds) tells whether the page called `next` within that time;
  - the relay renumbers JSON-RPC ids, so several agents may share a port;
  - the integrator MUST bind each relay to the person's authenticated page
    session and document, and let only an agent that person started call
    `request`.

  HTTP long polling is the reference transport (a request endpoint for the
  agent, and `next` and `reply` endpoints for the page); a WebSocket carries
  `next` and `reply` the same way. Without a relay the agent works
  headless on the file, and the page sees its new version through `stamp`.

- **EM21** (1.4) *Picking files* ([`KitFiles 1.1`](files.md)). A storage
  provider MAY add `pick({ purpose, mode, accept, multiple, suggestedName })`
  answering `[{ fileId, name }]` (empty when the person cancels): the page
  shows its own picker (its file browser, its cloud drive). With it, the
  embed lists the Kit UI capability `files-pick` and answers `files/pick`
  with handles; without it, `files/pick` answers `unsupported` and the kit
  hides the features that need it.
- **EM22** (1.4) A storage provider MAY add `list(folderId)` answering
  `[{ fileId, name, version, size? }]`, for folder grants (`files/list`), and
  `print(bytes, title)` answering `{ printed }`, with which the embed lists
  the capability `print` and serves `files/print`.
- **EM23** (1.4) The embed mints the handles (FA1 to FA5) and keeps the map
  from handle to `fileId`: a page's `fileId`s never reach the kit, and the
  kit sees only display names. `files/create` still becomes
  `storage.create(name, bytes)`, called once with the whole file when the
  kit commits its staged writes (FA9); a `write` handle becomes
  `storage.write(fileId, bytes, { expectedVersion })`, whose
  `EmbedConflictError` answers `conflict`. Granted reads use `storage.read`
  (or `lend`, for the engine's ranged reads, E15). The embed lists the
  capability `files` when the provider has `create`.
- **EM24** (1.4) *File parameters of the agent port.* `editor.agentPort`
  (EM18) takes an optional `agentFiles(paths, access)` callback answering
  `fileId`s in the same order, or a refusal; the port resolves `file`
  parameters ([`KitAgent 1.4`](agent.md) A28, A29) only through it, and
  without it every `file` parameter answers `not-allowed`. The page decides
  what an agent may reach; FA13 holds for `write`.

- **EM25** (1.5) *Links, previews, and opening* ([`KitLinks 1.0`](links.md)).
  A storage provider MAY add `resolveLink(fromFileId, linkRef)` answering
  `{ fileId, name, kitId, version, path } | null` (`path` relative to the
  linking file, as the page names it), `open(fileId, view)` and
  `openUrl(url)` answering `{ opened }`, and `preview(fileId, view, width,
  height, scale)` answering PNG bytes and `{ version, area? }`. The embed
  mints link handles from `resolveLink` (FA18, EM23) and answers
  `links/resolve`, `host/open`, `host/openUrl`, and `host/preview` through
  them; it lists `links`, `open-file`, `open-url`, and `preview-files` only
  for the callbacks the provider has, and the kit degrades without them
  (`KitLinks 1.0` section 7). The embed enforces OP1, OP6, and OP7 before it
  calls `open` or `openUrl`; the page shows the confirmation of OP8.
  Without a `preview` callback the embed MAY draw previews itself, by
  mounting the target kit's package (when the page registered it) in a
  hidden frame from that kit's own origin with `document.preview` (PV1).
- **EM26** (1.5) A storage provider MAY add `backlinks(fileId)` answering
  `[{ fileId, name, path, link }]`, for `links/backlinks`; the page owns any
  index.
- **EM27** (1.5) `editor.renamed(fromPath, toPath)`, both relative to the
  open document's folder as its links name files, tells an open editor of a
  rename or move the page made: the embed sends `links/retarget` with
  origin `system` to that editor only (LK8 step 2 for the open document).
  Closed documents are the page's own business.
- **EM28** (1.6) *The page's shortcuts.* The mount option `shortcuts` lists
  keys in the Kit UI protocol's notation (`Cmd+S`). The embed sends them as
  `ui/initialize.shortcuts`, so the kit forwards them (`host/shortcut`,
  UI-K5) instead of handling them, and emits each as the editor's
  `shortcut` event (`{ key, code, meta, ctrl, shift, alt }`). A page that
  lists `Cmd+S` saves with `editor.save()`. Without the option the kit
  forwards nothing.

- **EM29** (1.7) *The page's services.* The mount option `services` holds
  the page's handlers for the Kit UI protocol's host services by id
  (`people.mention`, `people.notify`, `comment.create`, `file.pick`, and the
  rest of section 7k). The embed lists `service:<id>` for each one the
  document's permissions allow (UI-V4: `comment.create`, `people.mention` and
  `people.notify` need comment rights, so a viewer's kit is offered none) and
  routes `host/service` to it with checked params; the page treats every
  request as unsolicited (UI-V5). A handler refuses by throwing an error whose
  `reason` is one of the protocol's `SERVICE_ERROR_REASONS` (`not-allowed`,
  `no-gesture`, `cancelled`, `not-found`, `failed`); the embed answers the kit
  with that reason, and with `failed` for any other error.
- **EM30** (1.7) *Comment threads the page keeps.* With the mount option
  `comments` (`{ activated(threadId) }`) the page keeps the document's comment
  threads itself (its own store, people, notifications) and the kit only
  anchors them (capability `comment-anchors`): a kit that lists it too sends
  `comment.create` (EM29) for a new thread instead of writing one into its
  document. `editor.comments.show(threads)` gives the kit the whole list to
  mark, `[{ id, anchor, resolved, count }]`; the embed sends it again to a kit
  it opens again (a reconnect, a role change), so the page shows each list
  once. `editor.comments.locate(anchors)` answers whether the kit finds each
  anchor now (all `false` from a kit without `comment-anchors`), and the
  `activated` callback hears the person click a marker. Anchors are the
  protocol's (section 7k), checked on both sides. Kits that keep threads in
  their document (`KitModel 1.0` M23) keep doing so when the page passes no
  `comments`, and their threads stay the `comments` event's.

- **EM31** (1.8) *The page's own change.* `editor.commands.run(id, params,
  { save?, origin: 'system', originLabel? })` runs the command as a change
  the page makes on the person's behalf (a feature syncing mail into the
  open table), not as the agent: the embed sends `ai/run` with `origin:
  "system"` and `originLabel` (Kit UI protocol section 2), and the kit
  runs it as the KDM `system` origin with that label, the same change Kit
  Process Protocol's `commands.execute` with origin `system` makes on a closed
  document. It is a step of no undo history: neither the person's Undo nor
  the agent's takes it back. `originLabel` names the page's feature
  (`emailsync`: 1 to 64 letters, digits, `.`, `_`, `-`; `host` when absent).
  The `changed` event says `by: 'system'` with that `originLabel`, and the
  editor's status line says the app edited the document. A kit whose engine
  cannot keep a change out of its undo history refuses it (reason
  `unsupported`) and changes nothing. Only the page sends it: the agent port
  (`agentPort`) never does, whatever its caller passes.

`commands` stays the quick automation surface; the object model reaches an
embedded editor through `modelPort` and `document` ([`KitObjectModel 1.0`](object-model.md)).
