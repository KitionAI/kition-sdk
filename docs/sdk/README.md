# Kition SDK

Version **0.5.2** (`sdk.json`; changes in [CHANGELOG.md](../../CHANGELOG.md)).

Kition is 16 professional editors, called kits. The same kit and the same engine serve a person
(the editor), an AI agent (commands) and a program (code), so a person in your web app, your
agent and your server work on the same file with the same engine.

All 16 Kition kits are published: Note, for Markdown notes; Table, for `.ktable` tables; Board,
for whiteboards; Doc, for word-processing documents (`.docx`); Sheet, for spreadsheets; Slide, for
presentations; PDF; HTML, for `.html` pages; Photo, for layered images; Vector, for vector
drawings; Layout, for page layouts; Design, for interface designs; Film, for video projects;
Motion, for motion graphics; CAD, for `.dxf` drawings; and Scene, for 3D scenes
(`published-kits.json`). The [platform documentation](../platform/index.md) describes the
contracts behind this guide.

## Two programmable interfaces

- **Command API**: each kit's catalogue of named commands, each with a parameter schema. Agents
  call it over MCP (`kition mcp`: `<kit>_run`, `<kit>_commands`, ...; [agent.md](agent.md)), the
  `kition` command line serves it, and programs in any language call it as JSON lines
  (`kition serve`: `commands.list`, `commands.execute`; [hosts.md](hosts.md)). An editor embedded
  in your page serves the same tools to your agent (`editor.agentPort`, [embed.md](embed.md)).
- **Script API**: the typed object model for TypeScript, `@kition/script` ([script.md](script.md)):
  the same script runs in a page on an embedded editor, in Node on the kit's WebAssembly engine,
  on a headless kit, or on a co-edited room. Agents reach the same objects with `<kit>_query`
  and `<kit>_batch`.

## Ways in

