# Changelog

The Kition SDK's versions (`sdk.json`). Each entry names the contract versions it carries.

## Unreleased

- **The quality rules say where the full checks run**: since the kits' full checks moved to their
  CI run on GitHub, the template put a kit's pre-finish check (`cargo fmt --all -- --check`) into
  sentences written for `cargo xtask ci` ("an existing test that `cargo fmt --all -- --check`
  already runs", "the commit is refused by" it). `templates/quality/repositories.json` now holds,
  per repository, the pre-finish check (`check`) and where the full checks run (`fullChecks`: the
  kit's CI run, the repository's own CI run, or the check itself, locally), and `docs/quality.md`,
  `AGENTS.md` and the contributing guide and pull request template say each in its own sentences
  (regressions/issue-quality-full-checks). The cases of the `gate` layer are "gating tests" in the
  quality reference's prose.
- **`node ../kition-sdk/tools/sync-quality.mjs .` needs no flag**: the title of `docs/quality.md` is
  the repository's product name (from `templates/community/repositories.json`, or the quality
  table's `name` where that file does not name it), not the folder name, and the owner is the
  table's `@KitionAI/owners`; `--name` and `--owner` override them
  (regressions/issue-quality-sync-defaults). Each run prints a `warning: <file>:<line>` for a line
  of a repository's own `AGENTS.md` or `.claude/CLAUDE.md` text that contradicts the generated block
  (asks for `cargo xtask ci` before a commit where the kit's CI run runs it, or forbids CI), without
  failing (regressions/issue-quality-contradiction-warnings).
- **A kit's expected previews are `conformance/expected/`**: the folder of the expected previews
  of `basic` and their `tolerance.json` was `conformance/golden/`; KHP renamed it before its first
  release, and the quality rules no longer use that word (a case's `source.kind` `golden-sample`
  is `reference-sample`; the conformance suite's `--golden` is `--expected`).
  `kition_headless::agent_ready::check` reads `expected/` only, and `tools/check-expected.mjs`
  protects `conformance/expected/` through its `**/expected/**` glob; neither reads the old folder
  name, since all 16 kits have moved (regressions/issue-expected-folder-rename,
  regressions/issue-expected-folder-rename-guard).
- **A list window holds which objects are in it, not their order**: a kit's ordinal `within`
  window refused any move of a member by another writer, so the motion kit's all-mask assignment
  (window `[0, n+1)`) was refused as `relocated` after a swap of two masks. Each change is now read
  in the list before and after it: an object created or deleted inside, moved or shifted across an
  end (an insertion or removal before the window shifts one), or a member's position field changed
  refuses; a reorder among the members applies (regressions/issue-guard-window-membership).
- **A receipt's place is a raw batch target as given**: `{parent: 1, field: "comp.layers"}` replayed
  as `target: 1` reached the kit's planning copy as a number ("`target` is a string"), and as `"1"`
  was refused for a missing premise contract although the comp declares `list.move.layers`.
  Number ids are passed as strings, a nested holder path is checked with the contract of the
  object holding its last field, and the object model says what it got for an id that is no string
  (`give "1" for the number 1`) (regressions/issue-guard-held-batch-target).
- **`@kition/sdk/script` and `/extensions` share Loro and the KDM with `/kdm` and `/sync`**: they
  were the standalone build (Loro's WebAssembly inlined, a KDM of its own), so an app importing
  them beside `/kdm` held two of each, and Kition Desktop kept copies of their sources. They are
  library builds now, importing `loro-crdt`; the self-contained object model for a page without a
  bundler is `@kition/sdk/script/standalone` (every kit registered). `/kdm` exports `wrapEnvelope`
  beside `openEnvelope`; `LICENSE` is at the package's top (regressions/issue-sdk-script-second-loro).
- **The release reads Kition's npm kit pins**: the kit check and the SDK bundle wanted a `package`
  field Kition's lock never writes; `tools/kit-lock.mjs` reads its pin (`scope`, `version`, the build
  commits, `editor` and `platforms` with integrity and size), naming the packages from the kit and
  the scope, and refuses a GitHub Release pin and a pin of another scope than the release's
  (regressions/issue-kit-lock-npm-pin).
- **The kit index leaves out withdrawn kit versions**: Kition Table was published by mistake as
  0.5.8 before its first version, 0.1.0; npm keeps it, so `kition kit install table` took 0.5.8 as
  the highest version. `kits-withdrawn.json` names such versions per kit (`{ "table": ["0.5.8"] }`),
  and `tools/kits-index.mjs` reads it by default (`--withdrawn <file>` for another): a withdrawn
  version is skipped unread (no size asked, not compared with by the holding rule) and the report
  names it (`withdrawn, left out: 0.5.8`); a malformed list, or one naming a kit `modules.json` does
  not have, stops the run (sdk.distribution.kits-index/withdrawn).
- **The kit index is gathered while a tarball is not downloadable yet**: for a minute or two after
  a publish npm lists a version whose tarball still answers 404, and the kits-index run stopped on
  it ("the size of @kition/kit-doc-darwin-arm64@0.1.4 cannot be read"), during every kit publish.
  Such a package now counts as not published in that run: its version is held back when a lower
  listed version has it, and the report says the tarball is not downloadable yet; any other failure
  still stops the run (regressions/issue-kits-index-tarball-not-ready).
- **The kit index holds back a version still being published**: a kit's packages reach npm one
  after another, and an index gathered in between listed Layout 0.1.4 without its editor, so
  `kition kit install layout` took it over 0.1.3, which has one. A version that lacks a platform or
  editor package the kit's highest listed lower version has is no longer listed; the gatherer's
  report names it (regressions/issue-kits-index-unfinished-version).
- **Undo passes over a group whose changes came to nothing** (`kition-kdm`): an undo group whose
  edits cancel out (Enter then Backspace, a value written and written back) was, since the replica
  keeps its own undo steps, a step whose undo changed nothing, and the typing before it stayed for
  the next Undo. Undo and redo now pass over it and take back the step before it in the same call,
  as Loro's undo did before (and `@kition/kdm` does); a single transaction whose engine undo comes
  to nothing no longer leaves `can_undo` true with nothing to undo
  (regressions/issue-kdm-undo-step-that-changed-nothing).
- **The kit index is format 1 and `@kition/kits-index` is versioned `0.1.<n>`**: every format and
  protocol is version 1, and nothing is released as 1.0 yet. `kition` refuses an index of any other format, naming both.
- **The kit index is gathered past npm's placeholder of a first publish**: npm keeps a version
  `0.0.0-stage` of its own, without a `kition` field, beside a package's first version, and the
  kits-index workflow stopped on it for the first kit packages on npm. It is left out; any other
  version without the field is still refused (regressions/issue-kits-index-npm-placeholder).
- **The kit index reads a tarball's size from registry.npmjs.org**, which answers a tarball's HEAD
  without Content-Length: the gatherer then asks for a one-byte range and takes the total from
  Content-Range (sdk.distribution.kits-index/gather).
- **A kit of another protocol is refused with the right advice** (`kition kit install`, `kit add`):
  every protocol is version 1, so the refusal no longer says "upgrade kition" for a kit built
  before that; it names both protocols and says to install a version of the kit that speaks
  this kition's.
- **An editor opening a managed room never stores a state older than the file** (`@kition/embed`).
  A page with no record of the room (another person, another browser, cleared site data) replaced
  the host's stored replica, a save's checkpoint of the room's document under the file's current
  version, with the room's snapshot from `snapshot/get` (its creation, seq 0) under that same
  version; kits that rebuild on open (Slide, Doc, Sheet) then recorded the file on top as an
  import and the relay replayed the room's changes, duplicating content on every reopen. A stored
  replica of the room's document stamped with the file's version is now kept, record or not (the
  first join catches up from the room's snapshot; imports are idempotent). When the embed must
  store the room's state, it brings the snapshot up to the room's last save (`savedSeq`) first and
  the relay joins from there (regressions/issue-embed-adopt-checkpoint).
- **The DeepSeek Harness plugin never starts a kition without the gateway command**: its own
  kition, `KITION_BIN` and `KITION_KITS_MCP` are asked (`kition gateway --help`) like a system one;
  a capable kition after an old one is taken, and otherwise the tab and `kition_setup` name the
  old one's file and version and what to do. The plugin's tests and the release's check install it
  from their local registry only (`hermeticInstallEnv`: none of the runner's npm or pnpm settings,
  cache or store, since `npm run` and `npx` pass npm_config_userconfig, which made pnpm take npm's
  `@kition/cli` 0.5.2, without the gateway, under the same version), check the registry served
  `@kition/cli` and the platform package, and that the installed kition is the packed one; the
  release stops when npm has kition's packages or the plugin of its version with other bytes, and
  every platform's kition must answer `kition gateway --help` before anything is published
  (regressions/issue-dsh-registry-leak).
- **Kits, the kit index and `kition` come from npm, not GitHub** (feature
  `sdk.distribution.npm-registries`). Each kit version is published by its repository as the npm
  packages `@kition/kit-<kit>-<platform>` (`kit.json` and the executable) and `@kition/kit-<kit>-ui`
  (the editor folder `<kit>-ui/`), the same files as the archives before, with a `kition` field in
  `package.json`; `tools/kit-npm-package.mjs` writes, packs and checks them for Kition's Package
  workflow, and a version is published once. The kit index is the npm package
  `@kition/kits-index` (format 1: each entry is a package, its size and npm's `sha512-` integrity),
  gathered by `tools/kits-index.mjs` from the registry's metadata and published by the `kits-index`
  workflow only when it changes. `kition` downloads the index, kits and editors from
  `KITION_NPM_REGISTRY`, npm's own `.npmrc` setting, `registry.npmjs.org`, then
  `registry.npmmirror.com` (reachable from mainland China): a registry that does not answer within
  5 seconds or serves other bytes passes to the next, a cut download resumes or passes on, the
  integrity is always checked, and an error names every registry tried; `kition doctor` lists the
  registries. `install.sh` and `install.ps1` install `@kition/cli-<platform>` from the same
  registries with `curl` and `tar`, checked against its integrity, and ride in `@kition/cli`
  (`curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh`); `KITION_RELEASES_URL` is
  gone. The SDK bundle takes each kit's editor package from npm by the integrity Kition's lock
  pins. `kition` 0.5.2 and earlier read the branch `kits-index`, which is no longer written:
  upgrade them to see kit versions published from now on.
- **A forked document is co-edited in its own sync room** (sync protocol S20, KitModel M7a,
  M16a). A copy made as a new document (`Replica::copy_as_new_document`, `copyAsNewDocument`, and
  so every file `document.fork` writes) is shallow, and a sync server refuses a shallow snapshot as
  `room/create`'s, so no forked file could be shared. The copy's first change now records its root
  as the document's **birth**, and `carries_whole_history()` (`carriesWholeHistory()`; for a server
  without a schema, `Replica::snapshot_carries_whole_history(bytes)`,
  `Replica.snapshotCarriesWholeHistory`) is true for a full replica and for a shallow one whose
  state at its root records that root as its birth: the copy and every replica loaded from it.
  S20 now refuses only a snapshot that does not carry the document's whole history (truncated
  after its birth, or recording none: copies made by board 0.1.4-dev builds, which are copied
  again). `@kition/script`'s `createRoom` and the embed refuse a truncated replica with a clear
  error before `room/create`. The relay in `@kition/sync` never pushes a snapshot as changes (a
  shallow replica with an empty `lastSent` sends the changes after its root; `ReplicaVersions`
  has `snapshotRoot`), and what it has sent advances only once the room takes a push, so a refused
  or failed push is sent again with the next one; before, it was lost. The test sync server
  checks KDM exports as Kition Server does. Kits pin the new SDK revision and change nothing
  (sdk.collab.fork-rooms/create-and-converge, regressions/issue-sync-relay-shallow-push,
  regressions/issue-sync-relay-refused-push).
- **The embed merges a draft as the person before any agent port opened**: with an identity, a
  `draft.merge` before `editor.agentPort()` carried the principal `agent`, which a sync server
  refuses for a person's token; it is now the person's id (regressions/issue-embed-agent-principal).
- **A forked document's every change loads** (KitModel M14, M16a). A shallow replica, above all
  a copy as a new document and so every file `document.fork` writes, answered `export_changes`
  since the empty version (`exportChanges()` in TypeScript) with only the changes after its root,
  which `Replica::load` refused ("meta.kit is missing"): the object model over a kit's change
  exchange (`Headless::with_replica_port`: `model.batch`, `model.describe`) and agent drafts
  (`model.export`, then `model.open`) failed on every forked file. For a `since` that does not
  reach its root it now answers its snapshot, which loads as the document and imports into any
  replica that has the root; a full replica's export, and one since a version at or after the
  root, are unchanged. Kits need no workaround (regressions/issue-kdm-shallow-export).
- **Kit Process Protocol: `document.identity` and `document.fork`** (section 5.6, feature
  `document.identity`). A host reads the `docId` a file carries (`{ docId }`, `null` for none) and
  forks a file into a new document (`{ file, target }` → `{ docId, name, version }`: the embedded
  replica replaced by a copy as a new document, no history, the same object ids; a file without a
  replica is copied unchanged), without knowing the kit's format. `kition-kit-server` answers both
  from `KitBackend::file_identity`: `FileIdentity::NotEmbedded` needs no other code, and a kit
  whose files embed the replica gives `FileIdentity::Embedded` with an `EmbeddedReplica` (its
  schema, where the replica's bytes are, how to put others in their place); `kition-headless`
  takes it with `Headless::with_file_identity`. Hosts call `HeadlessKit::identity` and
  `HeadlessKit::fork`. The reference grid kit declares `NotEmbedded`; a kit that declares nothing
  answers "method not found".
- **The kit tools are there for a session's first step in DeepSeek Harness**: the plugin
  registers the unified tools' names at start, each admitted to a step once the kits listed it
  (waiting at most 30 seconds for the first list); a session's first request went without them
  while kition was still listing (regressions/issue-dsh-tools-ready).
- **Every protocol is version 1.** The Kit Process Protocol is version 1 (`PROTOCOL_VERSION` 1,
  `kition-kit/1` in `kit.json` and the kit index, the ready line and `kit.initialize` say `1`,
  `khp/1` in an inspect's `interface`); kits built on an earlier SDK speak 2 and are refused until
  they are rebuilt. The Kit UI protocol's documents now say what its code already did,
  `kition-kit-ui/1` and `kitionKitUi: 1`, without minor-version history, and the open sync
  protocol's reference states version 1.
- **`kition gateway --workspace <folder>`**: one workspace's kits on loopback HTTP
  (`http://127.0.0.1:<port>`, port 0 by default), as the one process that holds them: the Kit AI
  bridge to attached kit editors, `/kit-files/` reads, file grants, the person's draft review and
  the kits' MCP server (`POST /api/v1/mcp/kits`). It prints a JSON ready line (no token), keeps
  its token in a 0600 lockfile under `KITION_HOME/run/`, serves one workspace once (a second
  gateway exits with status 3), and stops on SIGINT, SIGTERM, SIGHUP, `--stdin-lifetime` or
  `--idle-timeout`. `kition doctor` names the running gateways.
- **The gateway's editor page** (`/page/?path=<file>`, `@kition/gateway-page`, built into
  `kition`): a workspace file in its kit's own editor, mounted over the Kit UI protocol from the
  kit's editor package, with real saves (atomic, refused over another version), replicas, KitFiles,
  theme, language and the host's shortcuts; the Kit AI bridge's window for it, answering
  `kit/documents` with the kit's capabilities and `kit/call` `version`, `changes` and `premise`, so
  an agent's call through a relayed `kition mcp` runs in the open editor, live; a banner while the
  agent has a draft of the file and the person's review (`/page/review?path=<file>`: the structured
  comparison, pictures before and after, Merge and Discard, overwrite for a stale draft); clear
  states for no kit, a downloading editor (its progress), a missing file, an unreachable gateway; a
  `postMessage` protocol for a host that frames it; Focus mode below 480 px. It works under any
  prefix of a same-origin proxy that adds the token, or opened directly: `--open [<file>]` and
  `kition gateway url --workspace <folder> [<file>] [--review]` print an address whose one-time
  signed bootstrap the page trades for a page session (`docs/sdk/gateway-page.md`). New routes:
  `/page/`, `/kits-ui/<kit>@<version>/`, `GET /api/v1/kits/editors`, `POST
  /api/v1/kits/editors/install`, `GET`/`PUT /api/v1/kits/replicas`, `POST /api/v1/gateway/sign`,
  `GET /api/v1/gateway/page-session/<nonce>`; `PUT /api/v1/kits/files` takes `expected` and answers
  `version`; `/kit-files/` answers an `ETag`; `GET /api/v1/kits` lists the kits the index would
  install on first use, not installed; `/api/v1/gateway` and `/api/v1/mcp/kits` need the token itself.
- **Editor packages in the kit store**: the kit index lists each version's editor package (`ui`,
  gathered by `tools/kits-index.mjs` from the kit repositories' `kition-<kit>-<version>.tgz` release
  assets and their entries; schema field added, read by older `kition`s as nothing).
  `kition kit install` and `upgrade` install it beside the kit (`kits/<kit>/ui/<version>/`), checked
  against the index's size and SHA-256; `kit list` (`EDITOR`), `kit info` and `kition doctor` show
  it; the gateway installs it on first use and serves it, or a development build named with
  `--kit-ui <folder>`.
- **A draft merged or discarded in another process** (`drafts merge` from the command line while a
  `kition gateway` or `kition mcp` that drafted it runs) no longer blocks the agent's next draft of
  the file, which failed with `draft-required` (the server still held the merged draft's
  document); it now drops that document and forks a new draft
  (regressions/issue-draft-merged-elsewhere).
- **An agent's draft is always headless** on a server that keeps drafts (`kition mcp`,
  `kition gateway`), even when the file is open in an editor attached to the gateway; it used to
  live in the editor's page and go with its tab (regressions/issue-agent-draft-in-editor). Bridge
  windows hear `kit/draftsChanged {path}` when a draft changes.
- **`kition mcp` relays to a gateway** for the same workspace when one runs, so an agent's edit
  of a file open in an editor attached to it happens in the editor; without one it serves as
  before, takes over when the gateway stops and hands over when one starts; `--no-relay` turns it
  off.
- **The kits' HTTP API is an SDK crate**, `kition-kits-http`, ported from Kition's runtime with
  its route paths, envelope and error codes, behind a transport guard of its own,
  `kition-http-guard` (loopback `Host` and `Origin` fence, the per-launch token, signed GET URLs).
  Changed from Kition's: `POST /kits/grants` takes a `choice` offered by the new
  `POST /kits/grants/choices` (and a new file's `name`) instead of a `path`; bridge session ids are
  random; `POST /mcp/kits` tells connections apart by `Kition-Mcp-Connection`, so clients no longer
  share requests in flight or cancel each other's calls; routes refuse absolute paths; reads open
  the file they checked; a link into the workspace's hidden store is refused like the store.

- **Published kits: all 16.** Board, CAD, Design, Doc, Film, Layout, Motion, PDF, Photo, Scene,
  Sheet, Slide and Vector join HTML, Note and Table (`published-kits.json`, `sdk.json`), each at
  the version Kition's `kits/kits.lock.json` pins: their generated typings
  (`@kition/script/kits/<kit>`), their schemas for `@kition/embed`, their manifests as
  `kition-kits` test fixtures (in place of the reduced stand-ins), and their Claude Code plugin
  skills (`<kit>-editing`). `@kition/script/kits/note` gains `view.scheme`, from the pinned Note
  0.1.2 package. The release builds every published kit's headless executable.
- **The DeepSeek Harness plugin `@kition/dsh-kits`** moves from `packages/dsh-kits` to
  `plugins/deepseek-harness/kition-kits` and becomes an installable DeepSeek Harness bundle
  (`dsh plugin --profile <profile> add <archive>`; Desktop through the app's own CLI), for
  DeepSeek Harness 0.2.2-rc.2 (Desktop's) and later 0.2.x (`engines.dsh`
  `>=0.2.2-rc.2 <0.3.0-0`), pinned to 0.2.2-rc.5. A kit file opens in its kit's editor (the
  gateway's editor page) in the right sidebar: a tab type for the extensions only Kition opens, the
  kit under Open with for those DeepSeek Harness previews (`.md`, `.html`, `.pdf`, `.docx`,
  `.xlsx`, `.pptx`), with the tab's unsaved and draft marks, a question before closing unsaved
  edits, DeepSeek Harness's theme and language, and states for kition missing (how to install it),
  starting and unreachable. Its host module runs one `kition gateway` per workspace folder, serves
  it same-origin under `/kition/` behind DeepSeek Harness's own login and only for its sessions'
  folders, and registers the kits' tools (`mcp__kition__kit_<action>`) so each session's calls
  reach its own folder's gateway, live in an open editor (DeepSeek Harness's MCP client runs one
  server per host, on one folder, and a call does not say its session). Also an editing skill per
  published kit, and the person's draft review (`/drafts-list`, `/drafts-compare`,
  `/drafts-merge`, `/drafts-discard`, the last two only from the person). It is no longer private;
  the release packs and publishes it. The old `kition-kits.stdio.cordis.patch.yml`, which started
  `kition-kits-mcp` with one variable per kit, is gone.
- **One install for DeepSeek Harness**: `@kition/dsh-kits` depends on `@kition/cli` at its own
  version, so `dsh plugin add @kition/dsh-kits` (the web runtime's CLI, Desktop's CLI or its
  Plugins page) installs the plugin's own `kition` with it, which it starts directly. Its order:
  `KITION_BIN`, a `kition` `KITION_KITS_MCP`, its own, then a system `kition` only when it has the
  `gateway` command (an older one is passed over and named). With none, a tab, a card and the
  agents' `kition_setup` tool say why: no build for the platform, optional dependencies left out,
  or a plugin added from a folder (pnpm links a folder without its dependencies). The plugin uses no
  gateway of another `kition` version, and the release publishes it after `@kition/cli` and its
  platform packages, once it installs by name from the packed archives
  (`tools/check-dsh-plugin-package.mjs`).
- **`kition mcp` relays to no gateway of another kition version** or gateway protocol (its
  lockfile's `version`, `protocol`): it serves in its own process and says so.
- **Human and agent together in DeepSeek Harness** (`@kition/dsh-kits`): each turn's kit edits are
  projected from the session log into review cards at the turn's tail (the file, its kit, a picture
  and the counts of what changed, and whether it was edited live, saved, drafted, stale, merged or
  discarded), with Open, Review (in the right sidebar's tab) and the person's own Merge, Discard and
  Merge and overwrite, never an agent's tool; the cards follow the drafts live, and what the person
  did is recorded with the workspace (`.kition/dsh-reviews.json`), so a reload or another browser
  shows the same cards. Before an agent edits a file that is not open, the host announces it to the
  browsers showing the session and waits, bounded (`KITION_LIVE_WAIT_MS`), for a live window to
  open the file's editor beside the conversation, so the first edit too runs live, without taking
  the keyboard. Questions (closing unsaved edits, discarding a draft) are a dialog in DeepSeek
  Harness's page, and DeepSeek Harness Desktop closes with unsaved edits in a Kition tab (it would
  not close at all). The person's settings (the live window, opening a file after the agent's first
  edit, Kition or DeepSeek Harness's preview first) are on the plugin's page, kept in the profile. An Open with preview's tab
  shows unsaved and draft marks and asks before it closes, the editor hands DeepSeek Harness its
  shortcuts, the kits' resources reach agents through DeepSeek Harness's resource tools, and the
  kit tools appear without a restart once kition is installed (until then one `kition_setup` tool
  says how), and are listed again after an upgrade.
- **View-only formats open read-only**: `GET /api/v1/kits` lists each kit's `views` (its `view`
  formats no kit edits there), and the gateway's page opens such a file in the kit's editor
  read-only (`state` gains `readOnly`). The kit index lists the extensions each kit only views
  (`views`, from its `kit.json` at its newest version's tag; schema field added, read by older
  `kition`s as nothing), so such a file opens before the kit is installed. The page also takes a
  host's extra shortcuts (`keys=`), opens without taking the focus (`focus=no`), leaves the
  question before unsaved edits are lost to a host that asks itself (`closing=host`: an Electron
  window, which shows no page's question, refused to close instead), opens the draft's review on a
  host's `review` command, and takes a merge made outside it (a host's review card). The page's
  review fills a frame narrower than its dialog, the banner hidden behind it, and its buttons sit on
  the dialog's bottom edge.
