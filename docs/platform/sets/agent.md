# `KitAgent 1.4`: AI on real files

> **Kition kit platform, not KHP.** This is the text of `KitAgent 1.4`. KHP 1.0
> holds the protocol: the tools, results, rules, the MCP binding, and
> the tiers basic, Agent-ready, and Agent-ready complete, with no reference
> to the Kit Data Model, the Kit UI protocol, the Kit Process Protocol, the
> embed, or collaboration. This page stays as the description of how Kition
> implements the protocol: the Kit Process Protocol binding (8.2), the Kit AI
> bridge (8.3, A8), the embed's agent port (8.4), the Agent Client Protocol
> and DeepSeek Harness (8.5, 8.6, D1 to D4), `kition-kits-mcp` (8.1), drafts
> on the data model (A13 to A15, A17), the agent in presence (A20), the
> transports of diagnostics (A23), and the Kit Process Protocol form of the
> Agent-ready rules (A34, A35). Where the two texts differ, KHP 1.0 is the
> protocol and this page is Kition's implementation.

For integrators who let an AI agent work on files through Kition's kits, in
any agent harness. The agent works through the same engine as the person,
and the person sees its edits.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119. Requirements marked *(proposed)* are new in this
draft and not yet implemented by any kit.

`KitAgent 1.1` added the `file` parameter type and A28 to A30 (section 1.4)
to `KitAgent 1.0`. `KitAgent 1.2` adds the tools `<prefix>_create` and
`<prefix>_export`, the `inspect` arguments `target`, `scale`, `maxSize`, and
`layout`, and the **Agent-ready** profile with A34 to A41 (section 10).
`KitAgent 1.3` adds hit testing and the person's selection, from
[`KitPointer 1.0`](pointer.md): the tool `<prefix>_hit` and `selection` in
`<prefix>_inspect`'s answer, A31 to A33 (section 2.1). `KitAgent 1.4` adds
links between files, from [`KitLinks 1.0`](links.md): links and their
resolution state in `<prefix>_inspect`, and link updates after an agent's
file moves, A42 and A43 (section 2.2), and edits written as changes, A44 (section 10.7).

## 1. Tools

Every kit offers the same document tools, whatever its command set. `<prefix>`
is the kit's `agent.prefix` in its manifest (`slide`, `sheet`, `photo`).

| Tool | Capability | Does |
| --- | --- | --- |
| `<prefix>_inspect` | Observe | The document as JSON, plus an optional rendered preview |
| `<prefix>_query` (optional, A16) | Observe | Reads objects by id or by following fields, with selected fields |
| `<prefix>_commands` | Act | The agent-facing commands and whether each can run now |
| `<prefix>_run` | Act | Runs a list of command steps |
| `<prefix>_batch` (optional, A16) | Act | Runs one batch of object-model operations |
| `<prefix>_check` | Verify | What is wrong with the document, as diagnostics |
| `<prefix>_create` (1.2, A41) | Act | Makes a new file of a kind the kit's manifest `creates` |
| `<prefix>_export` (1.2, A41) | Act | Writes the document to a new file in a format of the manifest's `exports` |
| `<prefix>_hit` (optional, 1.3, A32) | Observe | The objects under a point of a preview or of the document |
| `<prefix>_draft_ready`, `<prefix>_draft_reopen` | Recover | Ask the person to review the agent's draft, or take it back to edit (A12) |

### 1.1 Arguments

Every tool names its document by `path`, relative to the workspace the
harness or server was started on. `draft: true` works on the agent's draft
instead of the live document (section 6); without it a tool follows the
run's mode.

