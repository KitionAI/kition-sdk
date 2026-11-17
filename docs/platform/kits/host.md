# Host contract

What a host that runs kit engines guarantees. `@kition/embed` implements it for integrators; Kition's desktop client implements it too.

## Host contract

- **H1** A host MUST run each open document's engine in its own Web Worker
  and MUST NOT run an engine on the page's thread.
- **H2** A host MUST provide file IO as a `KitHost`: `read(path)` returning
  bytes and a version stamp, `stamp(path)`, `write(path, bytes)`, and
  `lend(path)` for lent files.
- **H3** A host MUST confine every path to its workspace, and MUST NOT serve
  its own data or hidden files through a kit's reads (LR2). A kit's reads by
  path (`host/read`, `host/stamp`, lent files) reach only the document and
  the files beside it: lent paths resolve against the document's folder, and
  nothing resolves above the workspace root. Every other file is reached
  through a file handle ([`KitFiles 1.1`](../sets/files.md)), which the host
  confines the same way (FA8); a file the document links, through a link
  handle ([`KitLinks 1.0`](../sets/links.md) LR1, FA18).
- **H4** A host MUST save in place atomically (temporary file, then rename)
  and MUST call `markSaved` only after the write succeeded and only if the
  document did not change meanwhile.
- **H5** A host MUST write exports, and every file a kit creates
  (`files/create`), as new files only, choosing an unused name, and MUST
  refuse a write that would replace an existing file through an export or a
  `create` handle. A kit replaces an existing file other than its document
  only through a `write` grant ([`KitFiles 1.1`](../sets/files.md) FA2), and
  an agent only through a draft or the person's approval (FA13).
- **H6** While a document's editor is in front, a host MUST follow its file:
  a clean document reloads when the file changes on disk; a document with
  unsaved edits MUST NOT be silently replaced; the person chooses.
- **H7** A host MUST allow WebAssembly compilation and nothing more
  (`'wasm-unsafe-eval'`, not `'unsafe-eval'`), and MUST serve lent files
  with ranged reads and the headers needed to read version stamps across
  origins (`Last-Modified`, or `ETag` with `Access-Control-Expose-Headers`).
- **H8** A host MUST check `contractVersion()` and refuse a newer contract.
- **H9** A host SHOULD let a person create files a kit declares in `creates`
  and start from files a kit declares in `imports`.

## Agent-ready hosts

A host that claims the Agent-ready profile ([`KitAgent 1.4`](../sets/agent.md)
section 10) ships its kits' headless executables and lists them to agents
with no setup. H10 to H13 are stage core, H14 stage complete. H11's version
check is in force (`kition-kits` enforces it); the rest of the five are
*(proposed)*: no host implements them yet.

- **H10** *(proposed) Ship them.* A host that ships kit editors MUST ship,
  for every platform it releases, each of those kits' headless executables
  (A34), so an agent works on files no editor has open in the released
  product. (Kition releases macOS arm64 and x64, Windows x64, and Linux x64;
  thirteen kits make 52 executables.)
- **H11** *Lock-step.* A host MUST refuse to start an executable whose
  `kit.initialize` answers a `kit.version` other than the manifest's of the
  package it serves ([Kit Process Protocol](../reference/kit-process-protocol.md)
  section 4), so a stale build never serves its old behaviour under a newer
  manifest. The refusal is an error that names the executable, the version
  it reports, the manifest's version, and what to do: rebuild the executable
  from the kit's source at the manifest's version, or install the package
  whose executable is that version. An agent's tool call on that kit answers
  `unavailable` (KHP A18) with a message for people that names the kit. There
  is no switch that skips the check: a kit author bumps `kit.json`'s
  `version` and rebuilds. (`kition-kits` enforces it, for `kition-kits-mcp`,
  `kition-kits serve`, and the hosts built on it.) *(proposed)* A host that
  ships executables (H10) MUST also pin each with the package it serves: the
  same kit version and source commit, and a SHA-256 per platform, and refuse
  an executable whose digest differs from the pin. Executables are signed
  with the host's release (notarized on macOS, Authenticode on Windows).
  (Kition pins both in `kits/kits.lock.json`.)
- **H12** *(proposed) One server, every kit.* A host's server of kit tools
  (an MCP server, [`KitAgent 1.4`](../sets/agent.md) section 8.1) MUST list
  the tools of every kit the host ships, discovered from the shipped
  manifests, never from a hand-written list, and its instructions name the
  kits. `kition-kits-mcp --list-kits` prints
  `[{ id, prefix, version, executable, formats }]`. A host SHOULD show the
  person the command that registers the server in other agent harnesses
  (Claude Code, Codex), with the shipped executable's real location filled
  in on the person's machine when it is shown, never written into
  documents.
