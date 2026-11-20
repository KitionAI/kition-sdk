# Kit Process Protocol, Version 1

> **Names.** This is the **Kit Process Protocol**: JSON-RPC between a host and a
> kit process. It is always written in full, never abbreviated; a section is
> "Kit Process Protocol section 10". **KHP** is only the Kit Harness Protocol: how
> an AI agent uses a kit, bound to MCP (its rule
> ids A*, K*, `khp check`, the manifest's `khp` field, `khp://` resources). The
> Kit Process Protocol is part of the Kition kit platform, not of KHP.

Reference implementations:
`kition-kit-server` for kits, `kition-kit-host` and `kition-kits` for hosts;
see section 15.

The kit works on file handles
([`KitFiles 1.1`](../sets/files.md)): the host serves `files.*` to the kit,
and the kit never sees a path (sections 5 and 5.3).

A host in any language need not implement this protocol: `kition-kits serve`
implements the host side and offers kits by workspace path over standard input
and output ([hosts in any language](../../sdk/hosts.md)). This document is for
kit authors, and for hosts that serve files from their own storage.

The Kit Process Protocol connects Kition to kits: native executables that open and edit
one family of documents. How Kition runs kits is in Kition's
`docs/kits.md`. Agents reach these methods through
[`KitAgent 1.4`](../sets/agent.md) (section 8.2).

Machine-readable contracts, in kition-sdk's `schemas/` (and the SDK bundle's):

| File | Purpose |
| --- | --- |
| [`kit.schema.json`](../../../schemas/kit.schema.json) | `kit.json` shipped inside every kit package; its `headless.protocol` is `kition-kit/1` |
| [`kit-process-protocol.schema.json`](../../../schemas/kit-process-protocol.schema.json) | Parameter and result shapes for every method below, the host services included |

When this document and the schemas disagree, the schemas win and this document
is fixed.

## 1. Roles

| Role | Who | Count per kit process | May use |
| --- | --- | --- | --- |
| `host` | Kition desktop (Tauri shell) | Exactly one, connects first | Everything |
| `agent` | Kition runtime | Zero or more | `kit.*` except `kit.shutdown`, `document.*`, `commands.*`, `view.*`, naming files only by handles the host minted for the agent's run (A29) |

The kit is the server. Clients connect to it. The Kition runtime runs inside
the desktop process, but it still connects as a separate `agent` client so
that the kit enforces agent limits itself. Everything an `agent` connection
runs is the agent's: `commands.execute` takes only origin `agent` there, and
a `model.batch` only `origin.kind` `agent`; anything else fails `-32003
role_forbidden`. A host acting for an agent on its own connection sends
origin `agent` too, and gets the same limits.

## 2. Transport

- JSON-RPC 2.0 messages, UTF-8, one message per line (newline-delimited JSON).
  A message must not contain a raw newline.
- Endpoint: a Unix domain socket on macOS and Linux, a named pipe on Windows.
  The host chooses the endpoint path inside a fresh per-launch directory with
  mode `0700`. On Windows it chooses a random name under `\\.\pipe\` and the
  kit creates the pipe with remote clients rejected; the launch token is the
  access control.
- Maximum message size is 64 MiB. File bytes travel base64 in chunks of at
  most 8 MiB (`files.read`, `files.write`, section 5.1).

## 3. Launch

The host starts the kit executable with one argument and four environment
variables:

```text
<kit-executable> --kition-kit

KITION_KIT_PROTOCOL=1
KITION_KIT_ENDPOINT=<socket path or pipe name>
KITION_KIT_TOKEN=<64 hex characters, random per launch>
KITION_KIT_SURFACE=headless
```

Kits run only headless, for the agent: a kit's editor runs in the page over the
[Kit UI protocol](ui-protocol.md), never as a native window over the host. A kit
refuses any other `KITION_KIT_SURFACE`.

The token is passed through the environment, never on the command line, so
that it does not appear in process listings.

The kit gets nothing else of the host's: no current folder, home, temporary
folder, or variable a kit does not need ([host contract](../kits/host.md)
H14a). The host makes a private folder for each launch (mode `0700`, empty)
and starts the kit with:

| What | Value |
| --- | --- |
| Current folder | `<private>/work` |
| `HOME`, `USERPROFILE` | `<private>/home` |
| `TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`, `TEMP`, `TMP` | `<private>/tmp`, the kit's private runtime folder (KHP A58): one folder, whichever of them the kit reads first |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | `.config`, `.local/share`, `.local/state` under `<private>/home` (Windows: `APPDATA`, `LOCALAPPDATA` there too) |
| `LANG`, `LC_ALL` | `C.UTF-8`, whatever the host's (deterministic output, KHP A26; the person's locale arrives in `kit.initialize`) |
| `TZ` | `UTC` |
| From the host's environment, when set | `KITION_FONTS_DIR`, `SOURCE_DATE_EPOCH`, `RUST_BACKTRACE`, `RUST_LIB_BACKTRACE`, `RUST_LOG`, every `KITION_KIT_*` (a kit's own settings are named `KITION_KIT_<NAME>_…`), and on Windows `SystemRoot` and `windir` |
| The four launch variables above | as above |

`PATH` is not passed: a kit starts no programs. Variables a host adds for one
launch on purpose (diagnostics) pass as it gives them. The private folder is
outside the workspace (a launch whose private folder would lie inside it is
refused) and belongs to one launch: no two kit processes share one. The host
removes it when the process ends, and when it next launches a kit, any
folder no running host holds (a host that crashed left it); the folder the
private folders are made in by default (`kition-kits` in the host's own
temporary folder) goes with the last one in it, so a host that is itself a
kit server leaves nothing in the private runtime folder its harness gave it.
The private folder is not a confinement: a kit that names an absolute path
still reaches it, unless the host runs the kit under the platform's sandbox
(below). It keeps what an engine writes by a relative path, or into its home
or temporary folder, out of the person's folders and where a test sees it.

**Sandbox** *(opt-in; meant to become the default)*. `kition-kits-mcp
--sandbox` and `kition-kits serve --sandbox` (`KitManager::with_sandbox`,
`LaunchOptions::sandbox` in `kition-kit-host`) start every kit under the
platform's sandbox ([host contract](../kits/host.md) H14). The kit reads the
platform's own files a process needs (its system libraries, the dynamic
loader, time zones), its package (the folder of its `kit.json` and its
executable's folder) and the fonts folder `KITION_FONTS_DIR` names; it reads
and writes its private folder and the folder of its endpoint, and binds Unix
sockets only there; it reaches no other file and no network (KHP A37). It
gets no workspace: its documents reach it as handles (section 5.1).

| Platform | How |
| --- | --- |
| macOS | `sandbox-exec -p <profile>`: a profile that denies everything by default and allows the above |
| Linux | Landlock for the file system (Linux 5.13 or later with Landlock enabled) and a seccomp filter that refuses every socket but a Unix one, and `io_uring`; both are applied to the host thread that starts the kit, so they hold for the kit only. A kernel without Landlock, or an architecture other than x86_64 and aarch64, refuses to start |
| Windows and others | Not supported: `--sandbox` refuses to start |

There is no fallback: where the sandbox cannot be set up, the program
refuses to start (and a launch fails `could not start the kit sandboxed`),
never running a kit unconfined. On macOS, `sandbox-exec` cannot run inside
another sandbox, so a host that is itself sandboxed (`khp check --sandbox`)
runs its kits without `--sandbox`.

**Kition host process policy.** The same programs offer `--call-timeout-secs` (120 by
default), `--idle-timeout-secs` (600), and optional `--memory-limit-mib` (Linux/macOS;
refused elsewhere). These are host policies over the protocol defaults in section 11;
they use the existing cancellation and progress messages in sections 4 and 9. See
[process controls](../../sdk/process-control.md) for save/restart behaviour and limits.

When the endpoint is listening, the kit writes exactly one line to standard
output and then never writes to standard output again:

```json
{"type":"ready","protocolVersion":1}
```

Standard error is free-form diagnostic logging. The host must reach `ready`
within 10 seconds or it terminates the process.

A kit launched with a `KITION_KIT_PROTOCOL` it does not speak still listens and
writes its ready line, with the version it speaks; a host that reads another
version there stops the kit and reports both versions, and `kit.initialize`
with another version fails `-32004 unsupported_protocol` with the kit's version
in `data.detail`. A kit's `kit.json` says the same in `headless.protocol`
(`kition-kit/1`), so a host can refuse a kit before it starts it.

## 4. Lifecycle

```text
host                          kit
 | -- spawn ------------------> |
 | <------------- ready line -- |
 | -- kit.initialize ---------> |   role=host, token, preferences
 | <----------- capabilities -- |
 | -- kit.initialized (notif) ->|
 | -- document.open ----------> |
 |... session...     |
 | -- kit.shutdown -----------> |   kit flushes and exits within 5 s
