# Changelog

The Kition SDK's versions (`sdk.json`). Each entry names the contract versions it carries.

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
