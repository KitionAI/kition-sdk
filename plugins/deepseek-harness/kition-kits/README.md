# kition-kits: the Kition kits in DeepSeek Harness

`@kition/dsh-kits` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
(a bundle) for the 16 Kition kits: Note, for Markdown notes; Table, for `.ktable` tables; Board,
for whiteboards; Doc, for Word documents; Sheet, for spreadsheets; Slide, for presentations; PDF;
HTML, for `.html` pages; Photo, for layered images; Vector, for vector drawings; Layout, for page
layouts; Design, for interface designs; Film, for video projects; Motion, for motion graphics; CAD,
for `.dxf` drawings; and Scene, for 3D scenes. A kit's file opens in the kit's own editor in
DeepSeek Harness's right sidebar, where you edit it; DeepSeek Harness's agents create, inspect,
edit and check the same files with the kits' Kit Harness Protocol (KHP) tools, and an agent's edit
of a file open in the editor appears there as it happens. No Kition app needs to run: the plugin
starts `kition gateway` (`@kition/cli`) for each workspace folder that needs it. It is the DeepSeek
Harness counterpart of the Claude Code plugin in `plugins/claude-code/kition-kits`.

What it adds:

- **The kits' editors in the right sidebar.** Click a file of a type only Kition opens (`.ktable`,
  `.kboard`, `.kslide`, `.kdesign`, `.psd`, `.dxf`, ...) in the file tree, and it opens in its
  kit's editor in a tab. A type DeepSeek Harness previews itself (`.md`, `.markdown`, `.html`,
  `.htm`, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.csv`, `.svg`, `.xls`) keeps DeepSeek Harness's
  preview; the kit is under **Open with** in the preview's toolbar ("Kition Note", "Kition Doc",
  ...), or first when you set it so (Settings, below). A type a kit only views (Sheet's `.csv`,
  `.ods`, `.xls`; Vector's `.svg`, `.ai`, `.eps`; Design's `.fig`, `.sketch`; Layout's `.idml`)
  opens read-only, marked so. Saving is the editor's own (Cmd+S, its Save button). The tab's title
  shows `●` while it has unsaved edits and a Draft mark while an agent's draft waits, and closing it
  with unsaved edits asks first, for a Kition tab and an Open with preview alike. DeepSeek
  Harness's keyboard shortcuts work with the keyboard in the editor. The editor follows DeepSeek
  Harness's theme and its language (English and Chinese).
- **The agent's edits, live.** The KHP tools `mcp__kition__kit_inspect`, `_commands`, `_run`,
  `_check`, `_query`, `_batch`, `_export`, `_create`, `_draft_ready` and `_draft_reopen` (those the
  installed kits offer), routed to the right kit by the file's extension, and the kits' resources
  (each kit's manifest, a document's objects) through DeepSeek Harness's resource tools. A
  session's calls act on that session's own workspace folder and go to its gateway: a file open in
  the editor is edited there, as a step in the editor's history; any other file through the kit's
  headless engine. Paths outside the folder are refused (KHP A29). While an agent edits a file that
  is not open, a floating window shows it as it happens, without taking the keyboard from where you
  type (Settings); you close it, and it stays closed for that turn.
- **A review card at the end of each turn.** Each kit file the turn changed gets a card in the chat:
  its name and kit, a picture of the draft, what changed (objects created, changed, deleted), and
  where it stands: edited live in the open editor, edited, created, a draft for your review (ready,
  or stale when the file changed since it began), merged, discarded, the draft gone, the file
  deleted; or that Kition is not installed or does not answer, with Try again. Open opens the file
  in the sidebar; Review opens the editor's review of the draft. Merge, Discard and, for a stale
  draft, Merge and overwrite are yours: buttons in the card, never an agent's tool (KHP A14). The
  card follows the draft as it changes, the open editor takes a merge, and a conversation opened
  again shows its cards.
- **The agent's drafts, for you to review.** An agent's draft (`draft: true`) leaves the file as it
  is; the editor shows a banner ("An agent drafted changes to this file — Review") with the
  comparison and the pictures before and after, and Merge and Discard. `/drafts-list`,
  `/drafts-compare <file>`, `/drafts-merge <file>` and `/drafts-discard <file>` do the same from the
  chat; merge and discard are not in the agent's catalog and only start when you type them.
- **A skill per kit, `<kit>-editing`**: the kit's own model guide (`agent/guide.md` in its
  repository): how its documents are built, how objects are addressed, the workflow (inspect,
  find commands, run in small steps, check, fix) and worked examples. They are in every agent's
  skill catalog; the agent loads one with the `skill` tool when it works with that kit's files.

## Install

The plugin needs `kition` with its `gateway` command. Install it with `npm install -g @kition/cli`,
or `curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh`
(into `~/.kition/bin`). The plugin finds it as `KITION_BIN`, else on the `PATH`, else in
`~/.kition/bin`, `~/.cargo/bin`, `/usr/local/bin` and `/opt/homebrew/bin` (DeepSeek Harness Desktop
started from the Finder or the Dock has a `PATH` without most of these). Without it, a Kition tab
and a card say how to install it, and agents have one tool, `kition_setup`, that answers the same.
Once it is installed (or upgraded) the kit tools appear without a restart: the plugin looks for it
again every 15 seconds and whenever you open a kit file. `kition` downloads each kit, and its
editor, the first time a file of it is opened.

The plugin is not on npm yet. Pack it from a kition-sdk checkout:

```sh
npm pack ./plugins/deepseek-harness/kition-kits        # kition-dsh-kits-<version>.tgz
```

**DeepSeek Harness (web).** DeepSeek Harness 0.2.2-rc.5 needs Node.js 24.9 or later, and
`dsh plugin` needs `pnpm` on the `PATH`. Install into the profile you run, `web` for the browser UI:

```sh
dsh plugin --profile web add ./kition-dsh-kits-<version>.tgz
```

`dsh plugin` creates a profile it does not know with DeepSeek Harness's base bundle only, which has
no browser UI; the shipped profile names (`web`, `headless`, ...) start from their own template.
For the browser UI under another name, create the profile from the `web` template first:

```sh
dsh --profile <profile> --from-default-profile web --dump-config
dsh plugin --profile <profile> add ./kition-dsh-kits-<version>.tgz
```

`dsh --profile <profile> --dump-config` then shows the plugin's layer, `# == @kition/dsh-kits`.
Restart a running profile after adding the plugin. `dsh plugin --profile <profile> remove
@kition/dsh-kits` removes it. In the `headless` profile, which has no browser UI, the plugin gives
the agents the tools and the skills.

