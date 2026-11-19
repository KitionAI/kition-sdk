# kition

Kition's command line, from npm. `kition` holds no kit: it downloads each published kit the first
time you or your agent need it, into `~/.kition/kits`, and serves the kits' tools to any agent
over MCP (Claude Code, Claude Desktop, Cursor, Codex, or your own MCP client). No Kition app has
to run, nothing is compiled on your machine, and no licence key is needed.

```sh
npm install -g kition
kition --version
kition kit install note
kition agent add claude        # in your project folder: Claude Code runs `kition mcp` there
```

or, without installing:

```sh
npx -y kition kit list
npx -y kition mcp --workspace <folder>
```

Node.js 20 or later, on macOS (arm64, x64), Linux with glibc (arm64, x64) or Windows (x64). The
same `kition`, without Node.js, is in each
[SDK release](https://github.com/KitionAI/kition-sdk/releases) with its SHA-256 sum, with an
install script:

```sh
curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh
```

Every command (`kit`, `agent`, `mcp`, `serve`, `doctor`) is in
[docs/sdk/cli.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md).

## Connect your agent

`kition agent add claude` (or `codex`, `cursor`) registers `kition mcp` with the agent and prints
what it ran or wrote. Installed with `npm install -g kition`, it registers npm's `kition` command;
run through `npx -y kition agent add ...`, it registers `npx -y kition mcp`, so the agent can
start it again after npm clears its cache. By hand:

```sh
claude mcp add kition -- npx -y kition mcp --workspace "$PWD"
```

**Claude Desktop, Cursor, and any client with an `mcpServers` file** (`claude_desktop_config.json`,
`.cursor/mcp.json`, `.mcp.json`, ...). Use an absolute path where the client does not start
servers in your project folder (Claude Desktop); Cursor fills in `${workspaceFolder}`:

```json
{
  "mcpServers": {
    "kition": {
      "command": "npx",
      "args": ["-y", "kition", "mcp", "--workspace", "/absolute/path/to/folder"]
    }
  }
}
```

**Codex**: `~/.codex/config.toml`:

```toml
[mcp_servers.kition]
command = "npx"
args = ["-y", "kition", "mcp", "--workspace", "/absolute/path/to/folder"]
```

With `kition` installed globally, put `kition` as the command and drop `-y` and `kition` from the
arguments. On Windows, an agent starts `npx` (a batch file) as `cmd /c npx -y kition mcp ...`.

The server's tools, the workspace and its sandbox, drafts and kits installed on first use are in
[docs/sdk/agent.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/agent.md) and
[docs/sdk/cli.md](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md#your-agent).

## How the `kition` command finds kition

The `kition` command here is a small Node launcher. It starts the `kition` executable for this
platform with your arguments and your standard input, output and error, and exits with its exit
code or signal; a client's SIGTERM or SIGINT is passed on, and when the client closes standard
input, `kition mcp` ends by itself. The launcher itself never writes to standard output. It runs:

1. `KITION_BINARY`, an executable you name, for example a development build. If the variable
   names a missing file, the launcher stops with an error.
2. Otherwise the `bin/kition` of the optional package `@kition/cli-<platform>`, which npm installs
   with this one on `darwin-arm64`, `darwin-x64`, `linux-arm64` (glibc), `linux-x64` (glibc) and
   `win32-x64`. It holds `kition` and nothing else.

It never looks on the `PATH`, where `npm install -g` puts this launcher itself. If there is no
`kition` for this platform, the launcher says why on standard error: the platform is not one of
those, Linux runs musl (Alpine), or npm left the optional package out (`--omit=optional`,
`--no-optional`); and it names `install.sh` (`install.ps1` on Windows) as the way without npm.

The launcher tells `kition` how it was started in `KITION_LAUNCHER`, a JSON object with `via`
(`npx` or `npm`), `command` (the words that start this `kition` again) and `executable` (the
`kition` it started), which `kition agent add` registers and `kition doctor` checks on the `PATH`.

Programs that start kition themselves can use the same lookup:

```js
import { launchedAs, resolveKition, thisMachine } from 'kition'
// resolveKition(thisMachine(file)) -> { ok, command } or { ok: false, message }
```

Apache-2.0.
