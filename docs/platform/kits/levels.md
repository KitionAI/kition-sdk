# Kit conformance levels

> **Kition kit platform, not KHP.** Platform requirements and implementation contracts.
> KHP's tiers are basic, Agent-ready, and Agent-ready complete (KHP
> `spec/agent.md` section 10); the levels L1 to L6 and the release tiers
> below are Kition's.

The levels a kit and a host reach, as Kition's tools report them. Integrators use the per-set conformance in [conformance.md](../conformance.md) instead.

> Tool and schema paths (`tools/...`, `schemas/kit.schema.json`) are in the
> Kition SDK repository, which implements the conformance checks.

## Conformance levels and testing

| Level | A kit | A host |
| --- | --- | --- |
| **L1 Engine** | Passes `check_contract` (Rust) and `tools/check-sdk.mjs` (built module); manifest valid | Runs kits per H1 to H8 |
| **L2 Editor** | L1, plus `ui` and `creates` declared; commands complete (E6); its editor passes a flow test through `@kition/kit-dev-host` in Chromium and WebKit, and `check-ui-ids` when it honors UI configuration (U5a) | L1, plus U1 to U5; e2e in Chromium and WebKit |
| **L3 Agent** | L2, plus schemas for agent-facing commands (E7, A5) and the three document tools (A3) | L2, plus the Kit AI bridge (A7 to A10) |
| **L4 Harness** | L3, plus registered in `@kition/dsh-kits` (D1) | L3, plus D2 to D4 |

Tests:

- `cargo test` with `kition_kit::testing::check_contract` (E1 to E4).
- `node tools/check-sdk.mjs` against the built module (E1 to E4, from
  JavaScript).
- `node tools/check-manifest.mjs <kit.json>` (KHP K1, K2, K4, K5, K16,
  K17, K19; platform K3 to K9, and K10 to K14 for engine contract 2;
  [the manifest](manifest.md)). It
  reports the levels the manifest supports, L5 and L6 included
  (below).
- A kit's editor flow test (each kit's `web/tests/flow.mjs`) mounts the
  editor in `@kition/kit-dev-host`, a host of the UI protocol with an
  in-memory workspace, and drives it in Chromium and WebKit: it opens the
  document, edits it, and saves it through `host/write`. A kit that honors UI configuration also runs
  `checkUiIds` from `@kition/kit-dev-host/check-ui-ids` (U5a).
- Host e2e suites in Chromium and WebKit, with mock servers that behave like
  the host's real file server.
- Harness checks: every exposed tool's schema is a valid `ParameterSchemaSpec`
  and every call round-trips through the bridge.

A conformance report states the standard version, the level, the kit or host
version, the DeepSeek Harness version targeted (D4), and the test results.


## Levels for the Kit Data Model


