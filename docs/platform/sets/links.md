# `KitLinks 1.0`: links between files, previews, and opening

For integrators and kit authors whose documents link other files: a note
that embeds a section of another note or a board, a board whose cards show
notes, tables, and other boards, a table field that points at a file. This
set fixes how a kit reads the files its document links, how it gets a
picture of a file another kit edits, how it opens a file or a web address
in the host, and how a host keeps links working when files are renamed or
moved. The host stays in charge of the workspace; the kit never sees a path
of the host's file system.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

| | |
| --- | --- |
| Status | Specified in edition 2026.11; not yet implemented by any kit or host |
| Bindings | [Kit UI protocol](../reference/ui-protocol.md) section 7i (protocol 2.1, `kition-kit-ui/2`); [Kit Process Protocol](../reference/kit-process-protocol.md) version 2, section 5.4; [`KitEmbed 1.5`](embed.md) EM25 to EM27; [`KitAgent 1.4`](agent.md) A42 and A43; [`KitFiles 1.1`](files.md) FA18 (the link grant flow) |
| Kit side | HC-P1 to HC-P5, LR6, LK1 to LK6 below; engine rules E17 to E19 ([engine contract](../kits/engine.md)); manifest rule K18 ([manifest](../kits/manifest.md)); UI-K8 |
| Host side | LR1 to LR5, PV1 to PV8, OP1 to OP9, LK7 to LK13, UI-N1; H15 to H17 ([host contract](../kits/host.md)); LR2 |

The set has three parts a host offers one by one: **linked reads and the
link index** (sections 3 and 6, the set proper, which a host advertises as
`"KitLinks 1.0"` in `capabilitySets`), **previews** (section 4, capability
`preview-files`), and **opening** files and web addresses (section 5,
capabilities `open-file` and `open-url`). A kit tests for each and degrades
without it (section 7).

## 1. Principles

- **HC-P1 The host owns the workspace.** Only the host knows which files
  exist, what a name resolves to, which kit opens a file, and who links
  what. A kit asks; the host answers under its own policy (UI-H2, FA-P1).
