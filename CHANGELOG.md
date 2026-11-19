# Changelog

The Kition SDK's versions (`sdk.json`). Each entry names the contract versions it carries.

## Unreleased

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