```

### `kit.initialize` (request, every client)

The first message on every connection. Any other method before it fails with
`-32002 not_initialized`. A wrong token closes the connection after a
`-32001 unauthorized` error. The first connection must use role `host`; agent
connections are rejected until the host has initialized.

Parameters:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer | `2` |
| `token` | string | Value of `KITION_KIT_TOKEN` |
| `role` | `host` or `agent` | |
| `client` | `{ name, version }` | |
| `locale` | string | BCP 47, for example `en-US` or `zh-CN` (host only) |
| `appearance` | `light` or `dark` | Host only |
| `reservedShortcuts` | array of shortcut | Host only; see section 8 |
| `hostServices` | array of string | Host only; the services the host serves to the kit on this connection: `files` (always), `files.print` when it prints (section 5.1), `links` and `links.preview` (section 5.4), and `replica` (section 5.5) |

Result:

| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | integer | Must equal the requested version |
| `kit` | `{ id, version }` | Must match the installed manifest |
| `capabilities` | object | `surfaces` (`["headless"]`), document formats, optional methods (`features`), and platform capabilities (`capabilities`, as the manifest's `headless.capabilities`, K22; section 5b) |

A version mismatch fails with `-32004 unsupported_protocol`. A host MUST
refuse a kit whose `kit.version` differs from its package manifest's
version (H11, [host contract](../kits/host.md)): it stops the process and
answers an error that names the executable, both versions, and what to do
(rebuild the executable at the manifest's version, or install the matching
package). A stale build is the usual cause: bump `kit.json`'s `version`,
then rebuild. No option or variable skips the check.

### `kit.initialized` (notification, client to kit)

Sent once after a successful `kit.initialize`.

### `kit.ping` (request)

Returns `{}`. The host pings every 15 seconds; three consecutive failures mean
the kit is hung and the host restarts it.

### `kit.setPreferences` (request, host)

Updates `locale` and `appearance` while running.

### `kit.shutdown` (request, host)

The kit stops accepting new requests, closes documents without saving, returns
`{}`, and exits within 5 seconds. The host saves or prompts before calling it.

When the host connection closes without `kit.shutdown` (the host crashed, was
force-quit or killed, or forgot), the kit does the same: it closes its
documents without saving and exits within 5 seconds. A process the host cannot
clean up after (macOS has no parent-death signal) so never outlives it. An agent
connection closing ends only that connection.

### `$/cancelRequest` (notification, client to kit)

`{ id }` cancels an in-flight request; the request then fails with
`-32800 request_cancelled`.

## 5. Documents and files

A kit may hold several open documents. Documents are identified by an opaque
`documentId` assigned by the kit.

A kit names files only by **file handles** (`fh_…`, [`KitFiles 1.1`](../sets/files.md)
FA1 to FA5) that a client gave it in a request, and reads and writes them
only through the host's `files.*` services (section 5.1). It needs no
file-system access except its own private cache directory, and a host SHOULD
run it in the platform's sandbox, denying the rest of the file system and
the network. A kit MUST NOT open network connections. A handle belongs to
the kit process's host connection; the host mints the handles an agent
client passes for that agent's run (A29), and they expire when the run ends.

| Method | Direction | Parameters | Result |
| --- | --- | --- | --- |
| `document.open` | request | `file` (a handle: `read`, plus `write` unless `readOnly`), optional `readOnly`, optional `create: { format }` (a handle on a file that does not exist yet, with `read`, `create` and `write`) | `DocumentState` |
| `document.list` | request | none | `{ documents: DocumentState[] }` |
| `document.activate` | request, host | `documentId` | `{}`; selects the active document |
| `document.save` | request | `documentId` | `{ name, version }` |
| `document.saveAs` | request | `documentId`, `file` (a `create` or `write` handle), optional `format` | `{ name, version }` |
| `document.export` | request | `documentId`, `file` (a `create` handle), `format`, optional `options` | `{ name, version }` |
| `document.close` | request | `documentId`, optional `discardChanges` | `{}`; fails with `-32011 document_dirty` if dirty and not discarding |
| `document.didChangeOnDisk` | notification, host to kit | `documentId` | The kit reloads, or reports a conflict (below) |
| `document.reload` | request, host | `documentId` | `DocumentState`; reads the file again, dropping unsaved edits |
| `document.didChangeState` | notification, kit to all clients | `DocumentState` | Sent on dirty, title, undo, or redo changes |
| `document.didSave` | notification, kit to all clients | `documentId`, `name`, `version` | |

`DocumentState` is `{ documentId, name, title, format, readOnly, dirty, canUndo, canRedo, conflict }`;
`name` is the file's display name (a last segment, FA3).

**Conflicts.** A document is in conflict when its file changed since the kit
read it while the document has unsaved edits. On `document.didChangeOnDisk`
a kit reads a clean document again; it keeps a dirty one's edits, never
silently, and sends `document.didChangeState` with `conflict: true` when the
file is no longer the version it read (a `files.stat` tells). A save that
fails `-32015 file_conflict` puts the document in conflict too. The host
resolves it: `document.reload` takes the file and drops the edits,
`document.saveAs` keeps the edits in another file, or `document.close` with
`discardChanges`. A successful save or reload clears `conflict`.

- The kit reads the document with `files.read` on its handle and saves it
  with staged `files.write` on the same handle, with the version it read as
  `expected` (FA9). `document.saveAs` (the document then lives in the new
  file) and `document.export` (the engine's output for `format`, E16) write
  the same way. A `create` handle commits once and never
  replaces a file (H5). A host names a document's new file (`document.open`
  with `create`, `saveAs` to a new file) with `create` and `write`: the first
  save commits the new file without `expected`, and the saves after it
  replace it with the version that commit answered. An export's handle has
  `create` alone.
- Opening a handle to a file that is already open returns the existing
  `documentId`.
- Every exposed command parameter that names a file is typed `file`
  ([`KitAgent 1.4`](../sets/agent.md) A28); its value in `commands.execute`
  is a handle, never a path.

### 5.1 Host services (requests from the kit to the host)

JSON-RPC 2.0 is symmetric: on the host connection, the kit sends these
requests **to the host** ([`KitFiles 1.1`](../sets/files.md) FA12). Only the
host connection carries them; an agent client never serves them.

| Method | Parameters | Result |
| --- | --- | --- |
| `files.stat` | `handle` | stat (`{ handle, name, kind, size?, mime?, version, rights }`, FA3) |
| `files.read` | `handle`, optional `offset`, optional `length` (at most 8 MiB) | `{ data, version, size }`, `data` base64 |
| `files.list` | `handle` (a folder, `read`) | `{ files: stat[] }` |
| `files.write` | `handle`, `data` (base64, at most 8 MiB), `offset`, optional `final`, optional `expected` | `{}`, or `{ version }` when `final` |
| `files.create` | `suggestedName`, optional `mime`, optional `folder` (a handle), optional `documentId` (create beside that document) | stat of a new `create` handle |
| `files.resolve` | `documentId`, or `file` (the document's handle, while `document.open` still runs), and `link` (the path as the document stores it) | stat of a `read` handle for the lent file, resolved against the document's folder and confined as H3 and LR2; for a kit that lists `links`, also for a target of the document's links (section 5.4). A path that passes every check and names no file fails `-32023 file_not_found`; one that fails a check fails `-32018 file_not_allowed`, whether it exists or not (section 10) |
| `files.release` | `handles` | `{}` |
| `files.print` | `data` (base64 PDF) and `title`, or `handle` and `title`; only with `hostServices` `files.print` | `{ printed }` |
| `files.revoked` | notification, host to kit: `handles` | |

- Lent files (E5): the kit's binding answers its engine's
  `kition_kit::host::read_range(path, …)` from `files.read` on the handle
  `files.resolve` gave for that path, and keeps the map for the session.
  `kition_kit::host::exists(path)` answers `false` when `files.resolve`
  fails `file_not_found`, so an engine's link check tells a missing file
  from a refused one.
- Writes are staged and committed atomically (FA9); the rules of
  `KitFiles 1.1` sections 2 to 7 hold unchanged. There is no `files.pick`:
  a headless kit has no person to ask.

### 5.2 What a host does

- It mints a handle for every file it names to the kit (`document.open`,
  `saveAs`, `export`, `file` command parameters, `files.resolve`), with
  exactly the rights the request needs, and refuses foreign, expired, and
  ungranted handles (`-32014 file_not_granted`).
- It applies the policy of `KitFiles 1.1` section 7 to agent clients: an
  agent's `write` on an existing file other than the document its tool call
  targets goes through a draft or the person's approval (FA13).

### 5.3 Files by handle only

- `document.open`, `document.saveAs` and `document.export` take `{ file: handle }`;
  `document.save`, `saveAs`, `export` and `document.didSave` answer `{ name, version }`, and
  `DocumentState.name` names the document.
- `kit.initialize` carries `hostServices`; there are no workspace roots.
- The kit reads and writes only through `files.*` (section 5.1); a file the host did not
  grant is refused with `-32014 file_not_granted`.
- Parameters that name files are typed `file` (A28).

### 5.4 Links

For kits whose documents link other files ([`KitLinks 1.0`](../sets/links.md)).
A kit that answers `document.links` lists the feature `document.links` in
`capabilities.features` and its manifest's `headless.features` (K9, K18).

| Method | Direction | Parameters | Result |
| --- | --- | --- | --- |
| `document.links` | client to kit | `documentId` | `{ links }`: every outgoing link, as the engine's `linksOf` (LK1) |
| `links.resolve` | kit to host, `hostServices` `links` | `documentId`, `links` (link references `{ path?, name?, docId? }`) | `{ resolved }` as LR4, `file` always a handle stat when the read is allowed |
| `links.backlinks` | kit to host, `hostServices` `links`, optional | `documentId` | `{ backlinks }` as LK5 |
| `links.preview` | kit to host, `hostServices` `links.preview` | `documentId`, `link`, optional `view`, `width`, `height`, optional `scale`, optional `background` | `Image` plus `{ version, kit, name, area? }` (PV8) |
| `links.targetChanged` | notification, host to kit, optional | `documentId`, `link`, `exists`, optional `version`, optional `path` | |

- Retargeting is the command `links.retarget` (LK2), run with
  `commands.execute` and origin `system`; a host saves the document
  afterwards with `document.save` (LK8). It is exposed like every command.
- `files.resolve` serves link targets under LR1 to LR3: a target the
  document's links name (the last `document.links` answer, or a
  `links.resolve` answer), with an extension the manifest's `links.read`
  declares. A kit's binding answers its engine's lent reads of a link path
  from that handle (LR6), so an engine reads lent files and link targets the
  same way.
- There is no headless `host/open` or `host/openUrl`: a headless kit has no
  person to open anything for.

### 5.5 Stored replicas

A host that keeps a document's replica beside its file (the page's
`host/replicaRead` and `host/replicaWrite`, [Kit UI protocol](ui-protocol.md)
section 7) serves it headless too, so an agent working on a closed file
sees and writes the same replica the person's editor does: its comment
threads, its `docId` (M7), and every change the file format cannot carry.
A host that serves this lists `replica` in `hostServices`; a kit uses it
when its engine keeps a replica (`open_with_replica`, the features
`model.open` and `model.export`).

| Method | Direction | Parameters | Result |
| --- | --- | --- | --- |
| `replica.read` | kit to host, `hostServices` `replica` | `file` (the document's handle) | `{ snapshot, blobs, fileStamp }`, or `null` when the host keeps none |
| `replica.write` | kit to host, `hostServices` `replica` | `file`, `snapshot`, `blobs`, `fileStamp` | `{}` |

- `snapshot` and `blobs` are base64 in the KDM's encodings, as the page's
  `host/replicaRead` carries them as bytes; `fileStamp` is the file's
  version as `files.stat` answers it. A replica larger than the message
  limit (section 2) is answered `null` and the kit opens the file plainly.
- **On open.** In `document.open`, a kit whose engine keeps a replica asks
  `replica.read` for the document's handle and follows UI-R1: it opens the
  file with the replica only when `fileStamp` equals the file's version,
  else plainly, and a missing, stale, or damaged replica never stops the
  file from opening.
- **On save.** After `document.save` (and `document.saveAs`, for the new
  file's handle) committed, the kit writes the replica taken with the saved
  bytes under the version the commit answered (UI-R2); a failed
  `replica.write` never fails the save.
- The host keeps one replica per document across the page and headless
  (UI-R3, H18), and confines `file` to handles it minted for this
  connection. An agent's drafts beside a file (A27) fork the replica opened
  this way, so a draft and its merge keep the document's `docId`.

### 5.6 Document identity and forks

A document's permanent id (`docId`, [`KitModel 1.0`](../sets/model.md) M7) lives
in its replica. A kit whose files embed the replica (a board, a table, a
layout) makes every byte copy of a file the same document: a file copied, a
template instantiated twice, the same file uploaded twice. These two requests
let a host read the id a file carries, and make a file into a new document,
without knowing the kit's format. A kit that answers them lists the feature
`document.identity` in `capabilities.features` and its manifest's
`headless.features` (K9); a kit that does not answers both `-32601 method
not found`.

| Method | Direction | Parameters | Result |
| --- | --- | --- | --- |
| `document.identity` | request | `file` (a handle with `read`) | `{ docId }`: the id the file carries, or `null` |
| `document.fork` | request | `file` (a handle with `read`), `target` (a `create` handle) | `{ docId, name, version }`: the new document's id, or `null`; the target's name and the version its commit answered |

- Both read the file through its handle (`files.read`); neither opens a
  document nor needs one open. `document.fork` writes its answer to `target`
  with one committed write and never replaces a file (a `create` handle, H5).
- `docId` is a lower-case hyphenated UUID. It is `null` when the kit's files
  embed no replica (the kit makes a new one each time it opens a file) or
  when this file holds none (a file another program wrote); then
  `document.fork` writes the file's bytes unchanged.
- Otherwise `document.fork` writes the same file with its replica replaced by
  a copy as a new document (M7a, `copy_as_new_document`): the same objects,
  object ids and values, no history (deleted content and earlier versions
  stay behind), empty undo, and a new `docId` the kit makes and answers; the
  host supplies none, as it supplies no `documentId`. Everything else in the
  file is kept. The source and the fork refuse each other's changes (M17),
  and a fork of a fork is another new document. The fork's replica is
  shallow (M16a); its every change (`model.export` without `since`) still
  opens with `model.open` (M14), so the object model and drafts need nothing
  more from the kit.
- A replica the kit cannot read (damaged, of another kit, of a newer schema)
  is `-32012 unsupported_format`, never `null`: a host must not take a file
  it cannot read as one without identity.
- `kition-kit-server` answers both from the kit's `file_identity`:
  `FileIdentity::NotEmbedded` needs no other code; a kit whose files embed a
  replica gives `FileIdentity::Embedded` with where its container keeps the
  replica's bytes and how to put others in their place, and the server loads,
  reads and copies the replica. Hosts call them through `kition-kit-host`'s
  `HeadlessKit::identity` and `HeadlessKit::fork`.

## 5a. Object model and diagnostics

A kit built on the Kit Data Model lists these features in `kit.initialize`'s
`capabilities.features`, and its manifest's `headless.features` repeats them
(K9).

| Method | Feature | Parameters | Result |
| --- | --- | --- | --- |
| `model.describe` | `model.describe` | `documentId` | The document's object types |
| `model.batch` | `model.batch` | `documentId`, a batch | The batch's result |
| `model.open` | `model.open` | `name`, `snapshot`, optional `blobs`, `readOnly` | `{ documentId, title, format, readOnly }` |
| `model.import` | `model.import` | `documentId`, `changes`, optional `blobs` | `{}` |
| `model.export` | `model.export` | `documentId`, optional `since` | `{ changes, blobs? }` |
| `model.save` | `model.save` | `documentId`, optional `format` | `{ data, format, name }` |
| `document.check` | `document.check` | `documentId` | `{ diagnostics }` |

The batch and the replica methods are specified in
[the object model reference](object-model.md) (Headless kits); diagnostics in
[`KitAgent 1.4`](../sets/agent.md) A21 to A23.

### Versions and change sets

Two more requests read what changed in a document, so a client can say what
a write did (the agent tools' receipts, `changes` in a `<prefix>_run` or
`<prefix>_batch` result). They list no feature of their own: a kit that
serves `model.describe` serves them, and one without an object model answers
`-32601 method not found` for both, which a client reports as "not
available" rather than as nothing changed.

| Method | Parameters | Result |
| --- | --- | --- |
| `model.version` | `documentId` | `{ version }` |
| `model.changes` | `documentId`, `since` | `{ changes, version }`, or `{ changes: null, unavailable, version }` |
| `model.derived` | `documentId`, optional `ids` (every object of a type that declares derived values when absent), optional `names` (every declared one when absent) | `{ objects: [{ id, values }] }`: each object's derived values by their declared names, computed now  |
| `model.carried` | `documentId`, `ids` (the objects a change set names as changed or moved), additive `changes` (those entries with `fields`, `edits`, `from`/`to`) | `{ objects: [{ id, carries: { count, what } }] }`: for each object whose change carries others with it that is no stored change (a parent's descendants in world space, a layer's keys in comp time), how many and what, read now; objects that carry nothing are left out. Inspect the changes so a mere rename does not claim to carry transforms. A client asks it once per change set and shows it on the object's change as `carries`; a kit without it answers an error, read as nothing carried |

- `version` is the document's replica version, base64 (KDM `Version`
  encoded); a client treats it as opaque and only hands it back.
- `model.changes` answers the change set since `since` (KDM
  `Replica::changes_since`, `@kition/kdm` `changesSince`): `{ created,
  changed, moved, deleted }`, each list ordered by id, objects named by the
  ids the object model answers (tool ids where the schema declares them,
  KitObjectModel OM9). A created object is `{ id, type, fields, values, at? }`,
  a changed one `{ id, type, fields, edits: [{ field, before, after }] }`, a
  moved one `{ id, type, from, to }` with positions `{ parent, field, index }`,
  a deleted one `{ id, type, fields: [] }`. Values are given as they are,
  except texts longer than 80 characters (`{ excerpt, length }`, the excerpt
  at most 80 characters, cut with `…`) and blob `after` values (`{ size }`);
  blob `before` values retain `{ hash, mime, size, name? }` so a kit can identify
  the basis value (bytes may still be unavailable); a list or tree
  field's change is told by `moved`, `created` and `deleted`, not as values.
  An object without a tool id that an object with one holds (through a list
  or tree field, or a `ref` the schema declares `owns`) is told as an edit of
  the nearest such holder, `field` being the path from it, field names and
  positions joined by `.` (`body.paragraphs.0.text`); created and deleted
  ones give their values as `after` and `before`, moved ones their paths
  (OM9). A kit never sends `footprint`: a client that answers a change set may
  write it there (`kition-kits` does, KDM `footprint::with_footprint`): `[{
  parent, field, from, count, shift: { field, by } }]`, the `count` objects of
  `parent`'s list `field` from index `from` (after the change) whose only
  change was `shift.field` changed by `shift.by`, stated once instead of
  listed.
- A field the schema marks `"position": true` says where its object is, not
  what it is (a clip's `start` and `duration` on its track). Clients read its
  change, or a change at a path inside it (`location.0`), as a move: the premise guard answers `relocated` for it, a command
  declared position-independent (section 6) is not refused for it, and two
  reads of a file compare objects without it when they look for renumbered
  tool ids.
- A type may declare `derived` values (`{ "topology": { "description": … } }`):
  values the kit computes for an object on request (`model.derived`) and never
  stores in the replica or the file, which change sets and premises name
  `~<name>` (`~topology`). Field names starting with `~` are reserved.
- When the document's history no longer holds `since` (it was reloaded or
  replaced since the version was read), `changes` is `null` and `unavailable`
  says why: never an empty change set, which would read as "nothing changed".
  `version` is always the version now.
- Neither request changes the document. A kit built with `kition-headless`
  answers both for any document with an object model, from the replica the
  object model reads; no kit code is needed.

## 5b. Document text

A kit whose words live outside its object model (PDF page text, text
layers) lists the capability `document-text` in `kit.initialize`'s
`capabilities.capabilities` and its manifest's `headless.capabilities` (K22),
and answers `document.text` ([`KitText 1.0`](../sets/text.md)):

| Method | Capability | Parameters | Result |
| --- | --- | --- | --- |
| `document.text` | `document-text` | `documentId`, optional `limit` (Unicode scalar values, default `1048576`) | `{ text, truncated, parts? }`, `parts` as `[{ label, start, end }]` |

It is read-only and has no side effects (T2); `text` has at most `limit`
characters and `truncated` says whether there was more (T5). A host reads a
document's words with `document.text`, else from the object model, else
from the file name (T7).

## 6. Commands

Commands are the single way to change a document. Every UI action in a kit
maps to a command, so agents and people have the same abilities.

### `commands.list` (request)

Parameters: optional `documentId`, optional `groups` (array of tool group ids
from the manifest). On an `agent` connection the list leaves out what the
manifest keeps from the agent (`agent.include`, `agent.exclude`).

Result: `{ commands: CommandInfo[] }` where `CommandInfo` is:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable dotted identifier, for example `layer.newAdjustmentLayer.curves` |
| `title` | string | Localized to the host locale |
| `description` | string | Optional: the engine's `KitCommand::description`, what the command does, when to choose it and what it changes or answers; absent when the kit gives none (a host never fills in parameter notation or the title) |
| `group` | string | A tool group id declared in the manifest |
| `params` | JSON Schema object | Parameters accepted by `commands.execute`; a `file` parameter is a string with `x-khp-file` (KitAgent A28, A29). The parameter that names what the command acts on (one id, or an `array` of ids) has `"x-khp-role": "targets"`, and `"x-khp-reads"` at the top lists the editor state the command reads besides its parameters (`selection`, `part`, `time`, `mode`, `active`, `area`; section 7a). A parameter that names a place rather than an object (a track, a time, an index) has `"x-khp-role": "place"` (section 7a, `context.under`); one besides the targets that names objects by id (a parent, a material) has `"x-khp-role": "object"`, and only there (or with `"x-khp-index"`) is a whole number read as an id. `"x-khp-position": "independent"` at the top says what the command does to its target does not depend on where the target is (its index, its `position` fields): an opacity, a colour. `"x-khp-index": "#"` on the target parameter says it also takes an object by its place in a list, the prefix and a number from 1 (`"#3"`): such a value, in that or any other parameter (`parent: "#2"`), is a place (`context.under` answers what it names), never an id, and a step's `on` refuses it; `"x-khp-index-numbers": true` beside it says a whole number there that names no object is such a place too (a motion kit's `layer: 3`); `"x-khp-index-order": "reversed"` beside it says the number counts from the other end of the list, `"#1"` the last item stored, while `context.under` still answers windows in stored order. `"x-khp-role": "object"` may sit on a member nested in a parameter (`rules[].target`): ids are read there at any depth. `"x-khp-types": ["Layer"]` on the target or an object parameter lists the types it names: an id of another type is not its object (with `x-khp-index-numbers`, a number naming no object of these types is a place). `"x-khp-name": "name"` on the target parameter says it also takes an object by its name, that stored field: a client holds that the name names the object it named at `basis`. A numeric string in an integer target or object parameter (`"9"`) is that integer  |
| `output` | JSON Schema object | Optional: the command's `result`, from the engine's `outputSchema` (KitAgent A1). An MCP binding sends it as the tool's `outputSchema`, with the A18 error result beside it |
| `mutates` | boolean | `true` if it changes the document |
| `enabled` | boolean | For the given document and current selection |
| `menu` | array of string | Optional: where the command sits in the kit's menus |
| `shortcut` | string | Optional: the default shortcut |
| `keywords` | array of string | Optional: words an agent's command search finds the command by that its id, title and description do not say, for example the effect names `effect.apply` takes. Searched, not shown |

`x-khp-name` also applies to non-target name-taking parameters, including
nested members (`KitCommand::name_params`); each parameter's `x-khp-types`
limits both id and name resolution. A name's deleted object refuses as
`deleted`, a rename-away or reassignment as `relocated`.

### `commands.execute` (request)

Parameters: `documentId`, `command`, `params`, `origin` (`user`, `agent`,
or `system`; `system` only from the host connection, for changes the host
makes on the person's behalf, such as `links.retarget` after a rename, or a
host feature importing mail into a table), and with `system` an optional
`originLabel` naming the host feature (`emailsync`: 1 to 64 letters, digits,
`-`, `_`, `.`; `host` when absent).

Undo follows the origin ([`KitModel 1.1`](../sets/model.md) M12a): a `user`
change is a step of the person's undo history, an `agent` change a step of
the agent's (the person's undo keeps it), and a `system` change is a step of
**no** history: neither the person's undo nor an agent's takes it back. A kit
records it under the `system` origin with its label, so the document's
history says which host feature wrote it. A kit that cannot keep a change out
of its undo histories refuses `system` with `-32021 command_disabled` rather
than make it undoable; kits built on `kition-headless` with an object model
keep it out. A kit's own parameters with the same effect (kit.table's
`asOrigin`) are that kit's; `origin: "system"` is the protocol's way.

Result: `{ changed, result }`, where `result` is optional command-specific JSON.

Errors: `-32020 command_not_found`, `-32021 command_disabled`,
`-32022 invalid_params`.

Every way a client runs a command passes the same check, for whom it runs:
`commands.execute`, each `command` operation of `model.batch` (section 5a),
and every step a command that runs other commands dispatches while it runs
(a macro, a script; engine contract E21). The command must exist
(`command_not_found`, with the closest ids the caller is offered); name no
file unless the kit declared it safe, and, for the agent, not be kept from it
by the manifest (`command_disabled`); and have the parameters its schema
states (`invalid_params`).

Every executed command that mutates a document is one undo step.

### `commands.didChangeEnabled` (notification, kit to all clients)

`{ documentId, enabled: string[], disabled: string[] }`, sent when enablement
changes. Clients that do not care may ignore it.

## 7. View

| Method | Parameters | Result |
| --- | --- | --- |
| `view.screenshot` | `documentId`, `scope` (`canvas`), optional `maxSize`, optional `target`, optional `scale` | `Image` |
| `view.describe` | `documentId` | `{ summary, state }`: a short text summary and kit-defined structured state, for example layers, pages, or timeline tracks |
| `view.layout` | `documentId`, optional `pages` (page numbers), optional `limit`, optional `cursor` | `{ layout }` ([`KitAgent 1.4`](../sets/agent.md) A40) |
| `view.hitTest` | `documentId`, `x`, `y`, `space` (`preview` or `document`), optional `page`, optional `target`, optional `scale`, optional `maxSize` | `{ hits: [{ id, type?, bounds, page? }] }` ([`KitAgent 1.4`](../sets/agent.md) A31) |

`Image` is `{ mimeType: "image/png", width, height, data }` with base64 `data`.
`view.screenshot` must work in `headless` mode by rendering offscreen.
`target` and `scale` are those of `<prefix>_inspect` (A39): `target` is a
diagnostic's target plus `time` for timeline kits, `scale` (device pixels per
document unit) above 0 and at most 2, 1 when absent, and `maxSize` (the
longer side) 16 to 4096, 1024 when absent; `maxSize` wins over `scale`. An
Agent-ready kit answers a rendering by its own engine, not uniform and framed
to the content (A39). A kit answers what was asked or refuses the call with
`invalid_params` saying what it cannot draw (a `target`, or a scale its engine
could only enlarge); it never answers another image instead. A kit on
`kition-headless` draws the whole document at the scale its engine's
`max_render_scale` allows and refuses any `target`.

`view.layout` is the feature `view.layout` in `kit.initialize`'s
`capabilities.features` (and the manifest's `headless.features`, K16); a
layout kit that claims the Agent-ready profile lists it.

`view.hitTest` is the optional feature `view.hitTest`, listed the same way
([`KitPointer 1.0`](../sets/pointer.md) section 8). It answers the objects
under a point, topmost first, at most 32, with `bounds` as
`[x, y, width, height]` in document units. With `space: "preview"`, `x` and
`y` are pixels of the image `view.screenshot` (scope `canvas`) returns for
the same `target`, `scale`, and `maxSize`; with `space: "document"`, document
units of `page` (counted from 1) or of the canvas. It changes nothing and
answers for read-only documents. There is no headless selection method a
person's selection comes from: a headless kit has no person (`KitPointer 1.0`
PT10). The editor state a command reads is set for one call only (section 7a).

## 7a. Editor context

A command may read editor state besides its parameters: the selection, the
current part (slide, page, or the kit's own part noun), the current time, the
editor's mode (`mode`: a 3D kit's edit mode, a document's editing mode), and
the active object new content goes to (`active`: the active layer, the target
tracks), and the selected area (`area`: a photo kit's marquee or pixel
selection, a region rather than objects); its `params` schema says which (`x-khp-reads`, section 6). These requests let a client set that state for one
call and put it back, so no call leaves hidden state behind. They are
optional: a kit without them answers `-32601` (method not found), and a client
then addresses a part through the kit's own command (`slide.go`, `page.go`)
and cannot set a selection or a time.

| Method | Parameters | Result |
| --- | --- | --- |
| `context.get` | `documentId` | `{ state }`: the editor state, opaque to the client; `null` for a kit that keeps none |
| `context.set` | `documentId`, optional `on` (the ids of the objects a call acts on, which become the selection), optional `part` (one of the kit's part nouns as its manifest declares them, `agent.parts`, for example `{ sequence }`, passed as the call gave it; for a kit that declares none `{ slide }` or `{ page }` counted from 1, `{ slideId }` or `{ pageId }`), optional `time` (seconds) | `{}` |
| `context.restore` | `documentId`, `state` (what `context.get` answered) | `{}` |
| `context.under` | `documentId`, `command`, optional `params` (the step's, with `on` written into its `targets` parameter), `on` (the step's, for a command without a `targets` parameter: set as the selection), `part`, `time` | `{ objects, within?, premises? }`: the objects (by the ids the inspect lists) the command would act on, named by its place: its `place` parameters, an index spelling, or the current time for a command that reads `time` (empty for a call that names its objects by id); `within`, for each list the place falls in, `{ parent, field, from, to }`, the window of the indexes of those objects in that list (`from == to` for a place no object covers: where one put there would go), or `{ parent, field, time: { from, to, start, end \| duration } }`, a place in time (`from == to` for a point) over the items' time fields (fields marked `position`, numbers or numeric strings); `premises`, what the call needs of each object it names, `{ id, fields?, positions? }`: the paths it reads or replaces (as receipts give them, or `named`) and the positions it depends on (`position` fields, and the list field holding it for its index), each left out for every one; `covers: { fields }`, for a place no window can declare (a world point), that the client should ask `context.covered` instead, `fields` the fields besides `position` ones whose change may move an object into or out of it (`hidden`, `~bounds`) |
| `context.covered` | `documentId`, `command`, `params`, `on`, `part`, `time` (as for `context.under`), `objects`: `[{ id, before, deleted?, created?, unknown? }]` | `{ under, covered: [{ id, covered }] }`: evaluated with every object's `before` values put in at once (a `deleted` one put back from them, a `created` one left out), every other object as it is now, what the place named at the agent's `basis` (`under`, as `context.under`'s `objects`), and whether each object, or anything whose place derives from it (its children), was among them; `covered: null` when a value it needs is in `unknown`  |

None of them is an edit: the document is not dirty after them, its revision
does not move, and nothing joins an undo history. `context.set` sets only the
members it is given and refuses an id or part the document lacks
(`-32022 invalid_params`) and a member the kit cannot set
(`-32021 command_disabled`); an unknown member is `invalid_params`. A kit on
`kition-headless` answers them through `KitDocument::editor_state`,
`set_context` and `restore_editor_state`.

time windows may also address JSON arrays or maps, including paths
through owned refs and JSON stable-member selectors. `time.identity` is an
optional stable JSON member path; arrays should declare it to distinguish
replacement at equal time, while maps may use their keys. Missing/duplicate
identities or unavailable historical values refuse `unknown`. `start` without
`end`/`duration` declares an ordering point. Historical membership and ordering
changes inside the window refuse, including a deleted entry. Model-object
deletion reports `deleted`; JSON membership changes report `relocated` on the
holder. Content holds remain separate. Mixed ordinal/time windows are checked
independently.

A `model.batch` command operation can carry `on` and `at: {part,time}`, with the
same meaning as a run step. The batch adapter applies these before executing
the command and restores editor state afterward, including on command failure.
An adapter unable to set explicit context refuses `command-failed` instead of
executing under different state. Bound references in context use command tool
ids. Rust `BatchTarget::command_at` and TS `BatchTarget.commandAt` supply this
contract; SDK session/exchange adapters use the document's context hooks.

A type declaring `batchIndependent: true` in `model.describe` opts raw field
writes into identity-and-field premises: they hold the written fields, including
positional fields they replace, and ignore unrelated placement. Without the
declaration raw field writes retain the existing positional contract. Structural
operations still hold their source/destination windows. This is a Rust/TS schema
property; explicit Rust `TypeDef` literals add `batch_independent: false`.

`context.identity`  takes `{documentId, objects:[id-or-name,...]}`
and answers `{unproven:[...]}`, a subset of the addressed values whose identity
cannot be proven across saved-file rereads. An empty list proves no ambiguity
for these addresses. The guard consults it only after an outside entry since
basis and refuses listed values as `unknown` until a fresh observation. The
default SDK hook returns an empty list; older servers may omit the method.
A supported method that fails or returns a malformed answer refuses unknown.
During an equal-model outside reread the host may ask about all model ids.
Uncertainty still advances private guard history, even when no stored value
changed; it never adds an object to public changes.

`context.inputs` takes `{documentId}` and answers
`{inputs:[{name,fingerprint:string|null},...]}`. Names are unique nonempty
strings; fingerprints are content identities computed by the kit. Keep names
when bytes become unavailable (`null`). The host captures these before calls
and after successful calls; a changed observation advances the revision even
when the document did not change. `context.under` may add `inputs:[name,...]`
for consumed sources. A source absent or unavailable at basis refuses
`unknown`; changed content refuses `changed`. Inputs first registered by a
read command are captured before its returned revision. Default SDK hooks
return an empty list, and older servers may omit the method.

`context.under` sets the call's `on`, `part` and `time` as `context.set` does, asks,
and puts the state back: no edit, and the editor as it was. A kit that cannot
say for a command answers `-32021 command_disabled`; one without the request
`-32601`. A kit on `kition-headless` answers it through `KitDocument::under`,
the context set before it is called. `kition-kits` asks it for every step of an
agent's write with `basis`: for a step that names what it acts on by
a place it refuses the write when the objects under the place are not those
that were there at `basis`; for every step it reads `premises`, which narrow
(or add) what the write needs of each object
([agent tools](../../sdk/agent.md#what-others-changed)). A step that names its
objects by id is asked too: a kit that cannot say anything for it answers
`command_disabled` or an empty `objects`, and a by-id step's `objects` and
`within` are not read.

a premise may add optional `identities`, a map from one of its
`fields` selectors to an entry's stable member key, for example
`{"id":"image","fields":["channels[name=\"Alpha\"]"],"positions":[],
"identities":{"channels[name=\"Alpha\"]":"key"}}`. The member is a unique,
immutable string/number retained across saved rereads. The host reconstructs
the named entry at `basis` and follows that identity, distinguishing deletion
(`deleted`), rename or name reassignment (`relocated`) and content changes
(`changed`). Other entries and index shifts alone do not conflict. Declare
the original name even if it no longer resolves now. Missing/duplicate keys,
unreadable lists or incomplete history refuse `unknown`. The conflict still
names its holder in `id`, with `place.selector` naming the selected entry.
Plain selector fields keep their existing behavior; this property is optional.

`context.covered`  is asked for a place whose `context.under` answer
gives `covers`: in one request, every object others created, deleted, moved in a
list, or changed in a `position` field (or a path inside one, `location.0`) or a
field `covers` names since `basis`, at most 64 (beyond, the write is refused
without asking, `place.unknown`). `before` holds each object's values at `basis`
of the fields that changed since (the earliest value; a json field rebuilt whole
from the leaves a change set told; a deleted object's from what the journal kept,
its `position` fields and derived values; one others created since is asked as
`created`, not there then); the kit takes every other field as it is now. A deleted object's fields the journal did not keep (`hidden`) are the
kit's to assume: assume the value that lets it be under the place. The kit
evaluates the place as it was, without changing the document or the editor state
(it substitutes the values into its own geometry query), and answers what the
place named then. The write is refused as `relocated` when an object under the
place now was not under it then, or one under it then is not now (`deleted` when
others deleted it; an object others moved that held it, a parent, is named too),
and when the kit cannot say (`null`, an error, no such request). A kit on `kition-headless` answers it through
`KitDocument::covered`, and `model.derived` through `KitDocument::derived`.

`kition-kits` saves the state before a `<prefix>_run` or a `<prefix>_inspect`
with a `target`, sets each step's `on`, `part` and `time` before it, and
restores the state after the last step and after a failed run is rolled back,
also on the document a rollback reopened. It restores before it saves, so a
kit that writes some editor state into its file (an open sequence, a
viewport) saves the person's state, never the run's navigation.

A step's `on` fills the parameter the command marks `"x-khp-role": "targets"`
when it has one (and sets no selection, even when the command also reads
it); else it becomes the selection, through `context.set`, for a command that
reads `selection`, and the step's other parameters go as given; else it is
`invalid-params`. A step that gives both `on` and the `targets` parameter is
`invalid-params`, even with the same ids.

No `context.set` member sets `mode`, `active` or `area`. `kition-kits` still saves the
state before a run and restores it after, and the commands tool says of a
command that reads them (`dependsOn`) that the run sets them with the kit's
own command in an earlier step; what a run sets is gone after the call.

## 8. Surface

Kits have no native surface: there are no `surface.*` methods, focus or input
notifications, or embedding mechanisms, and the error codes -32030 and -32031
are not used.

## 9. Progress And Logs (Kit To All Clients)

| Notification | Parameters |
| --- | --- |
| `kit.progress` | `{ token, title, fraction?, done }`; `token` is the related request id |
| `kit.log` | `{ level: "debug" or "info" or "warn" or "error", message }` |

Log messages must not include document contents, file paths, file names the
host granted, or credentials.

## 10. Errors

Standard JSON-RPC errors (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`)
keep their meaning. Kit errors carry a stable string `data.reason`:

