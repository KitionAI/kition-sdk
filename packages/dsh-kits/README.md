# @kition/dsh-kits

Kition's kit tools in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`KitAgent 1.4` D1). A DeepSeek Harness agent can then inspect and edit the files Kition's
kits own: today the Note kit's Markdown notes, the Table kit's tables and the HTML kit's pages; the other kits are not published yet.

The package is two DeepSeek Harness profile patches. Each mounts Kition's MCP server through
DeepSeek Harness's own `@deepseek-ai/dsh-mcp-client`, so the tools register on `ctx.tools` with
no Kition code inside the harness. Every installed kit adds its tools, named
`mcp__kition__<prefix>_inspect`, `_commands`, and `_run` (for example `mcp__kition__note_run`),
the draft tools `_draft_ready` and `_draft_reopen`, and the object-model tools `_query` and
`_batch`: the same tools Kition's own agent uses (standard A3; standard-2 A16). Failed calls
answer a structured `error.code` (standard-2 A18), and the server also offers `kit://`
resources (A19).

| Patch | Use it when | Edits go to |
| --- | --- | --- |
| `kition-kits.http.cordis.patch.yml` | Kition is running | The open kit editor when the file is open (the Kit AI bridge, A7), else the headless kit |
| `kition-kits.stdio.cordis.patch.yml` | Kition is not running | The kits' headless executables, in one workspace folder |

## Use

With Kition running, point the patch at its loopback MCP endpoint:

```sh
KITION_MCP_URL=http://127.0.0.1:<port>/api/v1/mcp/kits \
  dsh --profile <profile> --patch kition-kits.http.cordis.patch.yml
```

Without Kition, give the stdio server a workspace and the kit executables it may use:

```sh
KITION_KITS_MCP=<kition-kits-mcp> KITION_WORKSPACE=<workspace> \
KITION_KIT_NOTE_BINARY=<kition-note> \
  dsh --profile <profile> --patch kition-kits.stdio.cordis.patch.yml
```

`kition-kits-mcp` is built from Kition's `crates/kition-kits`; each kit's executable is
`apps/kition-<kit>` in its repository (`kition-headless`). The patches pass on only the
`KITION_KIT_<KIT>_BINARY` variables, because the MCP client starts servers with a scrubbed
environment.

The tools keep the workspace boundary and the kits' agent role. They refuse kit commands that
name files and paths outside the workspace, and they report failures to the model as tool
errors.

## Test

`test/e2e.sh` runs a real DeepSeek Harness runtime through its own Python SDK. A scripted model
(`test/scripted_model.py`, an OpenAI Chat Completions server reached through the
`dsh-llm-pi-ai` route in `test/scripted-route.cordis.patch.yml`) asks for
`mcp__kition__note_inspect`. The harness calls Kition's tool on a real note, and the test
checks the `tool/call` and `tool/result` events in the harness's session log and the final
answer. No model account is needed.

```sh
PYTHON=<python with pydantic> test/e2e.sh <kition-kits-mcp> <kition-note> <Plan.md> \
  <deepseek-harness>/python/sdk/src
```

Requires Node and npm. The first run installs the published `@deepseek-ai/dsh` runtime into a
cache folder (`DSH_KITS_CACHE`, about 500 MB).

## Versions

Written against DeepSeek Harness `0.2.1-alpha.2` (`d7432673`), the release the standard pins
(D4), and tested with the published `0.2.0-rc.2` runtime and the pinned Python SDK. The pin is
`dsh` in `package.json`; Kition's `kition_harness::DSH_TARGET` names the same release, and
`kition-kit-conformance` reports it with each kit's L4.