- **One skill generator for both agent plugins**: `tools/agent-plugin-skills.mjs` (was
  `tools/claude-plugin-skills.mjs`) writes and checks the Claude Code and DeepSeek Harness skills
  (`--target claude-code|deepseek-harness`, both by default); its test is
  `tools/agent-plugin.test.mjs`.
- **A copy as a new document**: `Replica::copy_as_new_document(doc_id, actor)`
  (`replica.copyAsNewDocument(docId, actor)` in TypeScript) answers a replica with a new permanent
  docId, written in both the meta map and the byte envelope, and the source's objects, ids, tree
  nodes and blob references. It carries no history (deleted content, earlier versions and the
  source's docId stay behind) and starts with empty undo; a copy and its source refuse each other's
  changes, drafts and snapshots. For templates used twice, copied files and repeated uploads
  (KitModel M7a, `docs/platform/data-model.md`).

## 0.5.2 (2026-11-19)

Contracts: KHP 1.0, the Kit Process Protocol `kition-kit/2`, the kit engine contract 1
(`CONTRACT_VERSION`), the Kit UI protocol `kition-kit-ui/1` and KDM 1, as in 0.5.0. The published kits
are those of 0.5.0.

- **`@kition/cli` on npm.** `npm install -g @kition/cli` gives the `kition` command, and
  `npx -y @kition/cli <command>` runs it (`npx -y @kition/cli mcp --workspace <folder>` for an
  agent). The package `@kition/cli` (`packages/kition`) is a Node launcher; the executable comes
  in the optional package `@kition/cli-<platform>` (`darwin-arm64`, `darwin-x64`, `linux-arm64`,
  `linux-x64`, `win32-x64`), the same `kition` as the release's archives. Without it
  (`--omit=optional`, another platform, musl) the command says why and names `install.sh`.
- **`@kition/kits-mcp` is replaced by `@kition/cli`**, and `@kition/kits-mcp-<platform>` by
  `@kition/cli-<platform>`: `npx -y @kition/kits-mcp ...` becomes `npx -y @kition/cli mcp ...`,
  `npx -y @kition/kits-mcp kit install note` becomes `npx -y @kition/cli kit install note`, and
  the launcher's variable `KITION_KITS_MCP` becomes `KITION_BINARY` (a `kition` executable only).
  `@kition/kits-mcp` gets no new version. The Claude Code plugin falls back to
  `npx -y @kition/cli mcp`.
- **`kition agent add` registers a command that keeps working**: started through npx, it registers
  `npx -y @kition/cli` rather than the executable in npm's cache; from `npm install -g @kition/cli`,
  npm's `kition` command rather than the executable inside `node_modules` (on Windows, `npx` and
  npm's `kition.cmd` through `cmd /c`). The launcher says how it was started in `KITION_LAUNCHER`
  (`docs/sdk/cli.md`). `kition doctor`'s PATH check looks for npm's `kition` command's folder, and
  through npx says there is no command on the PATH, for information.
- **The release workflow** smoke-tests `kition` from the packed launcher and platform package,
  installed with `npm install -g` on every platform; drafts the GitHub Release before publishing
  on npm and publishes it after; publishes `@kition/cli` after the platform packages it depends
  on; and, run again for a version already released, from its tag, publishes only the npm
  packages missing, with the released `kition` executables (`docs/sdk/distribution.md`).

## 0.5.1 (2026-11-19)

0.5.1 has no GitHub release and no command-line package. npm refused the launcher's package name
`kition` as too similar to existing package names, so the release stopped before it. Its other
`@kition/*` packages, the libraries and `@kition/cli-<platform>`, are on npm at 0.5.1. 0.5.2 is
the release that brings the command line, as `@kition/cli`.

Contracts: KHP 1.0, the Kit Process Protocol `kition-kit/2`, the kit engine contract 1
(`CONTRACT_VERSION`), the Kit UI protocol `kition-kit-ui/1` and KDM 1, as in 0.5.0. The published kits
are those of 0.5.0.

## 0.5.0 (2026-11-19)

Contracts: KHP 1.0, the Kit Process Protocol `kition-kit/2`, the kit engine contract 1
(`CONTRACT_VERSION`), the Kit UI protocol `kition-kit-ui/1` and KDM 1, as in 0.4.0.

- **Published kits**: `kit.note` 0.1.2 and `kit.table` 0.5.5, each built from its
  `package-v<version>` tag, with `kit.html` 0.1.0 as before
  (`crates/kition-kits/tests/fixtures/kits/`). Note's versions start again from 0.1: 0.1.2
  follows 0.3.0.
- **The kit index comes from the kit repositories.** Each kit repository publishes its own
  archives (`kition-<kit>-<version>-<platform>.tar.gz`) and an index fragment
  (`kits-index-<kit>-<version>.json`) in its `package-v<version>` Release;
  `tools/kits-index.mjs` merges every kit's fragments, and `.github/workflows/kits-index.yml`
  publishes the result, when it changed, as the one file of the branch `kits-index`.
  `kition`'s default index is now
  `https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json`
  (`sdk.json` `binaries.cli.defaultIndex`): every kit Kition names and every version its
  repository has published with archives, not only the kits in `published-kits.json`, installable
  as soon as the kit's Release has them. It is the one mutable thing this repository publishes
  (`docs/sdk/distribution.md`).
- **An SDK release no longer publishes kit archives**, and no longer carries an index forward:
  `tools/release-archives.mjs` writes the `kition` archives only, and the release manifest has no
  `kitArchives`. The bundle still carries the published kits' executables in `bin/<platform>/`.
- **An SDK release's `kits-index.json` is a snapshot.** The index `kition` reads is the one on the
  branch `kits-index`; each release carries the same index as gathered when it is made
  (`tools/kits-index.mjs` in the release workflow, not a copy of the branch), for `kition` 0.3.0
  and 0.4.0, which read `releases/latest/download/kits-index.json`. It is schema checked and named
  in the release manifest (`index`) and `SHA256SUMS`; a gathered index with no kit stops the
  release. Those versions see kit versions published up to the latest SDK release; upgrading
  `kition`, or `KITION_INDEX` set to the branch address, shows every version.
- `kition kit upgrade` and `kition kit install <kit>`, when the version installed is newer than
  every version in the index (Note went from 0.3.0 back to 0.1.0), leave it in use and say so,
  instead of downloading the older version, reporting "upgraded 0.3.0 -> 0.1.0" and removing it
  again; `kit list` marks it `(newer than the index)`.
- **`kition`, the command line, easier to use**:
  - `kition kit install` takes several kits, and `--all` installs every kit the index has for this
    machine; `kition kit remove` takes several kits. A kit that fails does not stop the others,
    and the exit status says one failed. On a terminal, each download shows its progress on
    stderr.
  - `kition kit info <kit> [--json]`: its id, name and files, the versions installed, in use,
    pinned and in the index, its folder, executable and protocol, and the agent tools its
    `kit.json` declares.
  - `kition kit add <path>` puts a kit built or copied here (an archive, a folder with its
    `kit.json`, or a kit executable in its repository) into the store with the checks and the
    one-rename move of an install; `kition kit pack <kit>` writes the version in use as an archive
    that `kit add` takes on another machine, with no network.
  - `kition agent add/remove/list` registers `kition mcp` with Claude Code, Codex or Cursor, by
    this `kition`'s absolute path, and prints what it ran or wrote.
  - `kition doctor [--json]` checks the home, the PATH, the kit index, each installed kit
    (started and asked `kit.initialize`) and the agents, and gives the command that fixes each
    failed check.
  - `kition mcp` without `--workspace` serves the folder it starts in, and names it on stderr.
  - Each command and kit command has its own `--help`; a mistyped command names the closest one
    instead of printing the whole usage, and the usage is grouped (kits, agents, servers,
    troubleshooting).
- **KDM undo of large writes**: a transaction that only writes register fields and keys of map
  fields of existing objects is undone and redone by the replica itself, which writes back the
  values it replaced, instead of by Loro's undo, which looked each overwritten key up in the
  document's history; every other transaction stays a step of the scope's Loro `UndoManager`.
  An engine undo or redo releases the history index it read
  (`LoroDoc::release_parsed_history`, Loro from KitionPkg/loro `b7e6dfea`), which also reads a
  large write with less copying. Undoing a cleared column of a 100,000-record table, alone or
  after older steps, no longer runs a page out of memory (`docs/platform/undo-across-remote-edits.md`).

## 0.4.0

Contracts: KHP 1.0, the Kit Process Protocol `kition-kit/2`, the kit engine contract 1
(`CONTRACT_VERSION`), the Kit UI protocol `kition-kit-ui/1` and KDM 1, as in 0.3.0.

- **Published kits**: `kit.table` 0.5.1, built from its `package-v0.5.1` tag, with `kit.note`
  0.3.0 and `kit.html` 0.1.0 as before (`crates/kition-kits/tests/fixtures/kits/`).
- **Lazy fonts in `@kition/kit-editor`**: the engine manifest gains `lazyFonts`, font files given
  to `addFont` after the document opened, once the engine's optional `wantsFonts()` answers true
  (right after the document opens for an engine without it); `fonts` stays the faces the first
  frame waits for. `KitEngine.loadFonts`, `KitEngine.fontsPending` and `onFonts` follow them, and
  `KitCanvas` draws the whole view again after each. Engine contract E9 (late faces lay out from
  the next call on) and E9a (`wantsFonts`) in `docs/platform/kits/engine.md`; both are optional,
  so the engine contract stays 1.
- **KDM changes**: `Replica::take_changes` answers `Changes`, the changed objects and, for an
  object whose only changes were writes to keys of map fields, those keys with their values. A
  transaction, an import, an undo or redo and a draft's merge report them, so a host's
  projection of a large write reads nothing back for such objects. `take_changed` answers the
  objects, as before.
- **KDM bulk writes**: a transaction reads each object's type and containers once and writes to
  the containers it found, gathers its undo footprint in one pass, and prepares the maps it
  writes while their values are still decoded; Loro from KitionPkg/loro `2498cd8`, which links a
  child to its parent when reading finds it and builds a lazy map's state from its decoded
  value. A write to every record of a large table no longer decodes each record again.
- `kition-kits`: a document call's future is on the heap, so debug builds no longer overflow a
  test thread's stack.
- `@kition/kit-editor`: commands named "smart graphic" keep the diagram icon.

## 0.3.0

- **Published kits**: HTML joins Note and Table (`published-kits.json`, `sdk.json`): `kit.html`
  0.1.0, for `.html` and `.htm` pages, built from its `package-v0.1.0` tag, with its generated
  typings (`@kition/script/kits/html`), its Claude Code plugin skill and its kit archives in the
  index.
- **`kition`, the command line**: one small program with no kit inside; it installs kits from a
  kit index into a store under `~/.kition` (`kition kit list/install/upgrade/remove`), and
  `kition mcp` installs a kit the first time an agent opens a file of it (`docs/sdk/cli.md`).
  `kition --version` is the SDK version.
- **Releases** add `kition-<version>-<platform>.tar.gz` for the five platforms, the kit archives
  `kition-<kit>-<kitVersion>-<platform>.tar.gz`, `kits-index.json` and the installers `install.sh`
  and `install.ps1`, all in the release manifest and `SHA256SUMS`. Each release's index carries
  the previous release's forward, so every published kit version stays installable
  (`tools/release-archives.mjs`, `docs/sdk/distribution.md`).
- `@kition/kits-mcp-<platform>` carries `kition` and no kit; `@kition/kits-mcp` starts
  `kition mcp` (the same `npx -y @kition/kits-mcp --workspace <folder>`), and
  `npx -y @kition/kits-mcp kit install <kit>` installs a kit ahead of time. The Claude Code
  plugin prefers `kition` on the `PATH`.
- The shipped executables are built with the `dist` profile (LTO, stripped).
- **Linux: glibc 2.17 or later.** The Linux executables (`kition`, `kition-kits`,
  `kition-kits-mcp` and every kit's) are linked against glibc 2.17 with cargo-zigbuild instead of
  the build machine's, so older distributions run them; the release fails a Linux build that
  needs a newer `GLIBC_` symbol version (`tools/glibc-floor.mjs`, `docs/sdk/distribution.md`).

## 0.2.0

- **Releases you download**: each SDK version is the GitHub Release `sdk-v<version>`, made by
  `.github/workflows/release.yml` (which replaces `publish-npm.yml`): the SDK bundle for macOS
  (arm64, x64), Linux (arm64, x64) and Windows (x64), each with `kition-kits`, `kition-kits-mcp`
  and the published kits' headless executables in `bin/<platform>/`; the release manifest
  `kition-sdk-<version>.json` (every executable's SHA-256 and the kit version it answers, each kit's
  package, tag and commit); every schema as its own asset; `SHA256SUMS`; and build provenance
  attestations (`docs/sdk/distribution.md`). No Rust is needed to use a kit headless.
- `@kition/kits-mcp` and its platform packages are on npm, from the same build.
- **Published kits**: Table joins Note (`published-kits.json`, `sdk.json`): `kit.table` 0.4.0 and
  `kit.note` 0.3.0, each built from its `package-v<version>` tag.
- Every kit executable a bundle carries answers `kit.initialize` with its package's kit id and
  version before it is shipped (`tools/kit-handshake.mjs`); `tools/sdk-bundle.mjs` downloads kit
  packages from their public release URLs instead of with `gh`.
- Published versions are immutable: a release, a tag or an npm version is never replaced or
  reused; a correction is a new version.

## 0.1.0

First public release.

- **Kit contract**: the `kition-kit` crate (`KitDocument`, `export_kit_document!`,
  `kition_kit::testing::check_contract`) and the Kit Process Protocol between a host and a kit
  process (`docs/platform/reference/kit-process-protocol.md`).
- **Document model**: KDM (`kition-kdm`, `@kition/kdm`) with schemas, replicas and canonical
  state, in Rust and TypeScript.
- **Agent tools and the premise guard**: kits declare what each write rests on; the host
  refuses a stale write with `deleted`, `relocated`, `changed` or `unknown` and applies the
  others (`docs/platform/kits/call-context.md`, `docs/sdk/agent.md`).
- **Hosts**: `kition-kits` (service and MCP server), `kition-headless`, `kition-env`, and the
  npm packages `@kition/kit-host`, `@kition/kit-dev-host`, `@kition/embed`, `@kition/sync`,
  `@kition/embed-server`, `@kition/convergence`.
- **Editors**: `@kition/kit-editor` and `@kition/kit-engine` run a kit's WebAssembly engine in
  the page over the Kit UI protocol (`@kition/kit-ui-protocol`).
- **Scripts and extensions**: `@kition/script` and `@kition/extensions`.
- **Published kits**: Note (`published-kits.json`).
- Public npm packages that bundle third-party code ship `dist/THIRD_PARTY_NOTICES` with each
  bundled package's license: `@kition/embed`, `@kition/script` and `@kition/kit-editor` bundle
  Loro (`loro-crdt`, MIT).
- Preserve member precision through owned objects, use pre-removal gaps for raw list moves, guard nested text offsets by their character range, and prioritize indexed JSON relocation reasons.
- Replay named member premises across sibling subtree deletions and retain complete private derived content bases across other agents' writes.
- Keep outside register edits precise by member in raw-id guard history: unrelated member writes apply, while changed-member and whole-register holds refuse.
- Guard nested raw text edits by their paragraph index and preserve private list history.
- Resolve owned field paths consistently for raw text insert, delete and set in Rust and TypeScript.
- Stop guarded run planning at a successful terminal close and report later steps as not run.
- Environment task generation accepts public-only receipts: filtering private facts keeps
  the receipt's shape.
- Track raw object ids correctly after outside list deletions.
- Keep private premise fields and values out of created, changed and deleted receipts.
- Report invalid step targeting before premise conflicts.
- Preserve model validation errors before raw batch contract admission.
- A stale write on an object the kit's own reread deleted is refused as `deleted`, whatever
  the order of the reread and the server's reads.
- kition-env: `ops_for` replays a creation with the receipt's object id (list, tree and
  map-member creates), so a replayed file matches the forward one; an id the document already
  holds still fails the batch.
- Mixed public and private edits retain complete coverage history without
  exposing private facts in receipts.
- Receipts omit private, unchanged and unproven derived facts while retaining
  premise evidence in the guard's journal.
- Rust and TypeScript replica exchanges and isolated planners follow document
  replacements without merging document histories.
- Content callbacks preserve explicit null regions and historical values.
- Document how explicit targets replace selection reads and how declared
  sibling holds affect independent list appends.
- `@kition/kits-mcp`: `npx -y @kition/kits-mcp --workspace <folder>` starts `kition-kits-mcp`
  from npm, from the optional package `@kition/kits-mcp-<platform>` that carries the server and
  the published kits (darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64). The
  publish workflow builds them. The Claude Code plugin falls back to it when no
  `kition-kits-mcp` is configured or on the `PATH`.
- Docs: `docs/sdk/agent.md` opens with copy-paste setup for Claude Code, Claude Desktop, Cursor
  and Codex. Capability set labels match the set texts (`KitEmbed 1.8`, `KitAgent 1.4`,
  `KitModel 1.1`). Sync tokens are requested from `https://kition.ai/api/sdk/sync-tokens`.
- Quality vocabulary: cases run in the layers `unit`, `gate` (`cargo xtask gate`, budget
  `gate_budget_s`, output in `target/gate/`), `corpus` and `eval` (`cargo xtask eval`, run by
  `tools/eval-cases.mjs`, reports in `target/eval/`); features and cases name their `dimension`;
  a case's `source` names its `license`; only a maintainer approves expected-result changes.
