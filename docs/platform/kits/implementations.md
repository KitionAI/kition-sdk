# Implementations

Non-normative. Where Kition implements each part of the standard.

How the Kition desktop client implements each part:

| Requirement | Where in Kition |
| --- | --- |
| Engine contract crate (E1 to E8) | `kition-kit` crate; kits pin it by git revision |
| Worker per document (H1) | `src/features/kits/module/kitEngine.worker.ts`, `kitEngine.ts` |
| `KitHost` (H2, H3) | `src/features/kits/module/kitHost.ts`, `kition/kitionHost.ts`, `lentFiles.ts` |
| Atomic save, exports (H4, H5) | `crates/kition-kits/src/manager.rs` `write_file`; `PUT /v1/kits/files` |
| Follow the file (H6) | `@kition/kit-host` (`document/fileChanged`), copied into Kition as `src/features/kits/host/` |
| CSP, CORS (H7) | `index.html`; `crates/kition-http/src/cors.rs` |
| Embedded UI host (UI-H1 to UI-H6) | `@kition/kit-host` (Kition SDK); Kition's `src/features/kits/kition/KitFrame.tsx`; first kit: `kit.slide` |
| Embedded UI components (U2) | `@kition/kit-editor` (Kition SDK) |
| Engine tools (U8b; still the U8a shapes, `KitPointer 1.0` not yet implemented) | `@kition/kit-editor` (Kition SDK, `packages/kit-editor/src/editor.tsx`, the tool rail); first kit: `kit.vector` |
| Kit registry and creation (K4, H9) | `src/features/workspace/components/kits/kitEditors.ts`, `hooks/useKitCreations.ts` |
| Agent tools (A3) | Kition's `crates/kition-kits/src/tools.rs` (adapted for its agent in `crates/kition-agent/src/tools/kits.rs`): `<prefix>_inspect`, `_commands`, `_run`, and `<prefix>_check` (A21 to A23) for every kit, from its definition; the draft tools only for a kit that declares `agent.drafts`, and the object-model tools `<prefix>_query` and `<prefix>_batch` ([`KitModel 1.0`](../sets/model.md) A16, A17) only for a kit that declares `agent.objectModel` (A35); structured error codes (A18) |
| Headless executables | `kition-headless` (Kition SDK) serves any `KitDocument` over the Kit Process Protocol; each kit's `bindings/headless`; checked by Kition's `kition-kit-conformance` |
| Kit AI bridge (A7 to A10) | Runtime `crates/kition-kits/src/bridge.rs` (server-sent events out, posts back); renderer `src/features/kits/kition/kitBridge.ts`, `useKitBridge.ts`; agent `crates/kition-agent/src/tools/kits.rs` prefers a live editor; messages in `contracts/runtime/kits.schema.json` (`bridge*`) |
| Kit tools in DeepSeek Harness (D1) | `plugins/deepseek-harness/kition-kits` (Kition SDK, `@kition/dsh-kits`): a DeepSeek Harness bundle mounting Kition's MCP server (`kition mcp` over stdio; Kition's `POST /v1/mcp/kits` with its second patch) through `dsh-mcp-client`, with an editing skill per published kit and the person's draft review through `dsh-skill-filesystem`; `test/e2e.sh` with a real dsh runtime |
| DeepSeek Harness conformance (D2 to D4) | Kition's `crates/kition-harness` (session log, `defineTool` shape, pinned release `0.2.1-alpha.2 (d7432673)`; the SDK's `@kition/dsh-kits` pins `0.2.2-rc.5 (2e39e704)` in its `package.json` `dsh`, tested there and on Desktop's `0.2.2-rc.2`); `kition-kit-conformance` reports L4 against it; the SDK protocol server is planned; see roadmap.md |
| External agents (D3) | Kition's `crates/kition-acp`: `kition-acp`, an Agent Client Protocol server (protocol version 1, stdio) over the running Kition's agent |
| Tests | `make kit-test`, `make kit-e2e-webkit`, `pnpm check:kit-modules` |

## Kit Data Model


The KDM has two implementations in the Kition SDK: Rust, `crates/kition-kdm`
(over `loro` 1.16.2), and TypeScript, `packages/kdm` (`@kition/kdm`, over
`loro-crdt` 1.16.4). They produce byte-identical canonical state for the same
changes and schema, proven by fixtures in both directions: a Rust-made
document (`packages/kdm/test/fixtures/rust-page.*`) read by TypeScript, and
a TypeScript-made one (`crates/kition-kdm/tests/fixtures/ts-page.*`) read by
Rust. Shallow snapshots (M16a) are proven the same way
(`rust-shallow.*`, `ts-shallow.*`).

