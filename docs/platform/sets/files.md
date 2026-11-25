# `KitFiles 1.1`: files beyond the open document

For integrators whose kits read, create, or replace files other than the
document they opened: insert pages from another PDF, place an image, run a
batch over a folder, export a PNG or a PDF, print. The host stays in charge
of storage and security; the kit never sees a path of the host's file system.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

| | |
| --- | --- |
| Status | Specified in edition 2026.11. The headless binding (Kit Process Protocol, section 8.2) is implemented by every kit built on kition-sdk (`kition-kit-server`) and by its hosts (`kition-kit-host`'s `KitFiles`, `kition-kits`); the page binding by `@kition/kit-host`. `KitFiles 1.1` adds the link grant flow (FA18, from [`KitLinks 1.0`](links.md)) |
| Bindings | [Kit UI protocol](../reference/ui-protocol.md) section 7g (`kition-kit-ui/1`); [Kit Process Protocol](../reference/kit-process-protocol.md) version 1, section 5; [`KitEmbed 1.5`](embed.md) EM21 to EM24; [`KitAgent 1.4`](agent.md) A28 to A30 |
| Kit side | Engine rules E15 and E16 ([engine contract](../kits/engine.md)); manifest rule K15 ([manifest](../kits/manifest.md)) |
| Host side | FA1 to FA18 below; H3 and H5 ([host contract](../kits/host.md)); LR2 |

## 1. Principles

- **FA-P1 The host owns storage and security.** A kit asks; the host
  decides, shows, and records.
- **FA-P2 No raw paths into the kit.** A kit never receives an absolute
  path, a URI of the host's file system, the workspace root, or anything that
  names the person's machine. It receives **file handles** and display names
  (a last path segment).
- **FA-P3 Least privilege, short lifetime.** A handle carries only the
  rights the request needed and lives at most as long as the session that
  asked.
- **FA-P4 One meaning, three bindings.** The page (Kit UI protocol), headless
  (Kit Process Protocol), and the embed carry the same requests under the same
  rules, so a kit written once works in every host.
- **FA-P5 The engine stays IO-free (E5).** Engines read inputs through the
  lent-file path and hand outputs back as bytes; the kit's binding does the
  IO.

## 2. File handles

- **FA1** A **file handle** is an opaque string the host mints, with at
  least 128 bits of randomness, prefixed `fh_`. It is bound to one kit
  session (one document in one editor page, or one headless host
  connection), one kit id, and one principal (the person, or the person on
  whose behalf an agent runs, A11).
- **FA2** A handle names either a **file** or a **folder** and carries a set
  of **rights**:

  | Right | Allows | Never allows |
  | --- | --- | --- |
  | `read` | `files/read` and `files/stat`; for a folder, `files/list` and reading the files it lists that match the grant's `accept` | Writing |
  | `create` | For a file handle minted by `files/create`: writing it once, in chunks, and committing. For a folder: `files/create` inside it | Replacing a file that existed before the grant (H5) |
  | `write` | Replacing an existing file atomically, with an expected version (H4) | Deleting, renaming, or writing outside the handle |

- **FA3** A handle answers `stat` as a **file stat**:

  ```json
  { "handle": "fh_9c1d…", "name": "Q3 report.pdf", "kind": "file", "size": 482113,
    "mime": "application/pdf", "version": "\"1791704599-22779\"", "rights": ["read"] }
  ```

  `kind` is `file` or `folder`; `size` and `mime` are optional; `version` is
  the host's opaque version stamp, `null` for a created file not committed
  yet. `name` is a display name, the last segment only, which the kit MUST
  treat as untrusted text.
- **FA4** A handle expires when its session ends (the frame closes, the
  headless connection closes, the agent run that asked ends) and MAY be
  revoked earlier; the host then sends `files/revoked { handles }`, and later
  calls with it fail with the reason `file-not-granted`.
- **FA5** A handle is not transferable: the host MUST refuse it from any
  other session, kit, or principal. Handles MUST NOT be persisted in
  documents; a document that links a file keeps its relative link (E5).

## 3. Grants

A handle is granted through one of four flows.

| Flow | Who consents | Rights a host MAY grant | Used for |
| --- | --- | --- | --- |
| **Pick** (`files/pick`; or a drop on the kit's frame, `files/dropped`, [`KitPointer 1.0`](pointer.md) section 9) | The person, in the host's own picker, inside a gesture; or by dropping the files | `read` (mode `open`, and drops); `read` on a folder (mode `folder`); `create`, or `write` on an existing file the person chose to replace (mode `save`) | Insert pages from a file, place an image, choose a batch folder, Save a Copy to a chosen place |
| **Create** (`files/create`) | Policy: a new file beside the document destroys nothing; a host MAY still ask | `create` on a new file | Export As, Quick Export, Layers to Files, split into files |
| **Agent request** (a command parameter typed `file`, [`KitAgent 1.4`](agent.md) A28) | The harness's policy for the run, logged; the person sees it in the tool card | `read`; `create`; `write` only under FA13 | An agent combines PDFs, exports a PNG, runs a data-set batch |
| **Link** (`links/resolve`, headless `links.resolve` and `files.resolve`; [`KitLinks 1.0`](links.md) LR1) | Implicit: the document already links the target; LR2 and LR3 bound it | `read` only, on a file | A note embeds a section of another note, a board draws a note card, a kit checks for broken links |

- **FA6** `files/pick` asks the host to show its picker. Params:

  ```json
  { "purpose": "Choose PDFs to insert", "mode": "open", "accept": ["pdf"], "multiple": true, "suggestedName": null }
  ```

  `mode` is `open`, `folder`, or `save`; `accept` lists extensions without
  the dot; `multiple` (default `false`) applies to `open`; `suggestedName`
  applies to `save`. `purpose` is a short English sentence the host MAY show.
  The answer is `{ "files": [stat] }`, empty when the person cancels. A host
  MUST show its picker only in response to a person's gesture in the kit
  (the kit sends the request from a click or key handler); a host MAY refuse
  a pick with no recent gesture (reason `no-gesture`). A host without a
  picker answers `unsupported`; a host lists the capability `files-pick`
  when it has one, and a kit hides the features that need a picker when it
  is missing.
- **FA7** `files/create` params: `{ suggestedName, mime?, folder? }`, where
  `folder` is a folder handle with right `create`. Without `folder`, the host
  creates beside the document. The host MUST pick an unused name (`Report
  2.pdf` when `Report.pdf` exists), MUST NOT replace an existing file, MUST
  take only the last segment of `suggestedName`, and MUST refuse an
  extension the kit's manifest does not declare for output (K15, reason
  `not-allowed`). It answers the new handle's stat (right `create`, `version`
  `null`); the file appears only when it is committed (FA9).
