# The `kition` command line: kits on demand

`kition` is one small program with no kit inside. Kits are listed in a kit index, downloaded into
a kit store under `~/.kition` when you ask for them (or when your agent first opens a file of
theirs), and upgraded in place. `kition mcp` and `kition serve` are the kits' MCP server and the
Kits Service, the same programs as `kition-kits-mcp` and `kition-kits serve` with the same flags,
running the kits in the store.

It is free on any machine, servers included, and needs no licence key.

## Installing it

Nothing has to be compiled, and Rust is not needed. Pick one:

```sh
# with Node.js 20 or later: npm installs kition for this platform and the `kition` command
npm install -g @kition/cli
kition --version
# or run it without installing; npx keeps it in npm's cache
npx -y @kition/cli kit install note
npx -y @kition/cli mcp --workspace <folder>
```

```sh
# without Node.js, macOS and Linux (glibc): the latest kition from npm, into ~/.kition/bin/kition
curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh
# a given version
curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh -s -- 0.6.0
# the same script from a registry or mirror, out of @kition/cli's tarball (a version is needed)
curl -fsSL https://registry.npmmirror.com/@kition/cli/-/cli-0.6.0.tgz | tar -xzO package/dist/install.sh | sh
```

```powershell
# without Node.js, Windows (x64; Windows 11 on Arm runs it by emulation): into %USERPROFILE%\.kition\bin\kition.exe
irm https://unpkg.com/@kition/cli/dist/install.ps1 | iex
```

The npm package `@kition/cli` (`packages/kition` in kition-sdk) is a small Node launcher: its
`kition` command starts the `kition` of the optional package `@kition/cli-<platform>`, which npm
installs beside it on `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64` (glibc) and
`win32-x64`, with the same arguments, standard input, output and error, and exits as it does. It
is the same `kition` the installers install. Installed with `--omit=optional` (or
`--no-optional`), on another platform, or on Linux with musl (Alpine), there is no `kition` for
it, and the command says so on standard error and names `install.sh`. `npm install -g @kition/cli`
again upgrades it; the kits in the store stay.