| Code | `data.reason` | Meaning |
| --- | --- | --- |
| -32001 | `unauthorized` | Wrong token |
| -32002 | `not_initialized` | Method called before `kit.initialize` |
| -32003 | `role_forbidden` | Method not allowed for the client role |
| -32004 | `unsupported_protocol` | Protocol version mismatch |
| -32010 | `document_not_found` | Unknown `documentId` |
| -32011 | `document_dirty` | Close without `discardChanges` on a dirty document |
| -32012 | `unsupported_format` | Format cannot be opened, saved, or exported |
| -32013 | `io_error` | Read or write failed; `data.detail` is a sanitized message |
| -32014 | `file_not_granted` | Unknown, expired, revoked, or foreign handle, or a right the handle lacks |
| -32015 | `file_conflict` | A commit whose `expected` version is stale |
| -32016 | `file_already_committed` | A second commit of a `create` handle |
| -32017 | `file_unsaved_edits` | A `write` to a file open with unsaved edits |
| -32018 | `file_not_allowed` | The host's policy refuses the file or the grant (K15, LR2, FA13) |
| -32019 | `file_quota` | A per-grant or per-session byte cap |
| -32020 | `command_not_found` | Unknown command id |
| -32021 | `command_disabled` | Command not enabled in the current state |
| -32022 | `invalid_params` | Command parameters failed schema validation; `data.errors` lists them, one `{ path, message, expected? }` for each wrong parameter: `path` a JSON Pointer into the params (`/fields/0/type`), `expected` what the command takes there in words; `data.detail` repeats the first `message` |
| -32023 | `file_not_found` | A file the kit asked for by path (`files.resolve`) that passes every check of the host's confinement and does not exist; never answered for a path that fails one (below) |
| -32040 | `link_not_found` | No such link target, or one the person may not see ([`KitLinks 1.0`](../sets/links.md) LR2, PV7) |
| -32041 | `link_not_linked` | The target is not in the document's link set (LR1) |
| -32042 | `link_no_kit` | No kit draws the target |
| -32043 | `preview_limit` | A preview bound; `data.detail` is `too-large`, `timeout`, or `busy` (PV4, PV5) |
| -32044 | `preview_unsupported_view` | The target's engine cannot find the `view` (PV2) |
| -32045 | `preview_failed` | The target's kit failed to draw |
| -32800 | `request_cancelled` | Cancelled by `$/cancelRequest` |