- **FA8** A host MUST refuse a grant that would reach outside its workspace
  or storage (H3), follow a link out of it, or name a file the kit would not
  otherwise be allowed to see: another person's file in an embed, the host's
  own data or a hidden path (LR2), a file the host hides. It refuses such a
  file the same way whether it exists or not, so a kit cannot probe for it.
  It runs every one of these checks, and the extension checks (FA7, K15,
  LR3), before it looks for the file. Only a path that passes all of them
  and names no file is answered "not found" (Kit Process Protocol `-32023
  file_not_found`, section 10); every other refusal is `not-allowed`, the
  same for an existing and a missing target.
- **FA18** (1.1) A **link grant** gives a `read` handle on one file the
  document links ([`KitLinks 1.0`](links.md) LR1), only to a kit that lists
  `links`, only for an extension its manifest declares in `links.read`
  (K18, LR3), and in every binding, the page included. It is minted when
  the kit resolves the link and lives as FA4 says; when the target is
  renamed, deleted, or hidden, the host revokes it (`files/revoked`). A
  link handle is read as any `read` handle (E15), and the kit's binding
  maps the link's stored path to it so the engine reads by that path
  (LR6).

## 4. Reading and writing

| Method | Params | Result |
| --- | --- | --- |
| `files/stat` | `{ handle }` | stat |
| `files/read` | `{ handle, offset?, length? }` | `{ bytes, version, size }` |
| `files/list` | `{ handle }` (a folder handle with right `read`) | `{ files: [stat] }` |
| `files/write` | `{ handle, bytes, offset, final?, expected? }` | `{}`, or `{ version }` when `final` |
| `files/release` | `{ handles }` | `{}` |
| `files/revoked` | host to kit notification: `{ handles }` | |

