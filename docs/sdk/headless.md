# Headless: kits without a page

Every kit has a native executable, `kition-<kit>` (for example `kition-note`), that opens, edits,
renders, and saves its documents with no window. Each kit publishes it on npm for macOS (arm64,
x64), Linux (arm64, x64) and Windows (x64), as `@kition/kit-<kit>-<platform>`
([distribution.md](distribution.md#kit-packages-and-the-kit-index)), and `kition` installs it into
its kit store, checked against the size and integrity the kit index gives ([cli.md](cli.md)):

```sh
npm install -g @kition/cli
kition kit install note table       # or --all
kition serve --workspace <folder>   # the installed kits, for your host
```

They can also be built from each kit's repository (`cargo build --release -p kition-<kit>`) and
added to the store with `kition kit add <path>`.

They speak the [Kit Process Protocol](../platform/reference/kit-process-protocol.md), version 1, on the
`headless` surface (a private socket or named pipe, a fresh token per launch): the kit never sees
a path, and reads and writes files only through its host, by handle. You rarely drive that
yourself:

- **From any language**: `kition serve` runs the kits for one workspace folder and takes
  requests by path, as JSON lines on its standard input and output ([hosts.md](hosts.md), with
  examples in Python, Node and Go).
- **From Node**: `openHeadless(binary, file, options)` in `@kition/script/node`
  ([script.md](script.md)), on the Kits Service: the object model, `commands()`, `execute()`,
  `save()`, `saveAs()`.
- **From an agent**: `kition mcp` (`npm install -g @kition/cli`) launches the executables for you
  ([agent.md](agent.md)).
- **As your own host**: a host that keeps files elsewhere than a folder speaks the protocol to each
  kit and serves its `storage.*` ([hosts.md](hosts.md#hosts-that-serve-files-themselves)).

Rules a host keeps ([host contract](../platform/kits/host.md), [engine contract](../platform/kits/engine.md)):

- Files are confined to the workspace: nothing outside it, nothing hidden, no link out of it.
- A kit writes a file only when asked to save, and a save commits only while the file is the
  version the kit read (`file_conflict` otherwise); a read-only open refuses writes.
- Failures carry a stable reason (`KitProtocolError.reason`, object-model `BatchError`).

Finding the executables: `kition serve` and `kition mcp` find kits the same way. With neither
`--kit` nor `--kits-dir`, they run the kits installed in the kit store (`kition kit install`).
Otherwise `--kits-dir <folder>` names a folder with one folder per kit holding its `kit.json`, and
`--kit <path>` (repeatable) or `KITION_KIT_<KIT>_BINARY` names an executable, whose `kit.json` is the nearest one above it that
names it; one whose file name no `kit.json` names is asked which kit it is (`kit.initialize`), and
one that is no kit known stops the program with an error naming the path and the kits known. A
kit found without one takes the `kition-<kit>` beside the program or on the `PATH`. A kit with no
executable is named on standard error; `--help` lists every option. An executable that reports
another `kit.version` than its `kit.json` (a stale build) is refused when it starts, and the
agent's tool calls on that kit answer `unavailable` naming the executable, both versions, and
what to do: bump `kit.json`'s `version` and rebuild, or install the matching package. Headless use is free, on your machine or
your servers, and needs no licence key: only collaboration is paid.

Drafts without an editor: an agent's `draft: true` edits stay in the workspace's
`.kition/drafts/` until a person merges them ([agent.md](agent.md#drafts)). A kit whose
executable opens replicas (`model.open`) keeps a replica fork there, whose
comparison lists the objects the draft created, changed, and deleted; the others keep a copy of
the file.

Kition kit platform: [engine contract](../platform/kits/engine.md), [host contract](../platform/kits/host.md),
[agent tools](../platform/sets/agent.md) (the headless Kit Process Protocol).
