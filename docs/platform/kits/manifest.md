# Kit package and manifest

> **Kition kit platform, not KHP.** Platform requirements and implementation contracts.
> KHP's minimal manifest (`khp`, `id`, `name`, `version`, `formats`,
> `creates`, `exports`, `agent`, and `level`) is in KHP's `spec/manifest.md`;
> this page is the full `kit.json` of Kition's kits, which adds the engine,
> editor, headless, files, links, and data model fields. Where K1, K2, K4,
> K5, K16, and K17 differ, KHP 1.0 has the protocol's form and this page
> Kition's. `khp` names only the KHP version (`1.0`); the platform rules
> below key off the platform fields themselves (`engine.contract`, `model`,
> `ui`), never off `khp`. `tools/check-manifest.mjs` labels each failure
> `(KHP Kn)` or `(platform Kn)`.

How a kit is packaged and described. Integrators read a manifest to learn what a kit opens, creates, exports, and offers to agents; they never write one.

### Kition product names

Kition's maintained kits use one singular lowercase identity across their manifest,
repository, SDK, tools and editor package. Note is the published kit; the
publication allowlist is `published-kits.json`. Product naming rules live in
`tools/kit-naming.mjs` and do not constrain third-party KHP products.

The identity `name` derives `kit.name`, `kition-name`, `kition-name-kit`,
`kition_name_kit`, `kit-name`, the Agent prefix `name`, and the editor directory
`name-ui`. Display names are capitalized (PDF, CAD and HTML remain uppercase).
The create type is `name` and its base name is `Untitled name`, preserving uppercase
acronyms. A native extension is `.kname`; its MIME is
`application/vnd.kition.name+zip`, `+json` or `+sqlite3`, matching the actual container
(a zip package, a JSON document, or a SQLite 3 database).
Standard formats and MIME types retain their standard names. Note uses Markdown.

`KitDocument`, `document.check`, DOM `document`, word boundaries, and Office XML
names retain their technical meanings. Only product identities follow these rules. A
manifest carries no upstream fields: a kit derived from another project credits it
only in its repository's `NOTICE`. `tools/check-kit-naming.mjs` checks manifests, schemas, package metadata
and lock entries; `check-manifest.mjs` also checks the product fields. Kit packages
ship `kit.json` with a package-relative model schema path, and generated SDK modules
must come from the same package revision the host pins.

> Tool and schema paths (`tools/...`, `schemas/kit.schema.json`) are in the
> Kition SDK repository, which implements the conformance checks.

A kit is distributed as a **kit package**: a directory or archive with a
manifest named `kit.json` at its root, the engine's WebAssembly module, and
optional native executables. The manifest is validated by
`schemas/kit.schema.json`.

```json
{
  "khp": "1.0",
  "level": "basic",
  "id": "example.video",
  "name": "Example Video",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "engine": {
    "module": "example_video",
    "class": "VideoDocument",
    "contract": 1
  },
  "formats": [
    { "id": "video", "extensions": ["examplevideo"], "mime": "application/vnd.example.video+json", "role": "edit" }
  ],
  "creates": [
    { "id": "video", "extension": "examplevideo", "baseName": "Untitled video", "size": { "width": 1920, "height": 1080 } }
  ],
  "exports": [
    { "extension": "mp4", "mime": "video/mp4" }
  ],
  "imports": [
    { "extensions": ["mp4", "mov", "webm", "wav", "mp3"], "action": "project-from-clip" }
  ],
  "capabilities": ["lent-files", "audio", "stepped-export"],
  "extras": {
    "audio": { "params": ["startSeconds: f64", "frames: u32"], "returns": "Float32Array" },
    "exportStep": { "params": ["job: f64", "budgetMs: u32"], "returns": "string" }
  },
  "ui": {
    "mode": "embedded",
    "entry": "ui/index.html",
    "menus": ["File", "Edit", "Clip", "Sequence", "Markers", "Graphics and Titles", "View"],
    "layout": "timeline",
    "display": "menus"
  },
  "agent": {
    "tools": "commands",
    "prefix": "video",
    "drafts": true,
    "objectModel": false,
    "layout": false,
    "include": ["edit.*", "timeline.*", "sequence.*", "file.import", "file.exportMedia"],
    "exclude": ["file.open", "file.save*"]
  },
  "headless": { "executable": "example-video", "protocol": "kition-kit/2", "features": ["model.describe", "model.batch"] }
}
```