**Not found or not allowed.** A host answers a kit's request for a file by
path (`files.resolve`) in this order. It first runs every check of its
confinement ([host contract](../kits/host.md) H3, LR2; [`KitFiles 1.1`](../sets/files.md)
FA8): the path, once `..` and links are resolved, is inside the workspace;
no segment is hidden (a dot first); it is none of the host's own data
(Kition: `.kition/`); and its extension is one the request accepts, where a
rule names extensions (K15, LR3). A path that fails any check fails
`-32018 file_not_allowed` with the same message and data whether its target
exists or not, so a kit cannot probe the disk ([`KitAgent 1.4`](../sets/agent.md)
A29). Only a path that passes every check and names no file fails
`-32023 file_not_found`. A kit that does not know `file_not_found` (section
12) handles it as any failed read, as it handled `file_not_allowed` before.

## 11. Timeouts

| Operation | Limit |
| --- | --- |
| Launch to `ready` | 10 s |
| `kit.initialize` | 10 s |
| `kit.shutdown` to process exit | 5 s, then the host kills the process |
| Other requests | 30 s, except `document.*` and `commands.execute`, which report `kit.progress` and have no fixed limit |

## 12. Versioning

- `protocolVersion` is an integer, `1` in this version. Breaking changes
  increment it; hosts and kits speak one version.
