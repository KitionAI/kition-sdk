# Conformance

> **Kition kit platform, not KHP.** Platform requirements and implementation contracts.
> KHP's own conformance (the tiers basic, Agent-ready, and Agent-ready
> complete, run by `khp check` against a kit's MCP server) is in KHP's
> `spec/conformance.md`. The `KitAgent 1.4` row and the Agent-ready profile
> section below are Kition's release checks for its own kits and hosts, over
> the Kit Process Protocol; Kition's **Agent-ready core** stage sits between
> KHP's basic and Agent-ready tiers.

Conformance is stated per capability set. A kit, a host, a server, or an
agent harness conforms to a set at a version when it passes that set's
tests.

> Tool and schema paths (`tools/...`, `schemas/kit.schema.json`) are in the
> Kition SDK repository, which implements the conformance checks.

| Set | Who conforms | Tests |
| --- | --- | --- |
| `KitModel 1.0` | Kits | A valid engine contract 2 manifest with a KDM schema (`tools/check-manifest.mjs`); import, export, re-import round trips on the kit's fixture corpus, with content the schema does not model kept as opaque objects and written back (M24) |
| `KitAgent 1.4` | Kits; agent harnesses and MCP servers | Every agent-facing command has a valid `ParameterSchemaSpec` (`tools/check-sdk.mjs`); every exposed tool round-trips through the bridge and a headless kit; `check()` leaves the document unchanged (A21); every parameter that names a file is typed `file`, and a harness converts it, stops a call on a refused path, and lists and logs created files (A28–A30); `<prefix>_hit` routed like the other tools and `selection` given only to the person's own agent (A31–A33); links with their state in `<prefix>_inspect`, and an agent's file moves retargeted, logged, and listed (A42, A43); for the Agent-ready profile, see [below](#agent-ready-profile) |
| `KitFiles 1.1` | Kits, hosts, embeds, agent harnesses | See [KitFiles conformance](#kitfiles-11) below |
| `KitLinks 1.0` | Kits, hosts, embeds, agent harnesses | See [KitLinks conformance](#kitlinks-10) below |
| `KitPointer 1.0` | Kits (canvas and DOM editors), hosts | See [KitPointer conformance](#kitpointer-10) below |
| `KitEmbed 1.8` | Hosts (`@kition/embed`) | EM1–EM31, driven in Chromium and WebKit through the Kit UI protocol |
| `KitObjectModel 1.0` | Kits, hosts | OM rules over every transport the implementation offers |
| `KitCollab 1.3` | Kits, sync servers | The convergence suite for kits; the sync protocol's rules for servers |
| `KitExtensions 1.0` | Hosts | EX rules, with the example extension |
| `KitText 1.0` | Kits, hosts | `kition_kit::testing::check_text` on a fixture with known words; Kit Process Protocol check 15; `headless.capabilities` in `tools/check-manifest.mjs`; hosts read words in the T7 order ([`KitText 1.0`](sets/text.md) section 6) |

## `KitFiles 1.1`

[`KitFiles 1.1`](sets/files.md) is the first set whose rules bind kits,
hosts, embeds, and harnesses at once, so each role has its own test. None is
implemented yet; the tools named are where the tests go.

| Who | Test | Rules |
| --- | --- | --- |
| Kits, page | A flow test through `@kition/kit-dev-host` with a scripted picker and in-memory folders: pick a file and a folder, list the folder, create an export, write it in chunks, print; `checkNoPaths` fails the run if any `files/*` request carries a path-shaped string | FA-P2, FA6–FA11, UI-K2, UI-F3, E15, E16 |
| Kits, headless | `kition-kit-conformance` checks 5, 10, and 11 of the Kit Process Protocol (section 14): ungranted, foreign, and expired handles refused; `create` never replaces; staged writes commit atomically; `file`-typed parameters; optionally a sandboxed run with no file system and no network | FA1–FA5, FA9, FA12, A28 |
| Kits, manifest | `tools/check-manifest.mjs`: `files` declared when the capability is listed; `files.create` covers `exports`; every `file` parameter's `accept` is within the lists | K15, A28 |
| Hosts | In Chromium and WebKit: expired, released, revoked, and foreign handles refused; unused names chosen and nothing replaced by `create`; extensions outside K15 refused; a pick without a gesture refused; a stale `expected` answered `conflict`; a `write` refused on a file with unsaved edits; `host/write` refused for any path but the document's; `host/read`, `host/stamp`, and lent reads refuse hidden paths and the host's own store, the same way whether they exist or not; no path in any answer | FA1–FA17, H3, H5, LR2, UI-F1, UI-F2 |
| Embeds | EM21–EM24 with a fake storage: page `fileId`s never reach the kit; `create` and `write` go to the storage with the expected version; an agent port without `agentFiles` refuses `file` parameters | EM21–EM24 |
| Agent harnesses | `file` parameters converted to handles; a refused path stops the whole call with `not-allowed` and nothing runs; an agent `write` on another existing file goes to a draft or waits for approval; created files listed in the result and every grant in the session log | A28–A30, FA13 |

A conformance report for `KitFiles 1.1` names the role and the bindings it
covers (page, headless, embed, agent), since a host may serve one binding
only. Link grants (FA18) are tested with `KitLinks 1.0`.

## `KitLinks 1.0`

[`KitLinks 1.0`](sets/links.md) binds kits whose documents link other
files, the hosts that read, preview, and open those files and keep the link
index, embeds, and harnesses that move files. None of it is implemented
yet; the tests go where the set's section 13 says.

| Who | Test | Rules |
| --- | --- | --- |
| Kits, page | `checkLinks` in `@kition/kit-dev-host`, with a scripted workspace (names, a fake index, canned previews): the reported link set of a fixture, comments excluded; `links.retarget` of a file and of a folder changes only link spans and is idempotent, and Undo restores the bytes; against a host without `links`, `preview-files`, `open-file`, or `open-url` the kit degrades and sends nothing it was not offered; no path-shaped string in any request (`checkNoPaths`); `host/open` and `host/openUrl` only from a gesture | LK1–LK4, HC-P2, HC-P3, OP1, OP6, UI-K8, UI-N1 |
| Kits, headless | `kition-kit-conformance` check 13 of the Kit Process Protocol (section 14): `document.links` equals the page's `linksOf`; a `system` retarget saves atomically; link reads go only through handles | LK1, LK2, LK7, LR6 |
| Kits, manifest | `tools/check-manifest.mjs`: `links` declared when the capability is listed, `linksOf` in `extras`, `document.links` in `headless.features` | K18, E17 |
| Hosts | In Chromium and WebKit: link grants refused for the host's store, hidden paths, undeclared extensions, `..`, and unlinked targets, alike; the name resolution order; preview bounds (`too-large`, `timeout`, the queue), a new `version` and `links/targetChanged` after a save, and no kit code on the host page's origin; `view` reaching an opened kit, `create` making a new file only; web addresses other than `https:`, `http:`, `mailto:` refused, the confirmation shown, nothing but `opened` returned; rename and move with an open document that has unsaved edits, a closed document, a conflict, a read-only shared document, and Undo restoring every file byte for byte | LR1–LR5, PV1–PV7, OP1–OP9, LK7–LK13, H15–H17 |
| Hosts, picking a file to link | In Chromium and WebKit: `links/pick` offers only existing workspace files of `accept`, never hidden paths, the host's store, or the document; answers the document-relative path and copies nothing; `host/read` and `host/stamp` then serve that path (`../` included); a read-only document and a preview get no `links-pick` | UI-N2–UI-N4 |
| Embeds | EM25–EM27 with a fake storage: the callbacks drive `links/resolve`, `host/open`, `host/openUrl`, `host/preview`, `links/backlinks`, and `links/retarget`; each capability is absent without its callback; the mount option `shortcuts` reaches the kit and each `host/shortcut` comes back as the `shortcut` event | EM25–EM28 |
| Agent harnesses | `<prefix>_inspect` lists links with `exists`, `kit`, and `path`; an agent's move retargets, logs, and lists the changed files | A42, A43 |

## Stored replicas

A host that keeps documents' replicas beside their files serves them to the
page and to headless kits alike ([Kit Process Protocol](reference/kit-process-protocol.md)
section 5.5, H18). Neither side is implemented yet.

| Who | Test | Rules |
| --- | --- | --- |
| Kits, headless | `kition-kit-conformance` check 14 of the Kit Process Protocol (section 14), for a kit whose engine keeps a replica: the stored replica read on open and used when its `fileStamp` matches, or whatever it is when the kit's engine merges a newer file (one `import` change); otherwise a stale replica, and a damaged or missing one, opens the file plainly; the replica of the saved bytes written after `document.save` and `document.saveAs` under the committed version; a failing `replica.write` never fails the save; no `replica.*` request to a host that does not serve it | UI-R1, UI-R2 |
| Hosts | In Chromium and WebKit and headless: a comment thread added in the page is seen by a headless kit opening the same file, and one added headless is seen by the page, with the same `docId`; an agent's draft beside the file forks that replica and its merge keeps the `docId`; the replica follows a rename or move and a copy starts without one; `replica.read` and `replica.write` refused for any handle the host did not mint for the connection | H18, UI-R3, A27 |

## `KitPointer 1.0`

[`KitPointer 1.0`](sets/pointer.md) binds every kit whose editor shows the
document in a view a person points at, whether a canvas or DOM draws it
(PT13), and whether its tools run in the engine (U8b) or the editor (U10).
None of it is implemented yet; the tests go in `@kition/kit-dev-host`.

`checkPointerRoles(editor, fixture, script)` drives the kit's editor in
Chromium and WebKit with a scripted pointer and keyboard, against a fixture
whose object positions the kit's test states:

| Step | Checks | Rules |
| --- | --- | --- |
| 1 Roles | Every tool reports a role, `mutates`, and a hint; a run of every non-mutating tool leaves the revision, dirty state, and history unchanged | PT1, PT2 |
| 2 Behaviour | For each declared role, the gestures of section 4 (click, Shift+click, drag, double and triple click, `Escape`, `Delete`, arrows, `Tab`, `Cmd+A`, copy, right click) give the expected selection, in ids, text positions, cells, or time; `selection/changed` reports it | PT7, PT8, UI-S1 |
| 3 Undo | Each gesture is one undo step: one Undo restores the revision before it; `Escape` mid-gesture leaves none | PT4 |
| 4 Read-only | In a read-only session `select`, `text-select`, `hand`, and `zoom` work and `Cmd+C` copies; every mutating tool and every editing gesture is refused; `ai/selection` and `ai/hitTest` answer | PT2, UI-K7, UI-S2 |
| 5 Input methods | With a composition in Chromium and WebKit, the text lands at the caret and the kit's text input sits inside the reported caret rectangle (a DOM editor: inside the focused editable at the caret) | PT5, UI-K6, PT13 |
| 6 Commands | Each tool effect repeated through `ai/run` with its command and explicit params gives the same canonical state; the undo label is the command's title; `target: "selection"` is refused headless | PT6, PT10 |
| 7 Handles | Handle hit areas are at least 8 screen pixels at zoom 0.25, 1, and 4 | PT3 |
| 8 Selection relay | `ai/select` selects found ids and drops the rest, is refused while a gesture is busy, and moves the view only after two idle seconds | PT9, UI-S2 |
| 9 Hit testing (optional) | For a kit listing `hit-test`: `ai/hitTest` on a preview pixel inside a fixture object answers its id first, and agrees with `view.hitTest` headless (check 12 of the Kit Process Protocol suite) | A31 |

Hosts are tested in their e2e suites in Chromium and WebKit: the selection
reaches only the person's own agent, `ai/select` is never sent during a
busy gesture or into another person's session, and a dropped file arrives as
a `read` handle with no path (PT9, PT12, UI-S3, UI-S4, section 9 of the
set).

## Agent-ready profile

The Agent-ready profile ([`KitAgent 1.4`](sets/agent.md) section 10) is
claimed by a kit and by a host, at one of three stages: **Agent-ready core**,
**Agent-ready**, and **Agent-ready complete**. None is implemented yet.

| Stage | Kit rules | Host rules | Suite phases |
| --- | --- | --- | --- |
| Agent-ready core | A34, A35, A38 (not the default answer), A39, K16, E20 | H10–H13 | 1 (without the catalogue), 2 (without the network test), 3, 5, 6 (not the default answer), 7, 11 |
| Agent-ready | Core, plus A26, A36, A37, A38 (catalogue), A40 (overflow diagnostics), A41, K17 (`agent/checks.json`) | Core, plus A36's converted schemas and A41's writes through grants | All of 1–11; phase 8 for the overflow in `check` |
| Agent-ready complete | Agent-ready, plus A40 (layout answer), K17 (`agent/guide.md`), A44, a sandboxed run (H14) | Agent-ready, plus H14 | All, with phase 8 in full and phase 2 sandboxed |

Kition's release tiers require these stages as
[kits/levels.md](kits/levels.md#agent-ready-stages-and-kitions-release-tiers)
says.

### The Agent-ready suite

One command per kit, run on a developer machine in the kit's repository and
over the host's shipped bundle in the host's release checks:

```text
khp-agent-conformance --package <kit package folder> --executable <kit executable> \
  --fixtures <folder> [--layout] [--expected <folder>] [--platform <target triple>]
```

Each kit keeps its fixtures in a `conformance/` folder of its repository:
`basic.<ext>` (opens, edits, saves), one `check-<code>.<ext>` per catalogue
code (A38), `overflow.<ext>` for a layout kit (A40), `links-outside.<ext>`
for a kit that declares `agent.links` (KHP K21, A42), `expected/` previews,
and `edit.json` (a command and params that change the document).

| Phase | Checks | Passes when |
| --- | --- | --- |
| 1 Package | The manifest is valid (K1–K18, `tools/check-manifest.mjs`); `agent/checks.json` is present and every catalogue fixture exists | All present |
| 2 Launch | The Kit Process Protocol suite (section 14 there, checks 1–10); `kit.initialize` answers the manifest's `kit.version`; the executable starts and answers within the protocol's limits; with the network denied the suite still passes (A37) | Checks 1–10, the version, and the network |
| 3 Tools | Through the host's kits MCP server over stdio: `tools/list` has every A35 tool for the kit; `--list-kits` lists it (H12); the `--schemas` output validates | All listed |
| 4 Schemas | Every exposed command's schema is a valid `ParameterSchemaSpec`; the coverage report counts 100% of `agent.include`; each command called with `{}` answers a typed error or a result and leaves the file unchanged (A36) | No failures |
| 5 Act | `run` of `edit.json` changes the revision, and a save and reopen keep it; `batch` round-trips one object edit (`kdm` kits); an unknown command and bad params answer A18 errors, and no call waits on a dialog or prompt (E20); at Agent-ready complete, `edit.json` addresses its object by a name or path and an ambiguous or unknown name answers an error that lists the candidates (A44) | Matches |
| 6 Verify | `check` on `basic` answers no errors and leaves the revision, dirty state, and history unchanged (A21); each `check-<code>` fixture yields its code; the answer is not the SDK's default (A38) | All codes triggered |
| 7 Preview | `inspect { preview }` and `view.screenshot` of `basic`: not uniform, framed to the content, `target` and `scale: 2` honoured, equal to `expected/` within a tolerance the kit states; substituted fonts reported (A39) | Within tolerance |
| 8 Layout | `inspect { layout }` on `overflow` reports the overflowing object with `by` greater than 0, and the same object appears in `check` (A40) | Reported in both |
| 9 Create and export | `create` for every `creates` entry and `export` for every `exports` entry write new files only: an existing file at the target is kept and the result names the unused name the host chose (A41, FA7); the outputs reopen in an independent reader (PDF: pdfium or poppler; images: a decoder; xlsx: an independent reader; MP4: a demuxer) | All reopen |
| 10 Determinism | `edit.json` run in the page engine (`@kition/kit-dev-host` in Node or a browser) and headless gives the same canonical state (A26) | Equal |
| 11 Release (host) | For each platform artifact of the host: one executable per kit it ships, its SHA-256 equal to the pin and signed (H10, H11), and phase 2 passing on that platform | All kits, all platforms |

A conformance report for the profile names the stage, the kit or host and
its version, each platform tested, and the result of every phase.

Kits are also rated by the levels L1–L6 in [kits/levels.md](kits/levels.md),
which `tools/check-manifest.mjs` reports.

## `khp check` on a Kition kit

The separately supplied KHP conformance tool, `khp check`, talks to a kit's MCP server over stdio. A
Kition kit's MCP server is `kition-kits-mcp` serving the kit's headless
executable, so the start command names both, and the workspace through the
placeholder `{workspace}`, which `khp check` replaces with the fresh copy of
the kit's `conformance/` folder it makes for every phase; a start command
without `{workspace}` is a usage error:

```sh
khp check --kit "<sdk>/target/debug/kition-kits-mcp --workspace {workspace} --kit <kit>/target/debug/kition-<kit>" \
  --package <kit> [--level basic|agent-ready|agent-ready-complete] \
  [--env NAME=VALUE]... [--no-probes] [--sandbox [--allow-read <folder>]...] [--json] [--report <file>]
```

`<sdk>` and `<kit>` are absolute paths to the kition-sdk checkout and the
kit's repository: the server starts in an empty folder of `khp check`'s
own, so a relative path in the start command resolves nowhere (`khp check`
makes only a relative executable absolute). `--package` is the folder of
the kit's `kit.json`; `khp check` reads `agent/checks.json` and the fixtures
in `conformance/` beside it.

- **Environment.** The server gets `PATH` and nothing else of the caller's
  environment: `HOME`, `USERPROFILE`, the `XDG_*` folders, `APPDATA` and
  `LOCALAPPDATA` name empty folders of `khp check`'s own. A setting the kit
  legitimately takes, such as `KITION_FONTS_DIR`, is passed with
  `--env NAME=VALUE` (repeat it); `--env` cannot set the folder variables.
- **Private runtime folder** (KHP A58). `TMPDIR`, `TEMP`, `TMP`,
  `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME` all name one folder, the server's
  private runtime folder. `kition-kits-mcp` and the kit host it drives make
  their sockets and each kit launch's private folder (Kit Process Protocol
  section 3) in `TMPDIR`, so they stay inside it, and remove them, and the
  `kition-kits` folder that holds the private folders, when the kits stop;
  what is left there after the server stops is a note, not a failure.
- **Containment** (phase 11, every tier). Anything written, deleted, or
  changed outside the workspace and the private runtime folder, and the
  content of a canary outside the workspace in any answer or file, fails
  the kit (KHP spec/agent.md section 10.6; KHP A29, A58).
- **Links** (KHP K21, A42). A kit whose manifest says `agent.links: true`
  ships `conformance/links-outside.<ext>`, a document that links
  `../outside-canary.bin` (and, when its documents can link a remote target,
  `http://outside-canary.invalid/outside-canary.bin`); phase 11 fails such a
  kit without it, or when its `<prefix>_inspect` of it answers no link to
  the canary, or answers one with `exists` other than `false`, with a `path`
  or `kit`, or differently when the canary is absent. A kit that does not
  declare `agent.links` fails when its inspect of `basic.<ext>` answers any
  link. `tools/check-manifest.mjs` checks the field and the fixture's
  presence before `khp check` runs.
- **Probes** (phase 12, every tier). Every free string parameter of every
  listed command is given a path outside the workspace; `--no-probes` skips
  the phase, for a quick run only.
- **Sandbox** (Agent-ready complete, macOS). `--sandbox` lets the server
  read only the workspace, its package, the private runtime folder, its
  executable and the system's folders. `kition-kits-mcp` and the kit's
  executable live outside the kit's package, so name their folders with
  `--allow-read` (the kition-sdk build's `target/debug` and the kit's), and
  any other folder the install spans. Leave `kition-kits-mcp`'s own
  `--sandbox` out of such a start command on macOS: `sandbox-exec` cannot
  apply a profile inside another sandbox.

Exit status 0 means every phase of the tier passed; 1 a phase failed; 2 a
usage error or a server that did not start.

## Tools

| Tool | Checks |
| --- | --- |
| `node tools/check-manifest.mjs <kit.json> [--module <dir>] [--convergence <report.json>]` | The manifest against `schemas/kit.schema.json` and rules K1–K14 (K15 to K18 to come), and KHP K21 (`agent.links` a boolean; when `true`, `conformance/links-outside.<ext>` beside `kit.json`); reports the kit levels it supports |
| `node tools/check-sdk.mjs --dir <dir> --module <module> --class <Class> ...` | A built engine against the engine contract from JavaScript (E1–E4), and its command schemas (A5) |

## Conformance report

A conformance report states the edition, each set and version claimed, the
Agent-ready stage claimed, if any, the kit, host, server, or harness and its version, the DeepSeek Harness version
targeted when it claims D1 or D2 (D4), and the test results.