**DeepSeek Harness Desktop.** Its profile, `desktop`, takes plugins only through the app's own
command line (the npm `dsh` refuses it) or its Plugins page. Quit the app, then:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add ./kition-dsh-kits-<version>.tgz
```

and start the app again. Installing through the Plugins page has not been tested.

## Settings

On the plugin's own page in DeepSeek Harness (Plugins, `@kition/dsh-kits`), kept in the profile:

| Setting | Default | What it does |
| --- | --- | --- |
| Live window | on | While an agent edits a kit file that is not open, show it in a floating window |
| Open after the agent's first edit | off | Open a file in the right sidebar after an agent's first edit of it in a turn (instead of the floating window) |
| Open first in | DeepSeek Harness's preview | Which opens a `.md`, `.html`, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.csv` or `.svg` file first: DeepSeek Harness's preview, or the Kition editor (the other stays under Open with) |

They are the host row's settings (`kition-kits-host`, its `Config`), which the browser module reads
through DeepSeek Harness's settings service.

## Options

DeepSeek Harness bundles have no settings form, so the options are environment variables of the
`dsh` process (of the app, for Desktop):

| Variable | What it is |
| --- | --- |
| `KITION_BIN` | The `kition` executable (such as `target/debug/kition` from `cargo build -p kition-cli`). Unset: found as above |
| `KITION_KITS_DIR` | A folder with one folder per kit, each holding its `kit.json` and headless executable. Unset: the kits `kition` installs in `~/.kition/kits` |
| `KITION_KIT_REPOS` | A folder of kit checkouts, `kition-<kit>/`. Every kit built there with `cargo build -p kition-<kit>` is served from `target/debug/kition-<kit>` with its repository's `kit.json` |
| `KITION_KITS_UNIFIED` | `true` (the default): `mcp__kition__kit_<action>` tools routed by file extension. Anything else: `mcp__kition__<prefix>_<action>` per installed kit, such as `mcp__kition__note_run` |
| `KITION_KITS_MCP` | The draft skills' server, as `bin/kits-mcp.mjs` starts it: `kition` (started as `kition mcp`) or a `kition-kits-mcp`. Unset: `kition` as above, else `kition-kits-mcp` on the `PATH`, else `npx -y @kition/cli mcp`. A `kition` named here is also the one the gateways use, unless `KITION_BIN` is set |

