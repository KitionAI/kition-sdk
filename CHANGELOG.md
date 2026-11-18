# Changelog

The Kition SDK's versions (`sdk.json`). Each entry names the contract versions it carries.

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
