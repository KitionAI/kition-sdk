# Adopting call context in a kit

## Public Receipt Facts

Declare facts used only for guarding writes with `premiseOnly: true`. The SDK
keeps their comparisons in its private journal and omits them from receipt
`fields` and `edits`, including objects whose only differences are private facts.
Public derived facts appear only when their before and after values prove a
change. An unavailable before value does not prove a change; it remains private
guard evidence. A successful derived read becomes the baseline for later writes.
Unchanged derived facts never appear as edits. These rules also apply to `others`
and to requests for all changes. Consumers must not rely on private or unproven
facts appearing in public receipts.

## Document Replacement

A command may replace its replica with a new document. The Rust `Exchange`
detects the different document identity (or a change list that does not follow
its version, `stale`) and loads the engine's full export under a fresh actor,
discarding the old scratch replica. Changes from different documents are never
applied to each other. A replacement must
provide a complete export valid for the declared schema; malformed exports and
other import errors still fail with their reason.

Isolated premise plans follow replacement documents too. They compare the
original model with the replacement model instead of requesting history from
the old document's version. The live document remains untouched by planning.
A completed replacement can return `changesUnavailable` when its receipt cannot
compare the old replica's history with the new one; this is distinct from an
empty change set.

## Null Content Regions

`ContentPremise.region` is kit-defined JSON. An explicit `region: null` reaches
`content_at` as JSON null, as does an explicit null `before` value. The transport
preserves these members; an absent required region remains invalid. Kits may
use null to name a region, and consumers must distinguish a present null from
an absent member.

## Selection And List Holds

Declare a fallback selection parameter as `targets`. When it is explicitly
provided, the SDK suppresses that command's declared selection read. Marking a
parameter as `objects` only declares a reference; it does not replace selection.
For commands with conditional target parameters, make their declarations match
the branch actually consumed. The SDK cannot infer that an arbitrary object
parameter makes a separately declared selection read unnecessary.

For list insertion, declare the insertion gap and only the existing objects,
fields and positions the operation depends on. A distant append outside that
gap remains independent. If `under` explicitly holds a newly appended object,
the guard refuses it as `relocated` because it did not exist at the caller's
basis. Enumerating every current sibling as an unconditional premise therefore
prevents that rebase. Fix the kit's declaration when those dependencies are not
consumed; the SDK continues to enforce explicitly declared holds.

## Terminal Close

A command that closes its document returns `{closed:true}` only after a
successful close. This result terminates the run. The SDK releases the session
and returns `closed:true`, `saved:false`, and the completed steps without a
`document` view. It does not restore editor state, save, inspect, collect a
post-close receipt, or render a preview. `notRun` counts any remaining steps.
Close should be the last step. A refused close returns `{closed:false}` or a
normal command error and keeps the session open. Declare force-close commands
without content premises when they discard changes, so outside edits do not
block closing. The SDK never saves those discarded edits over the file.

`KitManager::execute` now returns `ExecuteView.document: Option<DocumentView>`:
`None` means the command returned a successful terminal close. Service clients
must accept the corresponding omitted `document` member. The TypeScript
worker uses the same terminal-result contract and clears its open engine.

## Typed Owning Maps

Declare a typed owning map as `{kind:"map",owns:true,of:"Cell"}`. Each entry
must be a nonempty object ID of the declared type. `map.set` resolves public
tool IDs and batch references before checking the type and rejects missing
objects. Direct engine transactions permit dangling references, as ref fields
do, but reject an existing object of the wrong type. Untyped owning maps still
accept their existing nested values. Loads and receipts translate the owned
references through the usual tool-ID and ownership rules.

## Omitted Receipt Values

Receipt edits always name `field`; `before` and `after` are optional when the
value is unavailable or omitted, including large derived values. Omission is
not JSON `null`. Kits should leave unknown values out and consumers must check
for a member's presence before using it as historical evidence.

## Literal Paths

Use a JSON Pointer for a literal premise path: `/data/flag[id=7]` holds the
map member `flag[id=7]`, rather than a selector. Pointer segments use `~1`
for `/` and `~0` for `~`; brackets and equals signs are literal. The same form
is accepted when the server reads JSON content paths. Use ordinary selector
paths when matching a list member by value. A raw `map.set` still takes its
literal map key in `key`.

## JSON Resource Identity

For a JSON list resource, declare its immutable member in the premise's
`identities` map. A stable address such as `data.members[key=a].value` uses
`identities:{"data.members[key=a].value":"key"}`; removing it refuses `deleted`.
A name address can use the same stable key: renaming or reassigning that name
refuses `relocated`, while unrelated list edits and index shifts still apply.

For an index address, declare `identities:{"data.members.0.value":"key"}`.
The server replays each writer's transition and checks the occupant at that
index. Delete, swap and insert operations that change it refuse `relocated`,
even when the replacement has the same value. Edits to the same occupant's
held value refuse `changed`. Missing, duplicate or unprovable keys refuse
`unknown`. Keep keys stable across saves; a mutable name is not an identity.
Outside object pairing that proves a tool ID was renamed also reports
`relocated`, with its current ID in `now.id`.

## Session Continuity On Reread

A clean file reread restores the live session's `editor_state` on the fresh
document before replacing anything. `restore_editor_state` must validate every
active target, selection, part and mode against that document and refuse an
unresolved identity with a specific reason, such as `deleted active target`.
The host reports `file-conflict` and keeps the previous session on failure.
Never silently choose a default target when restoring saved state.

Implement `KitDocument::reconcile_reread(&mut self, fresh: &Self)` to keep
undo history. Resolve imported identities, apply only the file difference to
the existing session, retain its editor state and blobs, then return `true`.
`KitSession::reread` applies that difference
in one atomic import transaction, outside both undo histories. The callback
writes only values that actually changed; rewriting unchanged values would
make them outside writes and prevent undo from restoring them. An unsupported
hook returns `false` without mutation; a failed hook must also leave the live
session intact. A clean session with retained history then refuses reread
instead of dropping it. The host marks a successful reconciliation saved.
An explicit reload that discards unsaved edits retains its discard semantics.

## Conditional Recipients

Parameter-dependent targets need no additional SDK API. In `under`, declare
only the target actually consumed by this parameter branch: for example, hold
`params.id` when `params.kind == "shape"` and the chart otherwise. A parameter
that names an object only in some branches should not have an unconditional
`objects` declaration. Return precise `premises` for the chosen objects.

For a subset join or reuse by content, return the currently matching recipients
in `Under.objects`, narrow their `premises`, and declare `covers.fields` for
every predicate input. In `covered_at`, start with current candidates, overlay
all `CoveredAsk.before` values together, restore deleted candidates, remove
created candidates, and rerun the predicate with the original parameters.
Return the complete historical match set as `CoveredAt.under` and each asked
candidate's historical membership as `covered`. A departed recipient then
refuses `deleted` or `relocated`; one still selected with changed consumed data
refuses `changed`. Return `Covered.content` for consumed content independent
of membership, and cannot-say for unknown fields or missing historical bytes.
Use `HistoricalBlobs` for byte comparisons; current bytes cannot prove a basis
match. The editor bridge serves the same `under` and `covered` wire callbacks.
Rust `StateDiff::to_recorded_json` retains deleted JSON predicate values in
private `$was` metadata; strip `$was` from public receipts. These values retain
the receipt's bounds, so an excerpt still requires cannot-say.

## Isolated Planning And Raw Batches

Update the Rust SDK, editor worker and host together.

- For scoped `edit.undo` and `edit.redo`, use Rust `undo_touches_in(scope)` /
  `redo_touches_in(scope)`. The result describes the next grouped step's original
  object IDs and fields. Translate raw IDs through `ToolIds` and return these
  holds from `under`; `can_undo_in` / `can_redo_in` alone cannot declare them.
- `under`, `covered` and `content` requests carry a zero-based `step`, editor
  `state` and the earlier steps' `changes`. Rust kits can implement `under_step`
  and `covered_step`; `ContentAsk` contains the same `PremiseStep`. Callbacks
  for dependent steps read an isolated copy after its prefix has run. Implement
  `fork_for_premises` / `forkForPremises`, including document data, blobs and
  editor state. Replica-backed headless adapters can reopen a snapshot instead.
  Planning caches the copy until all reads of that step finish, preserving
  newly allocated IDs; it is then discarded before execution. A refusal never
  applies the planned writes. The host advances each cached scratch copy one
  step at a time, retaining cumulative changes and batch references. Limits are
  16 plans, 256 prefix operations and 1 MiB cumulatively per plan.
  Fresh direct batches need no prefix plan. Unavailable planning refuses
  `unknown`. Kits must execute commands without external effects while planning;
  this is a document copy, not an external-service transaction.
- Raw `_batch` writes require a type's `batchOps` premise contract, including
  calls without `basis`. Declare a command mapping for operations that read
  command-specific inputs, or `{ "direct": true }` when the SDK's ordinary
  object, field, reference and insertion-window holds describe every read.
  Keys are `op.field`, `op`, or an explicit `*` default. An operation on a nested
  holder path (`target: 1, field: "comp.layers"`) uses the contract of the object
  holding the last field (`list.move.layers` on the comp), whose parameter paths
  then read `target` as that object and `field` as the last field. Parameter paths are
  structural paths into the raw operation. For example:

  ```json
  {"batchOps":{"set.opacity":{"command":"clip.opacity","params":{"clip":"target","opacity":"value"}}}}
  ```

  A mapped operation is checked using that command's premises; execution still
  uses the raw operation and the kit's settler. Each stale-basis batch operation
  is checked on a scratch copy of the actual preceding operations. Omitted
  writable contracts refuse before execution. Immutable operations retain
  their model validation errors. Low-level KDM transactions remain available
  to kits. The existing live-editor refusal of mixed raw/command batches whose
  rollback is unavailable still applies.