`KITION_HOME` and `KITION_INDEX` are `kition`'s own (its kit store and lockfiles, and its kit index).

## How it fits together

- `package.json` declares the bundle (`dsh.bundle.patch`, `cordis.patch.yml`), its browser module
  (`dsh.client`, `exports["./client"]`, `lib/client.js`), its host module (`main`,
  `lib/host.mjs`), and the DeepSeek Harness releases it supports, `engines.dsh`
  `>=0.2.2-rc.2 <0.3.0-0`. DeepSeek Harness compares the range with prereleases included: it
  accepts 0.2.2-rc.2 and every later 0.2.x, prereleases too, and refuses 0.3.0 and its
  prereleases (a plain `<0.3.0` would let 0.3.0-rc.1 in). `dsh plugin add` refuses a plugin whose
  range the running DeepSeek Harness is outside, and installs nothing.
- `cordis.patch.yml` inserts two rows on the host. `kition-kits-host` loads the package by its name:
  its host module, and, in a profile with the browser UI, its browser module. `kition-kits-skills`,
  a `@deepseek-ai/dsh-skill-filesystem` row (`includeDefaultRoots: false`), adds the plugin's
  `skills/` folder to the host's global skill layer, which every agent's catalog merges (in the
  `web` profile beside each agent preset's own skills). In a bundle's patch, `baseUrl` is the
  profile's folder (`$DSH_HOME/profiles/<profile>/`), not the bundle's, so the row finds the
  plugin's folder where the profile resolves `@kition/dsh-kits/package.json`.
- **The gateways** (`lib/gateways.mjs`). The host module starts one
  `kition gateway --workspace <folder> --stdin-lifetime` per workspace folder, with the kit options
  above, the first time a tab or a tool call needs it, and reuses it. A gateway that another
  process already runs for the folder is used through its lockfile (`kition gateway` exits 3 and
  names it). A gateway that stops is started again on the next request, with its new token. The
  gateways the host started stop with it (their stdin closes).
- **The kit tools** (`lib/tools.mjs`, `lib/mcp.mjs`). The host module registers the kits' tools with
  DeepSeek Harness's tool registry under the names its MCP client would give them,
  `mcp__kition__<tool>`, and the kits' instructions as the MCP server section of the system prompt.
  The tools and the instructions come from a `kition mcp` for an empty folder of its own, run once
  at start, and are listed again after calls (a kit installed on first use can add tools). A call
  goes to the kits' MCP server of the gateway of the calling session's workspace folder
  (`POST /api/v1/mcp/kits`, one connection per agent). DeepSeek Harness's own MCP client cannot do
  this: it runs one server per host, on one folder (in Desktop the host's folder is the profile's),
  and a tool call carries nothing that names the session it comes from; a registered tool is
  given its calling agent and session. A result's preview images are saved as attachments when the
  model takes images, else replaced by a note, as the MCP client does. Each call's outcome (the
  file, its kit, live or draft) is kept with its result in the session log (`presentationMeta`),
  where the browser module's turn projection reads it. The kits' MCP resources go the same way,
  registered with DeepSeek Harness's resource service as server `kition`. While `kition` is missing
  there is only `kition_setup`; `lib/freshness.mjs` lists the tools again when it appears or its
  executable changes (an upgrade also stops the gateways of the old one).
- **The proxy** (`lib/routes.mjs`, `lib/forward.mjs`). The host module serves each gateway under
  `/kition/w/<key>/` on DeepSeek Harness's own web server (and, in Desktop, through its
  `dsh-app://` forwarding), where `<key>` names a workspace folder. Every request passes DeepSeek
  Harness's own login check first (its connection service's Host and Origin fence and browser
  cookie; plugin routes are not guarded otherwise), and nothing reaches a gateway for a folder no
  DeepSeek Harness session or project works in. `/kition/api/open?session=<id>&path=<file>` gives a
  session's file's editor address, the file inside the session's folder, and starts its gateway.
  The proxy adds the gateway's token, which never reaches the browser, drops the browser's
  `Origin`, `Cookie`, `Referer` and any `Kition-Token`, and streams the bridge's events, ranges and
  large saves as they come (kition-sdk `docs/sdk/gateway-page.md`).