- **H13** *(proposed) No setup.* A released host MUST NOT require
  environment variables, `PATH` changes, or developer builds for any kit
  tool. Overrides such as `KITION_KIT_<KIT>_BINARY` are for development
  builds only. A kit that is unavailable answers `unavailable` (A18) with a
  message for people that names the kit, never a variable.
- **H14** *(proposed) Sandbox.* A host SHOULD run headless kits under the
  platform's sandbox, denying the file system (except the platform's own
  files, the kit's package, and its private folder with its private runtime
  folder, KHP A58) and the network, as the Kit Process Protocol's check 11 runs
  them ([Kit Process Protocol](../reference/kit-process-protocol.md) section 14). Where
  it does not, it MUST still give a kit no workspace path in its arguments
  or environment, so files reach the kit only as handles
  ([`KitFiles 1.1`](../sets/files.md) FA-P2). `kition-kits-mcp --sandbox`
  and `kition-kits serve --sandbox` do it, opt-in for now and meant to
  become the default: `sandbox-exec` with a deny-by-default profile on
  macOS, Landlock and a seccomp filter on Linux; on other platforms, and on
  a Linux kernel without Landlock, they refuse to start rather than run a
  kit unconfined ([Kit Process Protocol](../reference/kit-process-protocol.md)
  section 3).
  Both programs expose `--call-timeout-secs` (120), `--idle-timeout-secs` (600), and optional
  `--memory-limit-mib` beside `--sandbox`. These host policies bound each request, save before
  idle reclaim, isolate documents in independent workers, and forward MCP stdio progress and
  cancellation. [Process controls](../../sdk/process-control.md) describes enforcement and gaps.
- **H14a** *Launch environment.* A host MUST start a kit process in a
  private, empty folder of its own, never its own current folder, the
  workspace, or the person's home, and never one another kit process
  shares: the kit's current folder, `HOME` and `USERPROFILE`, the `XDG_*`
  folders, and its private runtime folder (KHP A58: `TMPDIR`,
  `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME`, `TEMP` and `TMP` all name one
  folder) point inside it, and the host removes it when the process ends
  and, on its next launch, any a crashed host left. The kit gets no other
  variable of the host's environment than the launch contract lists
  ([Kit Process Protocol](../reference/kit-process-protocol.md) section 3).
  `kition-kit-host` does both; `kition_headless::agent_ready::workspace_only`
  launches a kit that way and fails on any file it leaves there. This keeps
  a kit's accidental writes out of the person's folders and in view of a
  test; it does not confine the kit, which still reaches any absolute path
  unless H14's sandbox denies it.

## Hosts of linked documents

A host that serves [`KitLinks 1.0`](../sets/links.md), previews, or opening
follows these rules. All four are *(proposed)*: no host implements them
yet.

- **H15** *(proposed) Linked reads.* A host that grants link handles to a
  kit listing `links` grants them only for targets of the document's links,
  with the extensions the kit's manifest declares in `links.read`, and
  resolves names in the order LR4 fixes (LR1, LR3, LR4).
- **H16** *(proposed) Previews.* A host that offers `preview-files` has each
  preview drawn by the target's own kit, in that kit's own origin or its
  headless executable, never on its own page's origin or in the asking
  kit's frame; bounds it as PV4 and PV5; and answers `not-found` alike for
  missing files and files the person may not see (PV1, PV7).
- **H17** *(proposed) Renames.* A host that serves `KitLinks 1.0` keeps the
  link index (LK7) and, after a rename or move it performs, retargets every
  linking document it may edit without losing unsaved work, shows and logs
  the change, and offers to undo it (LK8 to LK13).
- **H18** *(proposed) One replica, page and headless.* A host that keeps
  documents' replicas beside their files (Kit UI protocol section 7) serves
  them to headless kits too (`replica.read`, `replica.write`, Kit Process
  Protocol section 5.5), and opens files for its agent, and its drafts
  beside a file (A27), with the stored replica, so a person and an agent
  see the same comment threads and the same `docId`. Tested as
  [conformance](../conformance.md#stored-replicas) says.

## Read scope

LR1 and LR3 to LR6, the scope of link handles, are in
[`KitLinks 1.0`](../sets/links.md) section 3. LR2 holds for every kit, with
or without links:

- **LR2** *Never host data.* For every kit, a host MUST NOT serve its own
  data through a kit's reads, whatever the document or a link names: no path
  with a segment that starts with a dot (hidden folders and files, such as
  `.git/` or `.env`), unless the kit's manifest declares that extension and
  the person opened such a file; none of the host's own stores (Kition:
  `.kition/`); no file of another person in a shared space that the person
  cannot open; nothing outside the workspace. This holds for `host/read`,
  `host/stamp`, lent files (`document.lend`, `kition_kit::host`), and every
  file handle a host grants (FA8). A host refuses such a path the same way
  whether it exists or not, so a kit cannot probe for it. Only a path that passes
  every check and names no file is answered "not found" (Kit Process Protocol
  `file_not_found`, section 10).