## Verify

Every kit answers `check()` (A21) and lists its diagnostic codes in
`agent/checks.json`.

The Rust reference for diagnostics (A21) is `kition_kit::diagnostics` and `KitDocument::check` (the export macro adds `check()` to the JavaScript class, answering `{ "diagnostics": [...] }` as JSON), checked by `kition_kit::testing::check_contract`; a TypeScript engine's `KitModel` adds `check(view, replica)` and `kitEngineClass` serves it.

## Licence issuing (Kition Console)

1. `console licence keygen` makes a `KITION1` signing seed and prints its public key. Store the
   seed in Console's secret configuration only.
2. Pin the public key in `crates/kition-license/src/kition1.rs` (`PROD_KEYS`, or `TEST_KEYS` for
   `env: "test"`) under its `kid`, and release the SDK
   ([licence-format.md](../licence-format.md), section 5).
3. Kition Cloud's co-editing needs no licence: a super admin registers an integrator's tenant
   with `POST /api/admin/sync-tenants` (`{ tenant }`, answering `{ tenant, secret, url }`); the
   integrator's server exchanges the tenant and its secret at `POST /api/sdk/sync-tokens`
   ([`KitCollab`](../sets/collab.md) section 4).

## Manifests and headless drafts

- K9 is enforced by Kition's `kition-kit-conformance`: it compares a kit's
  `headless.features` with what its executable's `kit.initialize` answers and
  lists the missing and extra features. Every kit built on `kition-headless`
  answers `view.describe`, `document.check`, `model.open`,
  `model.import`, `model.export`, `model.save`, `model.describe`, and
  `model.batch`. Agent object-model tools are offered only when the kit
  declares `agent.objectModel: true`.
- Drafts beside a file (A27): `kition-kits-mcp --drafts` writes them;
  `kition-kits-mcp drafts` and `workspaceDrafts()` of `@kition/script/node`
  review them; Kition's desktop client reviews them too, over its loopback API
  (`GET /v1/kits/drafts`, `/compare`, `POST /merge` with `{ path, overwrite? }`
  answering `409` when stale and `404` when gone, `/discard`).

Draft comparisons use KDM's generic diff for every kit declaring `agent.objectModel`.
Replica drafts compare their stored base and draft snapshots. File drafts export each
opened side and use KDM's reread pairing, so newly minted internal ids do not appear as
replaced objects. A kit that cannot describe or export its model returns `diff: null`
and `diffUnavailable`; kits without an object model keep summaries and optional previews.

The `diff` uses the write receipt's vocabulary and ids: `created` with `values` and optional
`at`, `changed` with `edits: [{ field, before, after, named? }]`, `moved` with `from` and
`to` positions (either can be null), and `deleted` with optional `at`. Integer tool ids
remain numbers; held objects use their holder's id and field path. Map and JSON edits
use the same leaf paths as receipts. `texts` additionally lists changed plain text values;
`renumbered`, when present, identifies ambiguous tool ids found by reread pairing.

The answer lists at most 50 objects across `created`, `changed`, `moved`, and `deleted`,
taking each list in turn as receipts do. Each object keeps at most 50 field names, edits,
and created-value members; `texts` and `renumbered` each keep at most 50 entries. Values
longer than 80 Unicode characters use the receipt's `{ excerpt, length }` form (for a
compound value, its JSON spelling); an entry over 64 KiB including ids, paths and keys is
omitted whole so those addresses are never shortened. `diff.truncated` is absent when
complete, otherwise it gives omitted counts for `created`, `changed`, `moved`, `deleted`
and, when applicable, `texts`, `renumbered`, `fields`, `edits`, `members`, and `values`
(the number of excerpted values among retained entries). Add each list's omitted count
to its length for the total. These limits apply to the object comparison; previews remain
optional and use the existing 1024-pixel render size.

`kition-kits-mcp drafts compare` and the node `workspaceDrafts().compare()` use the same
Rust `drafts::compare` result. Desktop `/v1/kits/drafts/compare` adapters should forward
that shape unchanged. Review is a human operation; compare, merge and discard are not
added to the agent's MCP tool list. Draft review uses the existing review protocol.