- **The browser module** (`lib/client.js`, built by `build-client.mjs` from `src/client/`). It
  registers a right sidebar tab type for the extensions only Kition opens and a document preview
  for each kit whose extensions DeepSeek Harness previews (the extensions each published kit edits
  or only views come from the kits' manifests at build time). A tab frames the gateway's editor
  page, same-origin, in a frame named `dsh-sidebar-html-<tab id>` with a `data-html-preview`
  attribute, the frames DeepSeek Harness Desktop hands its shortcuts to, and speaks the page's
  `postMessage` protocol: theme and language, title, unsaved mark, read-only, draft, review, close
  requests. In the web UI it gives the page DeepSeek Harness's own shortcut bindings (`keys=`), so
  the editor hands them back. The document preview's title is the plugin's (it stands in for
  DeepSeek Harness's, drawn the same way) and both tab kinds have its close guard.
- **The review cards** (`src/client/turn.ts`, `src/client/gateway.ts`). A projection registered
  with DeepSeek Harness's conversation engine (`uiConversation.events.register`, `kitionTurn`) reads
  each turn's kit tool calls and results; the turn's tail (`conversation.chat.turnTail`) shows a
  card per file the turn changed, with the gateway's drafts (followed through its bridge's
  `kit/draftsChanged`, the pages' messages, and every 10 seconds) and their comparison. Merge and
  Discard go through the proxy from the person's click in the card. A watcher in the composer's dock
  (`conversation.input.dock`) opens the live window (`sidebarRight.openResource`, `destination:
  'float'`) for a running turn's edit of a file not open. The settings card is on the plugin's page
  (`plugins.bundle.config`), bound to the host row's settings (`configForms`).
- `bin/kits-mcp.mjs` starts `kition mcp` with the options; the draft skills run its
  `drafts <command> ...` passthrough on the session's folder.
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

- A type a kit only views opens once that kit is installed (`kition kit install <kit>`, or after an
  agent first used it): the kit index, made from what the kit repositories publish, lists only the
  types each kit edits. Of the view-only types, the tests open Sheet's `.csv`; whether each other
  kit's editor shows its view-only types (Vector's `.svg`, `.ai`, `.eps`; Design's `.fig`,
  `.sketch`; Layout's `.idml`; Sheet's `.ods`, `.xls` and templates) is the kit's, and untested.
- What you did to a draft from a card or the editor's review (merged, discarded) is kept in this
  browser: another browser's card of that turn says the draft is no longer there.
- A card is there for each file the turn changed; a turn that only read kit files has none.
- The live window shows the file once the agent's first edit of it began, so that edit shows when
  it is done; the turn's later edits show as they happen. DeepSeek Harness places the floating
  window, which can lie over the conversation; dock it with its button or move it.
- DeepSeek Harness sends every tool definition with every request; the kits' tools are large (with
  Note and Table installed, about 93,000 characters of definitions).
- The skill catalog shows at most 500 characters of a skill's description; the Scene kit's is
  longer and is cut there.
- The draft skills work on the session's current folder; after the agent changed its working
  folder to a subfolder, they look there.
- Merging and discarding are yours (KHP A14) as far as the cards, the editor and the skills go; an
  agent with a shell could still run the launcher's `drafts merge` itself, as with any harness.