- **HC-P2 Links are document content.** A kit sends and receives link
  targets in the form its documents store them: workspace paths relative to
  the document's folder, root-anchored with a leading `/` (the lent-path
  rules of E5), or a bare name (`[[Plan]]`). It never receives an absolute
  path, a host URI, or the workspace root (FA-P2). Paths it learns from the
  host (a resolved name, a backlink's source) come in the same
  document-relative form.
- **HC-P3 Every capability degrades.** A kit MUST open, edit, and save its
  document, with a reduced view, against a host that offers none of this set
  (section 7).
- **HC-P4 One meaning, three bindings** (FA-P4): the page (Kit UI
  protocol), headless (Kit Process Protocol 2), and the embed carry the same
  requests under the same rules.
- **HC-P5 The engine stays IO-free** (E5, FA-P5): it reports its links and
  rewrites them; reading a target goes through the lent-file path; drawing
  another kit's file is the host's work, done by that kit.

## 2. Links

A **link** is a reference from a document to another file of the workspace.
The set uses one shape everywhere:

```json
{
  "id": "l3",
  "kind": "link",
  "target": { "path": "../plans/Roadmap.md", "docId": "8c1e…" },
  "view": { "heading": ["Plan", "Risks"] },
  "at": { "object": "…", "range": [120, 141] },
  "text": "see [[Roadmap#Risks]] before"
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable within one answer and across answers while the link exists: the KDM id of a board card; for a note, an id the engine derives from the link's position and text |
| `kind` | `link` (navigates), `embed` (shows the target inline: `![[…]]`, a picture), `card` (a board card), `media` (a clip, a linked image, a font the document needs to draw) |
| `target.path` | The path as stored, normalised by the lent-path rules; absent for a name link |
| `target.name` | A bare name the host resolves (LR4), for syntaxes such as wikilinks; absent for a path link |
| `target.docId` | The target's `docId` ([`KitModel 1.0`](model.md) M7) when the document stores it; lets the host follow a target that moved while the document was closed |
| `target.url` | A web address (`https:`, `http:`, `mailto:`), for links a kit shows in its own panels; a host ignores such links for reads and the index |
| `view` | Where in the target: the shape of a diagnostic's target ([`KitAgent`](agent.md) A21: `objectId`, `path`, `page`, `slide`, `sheet`, `cell`), plus `time` for timeline kits, `heading` (a heading path) and `blockId`, as the target's kit understands them |
| `at` | Where in the source: an object id, and for text a range in the engine's local coordinates |
| `text` | Up to 200 characters around the link, for backlink lists; plain text, untrusted |

A request that names a target uses the **link reference** `{ path?, name?,
docId? }`, with `path` or `name` present.

## 3. Linked reads

How a kit reads the files its document links. Reads by path (`host/read`,
`host/stamp`, `document.lend`) keep the scope of H3: the document and the
files beside it. A link target outside that scope is reached only through a
file handle that the **link grant** gives ([`KitFiles 1.1`](files.md) FA18),
in every binding, the page included. LR2 (never host data, never hidden
paths) is stated once in the [host contract](../kits/host.md#read-scope) and
holds for every read of this set.

- **LR1 Scope.** For a kit that lists the capability `links` (K18), a host
  serves, besides the document and its lent files, `read` handles for the
  **targets of the document's links**: the links the kit last reported
  (`links/changed`, headless `document.links`) and the ones it asks to
  resolve (`links/resolve`). A host MAY refuse to resolve a target that is
  not in the last reported link set (`not-linked`). Every target stays
  inside the workspace (H3) and outside LR2.
- **LR2** *Never host data.* Specified in the
  [host contract](../kits/host.md#read-scope); not repeated here. A target
  in a hidden path or the host's store is answered `exists: false`, the
  same as a missing file.
- **LR3 Extensions.** A host MUST refuse a link grant whose target's
  extension the kit's manifest does not declare in `links.read` (K18), so a
  note kit reads Markdown, pictures, and boards, but not a spreadsheet
  because a link names one. The answer is `exists: true` with no `file`, so
  the kit can still draw the link and offer to open it.
- **LR4 Resolving.** `links/resolve` (headless `links.resolve`) takes
  `{ links: [linkRef] }` and answers, in the same order,
  `{ resolved: [{ exists, path?, docId?, kit?, name, version?, file? }] }`:
  `path` in the document-relative form (HC-P2), `docId` the target's M7 id
  when the host knows it, `kit` the id of the kit that edits the target (or
  `null`), `name` the display name (the last segment), `version` the
  target's version stamp, and `file` a KitFiles stat of a `read` handle
  (FA3) when LR3 allows the read. A missing target answers `exists: false`.
  Names resolve deterministically: the host matches the base name without
  its extension, case-insensitively (an extension, when given, must match
  too), and among several matches prefers one in the document's own folder,
  then the shortest path, then the first in Unicode code-point order of the
  path. A `docId` the host knows wins over a stale `path`.
- **LR5 Freshness.** A link handle lives as KitFiles handles do (FA4): until
  the session ends, until the document stops linking the target (the next
  `links/changed` without it), or until the host revokes it
  (`files/revoked`) because the target was deleted, renamed, or hidden.
  After a rename the kit resolves the new path again.
- **LR6 Engines.** An engine reads a linked target only through
  `kition_kit::host` (E5, E15): `size`, `read_range`, and `read`, with the
  path as the document stores it. The kit's binding keeps a map from that
  path to the link handle and answers the read from the handle; the engine
  never sees the handle's origin or the target's real path. A read of a
  target the binding has not resolved yet fails with the reason
  `not-resolved`; the binding resolves it (`links/resolve`) and asks the
  engine to draw again, as for blobs that arrive late. An engine MUST treat
  target bytes as untrusted input (E2).

### 3.1 Hosts that serve each kit from its own origin

A host MAY serve each kit's package from an origin of its own, neither the
host page's nor another kit's (`@kition/embed` does, EM4). Everything in
this set works there unchanged:

- Every request and answer travels over the Kit UI protocol's
  `MessageChannel`; previews arrive as bytes (`ArrayBuffer`), never as a URL
  on the host's origin, and the kit draws them in its own origin.
- The lent root (`document.lend.root`) and the handle-scoped URLs a host
  serves for ranged reads (UI-F2) are **capability URLs**: they carry an
  unguessable token of at least 128 bits, bound to the kit session, the kit,
  and the files the session may read (the document's folder for lent
  files, one file for a handle); they stop working when the session ends or
  the handle is revoked (FA4); they answer cross-origin requests only from
  the kit's origin (`Access-Control-Allow-Origin` that origin, `Range`
  allowed, `ETag` and `Content-Range` exposed, H7). They are never a view
  of the whole workspace and need no credential of the host's own page.
- Previews are drawn by the target's kit in that kit's own origin or
  headless (PV1), never on the host page's origin and never in the asking
  kit's frame.
- Opening needs no popup or navigation right in the kit's frame: the host
  opens files and web addresses (section 5), so a host MAY frame kits
  without `allow-popups` and `allow-top-navigation`.

## 4. Previews (capability `preview-files`)

A kit asks the host for a picture of another file, drawn by the kit that
edits it.

| | |
| --- | --- |
| Request (kit to host) | `host/preview { link: linkRef, view?, width, height, scale?: 1 \| 2, background?: "transparent" \| "surface" }` |
| Result | `{ image: ArrayBuffer, mime: "image/png", width, height, version, kit, name, area?: [x0, y0, x1, y1] }` |
| Refusals (`error.data.reason`) | `not-found`, `not-linked` (LR1), `no-kit` (no kit draws it), `too-large` (PV4), `timeout` (PV4), `busy` (PV5), `unsupported-view` (PV2), `render-failed` |

- **PV1 Who draws.** The host has the target drawn by the target's own kit,
  opened read-only, in one of two ways: a hidden frame of the target kit,
  served from that kit's own origin and opened with `document.preview: true`
  (Kit UI protocol section 7i), which answers `view/render`; or the target
  kit's headless executable (`view.screenshot`, Kit Process Protocol section
  7). A host MUST NOT run a kit's code on its own page's origin, in the
  asking kit's frame, or on any page's main thread (H1).
- **PV2 What it shows.** Without `view`, the target's initial area: the
  whole document for a single-area kit, the first page for a paged kit, the
  content bounds of the first page for a canvas such as a board, fitted
  into `width` × `height` keeping its aspect ratio. With `view`, the
  target's engine finds the area with the extra `areaOf` (E19); an engine
  without it, or an answer of `null`, refuses `unsupported-view`, and the
  asking kit falls back to a preview without `view`. `area` reports what
  was drawn, in the target's document units.
- **PV3 Which state.** The host draws the saved file. A host MAY draw the
  state of an editor that has the target open with unsaved edits; it then
  answers that editor's revision as `version`.
- **PV4 Limits.** A host MUST bound every preview and refuse beyond its
  bounds: at most 2,048 × 2,048 device pixels after `scale`; a target of at
  most 64 MiB; a wall-clock budget per preview, after which it stops the
  drawing frame or process and answers `timeout`. These are proposed
  defaults, not measured values; a host MAY lower them and MUST document its
  values.
- **PV5 Concurrency and caching.** A host MUST limit how many previews it
  draws at once and queue the rest (answering `busy` when its queue is
  full); it SHOULD keep one drawing session per target warm for a short time
  and cache images by target, `version`, `view`, size, and `scale`. A kit
  SHOULD ask once per card for each version and size, and SHOULD keep the
  last image in its own view cache, never in the document, to draw while it
  waits.
- **PV6 Updates.** When a previewed target is saved, renamed, or deleted,
  the host sends `links/targetChanged` (section 6.1, LK6); the kit asks
  again when the version differs.
- **PV7 Privacy.** The image carries only what the target's kit draws. A
  host MUST NOT draw a file the person cannot open, and answers `not-found`
  for it exactly as for a missing file, so a kit cannot probe for files.
- **PV8 Headless (optional).** A Kit Process Protocol 2 host MAY serve
  `links.preview` with the same params, answering an `Image`; without it,
  headless renders and exports draw such cards as titled placeholders.

## 5. Opening

### 5.1 Files (capability `open-file`)

| | |
| --- | --- |
| Request (kit to host) | `host/open { link: linkRef, view?, placement?: "tab" \| "beside", create?: { kit?: string } }` |
| Result | `{ opened: boolean }` (`false` when the person cancelled a confirmation) |
| Refusals | `not-found`, `no-gesture`, `no-kit`, `not-allowed` |

- **OP1 Gesture.** A host MUST open only in response to a person's gesture
  in the kit (the kit sends the request from a click or key handler), as for
  pickers (FA6), and MAY refuse a request without a recent gesture
  (`no-gesture`). An agent opens files through its harness, never through a
  kit.
- **OP2 Where.** The host opens the target in its own UI (a tab, or beside
  the current one for `beside`) with the kit that edits it, under the same
  policy as when the person opens it from the host's file list. A target no
  kit edits opens the host's way (its own preview); a host MUST NOT launch
  another application without the person's confirmation. A target under
  LR2 is `not-found`.
- **OP3 View.** The host passes `view` to the opened kit: as
  `document.view` in `ui/initialize` for a new editor, or as the
  notification `document/reveal { view }` to an editor already open on it.
  A kit that can show the `view` scrolls to it and selects it; otherwise it
  ignores it.
- **OP4 Create.** With `create`, a missing target named by `path` or `name`
  is first created as a new, empty file of a kit that declares the
  extension in `creates` (H9; `create.kit` picks one when several do),
  never replacing a file (H5), its name sanitised as FA15. This is "click an
  unresolved link to create the note". A host MAY ask the person first.
- **OP5 Read-only sessions.** `host/open` works in a read-only document
  (UI-K7): opening is viewing. The opened editor follows its own access.

### 5.2 Web addresses (capability `open-url`)

A kit loads nothing from the network (UI-K1) and opens no window itself
(UI-K8). Hyperlinks in its documents (a link card, a text link) open
through the host.

| | |
| --- | --- |
| Request (kit to host) | `host/openUrl { url }` |
| Result | `{ opened: boolean }` (`false` when the person declined) |
| Refusals | `no-gesture`, `not-allowed` |

- **OP6 Gesture.** As OP1: only from a person's gesture in the kit; a host
  MAY refuse without one (`no-gesture`).
- **OP7 Schemes.** A host MUST open only `https:`, `http:`, and `mailto:`
  addresses, and MUST refuse every other scheme (`file:`, `javascript:`,
  `data:`, custom application schemes) with `not-allowed`. It opens the
  address in the system's browser or mail client, never inside the kit's
  frame or the host's own window.
- **OP8 Confirmation.** Before it opens an address, a host MUST show the
  person the full address, with its host name emphasised and any
  non-ASCII host name also shown in its ASCII (punycode) form, and open it
  only when the person confirms. A host MAY offer to skip the confirmation
  for a site the person chose to trust; it MUST NOT skip it on a kit's or
  an agent's say.
- **OP9 Nothing comes back.** The result carries only `opened`; a host
  MUST NOT tell the kit anything the browser or mail client did, so the
  request is no channel out of the host beyond what the person confirmed.

## 6. The link index

A host that serves `KitLinks 1.0` keeps a workspace **link index**: from
every document of a kit that lists `links` to its outgoing links, so it can
answer backlinks and rewrite links when files move.

### 6.1 Kit side

- **LK1 `linksOf()`.** An engine that stores links answers the extra
  `linksOf()` (E17): every outgoing link of the current document state
  (section 2), in document order, links inside comments excluded. It MUST
  be cheap enough to call after every committed change (a proposed budget,
  not measured: under 5 ms for a document with 1,000 links on the
  conformance machine) and MUST NOT read target files.
- **LK2 `links.retarget`.** An engine that stores links offers the command
  `links.retarget { from, to }` (E18), where `from` and `to` are
  `{ path, docId? }` in the document-relative form. It rewrites every link
  whose target resolves to `from` (by path, by stored `docId`, or by a name
  that resolved to `from`) so it resolves to `to`, and nothing else:
  - **minimal span**: only the link's target text changes; labels, aliases,
    `#heading` and `^block` suffixes, and the link's syntax stay as written.
    A name link stays a name link while the new name is unambiguous under
    LR4, else it becomes the shortest unambiguous path;
  - **idempotent**: running it again, or when no link targets `from`,
    changes nothing and answers `{ changed: 0, links: [] }`;
  - it answers `{ changed, links: [id] }`, is `mutates: true`, carries a
    parameter schema (E7), and is one transaction recorded with the origin
    the caller gives ([`KitModel 1.0`](model.md) M10, M11).
- **LK3 Folders.** `from` and `to` MAY name folders, with a trailing slash
  (`{ path: "plans/" }`): every link under `from` moves under `to`. One call
  covers a folder move.
- **LK4 Reporting.** In the page, a kit that lists `links` sends
  `links/changed { links }` after it opens and after every committed change
  that altered its link set, at most about once a second while the person
  types; the host keeps the latest as the document's live link set (LR1).
  Headless, the host asks `document.links`.
- **LK5 Backlinks.** `links/backlinks {}` answers
  `{ backlinks: [{ source: { path, name, docId?, kit? }, link }] }` for the
  current document, `source.path` document-relative (HC-P2). The host sends
  `links/backlinksChanged {}` when the set changes and the kit asks again.
  `link.text` is untrusted.
- **LK6 Target changes.** `links/targetChanged { link, exists, version?,
  path? }` (host to kit): a target the document links was saved, renamed
  (`path` is its new document-relative path), created, or deleted. The
  document's own links are rewritten by LK8; this notification only
  refreshes views and previews.

### 6.2 Host side

- **LK7 The index.** A host keeps an index from every workspace document of
  a kit that lists `links` to its links (LK1), keyed by `docId` and path.
  Open documents report through their editor (LK4); closed ones are indexed
  with the kit's headless executable (`document.links`, which runs the same
  `linksOf`); a file changed on disk while closed is indexed again. A host
  MAY persist the index; it is derived data and never part of a document.