Requirements:

- **K1** `id` MUST be a reverse-domain-style identifier unique to the kit
  (`kit.<name>` is reserved for kits published by the protocol's maintainer).
- **K2** `khp` MUST name the KHP version the kit conforms to, `1.0`
  (KHP K2). It says nothing about the platform: a kit on the Kit Data Model
  says so with engine contract 2 (K10). A manifest with a `standard` field is invalid. `level` is the KHP tier the kit claims (KHP K19), and
  `agent.drafts`, `agent.objectModel`, and `agent.layout` are KHP's (KHP
  K16); on the platform `agent.objectModel` is `true` exactly when
  `headless.features` has `model.describe` and `model.batch`. So is
  `agent.links` (KHP K21, at every tier): `true` when the kit's documents
  can link or embed other files by reference (wikilinks, embeds, cards,
  linked media and images, external references); such a kit reports their
  links in `<prefix>_inspect` (KHP A42) and ships
  `conformance/links-outside.<ext>`, named after the first extension of the
  format it edits. A kit whose documents link nothing omits it or says
  `false`. `tools/check-manifest.mjs` refuses a value that is not a boolean,
  and fails a kit that says `true` without the fixture beside `kit.json`.
  KHP's K21 is not this page's K21 (below); the labels `(KHP K21)` and
  `(platform K21)` tell them apart. A format's `role` is `edit` or `view`
  (read-only).
- **K3** `engine.contract` MUST be the engine contract version the module
  exports (`contractVersion()`, [engine contract](engine.md)).
- **K4** Every extension in `formats` with role `edit` is a file the kit owns:
  the host routes it to the kit and the kit saves it in place.
- **K5** Every extension in `exports` is a file the kit writes as a new file
  only. An entry is `{ extension, mime? }`; the command that writes every
  format is `agent.export.command` (K21). `exports[].command` is not read by
  any host, tool, or the self-test, and should be omitted. A host MUST NOT let an export replace an existing file ([host contract](host.md)).
  Exports go through `files/create` ([`KitFiles 1.1`](../sets/files.md)), so
  `files.create` (K15) covers them.
- **K6** `extras` MUST list every method the module exports beyond the
  contract, with its parameters, so hosts and harnesses can reach them
  through `invoke` without guessing.
- **K7** `capabilities` declares optional behavior. Hosts MUST refuse a kit
  that requires a capability they do not provide.
- **K8** `ui.mode` is `embedded`: the kit draws its editor
  ([kit editors](ui.md)) and MUST name its UI entry in `ui.entry`, a path
  inside the package. There is no `host` mode: no
  host draws kit editors. The optional `ui.display` is the editor's
  default display mode (U5c).
- **K9** `headless.features` lists the optional [Kit Process Protocol](../reference/kit-process-protocol.md) features the
  headless executable serves, exactly as its `kit.initialize` answers them in
  `capabilities.features`, so a host knows them before it starts the
  executable. An executable that serves the object model (an engine contract 2 kit,
  [`KitObjectModel 1.0`](../sets/object-model.md), `model.describe` and `model.batch`) lists both.
- **K15** *(KitFiles 1.0; not yet implemented)* A kit that reads, creates,
  or replaces files other than its document ([`KitFiles 1.1`](../sets/files.md))
  lists the capability `files` and declares what it may ask for:

  ```json
  "files": { "read": ["pdf", "png", "jpg"], "create": ["pdf", "png", "jpg", "txt"], "folders": true, "print": true }
  ```

  `read` and `create` are extensions without the dot; `folders` (default
  `false`) allows folder grants; `print` (default `false`) allows
  `files/print`. `create` MUST cover every extension in `exports`, and every
  `file` parameter's `accept` (A28) MUST stay within `read` (access `read`)
  or `create` (access `create` and `write`). A host MUST refuse a grant
  outside these lists and SHOULD show them before it installs a plugin kit.