The ways in differ by where the kit runs. An agent is not a way in but a kind of user: it works
next to people in the ways in below (see [People and agents together](#people-and-agents-together)).

| Way in | Where it runs | What you use | Guide |
| --- | --- | --- | --- |
| **Embed** (client side) | the editor in your web page, its engine as WebAssembly in the browser; files in your storage, people from your identity system | `@kition/embed` | [embed.md](embed.md) |
| **URL** (server-rendered page) | your server mints a signed iframe URL for one person and one file; the embed server shows the editor and reads and writes the file through HTTP callbacks to your server | `@kition/embed-server` | [url.md](url.md) |
| **Server / headless** | no page: open, edit, render and save on your servers, from any language as JSON lines or from Node with the Script API | `kition serve`, `@kition/script/node` | [headless.md](headless.md), [hosts.md](hosts.md), [script.md](script.md) |
| **Command line** (local runtime) | `kition`, a small program that installs kits on demand and runs them for agents and host applications | `kition kit install`, `kition mcp`, `kition serve`, `kition gateway`, `kition agent add` | [cli.md](cli.md), [agent.md](agent.md), [gateway-page.md](gateway-page.md) |
| **Collaboration** | several people (and agents) on one document, through Kition Server (self-hosted) or Kition Cloud | `@kition/embed` with `collaboration`, `@kition/sync` | [collab.md](collab.md) |

**Host integration.** A host application (an agent tool, a desktop app) integrates through the
command line: it starts `kition gateway --workspace <folder>` and shows the gateway's editor page
in a frame or a window ([gateway-page.md](gateway-page.md)). The agents it runs connect with
`kition mcp`, which relays to the gateway, so their edits of a file open in the page appear there
live. The DeepSeek Harness plugin in kition-sdk (`plugins/deepseek-harness/kition-kits`) is such a
host.

`kition` works like a container tool: a kit is an image, the kit index is the registry,
`kition kit install` is `docker pull`, and `kition mcp|serve|gateway` is `docker run` on a
workspace folder ([cli.md](cli.md)).

Platform documents, by capability: [embed](../platform/sets/embed.md),
[Kit UI protocol](../platform/reference/ui-protocol.md) and [kit editors](../platform/kits/ui.md);
[object model](../platform/sets/object-model.md) and [Kit Data Model](../platform/sets/model.md);
[engine contract](../platform/kits/engine.md), [host contract](../platform/kits/host.md) and
[Kit Process Protocol](../platform/reference/kit-process-protocol.md);
[agent tools](../platform/sets/agent.md); [co-editing](../platform/sets/collab.md) and the
[sync protocol](../platform/reference/sync-protocol.md).

Also: [env.md](env.md) (any kit as a training and evaluation environment: generated editing
tasks, rewards, verified traces; `kit-env`); [process-control.md](process-control.md) (time and
memory limits for kit processes); [distribution.md](distribution.md) (what a release and the kit
packages on npm hold). Licence: every way in is free and needs no key; only collaboration is paid
(see [licence](#licence)).

## Getting the kits

The kits come from npm: each kit's engine as `@kition/kit-<kit>-<platform>`, its editor as
`@kition/kit-<kit>-ui`, and the kit index as `@kition/kits-index` ([distribution.md](distribution.md)).
`kition` installs them for you:

```sh
npm install -g @kition/cli          # or, without Node.js: curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh
kition kit install note table       # into the kit store, ~/.kition/kits; --all for every kit
kition serve --workspace <folder>   # the installed kits, for a host in any language
kition mcp --workspace <folder>     # the kits as MCP tools; a kit not installed is installed on first use
```

## Connecting an agent

Every way to connect an agent uses the Command API:

- `kition agent add <claude|codex|cursor>` registers `kition mcp` with Claude Code, Codex or
  Cursor ([cli.md](cli.md#your-agent));
- `kition mcp --workspace <folder>` in any MCP client's configuration ([agent.md](agent.md#by-hand));
- a host plugin: in kition-sdk, the Claude Code plugin (`plugins/claude-code/kition-kits`)
  starts the same server, and the DeepSeek Harness plugin (`plugins/deepseek-harness/kition-kits`)
  starts `kition gateway` for each workspace and gives its agents the same tools through it;
- `editor.agentPort()`, for an agent working in the editor open in your page
  ([embed.md](embed.md), [agent.md](agent.md#open-embed-agentport)).

The tools are each kit's own: `<kit>_inspect`, `<kit>_run`, `<kit>_query`, `<kit>_batch`,
`<kit>_check` and the rest ([agent.md](agent.md#the-server)). `--unified` gives one set of
`kit_<action>` tools for every kit instead, routed by the file's extension, for clients that limit
the number of tools.

## People and agents together

A person and an agent work on one document in three ways:

1. **Taking turns on the file.** The agent edits the file with `kition mcp`; the person's editor
   sees the save as a new version. Every write carries the version it read, so a save over a
   change it did not see is refused and nothing is lost (`file_conflict` in
   [hosts.md](hosts.md#errors), `EmbedConflictError` in [embed.md](embed.md), `basis` and `others`
   in [agent.md](agent.md#what-others-changed)).
2. **Drafts the person reviews.** With `--drafts` (or `draft: true`) the agent's edits go to a
   draft, and the file stays as it is until the person merges it: with `kition mcp drafts`
   ([agent.md](agent.md#drafts)), on the gateway's review page
   ([gateway-page.md](gateway-page.md)), or in your page (`editor.draft`, [embed.md](embed.md)).
3. **Live in the open editor.** The agent's edits happen in the editor the person has open, as
   steps of its history: through `kition gateway`, to which `kition mcp` relays
   ([agent.md](agent.md#editors-attached-to-a-gateway)), or through `editor.agentPort()` in your
   page when the page allows live edits (`agentPort({ draft: false })`; by default its edits are
   a draft, [embed.md](embed.md)).

## The path a customer takes

1. **Embed** Note in the web app with its own `StorageProvider` (files on its server).
2. **An agent** edits the same files with `kition mcp --workspace <folder>`
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

- The SDK has one version for the whole project (`sdk.json` `version`): every public `@kition/*`
  package and `kition` are released at it. A release moves only its last digit.
- Each kit has its own version (its `kit.json`), published on npm by the kit's repository;
  `kition` installs the newest version it can run, or the one you name
  ([cli.md](cli.md#the-kit-index)).
- The protocols are at version 1: the Kit Process Protocol (`kition-kit/1`), the Kits Service API,
  the sync protocol (`kition-sync/1`) and the gateway's (`kition-gateway/1`).

## Licence

Every way in is free, open source (Apache-2.0), and needs no licence key, in development and in
production: editors embedded in a web page (`@kition/embed`) and single-user URL embedding,
`@kition/script` scripts, and `kition` with the kits it runs (`kition serve`, `kition mcp`,
`kition gateway`) on any machine, your servers included. Nothing shows a mark or prints a
warning.

Only collaboration is paid: running Kition Server yourself (free for companies of up
to 8 people; Business and Enterprise plans are paid) or co-editing on Kition Cloud (hosted by
Kition, billed by usage). See [collab.md](collab.md).

Kition Server's licence (format, claims, verification): [licence format](../platform/licence-format.md).