- `files/read` answers the bytes from `offset` (default 0), at most `length`
  bytes (default: to the end). A host MAY answer fewer bytes than asked (a
  binding's chunk limit); `size` is the whole file's size, so a kit reads on
  until it has what it needs.
- `files/list` answers the folder's entries that match the grant's `accept`,
  not recursively. Each entry's handle carries the folder grant's `read` and
  nothing more.
- `files/release` drops handles the kit no longer needs; it is never an
  error to release an unknown or expired handle.
- **FA9** Writes are staged. A kit sends the bytes in chunks; each chunk's
  `offset` MUST equal the number of bytes staged so far (else `-32602`). The
  host keeps them in a temporary file; `final: true` commits it atomically
  (temporary file, then rename, H4). A `create` handle commits once; a second
  commit fails `already-committed`. A `write` handle commits only while the
  file's version is still `expected`, which the final chunk MUST carry, else
  `conflict`. An uncommitted staging file is deleted when the handle expires.
  This carries an export of any length in bounded memory.
- **FA10** A host MAY cap the bytes written per grant and per session; it
  answers `quota` when a write would pass a cap, and a kit MUST show the
  refusal to the person.

## 5. Printing

- **FA11** A host that prints lists the capability `print`. `files/print`
  takes `{ bytes, mime: "application/pdf", title }` or `{ handle, title }`
  (a handle with right `read` on a PDF) and shows the system's print dialog;
  it answers `{ printed: bool }` (`false` when the person cancels). A kit
  renders what it prints to PDF itself (a PDF kit: the document; other kits:
  their page export). A host MUST NOT answer printer names, settings, or
  anything beyond `printed`, which would fingerprint the machine. Like a
  pick, a print needs a person's gesture (FA6).

## 6. Engines

Engines do no IO (E5). [E15 and E16](../kits/engine.md) say how they
read granted files and hand back what they produce:

- **E15** reads a granted file as it reads a lent file:
  `kition_kit::host::read_range("fh_…", offset, len)` and `size`, served by
  the binding from the same synchronous ranged-read path as lent files.
- **E16** answers a command that produces files with `{ outputs: [{ id,
  suggestedName, mime }] }` and keeps the bytes; the binding takes each with
  the engine member `takeOutput(id)` and writes it to the handle the
  command's params named, or to a handle it creates with `files/create`.

A command names a file by a parameter whose value is the handle string; the
engine passes it back to `host::read_range` and never sees a path.

## 7. Policy rules for hosts

- **FA13 Agent writes.** An agent's `write` grant on an existing file other
  than the document its tool call targets MUST go through a draft beside the
  file ([`KitAgent`](agent.md) A27) or the person's explicit approval in the
  host; a host MUST NOT let a model replace an existing file on its own say.
  `create` grants for an agent need no approval but are logged (A30). (The
  targeted document itself follows A7 and A12: live in its editor, or a
  draft.) Saving the targeted document, in an editor or headless with or
  without drafts, is editing that document, not replacing an existing file
  under this rule.
- **FA14 Unsaved work.** A host MUST refuse `write` on a file that is open
  with unsaved edits in any editor (reason `unsaved-edits`; H6, A9).
- **FA15 Names.** A host sanitises the names it creates: the last segment
  only, no control characters, no names the platform reserves (`CON`, `NUL`
  on Windows), no leading dot unless the kit's format needs one, and an
  extension that matches `accept` and K15.
- **FA16 Visibility.** A host SHOULD let the person see what a kit and an
  agent were granted in this session, and revoke it (FA4).
- **FA17 Read-only sessions.** In a read-only document (UI-K7) a kit may
  still create exports (`files/create`) and print (`files/print`); it is
  granted no `write`.
- **Grant log.** A host records every grant, a person's or an agent's, with
  its flow, kit, principal, rights, and display name, in its session log
  when it keeps one (A10, A30).

## 8. Bindings

### 8.1 Kit UI protocol (page)

The methods of sections 3 to 5 are Kit UI protocol requests from kit to host
(`files/revoked` is a notification from host to kit), specified in the
[Kit UI protocol](../reference/ui-protocol.md) section 7g; `files/dropped`
(host to kit) is in section 7h. Bytes travel as
`ArrayBuffer`s. A host that serves them lists the capability `files` in
`ui/initialize`, and `files-pick` and `print` when it has a picker and
prints.

### 8.2 Kit Process Protocol (headless)

- **FA12** The host serves `files.stat`, `files.read`, `files.list`,
  `files.write`, `files.create`, `files.release`, and `files.resolve` (and
  `files.print` where it prints) **to the kit** on the host connection:
  JSON-RPC 2.0 is symmetric, so the kit sends these requests to its host on
  the same connection. There is no `files.pick`: a headless kit has no
  person to ask, and gets handles from the host's `document.*` requests and
  from `file` parameters (A29). Bytes travel base64 in chunks of at most
  8 MiB.

`file.open`, `document.saveAs`, and `file.export` take handles
instead of URIs, and lent files are read through handles the host resolves
(`files.resolve`). A headless kit process then needs no file-system access
at all, and a host SHOULD run it with the platform's sandbox denying the
file system (except its private cache directory) and the network. See the
[Kit Process Protocol](../reference/kit-process-protocol.md) section 5.

### 8.3 `@kition/embed`

The embed is the host. It mints the handles from its page's storage and
never hands a page `fileId` to the kit: [`KitEmbed 1.5`](embed.md) EM21 to
EM24.

### 8.4 Agents

A command parameter that names a file is typed `file`; the harness turns the
model's workspace path into a handle before the call reaches the kit:
[`KitAgent 1.4`](agent.md) A28 to A30.

## 9. Manifest

A kit that uses this set lists the capability `files` in its manifest and
declares what it may ask for (K15, [manifest](../kits/manifest.md)):

```json
"files": { "read": ["pdf", "png", "jpg"], "create": ["pdf", "png", "jpg", "txt"], "folders": true, "print": true }
```

A host MUST refuse a grant for an extension outside these lists (FA7, FA8),
a folder grant when `folders` is not `true`, and `files/print` when `print`
is not `true`, and SHOULD show the lists before it installs a plugin kit.

## 10. Errors and capability names

A refusal names one reason. The Kit UI protocol and the embed carry it as
`-32000` with `error.data.reason`; the Kit Process Protocol has a code per
reason.

| Reason (Kit UI, embed) | Kit Process Protocol | Meaning |
| --- | --- | --- |
| `file-not-granted` | `-32014 file_not_granted` | Unknown, expired, revoked, or foreign handle, or a right the handle lacks (FA4, FA5) |
| `not-allowed` | `-32018 file_not_allowed` | The host's policy refuses the grant or the file: an extension outside K15, outside the workspace, host data or a hidden path (FA7, FA8, LR2), an agent write without a draft or approval (FA13), a write in a read-only session (FA17) |
| (none: the page reads lent files by path, not through `files/*`) | `-32023 file_not_found` | A file the kit asked for by path (`files.resolve`) that passes every check of FA8 and does not exist; never answered for a path that fails one |
| `no-gesture` | (none: headless has no picker) | `files/pick` or `files/print` without a recent gesture (FA6, FA11) |
| `already-committed` | `-32016 file_already_committed` | A second commit of a `create` handle (FA9) |
| `conflict` | `-32015 file_conflict` | The file's version is no longer `expected` (FA9) |
| `unsaved-edits` | `-32017 file_unsaved_edits` | The file is open with unsaved edits (FA14) |
| `quota` | `-32019 file_quota` | A per-grant or per-session cap (FA10) |
| `unsupported` | `-32601` (method not found) | The host has no picker, does not print, or does not serve the method |
| `io-error` | `-32013 io_error` | The host's storage failed; the message is sanitised and names no path |

| Capability | Who lists it, where | Means |
| --- | --- | --- |
| `files` | Host, Kit UI `ui/initialize` `capabilities` | Serves `files/stat`, `read`, `list`, `write`, `create`, `release`, and sends `files/revoked` |
| `files-pick` | Host, Kit UI `ui/initialize` `capabilities` | Serves `files/pick` |
| `print` | Host, Kit UI `ui/initialize` `capabilities` | Serves `files/print` |
| `files`, `files.print` | Host, Kit Process Protocol `kit.initialize` param `hostServices` | Serves `files.*` (always) and `files.print` |
| `files` | Kit, manifest `capabilities` (K15) | Uses this set; declares `files` lists |

## 11. What replaces today's methods

No compatibility layer is kept: the old methods are removed in the same
edition, with no aliases.

| Before | Now |
| --- | --- |
| Kit UI `host/pick` and the capability `pick-file` | `files/pick` and the capability `files-pick` |
| Kit UI `host/write` with `mode: "export"` or `mode: "create"` | `files/create`, then `files/write`. `host/write` keeps only `mode: "save"`, for the document's own file |
| Kit UI `host/read`, `host/stamp`, `document.lend` | Unchanged in role: the document and the files beside it (its lent files), under LR2. Other files are reached only through handles |
| A kit library's "export a file at a path" helper | `files/create`, then `files/write` of the bytes |
| Kit Process Protocol paths: `uri` in `file.open`, `saveAs`, `export`; `workspaceRoots`; `DocumentState.uri`; reason `uri_not_granted` | Kit Process Protocol `file` handles; no roots; `DocumentState.name`; reason `file_not_granted` |
| Name-based guesses of which command parameters name files | Parameters typed `file` (A28); a command that names files any other way is not exposed to agents |
| Embed: other writes become `storage.create(name, bytes)` | Unchanged, now reached through `files/create` with staged writes; `write` grants call `storage.write` (EM23) |

## 12. Security considerations

- **Threats covered.** A malicious or buggy kit reading or replacing
  unrelated files (handles, rights, H3, LR2); path traversal and link escapes
  (no paths reach the kit; FA8); a model talked by a document's text into
  replacing files (FA13, drafts); exfiltration through file names or printer
  details (FA3, FA11); filling the disk (FA10); a stale write over a newer
  file (FA9 `expected`); writes from a read-only viewer (FA17).
- **Prompt injection.** Picked file names, listed folder contents, and a
  kit's `purpose` are untrusted text. A harness MUST NOT treat them as
  instructions.
- **Sandboxing.** A headless kit on the Kit Process Protocol needs no ambient
  file access, so a host can deny it at the operating-system level (8.2).
  Headless kits MUST NOT open network connections.
- **Gestures.** Pickers and print dialogs open only from a person's gesture
  (FA6, FA11), so a kit cannot nag.
- **Auditing.** Every grant is a session-log event (section 7, A10, A30).

## 13. Conformance

A kit, a host, an embed, or a harness conforms to `KitFiles 1.1` when it
passes these tests (see [conformance.md](../conformance.md)):

| Who | Test |
| --- | --- |
| Kits (page) | A flow test through `@kition/kit-dev-host` that picks a file and a folder with a scripted picker, creates an export, and checks that the kit never sends a path-shaped string in any `files/*` request (`checkNoPaths`; a `mime` param is read as a MIME type, so `application/pdf` passes and `exports/Out.pdf` does not) |
| Kits (headless) | The Kit Process Protocol conformance checks: an ungranted handle is refused; `create` never replaces; a staged write commits atomically; every exposed command that names a file has a `file`-typed parameter; optionally, the executable passes under a sandbox that denies the file system and the network |
| Hosts | FA1 to FA18 and LR2 in Chromium and WebKit: expired and foreign handles refused, unused names chosen, the K15 extension policy, a pick without a gesture refused, a stale `expected` answered `conflict` |
| Embeds | EM21 to EM24 with a fake storage |
| Harnesses | A28 to A30: `file` parameters converted, a refused path stops the call, created files listed and logged |