- **K16** *(proposed; Agent-ready)* The manifest of a kit that claims the
  Agent-ready profile ([`KitAgent 1.4`](../sets/agent.md) section 10) MUST
  have `agent.prefix` and `headless.executable`, and its
  `headless.features` MUST include `document.check`, `view.layout` for a
  layout kit (A40), and `model.describe` and `model.batch` for a kit that
  lists `kdm` (K9 still requires them to match `kit.initialize`).
- **K17** *(proposed; Agent-ready)* The package of an Agent-ready kit MUST
  contain `agent/checks.json`, its check catalogue (A38), and SHOULD contain
  `agent/guide.md`: a short guide for models, saying what the kit's
  commands are for and how to write its content, with two worked examples.
  The guide is required at stage Agent-ready complete.

  The package ships the kit's `agent/` folder beside `kit.json` (KHP K20: the
  manifest is at the package root), copied from the kit repository's `agent/`
  unchanged, so a host or `khp check --package` reads them without the
  repository:

  | File | Required | What it holds |
  | --- | --- | --- |
  | `agent/checks.json` | At Agent-ready (A38, K17) | The check catalogue: `[{ code, severity, summary, fixture }]`, every code the kit's check reports |
  | `agent/commands.json` | SHOULD, at every tier | The agent-facing command catalogue, below |
  | `agent/guide.md` | SHOULD; at Agent-ready complete (K17) | The guide for models |

  `agent/commands.json` is `{ "khp": "1.0", "kit": "<kit id>", "commands":
  [{ command, tool, title, mutates, inputSchema, outputSchema }] }`: one entry
  per command the engine's `commands()` lists with a `schema` (A6), in that
  order. `tool` is the A2 name (`<prefix>_<command>`); `inputSchema` is the
  command's `schema` as JSON Schema (A5's conversion, `file` parameters as
  A29 strings); `outputSchema` is the JSON Schema of the tool's structured
  result, which accepts the A18 error result `{ error: { code, message,
  index?, retryable? } }` too. It MUST agree with the engine's `commands()`
  (`schema` and `outputSchema`, engine contract 1): a kit tests that the file
  equals what it generates, and regenerates it when a command changes. A host that builds per-command tools reads it from the package
  when it cannot ask the engine; when it can, the engine's `commands()` wins.
- **K18** *(KitLinks 1.0; not yet implemented)* A kit whose documents link
  other files ([`KitLinks 1.0`](../sets/links.md)) lists the capability
  `links` and declares:

  ```json
  "links": { "kinds": ["link", "embed", "media"], "read": ["md", "png", "kboard"], "retarget": true, "names": true }
  ```

  `kinds` are the link kinds its documents store (`link`, `embed`, `card`,
  `media`); `read` are the extensions, without the dot, of targets it may
  read through link handles (LR3); `retarget: true` promises the command
  `links.retarget` (LK2, E18); `names: true` says it stores name links and
  needs name resolution (LR4). Its engine exports `linksOf` (E17), named in
  `extras` (K6), and its `headless.features` include `document.links`. A
  kit that asks for previews, opens files, or opens web addresses lists
  `preview-files`, `open-file`, or `open-url` in `capabilities`. A host
  MUST refuse a link grant outside `read` and SHOULD show these before it
  installs a plugin kit. Such a kit's documents link files, so its manifest
  also says `agent.links: true` (KHP K21, see K2).

