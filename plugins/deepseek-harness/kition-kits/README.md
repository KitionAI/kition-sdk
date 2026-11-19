# kition-kits: the Kition kits in DeepSeek Harness

`@kition/dsh-kits` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
(a bundle) that lets its agents create, inspect, edit and check files in your workspace with the
16 Kition kits through their Kit Harness Protocol (KHP) tools: Note, for Markdown notes; Table, for
`.ktable` tables; Board, for whiteboards; Doc, for Word documents; Sheet, for spreadsheets; Slide,
for presentations; PDF; HTML, for `.html` pages; Photo, for layered images; Vector, for vector
drawings; Layout, for page layouts; Design, for interface designs; Film, for video projects;
Motion, for motion graphics; CAD, for `.dxf` drawings; and Scene, for 3D scenes. No Kition app
needs to run: the plugin starts `kition mcp` (`@kition/cli`), which drives each kit's headless
executable on the files in the workspace folder. It is the DeepSeek Harness counterpart of the
Claude Code plugin in `plugins/claude-code/kition-kits`, and holds no code that runs inside the
harness: two patch rows, skills, and a launcher.

What it adds:

- **An MCP server, `kition`**: the KHP tools `mcp__kition__kit_inspect`, `_commands`, `_run`,
  `_check`, `_query`, `_batch`, `_export`, `_create`, `_draft_ready` and `_draft_reopen`, routed
  to the right kit by the file's extension, through DeepSeek Harness's own
  `@deepseek-ai/dsh-mcp-client`. The workspace is one folder (below); paths outside it are refused
  (KHP A29).
- **A skill per kit, `<kit>-editing`**: the kit's own model guide (`agent/guide.md` in its
  repository): how its documents are built, how objects are addressed, the workflow (inspect,
  find commands, run in small steps, check, fix) and worked examples. They are in every agent's
  skill catalog; the agent loads one with the `skill` tool when it works with that kit's files.
- **Draft review, the person's side**: `/drafts-list` and `/drafts-compare <file>` show what an
  agent drafted (`draft: true`); `/drafts-merge <file>` and `/drafts-discard <file>` keep or drop
  it. Merge and discard are not in the agent's catalog and only start when you type them (KHP A14).

## Install

DeepSeek Harness 0.2.2-rc.5 needs Node.js 24.9 or later, and `dsh plugin` needs `pnpm` on the
`PATH`. The plugin is not on npm yet. From a kition-sdk checkout, install its folder into a
profile:

```sh
dsh plugin --profile <profile> add ./plugins/deepseek-harness/kition-kits
```

or pack it and install the archive:

```sh
npm pack ./plugins/deepseek-harness/kition-kits        # kition-dsh-kits-<version>.tgz
dsh plugin --profile <profile> add ./kition-dsh-kits-<version>.tgz
```

`dsh plugin` creates a profile it does not know with DeepSeek Harness's base bundle only, which
has no browser UI; the shipped profile names (`web`, `headless`, ...) start from their own
template. For the browser UI under another name, create the profile from the `web` template first:

```sh
dsh --profile <profile> --from-default-profile web --dump-config
dsh plugin --profile <profile> add ./plugins/deepseek-harness/kition-kits
```

`dsh --profile <profile> --dump-config` then shows the plugin's layer, `# == @kition/dsh-kits`.
Restart a running profile after adding the plugin. `dsh plugin --profile <profile> remove
@kition/dsh-kits` removes it.

