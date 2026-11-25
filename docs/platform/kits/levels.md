# Kit conformance levels

> **Kition kit platform, not KHP.** Platform requirements and implementation contracts.
> KHP's tiers are basic, Agent-ready, and Agent-ready complete (KHP
> `spec/agent.md` section 10); the levels L1 to L5 and the release tiers
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
  reports the levels the manifest supports, L5 included (below).
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

The L1 to L4 levels of 1.1 are unchanged; L5 builds on L1, not on the
editor and agent levels L2 to L4.

**The performance suite.** `crates/kition-convergence` in the Kition SDK
measures a kit's performance budgets (`perf`: open from snapshot, 1,000
changes from another replica, keystroke to paint, memory per replica; the P
rules, [engine contract](engine.md#performance-rules)) through a small adapter
(`KitAdapter`) on any contract 2 kit, as a dev-dependency of its tests. It
sees only bytes and JSON, so it depends on no particular `kition-kit`
revision.

**Reporting levels.** `node tools/check-manifest.mjs <kit.json>` reports the
levels a manifest supports (`PLATFORM LEVELS L1 L2 L3 L5 ...`; these are
not KHP's tiers, which the manifest's `level` claims). Kition's Kit Process
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
