# Kit UI protocol

| | |
| --- | --- |
| Protocol | `kition-kit-ui/1` |
| Version | 1 |
| Part of | [Kition kit platform](../index.md) edition 2026.11 ([index](../index.md#32-versions-and-editions)) |
| Host library | `@kition/kit-host` (packages/kit-host (Kition SDK: `packages/kit-host`)) |
| Kit library | `@kition/kit-editor` (packages/kit-editor (Kition SDK: `packages/kit-editor`)) |
| License | Apache-2.0 |

A kit with an **embedded UI** draws its whole editor itself: menus, ribbon,
tool rail, panels, canvas, status bar, and dialogs. The host shows that editor
in an `<iframe>` inside one of its tabs and talks to it over this protocol. The
host keeps what only a host can do: files, the workspace, the agent, the theme
and language, and the shortcuts of the application around the tab.

The same kit UI runs in any host that implements this protocol.

## 1. Connection

1. The host creates an `<iframe>` whose `src` is the kit's UI entry
   (`ui.entry` in `kit.json`, resolved against where the host serves the kit
   package).
2. The kit announces every document it loads: as soon as its script runs, it
   posts to its parent window

   ```js
   window.parent.postMessage({ kitionKitUi: 1, ready: "kition-kit-ui/1", id }, "*")
   ```

   where `id` is a fresh random string for this document. The message carries
   nothing secret, so its target origin may be `"*"`. A kit that receives
   `{ kitionKitUi: 1, hello: "kition-kit-ui/1" }` from its parent before it has
   a port announces itself again.
3. The host listens for `ready` from the frame's window (`event.source`) and
   origin, and posts `hello` to the frame when it starts, for a kit that
   announced itself before the host listened. It answers each `ready` with a
   new `MessageChannel`, transferring `port2` and naming the document:

   ```js
   frame.contentWindow.postMessage({ kitionKitUi: 1, protocol: "kition-kit-ui/1", id }, kitOrigin, [channel.port2])
   ```

   A `ready` with an `id` it already answered changes nothing. A `ready` with
   a new `id` means the frame now holds another document (it navigated, or the
   first answer reached the page it replaced): the host closes the earlier
   channel and starts again with the new one. The host MUST NOT wait for the
   frame's `load` event to start: it may already have fired.

   The kit takes the port from the first handshake whose `id` is its own and
   whose protocol it speaks, and ignores every other window message from then
   on.
4. Every further message goes over the port. Each is a JSON-RPC 2.0 object
   (`jsonrpc`, `id`, `method`, `params`, `result`, `error`), sent with
   `postMessage`, so it is a structured clone: binary data travels as
   `ArrayBuffer`, transferred when the sender gives it up.
5. Both sides send requests and notifications. Request ids are unique per
   sender; a host SHOULD prefix them `h`, a kit `k`.
6. The host sends `ui/initialize` first. A kit MUST NOT send any request
   before it has answered `ui/initialize`, and a host MUST NOT send any
   other request before that answer.

Errors use JSON-RPC codes: `-32601` unknown method, `-32602` bad params,
`-32000` the operation failed (`error.message` is for people, `error.data`
MAY carry `{ reason }` with a [Kit Process Protocol](kit-process-protocol.md) reason code).

## 2. Host to kit

### `ui/initialize` (request)

```json
{
  "protocol": "kition-kit-ui/1",
  "host": { "name": "Kition", "version": "0.2.0" },
  "document": {
    "path": "talks/Launch.pptx",
    "name": "Launch.pptx",
    "bytes": "<ArrayBuffer>",
    "version": "\"1791704599-22779\"",
    "readOnly": false
  },
  "theme": { "colorScheme": "light", "tokens": { "--kit-primary": "#5645d4" } },
  "locale": "zh-CN",
  "shortcuts": ["Cmd+N", "Cmd+O", "Cmd+W", "Cmd+T", "Cmd+,", "Cmd+Q", "Cmd+."],
  "capabilities": ["agent", "files", "files-pick"],
  "capabilitySets": ["KitModel 1.0", "KitObjectModel 1.0", "KitExtensions 1.0"]
}
```

- `file.bytes` is the file as it is now, with its version stamp. To start
  a new file instead, the host sends `document.create: { "width", "height" }`,
  no bytes, and the `path` and `name` of the file it will create (an unused
  name it chose, H5); the kit makes the document and writes it with
  `host/write` (`mode: "save"`, no `expected`) when the person first saves.
  That first write creates the file; the host refuses it (`conflict`) when a
  file appeared at that path meanwhile.
- `document.lend`, when present, is `{ "root", "folder" }`: a URL that
  serves ranged reads (`Range`, `ETag`) of the document's folder, and the
  document's folder below it. The kit's engine reads the files beside the
  document (media, pictures, fonts) from it synchronously in its worker
  (standard E5); the host confines it like `host/read` (H3, LR2). The
  root is a capability URL bound to this session and never a view of the
  whole workspace; it need not be on the kit's origin and answers the kit's
  origin across origins ([`KitLinks 1.0`](../sets/links.md) section 3.1).
  Files the document links outside its folder are read through link handles
  (section 7i).
- `document.view`, when present, is where in the
  document to show first, in the shape of a link's `view`
  ([`KitLinks 1.0`](../sets/links.md) section 2): the host opened the
  document from a link (`host/open`, OP3). A kit that can show it scrolls to
  it and selects it; otherwise it ignores it.
- `document.preview`, when `true`, opens the document
  only to draw previews of it for the host (PV1): the frame is hidden, the
  document is read-only (`readOnly` is `true`), and the kit answers
  `view/render` (section 7i) and need not draw its editor.
- `theme` and `locale` follow section 4.
- `shortcuts` are the host's own; see `host/shortcut`. A host that opens a
  command palette with a key kits also use (Kition's Cmd+K, which Word,
  Slide, and Sheet use for links) names a second key for it here that no kit
  binds (Kition: Cmd+.), so the palette is reachable from inside the kit and
  the kit keeps its own key. kit-editor's `RESERVED_SHORTCUTS` lists Kition's.
- `capabilities` are the optional host methods this host serves (sections 3,
  7, 7b, 7e, 7g, 7h, and 7i).
- `capabilitySets` are the capability sets this host serves ([capability sets](../index.md#3-capability-sets)),
  such as `"KitModel 1.0"`, `"KitObjectModel 1.0"`, `"KitExtensions 1.0"`, or
  `"KitEmbed 1.0"`. Older hosts leave it out; a kit treats that as an empty
  list.
- `ui`, when present, is the UI configuration (section 9).
- `document.readOnly`, when true, opens the document for viewing only (a
  view-only link, a viewer of a shared document): see UI-K7. It is fixed for
  the session.
- `document.comments`, when present, is who comments and
  how, for a kit that keeps comment threads ([`KitModel 1.0`](../sets/model.md) M23):
  `{ me, name, canComment, othersReadOnly }`. `me` is the person's principal
  id (a comment's `author`; `null` when unknown), `name` their display name,
  `canComment` whether they may write comments (false for a viewer), and
  `othersReadOnly` that the document is not co-edited now, so threads others
  opened are read-only history. A commenter of a shared document opens with
  `readOnly: true` and `canComment: true`: the kit refuses every edit of the
  content (UI-K7) but still writes comment threads: it runs the
  commands its `kit.json` lists as `collaboration.comments.commands` (Kit Harness
  Protocol 2.0 K13) and no other edit, and Undo and Redo
  of what those commands did in the session, never of anything else. Its
  menus hide what it refuses a commenter instead of showing it disabled. kit-editor's
  `CommentsPanel` takes these as its props. Absent, a kit treats the person as
  unknown, allowed to comment unless `readOnly`, and others' threads as
  writable.
- `document.permissions`, when present, is
  `{ download, export, share }`: what the person may take out of the
  document, from the host's open token ([managed-collab.md](../managed-collab.md)
  OT5). A kit hides its Download, Export and Print (`export`), and Share
  controls whose flag is not `true`. Absent, all are allowed. These are
  display permissions; the host enforces them for the bytes it serves.
- `document.watermark`, when present, is `{ text }` (at
  most 256 characters, no control characters): the kit draws it faint and
  repeated over its canvas, in every mode, previews and prints included.
  `null` or absent: none. kit-editor's `HostConnection` has both, checked
  (`permissions`, `watermark`; `@kition/kit-ui-protocol`'s
  `parseDocumentPermissions` and `parseWatermark`).

The kit answers once the document is open, or with an error the host shows in
the tab:

```json
{ "kit": { "id": "kit.slide", "version": "0.1.0" }, "capabilities": ["ai"] }
```

A kit that honors UI configuration lists `ui-config` in its `capabilities`.

### `document/state` (request)

Answers `{ "dirty": bool, "revision": number, "title": string }`.

### `document/save` (request)

The kit saves as its own Save does (through `host/write`) and answers
`{ "saved": bool, "version": string | null }`. Hosts send it when the person
closes a tab with unsaved work and chooses Save. A read-only document refuses
it (`-32000`, `error.data.reason` `read-only`).

### `document/fileChanged` (notification)

`{ "version": string }`: the file changed on disk. A kit with no unsaved
edits MUST reload it (`host/read`); a kit with unsaved edits MUST NOT replace
them and MUST let the person choose (standard H6).

### `document/held` (notification)

`{ "version": string }`: the file is now `version`, and the
document the kit holds already contains everything it holds (another session
saved a state this replica has). The kit takes `version` as the version it
last read or wrote, keeps its unsaved mark as it is, and raises no "changed
on disk" choice for it; one it raised already for that version goes away.
kit-editor's `useKitDocument` takes it (`holdFile`); no SDK host sends it.

### `document/check` (request)

`{ "draft"?: bool }` answers `{ "diagnostics": [...] }`:
what the kit's engine finds wrong with the document ([`KitAgent 1.4`](../sets/agent.md) A21),
each `{ code, severity, target, message, fix? }`, errors first. A kit that
serves it lists the capability `check`; a host MUST NOT send it to a kit
that does not. It changes nothing, so a read-only document answers it, and
with `draft: true` (capability `draft`, section 7d) it checks the agent's
draft. kit-editor's `useKitSession` serves it from the engine's `check()`
(none from an engine without one).

### `ui/theme`, `ui/locale` (notifications)

`{ "theme": {...} }` and `{ "locale": "..." }` when they change. The kit
applies them at once.

### `ui/focus` (notification)

The tab came to the front; the kit SHOULD move keyboard focus into its editor.

### `ai/*` (requests): the Kit AI bridge

The host forwards the Kit AI bridge (standard A7 to A10) to the open editor,
so an agent edits the live document the person sees:

| Method | Params | Result |
| --- | --- | --- |
| `ai/inspect` | `{ draft? }` | `{ path, kit, dirty, revision, summary, details }` |
| `ai/commands` | `{ query }` | `[{ id, title, description, enabled, schema }]` |
| `ai/run` | `{ steps: [{ command, params, context? }], save, draft?, origin?, originLabel? }` | `{ completed: [{ command, changed, result }], saved }` |
| `ai/preview` | `{ maxSize, draft? }` | `{ png: <base64> }`, at most `maxSize` pixels on the longer side |
| `ai/version` | `{}` | (capability `changes`) `{ version }`, the replica's version, base64 |
| `ai/changes` | `{ since, schema? }` | (capability `changes`) `{ changes, version }`, or `{ changes: null, unavailable, version }` |

`ai/inspect`'s `details` is the engine's `inspect()` (at the part and in
the context the request gives, when it gives them) as the engine answers it,
so it includes the editor state the engine reports: the person's selection,
current part, view or playhead, which change as the person works and as the
editor's canvas resizes. The kit does not filter it. The host does: what it
hands an agent as the document, and what it compares to tell whether the
document changed, is `details` without the editor state the kit declares in
`kit.json` `engine.editorState` and without the session's bookkeeping at the
top (`canUndo`, `canRedo`, `dirty`, `revision`, `history`, `undo`, `redo`,
`path`, `title`, which the answer's own members carry), exactly as a headless
kit's `view.describe` leaves them out (`kition_kit::document_content`;
[manifest](../kits/manifest.md) K23, [engine contract](contract.md)). A kit
whose manifest declares no `engine.editorState` has all of `details` read as
the document. The person's selection reaches an agent through
`ai/selection` (section 7h), and an agent's step acts in an editor state of
its own (below), so the agent needs none of it in the document.

With `draft: true` (capability `draft`, section 7d) they work on the agent's
draft instead of the live document. `ai/selection`,
`ai/select`, and `ai/hitTest` are in section 7h.

A kit that declares the `ai` capability MUST answer these; edits made through
`ai/run` MUST join the document's undo history, and the kit MUST report them
with `document/changed` (`by: "agent"`), except a host's own change (below). A kit whose engine runs commands
as an origin (engine contract 2, `executeAs`) runs each step as origin `agent`
for the person (label `ai/run`), so the steps are the agent's undo steps
([`KitModel 1.1`](../sets/model.md) M12a): the person's Undo keeps them, a step
`edit.undo` takes back only the agent's own, and `edit.undo` with
`{ "scope": "agent" }` lets the person take back the agent's last change.
`@kition/kit-editor` does both.

**A host's own change.** With `origin: "system"` the steps are not the
agent's: they are a change the host makes on the person's behalf through the
open editor (a host feature importing mail into the open table), so the
person sees it at once and there is one copy of the document. `originLabel`
names the host feature (`emailsync`: 1 to 64 letters, digits, `.`, `_`, `-`;
`host` when absent). The kit runs each step as the KDM origin `system` with
that label (`system(label)`, principal `kdm`), exactly as Kit Process Protocol's
`commands.execute` with origin `system` runs a change on a closed document
([kit-process-protocol.md](kit-process-protocol.md) section 6): it is a step of **no** undo
history, so neither the person's Undo nor an agent's `edit.undo` takes it
back, and the document's history records which host feature wrote it. The
kit reports it with `document/changed` `{ by: "system", originLabel }` and
says in its status line that the app made the change, not the agent.

- `origin` is `"system"` or absent; any other value, an `originLabel`
  without `origin: "system"` or not of the form above, and `origin:
  "system"` with `draft: true` are refused with `-32602` before any step
  runs.
- A kit whose engine cannot keep a change out of its undo histories (it does
  not run commands as an origin: no `executeAs`) refuses the step with
  `-32000`, `data` `{ reason: "unsupported", command, step }`, and changes
  nothing, rather than make the host's change the person's undo step.
- Every other rule of `ai/run` holds as for the agent's steps: the UI
  configuration (UI-C2, UI-C6), read-only documents (UI-K7), leases
  (section 7b), and `save`.
- Only the host sends it: `ai/run` is a request the host sends over the port
  it handed the frame (section 1), and a kit has no request that makes the
  host run steps, so a kit frame cannot claim to be the host. A host MUST NOT
  send `origin` for a model's or an agent's call (UI-H5); only its own
  features send it.

**An engine's refusal of a step's parameters.** When the kit's engine
refuses a step's parameters with a list of what is wrong (an engine built on
`kition-kit` returns `kition_kit::schema::refusal(&errors)`, whose message is
the text, U+001E, and the errors as JSON), `ai/run` fails at that step with
`-32000`, `error.message` the text alone (never the JSON), and `data` `{
reason: "invalid-params", command, step, errors }`, `errors` one `{ path,
message, expected? }` for each wrong parameter as Kit Process Protocol's
`invalid_params` lists them. A kit shows the person the text alone too.

**What an agent's write changed.** A kit whose engine keeps a replica
lists the capability `changes` and answers `ai/version` and `ai/changes` from
it exactly as a headless kit answers Kit Process Protocol's `model.version` and
`model.changes` ([kit-process-protocol.md](kit-process-protocol.md) section 5a): the version
is the replica's, base64 and opaque; the change set since `since` is
`@kition/kdm`'s `changesSince` (`created`, `changed` with each field before
and after, `moved`, `deleted`, by the ids the object model answers), and a
version the replica's history does not hold answers `changes: null` with
`unavailable`, never an empty change set. `schema` is the kit's, as the host
sends it with `model/describe`. Neither request changes the document. The
host reads the version before an agent's write and the change set after it,
so the agent's tools answer the write's receipt (`changes`, `diagnostics`)
as on the headless path; the change set is the whole document's since the
version, so an edit the person made while the write ran is in it too.

**The agent's own editor state.** The person is using the editor while
the agent works, so an agent's step never moves the person's selection,
current part or playhead. A kit whose engine keeps editor state and takes a
call context (engine contract: `editorState()`, `restoreEditorState()`,
`setContext()`, and `editorState()` not `null`) lists the capability
`context` and runs each agent step of an `ai/run` on the live document in an
editor state of the agent's own, in one turn of its engine so the person never
sees it: the person's state is put aside, the agent's put in place (before the
run's first step it is the person's state as it is then), the step's
`context` set, the command run, the agent's state kept for the run's next
step, and the person's put back, however the step ends. A step's `context` is
`{ on?, part?, time? }` as Kit Process Protocol's `context.set` takes it (section
7a there): the host plans it as the headless path does (a step's `on`, `at`,
the run's `target`). A context the kit cannot set fails the step with `data`
`{ reason: "unsupported", command, step }`, and the run is rolled back as
below. A kit without the capability refuses a step that gives `context`
before any step runs, with the same `data`, rather than ignore it; its
agent steps run in the person's editor state. The agent's
draft (section 7d) takes no `context` yet.

**A failed run is atomic.** When a step of an agent's `ai/run` on the
live document fails, the kit takes back the steps before it that changed the
document, as the headless kit does (Kit Process Protocol A53): it runs
`edit.undo` with `{ "scope": "agent" }` as the agent once for each of them,
newest first, so only the agent's steps are undone and the person's own
edits stay. The error keeps its code, message and `data`, and `data` adds:

- `completed`: the steps that stay in the document, `[]` when all were taken
  back; `rolledBack`: the steps taken back (each `{ command, changed,
  result }`, as a run answers them);
- `editedMeanwhile: true` when the document changed between the agent's
  steps by someone else (the person, a co-editor, an import): the agent's
  undo scope keeps their edits, and where they changed what the agent's
  steps made or changed, their change is kept (an object a step created
  goes, with what they did to it), so the document is not simply as it was;
  the message says so;
- the message says what happened in a sentence after the step's failure.

The steps stay (and are `completed`, with no `rolledBack`) when they cannot
be taken back: a step undid or redid edits itself, the engine has no agent
undo scope (it does not run commands as an origin) and someone else edited
meanwhile, or the engine had nothing more to undo; when only some could be,
the newest are in `rolledBack` and the rest in `completed`. A kit runs one
agent `ai/run` on the live document at a time, so a rollback never takes
back another run's steps. Two failures are not rolled back: a step refused
for another session's lease (section 7b: the steps before it stay, and
`data` is as that section says) and a host's own change (`origin:
"system"`), which is a step of no undo history. `@kition/kit-editor` does all
of this; the agent's tools answer the error with `index`, `completed`,
`rolledBack`, `editedMeanwhile` and `saved: false`
([agent tools](../sets/agent.md)).

## 3. Kit to host

### `host/read` (request)

`{ "path", "offset"?, "length"? }` answers
`{ "bytes": ArrayBuffer, "version": string, "size": number }`. Paths are
workspace-relative. A host serves only the document's own file and the files
beside it (its lent files: linked media, fonts, pictures, resolved against
the document's folder), confines every path to the workspace (H3), and never
serves its own data or a hidden path (LR2): `host/read` and `host/stamp`
refuse them (`not-allowed`) exactly as `document.lend` does. A kit reaches
any other file only through a file handle: one the person or the host
granted (section 7g), or a link handle for a file its document links
(section 7i). A file the person chose with `links/pick` is one of the
document's lent files by the path the host answered (UI-N3).

### `host/stamp` (request)

`{ "path" }` answers `{ "version": string | null }`, under the same scope as
`host/read`.

### `host/write` (request)

`{ "path", "bytes": ArrayBuffer, "mode": "save", "expected"? }`
answers `{ "path", "version" }`.

- `save` replaces the document's file atomically (H4). With `expected`, the
  host refuses (`reason: "conflict"`) when the file's version is no longer
  `expected`.
- `path` MUST be the document's own path (`document.path` of
  `ui/initialize`); the host refuses any other path (`not-allowed`), whatever
  its extension. A read-only document refuses every `host/write`
  (`read-only`).
- `save` is the only mode, and there is no `host/pick`: a kit writes any other
  file through `files/create` and `files/write`, and asks the person for a
  file with `files/pick` (section 7g, [`KitFiles 1.1`](../sets/files.md)
  section 11).

### `host/openAgent` (request, capability `agent`)

`{ "prompt"? }` opens the host's agent on this document.

### `host/notify` (notification)

`{ "level": "info" | "success" | "warning" | "error", "title", "description"? }`.
A kit SHOULD show its own notices; this is for the ones the host shows best
(the window is behind, the tab is closing).

### `document/changed` (notification)

`{ "dirty", "revision", "title"?, "by": "person" | "agent" | "system", "originLabel"? }`
after every change, so the host shows the tab's unsaved mark and tells the
agent (A8 `kit.changed`). `by: "system"` is the host's own change
(`ai/run` with `origin: "system"`, section 2), with the `originLabel` it ran
under; `originLabel` is present only then. Kits SHOULD send at most one per
frame while dragging.

### `host/shortcut` (notification)

`{ "key", "code", "meta", "ctrl", "shift", "alt" }`: a key press inside the
kit that is one of the host's `shortcuts`. The kit MUST NOT act on it itself
and MUST forward it, because keys pressed in the frame never reach the host.

## 4. Theme and locale

`theme.tokens` are CSS custom properties. A kit MUST apply them to its
document root, and its styles MUST use them for every color, radius, font, and
shadow they cover, so the editor looks like the host. A kit MAY add its own
tokens for things the list does not cover. The token set:

| Token | Meaning | Kition |
| --- | --- | --- |
| `--kit-font-sans` | Interface font stack | the host's sans stack |
| `--kit-font-mono` | Monospace font stack | the host's mono stack |
| `--kit-surface` | Editor background | `#ffffff` |
| `--kit-surface-muted` | Panels, rails, ribbon background | light neutral |
| `--kit-canvas` | Behind the document (pasteboard) | light neutral |
| `--kit-text` | Primary text | near black |
| `--kit-text-muted` | Secondary text | gray |
| `--kit-border` | Hairlines and control borders | light gray |
| `--kit-primary` | Primary action, selection, focus | `#5645d4` |
| `--kit-primary-text` | Text on primary | `#ffffff` |
| `--kit-primary-soft` | Selected and hovered backgrounds | primary at low alpha |
| `--kit-danger` | Destructive and error | red |
| `--kit-radius-control` | Buttons, inputs | `8px` |
| `--kit-radius-card` | Cards, panels, dialogs | `12px` |
| `--kit-shadow-card` | Card and popover shadow | a light shadow |

`colorScheme` is `light` or `dark`; the tokens already carry the colors for it.

`locale` is a BCP 47 tag. A kit MUST ship its strings for `en-US` and SHOULD
for the host's locales; it falls back to `en-US`.

## 5. Kit obligations

- **UI-K1** The kit's UI, engine worker, WebAssembly, fonts, and assets are
  all in its package and load from the package's own location. It loads
  nothing from the network. A picture the person pasted or dropped by
  its web address reaches it only through the host (`host/fetchImage`,
  section 7l).
- **UI-K2** All file access goes through `host/read`, `host/stamp`,
  `host/write`, `files/*`, and link handles (sections 7g, 7h, and 7i); the
  kit MUST NOT fetch
  workspace files any other way, and MUST NOT send a path in a `files/*`
  request. Bytes the person drops or pastes into the frame itself
  (`File` objects, no path) are theirs to give ([`KitPointer 1.0`](../sets/pointer.md)
  section 9).
- **UI-K3** The engine runs in a Web Worker (standard H1 applies to the kit).
- **UI-K4** The kit MUST NOT touch `window.parent` or `window.top` beyond the
  handshake, and MUST NOT navigate the frame away from its entry.
- **UI-K5** Host shortcuts are forwarded (`host/shortcut`), never handled.
- **UI-K6** Typed text MUST work with input methods (IME composition for
  Chinese, Japanese, Korean): text input goes through a focused editable
  element, not raw key events.
- **UI-K7** A read-only document (`document.readOnly`) refuses every edit on
  every path: menus, buttons, shortcuts, canvas tools, typed text, its own
  panels, and `ai/run` (`-32000`, `error.data` `{ reason: "read-only",
  command, step? }`). `ai/commands` lists the commands that edit with
  `enabled: false`. Viewing still works: zooming, scrolling, moving between
  pages, selecting and copying, and playback. Canvas tools follow their role
  ([`KitPointer 1.0`](../sets/pointer.md) PT2): tools
  that do not change the document (`select`, `text-select`, `hand`, `zoom`,
  and `custom` tools declared `mutates: false`) keep working, in canvas and
  DOM editors alike; tools whose role mutates are refused, and so are the
  editing gestures of a non-mutating tool (Delete, dragging a selected
  object, cut, paste). The kit offers no Save, Undo, or Redo, writes
  nothing with `host/write`, creates no file except exports (`files/create`,
  FA17), and refuses `document/save`. Replica imports (section 7) still apply, so the document
  shows other people's edits; the kit's replica gains no local changes.
  `@kition/kit-editor` implements this in its engine worker, which every engine
  call passes, by the rules it exports as `READ_ONLY_RULES`. (Those rules
  refuse every engine-tool event today, `pointer`, `toolKey`, and
  `toolText` included, so a viewer of an engine-tool kit cannot select or
  copy; that does not conform and is to be fixed in the SDK.) A commenter
  (`document.comments.canComment`) is a viewer who also runs the kit's
  comment commands (`collaboration.comments.commands`, which the kit's editor
  passes as `KitModuleManifest.commentCommands`); `ai/commands` lists them
  enabled. The worker undoes and refuses (`read-only`) a comment command
  whose change touches anything but `CommentThread` and `Comment` objects
  ([`KitModel 1.0`](../sets/model.md) M23). The rest stays as for a viewer: no Save,
  Undo, Redo, or mutating canvas tools other than those whose every effect
  is a comment command (PT2), and nothing unsaved; the comments replicate.

- **UI-K8** The kit MUST NOT open windows or tabs
  (`window.open`, links with a `target`), navigate the top window, or start
  downloads itself. It opens a workspace file with `host/open` and a web
  address with `host/openUrl` (section 7i), and writes files only through
  `host/write` and `files/*`; a host MAY frame kits without
  `allow-popups`, `allow-downloads`, and `allow-top-navigation`.

## 6. Host obligations

- **UI-H1** The host gives the frame the tab's whole content area and draws
  nothing over it.
- **UI-H2** The host answers `host/*`, `files/*`, and `links/*` under the
  same policy as its own file IO (H2 to H6, LR1 to LR5, FA1 to FA18) and
  checks every path and handle; a kit is not trusted with the workspace.
- **UI-H3** The host serves the kit package with a content security policy
  that allows the kit's own scripts, workers, and `'wasm-unsafe-eval'`, and
  nothing from other origins.
- **UI-H4** The host shows the tab's title and unsaved mark from
  `document/changed`, asks before closing a tab with unsaved work, and uses
  `document/save` when the person chooses Save.
- **UI-H5** The host forwards the Kit AI bridge as `ai/*` to the frame of the
  document it targets. It sends `ai/run`'s `origin: "system"` only for
  its own features' changes, never for a call a model or an agent made.
- **UI-H6** The host sends `ui/theme` and `ui/locale` whenever the person
  changes them.
- **UI-H7** `document.readOnly` holds for the whole session: to change it (a
  viewer becomes an editor, or the reverse), the host opens the kit again in a
  new page (a new frame, or the same frame navigated to its entry again), since
  a kit page answers one handshake. The host still refuses a read-only
  document's writes itself.

## 7. Replicas (capability `replica`)

A kit whose engine holds its document as a KDM replica
([`KitModel 1.0`](../sets/model.md)) asks the host to keep the replica's state next to the file,
so the document keeps its object ids, comment threads and checkpoints (section 7m) across
saves, also when its file format cannot carry them (PSD). The host lists `replica` in
`ui/initialize`'s `capabilities` when it serves `host/replicaRead` and
`host/replicaWrite`; the kit lists `replica` in its answer when it uses them
and answers `replica/*`. Either side without it changes nothing: the kit opens
and saves the file alone. `replica/info` and narrower
`replica/export` blobs (UI-R5) are optional for a kit's engine to answer precisely.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/replicaRead` | kit to host | `{ path }` | `{ snapshot, blobs, fileStamp }` or `null` |
| `host/replicaWrite` | kit to host | `{ path, snapshot, blobs, fileStamp, version, checkpoint? }` | `{ checkpoint? }` (`checkpoint`: section 7m) |
| `replica/version` | host to kit | `{}` | `{ version }` |
| `replica/export` | host to kit | `{ since }` | `{ changes, blobs }` |
| `replica/import` | host to kit | `{ changes, blobs }` | `{ damage }` |
| `replica/restore` | host to kit | `{ snapshot, blobs, origin }` | `{ damage }` |
| `replica/changed` | kit to host (notification) | `{ version }` | |
| `replica/info` | host to kit | `{}` | `{ docId }` |

`snapshot`, `blobs`, `version`, `since`, and `changes` are `ArrayBuffer`s in
the KDM's encodings; `blobs` is the engine's blob bundle and `fileStamp` a
version stamp as `host/stamp` answers it. A `snapshot` is the document's
state with its version ([data model](../data-model.md) section 7.4, rules C2 and C10): opaque
bytes to the host, which stores them whole. A `version` is 0 bytes (the empty version) or 24
bytes, the replica's line of changes and its position on it; equal versions are equal bytes.
`since` may be empty (every change: the kit answers a snapshot).
`docId` is the replica's own id, or `null` when the engine keeps none.

- `replica/import` applies changes in order (or a snapshot) like the KDM's `import_changes`. Changes
  that do not follow the replica's version, or whose operations do not fit its state, are refused
  with `error.data.reason` `stale` and change nothing; the host then asks `replica/export` again
  from the version it holds.
- `replica/restore` writes the state `snapshot` holds (a checkpoint's, section 7m) over the
  document as one change of `origin` (`{ kind: 'person', principal, label? }`), keyed by
  object id: one person undo step, so Undo takes the restore back. The kit's engine does it
  (`restoreState`, which `export_kit_session!` provides); the host never computes changes from
  the bytes.
- **UI-R1** The host MUST answer `host/replicaRead` with the snapshot it keeps for `path` whatever
  its `fileStamp`, also when the file changed outside the host since. The kit opens the file with
  that snapshot, so its objects keep their ids; when the file's content differs from the
  snapshot's, its engine records the difference as one `system` change labelled `import`
  ([data model](../data-model.md) section 7.1). The file is always the document: a missing or
  unreadable snapshot is treated as none, and MUST NOT stop the file from opening.
- **UI-R2** After a save (`host/write`), the kit stores the replica taken with
  the saved bytes, never a later one, under the stamp `host/write` answered. A
  failed `host/replicaWrite` MUST NOT fail the save.
- **UI-R3** The host keeps a replica with its document's identity: it follows
  renames and moves of the file, and a copy of the file starts without one.
  It MUST confine `path` like every other host call (UI-H2).
- **UI-R4** The kit sends `replica/changed` after each edit that moved the
  replica's version; it MAY coalesce them while dragging. A host MAY add more
  than one listener for it; every listener hears every notification.
- **UI-R5** `replica/export`'s `blobs` MAY be narrower than the replica's
  whole blob bundle when the kit's engine can tell which blobs the changes
  since `since` actually need; a host MUST NOT assume it received every blob
  the replica ever referenced, only every blob its new changes need.
- **UI-R6** In `host/replicaWrite`, `version` is the version `snapshot` holds. A host refuses a
  `host/replicaWrite` without `version` (`-32602`) and stores nothing.

## 7a. Object model (capability `model`)

A kit that answers the object model itself ([`KitObjectModel 1.0`](../sets/object-model.md)) lists
`model` in its `ui/initialize` answer and serves:

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `model/describe` | host to kit | `{ schema? }` | `{ capability, kit, schemaVersion, root, rootId, types, commands }` |
| `model/batch` | host to kit | `{ origin?, ops, load?, schema? }` | `{ refs, results, loaded, version? }`, or an error whose `data` is `{ code, index, message }` |
| `model/changed` | kit to host (notification) | `{ version }` | |

A batch is then one undo step of the kit's own history. `schema` is the kit's
KDM schema as the host knows it (its `model/schema.json`); a kit whose engine
does not describe its own schema runs the batch with it, and a kit that does
ignores it. `version` is the kit's replica version after the batch (bytes),
so a host can tell its own change from the next `replica/changed`. A
read-only document refuses a batch with any operation (`read-only`) and
answers one that only loads.

`@kition/kit-editor` lists `model` when the document's engine answers it: an
engine with `modelBatch` and `modelDescribe` (`export_kit_session!`) runs the
batch itself, as one step of its own undo history.

## 7b. Leases (capability `lease`)

Some edits do not merge meaningfully when two people make
them at once (repainting one layer's pixels, rewriting a whole PDF). A kit
asks its host for a **lease** on the object's scope before such an edit; a
host that co-edits the document takes it from its sync server (sync protocol
section 8) and keeps it renewed until the kit releases it or closes. A host
that serves leases lists `lease` in `ui/initialize`'s `capabilities`.

A lease, as the kit sees it, is `{ scope, holder: { principalId, name, self } }`:
`self` is true for this session's own leases. Scopes are the kit's own
strings (a KDM object id, `layer:<objectId>`, `*` for the whole document);
two collide when equal or when either is `*`.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/leaseAcquire` | kit to host | `{ scope, ttl? }` | `{ lease }` |
| `host/leaseRelease` | kit to host | `{ scope }` | `{}` |
| `host/leases` | kit to host | `{}` | `{ leases }` |
| `lease/changed` | host to kit (notification) | `{ leases }` | |

- `host/leaseAcquire` takes or renews the lease; `ttl` (milliseconds) is a
  hint for how long one renewal lasts. `lease` is `null` when there is
  nobody to coordinate with (the document is not co-edited, or the host is
  offline): the kit goes ahead. A refusal is
  an error whose `data.reason` is `held` (another session holds a colliding
  scope; `data.lease` names it) or `read-only`.
- `host/leases` answers the document's leases now; `lease/changed` replaces
  the kit's list whenever it changes (a lease taken, released, expired, or
  its holder gone).
- **UI-L1** A host MUST release every lease it holds for a kit when that
  kit's connection closes (its tab closed, the kit opened again).
- **UI-L2** A kit MUST NOT start an edit of a leased scope another session
  holds, and SHOULD show who holds it; it releases its own lease when the
  edit (or a short run of edits) ends.
- An agent's `ai/run` step on the live document is an edit like the
  person's: the kit takes the lease the step's command needs before it and
  releases it after. A step refused because another session holds the
  lease runs nothing (the steps before it stay done) and fails `ai/run`
  with `data` `{ reason: "held", command, step, scope, holder? }`; the kit
  SHOULD also tell the person (`host/notify`). The agent's draft (section 7d)
  takes no leases: only its merge reaches the document.

`@kition/kit-editor`'s `kitLeases(host)`, `useLeases()`, and `useLease(scope)` do
the kit's side; with a host that does not serve `lease`, every acquire is
granted with no lease. For agent steps, `useKitSession`'s `agentLeaseScope`
option names each step's scope (a kit asks its engine, for example a
`leaseScope` extra declared in `kit.json`), and the session takes and
releases it, refuses held ones, and refuses a step that edits without a lease
of its own while another session holds the whole document (`*`).

## 7d. Drafts (capability `draft`)

An agent can edit a **draft** of the document instead of
the live document (`KitAgent 1.4` A12 to A15): the person reviews it and merges
it or discards it. A kit that keeps drafts lists `draft` in its
`ui/initialize` answer; its engine must exchange changes (engine contract 2).

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `ai/run`, `ai/inspect`, `ai/preview` | host to kit | `draft: true` | as in section 2; `ai/run` opens a draft when there is none |
| `model/batch` | host to kit | `draft: true` | as in section 7a, on the draft; a batch with operations opens a draft when there is none (capability `draft-model`) |
| `draft/state` | host to kit | `{}` | `{ state, revision }` |
| `draft/ready` | host to kit | `{}` | `{ state, revision }` |
| `draft/reopen` | host to kit | `{}` | `{ state, revision }` |
| `draft/compare` | host to kit | `{ maxSize?, schema? }` | `{ summary, before, after }` |
| `draft/merge` | host to kit | `{ origin, schema? }` | `{ merged, summary }` |
| `draft/discard` | host to kit | `{}` | `{ state, revision }` |
| `draft/changed` | kit to host (notification) | `{ state, revision }` | |

- A kit that also lists `draft-model` runs object-model batches on the draft
  (`model/batch` with `draft: true`; a batch with operations makes the draft
  `open` again, as an `ai/run` does). A host MUST NOT send `draft: true` on a
  batch to a kit that does not list `draft-model`: an older kit would run it
  on the document.
- `state` is `none` (no draft), `open` (the agent works on it), or `ready`
  (the agent asked for review); `revision` is the draft engine's.
- The kit opens the draft on a fork of the document's replica, in a second
  engine. A draft's `ai/run` never saves and never touches the document,
  its undo history, or its file: after it, the live document's `ai/inspect`
  answers the same content (`details` without the declared editor state and
  the session's bookkeeping, as `ai/inspect` above says), the same `dirty`,
  `canUndo` and `canRedo`, and the file the same bytes. The editor state may
  change meanwhile (the draft bar takes room from the canvas, so a view that
  follows the canvas changes); the host's UI configuration (section 9) and
  read-only rules apply to it as to the document, and a read-only document
  has no draft (reason `read-only`).
- `draft/compare` answers the object-level comparison (`KitAgent 1.4` A13,
  `summary` as `{ created, changed, moved, deleted, texts }`) of the document now
  with the document as merging the draft would leave it, and both sides
  rendered by the kit's engine as base64 PNGs at most `maxSize` pixels on
  the longer side (`null` where the engine cannot render).
- `draft/merge` takes the draft into the document as one undo step of the
  person recorded with `origin` (`{ kind: "agent", principal, label? }`: the
  draft's agent, which the editor passes on to the engine's `mergeChanges`;
  the step is the person's all the same, KitModel M12a),
  reports the edit with `document/changed` (`by: "agent"`), and closes the
  draft; `draft/discard` closes it and leaves the document as it is. When the
  document changed since the draft was opened, the merge follows the data
  model's merge rules (section 6.6, D1 to D9); a collision refuses it
  (`error.data.reason` `stale`, the message naming each object, field and key
  or item), changes nothing, and the draft stays open. `schema` is the kit's KDM schema as the host knows it, as in section 7a.
- **UI-D1** A host MUST send `draft/merge` and `draft/discard` only on the
  person's explicit action (a Merge or Discard button), never from a model's
  output; it MAY let an agent call `draft/ready` and `draft/reopen`.
- **UI-D2** A draft is local to the page that holds it. Its own changes MUST
  NOT be stored as the document's replica (`host/replicaWrite`); only the
  merge reaches the document, as this person's change. Closing the kit drops
  the draft.

`@kition/kit-editor` serves this capability for every contract 2 engine: the
draft is a second engine (its own worker) opened with the document's bytes
and replica (`openWithReplica`). The document's engine compares the draft's
changes with the document (`compareChanges`) and merges them (`mergeChanges`,
one person undo step), so the editor's Undo takes a merge back.

## 7e. Presence (capability `presence`)

The people in a co-edited document see what the others
have selected and where their carets are. A kit tells its host what this
session shares; the host carries it to the others as the person's presence
(sync protocol section 5) and tells the kit what they share. A host that does
this lists `presence` in `ui/initialize`'s `capabilities`; a kit that shares
its selection lists `presence` in its answer.

| Method | Direction | Params |
| --- | --- | --- |
| `presence/set` | kit to host (notification) | `{ selection, caret?, viewport? }` |
| `presence/peers` | host to kit (notification) | `{ peers: [{ principal, name, color, selection, caret?, viewport? }] }` |

- `selection` is the KDM object ids (`KitModel 1.0` M8) of what the person has
  selected, at most 256 (`[]` for nothing); `caret`, when the person types in
  a text field, is `{ object, field, offset }`, the offset counted in Unicode
  scalar values as the object model counts text positions; `viewport` is what
  they look at, in the kit's own shape (a page, a slide id, a rectangle).
  Only object ids travel, never engine-local ones, so every replica of the
  document reads the same selection.
- `presence/peers` replaces the kit's whole list: the other people in the
  document (not this person), each with their display name and a color the
  host picked for them (the sync server's), and the last presence they
  shared. A peer that shares nothing yet has `selection: []`.
- **UI-P1** A kit sends `presence/set` when its selection, caret, or
  viewport changes, at most about ten times a second while the person drags
  or types, and never for an object id it does not have. A read-only session
  (a viewer) shares its presence too: where it looks, never an edit.
- **UI-P2** A kit draws each peer's selection and caret in the peer's color
  with their name, over its own canvas, never into the document, and drops
  ids it does not find (an object the person deleted meanwhile).
- **UI-P3** Both sides check what they receive: a host takes at most 256
  string ids, a well-formed caret, and an object viewport, and leaves anything
  else out (`parsePresence` and `parsePeers` in `@kition/kit-ui-protocol`).
- The host's object model (`@kition/script`) fires `selection` (`{ ids }`) from
  `presence/set`, so a script hears what the person selects.

`@kition/kit-editor`'s `kitPresence(host)`, `usePresence(local)`,
`useRemoteSelections(locate)`, and `useRemoteCarets(locate)` do the kit's side;
with a host that does not serve `presence`, nothing is sent and the peer list
stays empty.

## 7f. Schema reports (`document/schema`)

A kit's document may hold changes a newer version of the
kit wrote (`KitModel 1.0` M5a: every commit records its author's schema
version). The kit keeps working on it, and tells the host, which tells the
person and offers the update:

| Method | Direction | Params |
| --- | --- | --- |
| `document/schema` | kit to host (notification) | `{ reads, newestAuthor }` |

`reads` is the schema version the kit's replica reads, `newestAuthor` the
newest one the document's changes were written under; the kit sends it only
when `newestAuthor` is above `reads`, once for each newer version, when the
document opens and after `replica/import`. A host shows a notice that never
blocks editing (a change the kit refuses because a newer kit raised the
document's minimum schema version, rule M20, fails `replica/import` with
reason `newer-schema` instead, and the host keeps the document read-only).
`@kition/kit-editor` sends it from the engine's `schemaVersion()` and
`authorSchemaVersion()` (engine contract 2), and `@kition/kit-host` hands it
to the host's `schema` handler.

## 7g. Files (capabilities `files`, `files-pick`, `print`)

A kit reaches files other than its document only through
**file handles** the host grants ([`KitFiles 1.1`](../sets/files.md)): the
person picks them, the host creates them, or an agent's command names them.
A host that serves the methods below lists `files` in `ui/initialize`'s
`capabilities`, `files-pick` when it shows a picker, and `print` when it
prints. A kit that uses them declares the capability `files` and its `files`
lists in `kit.json` (K15). `bytes` are `ArrayBuffer`s; `stat` is
`{ handle, name, kind, size?, mime?, version, rights }` (FA3).

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `files/pick` | kit to host, `files-pick` | `{ purpose, mode: "open" \| "folder" \| "save", accept, multiple?, suggestedName? }` | `{ files: [stat] }`, empty when the person cancels |
| `files/create` | kit to host, `files` | `{ suggestedName, mime?, folder? }` | stat of a new file handle with right `create` |
| `files/stat` | kit to host, `files` | `{ handle }` | stat |
| `files/read` | kit to host, `files` | `{ handle, offset?, length? }` | `{ bytes, version, size }` |
| `files/list` | kit to host, `files` | `{ handle }` (a folder, right `read`) | `{ files: [stat] }` |
| `files/write` | kit to host, `files` | `{ handle, bytes, offset, final?, expected? }` | `{}`, or `{ version }` when `final` |
| `files/release` | kit to host, `files` | `{ handles }` | `{}` |
| `files/print` | kit to host, `print` | `{ bytes, mime: "application/pdf", title }` or `{ handle, title }` | `{ printed }` |
| `files/revoked` | host to kit (notification) | `{ handles }` | |

- The rules are those of `KitFiles 1.1`: handles (FA1 to FA5), grants (FA6
  to FA8), staged writes (FA9, FA10), printing (FA11), and the host's policy
  (FA13 to FA17). A refusal is `-32000` with `error.data.reason` one of
  `file-not-granted`, `not-allowed`, `no-gesture`, `already-committed`,
  `conflict`, `unsaved-edits`, `quota`, `unsupported`, or `io-error`
  (`KitFiles 1.1` section 10).
- `files/pick` and `files/print` are sent only from a person's gesture in the
  kit (a click or key handler); a host MAY refuse them otherwise
  (`no-gesture`).
- **UI-F1** A host MUST NOT put a workspace path, an absolute path, or a
  page's file id in any `files/*` answer: only handles and display names
  (FA-P2). A host MUST refuse a file the kit may not see (LR2, FA8) the same
  way whether it exists or not.
- **UI-F2** The kit's engine reads a granted file through its lent-file path
  with the handle in place of a path (E15); a host serves those reads from a
  handle-scoped URL (or the kit's binding reads ahead with `files/read`) and
  refuses a handle the session was not granted.
- **UI-F3** A kit hides the features that need `files-pick` or `print` when
  the host does not list them, and shows every `quota` or `not-allowed`
  refusal to the person.

`@kition/kit-editor`'s `connectHost().files` offers `pick`, `create`, `stat`,
`read`, `list`, `write`, `release`, and `print`, and writes an engine's
outputs (E16, `takeOutput`) to their handles in chunks.

## 7h. Selection and hit testing (capabilities `selection`, `hit-test`)

A kit tells its host what the person has selected, and
the host's agent reads it, points the person at something, or asks what a
point in a preview shows ([`KitPointer 1.0`](../sets/pointer.md)). A kit
that reports its selection lists `selection` in its `ui/initialize` answer;
one that answers `ai/hitTest` lists `hit-test`. A host that relays the
selection to its agent lists `selection` in `ui/initialize`'s
`capabilities`. The selection's shape is `KitPointer 1.0` PT7.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `selection/changed` | kit to host (notification), `selection` | `{ selection }` | |
| `ai/selection` | host to kit, `selection` | `{}` | `{ selection }` |
| `ai/select` | host to kit, `selection` | `{ selection, reveal? }` | `{ selection }`, what the kit selected |
| `ai/hitTest` | host to kit, `hit-test` | `{ x, y, space: "preview" \| "document", page?, target?, scale?, maxSize?, draft? }` | `{ hits: [{ id, type?, bounds, page? }] }` |
| `files/dropped` | host to kit (notification), `files` | `{ files: [stat], x, y }` | |

- **UI-S1** A kit sends `selection/changed` whenever its selection changes,
  at most about ten times a second during a gesture and once more when it
  ends, with ids it has (PT8). A read-only session reports its selection
  too. A kit that also shares presence (section 7e) derives `presence/set`
  from the same selection.
- **UI-S2** `ai/selection`, `ai/select`, and `ai/hitTest` change no
  document state and run in read-only sessions. `ai/select` drops ids the
  kit does not find, and is refused with `-32000` and reason `busy` while
  the person is in a gesture; with `reveal: true` the kit moves its view
  only when the person has not pointed, scrolled, or typed in the editor
  during the last two seconds (PT9).
- **UI-S3** A host sends `ai/select` only while no gesture is reported busy
  and only for the person's own agent, and gives `ai/selection`'s answer
  (and `selection/changed`) only to that person's own agent, never another
  person's (PT12).
- **UI-S4** Both sides check what they receive, as for presence (UI-P3): a
  host takes at most 256 string ids or 64 ranges, well-formed positions, and
  a known `kind`, and leaves anything else out.

`ai/hitTest` takes the same `page`, `target`, `scale`, and `maxSize` the
preview was rendered with, so `space: "preview"` coordinates are pixels of
that image (`KitPointer 1.0` section 8). `files/dropped` hands the kit `read`
handles for files the person dropped on its frame, granted under
[`KitFiles 1.1`](../sets/files.md) (`KitPointer 1.0` section 9); `x` and `y`
are in the frame's CSS pixels.

## 7i. Links, previews, and opening (capabilities `links`, `preview-files`, `open-file`, `open-url`, `render`, `links-pick`)

A kit reads the files its document
links, asks the host for pictures of other kits' files, opens files and web
addresses in the host, and asks the person for a file to link; a host keeps
links working when files move
([`KitLinks 1.0`](../sets/links.md)). A host lists `links`,
`preview-files`, `open-file`, `open-url`, and `links-pick` in `ui/initialize`'s
`capabilities` for what it serves, and `"KitLinks 1.0"` in
`capabilitySets` when it serves `links`. A kit that reports and retargets
links lists `links` in its answer and its manifest (K18); a kit that draws
previews of its documents for a host lists `render`. `linkRef` is
`{ path?, name?, docId? }`, `link` the shape of `KitLinks 1.0` section 2,
`view` a link's `view`.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `links/changed` | kit to host (notification), `links` | `{ links: [link] }` | |
| `links/resolve` | kit to host, `links` | `{ links: [linkRef] }` | `{ resolved: [{ exists, path?, docId?, kit?, name, version?, file? }] }` |
| `links/backlinks` | kit to host, `links` | `{}` | `{ backlinks: [{ source: { path, name, docId?, kit? }, link }] }` |
| `links/backlinksChanged` | host to kit (notification), `links` | `{}` | |
| `links/targetChanged` | host to kit (notification), `links` | `{ link: linkRef, exists, version?, path? }` | |
| `links/retarget` | host to kit, kit lists `links` | `{ from: { path, docId? }, to: { path, docId? }, origin }` | `{ changed, links: [id] }` |
| `links/pick` | kit to host, `links-pick` | `{ purpose, accept, multiple? }` | `{ links: [{ path, name, version }] }`, empty when the person cancels |
| `host/preview` | kit to host, `preview-files` | `{ link: linkRef, view?, width, height, scale?, background? }` | `{ image, mime, width, height, version, kit, name, area? }` |
| `host/open` | kit to host, `open-file` | `{ link: linkRef, view?, placement?, create? }` | `{ opened }` |
| `host/openUrl` | kit to host, `open-url` | `{ url }` | `{ opened }` |
| `document/reveal` | host to kit (notification) | `{ view }` | |
| `view/render` | host to kit, kit lists `render` | `{ view?, width, height, scale?, background? }` | `{ image, mime, width, height, area? }` |

- The rules are those of `KitLinks 1.0`: linked reads (LR1 to LR6),
  previews (PV1 to PV8), opening (OP1 to OP9), and the link index (LK1 to
  LK13). A refusal is `-32000` with `error.data.reason` one of `not-found`,
  `not-linked`, `no-kit`, `too-large`, `timeout`, `busy`,
  `unsupported-view`, `render-failed`, `no-gesture`, or `not-allowed`
  (`KitLinks 1.0` section 11), or `read-only` for `links/retarget` and
  `links/pick` (UI-N4).
- `links/resolve`'s `file` is a KitFiles stat of a `read` handle granted
  by the link flow ([`KitFiles 1.1`](../sets/files.md) FA18). The kit's
  binding maps the link's stored path to it, and the engine reads it through
  `kition_kit::host` with that path (LR6); the host serves those reads from
  a handle-scoped capability URL or through `files/read` (UI-F2).
- `host/open` and `host/openUrl` are sent only from a person's gesture in
  the kit (OP1, OP6); a host MAY refuse them otherwise (`no-gesture`). Both
  work in read-only documents.
  - `@kition/kit-ui-protocol`'s `parseOpenParams` checks `host/open`'s params
    and `isOpenableUrl` an address (OP7); `@kition/kit-host`'s `mountKit`
    lists `open-file` and `open-url` for the host's `open` and `openUrl`
    handlers, answers malformed params with `-32602`, and refuses other
    schemes as `not-allowed` before `openUrl` runs.
    `@kition/kit-dev-host` serves both for a kit's flow tests (`open: true`
    or `?open=1`; `opens` keeps the requests, `openAnswer` is the answer):
    links resolve against the document's folder or by name, a missing one is
    `not-found` unless `create` asks for it.
- `links/retarget` runs the kit's `link.retarget` command (LK2) as one
  transaction with the given `origin` (`kind: "system"` for a host's
  rename); in a read-only document it is refused (`read-only`, LK11). The
  host sends it only after a rename or move it performed (LK8).
- `view/render` is sent only to a frame opened with `document.preview`
  (section 2). It draws the document as PV2 says, with the engine's
  `render` or `renderArea` and, for `view`, the extra `areaOf` (E19), and
  answers `unsupported-view` without it. It changes nothing.
- **UI-N1** The host never sends an absolute path, a host URI, or a path
  above the workspace in any `links/*` or `host/preview` answer; paths are
  document-relative (HC-P2), `name` is a last segment, and files are
  handles. Both sides check
  what they receive as for presence (UI-P3): at most 10,000 links in
  `links/changed`, `text` at most 200 characters, well-formed references.
- **Picking a file to link** (capability `links-pick`).
  A kit whose document refers to other workspace files by path (a design's
  library files, a slide's linked picture) asks the person to choose one
  with `links/pick`; the file stays where it is and the document links it.
  `purpose` is a short English sentence the host MAY show, `accept` lists
  extensions without the dot (at least one), `multiple` (default `false`)
  lets the person choose several.
  - **UI-N2** The host shows its own chooser of the workspace's existing
    files whose extension is in `accept`: never a hidden path or the host's
    data (LR2), never anything outside the workspace (H3), and not the
    document itself. It copies, moves, and imports nothing; a file from
    outside the workspace is not offered (a kit that wants one asks with
    `files/pick`, section 7g). It answers each chosen file as
    `{ path, name, version }`: `path` in the document-relative form of
    HC-P2 (relative to the document's folder, `../` where the file is
    elsewhere, never absolute and never above the workspace root), `name`
    its last segment, `version` its version stamp. The answer is empty when
    the person cancels. The kit sends `links/pick` only from a person's
    gesture; a host MAY refuse it otherwise (`no-gesture`).
  - **UI-N3** *Read scope.* A path `links/pick` answered is one of the
    document's lent files: the kit stores it as the link's path and reads
    the file with `host/read` and `host/stamp` (and its engine through
    `document.lend`), by the workspace path that the link names from the
    document's folder. The host serves those reads, in this session and in
    later ones while the document names the file, under H3 (the path
    resolves against the document's folder and nothing resolves above the
    workspace root) and LR2, and refuses the same paths it would never
    offer (`not-allowed`). A kit that lists `links` MAY read it through a
    link handle instead (`links/resolve`, LR1). The kit watches the
    file's version with `host/stamp` to learn of changes.
  - **UI-N4** Linking a file changes the document, so a host does not list
    `links-pick` for a read-only document (UI-K7) or a preview
    (`document.preview`), and refuses a `links/pick` there with reason
    `read-only`. A kit hides the controls that need it when the host does
    not list it (HC-P3); they work in hosts without it by other means (a
    path typed in, or a file the kit's own package brings).
  - `@kition/kit-ui-protocol` types it (`KitLinksPickParams`,
    `KitPickedLink`), checks its params (`parseLinksPickParams`), and turns
    a workspace path into the document-relative form (`linkPathFrom`).
    `@kition/kit-host`'s `mountKit` lists `links-pick` for the host's
    `pickLinks` handler, except in a read-only document; answers malformed
    params with `-32602`; hands the handler the checked params; and turns
    the workspace paths it answers into UI-N2's links, leaving out hidden
    paths, the document itself, and files outside `accept`.
    `@kition/kit-editor`'s `connectHost()` offers `pickLinks`.
    `@kition/kit-dev-host` serves it from its in-memory workspace: the
    answers `scriptLinkPick` queues; else, in an automated browser, the
    files `pickable` names; else a chooser of those files with "Choose from
    computer…", which copies the person's files into the workspace
    (`linkPicks` keeps the requests).

## 7j. Host generation and host actions (capabilities `generate`, `action:<id>`)

These are **Kition platform requests**, not part of KHP:
a kit stays offline and self-contained (UI-K1), so anything that needs a
model, the person's account, or a host feature goes to the host. The first
user is the Table kit: AI fields build their prompts and apply results in the
engine and ask the host for the model call, and button fields ask the host to
run a workflow or make a design from a record.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/generate` | kit to host, `generate` | `{ purpose, output, model?, messages, options? }` | `{ text?, image?, model?, usage? }` |
| `host/action` | kit to host, `action:<id>` | `{ id, params }` | `{ done, message? }` |

- **`host/generate`.** A host that runs models for kits lists `generate` in
  `ui/initialize`'s `capabilities`.
  - `purpose` names what the kit generates for, so the host can show it and
    account for it. It is a **defined purpose** or one of the **kit's
    own**:

    | Purpose | What the kit generates |
    | --- | --- |
    | `ai-field` | An AI field's cell, from the record's values |
    | `rewrite` | Text the person selected, rewritten as they asked (improve, shorten, expand, change the tone, fix the spelling, translate). The kit shows the answer as a suggestion, and writes it (UI-G3) only when the person accepts it |
    | `<kit>.<name>` | Anything else, named by the kit: `<kit>` is its id without `kit.` (`note` for `kit.note`), `<name>` lowercase letters, digits, and hyphens (`note.outline`) |

    - **UI-G4** A kit sends only defined purposes and its own. A host that
      lists `generate` serves every defined purpose (it still refuses a run
      for the reasons below); it MAY refuse a kit's own purpose
      (`not-allowed`), and MUST refuse one that names another kit, or any
      other string, with `not-allowed`. A kit uses a defined purpose where
      one fits, so hosts show and account for the same work alike across
      kits: a text editor's polish, shorten, and expand are `rewrite`, not a
      purpose of its own.
    - `@kition/kit-ui-protocol`'s `GENERATE_PURPOSES` lists the defined
      purposes and `isGeneratePurpose(purpose, kitId)` checks one;
      `@kition/kit-host`'s `mountKit` refuses the others (UI-G4) before the
      host's `generate` handler runs.
      `@kition/kit-dev-host` serves `host/generate` from a script for a
      kit's flow tests (`generate: true` or `?generate=1`; `scriptGenerate`
      queues answers or refusals, `generated` keeps the requests).
  - `output` is `text` or `image`.
  - `model` is the document's preference (a model id the field stored), a
    hint only: the host runs the person's model settings and MAY use another
    model (it answers the one it used in `model`).
  - `messages` are `[{ role, parts }]`, `role` one of `system` and `user`,
    each part `{ type: "text", text }` or `{ type: "image", mime, bytes }`
    (`bytes` an `ArrayBuffer`, transferred) or `{ type: "image", url }` for
    an `http(s):` address the document names.
  - `options` are `{ maxTokens?, temperature?, size? }` (`size` for images,
    `WIDTHxHEIGHT`); the host MAY ignore any of them.
  - The answer carries `text` for `output: "text"` and
    `image: { mime, bytes }` for `output: "image"`, and MAY carry
    `usage: { inputTokens?, outputTokens? }`.
  - **UI-G1** The kit sends `host/generate` only for a run the person asked
    for (a run button, a batch over a column) or one the document's own
    configuration makes on an edit the person made, never in the background
    on open. The host MAY ask the person before it spends their credits.
  - **UI-G2** The host never gives the kit a key, a token, a model endpoint,
    or account details; the kit sees only the answer. The kit sends only what
    its document holds (cell values and its own blobs).
  - **UI-G3** The kit writes the answer into its document itself, as an
    engine command (an edit like any other, with the origin the kit records
    for it); the host never writes the kit's document for this request.
  - A refusal is `-32000` with `error.data.reason` one of `unavailable` (no
    model configured), `not-allowed`, `quota` (no credits left), `refused`
    (the person or the model's provider declined), `too-large`, `timeout`,
    or `failed`. The kit shows it on the cell or the run and keeps the
    document as it was.
  - Without `generate` (a third-party host, an embed without a model), the
    kit hides what needs it: an AI field's cells stay editable values and its
    run controls do not show.
- **`host/action`.** A host lists each action it serves as a capability
  `action:<id>`; the kit offers a control for an action only when the host
  lists it, and sends `host/action` only from a person's gesture. Defined ids:
  - `workflow.run`: `params` `{ workflowId, tableId, recordId }`: run one of
    the host's workflows on a record of this document (a button field's
    "run workflow" action). The workflow's own writes reach the document
    through the kit like any host write; the host does not answer them here.
  - `design.fromRecord`: `params` `{ title, fields, record? }`: make a new
    design from a record's values (`record` `{ tableId, recordId, field }`
    when the design is linked back to a cell).
  - Other ids are the host's: a kit names them in its documentation, and a
    host that does not list one never receives it.
  - `done` says whether the host ran it; `message` is a short text the kit
    MAY show. A refusal is `-32000` with `error.data.reason` one of
    `not-allowed`, `no-gesture`, `not-found`, or `failed`.
- `@kition/kit-ui-protocol` types both (`KitGenerateParams`,
  `KitGenerateResult`, `KitGeneratePurpose`, `KitActionParams`,
  `KitActionResult`, the reason lists `GENERATE_ERROR_REASONS` and
  `ACTION_ERROR_REASONS`, `GENERATE_PURPOSES`, `isGeneratePurpose`, and
  `hostRequestErrorReason`); a kit sends them through the host connection's
  `peer` (`peer.request("host/generate", …)`). `@kition/kit-host`'s
  `mountKit` routes them to the handlers `generate` and `actions` (one per
  action id) and lists `generate` and each `action:<id>` it serves.

## 7k. Host services and comment anchors (capabilities `service:<id>`, `comment-anchors`)

For managed co-editing ([managed-collab.md](../managed-collab.md)
section 4); these are **Kition platform requests**, not KHP. A kit
asks its host for anything that needs the host's people, files, dialogs, or
permissions, so the same kit behaves as a native part of every host.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/service` | kit to host, `service:<id>` | `{ service, params }` | per service, below |
| `comments/show` | host to kit (notification), `comment-anchors` | `{ threads: [{ id, anchor, resolved, count }] }` | |
| `comments/locate` | host to kit, `comment-anchors` | `{ anchors }` | `{ found: [bool] }` |
| `comments/activated` | kit to host (notification), `comment-anchors` | `{ id }` | |

| `service` | Params | Result |
| --- | --- | --- |
| `file.pick` | `{ purpose, accept }` (as `files/pick`) | `{ files }`, grants as `files/pick` answers them (section 7g) |
| `image.insert` | `{ accept? }` | `{ image: { name, mime, bytes } \| null }` |
| `people.mention` | `{ query, limit? }` (`limit` 1 to 100) | `{ people: [{ id, name, avatar? }] }`, only people the host lets this person see |
| `people.notify` | `{ people: [id], message, anchor? }` | `{ notified: [id] }` |
| `share.open` | `{}` | `{ done }`: the host's share dialog |
| `file.rename` | `{ name? }` | `{ name \| null }` |
| `file.saveAs` | `{ name?, format?, bytes }` | `{ path \| null }` |
| `access.request` | `{ perm: "edit" \| "comment" }` | `{ requested }` |
| `editor.close` | `{}` | `{ closed }` |
| `comment.create` | `{ anchor, text? }` | `{ thread \| null }`, the host's thread id |

- **UI-V1** A host lists each service it serves as the capability
  `service:<id>`. A kit sends `host/service` only for a listed service and
  only from a person's gesture (`people.mention` also while they type after
  `@`). Refusals are `-32000` with `error.data.reason` one of `not-allowed`,
  `no-gesture`, `cancelled`, `not-found`, `failed`; malformed params `-32602`.
- **UI-V2** A kit that has a host service shows no version of its own: no
  share dialog, file browser, or people list of its own.
- **UI-V3** Both sides check what they receive: `message` at most 2 000
  characters, at most 256 people, `bytes` an `ArrayBuffer` within the host's
  file limit, and anchors as below.
- **UI-V4** A host offers (`service:<id>`) and serves a service only when the
  document's permissions allow it: `comment.create`, `people.mention` and
  `people.notify` need comment rights (not `readOnly`, or
  `document.comments.canComment`); `file.pick`, `image.insert` and
  `file.rename` need edit rights; `file.saveAs` needs `download` or `export`;
  `share.open` needs `share`; `access.request` and `editor.close` need
  nothing. `@kition/kit-ui-protocol`'s `serviceAllowed` is the rule, and
  `mountKit` applies it to the capabilities it lists and to every request.
- **UI-V5** A host treats every service request as unsolicited, whatever the
  kit says about a gesture: it confirms `file.rename` and `file.saveAs` in its
  own dialog (the kit's `name` is a suggestion), sends `people.notify` only
  after the person confirms it or as part of a comment they posted, and
  rate-limits `people.mention` and `people.notify` per person.
- **UI-V6** Ids, quotes, labels, comment text and messages are plain text: a
  host renders them as text only, never as markup, and both sides refuse
  control characters (lines and tabs only in quotes, comment text and
  messages) and bidirectional formatting characters (U+202A to U+202E,
  U+2066 to U+2069, U+200E, U+200F, U+061C).
- An **anchor** is `{ ids, range?, quote?, page?, label? }`: 1 to 256 object
  ids of the selection (`KitPointer 1.0` PT7), a text range `{ start, end }`
  in the first id's text, the quoted text and a label of at most 500
  characters each, and a page. A host that keeps comment threads itself lists
  `comment-anchors`; a kit that lists it too sends `comment.create` for a new
  thread instead of writing one into its document, draws a marker for each
  thread of `comments/show` (the whole list each time), answers
  `comments/locate`, and sends `comments/activated` when the person clicks a
  marker. Kits that keep threads in their document (M23) keep doing so with
  hosts that do not list it.
- `@kition/kit-ui-protocol` types them (`HOST_SERVICES`, `KitHostServices`,
  `KitServiceParams`, `KitCommentAnchor`, `KitShownThread`,
  `SERVICE_ERROR_REASONS`) and checks them (`parseServiceParams`,
  `parseCommentAnchor`, `serviceAllowed`); `@kition/kit-host`'s `mountKit` routes
  `host/service` to the handlers `services` (one per id, refusing the rest and
  malformed params before they run) and `comments.activated`, and its
  connection has `showComments` and `locateComments`; `@kition/kit-editor`'s
  `HostConnection` has `hasService`, `service`, `commentAnchors`,
  `onComments`, `activateComment`, and `locateComments`.

## 7l. Fetching pictures (capability `fetch-image`)

HTML a person pastes or drops from a web page carries its
pictures as web addresses (`<img src="https://…">`), often signed addresses
that expire within minutes. A kit loads nothing from the network (UI-K1), so
it asks the host to download such a picture and keeps the bytes as it keeps a
pasted file (`files/create`, or a file beside its document); the document
then links the kept copy, never the address.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/fetchImage` | kit to host, `fetch-image` | `{ url }` | `{ bytes, mime }` |

- **UI-I1** A kit sends `host/fetchImage` only for a picture the person
  pasted or dropped, while it handles that paste or drop, and only for an
  `https:` or `http:` address. It keeps the answer at once and links the kept
  file in place of the address. A picture the host refuses keeps its address,
  and the kit tells the person.
- **UI-I2** A host that serves it lists `fetch-image` in `ui/initialize`'s
  `capabilities`, except for a read-only document (`document.readOnly`),
  where it refuses every `host/fetchImage` (`read-only`). It refuses any
  other scheme (`not-allowed`) before any download.
- **UI-I3** The host downloads from public addresses only: never the
  person's computer or local network (loopback, private, link-local, and
  unique local addresses, `localhost`), checked again at every redirect, so
  a pasted page cannot reach the host's own API or the person's network
  (`not-allowed`). It sends no cookies or credentials of its own.
- **UI-I4** `mime` is one of `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, `image/svg+xml`, `image/avif` (`FETCH_IMAGE_TYPES`), from the
  response's type or, when the response does not say, its bytes. Any other
  answer is refused (`unsupported`). The host keeps a size limit and refuses a
  larger picture (`quota`) rather than answering part of it; a failed
  download is `io-error`.
- A refusal is `-32000` with `error.data.reason` one of `not-allowed`,
  `unsupported`, `quota`, `io-error`, or `read-only`
  (`FETCH_IMAGE_ERROR_REASONS`).
- `@kition/kit-ui-protocol` types it (`KitFetchImageResult`,
  `FETCH_IMAGE_TYPES`, `FETCH_IMAGE_ERROR_REASONS`) and checks it
  (`isFetchableUrl`, `fetchImageErrorReason`); `@kition/kit-host`'s `mountKit`
  routes it to the handler `fetchImage`, refusing other schemes, read-only
  documents, and answers that are not pictures before or after it runs.

## 7m. Checkpoints (capability `checkpoints`)

A file holds no history ([data model](../data-model.md) section 7.3): a document's
history is kept by the host. A **checkpoint** is the document's state at one moment (a saved
version a person labelled, the host's save, an agent's run) so a kit can list earlier versions,
show one, restore one, and let the person name or remove the ones the kit made. The host stores
each checkpoint's snapshot (the replica write's, section 7), the same bytes once. There are no
branches: a checkpoint is read, or restored as a new change (`replica/restore`, section 7).

The host lists `checkpoints` in `ui/initialize`'s `capabilities` when it serves the methods
below; it serves them only together with `replica` (section 7), since a checkpoint is recorded
with a replica write. A kit uses them only when listed.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/replicaWrite` | kit to host | `{ path, snapshot, blobs, fileStamp, version, checkpoint? }` | `{ checkpoint? }` |
| `host/checkpointList` | kit to host | `{ path, labelled?, before?, limit? }` | `{ checkpoints, more }` |
| `host/checkpointUpdate` | kit to host | `{ path, id, label?, description? }` | `{ checkpoint }` |
| `host/checkpointDelete` | kit to host | `{ path, id }` | `{}` |
| `host/checkpointRead` | kit to host | `{ path, id }` | `{ checkpoint, blobs, snapshot }` |

A checkpoint is `{ id, time, origin, author?, label?, description?, version }`
(`KitCheckpoint`): `time` in milliseconds since the Unix epoch; `origin` who made it (`kit`
for the kit's own; the host's are `save`, `agent`, and others it names); `version` the version
of its snapshot, base64, as `ai/version` answers it.

- **UI-C1** A checkpoint is recorded with the replica write that holds its state:
  `host/replicaWrite` with `checkpoint: { label?, description?, author?, origin? }` stores the
  snapshot and records a checkpoint of it, at the write's `version` (UI-R6), in one step, and
  answers it. So a labelled checkpoint holds the document as it was saved, never an edit made
  while the save was being written. `origin` is `kit` or absent (which means `kit`). Recording
  at the version of the newest checkpoint answers that checkpoint; a request with a label
  upgrades it: it takes the label and description and becomes the kit's (`origin: kit`), so the
  person can rename or remove it. A checkpoint is never recorded apart from a replica write.
- **UI-C2** `host/checkpointList` answers newest first, at most `limit` (default and maximum 200),
  only labelled ones with `labelled: true`, and only those older than the checkpoint `before`
  when given; `more` tells whether older ones remain. An unknown `before` is `not-found`.
- **UI-C3** A kit updates or deletes only checkpoints whose `origin` is `kit`. The host's own are
  listed and read like any other, but `host/checkpointUpdate` and `host/checkpointDelete` refuse
  them (`read-only`). In `host/checkpointUpdate` an absent field is kept and an empty string
  removes it. A read-only document (`document.readOnly`) refuses every update, delete, and
  `checkpoint` request (`read-only`).
- **UI-C4** `host/checkpointRead` answers the checkpoint's snapshot and the blobs it needs. The
  kit reads the state from the snapshot (a replica loaded from it, or the engine's
  comparison with the document now); `replica/restore` writes it over the document.
- **UI-C6** Labels are at most 200 characters (`CHECKPOINT_LABEL_LIMIT`) and descriptions at most
  2000 (`CHECKPOINT_DESCRIPTION_LIMIT`); longer ones are refused (`too-long`). A checkpoint changed
  or deleted by someone else meanwhile is refused (`conflict`); an unknown `id` is `not-found`.
  A labelled checkpoint is never dropped to make room for others: the host thins unlabelled ones
  under a limit of their own.
- A refusal is `-32000` with `error.data.reason` one of `not-found`, `too-long`, `read-only`, or
  `conflict` (`CHECKPOINT_ERROR_REASONS`). A refused `checkpoint` in `host/replicaWrite` stores
  nothing: the kit's save still succeeds (UI-R2), without the checkpoint.
- `@kition/kit-host`'s `mountKit` routes these to the handler `checkpoints` (`find`, `list`,
  `update`, `delete`, `read`) and checks the lengths, the origin, read-only documents, and
  unknown ids before the handler runs. `@kition/kit-editor` offers them as
  `listCheckpoints`, `updateCheckpoint`, `deleteCheckpoint`, `readCheckpoint`, and
  `useKitDocument`'s `saveCheckpoint`; without the capability they answer `null` and record
  nothing.
- `@kition/kit-dev-host` serves them for a kit's flow tests (`checkpoints: true` or
  `?checkpoints=1`, with the replica; `replica: true` or `?replica=1` for the replica alone), in
  memory for the page load and per workspace path. A checkpoint's `version` is the replica
  write's `version` (UI-R6); it keeps each one's snapshot and blobs, so
  `host/checkpointRead` answers them after later saves. `devHost.reload()` reopens the document as
  its last save left it and keeps its replica and checkpoints; `devHost.reopenChanged(bytes)`
  changes the file outside the editor (a new version) and reopens it, handing the stored snapshot
  over under its earlier stamp (UI-R1); `devHost.open()` opens a file alone.
  `devHost.recordCheckpoint({ origin: 'save' })` plays the host's own;
  `devHost.history.checkpoints(path)` lists them all.

## 7n. View state (capability `view-state`)

Where the person was in a document (the page, the zoom, the camera, open panels, a selection to
restore) belongs to that person on that device, not to the document: a kit never writes it into
the file or the replica. A host that serves `view-state` keeps one value per document and person
(or device) in its own data, outside the workspace.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/viewStateRead` | kit to host | `{ path }` | `{ state, bytes? }` |
| `host/viewStateWrite` | kit to host | `{ path, state, bytes? }` | `{}` |

`state` is a JSON object or `null`; `bytes` an optional `ArrayBuffer` (a thumbnail cache, a
camera path).

- **UI-S1** The value is written whole: the last write wins, `state: null` deletes it. The kit
  versions its own payload (a `v` field) and ignores one it cannot read.
- **UI-S2** `state`'s JSON is at most 256 KB (UTF-8, `VIEW_STATE_JSON_LIMIT`) and `bytes` at most
  16 MB (`VIEW_STATE_BYTES_LIMIT`); a larger value is refused (`too-large`) and nothing is kept.
- **UI-S3** A host keeps view state per document and per person or device, in its own app data:
  never in the workspace, the replica, or the file, never synced to other people. It follows
  the document like the replica (UI-R3) when it can; losing it loses nothing of the document.
  A missing or damaged value reads as `{ state: null }`. It confines `path` like every other
  host call (UI-H2).
- **UI-S4** A failed `host/viewStateWrite` MUST NOT fail a save or an edit: the kit goes on
  without it. A read-only document may keep view state (it is the person's, not the document's).
- A refusal is `-32000` with `error.data.reason` `too-large` (`VIEW_STATE_ERROR_REASONS`).
- `@kition/kit-host`'s `mountKit` routes these to the handler `viewState` (`read`, `write`) and
  checks the value and its size; `@kition/kit-editor` offers `readViewState` (`null` without the
  capability or on any failure) and `writeViewState` (does nothing without it, never throws), and
  `useKitDocument`'s `viewState` option writes the value after each save.
- `@kition/kit-dev-host` serves it for a kit's flow tests (`viewState: true` or `?view-state=1`):
  one value per workspace path, in memory for the page load, apart from the replica; it survives
  `devHost.reload()` and `devHost.open()`, and `devHost.history.viewState(path)` answers it.

## 8. Libraries

- `@kition/kit-host` (host side): `mountKit(frame, options)` performs the
  handshake and `ui/initialize`, routes `host/*`, `files/*` (section 7g),
  and `links/*` (section 7i) to the host's handlers, and
  returns a connection for `document/*`, `ui/*`, and `ai/*` (and
  `leasesChanged` for section 7b, `peersChanged` and `onPresence` for section
  7e). Framework-free.
- `@kition/kit-editor` (kit side): `connectHost()` answers the handshake and
  exposes the host calls; React components for kit editors (ribbon, menus,
  tool rail, panels, dialogs, inputs, the document canvas and engine client)
  styled only with the section 4 tokens.

## 9. UI configuration and brand colors

A host can hide or disable the elements of a kit's editor, add its own buttons, and keep what
the person hid. A kit that honors it lists `ui-config` in its `ui/initialize`
answer; a host that relies on `hide` or `disable` for permissions MAY refuse to show a kit
that does not.

### Element ids

| Kind | Example | Meaning |
| --- | --- | --- |
| `command:` | `command:filter.blur.gaussianBlur` | An engine command |
| `menu:` | `menu:Filter`, `menu:Filter/Blur` | An engine menu path, joined with `/` |
| `tool:` | `tool:Brush` | A tool |
| `panel:` | `panel:layers` | A panel |
| `tab:` | `tab:insert` | A ribbon tab |
| `group:` | `group:insert/media` | A ribbon group, `<tab>/<group>` |
| `action:` | `action:undo`, `action:redo`, `action:agent`, `action:mode`, `action:save`, `action:more` | The document actions |
| `control:` | `control:colors` | Any other element a kit draws |

A pattern is an id, or an id ending in `*` that matches every id with that prefix. A `menu:`
pattern also matches the menus below it and every command in them; `action:undo` and
`action:redo` also cover the `edit.undo` and `edit.redo` commands. Ids are a kit's public
interface; renaming one is a breaking change.

A menu path segment never contains `/`. Hiding a `tool:`, `tab:`, `group:`, `panel:`, or
`control:` element hides it and refuses the tool it selects, but does not refuse the commands
it contains; a host that wants a permission names the `command:` or `menu:` ids (or both).
`*` may appear only at the end of a pattern.

`KitElement` wraps a kit's own control in a disabled `fieldset` when it is disabled, which
disables its form controls only; a kit drawing other interactive content checks the element's
state itself.

### Configuration

`ui/initialize`'s optional `ui` field, replaced whole by the `ui/configure` notification:

```json
{
  "hide": ["command:file.export.*", "menu:Help"],
  "disable": ["action:save"],
  "add": [
    { "id": "submit", "place": "action", "label": { "en-US": "Submit" }, "icon": "send", "shortcut": "Cmd+Enter" }
  ],
  "personal": { "hide": ["menu:Filter/Video"] },
  "modes": { "allowed": ["menus", "line", "classic", "focus"], "default": "line" }
}
```

`add[].place` is `menu:<path>`, `group:<tab>/<group>`, or `action`. A ribbon group built from
the engine's command paths (`@kition/kit-editor`'s `CommandTab`) has the id of its menu path, so it
takes buttons at `menu:<menu>/<group>` (or `menu:<menu>` for commands with one segment), not at
a `group:` place. `add[].shortcut` is checked after the active tool and the kit's own keys but
before the kit's Save (`Cmd+S`), zoom, and command shortcuts, so a host may bind `Cmd+S` to its
button. `add[].icon` is an icon name from `@kition/kit-editor` (`HOST_ICONS`: `bell`, `check`,
`download`, `eye`, `flag`, `help`, `info`, `link`, `lock`, `mail`, `message`, `plus`,
`printer`, `send`, `settings`, `share`, `star`, `upload`, `x`) or a `data:image/…` URL; hosts
allow `img-src data:` in the kit package's content security policy. An unknown icon name
draws a plain square, never a missing icon. `add[].label`
maps locales to text, falling back to `en-US`, then the id; every locale's text MUST be a
non-empty string. `add[].disabled` and `add[].pressed` are optional and default to unset: a
button with no `pressed` draws with no pressed state at all (no `aria-pressed`), not `pressed:
false`.

### Display modes

`@kition/kit-editor`'s editor frame draws in one of four display modes: `menus` (the tabs open as
drop-down menus or drop-down ribbon panels; no command area), `line` (one row of the selected
tab's main commands), `classic` (the full ribbon of the selected tab), and `focus` (no chrome but a
small floating bar with Exit focus, named with its key, Undo, Ask, and the active tool when the
kit has tools; the bar shows in full for a few seconds on entering Focus, then fades until
hovered). The person chooses with the mode button (`action:mode`, which also names the Focus
bar's Exit), or enters Focus with Cmd+\ (Ctrl+\ off the Mac) and leaves it with Escape. Escape
goes to the kit first (a tool, a gesture, or a selection to cancel; `KitPointer` section 4.4):
only an Escape the kit did not take leaves Focus. The editor keeps Menus, Single line, or
Classic per kit in the page's storage; Focus lasts until the person leaves it. A kit's `kit.json`
names its default (`ui.display`, platform U5c). An editor without tabs draws the same in Menus,
Single line, and Classic, so it shows Menus and its mode button only enters Focus. Without a
tab the kit selects, the editor opens on its first tab that is not File.

| `modes` member | Meaning |
| --- | --- |
| `allowed` | The modes the person may choose. Absent or empty: all four. With fewer than two, the mode button is not drawn |
| `default` | The mode the editor opens in when the person has not chosen one the host allows; `focus` opens in Focus |

### Methods

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `ui/configure` | host to kit, notification | `{ ui }` | |
| `ui/elements` | host to kit | `{}` | `[{ id, kind, label, parent, hidden, disabled }]` |
| `ui/action` | kit to host, notification | `{ id, document: { path, dirty, revision } }` | |
| `host/customize` | kit to host, capability `customize` | `{ personal: { hide } }` | `{}` |

`ui/elements` lists `action:agent` only when the host's `capabilities` include `agent`.

`@kition/kit-editor`'s shared editor adds "Customize interface…" to its More menu, and offers Hide
on the context menu of command buttons and command menu items and on tool slots (on a slot's
right-click, or in its flyout), only when the host's `ui/initialize` `capabilities` include
`customize` and the kit declares its UI (`connectHost`'s `ui`); otherwise the person cannot
change what they see. Panels, ribbon groups, and a kit's own controls offer no Hide; the person
hides them in the Customize dialog. The dialog does not list `action:more`, and a personal hide
never covers it, so the person cannot lock themselves out of Customize (a host may still hide
it). Nor does it list elements under a host-hidden parent.

### Rules

- **UI-C1** A hidden element is not drawn. A menu whose commands are all hidden is not drawn, a
  ribbon group with an id and nothing left to press is not drawn, and a separator placed
  directly in a menu is not drawn when it would lead, trail, or double another. A ribbon tab is
  not drawn only when its own `tab:` id is hidden: hiding every group of a tab leaves the tab,
  so a host that wants the tab gone hides its `tab:` id as well. A kit's own menus (a ribbon
  button that opens a menu, such as `RibbonMenu`) are not removed when everything in them is
  hidden; a kit that wants that checks its items' state itself.
- **UI-C2** A command the host hides or disables is refused on every path: menus, buttons,
  shortcuts, context menus, canvas tools, and `ai/run` (`-32000`, `error.data.reason`
  `not-allowed`). `ai/commands` omits host-hidden commands and lists host-disabled ones with
  `enabled: false`. Hiding or disabling `action:save` also stops the kit's Save shortcut and
  `ai/run`'s `save` (it answers `saved: false`); the host's `document/save` still works. A
  refusal's `error.data` is `{ reason, command, step? }`. A tool the host hides or disables is
  refused the same way: choosing it, its letter, the engine asking for it (`switchTool`), and the
  editor's initial tool; when a configuration comes to deny the active tool, the first allowed
  tool replaces it (for an engine's tools, the hand tool when none is allowed). A kit query (`editor.query`)
  of a command that edits answers null when the host denies the command; read-only queries are
  not refused.
- **UI-C3** `personal.hide` changes drawing only. Host-hidden elements are not offered to the
  person. While the kit is still waiting for `host/customize`, a `ui/configure` does not undo
  the person's new hides.
- **UI-C4** Unknown ids and invalid entries are ignored one by one; the rest applies, and
  `ui/initialize` never fails because of them. A button whose id repeats an earlier one in the
  same `add` list is dropped the same way, keeping the first.
- **UI-C5** The configuration is a blocklist: elements a kit adds later show unless a pattern
  covers them.
- **UI-C6** `ai/run` checks every step before it runs any; if one is refused, none run. If the
  configuration changes during a run, the next refused step stops the run with the same
  refusal.
- **UI-C7** The editor opens in the person's stored mode when `modes.allowed` includes it, else
  in `modes.default` when allowed, else in Menus for a read-only document, else in the kit's
  `ui.display`, else in `line`. Invalid entries of `modes` are dropped one by one (UI-C4).
- **UI-C8** When the chosen mode's commands do not fit the editor's width, Classic's ribbon gives
  way first, in steps: large buttons draw small, then buttons with an icon draw the icon alone,
  then groups collapse to one button each (opening the group whole), from the last group. Only
  when every group is collapsed and the ribbon still does not fit, or when Single line's row does
  not fit, does the editor show the next allowed mode down (Classic, then Single line, then
  Menus); it goes back up when there is room. Single line needs at least 720 CSS pixels. A host that wants one mode whatever the width
  allows only that mode. A read-only document shows only the tabs a kit marks as viewing tabs,
  and no tool rail.

### Brand colors

A kit's `kit.json` MAY declare `ui.brand: { light, dark }` (standard U5b). Unless the host's
`theme.brand` is `host`, the kit sets `--kit-primary` to the color for the theme's
`colorScheme`, `--kit-primary-text` to white or black (whichever contrasts more), and
`--kit-primary-soft` to the color at low alpha. When a later theme says `brand: "host"`, the
kit removes the brand's primary tokens before applying the host's, so none are left behind.