- Return mark attributes using object identities, with a complete object
  inventory including mark-only objects. Text loads and private retained text
  translate mark references through tool IDs while leaving typed characters
  literal. `ContentAsk.before` preserves retained formatting runs and their
  existing retention bounds. An outside rename is refused under the tool ID
  the agent observed, with the paired current ID in `now`; this does not make
  an old ID executable. Array-valued `premiseOnly` facts remain private values
  across rereads.

Custom native adapters implement `context.plan`; editor adapters forward
`ai/premise` with `name:"plan"`. A `begin` request supplies `steps` (command,
params and optional context), optional raw `ops`, and the zero-based `step` to
read next. It returns an opaque `token`, `beforeState`, current `state`,
cumulative `changes` and batch `refs`. An `advance` request carries the token
and only the newly added prefix operations; it must preserve earlier reference
bindings and allocated IDs. A `read` request carries the token, `method` and
`params`, and reads that copy with its current step, state and changes. An `end`
request releases the token. Keep these reads isolated from the live document
and release plans after refusal, errors and document closure. Planning the copy
lets the guard refuse the entire run before any live write, without depending
on undo to roll a partially executed run back.

If a planned command successfully returns `{closed:true}`, stop that prefix
immediately and return `{closed:true}` instead of a token. Release its scratch
plan without reading the closed model or editor state. The guard checks no
later steps; execution reports them as `notRun`. A refused close or a result
without `closed:true` does not signal terminal completion.

Source changes: `ContentAsk` embeds `PremiseStep`; `TypeDef` gains `batchOps`
and `creation`; `ProjectedPlace` gains optional `node` and defaults `index` to
zero. Update explicit Rust struct literals. Older schema readers reject these
new declarations. Raw tool batches without a declared writable contract now
refuse, and multi-step guards require an isolated planning implementation.

## Editor Callbacks And Projected Objects