- **LK8 Rename and move.** After a rename or move of a file or folder that
  the person (or an agent, A43) made in the host succeeded, the host:
  1. finds every document whose links resolve to the old path or folder
     (by path, name, or `docId`);
  2. runs `links.retarget { from, to }` in each, with origin
     `{ kind: "system", principal: <the person>, label: "Update links after rename" }`:
     in the open editor when the document is open (the host-to-kit request
     `links/retarget`), else headless (open, run, save atomically with the
     expected version, H4, close);
  3. tells the person how many links in how many files it changed, and
     which files it could not change.
- **LK9 Unsaved work is never lost.** In an open editor the retarget is one
  more transaction on top of the person's unsaved edits; a host MUST NOT
  save that document for the person unless it had no unsaved edits before
  the retarget (then it MAY save at once, so the workspace stays
  consistent). A closed file that changed between indexing and saving is
  read and retargeted once more; on a second conflict it is reported, never
  overwritten (H6, FA14).
- **LK10 Consent.** A host MUST show what it changes, before or as it
  changes it, and SHOULD offer the person a setting: "always update links",
  "ask each time", or "never". The default SHOULD be to update links and
  show a summary with an Undo. A host MUST log each retarget an agent's move
  caused in its session record (A10).
- **LK11 Shared documents.** A document the person may only view or comment
  on (UI-K7) is not retargeted; it is reported. In a co-edited document the
  retarget is an ordinary change that syncs; because LK2 is idempotent, two
  hosts that both retarget reach the same state.