- Additive features within a version are discovered through
  `capabilities`, never through kit version comparisons.
- Clients must ignore unknown notification methods and unknown result fields.
- A new error reason (a `code` and `data.reason` in section 10) is additive
  within a version. A receiver that does not know it handles the error as a
  failed request without a reason it can act on, as it handles any other
  failure; a sender never answers a new reason where an older receiver
  needs the old one to stay safe (`file_not_found` is answered
  only where `file_not_allowed` would have said nothing more).

## 13. Mapping From Upstream Control Channels

Upstream engines already expose a JSON-lines control channel. The kit adapter
translates it:

| Upstream concept | Kit Process Protocol |
| --- | --- |
| Engine command registry listing | `commands.list` |
| `engine.execute` | `commands.execute` |
| `ui.screenshot` / offscreen render | `view.screenshot` |
| MCP server tools | Not used directly; the Kition runtime builds agent tools from `commands.list` |

## 14. Conformance Suite

Every kit must pass a shared black-box suite before release. Checks 1 to 10
apply to every kit; 11 is optional; 12 to 15 apply to a kit that lists the
feature or capability or keeps the replica they name, and are skipped otherwise:

1. Launch, `ready` line, and initialize within the time limits.
2. Wrong token, wrong protocol version, and pre-initialize calls are rejected.
3. Agent role cannot call `kit.shutdown` or the other host-only methods.
4. Open, edit by command, save, reopen, and compare a fixture document.
5. `file_not_granted` for an ungranted, foreign, or expired handle;
   `files.create` never replaces a file; a staged write commits atomically
   and a stale `expected` fails `file_conflict`.