Update the Rust SDK, TypeScript packages, editor and host together. The live
reader now runs the same kit premise callbacks as the headless reader, in the
agent's editor context with the person's state restored. See
[the editor contract](#in-the-open-editor) for callback transport, retained
history, refusal behavior and limits. An editor without change history now
refuses a write with `basis` as `unknown`.

### Projected Objects

Declare computed types with `projected:true`, ordinary field schemas and,
for writable operations, `projectedOps`. Implement Rust
`KitDocument::projected_objects`.
Return the complete projection for the current document state as
`[{id,type,fields,at?:{parent,field,index}}]`. IDs must remain stable within the
session, be unique and never shadow stored IDs. Containers are virtual lists,
trees, or owning refs whose `of` names a projected type; their membership comes
from `at`, not stored fields. Indexes must be contiguous within each sibling
group. For a tree, `at.parent` and `at.field` identify the owning container and
optional `at.node` names its projected parent object in that same tree. For an
owning ref, omit `index` or use zero; at most one object may occupy it. Nested
projected parents may contain further lists, trees and owning refs. Placement
cycles, duplicate membership and trees deeper than 64 levels refuse.
Owning maps do not declare projected element types and are not supported
projection containers. Detached projected objects may omit `at`.

For example, a stored `Document.text` can project `Section` objects containing
virtual `Line` lists. No projected object or membership is written to the
replica, including during snapshot loads and remote imports. Query inventory,
loads, tool ID parameters, receipts, `others`, premises and environment sampling
use the combined view. The SDK diffs projections before/after commands and
unsaved human editor changes, including created/deleted/changed/moved objects.
Receipts use the ordinary footprint compaction. Outside rereads compare the
observed file states; kits still own identity continuity across rereads.

`projectedOps` maps an operation, optionally qualified by field, to a kit
command and parameter paths into that operation:

```json
{"set.text":{"command":"line.set","params":{"id":"target","text":"value"}},
 "create":{"command":"line.add","params":{"text":"fields.text","in":"in"}},
 "delete":{"command":"line.delete","params":{"id":"target"}},
 "list.move":{"command":"line.move","params":{"id":"target","in":"in","to":"to"}}}
```

Tree operations use the child's `tree.*` mappings, with projected object IDs
as node IDs. Setting an owning projected ref uses its child's `ref.set`
mapping. `create.in` accepts all three container kinds. Domain commands remain
responsible for valid moves and replacement semantics.

Commands enforce their domain rules and edit the stored source. Create commands
return the allocated `id` for batch refs. Missing mappings refuse `read-only`;
read-only types, fields and destination containers are checked before dispatch.
Invalid or incomplete projections cannot establish a comparison. Declare every
computed dependency in the same call premises used for stored objects; SDK
projection support does not infer a command's semantic dependencies.

For environment tasks, declare source-field consequences on the stored source
type, scoped to the owning container and actions. `structuralConsequences.on`
now also accepts `set` in schemas with projected types, for projected scalar
edits. A source text example is
`[{container:"Document",on:["create","delete","move","rename","set"],fields:["text"]}]`.
Replay must regenerate every saved-state effect. See [environment adoption](../../sdk/env.md).

### Missing Covered Objects

Return `Covered.gone:true` when a historically covered object no longer exists.
This distinguishes deletion from a surviving object moved away, even when the
native changes cannot name the deletion. `gone` defaults to false; malformed
values refuse `unknown`. Continue answering `covered` for historical occupancy.
`Covered.content:"deleted"` describes removed held content and remains useful
when its containing object survives. Explicit Rust `Covered` literals add
`gone:false`; default-based constructors need no change.

Rust `TypeDef` literals add `projected` and `projected_ops`; JSON schema readers
must preserve `projected` and `projectedOps`. Rebuild document exports for the
new `premiseRead` bridge method. No stored-document migration is introduced.
Seeded environment samples change when projected objects become eligible.

## Content History And Rereads

Direct `Under.content` holds now use the same private full text history as
covered places. Implement `content_at` against `ContentAsk.before`, including
formatting runs when present; no kit-side text history is required. Complete
text is retained up to 1 MiB of serialized UTF-8 per field and 4 MiB per change.
An excerpt without retained full text refuses `unknown` before calling the kit.
Public receipts and `others` still abbreviate long text.

Blob callbacks already receive the complete hash/mime/size reference and read
basis bytes through `HistoricalBlobs`, within the manager's byte and journal
bounds. Missing bytes must answer cannot-say. On-demand facts already receive
complete stored-model checkpoints, with their separate 20,000-object,
256-revision and 64 MiB limits. These facilities are also available to the live
editor reader; see [the editor contract](#in-the-open-editor).

The host now snapshots all live replica objects, including detached
comment threads, using `model.batch` with `objects:true`. Rust and TypeScript
batch adapters answer `objects:[{id,type}]` without changing the replica.
Custom adapters must pass this request and response member through. An adapter
that cannot enumerate objects cannot establish a complete reread snapshot.

The latest model checkpoint is now captured for every model kit, within the
existing 20,000-object and history-byte bounds, so an early file notification,
an explicit reload or a session reopened before the next call cannot hide
dropped objects. Snapshots add a complete model read at call boundaries.
Missing/evicted checkpoints still produce `unknown`. Dropped objects without
tool ids are named by their prior raw id in `others.deleted`, rather than only
counted as unnamed; held writes refuse `deleted` before execution.

Implement `KitDocument::carry_replica_objects(&mut self, previous:&Self)` on the
newly read document to carry replica-only objects. Choose keep, re-anchor or
drop per object, preserving kept ids and copying their owned children as needed.
Apply only session data; file content comes from the fresh read. The default
carries nothing. Headless explicit reload, file notification and replaced-file
open call the hook before replacing the previous document; a hook error keeps
that previous session. Custom servers must invoke their equivalent hook.

Command parameters hold objects only where their schema declares
`x-khp-role:"targets"`, `x-khp-role:"object"`, `x-khp-name`, or an object index
spelling. Declare references at the actual scalar position, including nested
members and array items. A literal string, number, nested member or array item
does not hold an object merely because its whole value spells that object's id.
Explicit `on`, model reference fields and `Under` premises still hold objects.
Declare every reference at its schema value position.

`unknown` retains its public reason but now explains the failed
comparison. Only a recorded reassignment of tool ids says objects were
renumbered. The message contains each unknown object's explanation, and any
kit/place detail. Preserve the specific explanation in client diagnostics.

| Unknown Trigger | Message Prefix |
| --- | --- |
| Missing changes, model unavailable, or a change the adapter cannot describe | Change history unavailable |
| Invalid/unreadable order, batch container/window, insertion gap, index/time window, missing covered callback or unprovable coverage/content | Place basis unavailable (with the specific place detail) |
| Implicit editor state unsupported, missing state history, or opaque state transition | Editor state unavailable |
| Invalid consumed input, missing basis observation, or unavailable fingerprint | External input basis unavailable |
| Invalid content premise, missing field/read/history, excerpt without full text, or retention limit | Content basis unavailable |
| Content callback unsupported, cannot-say/error, unavailable historical blob bytes | Content comparison unavailable |
| On-demand checkpoint missing or evicted by revision/object/byte bounds | Fact basis unavailable or evicted |
| Eager derived history incomplete or on-demand callback cannot compare | Derived fact comparison unavailable |
| Kit identity callback reports unprovable continuity (or fails) | Identity unprovable |
| Journal records reassigned tool ids | Objects renumbered |
| Addressed object's recorded type changed | Object type changed |
| Selector's identity keys, members, or historical membership cannot be reconstructed | Selector identity unprovable |

An expired, foreign or invalid journal basis is refused before comparisons and
keeps the journal's exact explanation (including an evicted basis). No message
claims renumbering from a generic unknown. A retry of actual renumbering retains
the stale basis until inspection, as before.

`Covered.content:"deleted"` now reports removed held content even when its
containing object survives. Kits must distinguish this from a span that moved
(`covered`/occupancy) and a span edited in place (`content:"changed"`). Adding `CoveredContent::Deleted` requires updating exhaustive Rust matches.

Long-text field edits can include `span:{offset,removed,inserted,
removedLength,insertedLength,before,after,complete}`. Offsets and lengths count
Unicode scalar characters; `before`/`after` are unchanged context, not whole
field values. Each changed fragment keeps at most 80 characters, each context
20, at most 2 KiB per span and 64 KiB of span metadata per change/answer. If
`complete:false`, the fragments are abbreviated and must not be replayed.
Formatting-only changes have no text span. Several edits of one field in
`others` have chronological `spans`, each relative to its preceding state;
`spansTruncated:true` indicates omitted details. Existing field excerpts remain.

Rust `to_recorded_json` includes spans automatically. `to_located_json` exposes
them without private history; `to_json` keeps the comparison shape.
Custom adapters must pass span metadata through. Update the SDK pin; no file
format change is required.

Uniform shifts of map-keyed leaves, including a whole JSON overlay register,
compact to `{field:"overlay.*.x",keys:[...],count,shift:{by}}` in the object's
edits. Keys are exact and sorted; the private journal retains the original
values. Non-numeric changes keep their full representation. Receipt readers must preserve Unicode offsets, truncation flags and exact map keys.

`kit-env` samples editable root fields as document fields. Long-text
replace tasks select a seeded word, line or sentence (bounded to 60 characters)
and describe its location by character position and surrounding context. Complete
spans replay through text insertion/deletion or a scalar string assignment;
the saved-state diff and score retain the span position. Missing, truncated,
mismatched or incomplete spans cannot authorize replay. Existing `readOnly`,
`sample:false` and identity-field exclusions still apply.

Declare a root text/label field and preserve span metadata in custom adapters.
No extra kit hook or task migration is required. ## Environment Tasks And References

Owning maps and single owning-ref children participate in environment tasks. Update the SDK and retain `owns:true` plus complete model loads. The
sampler balances edit kinds, then object types, then candidates. Maps use fresh
vocabulary keys and infer child types from their entries; kits validate keys
normally. Entry removal must own exactly one object. Replay uses create/bind
and map operations and restores required empty registers from saved snapshots.
Nested map/JSON receipt references now use tool ids in Rust and TypeScript.
See [environment adoption](../../sdk/env.md) for sampling limits.

Environment tasks carry recorded-id-to-batch-ref `bindings`; replay
learns each allocation from the kit's existing `refs` reply and carries the id
map through later calls, inverse setup and scoring. The trace exposes `idMap`
and actual dispatched arguments. No deterministic id declaration is needed.
Rust environment struct literals add the fields documented in [environment adoption](../../sdk/env.md).

Declare `structuralConsequences` on dependent types, naming the container
type, actions (`create`, `delete`, `move`, `rename`) and exact stored field paths.
Only effects in that container instance (or a move's source/destination) qualify.
For example, cells declare formula/address/label paths under `Sheet`; `Sheet`
declares its owning-map field when row edits rekey cells. The task names and
replays only the primary edit; settling must regenerate the full state. Extra structural operations require their own ownership/cascade
contract. Rust `TypeDef` literals add `structural_consequences`; update TS too.

SDK query loads, batch results and recorded receipts translate exact
references inside owning maps, nested JSON values and JSON keys to tool ids.
Headless inspect, diagnostics and command replies use the same translation.
Literal text containing an id as a substring stays text. Custom reply builders
must call `ToolIds::show_json` / `ToolIds.showJson`; arbitrary kit-authored RPC
answers are not rewritten by a generic transport. In the editor, `agentReply`
initializes its reader from the engine's native model description and replica
export on the first inspect/check/run reply. For replica-only engines without
a native model description, supply the schema through `modelDescribe(schema)`
before serving agent replies. Without a schema and export the editor cannot
resolve raw ids and returns them unchanged.

Return an empty `within` window for an empty address or gap, a `covers`
declaration for an empty region, or the command's name premise for an unoccupied
name. These holds must describe the place even when `objects` is empty. Names
and index/time windows already held absence; object-addressed covered places
now do too. When a kit has a stable id for an unmaterialized source, return it
in `Under.objects` or an explicit premise. A colleague creating that id refuses
`relocated`; creating an unrelated neighbor applies. `Under.objects` is now
honored for object-addressed commands too, so include actual read dependencies
and narrow them with explicit `fields` / `positions` as appropriate.

Keep both `covers` and `within` declarations when covered content and list membership are independent dependencies.

Editor readers retain checkpoints and observe eager `derived` reads,
along with historical bytes. Kits can retain the same derived declarations and
callbacks in both readers. The stored `readOnly:true, sample:false` holder
alternative is also valid; editor independence does not require it.
Missing callbacks or incomplete/evicted history still refuse `unknown`.

### Schema Readers

Update Rust/TS schema readers together for `structuralConsequences`. Explicit
Rust `TypeDef` literals add `structural_consequences`; environment `Task`,
`Observation`, `Step` and `Trace` literals add the binding/map/argument fields
listed in [environment adoption](../../sdk/env.md). Optional task `bindings`
and trace `idMap` are additive JSON fields. Stale calls refuse when an object-addressed source or place changed.
There is no stored-document migration or deterministic creation-id hook.

## Order Content And Private Facts

| Facility | What a kit declares or implements |
| --- | --- |
| First headless draft write | Update the SDK. The host creates the draft before observing pre-call context. No command or receipt change is required. |
| Relative list order | Return `Under.orders: [{parent,field,objects}]`. Name every held object and every sibling anchor whose order matters. Only their membership and relative order are held; insertion, deletion or movement of unlisted siblings may apply. Keep `positions: ["nodes"]` for exact stored indexes; use `within` for membership of an indexed window, including new members. Narrow ordinary positional premises separately. |
| Root windows and scoped strings | Return `within` even without object premises. A root list and an id-typed string such as `shape:<slide>/<n>` need no separate place parameter: resolve the string per call and return its list window, including when the source is now empty. The existing guard checks these windows before command execution. |
| Covered content | Return `Covered.content: "same"`, `"changed"` or `"unknown"` for a held covered place. A changed fingerprint while occupancy is unchanged refuses `changed`; changed occupancy still refuses `relocated`/`deleted`. Omission preserves the occupancy-only contract. Implement `covered`/`covered_at` and compare all content and formatting used by the command. |
| Long text and formatting | Rust session receipts and outside rereads retain full basis strings/runs privately. `CoveredAsk.before` includes these complete values rather than public excerpts, including formatting-only edits. Custom TS servers call `withTextBasis(diff,schema,before,after)` before journalling and retain its `$text` metadata privately. Public receipts remain abbreviated. Return cannot-say if basis content is unavailable. |
| Holder-specific derived facts | Declare `~layerItems`, `~compositionFrames`, etc. on their actual `Layer`/`Story`/`Page` holder and return that holder in per-call premises. Inputs may belong to another type and the holder need not appear in stored edits. Avoid a root fact when unrelated holders must remain independent. |
| On-demand private facts | Declare `derived: {layerItems: {premiseOnly:true,onDemand:true}}`. In `content_at`, a `~layerItems` request has `region:null` and `before:{objects,history:[{before:{objects},after:{objects}}]}`. Compute that holder's fact for each supplied other-writer transition and answer `Some(true)` if any differs, `Some(false)` if all are equal, or `None` if unprovable. The host calls only held on-demand facts. Ordinary derived facts still use eager `derived(ids,names)`; honor its names filter. |
| Consequential move fields | On each affected type declare `moveConsequences: ["address.slide"]` and mark the root field `position:true`. kit-env admits one structural move plus only these field paths on the moved object's owned subtree. Replay performs the move, and the kit's batch settling must regenerate the addresses. Full receipts and saved-state replay still have to agree. See [environment adoption](../../sdk/env.md). |

### Retention And Source Changes

Full text history is capped at 1 MiB per field and 4 MiB per change. On-demand
stored-model checkpoints are limited to 20,000 objects per snapshot, 256 revisions
and 64 MiB total per document, within the journal lifetime. Checkpoint capture
reads stored objects but evaluates no on-demand fact. Eviction, restart, missing
callbacks or missing history refuse `unknown`; observe again to establish a basis.
Headless and live editor readers require retained checkpoints and the matching kit callbacks. Intermediate outside
states that were never observed cannot be reconstructed.

New declarations are additive on the wire, but old strict schema readers reject
`onDemand` and `moveConsequences`: update Rust and TS readers together. Explicit
Rust literals add `Under.orders`, `Covered.content`, `DerivedDef.on_demand` and
`TypeDef.move_consequences`, or use defaults where available. No stored document,
task or public change-set format is replaced. Custom journal adapters must retain
private text history and remove `$text` from public answers.

## Premises Identity And External Inputs

| Item | What a kit must change |
| --- | --- |
| 1. Repeated premises | Update the SDK. Return every dependency normally, even when several premises name one object. Their fields, positions and selector identities are joined within each call and across steps; an omitted fields/positions member wins as a whole-target hold. Content regions remain independent additive holds. No kit-side join is required. |
| 2. Indirect derived facts | Update the SDK pin; declare and answer the fact on its holder even when its inputs are elsewhere. No whole-document stored premise or dependency graph is required. The host currently reads all declaring objects after writes; this is eager, not limited to pending holds. |
| 3. Private derived facts | Declare `derived: {history: {premiseOnly: true}}` and keep returning `history` through `derived`. Hold `~history` normally. The host retains private comparisons for guard history, omits their public fields/objects from receipts and `others`, and environment snapshots contain no derived facts. Rust `DerivedDef` literals add `premise_only: false`; update TS readers before emitting this property. |
| 4. Unprovable identity | Implement `KitDocument::unproven_identities(objects)` and return the addressed ids/names whose continuity across file rereads cannot be established. Return an empty list when provable. The headless adapter serves `context.identity`; custom servers answer `{unproven:[...]}`. After any outside journal entry since basis the guard asks for addressed targets, and refuses these as `unknown`, even when stored values match. Reusing the stale basis stays refused; inspect again to establish current identity. Default hooks and old servers preserve existing behavior. |
| 5. External inputs | Implement `external_inputs() -> Vec<ExternalInput>` with stable names and kit-computed content fingerprints. Keep an unavailable name with `fingerprint: None`. Expose the dependency during an observation before consuming it; for one-off imports a read command may register the source, and the host captures inputs after that command before returning its revision. Return consumed names in `Under.inputs`. The host records fingerprints before calls and after successful calls; changed fingerprints advance the revision independently of the document. Missing basis observations/unavailable fingerprints refuse `unknown`, changed fingerprints refuse `changed`. Explicit `Under` literals add `inputs: vec![]`; default hooks preserve existing kits. |
| 6. Text and compact assignments | Declare type-level `text: "kind.words"` for a field/JSON member that contains the object's text. It supplies the default label, replace-text candidates and "says"/"the text" wording; an explicit `label` still controls naming. Missing/non-string members are not sampled. Existing `sample: false` and read-only rules apply. Update Rust/TS schema readers; explicit Rust `TypeDef` literals add `text: None`. Receipt readers accept `footprint: [{ids,edits:[{field,after}]}]` for identical assignments, alongside numeric shifts. All ids remain represented; incomplete/excerpt values are not grouped. No kit receipt hook is needed. |
| 7. Local windows | Keep single-member `within` windows and `x-khp-index-numbers` on local integer parameters. No new hook or workaround is required. Structural edits in other lists and after the member apply; insertion before it refuses `relocated`. |
| 8. Time review | Return `within` for every consumed time interval, including JSON caption/key arrays or maps. For JSON arrays add `time.identity: "uid"` (or the stable member path); map keys provide identity when omitted. Use `start` alone for ordering points; interval windows also name `end` or `duration`. Declare content/positions independently, and keep ordinal and time windows together when both are consumed. A window cannot infer a deleted dependency from a list of only current per-entry premises. Nested selector name members such as `effects[meta.name="Blur"]` need a declared stable `identities` member for rename/deletion diagnostics. Batch commands may carry `on` and `at: {part,time}`; SDK session/exchange adapters apply and restore that context, custom Rust/TS adapters implement `command_at`/`commandAt` or explicitly refuse it. Declare `batchIndependent: true` on types whose raw field writes can ignore unrelated ancestor/list positions; undeclared types retain positional holds. Schema reference kinds determine raw value dependencies. Raw batch targets/containers retain paired UUID references across rereads within one bounded manager session; reobserve after restart/eviction. |
| Adoption | Pin matching Rust and TypeScript readers before emitting declarations, then verify the kit against saved-file regression tests. |

### Compatibility And Limits

Explicit Rust struct literals need these new members: `DerivedDef.premise_only`
(`false`), `TypeDef.text` (`None`), `TypeDef.batch_independent` (`false`),
`Under.inputs` (empty), and `TimeSpan.identity` (`None`). Builders/defaults
avoid these source changes. The document and batch adapter hooks have defaults.
Old schema readers reject new properties; update them before opting in.
Receipt consumers must accept identical-assignment `footprint` entries with
`after` as well as numeric `by`. Explicit batch command context applies or
refuses; the core batch runner never discards it.

Ordinary facts are still eager adds an opt-in cost bound for private
facts proportional to pending holds. Failed indirect
derived history now refuses unknown. Raw field placement precision requires
the per-type opt-in because existing tests protect the default relocation
contract. Structural operations keep their positional holds in either mode.

JSON windows need declared stable identities to distinguish replacement at
equal times; ordering values alone cannot prove that identity. Content reads
need their own field/content holds. The identity-confidence hook does not
improve snapshot pairing, and external bytes are not included in kit-env's
snapshots or rewards. Raw UUID target/container remapping lasts only within
the bounded manager registry; restart/eviction requires a fresh observation.

## Batch Validation And Replay

No new hook is required. Serve correct ranged blob bytes and the full
size; callbacks must return cannot-say when history is unavailable. Chunk
boundaries, corrupt capture, document close/reopen and worker restart are now
tested. Manager restart loses the journal/cache and requires a fresh basis.

Kits without a KDM session can keep `kition-kit`'s default features.
`BatchSettler`, `batch_settler`, `blob_source` and `value_limits` require the
`session` feature; enable it when implementing those hooks. Core `KitDocument`,
coverage and content comparison contracts compile without it. Remove a feature
workaround only if the kit does not itself use session APIs.

| Item | What a kit must change |
| --- | --- |
| 1. Bounded member types | Update Rust and TypeScript together. A declared numeric member path requires a number for scalar values; strings and booleans refuse. Add `nullable: true` on the member limits to permit null. Arrays and objects at that path are allowed, and deeper declared paths are independently checked. For number-or-array `resolution`, declare both `resolution` and `resolution[]`. Absent members remain optional. Explicit Rust `NumberLimits` literals add `nullable: false`. |
| 2. Positional batches | Update the SDK; no new hook or batch property. `create.in` with `at`, `list.insert`, `list.move` and tree equivalents automatically hold destination gaps and move sources. Keep destination indexes in pre-removal coordinates. Nested paths such as `root.groups.0.body.layers` resolve through lists and owned refs; `target:"comp:1", field:"layers"` also remains valid. Remove whole-list premise workarounds once the kit's own regression passes. |
| 3. Environment replay | Keep `owns: true` on owned refs and containers, expose their complete model loads, and report creation values normally. The generator creates owned objects before their owner, binds their fresh references and restores container contents. Task consumers accept these multi-operation creation solutions and nested move paths. No new hook, deterministic allocator or file-format change. |
| 4. Integer and conditional limits | Nested integer members declare `multipleOf: 1`; nullable ones add `nullable: true`. Map `members` can name keys or wildcard entries (`*.count`). Nullable integer registers use `optional: true`. Implement `KitDocument::value_limits` when bounds depend on live object register/map metadata: return an owned callback over `{id,type,fields}` and a concrete path, returning additional `NumberLimits` or `None`. Creates, register sets, map sets and map deletes validate in the transaction. Session/exchange adapters forward it and add `limits` to loads for env sampling; custom batch adapters forward `BatchTarget::value_limits`, and custom servers emit the load metadata. |
| 5. List windows | Keep returning `Under.within` for the held list; no extra selector or place parameter is required when the holder is named by id. For point ordering fields, return `time: {from,to,start:"time"}` without `end` or `duration`. Mark the ordering field positional. Ordinal and time windows check membership throughout history, including removal and move-out. |
| 6. Optional session feature | Enable `session` only when using the KDM hooks listed above. Core kit implementations compile without it. |
| 7. Historical blobs | Serve exact ranges and complete sizes; return cannot-say when old bytes are unavailable. Close/reopen and worker restart retain bounded history within one manager; manager restart needs a fresh observation. |
| 9. Adoption documentation | Pin the matching Rust and TypeScript versions and follow this table. Run the kit's geometry, replay and blob tests when adopting these declarations. |

## Model Declarations And History

| Item | What a kit must change |
| --- | --- |
| 1. Command dependencies | Update the SDK. Keep persistent tool ids and selector identity keys immutable. Declare exact `fields`/`positions`, `name_field`/`name_params` and type restrictions normally. A covered callback receives reserved `before.$at` for prior list order; use it when order affects picking. `covers` and `within` both hold. Derived values are reevaluated for all declaring objects after writes because the schema declares no complete input graph. Canonical `context.get.state` members `selection`, `part`, `time`, `mode`, `active`, `area` let implicit reads report `changed`; changed opaque state without the relevant member reports `unknown`. No state hooks, or implicit live-editor state without state history, refuses `unknown` with basis; provide explicit context where possible. |
| 2. JSON numeric members | Update Rust and TypeScript together. Declare `members: {"motion.blur.shutter":{"minimum":0},"weights[]":{"minimum":0},"effects[].amount":{"maximum":1}}`. Whole-value and path batch writes validate the reconstructed value. Environment sampling follows the same paths and bounds. Constrained scalars require numbers, or explicitly nullable nulls. |
| 3. Cascading trees | Opt in per tree field with `cascade: true`. A single node delete then removes its entire subtree, descendants first, in one transaction. The receipt names every addressable deletion, and saved reread agrees. Without the declaration the existing child-first refusal remains. Rust `FieldDef` literals add `cascade: false`; TypeScript declarations are optional. Environment tasks name the group and its contents and replay one root delete only when the receipt is exactly that complete subtree. |
| 4. Owning maps | Keep `owns: true` on owning maps and return their referenced objects through model loads. Direct references and references inside map-value records are traversed, normalized to tool ids and included in snapshots. No new kit hook. Map records become field-edit candidates; map containers are not treated as positional lists for move/delete tasks. |
| 5. Region content | Return `Under.content: [{id,field,region}]` for each content dependency. `region` is kit-defined JSON, for example `[x,y,width,height]`. Narrow ordinary `premises` separately to the other fields used; content premises never erase another step's whole-field premise. Implement `KitDocument::content_at(ContentAsk, HistoricalBlobs)` to compare the reconstructed basis field with current content inside that region. Answer `Some(false)` only when equal, `Some(true)` when different, and `None` when unavailable. The latter refuses `unknown`. This implementation uses historical bytes from item 6; no observe-time region registry is required. Explicit Rust `Under` literals add `content: vec![]` or use defaults. |
| 6. Historical bytes | Implement `KitDocument::blob_source()` using the open session's blob store, and optionally `covered_at(..., history)` to read a basis hash. Defaults preserve existing kit hooks. Headless advertises `model.describe.blobBytes`, serves current `model.readBlob`, and supplies the callback's temporary `history` token. Custom servers implement the same wire methods. Read at most 1 MiB per chunk and return cannot-say for unavailable bytes. Capture validates size and SHA-256 before retention. The per-journal cap defaults to 64 MiB and is configurable with `with_history_blob_limit`; FIFO eviction can make bytes unavailable before journal eviction. See [retention](../data-model.md#historical-blob-bytes). |
| 7. Adoption | Pin the matching SDK/TypeScript readers before emitting new schema properties. Existing wire declarations remain valid; new declarations and source struct fields require the adaptations above. |

## Ordered Places And Creation

| Item | What a kit must change |
| --- | --- |
| 1. Ordered premises | Update the SDK pin. Keep declaring the destination in `places` and returning `[i,i)` for the gap in the pre-removal list, including a move addressed by object id. For tree children use the parent node's object id and the tree field; top-level children use the tree owner. Declare the source object's actual position dependencies separately. No suffix-window workaround, schema property, or new hook is needed. |
| 2. Creation-only registers | Update the Rust SDK and `@kition/kdm` together. A register's `readOnly: true` means immutable after creation: provide it in `create.fields`, where required fields and enum/value limits are validated normally. Keep a writable same-type example in environment input files so sampling can copy its required creation values. Receipt replay supplies those values from `created[].values`. Remove workarounds that mark a creation-only `kind` writable; type-level `readOnly` and `readOnlyWhen` still prohibit creating kit-owned objects. |
| 3. Allocated ids | Update the SDK pin; no kit hook or deterministic-id allocator is needed. Keep existing ids stable within an opening, saves included; across a reopen they are stable only where the kit's file stores them, as the kit's `agent/guide.md` says, and an agent observes again after a reopen ([the data model](../data-model.md), "Ids within an opening and across a reopen"). Report all newly created objects in the receipt. Fresh ids allocated by that receipt may differ on replay; references to them must still point consistently to the corresponding new objects. |

The journal retains unnamed objects' old/new positions even when public rereads count
them in `unnamed`. Empty gaps hold the identities and positions of their left/right
neighbours (or the beginning/end boundary). An insertion, deletion, move-in,
move-out or reorder that changes either neighbour refuses `relocated`; edits strictly
after the gap and neighbour field edits alone apply. A distant reorder that leaves
both neighbours in place also applies. Non-empty windows hold their selected members,
without holding an adjacent item outside `[i,j)`: which objects are at the positions
`[i,j)`, not their order among themselves, so a reorder that keeps every member inside
applies ([the data model](../data-model.md), "List windows hold membership").
Stored `index` and reversed index
spellings retain their own counting direction; an id's position premise still detects
implicit shifts caused by another item being inserted or removed.

Replay compares allocated ids by one consistent renaming, including references in
other objects. This exception is limited to ids first appearing in the task's creation
receipt; pre-existing ids, content, list order and reference targets must still agree.
It does not permit a kit to remint an existing object's id within an opening, nor, on a reopen,
an id its file stores.

Compatibility: the wire schema and existing premise declarations are unchanged.
`create.fields` now accepts field-level read-only registers, so callers that expected
`read-only` for that creation must adopt the new contract. Later edits remain
read-only and atomic. Public reread output remains unchanged; `$unnamed` is private
journal metadata and is never returned in receipts or `others`.

## Nested Paths And Selector Identity

Pin the SDK containing these fixes before narrowing premises or adopting
identity hints. The [agent guide](../../sdk/agent.md) describes the refusals;
the [environment guide](../../sdk/env.md) describes sampling and replay.

1. Nested positions: after updating the SDK, replace whole-`frame` workarounds
   with `Premise::on(parent).fields([]).positions(["frame.transform"])` when
   that is the actual dependency. It matches changes at `frame.transform`,
   below it (`frame.transform.4`), or above it (`frame`), on dot-separated
   segments; `frame.transformOrigin` does not match. Keep marking the stored
   position field in the schema and declaring every ancestor the call reads.
   Field and derived premises already use this same overlap rule, including
   `~geometry.bounds`; no declaration changes are needed for those. Schema position
   detection classifies every leaf of a marked root field as positional.
2. Creation samples: keep required structured values as writable `kind: "json"`
   fields (for example a node's `kind: {"type":"frame"}`). The environment
   copies JSON registers from its seeded, same-type example object alongside
   scalar registers. Keep an example in the document; without a value for a
   required JSON field the candidate is `no-value`. No new schema field or hook
   is needed. `sample: false` prevents choosing a field edit, but does not omit
   the value from creation. Creation-only read-only registers are also included.
3. Tree-node deletion keeps the documented child-first contract. A node with
   live children refuses `invalid-value`, now explicitly saying to delete
   children child-first or move them before deleting the node in the same
   batch. Kits whose commands cascade must expand that command into descendant
   `delete`s followed by the node's `delete` when using model batches. Every
   deleted addressable node is in the receipt and saved reread agrees. This is
   distinct from deleting a tree's owner: ownership traversal still cascades
   through that owner's tree field. No schema or hook changes are needed.
4. Names inside JSON: plain `fields` selectors already prevent stale writes,
   but only report `changed`. To classify the selected entry, expose a unique,
   immutable string/number member key on every entry that survives save/reopen,
   then declare that key for the selector with `Premise::identity`:

   ```rust
   let selector = format!("docState.channels[name={}]", serde_json::to_string(name)?);
   let premise = Premise::on("image")
.fields([selector.clone()])
.positions(Vec::<String>::new())
.identity(selector, "key");
   ```

   The wire premise adds `"identities": {"docState.channels[name=\"Alpha\"]":"key"}`.
   Keep declaring the original name even when it no longer resolves now: the
   guard reconstructs its stable key at `basis`. It refuses `deleted` when the
   entry is gone, `relocated` after rename or reassignment of the name, and
   `changed` for its content; other entries and index shifts alone do not
   refuse. `conflicts[].id` is still the holder; `place.selector` names the
   entry, so `deleted` does not mean the holder was deleted. Missing/duplicate
   keys or history that cannot be followed refuse `unknown`. A name or index
   is not a stable key. Channels without such keys must expose persistent keys
   before adopting this recipe; comps/patterns/search bins may reuse their
   existing stable resource ids. Apply the recipe separately to each list and
   namespace, and keep any additional content premises the command reads.
   Existing declarations need no change unless adopting the refined reasons;
   explicit Rust `Premise` literals add `identities: Default::default()`.
Source compatibility: adding `Premise::identities` requires explicit Rust
struct literals without `..Default::default()` to add that member. Builder
calls and existing wire premises continue to work. The child-first refusal's
message changes, while its code remains `invalid-value`. Generated creation
solutions may now include structured JSON registers; consumers must accept
those values. No old names, file formats, aliases or migrations are added.

## Insertion Gaps And Cached State

Declare the actual insertion gap, numeric limits and cached-state hooks used by the kit.

| Item | Kit action and resulting contract |
| --- | --- |
| 1. Insertion gaps | Keep the index in `KitCommand::places`; answer `within: [{ parent, field, from: i, to: i }]` for insertion at stored index `i`. Board's empty-window declaration was correct. The SDK now holds that gap: an insertion at/before it or removal/move touching or preceding it refuses `relocated`; edits strictly after it may apply. For a move destination, report the gap in the list before removing the source. No suffix window or kit workaround is needed. |
| 2. Numeric limits | A numeric `json` field accepts `minimum`, `maximum`, `multipleOf`. For an object-valued `json` field use `members: { roughness: { minimum: 0, maximum: 1, multipleOf: 0.1 } }`. Bounds constrain present immediate members; they do not require those members. Whole-value and path `set` validate atomically, and environment sampling uses these limits. Command parameter schemas may use the same numeric keywords on `number`/`integer`, including union branches; the MCP tool schema retains them. Declare scene's roughness limits and slide's command ranges here. |
| 3. Name unions | Declare `name_params` and `object_types` normally for a point-or-name/id parameter. Only the value position and JSON type matching a name/id schema branch participate; coordinate arrays and objects do not become ids. Scene may remove its inline `x-khp-name` workarounds and use the command declaration. Scalar names and ids remain guarded. |
| 4. Environment correctness | Keep `sample: false` for fields that should not be chosen. It does not hide actual consequences: a mixed stored effect the instruction cannot describe is discarded as `instruction-incomplete`. No replay hook is needed for creation: stored register fields go in `create.fields`, containers use `text.*`, `map.*`, `list.*` or `tree.*` against a new binding, and derived `~` values are skipped. Marked-text creation retains saved runs for replay, instructions and scoring. |
| 5. Cached state | Override default `KitDocument::batch_applied(&mut self)` when the kit has state cached outside its replica; scene can call its existing `replica_changed()` there. Both direct sessions and Exchange call it after each successful model-operation transaction, before later commands. Read-only batches and rolled-back transactions do not call it. Refresh idempotently without making another edit; existing import notifications still run. |
| 6. Historical blob bytes | Opt into `blob_source` and use `covered_at`/`HistoricalBlobs`. Unavailable bytes require cannot-say. See [retention](../data-model.md#historical-blob-bytes). |
| 7. Documentation and schemas | Use the declarations above. `describe: "*"` expresses JSON member limits as optional numeric `properties` in its JSON Schema, and root numeric limits as standard keywords. Command parameter JSON Schema already admits them. No KDM stored-format or schema-version change is required. |

Rust code constructing `FieldDef` explicitly must add `members` (usually
`Default::default()`). Parsed schemas and kits using defaults need no source
adaptation. `batch_applied` has a no-op default. Generated environment task
records for marked-text creations now keep text runs in `groundTruth` instead
of only characters, and their `solution` uses bindings and container edits;
task consumers must accept these existing batch forms. Existing scalar
creation records remain scalar.

## Ownership Names And Values

Implement ownership, name resolution and value validation as follows:

| Item | Kit action and resulting contract |
| --- | --- |
| 1. Tree edits | Keep declaring `kind: "tree"`; no new hook. Receipts and rereads tell tree deletion with `deleted[].at`, without an empty-edits change of its holder. The environment samples move/create among tree children, as well as deletion. |
| 2. Owned deletion | Declare `owns: true` on owning refs/maps. Batch `delete` recursively deletes owned objects, children first, and names every addressable deletion. A held object without a tool id is attributed to its holder as usual. Non-owning references do not cascade. A later explicit delete of an object already removed in that transaction is harmless; a missing object still fails. |
| 3. Names | Set `name_field: Some("name")` for the target. For other parameters set `name_params: &[("material", "name")]` and `object_types: &[("object", &["Object"]), ("material", &["Material"])]`. Nested paths such as `rules[].source` work. Only the declared types participate in name resolution. A deleted name target refuses `deleted`; a renamed or reassigned name refuses `relocated`. |
| 4. Carried changes | Existing `carried` overrides add a second `&[Value]` argument: `fn carried(&self, ids: &[Value], changes: &[Value]) -> Result<Vec<Carried>, String>`. Inspect the changed entry's `fields`/`edits` or moved entry's `from`/`to`; a parent's mere rename must not carry world transforms. Kits using the default compile unchanged. Custom `model.carried` handlers receive additive `changes` beside `ids`. |
| 5. Stored values | Declare numeric limits and implement the optional `batch_settler` hook described below. Photo can select PSD byte rounding from its open file's format; motion can declare percentage bounds. Returning an error rolls back that run of model operations. Read-only loads never settle values. |
| 6. Point basis blobs | Use the full blob reference in `before`. Opt into retention across reloads through `blob_source`/`covered_at`; unavailable reads require `covered: null`. |
| 7. Environment tasks | Declare reversed index spelling and positive boolean field labels as described below. No kit hook is needed to skip unreadable files; the generator reports them and continues. |

Earlier pins need the `carried` signature adaptation when overriding it;
`Exchange::batch` now also requires a `KitDocument` implementation so it can
select the settling hook. Explicit `KitCommand` literals add `name_params`
or use `..Default::default()`; `FieldDef` literals add `label`, `minimum`,
`maximum`, and `multiple_of`. JSON schema users only add metadata they need.
There are no old-name aliases or old-format readers.

Environment wording: declare `index_reversed: true` and
`object_types` for commands counting from the last stored item. The environment
reads their target JSON Schema's `x-khp-index-order` and `x-khp-types`; a type
with any reversed declaration uses that order in generated references and
positions (stored batch indexes remain unchanged). Give boolean model fields
a positive-state `label` such as `"clipped"`; instructions then say
`Set... to clipped` / `not clipped`. An unreadable source is skipped and
reported with its reason; other files still produce tasks.

Blob basis values: a `context.covered` object's `before`
keeps each blob's `{hash, mime, size, name?}` reference, including a deleted
object's journal values. A kit can use the hash to look up bytes it retains.
It must return `covered: null` if bytes it needs are unavailable. Retention across
reloads is opt-in; byte eviction means a hash is not a promise
that its bytes can be read. See the retention contract in
[`data-model.md`](../data-model.md#historical-blob-bytes).

Batch values: declare `minimum`, `maximum`, and `multipleOf`
on number/integer model fields. Out-of-range batches fail as invalid params.
For file precision, implement `KitDocument::batch_settler` returning an owned
closure that takes `&mut Tx` and returns `Result<(), String>`; select its
configuration from the open file's format. Both headless model paths call it
after each run of model operations, inside that transaction, before receipts.
The default is no settling; existing implementations compile unchanged.

An agent's `<prefix>_run` step says what it acts on (`on`, ids as the kit's
inspect lists them) and where (`at.part`, `at.time`, the run's `target`). The
host saves the kit's editor state before the call, sets it for each step, and
puts it back after the call, before it saves, so no call depends on or leaves
behind the editor's current part, time or selection
([Kit Process Protocol section 7a](../reference/kit-process-protocol.md#7a-editor-context),
[engine contract](../reference/contract.md)). This page is the checklist the
presentation, video and 3D kits followed, with what the SDK added after them.

## Checklist

1. **Pin the SDK** and run the kit's tests unchanged before anything else; a
   failure there is an SDK change to report, not one to work around.
2. **List the editor state `inspect()` reports.** Write the kit's
   editor-state list once (`EDITOR_STATE`): JSON Pointers to the places in
   `inspect()` that are the editing session, not the file (`/slide`,
   `/selection`, `/sequence/playhead`, `/view`, `/mode`), or a name for a key
   that is editor state wherever it is. Pass it to kition-headless as the
   volatile keys and to `testing::check_context`, and declare the same list,
   in the same order, as `engine.editorState` in `kit.json` (`[]` when
   `inspect()` reports none; [manifest](manifest.md) K23), where a host that
   does not run the kit's Rust code reads it; a test compares the two. A key
   you leave out is reported as document content; a document field you list
   (a keyframe's `time`) disappears from what the agent reads.
3. **Implement the three hooks** on `KitDocument`, as an engine API that is no
   edit (no revision, no dirty state, no undo step):
   - `editor_state`: everything a command may read besides its parameters:
     current part, time, selections of every panel, mode, active layer or
     track targets, tool. Keep document data out (In and Out points are the
     sequence's).
   - `set_context`: `part` makes that part current, then `on` becomes the
     selection on it; `time` moves the current time. Check everything before
     changing anything. Refuse an id, part or time the document lacks with
     `invalid_params` saying what is valid, a member the kit cannot set with
     `command_disabled`, and `on` without a part when ids repeat across parts.
   - `restore_editor_state`: put the snapshot back, dropping what the run
     deleted.
4. **Declare the part nouns** in `kit.json` when a part is not a slide or a
   page: `agent.parts: ["sequence"]` (or `["comp"]`, `["sheet"]`). The host
   passes `{ "sequence": <id> }` to `set_context` as the call gave it; a kit
   that declares none gets `slide`/`page` (counted from 1) or
   `slideId`/`pageId` ([manifest K21](manifest.md)). A declared noun always
   carries the part's id as the kit lists it, even `page` or `slide`, in a
   run's `target`, a step's `at.part` and an inspect's `target` (which the
   host sets through `set_context` for the inspect and puts back); only an
   undeclared `slide` or `page` is a number from 1.
5. **Declare what each command reads** (`KitCommand::reads`): `Selection`,
   `Part`, `Time`, and `Mode` (an edit or editing mode), `Active` (the
   active layer, track or object new content goes to) or `Area` (the selected
   area, a photo kit's marquee or pixel selection; keep it in
   `editor_state` and list it, `/area`, in the editor-state list). Derive it from the
   command's code, with a test that fails when the declaration and the code
   disagree. No call context sets `Mode`, `Active` or `Area`: the commands tool tells
   the model to set them with the kit's own command earlier in the run, and
   the host puts them back after it.
6. **Declare the target parameter** (`KitCommand::targets`) where
   `schema::check_targets` takes it: an id (`string`, `integer`, or a `oneOf`
   of them), a list of ids, or a `oneOf` of ids and lists (one id or a list; `on` fills it with a list). `on` fills it, and then no selection is set; a
   step that gives both `on` and that parameter is refused. A command that
   takes two kinds of ids (clips and project items) declares none and gets
   `on` through the selection it reads.
7. **Remove navigation side effects.** A command an agent gives what it acts
   on (ids, a part, a time) leaves the current part, time and selection as
   they were, also when it fails; an agent's inspect of a part does not make
   it current. Commands whose work is moving the editor (`slide.go`,
   `playhead.set`, `timeline.select`) keep their effect.
8. **Render by explicit view** (`agent.render`): a preview is a function of
   the document and the call's `target`, never of the current part or time,
   and the same call answers the same bytes.
9. **Test it**: `testing::check_context(&mut doc, &context, EDITOR_STATE)` with
   a context that moves the editor (another part, another selection), and a
   headless test that a run with `target`, `on` and `at` leaves the editor as
   it was and saves no navigation into the file.
10. **Optionally publish required parameters** (`KitCommand::notation_required`),
    command by command, once `testing::check_required` passes for them
    ([engine A6a](engine.md)).
11. **Name places and positions** (kits with a time or an order: a timeline, a
    sheet's rows). A command that names what it acts on by a place declares its
    place parameters (`KitCommand::places`: `["track"]`, `["index"]`; with
    `reads: [Time]`, `at.time` is a place too, also for a step that names objects by id: answer
    no `objects` where its time selects none) and the kit answers
    `KitDocument::under(command, params)`: the objects under the place now and
    their windows in their lists (`Under { objects, within }`), read with the
    step's part and time already set. Mark the fields that say where an object
    is `"position": true` in the object model's schema (a clip's `start` and
    `duration`; a json `location`, whose one-coordinate change a change set
    tells at its leaf, `location.0`, is a move too), and declare `KitCommand::position_independent` on the
    commands whose effect on their target does not depend on where it is (an
    opacity, a name). Then an agent's write by place after a colleague's ripple
    insert is refused as `relocated` instead of acting on whatever is there
    now, and a write by id that does not depend on position is not refused
    for a move.
12. **Declare index spellings**: a command whose target parameter
    also takes an object by its place in a list (`"#3"`, the third layer of
    the comp) declares the prefix (`KitCommand::index: Some("#")`) and answers
    `KitDocument::under` for such a value (the object it names now and its
    window: `{ parent: <comp id>, field: "comp.layers", from: 2, to: 3 }`).
    A write with `basis` that gives `"#3"` is then refused as `relocated`
    after a colleague's layer above it, naming the layer `"#3"` named and
    where it is now; `on: ["#3"]` is refused as `invalid-params` (`on` takes
    ids). On a tree, the window names the node's siblings as change sets name a
    tree's place: `{ parent: <the parent node's id>, field: "layers", from, to }`,
    and for the top level `parent` is the tree's owner (the root's object id when
    the root holds it). The guard reads a node's children from the root's tree of
    that field, so a write by `"#2"` among a group's children is refused as
    `relocated` after others inserted, deleted or moved a layer below it, or moved
    it into or out of the group (by another agent or in the file), and applies
    after a change above it or in another group. Name the group the index counts
    in as a premise of existence alone (`Premise::on(group).fields([]).positions([])`),
    or a move of the group itself refuses the write. A list or tree the guard
    cannot read when others changed it refuses the write (`unknown`). A tree another object than the root holds is not read for a
    nested place yet: such a write is refused (`unknown`) after any change of
    that place. A command whose index counts from the other end of the list (a
    stack shown top-first: `"#1"` is the last layer stored) declares
    `KitCommand::index_reversed` (`"x-khp-index-order": "reversed"`); its
    `under` still answers windows in stored order. The guard then follows the
    index from that end: a layer put on top refuses a write by `"#1"`, one put
    at the bottom does not, and the object under such a place is not refused
    for a shift of its stored index alone. Every conflict of a place by index
    gives `now.spelled`, where the object is now in the command's spelling
    (`"#2"`), when it is still in that list.
13. **State what each call needs**: the host asks `under` for every step
    of a write with `basis`, by id too (`on` written into the target parameter),
    and reads `Under::premises` (`Premise::on(id).fields([..]).positions([..])`):
    the paths into an object the call reads or replaces (`name`,
    `effects.1.params`, `sequence.captionTracks.0.captions.2`, or the same in the
    kit's words, `transform/opacity.keys.1`) and the positions it depends on
    (`start`, `startTime`, or the list field for its index, `comp.layers`).
    Answer what the code reads, per call: a rename needs `["name"]` and no
    position; a key added at a time needs that property's keys and the layer's
    `startTime`, not its stack index; a cut at a time needs the clip under it and
    where it starts (`positions: ["start"]`), not its length. Leave out what you
    cannot state exactly: an object you say nothing of keeps every field and
    every position. The objects a place names are premises as if named by id
    (all of their content unless you state less), so a write by place after a
    colleague changed the clip under it is refused as `changed`. For a place in
    time, give `Within::time` (`TimeSpan { from, to, start: "start", duration:
    Some("duration") }`, or `end`, in the unit of those fields, ticks as numeric
    strings are fine) instead of an index window: the guard then replays
    exactly which items covered it since `basis`, and a change next to the place
    does not refuse it. A command whose target parameter reads a number naming no
    object as an index (`layer: 3`) sets `KitCommand::index_numbers`; an index
    spelling in another parameter (`parent: "#2"`) is a place too when the
    command declares `index`. A step with no time of its own after another step
    of the run is refused after any change by others unless `under` answers that
    its time names nothing (no `objects`, no `within`).
14. **Commands on the part itself** need nothing: a step that names no object
    (no `on`, no target, no place, no parameter naming an object) and gives
    `at.part` acts on that part, and others' changes of the part's own fields
    (a comp's markers and settings, a slide's properties) refuse it as
    `changed`. Keep what such a command writes in the part's own fields or in
    objects without tool ids it holds (`owns`).
15. **Name held objects as the commands do** (`pathName` on a type in the
    object model's schema): a tree of property nodes each named by a field
    (`"pathName": "meta.match"`) makes receipts and `others` give
    `named: "transform/opacity.value.v"` beside the positional `field`
    (`props.children.2.children.7.value.v`). The SDK's rule names a node by
    that text, `#<n>` when it is empty, numeric or holds `/. # @`, and
    `<name>#<n>` for repeated names; a kit whose own path rule differs
    (matching display names too) gets close but not equal paths.

16. **Places in space**: a place a window cannot declare (a world
    point or a pick ray: what is there depends on geometry, the hierarchy, a
    parent's transform, visibility) answers `Under { objects, covers:
    Some(Covers { fields: vec!["hidden", "~bounds"] }), premises,.. }`
    instead of a window over the whole object list, and implements
    `KitDocument::covered(command, params, objects) -> CoveredAt`: with every
    object of `objects` put back in its `before` state at once (a `deleted` one
    recreated from `before`, a `created` one left out), what the place names
    (`under`), and for each object whether it or anything whose place derives
    from it (its children) is among them. Run the kit's own query on
    substituted values; change nothing. Answer `covered: None` for an object
    whose needed values are in `unknown`. `fields` names what besides
    `position` fields decides the place: a stored field (`hidden`) or a derived
    value (`~bounds`, item 17), so that a mesh edit that keeps the bounds (a
    subdivide, a vertex moved inside them) does not ask. Then a write by point
    is refused when the object there was moved away, another was moved in, or
    its parent moved, and not for a move, delete or reparent elsewhere.

17. **Derived values**: what an agent needs to know changed but
    no stored field holds alone (a mesh's topology: element indexes stay valid
    while it is unchanged; a mesh's local bounds) is declared on the type in
    the object model's schema, `"derived": { "topology": { "description": … } }`,
    and answered by `KitDocument::derived(ids, names)`: small values (a count,
    a hash, a bounds pair) computed from the document as it is now. Each must
    be computed deterministically from the document, including other objects:
    the server reads them for every object of a declaring type before the
    first write it records, after writes and on outside rereads, and keeps the last values read
    as their `before`. Receipts, `others` and the journal then name a changed
    value `~topology` beside the stored fields, with `before` and `after` when
    each is at most 200 bytes of JSON; a deleted object's values go in its
    `$was` (kept, never shown), so `covers` can read where a deleted mesh was.
    A premise may name one (`Premise::on(id).fields(["~topology"])`). The root
    (no tool id: a photo's `Image`) declares them too: `derived` asks
    and answers it by its object id (as a load answers its `id`), and
    `Premise::on(<root's object id>).fields(["~layerCount"])` holds it. Create the
    root with the same object id on every read (`Tx::create_with_id`): a change of
    the file then names the root's own fields and derived values in `others`
    (before, they were counted in `unnamed`); a change of its lists alone is still
    told by their items.

18. **Name list items by a member**: an item without a tool id in a list (a keyframe, a
    marker, a caption) named by its index in a premise (`transform/opacity.keys.1`) is followed
    only within one save: a colleague who changes that key and then, in a second save, inserts a
    key before it moves the change to another index, and the write applies over it. Name it by a
    member instead: `Premise::on(id).fields(["transform/opacity.keys[time=254016000000]"])` or
    `sequence.markers[id=7]`, optionally with a path inside it (`…keys[time=2].value`). The value
    is JSON (`7`, `"a b"`) or bare text and matches a member equal as JSON or as text (`time=2`
    matches `2`, `2.0` and `"2"`). The guard replays every save since `basis` from the list as it is
    now: the premise is touched when an item matching it was changed or removed, or an item that
    matches it now did not before (created, moved in, or given that member); index shifts of other
    items do not touch it. Use it for items without tool ids (an item with one is named by it). A
    held object with a tool id (a clip in a sequence its item holds through an owned ref) is held at
    its path (`sequence.videoTracks.0.items.3`), so a premise on `sequence.markers.0` is not
    touched by its change.

19. **Say what an id parameter names**: a target or object parameter that names objects
    of one type lists it (`KitCommand::object_types: &[("layer", &["Layer"])]`, marked
    `"x-khp-types"`): with `index_numbers`, `layer: 1` where `1` is a comp item's id is then a stack
    position, not that item. An object parameter may be a nested member (`objects:
    &["rules[].target"]`). A target that also takes names declares the field holding them
    (`KitCommand::name_field: Some("name")`): a write by name is refused as `relocated` when others
    renamed the object away from it or gave the name to another. Check every id parameter is
    marked with `testing::check_id_params(&commands, ALLOW)` (an integer parameter whose name or
    description says id, neither targets, object nor place, unless allowed). A numeric string in an
    integer id parameter (`clip: "9"`) reaches the command as the integer: no schema needs to take
    both.

## Carried Consequences

Implement `KitDocument::carried(ids, changes)` when an edit has consequences
on other objects that stored field changes alone cannot describe. For example,
a parent's movement changes its descendants' world transforms. Inspect the
changed fields and positions so a rename does not report a carried transform.
The host asks once per change set and attaches each answer as
`carries: {count, what}` on the responsible object's change in receipts and
`others`. Editor readers use the same callback through the premise bridge.
Carried descriptions summarize an edit; declare the corresponding dependencies
through `under`, `covered` and derived facts when a command reads them.

## Ids in receipts and `others`

A tool id on an `integer` field without prefix or parent (a clip `9`) is a number in receipts,
`others`, `footprint`, conflicts, `_query`'s objects (an object's id and the ids its ref, list and
tree fields hold), a batch's `loaded` and its `results` (the ids of what it created),
the form the kit's commands take; `on`, `_query`'s
`objects` and a batch's `target` and `item` take `9` or `"9"`, and `on` hands the command the type
its target parameter declares (`integer` or `string`). A position's parent (`at`, `from`, `to`,
`now`, a footprint) takes the form of the type whose field the position names (a track named `2`
stays `"2"`); only where no type, or several that disagree, have that field is an id of all digits
read as a number. A conflict's `id` takes the form of its object's type when a change set or a
read says it, else a number when all digits. Nothing for a kit to do.

A receipt (`changes`) and `others` name every object by an id the agent can use on its next call,
never by an object id a kit may mint again on its next read of the file:

- An object with a tool id: by its tool id (`shape:7/1`).
- An object without one that an object with one holds (through list and tree fields, refs and
  maps declared `owns`): under that holder, at a path (`shape:7/1` at `body.paragraphs.0.text`);
  a ref to it reads `<tool id>.<path>` (`shape:7/1.body`).
- A path through a map whose key is made of object ids (a table's cells keyed
  `<row id>:<column id>`): when the whole key, or every one of its `:`-separated segments, names an
  object that has a tool id or a place in a list, each reads as that tool id or that index, so a
  cell reads `table.cells.0:1` (row 0, column 1). Any other key (a segment that is no object, or
  whose object no list holds) stays as the kit wrote it.
- A ref to an object no tool id names and no such holder holds (a slide's layout, shared media):
  `{ "unnamed": "<type>" }`, the type the ref field declares (`{ "unnamed": "Layout" }`), as
  changes of such objects in a file read again are counted in `unnamed` by type.

So a kit gets usable ids in receipts by giving tool ids to what agents address, declaring `owns`
on the refs and maps that hold parts of an object, and keeping rows and columns in lists.
Exact known references inside maps and JSON values/keys also use tool ids in SDK replies
(`modelReply`, `ToolIds::show_reply`). A reply is the kit's own JSON, so a reference is read
from the text and its place: a string or a member name that is an object id the KDM minted (a
UUID; also a member name whose `:`-separated parts all are) wherever it is; any other object id
(one the kit chose, such as `project` for a singleton) only as the value, or an item of the value,
of a member that holds references: `id`, `ids`, `object`, `objects`, `target`, `targets`,
`selection`, `parent`, or a name ending in `Id` or `Ids`. A member name that spells a chosen id,
and a value elsewhere that equals one (`"note": "project"`), stay as the kit wrote them; text
that contains an id stays literal. The document's own values (`model/batch` loads of a `json`
or `map` field) use `ToolIds::show_json`, where every exact known id is a reference.

## In the open editor

When the person has the document open, the agent's run goes to the kit's
editor instead of its headless executable (Kit AI bridge). The person is
using the editor, so the host must not move their selection, current part or
playhead. The live reader uses the kit's callbacks and retains their comparison
basis on the server, as the headless reader does:

The live reader sends `kit/call` tool `premise` with `{method,params}` to the
host's `connection.ai.premise(method, params)`, which forwards `ai/premise` to
the editor. `@kition/kit-editor` calls the engine's synchronous
`premiseRead(method, JSON.stringify(params))`. Rebuild Rust engines using
`export_kit_document!` to export that method. Engines also supply
`editorState`, `restoreEditorState` and `setContext` to isolate selection,
part and time. Supplying only some hooks
leaves editor context unavailable. Those hooks change transient view state,
never the replica. `state` is dispatched automatically from `editorState`.
The capability is `premises`. Hosts must forward this request in addition to
`version`, `changes` and `batch`.

The Rust export dispatches `under`, `covered`, `content`, `identity`, `inputs`
and `derived` to the existing `KitDocument` hooks. The guard asks the live kit
for `under` (objects, windows, field/position, coverage, relative-order,
content and external-input holds), `covered`, direct `content` comparisons and
identity confidence after outside rereads.
The complete field basis reconstructed from the server journal is passed to
content callbacks. Explicit `on`, `part` and `time` are set with the person's
state restored after success or failure. Unsupported requests, malformed
`under` answers and unavailable comparisons refuse `unknown` after another
writer's edit. A successful `under:null` explicitly declares no extra premises.

The server observes implicit state and external-input fingerprints and evaluates
eager derived values around editor changes and receipts. `derived` must answer
every requested eager fact on each declaring object. On-demand comparisons get
the retained stored basis and other-writer transitions through `content` with
`field:"~<fact>"`, as headless. Full checkpoints require the `objects:true`
inventory and complete loads; limits are 20,000 objects, 256 revisions and
64 MiB. Outside rereads use schema pairing, including retained raw references.

Rust exports additionally answer `blob-support` and `blob` (current bytes).
Capture verifies SHA-256 and size before retention, reads at most 1 MiB per
chunk and uses the manager's historical-byte budget (64 MiB by default).
For a comparison the server supplies only retained hashes referenced by the
callback's basis values, authorized for that document and revision, in
`params.history:{hash:[bytes...]}`. That transport is bounded to 64 MiB of JSON.
Rust's `HistoricalBlobs` reads those supplied bytes; TypeScript callbacks use
the same map. Missing bytes must answer cannot-say.

Unavailable editor features refuse before execution:

- No `changes` capability (including editor drafts): a write with `basis`
  refuses conflict `unknown`, replacing the former applied `guardUnavailable`.
- Missing/malformed premise callbacks, incomplete eager facts, missing model
  inventory, expired checkpoints or unavailable historical bytes: affected
  holds refuse `unknown`; an unrelated change cannot establish a missing fact.
- No editor-state hooks: explicit context execution refuses `unsupported`;
  an implicit state premise without comparable history refuses `unknown`.
- Manager restart loses journals and historical caches. Reobserve for a new
  basis; a prior manager's basis cannot authorize a write.

These guarantees require matching SDK, editor and host versions and complete
kit declarations. The mock bridge exercises the server reader; worker tests
separately establish context isolation. They do not validate any real kit's
coverage algorithm or premise declarations.

- `export_kit_document!` gives the page `editorState()`,
  `restoreEditorState()` and `setContext()`, and `@kition/kit-editor` runs
  each agent step in an editor state of the agent's own: in one turn of the
  engine worker it puts the person's state aside, puts the agent's in place,
  sets the step's context, runs the command, keeps the agent's state for the
  next step and puts the person's back. The person never sees the agent's
  state, and a command that selects what it made does not change the
  person's selection.
- The editor lists the capability `context`, and the server then plans the
  run exactly as headless (`on` into the command's targets or the selection,
  `at.part` else the run's `target`, `at.time`) and refuses what headless
  refuses, with the same errors. A kit whose `editor_state` is `null` (it
  keeps no such state) does not list it, and a run in its editor that gives
  `target`, `on` or `at` stays `unsupported`.
- A preview of a view (`agent.render`) is the render command run in the
  editor with that view, as headless, checked against the command's schema as
  `ai/commands` lists it; in an editor that lists `context` it runs in the
  agent's own editor state too, so drawing another part or time never shows
  in the person's editor. In one that does not, it runs in the person's
  state, and only the kit's own rule (item 8: render by explicit view, no
  navigation side effects) keeps their view where it was.
- Limits: a step's `restore_editor_state` of the person's state runs after
  the step, so a selection naming an object the step deleted must be dropped
  by the kit as it would be on Undo; the agent's draft in the editor takes no
  context yet; the host application passes the editor's capabilities on in
  the bridge's `kit/documents` (`capabilities`), and until it does the server
  keeps the refusal.
