# Engine contract

What a kit's engine guarantees to the host that runs it. Member-by-member detail is in [the contract reference](../reference/contract.md).

## Engine contract

The engine contract is specified member by member in
[contract.md](../reference/contract.md); this section states its obligations.

- **E1** A kit engine MUST implement `kition_kit::KitDocument` and export it
  with `export_kit_document!`. The exported JavaScript class MUST have
  exactly the members in contract.md plus the declared `extras`.
- **E2** Bad input MUST be an error, never a panic or abort: a panic kills
  the worker and loses the person's work.
  Damaged files count: a file cut short, flipped bytes, an absurd declared length, a broken zip,
  SQLite or JSON container, nesting far deeper than any real file. Opening one MUST answer an
  error (or open what it can) promptly, without panicking or looping.
  `kition_kit::testing::check_malformed` opens such variants of a kit's conformance samples, each
  on its own thread with a time budget, and inspects and renders whatever opens.
  A command that does not run says why with a typed reason:
  `Err(kition_kit::failure::failure(CommandFailure::Disabled, "nothing is selected"))`
  (`NotFound`, `Disabled`, `InvalidParams`). The host answers that reason's error code
  (`command_disabled`) and shows the message alone; only a message without a reason is read by
  its wording, which is a guess.
- **E3** When the area is a whole multiple k of the output size, `renderArea`
  MUST agree with a whole render at that reduction, anti-aliasing aside: the
  pixels of a part MUST be those of the same part of a larger area on the same
  k grid. Hosts patch cached frames and fill the strip a pan uncovers with it,
  so a part must not show a seam. Averaging the 1:1 pixels (the k × k box
  mean) agrees, and so does drawing at 1/k directly. Engines that render whole
  frames SHOULD use `kition_kit::raster`. Above 1:1, a raster engine (pixels)
  repeats pixels exactly, while a resolution-independent engine (vectors,
  text, pages) renders at the requested scale so zoomed views stay sharp;
  below 1:1 a raster engine averages its pixels exactly, and a
  resolution-independent one may draw at the reduced scale.
- **E4** `save` MUST NOT mark the document saved; `markSaved` does, after
  the host wrote the bytes. `save` changes nothing in the document. A kit whose
  file holds its KDM document writes `content_snapshot()` there (data model
  7.3), which depends on the state alone: a document saved again unchanged is
  the same bytes.
- **E5** Files a document refers to (media, linked images, fonts) MUST be
  read only through `kition_kit::host` (lent files), in ranges for large
  files. An engine MUST NOT read the filesystem or network directly.
- **E6** Every command MUST have a stable id, a title, a menu path or none,
  a shortcut or none, `mutates`, and `enabled`. Commands MUST include
  `edit.undo` and `edit.redo`. An engine SHOULD answer `disabledCommands()`
  (the ids that cannot run now) without building the full command list,
  because hosts ask after every change.
- **E7** Every command that is agent-facing ([`KitAgent 1.4`](../sets/agent.md)) MUST carry a
  machine-readable parameter schema in the DeepSeek Harness
  `ParameterSchemaSpec` form ([`KitAgent 1.4`](../sets/agent.md) A5). Free-text parameter descriptions
  MAY remain for people.
- **E7b** A parameter that names a file, a folder, or a URL the engine reads or
  writes MUST be typed `file` ([`KitAgent 1.4`](../sets/agent.md) A28), never a
  plain string, or the command is not offered to agents. A plain string whose
  name or description reads like one (`destination`, `outputDir`, `image: "the
  file path"`) but carries none (a property path inside the document, HTML
  source, a cell reference) says so with `"notFile": true` in its schema, the
  record that someone reviewed it; hosts leave the keyword out of the JSON
  Schema they publish. `kition_kit::testing::check_file_parameters` fails on
  every unreviewed one among the commands an agent is offered. It reads names
  and descriptions, not values: a generic setter that stores a folder under a
  key (`prefs.set { key, value }`) is the kit's own to refuse.