6. Every listed command has a valid JSON Schema for `params`.
7. `view.screenshot` works.
8. `kit.shutdown` exits within 5 seconds, and so does closing the host
   connection without it; closing an agent connection does not end the kit.
9. The kit does not write to standard output after the `ready` line.
10. Every listed command whose parameters name a file has `file`-typed
    parameters (A28).
11. Optional (`--sandboxed`): the executable runs under a profile that denies
    the file system (except its cache directory) and the network, and still
    passes 1 to 10.
12. Optional, for a kit that lists the feature `view.hitTest`: a point inside
    an object of the fixture answers that object's id first, a point on
    nothing answers `hits: []`, and the document's revision is unchanged.
13. For a kit that lists the feature `document.links`: `document.links` of
    the fixture answers the links the kit's test states, comments excluded;
    `links.retarget` with origin `system` changes only link spans and a
    second run answers `changed: 0`; the engine's reads of link targets go
    only through handles from `files.resolve` or `links.resolve`, and a
    target outside `links.read` is refused.
14. For a kit whose engine keeps a replica (features `model.open` and
    `model.export`, section 5.5), with the suite serving `hostServices`
    `replica`: `document.open` asks `replica.read` for the document's handle
    and opens with a replica whose `fileStamp` matches the file's version
    (the reopened document keeps the replica's `docId` and comment
    threads); with a stale, damaged, or missing (`null`) replica it opens
    the file plainly; `document.save`, and `document.saveAs` for the new
    file's handle, are followed by `replica.write` for that handle with the
    replica taken with the saved bytes and the committed version; a failing
    `replica.write` leaves the save successful; and against a host without
    `replica` in `hostServices` the kit sends no `replica.*` request (UI-R1,
    UI-R2).