- **LK12 Deletes.** Deleting a file rewrites nothing; links to it become
  broken (`exists: false`, LK6), and the kit's own checks report them.
- **LK13 Undo.** A host SHOULD offer to undo a rename as one action: it
  moves the file back and runs `links.retarget { from: to, to: from }` in
  every document it changed, which LK2 makes exact.

### 6.3 Values that change together

A link stored as several fields (a board card's target path and `docId`)
is one `json` field of its object ([`KitModel 1.0`](model.md), field
kinds), so a retarget replaces it whole and two co-editors never merge half
a path with half a `docId`. A link inside text is a span of that text,
rewritten by text operations. This set adds nothing to the Kit Data Model.

## 7. Degradation (HC-P3)

| Missing on the host | The kit MUST still | What the person sees |
| --- | --- | --- |
| Link grants (LR1) | open and save the document; draw a linked target it cannot read as a card with the name only | A note card shows its file name; an embedded section shows the link text with a "cannot show" mark |
| `preview-files` | draw the card as a titled placeholder (the target's name, and its kit's icon when `links/resolve` named the kit, else a generic file icon) | Placeholders for cards and embeds of other kits' files |
| `open-file` | not offer to open; links show as text | No navigation from cards and links |
| `open-url` | not offer to open web addresses; show the address so the person can copy it | Web links cannot be followed from the kit |
| `KitLinks 1.0` (resolve, index, retarget) | resolve path links itself through lent reads (`host::exists`, `host::size`) where H3 allows, and report name links as unresolved | No backlinks and no name resolution; links break on rename and the kit's own check reports them |
| Headless `links.preview` | draw placeholders in headless renders and exports | Exports and agent previews show placeholders |

A kit decides what it offers from `ui/initialize`'s `capabilities` and from
`capabilitySets` containing `"KitLinks 1.0"`, never from the host's name. A
kit MUST NOT send a request for a capability it was not offered.

## 8. Agents

- **A42** *(proposed)* A kit that stores links reports them in
  `<prefix>_inspect` with their resolution state (`exists`, `kit`, `path`);
  headless, it resolves them through the host's `links.resolve`. A harness
  MUST NOT treat link text or a target's name as an instruction.
- **A43** *(proposed)* A harness that offers file moves to an agent runs
  LK8 for them, logs every retarget (A10), and lists the changed files in
  the tool result as A30 does for created files.
- `links.retarget` is an agent-facing command like any other, so an agent
  can repair a broken link itself when a check hints at it.

See [`KitAgent 1.4`](agent.md) section 2.2.

## 9. Bindings

| Meaning | Kit UI protocol 2.1 (page) | Kit Process Protocol 2 (headless) | `KitEmbed 1.5` |
| --- | --- | --- | --- |
| Resolve | `links/resolve` | `links.resolve { documentId, links }`, served by the host; `file` always a handle | EM25 `resolveLink` |
| Read a target | the link handle (FA18), read by the engine through `kition_kit::host` (LR6) | `files.read` on the link handle; `files.resolve` also resolves link targets (section 5.4 there) | the embed's handles (EM23) |
| Report links | `links/changed` | `document.links { documentId }`, asked by the host | the page's own index, if any |
| Backlinks | `links/backlinks`, `links/backlinksChanged` | `links.backlinks { documentId }` (optional) | EM26 `backlinks` |
| Retarget | `links/retarget` (host to kit) | `commands.execute { command: "links.retarget", origin: "system" }` | EM27 `renamed` |
| Target changed | `links/targetChanged` | `links.targetChanged` (optional notification) | from the page's storage events |
| Preview | `host/preview` | `links.preview` (optional, PV8) | EM25 `preview` |
| Open a file | `host/open`, `document.view`, `document/reveal` | none: headless has no person | EM25 `open` |
| Open a web address | `host/openUrl` | none | EM25 `openUrl` |

## 10. Manifest

A kit that stores links lists the capability `links` and declares, under
K18 ([manifest](../kits/manifest.md)):

```json
"links": {
  "kinds": ["link", "embed", "media"],
  "read": ["md", "markdown", "png", "jpg", "webp", "svg", "kboard"],
  "retarget": true,
  "names": true
}
```

`read` bounds link grants (LR3); `retarget: true` promises LK2; `names:
true` says the kit stores name links and needs LR4. A kit that sends
`host/preview`, `host/open`, or `host/openUrl` lists `preview-files`,
`open-file`, or `open-url` among its capabilities, so a host can show them
before it installs a plugin kit.

## 11. Errors and capability names

The Kit UI protocol and the embed carry a refusal as `-32000` with
`error.data.reason`; the Kit Process Protocol has a code per reason.

| Reason (Kit UI, embed) | Kit Process Protocol 2 | Meaning |
| --- | --- | --- |
| `not-found` | `-32040 link_not_found` | No such target, or one the person may not see (LR2, PV7) |
| `not-linked` | `-32041 link_not_linked` | The target is not in the document's link set (LR1) |
| `no-kit` | `-32042 link_no_kit` | No kit draws or opens the target |
| `too-large`, `timeout`, `busy` | `-32043 preview_limit` (`data.detail` names which) | A preview bound (PV4, PV5) |
| `unsupported-view` | `-32044 preview_unsupported_view` | The target's engine cannot find `view` (PV2) |
| `render-failed` | `-32045 preview_failed` | The target's kit failed to draw |
| `no-gesture` | (none: headless has no person) | `host/open` or `host/openUrl` without a recent gesture (OP1, OP6) |
| `not-allowed` | `-32018 file_not_allowed` | The host's policy refuses: a scheme outside OP7, a create outside H9 |
| `not-resolved` | (inside the kit) | An engine read a target its binding has not resolved yet (LR6) |

| Capability | Who lists it, where | Means |
| --- | --- | --- |
| `links` | Host, Kit UI `ui/initialize` `capabilities` | Serves `links/resolve` and `links/backlinks`, keeps the link set, sends `links/targetChanged`, `links/backlinksChanged`, and `links/retarget` |
| `preview-files` | Host, Kit UI `capabilities` | Serves `host/preview` |
| `open-file` | Host, Kit UI `capabilities` | Serves `host/open` |
| `open-url` | Host, Kit UI `capabilities` | Serves `host/openUrl` |
| `links` | Kit, `ui/initialize` answer and manifest (K18) | Reports links and answers `links/retarget` |
| `render` | Kit, `ui/initialize` answer | Answers `view/render` in a preview frame (PV1) |
| `links`, `links.preview` | Host, Kit Process Protocol 2 `hostServices` | Serves `links.resolve` (and `links.backlinks` when it has an index), and `links.preview` |
| `document.links` | Kit, Kit Process Protocol 2 `capabilities.features` and `headless.features` | Answers `document.links` |

## 12. Security considerations

- **What linked reads protect.** LR1 binds reads to what the document
  links, but the kit reports its own links, so a hostile kit can claim to
  link any file in the workspace. The bounds that hold against it are LR2
  (never host data or hidden paths), LR3 (only the extensions its manifest
  declares, shown before a plugin kit is installed), read-only rights,
  handles that a host lists and revokes (FA16), and the kit's lack of
  network (UI-K1, UI-H3, A37), which holds only where the host enforces it
  (section 3.1: per-kit origins and a content security policy sent by the
  host). LR1 still makes a first-party kit's reads auditable and stops
  accidents, such as a link that climbs out of one project into another.
- **No host paths reach the kit** (HC-P2, FA-P2): resolutions and backlinks
  are document-relative; names are last segments; handles stand in for
  every read outside the document's folder.
- **Probing.** `links/resolve`, `host/preview`, and `host/open` answer a
  file the person may not see exactly as a missing one (LR2, PV7, OP2).
- **Preview resources.** PV4 and PV5 bound pixels, size, time, and
  concurrency. A preview runs the target kit's code, which the host already
  trusts to edit that file, in that kit's own origin or process, and never
  the asking kit's code (PV1). A crash or a timeout ends only that drawing
  session.
- **Hostile targets.** The target's engine parses an untrusted file exactly
  as when the person opens it (E2).
- **Navigation and exfiltration.** `host/open` and `host/openUrl` need a
  gesture (OP1, OP6); `host/openUrl` opens only three schemes, after the
  person saw the full address (OP7, OP8), and tells the kit nothing back
  (OP9). A kit that cannot open windows (UI-K8, a frame without
  `allow-popups`) has no other way to send data out through an address.
- **Mass edits.** A rename can touch many files: LK9 never loses unsaved
  work, LK10 shows and logs what changes, LK11 skips documents the person
  may not edit, LK13 makes it reversible, and LK2's minimal span keeps each
  change to the link text.
- **Prompt injection.** `link.text`, names, and backlink contexts are
  untrusted; a harness MUST NOT follow them as instructions (A42).

## 13. Conformance

A kit, a host, an embed, or a harness conforms to `KitLinks 1.0` when it
passes these tests (see [conformance.md](../conformance.md#kitlinks-10)):

| Who | Test | Rules |
| --- | --- | --- |
| Kits (page), `@kition/kit-dev-host` `checkLinks` | 1. A fixture with known links (paths, names, embeds, cards, a link inside a comment): `links/changed` lists exactly the expected set, comments excluded. 2. `links.retarget` for a file and for a folder: the saved bytes differ only in link spans; syntax, aliases, and suffixes are kept; a second run answers `changed: 0`. 3. Undo of the retarget restores the bytes. 4. Against a host without `preview-files`, `open-file`, `open-url`, or `links`, the kit opens, draws placeholders, and sends no request it was not offered. 5. No request carries an absolute path or a path above the workspace (`checkNoPaths`). 6. `host/open` and `host/openUrl` are sent only from a gesture | LK1–LK4, HC-P2, HC-P3, OP1, OP6, UI-K8 |
| Kits (headless), `kition-kit-conformance` | `document.links` equals the page's `linksOf` for the same fixture; `links.retarget` run with origin `system` saves atomically; linked reads go only through link handles (check 13 of the Kit Process Protocol suite) | LK1, LK2, LK7, LR6 |
| Kits (manifest), `tools/check-manifest.mjs` | `links` declared when the capability is listed; `preview-files`, `open-file`, `open-url` listed when used | K18 |
| Hosts (Chromium and WebKit) | Read refusals: the host's store, hidden paths, undeclared extensions, `..`, unlinked targets, all answered alike. The name resolution order of LR4. Previews: oversize answers `too-large`, a slow fixture `timeout`, the concurrency cap queues, `version` changes after a save and `links/targetChanged` arrives, no kit code runs on the host page's origin. Opening: no gesture refused, `view` reaches the opened kit, `create` makes a new file only. Web addresses: other schemes refused, confirmation shown, nothing returned but `opened`. Rename: an open document with unsaved edits keeps them and gains the retarget; a closed one is rewritten atomically; a conflict is reported, not overwritten; a read-only shared document is reported; Undo restores every file byte for byte | LR1–LR5, PV1–PV7, OP1–OP9, LK7–LK13, H15–H17 |
| Embeds | EM25–EM27 with a fake storage: resolve, open, open-url, and preview callbacks; capabilities absent without them | EM25–EM27 |
| Harnesses | `<prefix>_inspect` lists links with their resolution state; an agent's move retargets, logs, and lists the changed files | A42, A43 |
