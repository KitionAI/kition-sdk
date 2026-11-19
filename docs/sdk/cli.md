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
# macOS and Linux (glibc): the latest release, into ~/.kition/bin/kition
curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh
# a given SDK version
curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh -s -- 0.4.0
```

```powershell
# Windows (x64; Windows 11 on Arm runs it by emulation): into %USERPROFILE%\.kition\bin\kition.exe
irm https://github.com/KitionAI/kition-sdk/releases/latest/download/install.ps1 | iex
```

```sh
# with Node.js 20 or later: the same kition, started as kition mcp (packages/kits-mcp)
npx -y @kition/kits-mcp --workspace <folder>
npx -y @kition/kits-mcp kit install note     # the kit commands, through the same package
```

The scripts take the `kition-<version>-<platform>.tar.gz` of this machine's platform from the SDK
release ([distribution.md](distribution.md)), check it against the release's `SHA256SUMS`, check
that it runs, and move it into `$KITION_HOME/bin` (`~/.kition/bin`) with one rename. They never
ask for administrator rights and never change a shell profile or the `PATH`: they print the line
to add. `install.sh` refuses Linux with the musl C library (Alpine) and says so; `kition` is built
for glibc 2.17 or later. Both read `KITION_HOME`, `KITION_VERSION` (as the argument) and `KITION_RELEASES_URL`,
another address laid out like `https://github.com/KitionAI/kition-sdk/releases` (a mirror). By
hand:

```sh
v=0.4.0 p=darwin-arm64
base=https://github.com/KitionAI/kition-sdk/releases/download/sdk-v$v
curl -fsSLO "$base/SHA256SUMS" && curl -fsSLO "$base/kition-$v-$p.tar.gz"
grep " kition-$v-$p.tar.gz\$" SHA256SUMS | shasum -a 256 -c
mkdir -p ~/.kition/bin && tar -xzf "kition-$v-$p.tar.gz" -C ~/.kition/bin kition
```

Running `install.sh` again replaces `kition` with the release's; the kits in the store stay.
`kition --version` names the SDK version it came with.

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
table  Table  -          0.5.1   .ktable
html   HTML   -          0.1.0   .html .htm
```

`(upgrade)` after a version means a newer one is in the index; `(pinned)` means the version was
asked for by number. When the index cannot be read, `kit list` says so on stderr and still lists
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
protocol:    kition-kit/2
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

- a kit archive laid out like the index's: a `.tar.gz` with `kit.json` and the executable at its
  top (what `kit pack` writes);
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

`agent add` registers this `kition`, by its absolute path (so the agent finds it even when
`~/.kition/bin` is not on its PATH), as the MCP server named `kition`, running `kition mcp`. It
prints exactly what it ran or wrote; running it again replaces the registration.

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

## When something is wrong

`kition doctor` checks, in order:

- `kition`'s version, its Kit Process Protocol and the index format it reads;
- the Kition home, and whether a file can be written in it (or, when it is not made yet, in the
  folder it would be made in);
- whether the folder holding this `kition` is on the `PATH`, with the line to add when it is not;
- whether the kit index can be read now; when it cannot, how old the copy kept from the last read
  is (a warning), or that there is none (a failure);
- each installed kit in use, started as a host starts it and asked `kit.initialize`: the version
  it answers, or why it did not start (an answer that is not its `kit.json`'s id and version is a
  failure too);
- which agents have `kition` registered (Claude Code and Codex through `claude mcp get kition`
  and `codex mcp get kition`; Cursor's two files), for information.

```text
$ kition doctor
kition 0.4.0 (kit protocol kition-kit/2, index format 1) on darwin-arm64
ok    home          /Users/me/.kition (writable)
fail  PATH          /Users/me/.kition/bin (this kition's folder) is not on the PATH
                    fix: export PATH="/Users/me/.kition/bin:$PATH"   (add the line to your shell's profile, ~/.zshrc or ~/.bashrc)
ok    index         https://github.com/KitionAI/kition-sdk/releases/latest/download/kits-index.json: read now, 3 kits
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
- **Installing** downloads the archive into `tmp/`, checks its size and SHA-256 against the index,
  unpacks it there, checks the unpacked `kit.json` (id, version, protocol, executable) against the
  index, and moves the finished folder to `kits/<kit>/<version>/` with one rename. An archive entry
  that is not a plain file or folder (a link, a device) or whose path leaves the folder (`..`, an
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
  "schemaVersion": 1,
  "kits": {
    "note": {
      "id": "kit.note",
      "name": "Note",
      "extensions": ["md", "markdown"],
      "versions": {
        "0.3.0": {
          "protocol": "kition-kit/2",
          "platforms": {
            "darwin-arm64": { "url": "kition-note-0.3.0-darwin-arm64.tar.gz", "size": 11534336, "sha256": "<64 hex digits>" },
            "linux-x64": { "url": "https://example.com/kits/kition-note-0.3.0-linux-x64.tar.gz", "size": 12058624, "sha256": "<64 hex digits>" }
          }
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
  own protocol and has an archive for this platform, and refuses another protocol, saying to
  upgrade `kition` when the kit's is newer.
- Platforms are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc) and `win32-x64`,
  as in the SDK release ([distribution.md](distribution.md)).
- An archive is a `.tar.gz` with `kit.json` and the executable (`kition-<kit>`, `.exe` on Windows)
  at its top. Its `url` is an `https` address or a path; a relative one is read beside the index.
- `kition` reads the `schemaVersion` it was built for, and asks to be upgraded for a newer one.

The default index is `https://github.com/KitionAI/kition-sdk/releases/latest/download/kits-index.json`,
the index of the latest SDK release. It lists every kit version that can still be downloaded, not
only the ones that release built: each release's index is the previous release's with the new
archives added, and the older entries keep their addresses in the releases that hold them
([distribution.md](distribution.md#kit-archives-and-the-kit-index)).
`KITION_INDEX` or `--index` name another: an address, or a file on this machine (an index you made,
a mirror on a shared drive). Each good read is kept in `cache/`, so the installed kits and the last
known index stay visible without a network.

## Environment

| Variable | Meaning |
| --- | --- |
| `KITION_HOME` | The Kition home, instead of `~/.kition` |
| `KITION_INDEX` | The kit index: an `https` address or a file |
| `KITION_KIT_<KIT>_BINARY` | A kit executable to use instead of the store's (development builds), as for `kition-kits-mcp` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Proxies for reading the index and downloading kits (lowercase forms too) |

Downloads use HTTPS with the Mozilla root certificates built into `kition` (rustls); nothing
depends on the system's TLS library.

## Building it

```sh
cargo build --release -p kition-cli        # target/release/kition
cargo build --profile dist -p kition-cli   # target/dist/kition, as released: LTO, stripped
```

`kition --version` is the crate's version, which is the SDK's (`sdk.json`): they are bumped
together.