The scripts (`install/` in kition-sdk, published in `@kition/cli` as `dist/install.sh` and
`dist/install.ps1`) need neither Node.js nor npm, only `curl` (or `wget`) and `tar`. They go
through [the registries](#the-registries) in order: from the first that serves it, they read the
metadata of `@kition/cli-<platform>` for this machine (its `latest`, or the version given),
download its tarball, check it against the integrity (SHA-512) the metadata gives, check that its
`bin/kition` runs, and move it into `$KITION_HOME/bin` (`~/.kition/bin`) with one rename. A
registry that does not answer within 5 seconds, lacks the version or serves other bytes passes
to the next; when none serves it, nothing is installed and the message names every registry tried
and why. They never ask for administrator rights and never change a shell profile or the `PATH`:
they print the line to add. `install.sh` refuses Linux with the musl C library (Alpine) and says
so; `kition` is built for glibc 2.17 or later. Both read `KITION_HOME`, `KITION_VERSION` (as the
argument) and `KITION_NPM_REGISTRY`. By hand:

```sh
v=0.6.0 p=darwin-arm64 r=https://registry.npmjs.org/      # or https://registry.npmmirror.com/
curl -fsSL "$r@kition%2fcli-$p/$v" | grep -o '"integrity":"[^"]*"'
curl -fsSLO "$r@kition/cli-$p/-/cli-$p-$v.tgz"
printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary "cli-$p-$v.tgz" | openssl base64 -A)"   # the same
mkdir -p ~/.kition/bin && tar -xzf "cli-$p-$v.tgz" -O package/bin/kition > ~/.kition/bin/kition && chmod 755 ~/.kition/bin/kition
```

Running `install.sh` again replaces `kition` with the latest; the kits in the store stay.
`kition --version` names the SDK version it came with. `kition` has no update command of its
own: run the installer again, or `npm install -g @kition/cli`.

## Commands

```sh
# kits
kition kit list [--json]                  # the kits in the index and those installed
kition kit install <kit>[@<version>]...   # install kits; --all: every kit the index has for here
kition kit upgrade [<kit>]                # move a kit, or every kit, to its newest version
kition kit remove <kit>...                # remove every version of kits
kition kit info <kit> [--json]            # a kit's versions, files, folder, protocol and tools
kition kit add <path>                     # put a kit built or copied here into the store
kition kit pack <kit> [--out <folder>]    # write the kit in use as an archive for kit add
# agents
kition agent add <claude|codex|cursor> [--workspace <folder>] [--scope user|project]
kition agent remove <agent> [--workspace <folder>] [--scope user|project]
kition agent list [--workspace <folder>]
# servers
kition mcp [--workspace <folder>] [options]   # the kits' MCP server on stdio
kition serve --workspace <folder> [...]       # the Kits Service API on stdio (hosts.md)
kition gateway --workspace <folder> [...]     # one workspace's kits on loopback HTTP (below)
# troubleshooting
kition doctor [--json]
kition --version
kition --help
```

`kition <command> --help` and `kition kit <command> --help` print that command's own usage. A
mistyped command names the closest one and where its usage is, and exits with status 2:

```text
$ kition install note
kition: unknown command install; did you mean `kition kit install`?
run `kition --help` for the commands
```

`kit list` shows each kit with the version in use and the newest version this `kition` can run:

```text
$ kition kit list
KIT    NAME   INSTALLED  LATEST  FILES
note   Note   0.3.0      0.3.0   .md .markdown
table  Table  -          0.5.2   .ktable
html   HTML   -          0.1.0   .html .htm
```

`(upgrade)` after a version means a newer one is in the index; `(pinned)` means the version was
asked for by number; `(newer than the index)` means the index offers only older versions (see
[the kit index](#the-kit-index)). When the index cannot be read, `kit list` says so on stderr and still lists
the installed kits. `--json` prints the same as JSON: `home`, `platform`, `index`
(`location`, `read`, `stale` or `error`) and `kits`, each with `name`, `id`, `displayName`,
`extensions`, `installed` (every version present), `inUse`, `pinned`, `latest`, `upgrade`,
`inIndex` and the `executable` in use.

`kit install <kit>` installs the newest version this `kition` can run and uses it from then on.
`kit install <kit>@<version>` installs that version and pins it: it stays in use when newer ones
are installed, and `kit upgrade` without a kit leaves it alone. `kit install` takes several kits
(`kition kit install note table html`), and `kit install --all` installs every kit the index has a
build of for this machine, naming on stderr the ones it skips and why. A kit that fails does not
stop the others; the exit status is 1 when any failed. While a kit downloads, stderr shows its
name, the bytes done and the total, and the percent, on one line written over as it goes; only
when stderr is a terminal, so scripts and `kition mcp` see nothing of it. `kit upgrade <kit>`
unpins the kit, installs its newest version, and removes the older ones. `kit remove` takes
several kits, as `install` does. `<kit>` is the short name (`note`) or the kit id (`kit.note`).

`kit info <kit>` states what one kit is here and in the index:

```text
$ kition kit info note
note (kit.note): Note
files:       .md .markdown
installed:   0.3.0 (in use)
in index:    0.3.0, 0.2.0
newest here: 0.3.0
folder:      /Users/me/.kition/kits/note/0.3.0
executable:  /Users/me/.kition/kits/note/0.3.0/kition-note
protocol:    kition-kit/1
agent:       prefix note
tools:       note_inspect note_commands note_run note_query note_batch ...
```

The tools are those the installed `kit.json` declares (its `agent` prefix, and `agent.drafts`,
`agent.objectModel`, `agent.export`, `creates` for the tools that depend on them). `--json` prints
`name`, `id`, `displayName`, `extensions`, `installed`, `inUse`, `pinned`, `available` (each
index version with its `protocol`, `platforms` and `runsHere`), `latest`, `folder`, `executable`,
`protocol`, `agent` (`prefix`, `tools`) and `platform`.

### Kits that are not in the index, and machines without a network

`kit add <path>` puts a kit built here, or copied from elsewhere, into the store. It checks the kit
as an install from the index does (its `kit.json` is `kit.<name>` at a semver version, speaks this
`kition`'s Kit Process Protocol, and names an executable that is there) and moves it into
`kits/<kit>/<version>/` with the same one rename. A kit of another protocol is refused with the
message an install gives. `<path>` is one of:

- a kit archive: a `.tar.gz` with `kit.json` and the executable at its top (what `kit pack`
  writes);
- a folder holding `kit.json` and the executable it names (`headless.executable`);
- a kit executable, whose `kit.json` is the nearest one above it naming it, as `--kit` finds it
  (`kition kit add ../kition-board/target/release/kition-board`).

A version installed already is left as it is: remove the kit first to replace it.

`kit pack <kit> [--out <folder>]` writes the version of the kit in use as
`kition-<kit>-<version>-<platform>.tar.gz` (default: in the current folder). Copied to another
machine of the same platform, `kition kit add <that file>` installs it there, with no network.

## Your agent

```sh
kition agent add claude           # Claude Code, for this folder
kition agent add codex            # Codex (its MCP servers are the user's)
kition agent add cursor           # Cursor: .cursor/mcp.json in this folder
kition agent list                 # where kition is registered
kition agent remove cursor
```

`agent add` registers this `kition` as the MCP server named `kition`, running `kition mcp`. It
prints exactly what it ran or wrote; running it again replaces the registration. The command it
registers is the one that will still start this `kition` later:

| How `kition` runs | `<kition>` in the registration |
| --- | --- |
| Installed by `install.sh` or `install.ps1`, or built | its absolute path, so the agent finds it even when `~/.kition/bin` is not on its PATH |
| `npm install -g @kition/cli` | npm's `kition` command, by its absolute path (`<prefix>/bin/kition`; `<prefix>\kition.cmd` on Windows, through `cmd /c`), not the executable inside `node_modules`: npm puts the command back at the same place on every upgrade |
| `npx -y @kition/cli agent add ...` | `npx -y @kition/cli` (`cmd /c npx -y @kition/cli` on Windows): npx runs `kition` from npm's cache, which npm may clear |
| A project's `npm install @kition/cli` | the project's `node_modules/.bin/kition` |

The npm package's launcher tells `kition` how it was started in the environment variable
`KITION_LAUNCHER`, a JSON object: `via` (`npx` or `npm`), `command` (the words that start this
`kition` again: `["npx", "-y", "@kition/cli"]`, or the absolute path of npm's `kition` command) and
`executable` (the `kition` it started). `kition` takes it only when `executable` is itself, so a
value another program inherited changes nothing. The launcher sets it only when it can tell; a
launcher installed another way (pnpm, yarn) leaves it out, and `kition` registers its own path.
`KITION_BINARY` names another `kition` executable for the launcher to start (a development
build).

| Agent | `--scope project` (default, except Codex) | `--scope user` |
| --- | --- | --- |
| Claude Code | `claude mcp add -s local kition -- <kition> mcp --workspace <folder>`, run in the folder | `claude mcp add -s user kition -- <kition> mcp` |
| Codex | refused: Codex keeps MCP servers for the user only | `codex mcp add kition -- <kition> mcp` (the default) |
| Cursor | `<folder>/.cursor/mcp.json` | `~/.cursor/mcp.json`, with `--workspace ${workspaceFolder}` |

The project folder is `--workspace`, else the current folder; it is also the folder the server
edits. A user registration edits the folder the agent works in, unless `--workspace` fixes one.
Claude Code's `local` scope is the one for a folder that is private to you; its `project` scope
writes a `.mcp.json` meant to be shared, which an absolute path to your `kition` does not suit.
Claude Code and Codex are asked through their own commands, found on the PATH; when one is not
there, `agent add` says so. Cursor's file is merged: every other server and setting in it stays
(keys come back in sorted order), and it is written to a temporary file beside it and renamed
into place. A file that is not JSON is left alone, with an error. `agent remove <agent>` removes
the server named `kition` (Claude Code: from whichever scope has it, unless `--scope`; Cursor:
from the project file and the user file, unless `--scope`).

By hand, the same registration is:

```sh
claude mcp add kition -- kition mcp --workspace "$PWD"
```

or, in an `mcpServers` file:

```json
{ "mcpServers": { "kition": { "command": "kition", "args": ["mcp", "--workspace", "/absolute/path/to/folder"] } } }
```

`kition mcp` without `--workspace` serves the folder it starts in, and names the workspace it
serves on stderr when it starts (`kition mcp: workspace /path (the current folder; --workspace
names another)`). `kition-kits-mcp` still needs `--workspace`.

With no `--kit` and no `--kits-dir`, the server's kits are the store's: the version in use of each
installed kit. A kit the environment names (`KITION_KIT_<KIT>_BINARY`, a development build) is used
instead of the store's. `--kit` and `--kits-dir` mean what they mean for `kition-kits-mcp`, and
with either, the store is not used. Every other option is `kition-kits-mcp`'s
([agent.md](agent.md#the-server)).

### Kits installed on first use

The server reads the kit index when it starts (the copy kept from the last hour, if there is one).
A kit the index lists and the store does not hold is installed the first time the agent names a
file of it:

- Each kit's own tools (`note_inspect`, `note_run`, ...) are there for the installed kits. Beside
  them, while some kit in the index is not installed, the server offers `kit_inspect`: called on a
  file of a kit that is not installed, it installs the kit, then inspects the file. The server then
  sends `notifications/tools/list_changed` (it declares `tools.listChanged`), and the kit's own
  tools appear in the next `tools/list`.
- With `--unified`, the `kit_<action>` tools cover the installed kits and the ones the index lists;
  any of them, called on a file of a kit not installed, installs it first.
- The server's instructions name the kits that would be installed.

When a kit cannot be installed, the call answers why and what to do, as a tool error
(`isError: true`, `structuredContent.error`):

| Case | `error.code` | `retryable` | The message says |
| --- | --- | --- | --- |
| No kit in the index opens the extension | `invalid-params` | no | which kits there are, and the file types they open |
| The index or the archive cannot be reached | `unavailable` | yes | what failed; try again later, or ask the person to run `kition kit install <kit>` |
| The kit speaks another Kit Process Protocol | `not-allowed` | no | the protocols, and to upgrade `kition` (or the kit) |
| `--no-install` | `not-allowed` | no | the person installs it with `kition kit install <kit>` and restarts the server |

`--no-install` turns automatic installs off; `--index <address or file>` reads another index.

Why the per-kit tools of a kit not installed are not listed before it is: they come from the
kit's `kit.json` (its commands, its object model, whether it keeps drafts), which comes with the
kit. A client that does not follow `tools/list_changed` sees the new tools when it starts the
server again; by then the kit is installed.

## The gateway

`kition gateway --workspace <folder>` serves one workspace's kits on `http://127.0.0.1:<port>`,
as the one process that holds them: an editor page that opens a workspace file in its kit's own
editor (`/page/?path=<file>`), the kits' editor packages (`/kits-ui/`), the Kit AI bridge to the
editors attached to it, the workspace's files for them, file grants, the agent's drafts for the
person to review (`/page/review?path=<file>`), and the kits' MCP server. A `kition mcp` started for
the same workspace relays to it ([agent.md](agent.md#editors-attached-to-a-gateway)), so an agent's
edit of a file open in the page happens in its editor, live. The page, its addresses, how a browser
gets in and how a host frames it behind a proxy: [gateway-page.md](gateway-page.md).

```sh
kition gateway --workspace <folder> [--port <n>] [--stdin-lifetime] [--idle-timeout <seconds>]
               [--open [<file>]] [--kit-ui <folder>]... [--unified] [--kit <path>] [...]
kition gateway url --workspace <folder> [<file>] [--review]
```

- `--port <n>`: the port; by default 0, a free one the system picks. It listens on 127.0.0.1 only.
- `--stdin-lifetime`: stop when stdin closes, so the process that started it takes it along.
- `--idle-timeout <seconds>`: stop after this long with no request and no editor attached.
- `--open [<file>]`: print on stderr an address that opens the page (for `<file>`) in a browser.
  It lets one tab in within two minutes, and that tab's session lasts twelve hours;
  `kition gateway url --workspace <folder> [<file>] [--review]` prints another one for the gateway
  already serving the folder (on stdout).
- `--kit-ui <folder>`: serve this development build of a kit's editor instead of the store's: an
  editor package folder (`index.html` and the kit's `kit.json`, as Kition's
  `scripts/build-kit-ui.sh` makes `public/kits/<kit>-ui/`), or a kit repository checkout with its
  editor built in `web/dist/` (`pnpm --dir web build`), whose `kit.json` is the repository's. It is
  served under its `kit.json`'s version with `Cache-Control: no-cache`. Repeat it for more kits.
- The kit options of `kition mcp` (`--unified`, `--drafts`, `--guard`, `--require-basis`, `--kit`,
  `--kits-dir`, `--sandbox`, `--index`, `--no-install`, `--call-timeout-secs`,
  `--idle-timeout-secs`, `--memory-limit-mib`) choose its kits and its MCP server as they do there.

On start it prints one JSON line on stdout, then serves:

```text
$ kition gateway --workspace ~/notes
{"apiPrefix":"/api/v1","kition":"gateway-ready","lockfile":"/Users/me/.kition/run/f35a82c17e3c034a0f3ea7e8bf34423c.json","pid":32783,"port":51512,"protocol":"kition-gateway/1","url":"http://127.0.0.1:51512","version":"0.5.2","workspace":"/Users/me/notes"}
```

The token every request needs is not on stdout, which supervisors and terminals tend to keep: it
is in the lockfile, `KITION_HOME/run/<key>.json`, readable by this account only (`0600`, in a
`0700` folder), with the same fields as the ready line but `kition` and `lockfile`, and also
`format` (1), `token` (64 hex digits, new for each start), `unified` and `started` (Unix seconds).
`<key>` is the first 32 hex digits of the SHA-256 of the canonical workspace path. The gateway
removes its lockfile when it stops.

One gateway serves a workspace. A second one for the same folder (however it is spelled) finds
the first through its lockfile, prints `{"kition":"gateway-running", ...}` with the first one's
fields, says so on stderr, and exits with status 3. A lockfile whose gateway is gone (nothing
answers at its address with its token, process id and workspace) is replaced. The gateway stops
on SIGINT, SIGTERM or SIGHUP (and as above), finishes what it is answering, saves and stops its
kits, and removes its lockfile.

Every request but `GET /health` needs the token in the `Kition-Token` header (a signed URL stands
in for it on the reads that cannot carry a header); a request whose `Host` is not
`127.0.0.1`, `localhost` or `[::1]`, or that comes from another origin (`null` included), gets
`403` before anything else. The routes, under `/api/v1` unless shown otherwise:

| Route | What |
| --- | --- |
| `GET /health` (no token) | `{"code":200,"message":"success","data":"healthy"}` |
| `GET /gateway` | its `protocol`, `version`, `pid`, `workspace`, `unified` and `started` |
| `GET /kits` | the kits, the extensions each edits (`extensions`) and only views (`views`, opened read-only), and whether each is installed |
| `GET /kits/editors` | each kit's editor package: the version a page loads, whether it is installed (`base`, where from), whether the index offers it, its download |
| `POST /kits/editors/install` | `{kit}`: installs the kit's editor package (`202`); `GET /kits/editors` follows the download |
| `PUT /kits/files?path=[&document=][&expected=]` | an editor saves its document (only over the version `expected` names, else `409 file_conflict`) or writes a new file; answers the new `version` |
| `GET`/`PUT /kits/replicas?path=&kit=` | the replica an editor keeps beside its document (`.kition/replicas/`) |
| `POST /gateway/sign` | `{path}`: a signed URL under `/kits-ui/` or `/kit-files/`, for a frame or worker that sends no header |
| `GET /gateway/page-session/<nonce>` | through a signed bootstrap only, once: a page session ([gateway-page.md](gateway-page.md)) |
| `/kits/grants/*` | file grants for an editor's kit (KitFiles); the person picks among `POST /kits/grants/choices` |
| `GET /kits/bridge`, `POST /kits/bridge?session=` | the Kit AI bridge to an attached editor |
| `GET /kits/drafts`, `GET /kits/drafts/compare`, `POST /kits/drafts/merge`, `POST /kits/drafts/discard` | the person's review of the agent's drafts |
| `POST /mcp/kits` | the kits' MCP server (Streamable HTTP, one JSON answer per message) |
| `GET /kit-files/<path>` (no prefix) | workspace files as kits read them (`ETag` is the version stamp): no hidden file, nothing a link leads to outside |
| `GET /kits-ui/<kit>@<version>/<file>` (no prefix) | an editor package's files, `immutable` (a development build `no-cache`), with an `ETag` and single ranges |
| `GET /page/`, `/page/review` (no prefix) | the editor page ([gateway-page.md](gateway-page.md)) |

`/api/v1/gateway` and `POST /api/v1/mcp/kits` need the token itself; the other routes take a page
session in `Kition-Token` too, and the reads under `/kit-files/`, `/kits-ui/`, `/page/` and the
bridge stream a signed URL.

### Editor packages

A kit's editor package is its own editor, engine and fonts, as a page loads it in a frame over the
Kit UI protocol (the npm package `@kition/kit-<kit>-ui` at the kit's version, which the kit
repository publishes; the index lists it as the version's `ui`). `kition kit install` and `kition
kit upgrade` install it with the kit from [the registries](#the-registries), checked against the
size and integrity the index gives (refused, and nothing installed, on any difference, or when it
is not that kit version's editor), into
`kits/<kit>/ui/<version>/`; an upgrade removes the older editors with the older versions, and
`kition kit remove` removes them all. The gateway installs a kit's editor the first time its page
opens a file of the kit (the page shows the download's progress), as the version of the kit in use,
or the newest the index offers when none is installed. `kition kit list` shows it (`EDITOR`:
`installed`, `missing`, `none` when the index has none), and so do `kition kit info` and
`kition doctor` (`editor <kit>`, for information).

## When something is wrong

`kition doctor` checks, in order:

- `kition`'s version, its Kit Process Protocol and the index format it reads;
- the Kition home, and whether a file can be written in it (or, when it is not made yet, in the
  folder it would be made in);
- whether the folder holding this `kition` is on the `PATH`, with the line to add when it is not.
  Installed with `npm install -g @kition/cli`, the folder checked is npm's folder of commands, which
  holds npm's `kition` command, not the folder inside `node_modules` that holds the executable.
  Run through `npx`, or from a project's `node_modules`, there is no `kition` command on the `PATH`
  to check: the check says so, for information, with `npm install -g @kition/cli` as the way to one;
- whether the kit index can be read now; when it cannot, how old the copy kept from the last read
  is (a warning), or that there is none (a failure);
- each installed kit in use, started as a host starts it and asked `kit.initialize`: the version
  it answers, or why it did not start (an answer that is not its `kit.json`'s id and version is a
  failure too);
- each installed kit's editor package (for information: the agent's tools do not need it; the
  gateway installs it when its page first opens the kit);
- which `kition gateway`s run, for which workspace, and how many lockfiles gateways that stopped
  left (the next gateway for that workspace replaces them), for information;
- which agents have `kition` registered (Claude Code and Codex through `claude mcp get kition`
  and `codex mcp get kition`; Cursor's two files), for information.

```text
$ kition doctor
kition 0.6.0 (kit protocol kition-kit/1, index format 1) on darwin-arm64
ok    home          /Users/me/.kition (writable)
fail  PATH          /Users/me/.kition/bin (this kition's folder) is not on the PATH
                    fix: export PATH="/Users/me/.kition/bin:$PATH"   (add the line to your shell's profile, ~/.zshrc or ~/.bashrc)
info  registries    kits and the index come from https://registry.npmjs.org/, https://registry.npmmirror.com/
ok    index         npm:@kition/kits-index: read now, 16 kits
ok    kit note      0.3.0 answers kit.initialize (/Users/me/.kition/kits/note/0.3.0/kition-note)
ok    agent claude  Claude Code: kition registered: ...
info  agent codex   Codex: not here (no `codex` on the PATH)
info  agent cursor  Cursor: kition is not registered (kition agent add cursor)
1 check failed
```

Each failed check ends with the command that fixes it, and the exit status is 1 when any check
failed. `--json` prints `version`, `protocol`, `platform`, `home`, `ok` and `checks`, each with
`name`, `status` (`ok`, `warn`, `fail` or `info`), `detail` and `fix`.

## The store

The Kition home is `~/.kition` on every system (`%USERPROFILE%\.kition` on Windows), or the folder
`KITION_HOME` names:

```text
~/.kition/
  bin/                        kition itself, when an installer put it there
  kits/<kit>/<version>/       an installed kit version: kit.json and kition-<kit> (.exe on Windows)
  kits/<kit>/pinned           optional: the version to use instead of the newest (one line)
  cache/kits-index-<id>.json  the kit index as last read from each address
  tmp/                        downloads and unpacking in progress; never read as kits
```

- **Installed** is a complete folder: `kits/<kit>/<version>/` whose `kit.json` has the id
  `kit.<kit>` and the version of the folder's name, with the executable its `headless.executable`
  names beside it. Anything else is not a kit and is left alone.
- **In use** is the version `pinned` names, when that version is installed; otherwise the newest
  installed version (semver).
- **Installing** downloads the kit's npm package for this platform into `tmp/` from
  [the registries](#the-registries), checks its size and integrity against the index, unpacks it
  there, checks its `package.json` (the package and version the index names) and the unpacked
  `kit.json` (id, version, protocol, executable) against the index, and moves the finished
  folder to `kits/<kit>/<version>/` with one rename. An archive entry that is not a plain file or folder (a link, a device) or whose path leaves the folder (`..`, an
  absolute path) refuses the whole archive. A failed or interrupted install leaves nothing in
  `kits/`; what it left in `tmp/` is cleared a day later. Two programs installing the same version
  at once both end with the one folder that was renamed into place first.
- **Removing** moves the kit's folder (or one version's) out of `kits/` with one rename and then
  deletes it. On Windows a version a running program uses cannot be moved: `kit remove` says to
  close it; `kit upgrade` leaves the old version and removes it next time.
- There are no links, so the store works the same on every system.

**Another program adding a kit** (Kition's desktop app) does what `kition` does: it builds the
complete version folder somewhere on the same volume (the home's `tmp/` is meant for it) and renames
it to `kits/<kit>/<version>/`. `kition` sees it at once: `kit list`, and the next `kition mcp`.

## The kit index

The index is one JSON file, [`schemas/kits-index.schema.json`](../../schemas/kits-index.schema.json):

```json
{
  "schemaVersion": 2,
  "kits": {
    "note": {
      "id": "kit.note",
      "name": "Note",
      "extensions": ["md", "markdown"],
      "versions": {
        "0.3.0": {
          "protocol": "kition-kit/1",
          "platforms": {
            "darwin-arm64": { "package": "@kition/kit-note-darwin-arm64", "size": 11534336, "integrity": "sha512-<88 base64 characters>" },
            "linux-x64": { "package": "@kition/kit-note-linux-x64", "size": 12058624, "integrity": "sha512-<88 base64 characters>" }
          },
          "ui": { "package": "@kition/kit-note-ui", "size": 9437184, "integrity": "sha512-<88 base64 characters>" }
        }
      }
    }
  }
}
```

- `kits` is keyed by the short name; `id` is `kit.` and that name.
- `extensions` are the kit's `edit` formats, lowercase and without the dot: they choose the kit to
  install for a file.
- `versions` is keyed by semver. `protocol` is the Kit Process Protocol the executable speaks, as
  its `kit.json` says (`headless.protocol`). `kition` installs the newest version that speaks its
  own protocol and has a package for this platform, and refuses another protocol, saying to
  upgrade `kition` when the kit's is newer.
- A version installed here that is newer than every version the index offers (the index went
  back to an older number, or the kit came by `kit add`) stays in use: `kit list` marks it
  `(newer than the index)`, and `kit install <kit>` and `kit upgrade` leave it as it is, saying
  so, and download nothing. `kit install <kit>@<version>` installs and pins an older one.
- Platforms are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc) and `win32-x64`,
  as in the SDK release ([distribution.md](distribution.md)). A kit version need not have every
  platform.
- Each entry names an npm package of that version, `@kition/kit-<kit>-<platform>` (the headless
  kit: `kit.json` and the executable `kition-<kit>`, `.exe` on Windows, at the package's top) or
  `@kition/kit-<kit>-ui` (`ui`: the editor, the folder `<kit>-ui/`), with its tarball's size and npm's
  integrity of it. The bytes are refused unless they have both, whichever registry served them.
- `kition` reads the `schemaVersion` it was built for, and asks to be upgraded for a newer one.

The default index is the npm package `@kition/kits-index`: `kition` reads the metadata of its
`latest` from the first registry that answers, downloads that version from it, checks it against
the integrity the metadata gives, and reads its `kits-index.json`. kition-sdk's `kits-index`
workflow publishes it from the registry metadata of every kit's packages, which each kit
repository publishes on npm: every kit and every version a kit repository has published is in
it, whether or not an SDK release bundles that kit, and a new kit version is in it within the hour
([distribution.md](distribution.md#kit-packages-and-the-kit-index)). `kition` 0.5.2 and earlier
read an index on GitHub instead, which no longer changes; upgrade them
([distribution.md](distribution.md#the-kitions-before-npm)). `KITION_INDEX` or `--index` name
another index: an address, or a file on this machine (an index you made, a mirror on a shared
drive); its packages still come from the registries. Each good read is kept in `cache/`, so the
installed kits and the last known index stay visible without a network.

## The registries

Kits, their editors, the kit index and the installers' `kition` all come from npm registries, in
this order, each once:

1. `KITION_NPM_REGISTRY`: one address, or several separated by commas;
2. npm's own setting, read without npm: `@kition:registry` from the `.npmrc` (the file
   `npm_config_userconfig` names, else `~/.npmrc`), else `npm_config_registry`, else that file's
   `registry` (quotes taken off, `${VAR}` expanded);
3. `https://registry.npmjs.org/`;
4. `https://registry.npmmirror.com/`, npmjs.org's mirror, reachable from mainland China.

A registry that does not connect within 5 seconds, answers an error, or lacks the package passes
to the next. A download cut in the middle resumes once from where it stopped (an HTTP range),
else passes to the next registry. The bytes are always checked against the size and integrity the
index (or, for the index itself and the installers, the registry's metadata) gives, whatever
registry served them; a registry serving other bytes is refused and the next one tried. When none
serves it, the message names every registry tried and why. `kition doctor` lists the registries
it uses. Proxies come from `HTTPS_PROXY` and the others below; no token is sent, as every
`@kition` package is public.

## Environment

| Variable | Meaning |
| --- | --- |
| `KITION_HOME` | The Kition home, instead of `~/.kition` |
| `KITION_INDEX` | The kit index: an `https` address or a file, instead of the npm package `@kition/kits-index` |
| `KITION_NPM_REGISTRY` | npm registries to try first, separated by commas ([the registries](#the-registries)) |
| `npm_config_registry`, `npm_config_userconfig` | npm's own settings, read as npm reads them ([the registries](#the-registries)) |
| `KITION_KIT_<KIT>_BINARY` | A kit executable to use instead of the store's (development builds), as for `kition-kits-mcp` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Proxies for reading the index and downloading kits and editors (lowercase forms too) |

Downloads use HTTPS with the Mozilla root certificates built into `kition` (rustls); nothing
depends on the system's TLS library.

## Building it

```sh
cargo build --release -p kition-cli        # target/release/kition
cargo build --profile dist -p kition-cli   # target/dist/kition, as released: LTO, stripped
```

`kition --version` is the crate's version, which is the SDK's (`sdk.json`): they are bumped
together.