- **K21** *(Kition platform)* A kit whose agent tools a host generates says
  how they read to a model in `agent.describe` (`noun`, `fileTypes`,
  `reports`, `covers`, `queries`, and an `example` command id): a host builds
  the tools' descriptions and its model instructions from it and from the
  manifest's `name`, `formats`, `creates`, and `exports`, never from a table
  of its own. `agent.render` names the engine command that renders one part
  of a document or a diagnostic's target (KHP A39); `agent.export` (`command`,
  `data`, `params`) is how `<prefix>_export` writes each extension in
  `exports` as a new file (KHP A41) through a command that answers the file's
  bytes. A manifest without `agent.describe` still works: the host words the
  tools from the kit's name and formats.

  `agent.parts` lists the kit's part nouns: the members a `<prefix>_run`'s
  `target` and a step's `at.part` take (`["sequence"]` for a video kit,
  `["comp"]` for motion graphics, `["sheet"]` for a spreadsheet). Each names
  one part by the id the kit's inspect lists (a whole number or a string),
  even when the noun is `page` or `slide` (then it is no number counted from
  1), in a run's `target`, a step's `at.part` and an inspect's `target`,
  and the host passes the part to the kit's `context.set` unchanged (Kit Process
  Protocol section 7a); a call gives exactly one of them, and any other
  member is `invalid-params` naming the ones the kit takes. Only
  `context.set` reaches a declared part, so a kit that declares parts
  implements the editor-state hooks. The run tool's published `target` and
  `at.part` list exactly these nouns. A kit that declares none takes
  `slide` and `page` (counted from 1) and `slideId` and `pageId`. The view a
  preview draws is the render command's own (below): a part noun is a view
  member only if the render command's `target` declares it too.

  The render command's contract, for `<prefix>_inspect` with `preview: true`
  and `<prefix>_run` with `preview: true` (after the steps). A preview is a
  function of the document and the view the call gives, never of the
  editor's current part, time, or selection: the host does not send the kit
  to a part (`slide.go`, `page.go`) to draw it.

  | Parameter | Meaning |
  | --- | --- |
  | `scale` | Device pixels per document unit, up to 2; always sent, `1` unless the call gives one |
  | `maxSize` | At most this many pixels on the longer side, up to 4096; sent when the call gives it |
  | `target` | The view: inspect's whole `target` (a run's `view`), passed on unchanged, for example a diagnostic's `{ path }` or `{ objectId }`, a timeline's `{ time }` (seconds) or `{ range: [from, to], frames }`, or the kit's part (`{ sequence }`, `{ comp }`) |
  | `slide` | One slide or page, counted from 0, when the call names a part (`slide`, `page`, `slideId`, `pageId`) that the command's `target` does not declare |

  The view members a kit takes are those its render command declares in
  `target.properties` of its parameter schema (`commands.list`), so a kit
  adds one without a change in the host. A member it does not declare is
  refused with `invalid-params`, naming the members it takes; a `target`
  declared without `properties` takes any member. A command whose schema
  the host cannot read (its open editor does not list it) gets the target as
  given and refuses what it cannot draw.

  It answers `{ "png": "<base64 PNG>" }` at the top of its result, framed to
  what it draws, and it is never an edit: nothing is saved. Every other member
  of its answer (`width`, `height`, `scale`, and for a timeline `sequence`,
  `frames: [{ time, frame, label }]`, `columns`, `rows`) is what the picture
  shows: the tool answers it as `preview`, so a model knows which times the
  picture shows. A kit with `agent.render` never falls
  back to the screenshot: when the render command fails, is not offered, or
  answers anything but a top-level base64 `png` (for example
  `{ change, result: { png } }`), the preview fails with the error `failed`
  (KHP A18), whose message names the command, says what it answered, and
  repeats the shape above (A48). A run's preview that fails leaves the run
  as it went and answers `previewError`.

  A kit without `agent.render` previews with its `view.screenshot` (Kit Process Protocol
  section 7), which gets the call's `maxSize` (1024 when the call gives
  none), its `scale` (when the call gives one), and its `target` less the
  slide or page the host already went to with `slide.go` or `page.go`. The
  screenshot draws what it is asked or refuses it: a kit on
  `kition-headless` draws the whole document, smaller to fit `maxSize`, at a
  `scale` up to its engine's `max_render_scale` (1 by default), and refuses
  a larger scale and any `target`. A document open in its editor previews
  through `ai/preview`, which draws the whole document at scale 1 within
  `maxSize`. A refused preview fails the call with the error `unsupported`
  (KHP A18), whose message gives the kit's reason (the scale it draws at
  most) and the call to make instead (inspect without `scale`, or without
  `target`, A48); it is never the whole document at scale 1 instead (A24,
  A39). A kit whose engine draws real detail at scale 2 says so with
  `max_render_scale`; a kit that previews targets declares `agent.render`.

  The export command `agent.export.command` runs for every extension in
  `exports`, with `format` set to the extension and the fixed `params`, and
  answers the file as base64 in the field `data` names; it names no file.
  The kit's self-test (`kition_headless::agent_ready`) exports the same way,
  so it tests the path agents take. `exports[].command` is optional in
  `kit.schema.json` and nothing reads it: omit it (K5). A kit whose formats
  need different commands gives them one command that switches on
  `format`. The export command MUST be one the agent may run (`agent.include`
  selects it, `agent.exclude` does not name it, and `agent/commands.json`
  lists it). `tools/check-manifest.mjs` warns about an `exports[].command`
  that names another command and about an export command the agent may not
  run, since only the engine's own command list settles which is right.