- **E7a** A command with a parameter schema MUST refuse a top-level key its schema does not
  name, before it changes anything, instead of running without it: a misspelled key (`objects`
  for `object`) would otherwise do something else without a word. The error is `invalid-params`
  (A18) and names the key, the declared key it most resembles when one is close, and the keys
  the command takes. The schema therefore names every key the command reads. A command whose
  top level takes keys a schema cannot name (a map keyed by the document's own names) says so
  (`KitCommand::open_params`, published as `additionalProperties: true` in its JSON Schema; the
  reason in its description), or is listed in its kit's tests with the reason.
  `kition-headless` refuses such a key itself for every command with a schema whose top level
  is not open, with `kition_kit::schema::refuse_unknown`'s words, before the kit sees the call;
  a kit that also calls `refuse_unknown` at dispatch answers the same. Nested objects follow
  their own `additionalProperties`. `kition_kit::testing::check_unknown_params` checks every
  command with a schema; kit requirement AX15.
- **E8** Engines with long work (exports, analysis) MUST offer a stepped form
  that advances within a time budget and reports progress, because
  WebAssembly in a worker has no threads.
- **E9** An engine whose web build embeds no face for some scripts (a CJK
  face is too large to compile in) MAY export a module function
  `addFont(bytes) -> number` that adds a font file's faces and answers how
  many it added. An embedded editor gives it the fonts it ships, so text in
  those scripts lays out and draws with real glyphs: the faces the first frame
  needs (the primary face) before any document opens (kit-editor's engine
  manifest `fonts`), in order, and the rest (kit-editor's `lazyFonts`) after
  the document opened, in order, so a large CJK or emoji face does not hold
  up the first frame. An engine given faces late MUST lay out with each new
  face from its next call on (no layout it cached with the faces it had
  before may answer again), so text it drew as missing glyphs draws with real
  ones once the page asks again.
- **E9a** Such an engine MAY also export `wantsFonts() -> boolean`: whether
  text it laid out since the last call needed a character none of its faces
  has (it drew a missing-glyph box, or a fallback, for it). The call clears
  what it answers. The editor asks after each request while lazy fonts are
  left and gives them all once it answers `true`; an engine without it is
  given them right after the document opens. A document that only ever needs
  the primary face so never loads the rest. After each face the editor tells
  the page (`KitEngine.onFonts`), which draws again: kit-editor's `KitCanvas`
  renders the whole view, and an editor that draws the engine's output
  itself asks for it again. Both are optional in contract 1.
- **E10** A document MAY pin bands that stay in view while the rest
  scrolls: the getters `pinnedLeft` and `pinnedTop` (document pixels, 0 when
  absent) name the columns left of and the rows above which stay put, as a
  sheet's headings and frozen panes do. A host shows the pinned bands at the
  view's top-left and the rest scrolled under them, and maps pointer
  positions the same way.
- **E15** *(KitFiles 1.0; not yet implemented)* *Granted inputs.* An engine
  reads a file the host granted ([`KitFiles 1.1`](../sets/files.md)) exactly
  as it reads a lent file (E5): `kition_kit::host::read_range(handle,
  offset, len)` and `size(handle)`, with the handle string (`fh_…`) in place
  of a path. The binding serves those reads from the same synchronous ranged
  path as lent files: in a page, a handle-scoped URL the host serves (or
  bytes the binding read ahead with `files/read`); headless, `storage.read`
  on the host connection. A command names such a file by a `file`-typed
  parameter ([`KitAgent 1.4`](../sets/agent.md) A28), whose value the engine
  passes back to `host` unchanged; it never sees a path.
- **E16** *(KitFiles 1.0; not yet implemented)* *Outputs.* An engine never
  writes files. A command that produces files answers `{ outputs: [{ id,
  suggestedName, mime }] }` and keeps their bytes; the binding takes each
  with the engine member `takeOutput(id) -> bytes` (in chunks for stepped
  exports, E8, until it answers an empty chunk) and writes it to the handle
  the command's params named, or to a handle it creates with `files/create`
  ([`KitFiles 1.1`](../sets/files.md) FA7, FA9). An engine MUST NOT keep an
  output after it was taken, and drops outputs nobody took when the document
  closes.
- **E17** *(KitLinks 1.0; not yet implemented)* *Links.* An engine whose
  documents link other files exports the extra `linksOf() -> JSON`: every
  outgoing link of the current state, in document order, in the shape of
  [`KitLinks 1.0`](../sets/links.md) section 2, links inside comments
  excluded (LK1). It is cheap enough to call after every change and never
  reads a target.
- **E18** *(KitLinks 1.0; not yet implemented)* *Retarget.* Such an engine
  offers the command `link.retarget { from, to }` with a parameter schema
  (E7): it rewrites only the target text of the links that resolve to
  `from`, keeps their syntax, is idempotent, and is one transaction (LK2,
  LK3). `kition_kit::testing::check_contract` runs it twice and checks the
  second run changes nothing.
- **E19** *(KitLinks 1.0; not yet implemented)* *Areas.* An engine MAY
  export the extra `areaOf(viewJson) -> [x0, y0, x1, y1] | null`: the area
  of its document that a link's `view` (or an agent's `target`, A24) names,
  in document units, or `null` when it cannot find it. Hosts use it to draw
  previews of part of a document (PV2); without it, a preview of a `view`
  is refused as `unsupported-view`.
- **E20** *(proposed)* *No prompts.* A command called by a program
  (`command.execute` headless, an agent's `<prefix>_run`, `call` from a
  host or script) MUST run to an answer without waiting for a person: it
  never opens a dialog, picker, confirmation, or alert, in the engine or
  through its binding. Input it lacks or must not guess is an error with a
  structured reason (`invalid-params`, A18), and a choice it needs is a
  parameter. Only the kit's editor asks a person, in its own UI, before it
  runs the command.
- **E21** *Commands that run commands.* A command that runs other commands
  (a list of steps, a macro, a script, a command line, a repeat of the last
  command) MUST ask `kition_kit::dispatch::may_run(command, params)` before
  each step it dispatches and fail the call, before the step runs, when it
  answers an error. A host that serves the kit (`kition-headless`) checks
  every command a caller runs, from `command.execute` and from each
  `command` operation of `model.batch` alike: it exists, the caller may run it
  (no parameter naming a file the kit did not declare safe, nothing the
  manifest keeps from the agent with `agent.include` or `agent.exclude`), and
  its parameters fit its schema ([`KitAgent 1.4`](../sets/agent.md) A28, A29,
  section 10.6). While the engine runs, `may_run` answers that same check for
  the caller (`kition_kit::dispatch::role()` says whom: the person, the agent,
  or the host's `system`), so a step the agent may not run fails the agent's
  macro as it fails the agent's own call. Without a host (the page, a kit's
  own tests) it allows everything. `kition_kit::testing::check_nested_dispatch_is_gated`
  finds a kit's dispatchers by their schema and checks each asks; a kit gives
  the step form of one it cannot find and says why a command it took for one
  runs no commands.
- **E22** *Hosted: the host owns every file.* A host that serves a kit
  outside the page (`kition-headless`, for every kit) says so before the
  engine opens anything: `kition_kit::host::hosting().files_only` is true,
  and `KitDocument::hosted(&Hosting { files_only: true })` is called once on
  every document right after it is opened or created (a provided method that
  does nothing by default). While it is set an engine MUST:
  - read and write no file by path, list, stat or delete none, and make no
    folder: a file the document refers to is read through `kition_kit::host`
    (E5, E15), a file a command makes is an output (E16), and a setting that
    names a folder (a cache, an auto-save, a template or recovery folder, a
    plug-in or script folder) is refused or kept in memory;
  - write no auto-save, recovery, log or cache file anywhere, the current
    folder, `HOME` and the temporary folder included;
  - start no process (a printer list, speech, a system report) and open no
    network connection (KHP A37);
  - scan no system font folder: it uses the fonts it ships or the host gives;
  - resolve no path a document carries (a linked image, an SVG `href`, a
    linked smart object) except through `kition_kit::host`.

  The same holds for every way a command runs, its own macros and scripts
  included (E21). `kition_headless::agent_ready::workspace_only` launches the
  kit as a host does and fails on any file it leaves in its private folder
  ([host contract](host.md) H14a). In the page's worker it is not set.


## Engine contract 2


A kit declares `"engine": { "contract": 2 }` and the capability `kdm`. Its
engine keeps a materialised view of its KDM document and

- **E11** loads the view from a replica and patches it from the changed
  objects an import reports, rather than rebuilding it;
- **E12** turns commands into transactions and never mutates its view
  directly; a bridge MAY change its own view first and record the
  difference as the command's transaction (`KitSession::record`), as long as
  undo, redo, and imports still patch the view from the replica;
- **E13** imports files into a new document with `create_with` and exports
  files from the KDM state;
- **E14** keeps the document within the kit's rules with `KitModel::validate`:
  after an import, an undo or a redo, the session runs it over the objects that
  changed, in a `system` transaction labelled `repair` that is no undo step;
  after a draft's merge or a restore, inside that change (data model 6.6, D9).
  It gives the same writes for the same state (dropping a list entry of a
  deleted object, say) and reads through its `Tx` what a `Replica` reads,
  the transaction's own writes included: registers, `text` and `text_delta`
  (marks), `list_items`, `map_get`, `map_entries`, `tree`, `objects_of_type`,
  `exists`, `object_type`. A file changed outside reaches the replica as one
  `write_state` change;
- **E14a** runs `edit.undo` and `edit.redo` in an undo scope ([`KitModel 1.1`](../sets/model.md)
  M12a): the one their optional `scope` parameter names (`"person"` or `"agent"`), else
  the scope of the origin they run as (`executeAs` as `agent`: the agent's). `undo()`,
  `redo()`, `canUndo()`, `canRedo()`, and `inspect()`'s `canUndo` and `canRedo` are the
  person's. `kition_kit::session::history_scope(params, origin)` reads the scope and
  `KitSessionDocument::undo_in` and `redo_in` run it (a kit that keeps its own state
  current in `undo` and `redo` overrides them too).

Contract 1 members stay available, so 1.1 hosts keep working. The engine's
class adds the session members: `version()`, `exportChanges(since)`,
`importChanges(bytes)`, `snapshot()`, `undo()`, `redo()`, `canUndo()`,
`canRedo()`, `executeAs(command, params, origin)`, and the static
`openWithReplica(name, bytes, snapshot, blobs)`; kits whose documents carry
media add `blobs()`, `addBlobs(bytes)`, and `blobsSince(since)`. The object
model is `modelDescribe()` and `modelBatch(request)` (JSON text in and out).
A draft's changes are compared with the document by `compareChanges(changes)`
(the `StateDiff` merging them would make, the kit's repair included as the merge
runs it, `KitSession::compare_changes`: the preview is what accepting gives;
nothing changes) and taken in by
`mergeChanges(changes, origin)` (one person undo step; answers
`{ damage, summary, scope }`; refuses, with the KDM's message, a draft that
collides with the document's changes since it was made). A merged draft is a
step of the person who accepts it even when an agent made it: `@kition/kit-editor`
passes the draft's agent origin (`["agent", principal, label]`, Kit UI protocol
`draft/merge`), and the merge still goes to the person's history (M12a). `scope`
says where it went (`"person"`, or `null` when nothing was recorded: also when the kit's repair
takes back everything the draft did, a merge that changes nothing, logs no change and leaves the
version; its `damage` is none and its summary empty), as
`Replica::merge_changes` (`DraftMerge::scope`) and `KitSession::merge_changes`
answer it: an engine that keeps an undo history of its own records the step in
that scope, never in the scope of the origin's kind, and only when `scope` is not `null`. Writes the
engine computes from its own view after the merge join the merge's step through
`KitSession::execute_in_step` / `record_in_step` / `merge_changes_with` (`Replica::transact_in_step`),
so the step's one Undo takes back both (data model 6.6, D9). The kit's repair of a merged
or restored state is part of that one change and undo step (data model 6.6,
D9): one Undo gives back the exact state before, one Redo the exact repaired
state. An engine that keeps an undo label of its own per step keeps as many as
`KitSession::undo_depth(scope)` (`Replica::undo_depth`) answers after each
command, batch, merge, undo and redo: a `model/batch` is one step, the commands
in it included (`in_undo_group()` is true while it runs). `restoreState(snapshot, origin)` writes
a checkpoint's state over the document as one change (Kit UI protocol
`replica/restore`), and `changesSince(since)` answers a write's receipt,
`{ changes }`, or `{ changes: null, unavailable }` when the replica's log does
not hold `since`; `modelReply(value)` names the objects of an agent's reply by
their tool ids where it refers to them (a minted id anywhere, an id the kit
chose only under a member that holds references; [call context](call-context.md),
"Exact known references"). `origin` is the KDM commit form `[kind, principal, label]`.
A module without any of these fails manifest rule K3a
([manifest](manifest.md)).
An engine SHOULD add `schemaVersion()` (the schema version its replica reads) and
`authorSchemaVersion()` (the newest one its changes were written under, or
`null`; rule M5a). `export_kit_session!` provides every one of these:
an editor reads them when a document opens and after imports, and tells its
host of a newer one (Kit UI protocol `document/schema`, section 7f).
`contractVersion()` answers 1 or 2: an engine built for contract 1 hosts
answers 1 and is recognised as contract 2 by its manifest and its session
members.

The reference implementation is `kition_kit::session` (`KitModel`,
`KitSession`, `export_kit_session!`; feature `session`); a kit whose engine
keeps its own session type exports the same members by hand. A TypeScript
engine (`engine.runtime` `ts-worker`) implements contract 1. The KDM writes only in
Rust: `@kition/kdm` reads replicas. Word, Slide,
Sheet, Photo, Vector, Motion, CAD, PDF, and Film implement contract 2, and
Kition and `@kition/embed` host them through the Kit UI protocol's `replica`
capability. Table, a default kit Kition hosts itself, exchanges changes
through `version`, `exportChanges`, `importChanges`, and `blobs`, and runs
the rest through its `call` method.


## Performance rules

These rules bound the work performed by kit engines.

- **P1** A collection that can grow past about 10,000 entries MUST be stored
  as objects (one object per record, row, or entity), not as plain values in
  one `map` field. Import cost into a map of plain values grows with the
  map's size.
- **P2** Bulk content (file import, generated documents) MUST be written when
  the document is created (`Replica::create_with`), outside undo history.
  Undo bookkeeping grows faster than linearly with a transaction's size.
- **P3** An interactive transaction SHOULD touch at most about 10,000
  objects. Larger edits split into several transactions or run as an import.
  A larger transaction that only writes register fields and keys of map
  fields of existing objects (a table's column cleared, pasted, or filled)
  is the exception: it costs no more to undo than it wrote. Undo and redo
  take back a step's inverse operations, carried over the changes in the log
  since the step that wrote the same text or list field, and cost about what
  the step wrote plus those changes, never the document's whole history ([undo across remote edits](../undo-across-remote-edits.md)).
  The undo of a group also reads what the group wrote, before and after, to
  pass over a group whose changes came to nothing ([`KitModel`](../sets/model.md) M12).
- **P4** Bulk work MUST run inside the engine's WebAssembly module. Driving
  the KDM object by object across the JavaScript boundary is several times
  slower than the same work inside the module. Every Rust kit runs the KDM
  inside its WebAssembly engine (`kition-kit`'s `session`, over `kition-kdm`
  built for `wasm32-unknown-unknown`).
- **P5** A save writes the document's content; the host stores one snapshot
  per replica write, replaced atomically (Kit UI protocol section 7).
  Loading and saving cost about the content: `Replica::load` reads the bytes
  straight into the store, and `content_snapshot` and `snapshot` write the
  store into one buffer. A map entry holding a short string, a number or an
  id costs 48 bytes, a small object about 200, and a fork shares every object
  until one side writes it. Kition Table's 100,000 records of 50 cells load
  in about a second into about the content's size (330 MB for 330 MB of
  content; `crates/kition-kdm/tests/large_documents.rs`).

## Command schemas from kit command notation

- **A6a** Schemas MAY be written by hand or converted from kit command notation
  with `kition_kit::schema::from_kit_params` (`KitCommand::with_kit_schema`).
  By default converted schemas mark no property required, because many
  notations do not say reliably what an engine requires (a key without `?`
  that the engine fills from the selection or a default), and a wrongly
  required property makes a harness reject valid calls. What the converter
  cannot type becomes `json` with the original notation as its description.

  What the notation can say: a key is optional with `?` after the key
  (`name?: str`, `"name"?: str`) or after its type (`"name":str?`); it has a
  default with `=value` (`"opacity":0..100=100`) or a literal written as its
  type (`convert?: true`, `steps: 1`); `(notes)` after it are for people and
  often state a condition (`"rect":[x,y,w,h] (rect only)`); keys joined by `|`
  (`"time":ticks|"frame":i64`) are alternatives, and objects joined by `|`
  (`{…}|{…}`) are alternative forms. It cannot say that one of several keys
  is needed, that a key is needed only with another, or that a default comes
  from the editor (the selection, the current layer).

  The converter lists, as `Conversion::required`, the top-level keys it types
  precisely that have no `?`, no default and no notes and are neither
  alternatives nor part of one of several forms. A kit publishes them as
  required only when it opts in: `KitCommand::notation_required` (default
  off) on each command it has proved, or on every command it lists. Prove a
  command with `kition_kit::testing::check_required(fresh, calls, checked)`:
  with a call that gives exactly its required parameters on a fixture, the
  call must run (else a parameter the notation marks optional is needed:
  too loose), and the call without each required parameter must fail in the
  engine (else that parameter is not needed: too strict). For an opted-in
  command a host's gate (kition-headless) refuses a call that leaves out a
  required parameter with `invalid-params` before the engine runs, one error
  per parameter, each naming it, what it takes and where a value comes from
  (an id the kit's inspect lists, or that the command has no default; A48).
  `cargo run -p kition-kit --example schema-report -- commands.json` reports a
  kit's coverage.

  An entry with no key the notation reads (`id?/ids?` where `id?, ids?` was
  meant; `deviceFrame? bool` for `deviceFrame?: bool`; `"frame"? | "dx"?`)
  gives the converted schema no parameter, so a host refuses a call that
  passes it as unknown. The converter lists such entries, as written, in
  `Conversion::unreadable`; `kition_kit::testing::check_commands` names each
  as a problem of its command (for a command whose schema is the notation's),
  and `schema-report` lists them and exits non-zero.