| Level | A kit | A host or server |
| --- | --- | --- |
| **L5 Model** | L1, plus engine contract 2 and its manifest fields (K10 to K14) with a valid KDM schema; its object model typings generated from the schema (`@kition/script` `kits/`); files import into the KDM and export from it, and an import, export, re-import round trip keeps the document (each kit's fixture corpus) | Keeps the document's KDM replica as its authority in a local store; serves the object model ([`KitObjectModel 1.0`](../sets/object-model.md)) over every transport it offers |
| **L6 Collaboration** | L5, plus passes the convergence suite (`kition-convergence`; `@kition/convergence` for a `ts-worker` engine) and the P rules | L5, plus the sync protocol, presence, per-author undo, and leases (`KitCollab 1.0`) |

The L1 to L4 levels of 1.1 are unchanged; L5 and L6 build on L1, not on the
editor and agent levels L2 to L4.

**The convergence suite.** `crates/kition-convergence` in the Kition SDK is
the suite a kit runs for L6, as a dev-dependency of its tests. A kit plugs in
with an adapter (`KitAdapter`): how to make and join replicas, exchange
changes, read the canonical state, make a random edit from its command
catalogue, and run a few scripted steps on a probe object. The suite drives
two to five in-process replicas through the kit's own commands and, after
each scenario, requires the same canonical state on every replica, valid
schema references (a `ref` names an existing object of its type, a `list`
holds existing objects once each, a tree names each object once), and a view
that matches its replica:

| Scenario | What passes means |
| --- | --- |
| `fields`, `same-field` | Concurrent edits to different fields of one object keep both; one field resolves to one written value |
| `create` | Concurrent creation from one snapshot makes distinct ids, all kept |
| `text-position`, `text-delete-insert`, `text-split`, `text-merge` | Concurrent typing at one position (IME composition, CJK, emoji with modifiers), inside a deleted range, and across paragraph split and merge loses nothing |
| `reorder`, `reparent` | Concurrent moves keep every item and node once |
| `delete-edit`, `duplicate-delete` | Delete wins over edit; references stay valid |
| `undo`, `undo-reconnect` | One actor's undo and redo, also offline and after reconnecting, keep another actor's later changes, also to the same field |
| `delivery` | Changes delivered in any order, with duplicates and retries, give identical state |
| `crash` | A replica that crashes after committing and before pushing recovers its changes from its saved snapshot and commit log (P5, [engine contract](engine.md#performance-rules)) |
| `blobs-late` | Changes that arrive before their blobs do not corrupt the document |
| `fuzz` | Seeded random commands, undo, redo, partial and out-of-order delivery, saves, and crashes on 2, 3, and 5 replicas converge |

Scenarios a kit has nothing for (no text, no tree) are skipped; text, list,
tree, and blob scenarios are required when the kit's schema or adapter has
them. The suite also measures the per-kit performance budgets (`perf`: open
from snapshot, 1,000 remote changes, keystroke to paint, memory per replica)
and checks that the kit's WebAssembly engine reaches the native state from
the same change log (`wasm`, through `tools/convergence-wasm.mjs`).

**TypeScript engines.** A `ts-worker` engine runs the same suite with
`packages/convergence` (`@kition/convergence`), a port of the crate's runner:
the same 17 scenarios, seeds and order of random draws, pass and skip rules,
and report (`Report.toJsonText()`, the JSON `save_if_requested` writes). Its
`KitEngineAdapter` drives a `kitEngineClass` document through the contract 2
members a host calls and joins snapshots as new `KitSession`s; the kit adds
its starting document, random edits from its command catalogue, the scripted
steps on its probe, its text (positions in Unicode scalar values, as in
Rust), and its view check. One source of truth is kept by test: the
TypeScript table of scenarios is checked against the crate's source, and a
toy kit written twice, in Rust (`tests/toy.rs`) and TypeScript
(`packages/convergence/test/toy.ts`), with deterministic actors and ids, must
read the same sequence of canonical states in every scenario and write the
same report in both runners (`tests/fixtures/toy-cross-check.json`, written
by the Rust test and checked by both). A change to a scenario changes both
runners and the fixture together. The perf and WebAssembly parity modes stay
Rust-only: a TypeScript engine has no native build to compare with.

**Reporting levels.** `node tools/check-manifest.mjs <kit.json>` reports the
levels a manifest supports (`PLATFORM LEVELS L1 L2 L3 L5 ...`; these are
not KHP's tiers, which the manifest's `level` claims); with `--convergence
<report.json>`, the report a kit's convergence test writes when
`KITION_CONVERGENCE_REPORT` names a file, it reports L6. Kition's Kit Process
Protocol conformance runner reports the levels of the manifest it checks.

## Agent-ready stages and Kition's release tiers

Kition releases each kit at a tier: Preview, Beta, or Flagship, each
including the one before. The Agent-ready profile
([`KitAgent 1.4`](../sets/agent.md) section 10;
[conformance](../conformance.md#agent-ready-profile)) is required from
Preview, so a kit in any released Kition works for outside agents:

| Kition tier | Agent-ready stage a kit reaches | What that adds |
| --- | --- | --- |
| Preview | Agent-ready core | Headless from the same engine and shipped for every platform; every document tool listed by the kits MCP server; a check that is not the default answer; a real preview; no command waits on a dialog |
| Beta | Agent-ready | Full schema coverage; the check catalogue with a fixture per code; overflow in `check`; create and export; the same canonical state in the page and headless; no network, tested |
| Flagship | Agent-ready complete | The layout answer (layout kits); `agent/guide.md`; edits written as changes; the sandboxed run |

A kit says it is a layout kit (A40) with `agent.layout: true` in its manifest.
Doc, note, pdf, and layout declare it; sheet and board declare `false`, and
slide does not declare it, so A40 does not apply to them. No kit gives the
layout answer: the platform's `<prefix>_inspect` has no `layout`
parameter. Kition itself, as a host, claims Agent-ready core from its first
release: it ships every kit's executable for macOS arm64 and x64, Windows
x64, and Linux x64 (H10), pinned in `kits/kits.lock.json` (H11).