The plugin needs the server. It uses, in this order: `KITION_KITS_MCP`; `kition` on the `PATH`
(from `npm install -g @kition/cli` or `install.sh`), started as `kition mcp`; `kition-kits-mcp`
on the `PATH`; otherwise `npx -y @kition/cli mcp`, the npm package that brings `kition` for your
platform. `kition` holds no kit: it downloads each kit of the kit index into `~/.kition/kits` the
first time an agent opens a file of it (kition-sdk's `docs/sdk/cli.md`).

## Options

DeepSeek Harness bundles have no settings form, so the options are environment variables of the
`dsh` process. Its MCP client passes the server the environment `dsh` has, without names that
contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` and without `DSH_*` names, so these reach it:

| Variable | What it is |
| --- | --- |
| `KITION_KITS_MCP` | The server executable: `kition` (such as `target/debug/kition` from `cargo build -p kition-cli`) or a `kition-kits-mcp`. Unset: `kition` on the `PATH`, else `kition-kits-mcp` on the `PATH`, else `npx -y @kition/cli mcp` |
| `KITION_KITS_DIR` | A folder with one folder per kit, each holding its `kit.json` and headless executable. Unset: the kits `kition` installs in `~/.kition/kits` |
| `KITION_KIT_REPOS` | A folder of kit checkouts, `kition-<kit>/`. Every kit built there with `cargo build -p kition-<kit>` is served from `target/debug/kition-<kit>` with its repository's `kit.json` |
| `KITION_KITS_UNIFIED` | `true` (the default): `mcp__kition__kit_<action>` tools routed by file extension. Anything else: `mcp__kition__<prefix>_<action>` per installed kit, such as `mcp__kition__note_run` |
| `KITION_WORKSPACE` | The workspace folder. Unset: the folder `dsh` started in |

With Kition running, `kition-kits.http.cordis.patch.yml` points the same server row at Kition's
loopback MCP endpoint instead, so a file open in a Kition kit editor is edited live there (the Kit
AI bridge, A7). Add it over the profile, with `KITION_MCP_URL` set to the endpoint (for example
`http://127.0.0.1:<port>/api/v1/mcp/kits`):

```sh
dsh --profile <profile> --patch <the plugin's folder>/kition-kits.http.cordis.patch.yml
```

## How it fits together

- `package.json` declares the bundle (`dsh.bundle.patch`, `cordis.patch.yml`) and the DeepSeek
  Harness releases it supports, `engines.dsh` `>=0.2.2-rc.5 <0.3.0-0`. DeepSeek Harness compares
  the range with prereleases included: it accepts 0.2.2-rc.5 and every later 0.2.x, prereleases
  too, and refuses 0.3.0 and its prereleases (a plain `<0.3.0` would let 0.3.0-rc.1 in).
  `dsh plugin add` refuses a plugin whose range the running DeepSeek Harness is outside, and
  installs nothing.
- `cordis.patch.yml` inserts two rows on the host. `kition-kits`, a `@deepseek-ai/dsh-mcp-client`
  row, starts `bin/kits-mcp.mjs` with DeepSeek Harness's own Node. In a bundle's patch, `baseUrl`
  is the profile's folder (`$DSH_HOME/profiles/<profile>/`), not the bundle's, for an installed
  folder and an installed archive alike, so the patch finds the plugin's folder where the profile
  resolves `@kition/dsh-kits/package.json`.
- `bin/kits-mcp.mjs` picks the server (above), turns the options into its arguments
  (`--kits-dir`, one `--kit` per built kit repository, `--unified`), and starts `kition` as
  `kition mcp`. `drafts <command> ...` passes through to the server's draft review.
- `kition-kits-skills`, a `@deepseek-ai/dsh-skill-filesystem` row (`includeDefaultRoots: false`),
  adds the plugin's `skills/` folder to the host's global skill layer. Every agent's catalog
  merges that layer: the skills are in it in the base and headless profiles, and in the `web`
  profile too, which turns the base's own skill row off and gives each agent preset its own, and
  where they sit beside the preset's skills (DeepSeek Harness's Office skills among them).
- A `/name` token anywhere in your message injects that skill's instructions into the turn; the
  rest of your message stays as you wrote it, and the skill reads the file from it (DeepSeek
  Harness replaces no `$ARGUMENTS`). A skill with `disable-model-invocation: true` is never in the
  agent's catalog and the `skill` tool refuses it, so `/drafts-merge` and `/drafts-discard` only
  start from your own message.
- `skills/<kit>-editing/SKILL.md` is generated by `node tools/agent-plugin-skills.mjs` (in
  kition-sdk) from each published kit's `agent/guide.md` and `kit.json`, with the same guides as
  the Claude Code plugin's; only the opening paragraph, which names the tools as each harness
  shows them, differs. The publication allowlist is `published-kits.json` at the SDK root. Edit
  the guide in the kit's repository, never the skill; `node tools/agent-plugin-skills.mjs --check`
  fails when they differ. The `drafts-*` skills are written by hand.

## Limits

- One server serves one workspace folder for the whole `dsh` process. A session in another folder
  (the `web` profile lets you open several) gets refusals for its files; set `KITION_WORKSPACE`
  to a folder that holds them all.
- DeepSeek Harness 0.2.2-rc.5 sends every tool definition with every request; the kits' tools are
  large (with Note and Table installed, about 93,000 characters of definitions).
- The skill catalog shows at most 500 characters of a skill's description; the Scene kit's is
  longer and is cut there.
- Merging and discarding are yours (KHP A14) as far as the skills go; an agent with a shell could
  still run the launcher's `drafts merge` itself, as with any harness.
- Tested on macOS. The launcher is Node and starts `npx` through a shell on Windows, which has not
  been run.
- `kition-kits.http.cordis.patch.yml` is checked with `--dump-config`, not against a running
  Kition.

## Test

`test/e2e.sh` runs the published DeepSeek Harness runtime's `headless` profile, with the plugin
installed into it by `dsh plugin add` under a `DSH_HOME` of its own. A scripted model
(`test/scripted-model.mjs`, an OpenAI Chat Completions server reached through the route in
`test/scripted-route.cordis.patch.yml`) asks for `mcp__kition__kit_inspect` on a real note, then
runs the launcher's `drafts list` with the `bash` tool as the draft skills do. `test/check.mjs`
checks the `tool/call` and `tool/result` events in the session log, the final answer, and that the
skill catalog the model received lists every kit's editing skill and the person's list and
compare skills, and not merge and discard. No model account is needed.

```sh
test/e2e.sh <kition> <folder of kit repositories> <a .md file>
```

`<kition>` is a `kition` or `kition-kits-mcp` executable, and the folder holds kit checkouts with
a debug build of the Note kit (`kition-note/target/debug/kition-note`). It needs Node.js 24.9 or
later and `pnpm`. The first run installs the published `@deepseek-ai/dsh` runtime into a cache
folder (`DSH_KITS_CACHE`, about 1 GB).

## Versions

Written and tested against DeepSeek Harness `0.2.2-rc.5` (upstream commit `2e39e704`), the
published npm runtime. The pin is `dsh` in `package.json`.
