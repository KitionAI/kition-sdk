# Kition SDK

Version **0.5.2** (`sdk.json`; changes in [CHANGELOG.md](../../CHANGELOG.md)).

The [platform documentation](../platform/index.md) describes the SDK contracts.
A distribution may additionally include a separately supplied KHP specification.

The Kition SDK delivers published Kition kits to products and AI agents. All 16 Kition kits
are published: Note, for Markdown notes; Table, for `.ktable` tables; Board, for whiteboards; Doc, for Word documents; Sheet, for spreadsheets; Slide, for presentations; PDF; HTML, for `.html` pages; Photo, for layered images; Vector, for vector drawings; Layout, for page layouts; Design, for interface designs; Film, for video projects; Motion, for motion graphics; CAD, for `.dxf` drawings; and Scene, for 3D scenes (`published-kits.json`). A kit is one engine behind four delivery
forms, so a person in your web app and your agent work on the same file with the same engine:

| Form | Use it to | Package or executable | Guide | Platform |
| --- | --- | --- | --- | --- |
| **Embed** | put a kit's editor in your web page, over your storage and your users | `@kition/embed` | [embed.md](embed.md) | [`KitEmbed 1.8`](../platform/sets/embed.md) (`@kition/embed` serves `KitEmbed 1.3`, with EM25's opening and EM28–EM31); [Kit UI protocol](../platform/reference/ui-protocol.md) (UI-H1–H7, UI-K1–K7); [kit editors](../platform/kits/ui.md) |
| **Script** | read and edit documents from code, in a page or in Node | `@kition/script` | [script.md](script.md) | [`KitObjectModel 1.0`](../platform/sets/object-model.md); exchange in [`KitModel 1.1`](../platform/sets/model.md) |
| **Headless** | run a kit without a page, from any language: servers, desktop apps, batch jobs, tests | `kition-kits serve`, `kition-<kit>` executables | [headless.md](headless.md), [hosts.md](hosts.md) | [engine contract](../platform/kits/engine.md); [`KitAgent 1.4`](../platform/sets/agent.md) (A1–A4, headless Kit Process Protocol) |
| **Agent** | give an AI agent a kit's tools, including checking its own output | `kition mcp` (MCP over stdio; `npm install -g @kition/cli`; the SDK bundle's `kition-kits-mcp`), agent skill | [agent.md](agent.md) | [`KitAgent 1.4`](../platform/sets/agent.md) (A1–A23, D1) |

Co-editing: [collab.md](collab.md) (Kition Cloud for your tenant: sync tokens from your server,
or Kition Server on your own machines).
Training and evaluation: [env.md](env.md) (any kit as an environment: generated editing tasks,
rewards, verified traces; `kit-env`).
Delivery: [distribution.md](distribution.md) (the release: a bundle per platform with every executable, a manifest and SHA-256 sums; verifying and pinning it).
Command line: [cli.md](cli.md) (`kition`: kits downloaded on demand into a store under `~/.kition`
from a kit index, upgraded in place; `kition mcp` and `kition serve` on the store's kits;
`kition gateway`, one workspace's kits and their editors on loopback, and its editor page,
[gateway-page.md](gateway-page.md)).
Licence: every form is free and needs no key; only collaboration does (see [licence](#licence)).

## The path a customer takes

1. **Embed** Note in the web app with its own `StorageProvider` (files on its server).
2. **Agent**: the customer's agent edits the same files with `kition mcp --workspace <folder>`
   (`note_run`, `note_query`, `note_batch`) and calls `note_check`.
3. The person sees the agent's edits as new versions of the files; the agent reads the person's.

The two examples do exactly this, and one end-to-end test runs them together:

```sh
pnpm example:embed                                   # the page (examples/embed-app)
EMBED_WORKSPACE=<folder> node examples/embed-app/serve.mjs   # the page keeping files in <folder>
pnpm example:agent <folder>                          # the agent (examples/agent-mcp)
pnpm test:sdk:exit                                   # both, end to end
```

## Versions

- The SDK has one version (`sdk.json` `version`); a bundle records it in `manifest.json` and in
  each package's `kitionSdk` field.
- Each npm package keeps its own semver inside the SDK; each kit package is the version Kition
  pins (`kits/kits.lock.json`) when the bundle is made, with its source commit.
- The contracts have their own versions: KHP 1.0, the Kition kit platform (edition 2026.11), the kit engine contract
  (`kition_kit::CONTRACT_VERSION`), the Kit UI protocol (1.x), the Kit Process Protocol. The SDK's minor
  version moves when one of them gains a feature, its major version when one breaks.

## Licence

Every form is free, open source (Apache-2.0), and needs no licence key, in development and in
production: editors embedded in a web page (`@kition/embed`) and single-user URL embedding,
`@kition/script` scripts, the headless executables on any machine (your servers included), and
`kition mcp` (the bundle's `kition-kits-mcp`). Nothing shows a mark or prints a warning.

Only collaboration is paid: running Kition Server yourself (free for companies of up
to 8 people; Business and Enterprise plans are paid) or co-editing on Kition Cloud (hosted by
Kition, billed by usage). See [collab.md](collab.md).

Kition Server's licence (format, claims, verification): [licence format](../platform/licence-format.md).