- Tested on macOS, with Chromium for the web UI (as a Windows browser, the test's device). Windows
  and Linux hosts have not been run, nor a browser on another machine than DeepSeek Harness, nor
  installing through Desktop's Plugins page.

## Test

- `tools/dsh-plugin.test.mjs` (in kition-sdk) checks the manifest, what the archive packs, the
  patch, the browser module (built from its sources, the extensions it claims), the skills and the
  launcher; `tools/dsh-plugin-host.test.mjs` the host module: finding `kition`, the gateways (one
  per folder, reused, started again, stopped), the proxy (the login gate first, workspace keys,
  paths, header hygiene, event streams, ranges, large bodies, an unreachable gateway), the kit tools
  (each session's calls on its own folder's gateway, the setup tool while kition is missing, the
  tools listed again when kition appears or changes, the resources) against a stand-in gateway
  (`test/fake-kition.mjs`); `tools/dsh-plugin-client.test.ts` the turn projection and the review
  card's states and actions.
- `test/e2e.sh` runs the published DeepSeek Harness runtime's `headless` profile, with the plugin
  installed by `dsh plugin add` under a `DSH_HOME` of its own. A scripted model
  (`test/scripted-model.mjs`, an OpenAI Chat Completions server reached through the route in
  `test/scripted-route.cordis.patch.yml`) asks for `mcp__kition__kit_inspect` on a real note, then
  runs the launcher's `drafts list` with the `bash` tool as the draft skills do. `test/check.mjs`
  checks the session log's `tool/call` and `tool/result` events, the final answer, and the skill
  catalog. No model account is needed.

  ```sh
  test/e2e.sh <kition> <folder of kit repositories> <a .md file>
  ```

  `<kition>` is a `kition` executable, and the folder holds kit checkouts with a debug build of the
  Note kit (`kition-note/target/debug/kition-note`). The first run installs the published
  `@deepseek-ai/dsh` runtime into a cache folder (`DSH_KITS_CACHE`, about 1 GB).
- `pnpm test:dsh:e2e` (in kition-sdk, `test/web.e2e.ts`) runs the web UI of that runtime in
  Chromium, with the packed plugin installed into a profile from the `web` template, the real
  Table, Note and Sheet kits and a scripted model (one that takes images), under a HOME of its own:
  `/kition/` refuses a request without DeepSeek Harness's login, a foreign Host and a cross-site
  Origin; a `.ktable` clicked in the file tree opens the Table editor, DeepSeek Harness's settings
  shortcut pressed in it opens DeepSeek Harness's settings, its language reaches the page, an edit
  marks the tab, closing it then asks first, and Cmd+S saves it to disk; a `.md` keeps DeepSeek
  Harness's preview and opens in Kition Note from Open with, which follows the theme, marks unsaved
  edits on DeepSeek Harness's tab and asks before it closes; the agent's `mcp__kition__kit_run`
  reaches the open editor live, its preview picture reaches the model as an image, the kits'
  instructions are in the system prompt, a resource reads through `read_mcp_resource`, a gateway
  killed and started again takes the next edit live, and its drafts show the banner and the tab's
  mark; review cards: Open, Review, Merge (the open editor following), Discard, Merge and
  overwrite of a stale draft, the same cards after a reload; the live window opens for an edit of a
  file not open without taking the keyboard, and not once turned off on the plugin's page; a `.csv`
  opens read-only in Kition Sheet; the gateway stops with DeepSeek Harness.
- `pnpm test:dsh:desktop` (`test/desktop.e2e.ts`, macOS) starts the installed DeepSeek Harness
  Desktop with a HOME, a DSH_HOME and an Electron user data folder of its own, installs the packed
  plugin with the app's CLI, opens a `.ktable` in the Table editor, closes its tab with Cmd+W
  pressed in the editor, has a scripted agent add a record in the open editor, live, and merges the
  agent's draft of another from its review card, the open editor following.

Both need Node.js 24.9 or later and `pnpm`, a built `kition` (`cargo build -p kition-cli`) and the
gateway e2e's kit index with editor packages (kition-sdk `examples/gateway-page`).

## Versions

| DeepSeek Harness | Where | Tested |
| --- | --- | --- |
| 0.2.2-rc.5 (upstream commit `2e39e704`) | the published npm runtime: `web` and `headless` profiles | `test/e2e.sh`, `pnpm test:dsh:e2e` |
| 0.2.2-rc.2 | bundled in DeepSeek Harness Desktop 0.2.2-rc.2 | `pnpm test:dsh:desktop` |

The pin (KitAgent D4) is `dsh` in `package.json`: the target `0.2.2-rc.5` and the versions tested.
Every DeepSeek Harness API the plugin uses (the tool registry and its presentation metadata, the
resource service, the system prompt, the web server, the connection service, the sessions, the
settings service, the right sidebar's tab types, close guards and floating panels, the document
previews, the conversation engine and the turn tail, the composer's dock, the plugin page's
configuration slot, the shortcuts, the theme and the locale) has the same source in both; what a
profile lacks (the web server in `headless`) is left out, never told apart by version.