15. For a kit that lists the capability `document-text` (section 5b):
    `document.text` of the fixture answers text within the default limit,
    with parts in order and inside the text; with a limit shorter than the
    text it answers the start of it, at most `limit` characters, and
    `truncated: true`; a negative `limit` is `-32602`; and the document's
    state (`document.list`, `view.describe`) is unchanged ([`KitText 1.0`](../sets/text.md)
    T2, T5, T6).

The suite is the `kition-kit-conformance` command. A kit repository runs it in
CI against its packaged executable with a fixture document and one command
that changes it:

```bash
kition-kit-conformance --kit <executable> --manifest kit.json \
  --fixture <document> --edit-command <command id> --edit-params '<json object>'
```

`kit.json` may be the Kit Harness Protocol manifest (it has a `khp`
version; schema `contracts/kit/kit.schema.json`, a copy of
kition-sdk's `schemas/kit.schema.json` that `node scripts/sync-kit-host.mjs`
refreshes and `pnpm check:kit-host` keeps current), whose `headless` section names the
executable and must say `kition-kit/1`; or the package manifest below. Kit ids
are dotted, reverse-domain style (`kit.photo`, `com.example.cad`), in both.
Kits built on the Kition SDK get their executable from `kition-headless`
and pass the suite without kit-specific protocol code.