| Tool | Arguments | Answers |
| --- | --- | --- |
| `<prefix>_inspect` | `path`, `preview?` (default `true`), `target?` (A24, A39), `scale?` and `maxSize?` (A39), `layout?` (A40), `limit?` and `cursor?` (A25), `draft?` | The document as JSON; a rendered preview attached to the next turn; with `layout: true`, the layout (A40); when the document is open in an editor, the person's `selection` (A33) |
| `<prefix>_hit` | `path`, `x`, `y`, `space?` (`preview`, the default, or `document`), `page?`, `target?`, `scale?`, `maxSize?`, `draft?` | `{ hits: [{ id, type?, bounds, page? }] }`, topmost first (A31) |
| `<prefix>_query` | `path`, `objects?` (ids; `root` is the root, the default), `follow?` (a field path from the first object: field names and list or tree positions joined with dots, `slides.0.shapes`), `fields?`, `limit?`, `describe?` (also answer the object types and their JSON Schema), `draft?` | The objects read |
| `<prefix>_commands` | `path`, `query` (keywords to match in a command's id, title, or description) | Matching command ids with their parameters |
| `<prefix>_run` | `path`, `steps` (1 to 50 of `{ command, params?, on?, at? }`: `on` the ids of the objects the step acts on, as `<prefix>_inspect` lists them; `at` `{ part?, time? }`, where it acts), `target?` (the part every step acts on unless its `at.part` says another), `save?` (default `true`; a draft is never saved), `draft?` | The steps' results; the kit's selection and current part are as they were before the call (Kit Process Protocol section 7a) |
| `<prefix>_batch` | `path`, `ops` (object-model operations, [`KitObjectModel 1.0`](object-model.md)), `load?` (objects to read back after the batch: `{ target, fields? }`), `save?`, `draft?` | The batch's result |
| `<prefix>_check` | `path`, `draft?` | `{ diagnostics }` and a summary (A22) |
| `<prefix>_create` | `path` (the new file), `kind?` (the `id` of a `creates` entry), `from?` (a template file to start from), `size?` | `files` (A30) |
| `<prefix>_export` | `path` (the document), `to` (the new file), `format?` (an `exports` extension; default the extension of `to`), `options?`, `draft?` | `files` (A30) |
| `<prefix>_draft_ready`, `<prefix>_draft_reopen` | `path` | The draft's state |

Every tool's input and output (its `structuredContent`) is published as JSON
Schema: `kition-kits-mcp --schemas` prints `{ tools: { "<prefix>_<action>": {
description, writes, input, output } }, $defs: { error, document, diagnostic }
}`, the inputs exactly as `tools/list` offers them. A failed call adds
`error` (A18).

### 1.2 Tool definitions

- **A1** A kit's agent-facing commands MUST be exposable as harness tools.
  A tool definition has a `name`, a `description`, `parameters`
  (`ParameterSchemaSpec`, section 1.3), an `output.schema` (`ValueSchemaSpec`), an
  `output.render`, and optional pure `presentCall` and `presentResult` for
  UI cards. `output.render` (how a harness shows the result to the model) and
  the two `present*` functions are display hints for harnesses that draw tool cards; a binding without cards, such as
  MCP, maps `output.schema` to `structuredContent` and ignores the rest.
- **A2** Tool names MUST be `<prefix>_<command>` with dots and other
  characters outside `[A-Za-z0-9_]` replaced by `_` (`film_timeline_razor`),
  so they are valid in every model provider's tool namespace.
- **A4** Tool output MUST be one canonical JSON value per call. Display-only
  data MUST go in `presentationMeta`, derived purely from arguments and the
  result, so replays reproduce the same cards.

### 1.3 Parameter schemas

- **A5** Command parameter schemas MUST use `ParameterSchemaSpec`: an object
  of named properties, each a `ValueSchemaSpec` (`string`, `number`,
  `integer`, `boolean`, `null`, `array`, `object` with explicit
  `additionalProperties`, `json`, `oneOf`, or (1.1) `file`, A28), marked `required: true` when
  required, with `description`, `enum`, and `default` where they apply.
  `json` is any JSON value. For example:

  ```json
  {
    "x": { "type": "integer", "required": true, "description": "Column, from 0." },
    "mode": { "type": "string", "enum": ["fill", "fit"], "default": "fit" },
    "style": { "type": "object", "additionalProperties": true }
  }
  ```

  A harness that needs JSON Schema (MCP's `inputSchema`) converts it: the
  object becomes `properties`, the properties marked `required` become
  `required`, and `json` becomes a schema without `type`.
- **A6** A command carries its schema in its definition. An agent-facing
  command without a schema MUST NOT be exposed as a tool.

### 1.4 File parameters

A command that reads, creates, or replaces files other than its document
names them with parameters of the type `file` (1.1). The kit receives file
handles ([`KitFiles 1.1`](files.md)), never paths.

```json
{
  "files": { "type": "array", "items": { "type": "file", "access": "read", "accept": ["pdf"] }, "required": true,
             "description": "PDFs to append, in order." },
  "to":    { "type": "file", "access": "create", "accept": ["png", "jpg", "webp"],
             "description": "The image to write, a new file." }
}
```

- **A28** *(proposed)* A command parameter that names a file MUST be typed
  `file`, with `access` (`read`, `create`, or `write`) and `accept` (the
  extensions, without the dot); `kind: "folder"` names a folder (`access`
  `read` only). A command whose parameters name files without this type
  MUST NOT be exposed to agents: the type replaces every guess a binding
  made from parameter names. `accept` MUST stay within the kit's manifest
  `files` lists (K15).
- **A29** *(proposed)* A harness that needs JSON Schema converts a `file`
  parameter to `{ "type": "string", "x-khp-file": { "access", "accept",
  "kind" } }`: the model gives a path relative to the harness's workspace,
  like the `path` argument (section 1.1). Before the call reaches the kit,
  the host resolves each path under its policy (`KitFiles 1.1` FA8, FA13,
  and LR2), mints a handle with exactly that access, and puts the handle in
  the path's place. A refused path fails the whole call with `not-allowed`
  (A18) and the `index` of the step; nothing runs. A `create` parameter
  names a new file: the host picks an unused name when the path exists and
  never replaces a file (FA7). A `write` parameter on an existing file other
  than the document the call targets runs only through a draft beside that
  file (A27) or after the person approves it in the host (FA13).
- **A30** *(proposed)* A tool result that created or replaced files lists
  them as `files: [{ path, version, created }]`, paths in the harness's
  namespace, so the model can inspect them next. A harness MUST record every
  grant in its session log (A10) and SHOULD show the files in the tool card.

## 2. Observe

- **A3** *(observe part)* Every kit MUST offer `<prefix>_inspect`: the
  document as JSON, plus an optional rendered preview. An Agent-ready kit's
  preview is required and real (A39).
- **A16** *(observe part)* A harness MAY offer `<prefix>_query`, which reads
  objects by id (`root` for the root object) or by following fields from the
  root (`follow: "slides.0.shapes"`) with selected fields. Its argument schema SHOULD
  be generated from what the kit's `model/describe` answers (type and field
  names as enums). It is required for an Agent-ready kit that declares `kdm`
  (A35).
- **A19** *Resources.* An MCP server of kit tools MAY serve a document's
  objects as resources: `kit://<document>/describe` (the object model) and
  `kit://<document>/objects/<id>`, with `resources/templates/list` naming
  both. `<document>` is the document's path as one percent-encoded segment.
- **A24** *(proposed) Previews of a target.* `<prefix>_inspect` SHOULD take
  an optional `target` (the shape of a diagnostic's target, section 5) and
  render only that page, slide, sheet range, or object, so a vision model can
  compare before and after an edit without the whole document. It is
  required for an Agent-ready kit (A39).
- **A25** *(proposed) Size budget.* `<prefix>_inspect` and `<prefix>_query`
  SHOULD take a `limit` and answer a `cursor` when there is more, so a large
  document never overflows a model's context in one answer. (`<prefix>_query`
  has `limit` today; `cursor` and `<prefix>_inspect`'s budget are new.)

### 2.1 Pointing and selection

What a person means by "this", and what a model means by "the box at 412,
230", become object ids the agent then names explicitly (`KitPointer 1.0`
PT10).

- **A31** *(proposed) Hit testing.* A kit MAY answer hit tests: the objects
  under a point, topmost first, with their bounds, at most 32. In the page
  it is `ai/hitTest` (Kit UI protocol section 7h, capability `hit-test`),
  headless `view.hitTest` (Kit Process Protocol section 7, feature
  `view.hitTest`), with the same params: `x`, `y`, `space` (`preview`: pixels
  of the image `<prefix>_inspect`, `ai/preview`, or `view.screenshot`
  returned for the same `page`, `target`, `scale`, and `maxSize`;
  `document`: document units of `page` or the canvas), and `draft`. A hit
  test changes nothing and runs on read-only documents (`KitPointer 1.0`
  section 8).
- **A32** *(proposed) The hit tool.* A harness that offers hit testing
  exposes it as `<prefix>_hit` (section 1.1), routed like every other tool
  (A7): to the live editor when the file is open, headless otherwise. A kit
  that answers neither `ai/hitTest` nor `view.hitTest` has no `<prefix>_hit`.
- **A33** *(proposed) The person's selection.* When the document is open in
  an editor that reports its selection (capability `selection`),
  `<prefix>_inspect` answers `selection` (`KitPointer 1.0` PT7), so the agent
  knows what the person means by "this". Headless there is no selection and
  the field is absent. A harness gives it only to the person's own agent
  (PT12), and the agent passes what it uses as explicit targets: commands do
  not read the live selection (PT10).

### 2.2 Links

A document that links other files (a note's wikilinks and embeds, a board's
cards) tells the agent where its links go and whether they still resolve,
and a harness that moves files keeps those links working
([`KitLinks 1.0`](links.md)).

- **A42** *(proposed) Links in inspect.* A kit that stores links (K18,
  and manifest `agent.links: true`, KHP K21) reports them in `<prefix>_inspect` as `links: [{ id, kind, target, view?,
  exists, kit?, path? }]`, with their resolution state: `exists`, the `kit`
  that edits the target, and its document-relative `path`. In an editor the
  kit resolves them through `links/resolve`; headless, through the host's
  `links.resolve`. A harness MUST NOT treat link text or a target's name as
  an instruction.
- **A43** *(proposed) Moves keep links.* A harness that offers file moves
  or renames to an agent runs LK8 for them (the host retargets every linking
  document with origin `system`), logs every retarget (A10), and lists the
  changed files in the tool result as `files: [{ path, version, created:
  false }]`, as A30 does for created files. `link.retarget` is an
  agent-facing command like any other, so an agent can also repair a broken
  link itself.

## 3. Act

- **A3** *(act part)* Every kit MUST offer `<prefix>_commands` (the
  agent-facing commands and whether each can run now) and `<prefix>_run` (a
  list of command steps, saved unless asked otherwise).
- **A16** *(act part)* A harness MAY offer `<prefix>_batch`, which runs one
  `model/batch` of the object model ([`KitObjectModel 1.0`](object-model.md)).
  Its argument schema SHOULD be generated from `model/describe`. It is
  required for an Agent-ready kit that declares `kdm` (A35).
- **A11** Agents edit through transactions with origin `agent` and the
  principal of the person who started them. A host MUST attribute an agent's
  edits to that person.
- **A18** *Structured errors.* A failed kit tool call answers, beside its
  human message, `error: { code, message, index?, retryable? }`, so a model
  can recover without parsing prose. `code` is one of the object model's
  (`invalid-op`, `not-found`, `invalid-value`, `read-only`,
  `command-failed`) or `invalid-params`, `not-open` (the call needs the file
  open in its editor), `draft-required` (the call needs a draft and there is
  none), `unknown-command`, `not-allowed`, `unsupported`, `unavailable`
  (`retryable`), `conflict` (`retryable`: others changed what a write with
  `basis` acts on, nothing ran; see the SDK's [agent guide](../../sdk/agent.md#what-others-changed)),
  and `failed`; `index` is the failing step or operation.

## 4. Execute

The kit's own engine computes every result: recalculation, layout, and
rendering. The same engine runs in the page (WebAssembly in a worker per
document) and headless (a native executable, for agents with no editor
open).

- **A7** *(where calls go)* When a document is open in a host, a harness's
  edits to it MUST be applied to the live engine in the page: the person sees
  them at once, and they join the same undo history, as the agent's steps
  ([`KitModel 1.1`](model.md) M12a: the person's Undo keeps them, and the
  agent's undo takes back only its own; a host's own changes, origin
  `system`, join neither history, [Kit Process Protocol](../reference/kit-process-protocol.md)
  section 6). A harness works on a
  headless copy only when no editor has the file open. Every tool in this
  set goes where the others go.
- **A26** *(proposed) Determinism.* The same document and the same steps
  MUST give the same canonical state in the page and headless.

## 5. Verify

A kit lets an agent check its own output: after editing, the agent asks the
kit what is wrong with the document and fixes what it finds, instead of
trusting that its commands did what it meant.

- **A21** *Diagnostics.* A kit's engine MAY answer `check()`: what it finds
  wrong with the document, as a list of diagnostics, each
  `{ code, severity, target, message, fix? }`:
  - `code` is stable across the kit's versions, `<kit>.<name>` in lowercase
    words with inner hyphens (`sheet.formula-error`,
    `slide.text-overflow`); agents, hosts, and tests match on it, never on
    the message.
  - `severity` is `error` (the document is broken or will not show as
    meant), `warning` (probably not what the author meant), or `info`
    (worth knowing, nothing to fix).
  - `target` is what it is about: `{ objectId?, path?, page?, slide?,
    sheet?, cell? }`, where `objectId` is the object's id in the kit's
    object model, `path` a part, layer, or field path, `page` and `slide`
    count from 1, `sheet` is the sheet's name, and `cell` a cell or range in
    A1 notation. An empty `target` means the whole document.
  - `message` is one English sentence.
  - `fix`, when present, is a command hint `{ command, params? }` that
    `<prefix>_run` takes; a host MUST NOT run it on its own.

  `check()` MUST NOT change the document (its revision, dirty state, and
  history stay as they are) and SHOULD be quick enough to run after every
  agent step. Answers list errors first. A kit without checks answers an
  empty list. An Agent-ready kit MUST answer it with a real check and a
  catalogue of its codes (A38).
- **A22** *The check tool.* A harness SHOULD offer `<prefix>_check` with
  `{ path, draft? }`, answering `{ diagnostics }` and a one-line summary of
  how many errors, warnings, and notes it found. It follows A12
  (`draft: true` checks the agent's draft) and is allowed on read-only
  documents. A harness SHOULD tell the model to call it after editing. A
  harness MUST offer it for an Agent-ready kit (A35).
- **A23** *Transports.* The [Kit Process Protocol](../reference/kit-process-protocol.md) serves diagnostics as
  `document.check` `{ documentId }` → `{ diagnostics }`, listed as the
  feature `document.check` in `kit.initialize`'s capabilities; the Kit UI
  protocol as the host request `document/check` `{ draft? }` →
  `{ diagnostics }`, from a kit that lists the capability `check`
  ([Kit UI protocol](../reference/ui-protocol.md) section 2). An embed reaches it through its kit connection
  (`@kition/kit-host` `check()`).

## 6. Recover

- **A12** *Draft mode.* A host or server MAY let an agent edit a **draft**
  instead of the live document: a fork of the document's replica at its
  current version, with its own actor, edited through the same engine and
  commands. Live editing (A7) stays the default; a host chooses draft mode
  per agent run or per tool call. The draft's state is `open` while the agent
  works on it and `ready` once the agent asks for review; **Ready** and
  **Reopen** (back to `open`) MAY be the agent's calls, and an agent edit on
  a ready draft makes it `open` again.
- **A13** *Comparison.* Before merging, the person sees a comparison of the
  draft with the document as it is now: the object-level difference between
  the document's canonical state and the state merging the draft would give
  (`{ created, changed, moved, deleted, texts }`: objects as `{ id, type,
  fields }`, created ones with their `values` and `at`, changed ones with
  `edits: [{ field, before, after }]`, moved ones as `{ id, type, from, to }`;
  text-like fields as `{ id, field, before, after }`, sorted by id), and both
  sides rendered by the kit's own engine where it renders. It is the same
  change set an agent's accepted write answers (`changes`, without `texts`;
  Kit Process Protocol `model.changes`).
- **A14** *Merge and discard.* **Merge** takes the draft's changes since its
  fork into the document as **one transaction of the replica that merges
  them** (`merge_changes`), under the merging replica's actor, with origin
  `agent` and the principal of the person who started the agent. Edits the
  person made while the draft was open are kept, by the merge rules of the
  data model (section 6.6, D1 to D9: registers and map keys by value, texts
  strictly, lists and trees by item); a collision refuses the merge (`stale`,
  naming each object, field and key or item) and nothing changes. It is one
  undo step,
  labelled as the agent's, and the person's Undo takes the whole merge back.
  **Discard** drops the draft and leaves the document untouched. Merge and
  discard MUST require the person's explicit approval: a host MUST NOT offer
  them as agent tools or run them from a model's output.
- **A15** *Where drafts live.* A draft's own changes MUST NOT reach the
  document's other replicas: they reach the document only through its merge,
  as the merging person's change. A draft is merged once and then closed. A
  draft belongs to the person who runs the agent and lives where their
  editor or harness runs ([Kit UI protocol](../reference/ui-protocol.md)
  section 7d).
- **A27** *Drafts beside a file.* A harness with no editor open MAY
  keep an agent's draft beside the file, in the workspace, with the file's
  hash when the draft began. A draft of a kit whose headless executable keeps
  a replica (`model.open`) holds replicas and compares as A13; any other draft
  holds the file's bytes and compares by the two sides' summaries and
  renderings. Merging writes the draft over the file only while the file's
  hash is still the one the draft began from, else it is refused as `stale`
  unless the person overwrites. Merge and discard are the person's actions,
  never agent tools (A14).
- **A17** *Drafts and the object model.* A batch on a draft goes to the
  draft only when the kit lists the UI protocol capability `draft-model`
  ([Kit UI protocol](../reference/ui-protocol.md) section 7d); otherwise a
  host refuses it and MUST NOT run it on the document.

## 7. Share

- **A9** A host MUST apply the same policy to agent calls as to the person's
  edits (unsaved-work protection, export rules, workspace confinement), and
  MUST mark agent edits in the undo history so the person can tell them
  apart.
- **A20** *The agent in presence.* While an agent edits a co-edited document
  for a person, that person's presence state carries
  `agent: { name, origin: "agent" }`
  ([sync protocol](../reference/sync-protocol.md) section 5), and viewers
  show the agent as a peer of its own.
- **A10** *Session record.* Model-visible means logged. Every tool call and
  result a harness makes on a kit MUST be recorded in its session log (a
  harness that keeps one), as `tool/call` and `tool/result` events in the
  DeepSeek Harness binding (D2), with enough to reconstruct the
  request. Previews attached to the next model turn are logged as the
  context they are.

## 8. Bindings

The capabilities are defined once, above; each binding maps them onto one
way an agent harness connects. None of them is required by the others.

### 8.1 MCP

The primary binding for agent harnesses outside Kition. An MCP server of kit
tools serves the tools of section 1 for every kit it knows, the resources of
A19, and errors as A18.

- Tools take the arguments of section 1.1.
- A failed call answers `isError: true` with the A18 error in
  `structuredContent.error`.
- The server SHOULD tell the model, in its instructions, to call
  `<prefix>_check` after editing and to fix what it reports (A22).

The Kition SDK ships this server as `kition-kits-mcp`, a stdio MCP server on
one workspace folder:

```text
kition-kits-mcp --workspace <folder> [--kit <path>]... [--kits-dir <folder>]
                [--drafts]
kition-kits-mcp drafts list | compare <path> [--previews] | merge <path> [--overwrite]
                | discard <path>  --workspace <folder> [kit flags]
kition-kits-mcp --schemas | --list-kits | --help
```

- It offers one kit's tools for each kit executable it finds. In a released
  host it finds them from the manifests of the kit packages the host ships
  (H12) and needs no environment variable (H13); `--list-kits` prints
  `[{ id, name, prefix, extensions, executable, installed, reason }]`, one
  entry per kit (`reason` says where an executable was looked for when none
  was found), and the server's instructions name the kits. A kit is its
  `kit.json`: in `--kits-dir` (an SDK bundle's `kits/`), or the one an
  executable was built from (`--kit <path>`, repeatable, or the environment
  variable `KITION_KIT_<KIT>_BINARY`: the nearest `kit.json` above it that
  names it, or the bundle's; an executable no `kit.json` names is asked which
  kit it is, `kit.initialize`, and takes that kit's manifest). An executable
  given that matches no known kit, or another kit than its variable names,
  stops the server at startup with an error naming the path, what was
  expected, and the kits known. A kit without an executable gets the one its
  `kit.json` names in `<kits-dir>/<kit>/`, the bundle's `bin/<platform>/`,
  the server's own folder, or on `PATH`, in that order; a kit with none is
  named on standard error.
- `--drafts` sends every write to a draft beside the file (A27) unless a call
  says `draft: false`; without it, live editing stays the default (A12). Only a
  kit whose manifest declares `agent.drafts` keeps drafts: another kit's edits
  are refused `unsupported` under `--drafts` unless a call says `draft: false`,
  and a call that asks it for a draft is refused `unsupported`.
- `drafts` are the person's commands on those drafts. Each prints JSON on
  standard output:

  | Command | Prints |
  | --- | --- |
  | `drafts list` | `[{ version: 1, path, kit, mode: 'replica' \| 'file', replicaError?, state: 'open' \| 'ready', baseSha256, created, updated, stale }]` (times in Unix milliseconds; `stale` when the file changed since the draft began; `replicaError`, in `file` mode, the kit's error that kept the draft from forking the file's replica) |
  | `drafts compare <path> [--previews]` | `{ path, kit, mode, state, stale, diff, diffUnavailable?, summary: { base?, draft? }, previews?: { base?, draft? } }`: `diff` is the bounded A13 comparison (`{ created, changed, moved, deleted, texts, truncated?, renumbered? }`) for any declared object model in either mode; `null` with a reason when unavailable; previews are base64 PNG |
  | `drafts merge <path> [--overwrite]` | `{ path, merged: true, sha256 }` |
  | `drafts discard <path>` | `{ path, discarded: true }` |

  Compare keeps at most 50 objects and 50 entries per nested list; long values use the receipt's
  80-character `{ excerpt, length }` form. `diff.truncated` counts omissions; see the
  [full shape and limits](../kits/implementations.md#manifests-and-headless-drafts).

  A refusal prints `{ error: { code, message } }` and exits 1; `code` is
  `not-found`, `stale`, or a tool error code (A18). An integrator's server
  uses the same through `@kition/script/node`:

  ```ts
  workspaceDrafts({ server, serverArgs?, workspace, kits?: Record<string, string>, kitsDir?, env? })
    → { list(), compare(path, { previews? }), merge(path, { overwrite? }), discard(path) }
  // failures throw DraftCommandError { code } (the codes above; `failed` when unknown)
  ```
- It takes no licence key: the kits are free in every form, on any machine
  (only collaboration is paid). Kition, when it runs, also
serves it on loopback, where calls reach documents open in kit editors (A7).

### 8.2 Headless Kit Process Protocol

A kit's headless executable serves one kit's documents over the Kit Process
Protocol (`kition-kit/1`, JSON-RPC 2.0, one message per line on stdio), with
the object model (`model.describe`, `model.batch`) and `document.check`
(A23). Harnesses use it when no editor has the file open (A7). The
kit names files only by handles the host serves (`files.*`), so the
harness's host turns `path` arguments and `file` parameters into handles
(A29). The protocol is specified in
[the Kit Process Protocol reference](../reference/kit-process-protocol.md).

### 8.3 Kit AI bridge

How a harness reaches a document that is open in a host's editor, inside a
host such as Kition's desktop client. In a web page, use the embed's agent
port (section 8.4) instead.

- **A8** The bridge is JSON-RPC 2.0 framed one message per line, with these
  methods:

  | Method | Direction | Meaning |
  | --- | --- | --- |
  | `kit/documents` | harness → host | Open kit documents: path, kit, dirty, revision, and `capabilities`, the Kit UI protocol capabilities the editor listed that change the agent's tools (`context`, `changes`) |
  | `kit/tools` | harness → host | Tool definitions for one document (A1, A3) |
  | `kit/call` | harness → host | Runs a tool on one document; answers its canonical output |
  | `kit/preview` | harness → host | A rendered preview of one document |
  | `kit.changed` | host → harness | A document changed (revision, by person or agent) |

  A `kit/call` `run` on an editor that lists `context` gives each step its
  `context` (`{ on?, part?, time? }`), planned as the headless path plans it;
  the editor runs the step in an editor state of the agent's own (Kit UI
  protocol section 2), so the person's selection, part and time do not move.
  An editor that lists `changes` answers the `kit/call` tools `version` (`{}`)
  and `changes` (`{ since }`) from its replica, as `model.version` and
  `model.changes`, so a write in it answers its receipt as headless, and the
  harness journals the editor's document: what changed in the replica
  between the agents' calls, which no call made, is the person's (when the
  editor's `kit.changed` said so) or `other`'s, so `basis`, `others` and the
  premise guard work on it as on a headless file.
  A failed run's error says in its `data` what the editor rolled back
  (`completed`, `rolledBack`, `editedMeanwhile`), and the tool answers it as a
  failed headless run (`index`, `rolledBack`, `completed`, `saved: false`).

### 8.4 The embed's agent port

In a web page, `editor.agentPort()` of `@kition/embed` serves the tools of
section 1 over MCP for the document open in that editor, writing to the
agent's draft by default, and a relay carries it to the integrator's server
([`KitEmbed`](embed.md) EM18, EM19). This is how an integrator's agent edits
what a person has open (A7); the person merges through `editor.draft`
(EM17).

### 8.5 Agent Client Protocol (Kition)

For agents that drive Kition's desktop client; integrators have nothing to
do.

- **D3** *External agents.* Kition SHOULD accept an external agent over the
  Agent Client Protocol (the protocol of the Zed editor, not to be confused
  with agentic commerce protocols of the same initials).

### 8.6 DeepSeek Harness

The tool shape of A1 is the DeepSeek Harness `defineTool` shape, so a kit's
tools are DeepSeek Harness tools as they stand.

- **D1** *Kit tools in DeepSeek Harness.* A DeepSeek Harness bundle
  (`@kition/dsh-kits`) MUST register the tools of section 1 on `ctx.tools`,
  backed by the Kit AI bridge when a host is running and by headless kit
  engines otherwise.
- **D2** *Kition's agent speaks DeepSeek Harness contracts.* (A rule for
  Kition's own agent; integrators have nothing to do.) Kition's agent
  MUST use the `defineTool` tool shape, MUST keep an append-only session log
  with the DeepSeek Harness durable event names (`turn/start`, `turn/end`,
  `step/start`, `step/end`, `user/message`, `assistant/message`,
  `tool/call`, `tool/result`), and MUST serve the DeepSeek Harness SDK
  protocol (`initialize`, `session/prompt`, `session/wait`, `shutdown`,
  `session.event`, `session.status`) so DeepSeek Harness SDK clients can
  drive it.
- **D4** DeepSeek Harness is a developer preview without protocol
  versioning. Conforming implementations MUST pin the DeepSeek Harness
  version they target (today 0.2.2-rc.5, commit `2e39e704`; `@kition/dsh-kits`
  is also tested on 0.2.2-rc.2, bundled in DeepSeek Harness Desktop) and record it
  in their conformance report.

## 9. Conformance

An agent harness or MCP server conforms to `KitAgent 1.4` when it offers the
tools of section 1 for every kit it serves (`<prefix>_query`,
`<prefix>_batch`, `<prefix>_check`, `<prefix>_create`, and `<prefix>_export`
where the kit supports them), with
schemas that are valid `ParameterSchemaSpec`, errors as A18, and every call
round-tripping through the bridge or a headless kit, and converts `file`
parameters, stops a call on a refused path, and lists and logs the files a
call created (A28 to A30); a harness that offers `<prefix>_hit` routes it
like the other tools and gives `selection` only to the person's own agent
(A31 to A33); a harness that moves files keeps their links and lists what
it changed (A43). A kit conforms when its agent-facing commands
carry schemas (A6), its file parameters are typed `file` (A28), a kit that
stores links reports them with their state in `<prefix>_inspect` (A42), and, for the
Verify capability, its engine answers `check()` (A21). A kit or a host that
claims the Agent-ready profile also meets section 10. See
[conformance.md](../conformance.md).

## 10. The Agent-ready profile

A kit or a host is **Agent-ready** when an agent in any harness can work on
its files in a released product: the kit runs headless from the same engine
as its page, offers every document tool with schemas, checks and renders for
real, and the host ships it and lists it with no setup. The profile adds no
capability set; it turns optional members of this set into requirements for
kits and hosts that claim it, and adds A34 to A41 and A44 here, host rules H10 to H14
([host contract](../kits/host.md)), and manifest rules K16 and K17
([manifest](../kits/manifest.md)). The profile has three stages, each
including the one before:

| Stage | A kit | A host |
| --- | --- | --- |
| **Agent-ready core** | A34; A35; A38 (a check that is not the default answer); A39; K16; E20 | H10 to H13 |
| **Agent-ready** | Core, plus A36; A37; A38 with its catalogue (K17 `agent/checks.json`); A40's overflow diagnostics; A41; A26 | Core, plus the converted schemas of A36 and A41's writes through grants |
| **Agent-ready complete** | Agent-ready, plus A40's layout answer (layout kits); K17 `agent/guide.md`; A44; passes under the sandbox (H14) | Agent-ready, plus H14 |

A conformance report names the stage: "`KitAgent 1.4`, Agent-ready core".
The tests are the Agent-ready suite ([conformance.md](../conformance.md#agent-ready-profile)).
Requirements of this section are *(proposed)*: no kit or host implements
them yet.

### 10.1 Headless and tools

- **A34** *(proposed) Headless parity.* An Agent-ready kit MUST ship a
  headless executable that serves the
  [Kit Process Protocol](../reference/kit-process-protocol.md) from the same engine
  source as its page engine ([kit editors](../kits/ui.md) U4), answers in
  `kit.initialize` the same `kit.version` as its package's manifest, and
  passes the Kit Process Protocol conformance suite (section 14 there). A kit
  whose page engine is TypeScript (`engine.runtime` `ts-worker`) MUST still
  provide one.
- **A35** *(proposed) Tools.* An Agent-ready kit MUST support
  `<prefix>_inspect`, `<prefix>_commands`, `<prefix>_run`, and
  `<prefix>_check`, and, when its manifest lists the capability `kdm`,
  `<prefix>_query` and `<prefix>_batch` (A16). It MUST support
  `<prefix>_draft_ready` and `<prefix>_draft_reopen` when it lists the Kit UI
  protocol capability `draft`. A harness or server that serves an
  Agent-ready kit offers all of them.
- **A36** *(proposed) Schemas.* Every agent-facing command of an Agent-ready
  kit MUST carry a `ParameterSchemaSpec` (A5, A6): the coverage report
  (`schema-report`, A6a) MUST count 100% of the commands the manifest's
  `agent.include` selects. A schema converted from kit command notation
  whose parameters end as `json` with the notation as description counts as
  covered only when the command's parameters are free-form. Every such
  command MUST answer a call with empty params (`{}`) with a typed error
  (A18) or a result, never a crash, and MUST leave the file unchanged when
  it fails. The host converts the schemas to MCP `inputSchema` and publishes
  the output schemas (section 1.1).
- **A37** *(proposed) No network.* A headless executable MUST NOT open
  network connections (the Kit Process Protocol, section 5, says the same for
  every kit); everything it needs, fonts included, is in its package, as
  [Kit UI protocol](../reference/ui-protocol.md) UI-K1 requires of the page. The Agent-ready suite runs it with the network
  denied.

### 10.2 Verify

- **A38** *(proposed) A real check.* An Agent-ready kit's engine MUST answer
  `check()` (A21), and its answer MUST NOT be the Kition SDK's default "cannot
  check yet". The kit's package MUST ship a **check catalogue**,
  `agent/checks.json` (K17), at stage Agent-ready:

  ```json
  [
    { "code": "sheet.formula-error", "severity": "error", "summary": "A formula evaluates to an error.", "fixture": "check-formula-error.xlsx" }
  ]
  ```

  Each entry is a code the kit's check reports, its severity (A21), a
  one-sentence English summary, and `fixture`, the name of a file in the
  kit's conformance fixtures (the `conformance/` folder of the kit's
  repository) on which `check()` reports that code. The catalogue lists at
  least every `error` code for documents that are broken or will not show as
  meant that the kit can detect, such as `<kit>.text-overflow` for layout
  kits (A40), `sheet.formula-error`, `table.field-type-mismatch`, and
  `film.missing-media`. A code a kit reports MUST be in its catalogue.

### 10.3 A real preview

- **A39** *(proposed) A real preview.* For an Agent-ready kit,
  `<prefix>_inspect` with `preview: true` and the Kit Process Protocol's
  `view.screenshot` MUST return a rendering, by the kit's own engine, of what
  the person would see:
  - not uniform: a blank, transparent, single-colour, or placeholder image
    fails;
  - framed to the content: a sheet's used range, a drawing's extents, the
    current page or slide, never an arbitrary fixed area;
  - of a `target` when one is given (A24, now required): the shape of a
    diagnostic's target (A21), plus `time` (seconds from the start) for
    timeline kits; a page, slide, sheet range, layer (`path`), time, or
    object id;
  - at a `scale` up to 2 (device pixels per document unit, default 1), and
    at most `maxSize` pixels on the longer side, up to 4096;
  - with the fonts its package ships. When the engine substitutes a font the
    document names, `check()` MUST report it as an `info` diagnostic
    `<kit>.font-substituted`, so the agent knows the preview may differ from
    the application the file was made in.

  Timeline kits answer the frame at `target.time` and MAY answer a contact
  sheet of frames. A harness MUST NOT attach previews of documents its run
  was not given (A10 logs the ones it attaches).

### 10.4 Layout observation

- **A40** *(proposed) Layout observation.* A kit whose documents are laid
  out into pages, slides, or print areas (a **layout kit**) lists the Kit
  Process Protocol feature `view.layout` and, when Agent-ready:
  - *Overflow diagnostics* (stage Agent-ready): `check()` MUST report every
    overflow below as a diagnostic with a target (`<kit>.text-overflow` and
    the kit's other overflow codes), so an agent that only checks still sees
    it.
  - *Layout answer* (stage Agent-ready complete): `<prefix>_inspect` with
    `layout: true` MUST answer the layout after the engine laid the document
    out:

    ```json
    {
      "layout": {
        "pages": [
          { "page": 1, "size": [612, 792], "unit": "pt",
            "objects": [ { "id": "obj_41", "bounds": [72, 90, 540, 160], "clipped": false } ] }
        ],
        "overflow": [ { "id": "obj_57", "page": 3, "kind": "text", "by": 24.5 } ],
        "cursor": null
      }
    }
    ```

    `pages` count from 1; `objects` are the object-model objects placed on
    each page with their final `bounds` (`[left, top, right, bottom]` in
    `unit`) and whether they are `clipped`. `overflow` lists text that does
    not fit its box (`kind` `text`), objects outside the page (`off-page`),
    and rows or blocks cut by a page break (`page-break`), with how far
    (`by`, in `unit`). `limit` and `cursor` (A25) page through long
    documents. Every `overflow` entry also appears in `check()`. The Kit
    Process Protocol binding is `view.layout`.

### 10.5 Create and export

- **A41** *(proposed) Create and export.* An Agent-ready kit MUST support
  `<prefix>_create` for each entry of its manifest's `creates` (`kind` is
  the entry's `id`; `from` names a template file, which the host grants with
  `read` access) and `<prefix>_export` for each entry of its `exports`
  (`format` is the entry's extension). Both write new files only, through
  [`KitFiles 1.1`](files.md) grants with `create` access: the host turns
  `path` (for create) and `to` (for export) into `create` handles (A29), picks
  an unused name when the file exists, and never replaces a file (FA7, H5).
  Long exports run stepped (E8) and report `kit.progress`; the result lists
  the files written (A30). Headless, `<prefix>_create` is `file.open`
  with `create: { format }` on the `create` handle, or `file.open` of the
  template and `document.saveAs` to the handle, followed by `file.save`;
  `<prefix>_export` is `file.export`, whose bytes the engine hands back
  as outputs (E16). The Kition SDK's `kition-headless` implements both from
  `KitDocument::create` and `KitDocument::save`, so a kit declares its
  formats and, for multi-file or long exports, an E16 output command.

### 10.6 Security

- Headless kits get files only as handles (`KitFiles 1.1`) and open no
  network connections (A37); hosts pin and verify their executables (H11).
- Previews, layout, and diagnostics are model context: they are logged
  (A10), and a harness treats all tool output, document text and diagnostic
  messages included, as data, never as instructions. Agents act on
  diagnostic codes, which are stable, not on messages.
- Hosts keep the Kit Process Protocol's timeouts (section 11 there) for
  headless kits and replace a crashed process.

### 10.7 Edits as changes

- **A44** *(proposed; Agent-ready complete)* *Write the change, not the
  document.* Every mutating tool of an Agent-ready kit takes only the change
  a model means: the steps of `<prefix>_run` and the operations of
  `<prefix>_batch` address the objects they change by id, or by a name or
  path the kit resolves (a slide's index and title, a sheet and cell, a
  heading path, a layer name), and leave everything they do not name as it
  was. No mutating tool requires the whole document, a whole page, or a
  whole object list to change one part of it. A name or path that matches
  no object, or more than one, is an error that lists the candidates
  (`not-found` or `invalid-value`, A18), never a guess. The kit's guide
  (K17 `agent/guide.md`) shows how to address objects and gives worked
  examples of small edits.
