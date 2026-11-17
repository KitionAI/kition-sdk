# @kition/kits-mcp

Kition's kit tools as a stdio MCP server, for any agent: Claude Code, Claude Desktop, Cursor,
Codex, or your own MCP client. The agent creates, inspects, edits and checks files in one
workspace folder through each kit's headless executable. No Kition app has to run, nothing is
compiled on your machine, and no licence key is needed.

The published kit is **Note**, for Markdown (`.md`, `.markdown`). Other Kition kits are not
published yet.

> **Status:** this package is not on npm yet. Until it is, build the server from
> [kition-sdk](https://github.com/KitionAI/kition-sdk) (`cargo build --release -p kition-kits --bin
> kition-kits-mcp`) and use the installed-binary form in
> [docs/sdk/agent.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/agent.md#connect-your-agent).

## Run

```sh
npx -y @kition/kits-mcp --workspace <folder>
# or install it once; the command is kition-kits-mcp
npm install -g @kition/kits-mcp
kition-kits-mcp --workspace <folder>
```

The server speaks MCP on standard input and output, so you do not run it in a terminal yourself:
you register the command with your agent (below), and the agent starts it. `--workspace` is the
only folder it reads or writes; a relative path is resolved against the folder the agent starts
it in.

## Connect your agent

**Claude Code**

```sh
claude mcp add kition -- npx -y @kition/kits-mcp --workspace "$PWD"
```

Run it in the project folder: the shell writes the folder's absolute path as the workspace. Add
`--scope project` to write it to the project's `.mcp.json` for everyone on the project.

**Claude Desktop, and any client with an `mcpServers` file** (`claude_desktop_config.json`,
`.mcp.json`, ...). Use an absolute path: Claude Desktop does not start servers in your project
folder.

```json
{
  "mcpServers": {
    "kition": {
      "command": "npx",
      "args": ["-y", "@kition/kits-mcp", "--workspace", "/absolute/path/to/folder"]
    }
  }
}
```

**Cursor**: `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "kition": {
      "command": "npx",
      "args": ["-y", "@kition/kits-mcp", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

**Codex**: `~/.codex/config.toml`:

```toml
[mcp_servers.kition]
command = "npx"
args = ["-y", "@kition/kits-mcp", "--workspace", "/absolute/path/to/folder"]
```

With the server installed globally (`npm install -g @kition/kits-mcp`, or a `kition-kits-mcp`
binary on the `PATH`), put `kition-kits-mcp` as the command and drop `-y` and
`@kition/kits-mcp` from the arguments.

## Tools: per kit, or `--unified`

By default each kit adds its own ten tools, named by its prefix: `note_inspect`,
`note_commands`, `note_run`, `note_query`, `note_batch`, `note_check`, `note_export`,
`note_create`, `note_draft_ready` and `note_draft_reopen`.

With `--unified` the server offers one set of ten tools for every kit, `kit_inspect`,
`kit_commands`, `kit_run`, `kit_query`, `kit_batch`, `kit_check`, `kit_export`, `kit_create`,
`kit_draft_ready` and `kit_draft_reopen`, and routes each call to a kit by the extension of
its `path`. Use `--unified` when the server has several kits installed, or when your client
limits how many tools or how many tokens of tool definitions it accepts. The tool definitions
stay the same size however many kits are installed. Without `--unified`, the tool names say
which kit they are for. With Note alone, both forms give ten tools.

```sh
npx -y @kition/kits-mcp --workspace . --unified
```

The usual loop for an agent: `_inspect` the file, find commands with `_commands`, change it with
`_run` (or `_query` then `_batch`), then `_check` it and fix what it reports. Failed calls answer
`isError` with `structuredContent.error.code` (`not-found`, `read-only`, `unknown-command`,
`invalid-params`, ...).

`--schemas` prints every tool's argument and result JSON Schema and exits. `--list-kits` prints
the kits the server found, each with its executable, and exits. `--help` lists every option.

## The workspace and the sandbox

- Every tool names its file by `path`, relative to `--workspace`. A path that leaves the
  workspace is refused.
- `--sandbox` also runs every kit process in the operating system's sandbox (macOS
  `sandbox-exec`; Linux Landlock and seccomp). A kit process can then read the system's files
  and its own package, keep state in its private folder, and reach no other file and no network.
  Where the platform cannot give the sandbox, the server refuses to start rather than run
  unconfined. It is off by default for now.
- `--call-timeout-secs`, `--idle-timeout-secs` and `--memory-limit-mib` bound each kit
  process.

## Drafts

With `draft: true` on a call, or `--drafts` for every call, the agent's edits go to a **draft**
of the file in the workspace's `.kition/drafts/`, and the file stays as it is. The agent hands a
draft over with `_draft_ready`. It can never merge one. You review and keep or drop it:

```sh
npx -y @kition/kits-mcp drafts list --workspace .
npx -y @kition/kits-mcp drafts compare notes/plan.md --workspace . --previews
npx -y @kition/kits-mcp drafts merge notes/plan.md --workspace .      # refused as stale if the file changed since
npx -y @kition/kits-mcp drafts discard notes/plan.md --workspace .
```

## How it finds the server and the kits

`kition-kits-mcp` here is a small Node launcher. It starts the real server with your arguments
and your standard input, output and error, and exits with the server's exit code or signal. The
launcher itself never writes to standard output. It uses the first server it finds:

1. `KITION_KITS_MCP`, the path of a `kition-kits-mcp` executable you name, for example a
   development build. If the variable names a missing file, the launcher stops with an error.
2. The optional package `@kition/kits-mcp-<platform>`, which npm installs with this one on
   `darwin-arm64`, `darwin-x64`, `linux-arm64` (glibc), `linux-x64` (glibc) and `win32-x64`.
   It holds `bin/kition-kits-mcp` and the published kits' manifests and headless executables
   (`kits/note/kit.json`, `kits/note/kition-note`). When you give neither `--kits-dir` nor
   `--kit`, the launcher passes `--kits-dir` for those kits.
3. `kition-kits-mcp` on the `PATH`.

If none is found, the launcher says on standard error which platforms are supported. Installing
with `--omit=optional` leaves the platform package out. To serve other kits, give
`--kits-dir <folder>` (one folder per kit, holding its `kit.json` and its executable) or
`--kit <executable>`, or name an executable in `KITION_KIT_<KIT>_BINARY`.

Programs that start the server themselves can use the same lookup:

```js
import { resolveServer, serverArgs, thisMachine } from '@kition/kits-mcp'
```

## More

- The tools in depth (receipts, `basis` and conflicts, drafts):
  [docs/sdk/agent.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/agent.md)
- A skill that tells a coding agent how to use the tools:
  [docs/sdk/skill/SKILL.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/skill/SKILL.md)
- The Claude Code plugin, with a skill per kit and draft review commands:
  [plugins/claude-code](https://github.com/KitionAI/kition-sdk/tree/main/plugins/claude-code/kition-kits)

Apache-2.0.