Besides the numbered checks it validates `kit.json` against the manifest
schema and validates `kit.initialize`, `document.open`, `commands.list`,
`view.describe`, and `view.screenshot` results against the protocol schema.

A kit that claims the Agent-ready profile ([`KitAgent 1.4`](../sets/agent.md)
section 10) also passes the Agent-ready suite, whose phase 2 runs checks 1 to
10 with the network denied and compares `kit.initialize`'s `kit.version`
with the manifest ([conformance](../conformance.md#agent-ready-profile)).

## 15. Reference Implementation

Kits: every kit's headless executable is built on kition-sdk's
`kition-kit-server` (through `kition-headless`), which implements every method
here, including section 5a. Hosts: the crates below. Both sides use one
definition of the protocol, `kition-kit-process-protocol`, which `kition-kit-server`
and `kition-kit-host` each re-export as `protocol`.

| Crate (kition-sdk) | Contents |
| --- | --- |
| `kition-kit-process-protocol` | The one definition for hosts and kits: types for every method in `schemas/kit-process-protocol.schema.json` (at the crate root), error codes, launch constants, framing, base64, and (with the `tokio` feature) the transport |
| `kition-kit-server` | The kit side: launch, the two-way host connection, roles, and dispatch to a backend, which reads and writes through the host's `files.*` |
| `kition-kit-host` | The host side: launch, endpoint, and client; `files` (the grant table of `KitFiles 1.1`) and `KitFiles`, the `files.*` a host serves one kit; `HeadlessKit`, a kit launched and initialized as the host of one workspace folder in one call |
| `kition-kits` | Kition's host of every kit (`KitManager`), and `kition-kits serve`, the same host for programs in any language |
| `kition-kit-mock` | A headless reference kit for `.mocktext` documents, written apart from `kition-kit-server` |

Kition keeps the conformance suite, `kition-kit-conformance`. The case
`regressions/issue-2` in kition-sdk drives a kit with nothing but a socket and
JSON, as a host in another language does.