- **K22** *(Kition platform, [`KitText 1.0`](../sets/text.md))*
  `headless.capabilities` lists the platform capabilities the headless
  executable serves, exactly as its `kit.initialize` answers them in
  `capabilities.capabilities`. The one capability is `document-text`: the
  executable answers `document.text` with the document's words (T1). A kit
  lists it when its words live outside its object model; it is never a
  `headless.features` entry.

## Manifest for engine contract 2


A kit on the Kit Data Model (engine contract 2) adds these fields to the fields above; `schemas/kit.schema.json` describes them and
`tools/check-manifest.mjs` checks K10 to K14.

```json
{
  "khp": "1.0",
  "id": "example.database",
  "distribution": "default",
  "engine": { "runtime": "rust-wasm", "module": "example_database", "class": "DatabaseDocument", "contract": 2 },
  "capabilities": ["kdm"],
  "model": { "schema": "model/schema.json", "schemaVersion": 1 },
  "collaboration": { "merge": ["database"], "leases": [], "serverValidation": false },
  "objectModel": { "namespace": "Database" }
}
```

- **K10** `engine.contract` 2 and the capability `kdm` go together, and a
  contract 2 kit has the fields of K11 to K14. A contract 1 kit MAY name a
  KDM schema (`model`, K12) before it moves to contract 2.
- **K11** `distribution` is `default` (ships with a host) or `plugin`
  (installed on demand); `engine.runtime` is `rust-wasm` (a Rust engine
  compiled to WebAssembly) or `ts-worker` (a TypeScript engine in a worker).
  A `ts-worker` engine is the ES module `<module>.js` in the package's engine
  folder: it exports the document class `engine.class` and, when it needs
  preparing (the WebAssembly of a dependency such as Loro), a default export
  that a host awaits with `{ base, read }` (`KitEngineInit`: the folder's URL,
  and in Node a reader of the folder's files) before the first document;
  there is no `<module>_bg.wasm` for the host to load. `@kition/kit-editor` loads
  it when its `KitModuleManifest` says `runtime: 'ts-worker'`, and
  `tools/check-manifest.mjs --module` checks it like a WebAssembly module.
- **K12** `model.schema` is the KDM schema's path relative to `kit.json`
  (`model/schema.json` in a package); the file is a valid schema ([`KitModel 1.0`](../sets/model.md))
  of this kit (`kit` equals `id`), and `model.schemaVersion` equals its
  `schemaVersion`.
- **K13** `collaboration.merge` names the merge classes the kit's data maps
  to: `structured`, `rich-text`, `database`, `grid`, `timeline`, `raster`,
  `overlay`, `binary`. `leases` lists the scopes it leases (M21), and
  `serverValidation` whether a server should validate pushed changes with the
  kit's headless engine ([sync-protocol.md](../reference/sync-protocol.md) section 4); a
  kit that sets it serves the replica methods (`model.open`, `model.import`,
  [object-model.md](../reference/object-model.md)) from its headless executable.
  `comments.commands` lists the engine commands that write only comment
  threads (M23), never the history or a `file` command: what a commenter's
  read-only session runs, with Undo and Redo of what they ran.
- **K14** `objectModel.namespace` is the namespace of the kit's generated
  object model typings (`@kition/script`'s `kits/`).
