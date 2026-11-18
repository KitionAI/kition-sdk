# A kit as an environment: tasks, rewards, traces

An object type may declare `creation.fields`, a valid seed for
required immutable fields even when no same-type object exists. Otherwise
creation continues to copy immutable content from a same-type example and
sample required scalar values. `sample:false` on a containing field now
excludes creation in that container, as well as ordinary field edits.

For types that need domain initialization or actual media bytes, declare
`creation.command` using a command ID and parameter paths, plus kit-provided
`creation.fixtures`. Paths read `fields`, `in`, `at` and `fixtures` from the
proposed creation. For example:

```json
{"creation":{"fields":{"kind":{"shape":"image"}},
 "fixtures":{"image":{"mime":"image/png","data":"<base64 fixture bytes>"}},
 "command":{"command":"image.create","params":{"name":"fields.name","in":"in","at":"at","image":"fixtures.image"}}}}
```

The kit command ingests those bytes through its normal blob store, validates
them, and returns the created live object's ID as a string or `{id}`. A batch
command's `ref` binds that ID for replay. The same command and fixture source
recreate generated tasks; the environment retains complete created blob
references for scoring and still requires saved-state equality and a replay
with reward one. A fixture hash or byte count alone cannot create media.
Fixtures must be deterministic, small and suitable for inclusion in task
solutions. This declaration is a fixture source, not a network fetch.

Update Rust and TypeScript schema readers together. Raw creation and replay
operations also need the kit's `batchOps` premise contract; commands need their
usual declarations. Seeded task samples change when templates or exclusions
change.

The environment samples projected objects from the kit's complete computed model
view, alongside stored objects. Declare `projected:true`, stable IDs, virtual
list placements and writable `projectedOps` command mappings. Queries and batch
loads must expose the same projection. The environment generates set-field,
replace-text, create, delete and move tasks through those mappings, honoring
ordinary sampling/read-only exclusions. Missing mappings cannot produce a task.
Projected trees and owning refs are also readable nested containers. Generic
environment edit kinds still depend on a describable placement and a replayable
kit mapping; owning-map projection containers remain unsupported. Projected
objects and their membership are never stored.

Declare the stored source fields as `structuralConsequences`, scoped to the
owning container and applicable actions. `on` also accepts `set` for projected
scalar edits. For a text-backed document, the document can declare its `text`
field for `create`, `delete`, `move`, `rename` and `set`. Replay edits the computed
object through the kit command; settling must regenerate the source and the
complete saved state. Ground truth, scoring and reward checks still include
all consequences.
Update Rust/TS schema readers together; seeded samples change. See
[projection declarations and limits](../platform/kits/call-context.md#projected-objects).

Editor hosts can forward kit premise reads through `ai/premise`; this transport
does not change `kit-env` sampling or its headless traces. Rebuild Rust document
exports or implement `KitModel.premise` in a TypeScript engine, and forward the
new request in the host before relying on kit-specific editor call premises.
The server now retains editor basis checkpoints and verified blob bytes and
observes derived facts, implicit state and external inputs. TypeScript engines
supply all three `KitModel` editor-state hooks to isolate callback context.
Unavailable callbacks/history and editors without `changes` refuse writes with
`basis`; traces must retain that refusal. See [retention and adoption](../platform/kits/call-context.md#in-the-open-editor).

Headless task solutions using `Under.content` now compare
complete retained basis text and formatting, matching covered-place callbacks.
Unavailable history still refuses `unknown`; traces must preserve that refusal.
This does not change long-text task sampling. See [callback retention and
adoption](../platform/kits/call-context.md#content-history-and-rereads).

Batch adapters expose the live-object inventory with `objects:true`,
including replica-only objects outside root ownership. Kits that retain such
objects across rereads implement `KitDocument::carry_replica_objects`, choosing
keep, re-anchor or drop per object. Dropped objects appear in `others.deleted`;
task traces must keep a resulting `deleted` refusal. The environment still
samples persistent file content, so session-only objects are not task seeds.

Located text metadata distinguishes a complete replacement fragment from
an abbreviated field. Use complete spans for replay; never treat an excerpt or
truncated span as a whole value. Map footprints describe shifts of exact keys.

Root scalar and text fields are candidates, subject to the same
read-only, tool-id and `sample:false` exclusions as child fields. Declare the
type's `text` field (or a recognized label) for replace-text tasks. A long text
is edited around a seeded position: a word, line or sentence, bounded to 60
characters when needed. Instructions give the replacement, character position
and surrounding context, and name the root as the document.

Task ground truth retains complete located spans. Replay validates the removed
text, lengths and context against its actual basis; string fields use `set`,
text containers use `text.delete`/`text.insert`. Saved-state checks and reward
comparisons include the span location, so matching excerpts at another offset
cannot earn reward one. Incomplete/truncated spans are not replayable. Update
custom receipt adapters to preserve spans and the SDK pin; no new hook is needed.

Preserve precise refusal messages in traces. Covered callbacks may now
report removed content as `deleted`, including text inside a surviving root.

Command traces hold only declared references. Preserve id/name/target
schema markers when exposing commands; literal values matching an id are values.

Owning maps already participated in snapshot traversal on the
starting SDK. Field and text tasks now also name tool-addressable single owning
ref children. Owning maps gain create/delete tasks: a create uses a fresh key
from the vocabulary and an existing child's type; a delete removes the one
entry holding the child. Entries holding multiple objects are not deletion
candidates. Lists and trees retain their own structural operations. Empty maps
without an element type/example cannot supply a creation type.

Sampling chooses an edit kind uniformly, then an eligible object type uniformly,
then a candidate of that type uniformly. This keeps object types represented
even when one type has many candidates. Kits retain `owns:true`, expose the children in model loads, and accept
ordinary create/bind/map operations; map keys must satisfy the kit's own rules.
Required empty stored values are retained from saved snapshots for replay.

Tasks that create objects carry `bindings`, a map from each
recorded id to its create operation's batch `ref`. An episode learns the replay
ids from `refs`, carries them through subsequent steps and inverse setup, and
scores using those ids. A reference to a creation earlier in the same batch
uses its native batch binding. Traces include `idMap` and the actual arguments
sent to the kit. Standalone scorers can use `task.with_ids(&trace.id_map)` with
`score_files`; the map is empty for tasks without allocations.

Kits need no deterministic-id hook: keep returning complete batch `refs` and
ids that survive save/reopen. Rust callers constructing `Task`, `Observation`,
`Step` or `Trace` literals add their new fields (`bindings`, `id_map`, actual
`arguments`, and `id_map`, respectively). JSON gains optional task `bindings`
and trace `idMap`; existing operations and source documents are unchanged.

A type may declare, for example,
`structuralConsequences: [{container:"Sheet", on:["create","delete","move","rename"], fields:["formula","address.row"]}]`.
Each declared field may change as a consequence of one structural edit in the
same container instance. A move may affect its source and destination containers;
a rename holds the renamed container itself. Declare owning-map key changes on
the container too, such as `Sheet` with `fields:["cells"]`. Declarations name
stored field paths; a member permits descendants but never its whole parent.

The instruction and solution contain only the primary create/delete/move or
label rename. The kit's settling hook must regenerate consequences, and the
full receipt, saved-state comparison and reward retain every effect. Extra
structural operations, undeclared fields and effects in unrelated containers
are rejected. Object creation/deletion consequences beyond the one primary
object still require an ownership/cascade contract; this declaration permits
field consequences. The narrower owned-subtree `moveConsequences` contract
continues to have its existing meaning.

The mock tests cover forward create/delete/move/rename and inverse create/move/rename.
They do not cover inverse deletion requiring restoration of the deleted object's persistent
identity. The generator rejects any trace whose complete
saved-state replay differs; a declaration does not waive that check.

Update Rust and TypeScript schema readers together. Explicit Rust `TypeDef`
literals add `structural_consequences: vec![]`; the new exported
`StructuralConsequence` contains `container`, `on` and `fields`.

Observations now receive tool ids for exact known references
inside maps/JSON. Custom observation replies use `ToolIds::show_json` /
`ToolIds.showJson`. Declare empty places or stable absent source ids even when
they have no current object; creation by another writer can invalidate them.
`covers` and `within` continue to hold independently. On-demand private facts
work in both host-managed headless and live-editor readers. Editor comparisons
use retained checkpoints; materialized stored holder facts remain an optional
alternative. Missing history refuses `unknown`. See [agent adoption](agent.md).

A type may declare `moveConsequences: ["address.slide"]`, with the
root field marked `position:true` (and normally `sample:false`). A move task may then contain one structural
move and edits only to those declared paths on the moved object and its owned
descendants. Other field edits, unrelated holders, creations, deletions or a
second move still make the instruction incomplete. A declaration on a JSON
member permits that member and its descendants, never a write of its whole
parent. Update both Rust and TS schema readers; explicit Rust `TypeDef` literals
add `move_consequences: vec![]`.

The kit must regenerate these values when replaying the move through its batch
adapter or settling hook. The solution contains the structural move; it does
not directly write consequential addresses. Ground truth and reward units keep
the full receipt, including address edits on group children. Forward and inverse
tasks must still replay to the same saved state. Opted-in tree types also gain
cross-container destinations in the same tree, excluding the moved subtree.
The mock regression samples a group, child and grandchild in both directions
and verifies each selected group's trace.

Guard adoption also applies to task solutions: use `Under.orders` for relative
order, `within` for root/scoped-address windows, `Covered.content` for changed
range content and full private text basis values for long text/formatting.
Holder-specific private facts can declare `{premiseOnly:true,onDemand:true}`
and compare supplied historical models in `content_at`; they stay out of
snapshots and reward units. Ordinary derived facts remain eager. See the
[declarations and retention bounds](../platform/kits/call-context.md#order-content-and-private-facts).

Task solutions may return multiple premises on one object;
the guard joins them within calls and across steps. Update the SDK; no task
format or kit-side join is required.

Indirect derived dependencies are compared on their holders. Declare and compute
the fact on its holder; the task format does not need a separate declaration.

`derived.<name>.premiseOnly: true` keeps guard-only facts out of public
receipts and `others`. Snapshot reads already exclude derived fields, including
these facts; no environment task change is required. Update schema readers.

Kits with ambiguous file identity implement `unproven_identities`.
Task traces retain `unknown` after outside rereads and must observe again;
the hook does not change snapshot pairing or reward scoring. Equal-model
rereads also consult the hook and retain uncertainty in private guard history.

Observations must expose external sources through `external_inputs`
before a task solution consumes them (`Under.inputs`). Trace bases include
fingerprint observations even without document edits. A read command may
register an import source; unavailable sources return `None`. External bytes
are not part of snapshots or rewards: task fixtures still supply the files.

A type may declare `text: "kind.words"` (or another field/JSON member
path). This selects replace-text candidates, supplies a default label and
uses "says" and "the text" in instructions. An explicit label still wins for
naming. Objects lacking a string at the path are not sampled; top-level
read-only and `sample: false` rules remain enforced. Ground truth keeps full
changes; compact public receipts may now group identical assignments as
`{ids,edits:[{field,after}]}` without truncating ids. Update Rust/TS readers.

Single-member and local-integer windows ignore unrelated structural edits,
both through the server and after outside file changes.

Time-dependent solutions declare `within` over the consumed JSON or
model collection, with stable `time.identity` for JSON arrays. Map keys may
supply identity. This retains removed caption/key membership in history;
current-only entry premises cannot do so. Batch-command solutions can carry
`on` and `at: {part,time}`; update custom adapters to apply/restore context.
Types may declare `batchIndependent: true` so raw field tasks ignore unrelated
list/ancestor positions; undeclared types retain positional holds. Literal
strings do not introduce reference holds.
Paired raw batch references survive saved rereads within the manager's bounded
reference registry; fresh observations are required after restart/eviction.
Snapshot/reward formats are unchanged. Failed indirect derived reads now
refuse `unknown` rather than silently accepting a task solution.

Pin the matching SDK/schema reader and accept the new assignment
footprint form before adopting these declarations. See the [adoption and
limits](../platform/kits/call-context.md#premises-identity-and-external-inputs). External sources
still belong in task fixtures; neither identity confidence nor external
fingerprints change snapshot pairing or reward scoring.

Creation solutions recursively create owned ref targets and their
containers before referencing them from the new owner. A slide's `notesBody`
therefore remains a ref to a separately created TextBody rather than a flattened
unresolved id. Keep `owns: true`, complete model loads and creation receipts;
task consumers accept the ordered create/bind/container operations. No new hook
or deterministic id allocation is required.  Nested move paths resolve through owning lists and refs, so either the
composition id plus `layers` or its held path can be used. Update the SDK and
remove invalid-path workarounds after the kit's replay tests pass.

Positional batch task solutions now hold their source and destination windows
automatically, including nested lists and tree children; no extra command place
declaration is required. Use pre-removal indexes. See [batch validation and replay](../platform/kits/call-context.md#batch-validation-and-replay).

Kits using the Rust session adapters enable `kition-kit/session` for numeric
limit, settling and blob-source hooks. A custom model server can keep the base
SDK without that feature and implement the documented wire methods itself.

Historical pixels remain available across document and worker reopen while
the manager retains their basis and bytes. A manager restart or corrupt source
requires a fresh observation; task traces must preserve cannot-say as `unknown`.
The manager also bounds the latest before-model checkpoint for blob-enabled
documents by the byte limit and 20,000 objects; missing checkpoints refuse unknown.

Conditional sampling: implement `KitDocument::value_limits` when a
numeric range or step depends on the object's metadata. Model loads return
`limits` by concrete path; custom model servers must provide the same property.
The sampler intersects those bounds with the schema's bounds and verifies both
steps. Keep same-type examples for creation, whose copied values are validated
with their copied metadata. Map constraints use exact member keys or `*`;
nested nullable integers use `multipleOf: 1, nullable: true`.

For window-dependent tasks, return `Under.within` for the actual held list.
The window is enforced for id-addressed holders too. Point ordering fields use
`time.start` with no `end`/`duration`; keep ordinary field premises for content
the command reads. Task solutions use the same guarded calls as direct edits.

Adoption:

1. Follow the [model declarations and history contract](../platform/kits/call-context.md#model-declarations-and-history).
   Existing field/name/selector declarations remain valid. State-dependent
   commands must declare `reads` and expose canonical state through context
   hooks; absent history refuses unknown with basis. Point picking that depends
   on old pixels opts into historical capture with `blob_source`/`covered_at`.
2. Numeric JSON sampling follows every nested leaf and wildcard constraint in
   `members`: `a.b`, `a[]`, `a[].b`. Declare actual numeric bounds and steps requires numbers at bounded scalar member paths. Declare
   `nullable: true` to allow null; strings and booleans refuse. Containers remain
   valid with deeper declarations checked independently. Declare both
   `resolution` and `resolution[]` for number-or-array values. Batch validation
   uses the same rules in Rust and TypeScript; update both SDK pins.
3. For group-delete tasks, declare `cascade: true` on the tree field. Default
   tree tasks remain child-first/leaf-only. The generator admits a cascade only
   when the receipt is exactly the complete owned subtree with no other stored
   effect, names the group and its contents, and replays the root delete. Return
   all descendants in the receipt. Add `cascade: false` to Rust field literals.
4. Keep `owns: true` on maps and expose all map-owned records through model
   loads. Snapshots now traverse direct and record-member references, normalize
   their ids and include their stored consequences. Map-owned named records are
   sampled for field edits with deterministic key order; map containers are not
   sampled as list move/delete destinations. There is no new environment hook.
5. Region-dependent writes can return `Under.content` and implement
   `content_at` to compare only the relevant pixels. The guard records ordinary
   fields independently; it never drops a whole-field hold from another step.
6. Historical bytes use a bounded per-journal host cache, independent of kit
   reloads. Expose the current session's `BlobSource`, then use `HistoricalBlobs`
   inside `covered_at`/`content_at`; return cannot-say after eviction. This does
   not change task storage or require deterministic blob ids beyond SHA-256.
7. Update Rust and TypeScript pins together before emitting `cascade` or nested
   member declarations. Accept complete subtree receipts and map-owned field
   consequences in task consumers. No sibling kit repository was changed.

Adoption:

1. Update the SDK pin for ordered guards. Existing empty-gap declarations remain
   correct for insertion and move destinations. Unnamed deletions/moves retain
   their positions privately in the journal, so a changed gap neighbour refuses
   `relocated`. Neighbour field edits and structural changes strictly after the
   gap apply; non-empty windows do not hold adjacent objects outside the window.
   List, tree, stored/reversed indexes and source position premises follow the
   same declared dependencies. No environment hook is needed.
2. Keep `readOnly: true` on registers that are immutable after creation, including
   a required `kind`. Both Rust and TypeScript accept them in `create.fields`,
   validate their values, and refuse later edits atomically. Sampling copies them
   from a same-type example; replay reads them from `created[].values`. Keep such
   an example in input files. Tool-id allocation stays with the kit, and type-level
   `readOnly`/`readOnlyWhen` restrictions still apply. No new schema word is needed.
3. Keep existing ids stable through save/reopen and return complete creation
   receipts. Fresh allocations may differ between the original task and its replay:
   `remakes` matches only receipt-created objects by type and final place, follows
   created parents, and renames references consistently before comparing states.
   A different value, order, reference target or pre-existing identity still fails.
   No deterministic-id allocator or kit hook is needed.
4. Task consumers must accept immutable registers in creation solutions. The
   [kit adoption table](../platform/kits/call-context.md#ordered-places-and-creation)
   describes the required declarations.

Traces with `basis` now refuse stale child moves when a
declared parent position such as `frame.transform` changed at a leaf. Kits
update the SDK and may narrow whole-`frame` workarounds to that path; no
environment-specific change is required. Ancestors and descendants overlap
on dot-separated segments, while similarly named members do not. Field and
derived premises keep their existing segment-overlap behavior.

Creation copies JSON fields, including required structured
values (`kind: {"type":"frame"}`), from the seeded example object of the
same type already used for scalar fields. This also applies to `sample: false`
fields, which are excluded from field-edit sampling, not creation. Kits need
only keep these fields writable and have an example in the document; no new
schema property or hook is required. When a required JSON value has no example,
the candidate yields `no-value`. Saved reread, replay and instruction checks
still have to pass before the environment emits the task.

Default tree-node deletion is child-first. The sampler
chooses only objects holding no others for a default-tree `delete` task. Kits constructing
their own batch solutions for deleting a group must delete descendants before
the group in one batch, or move them first; a single nonempty-node deletion
refuses `invalid-value` with that instruction. Declare per-tree
`cascade: true` for kits whose commands delete a group and all its contents.
Deleting an owner continues to traverse its owning fields.

For names stored inside root JSON (channels, patterns,
comps, search bins), kits may attach an `identities` map to a selector premise
to distinguish `deleted`, `relocated` and `changed`. Expose an immutable unique
entry key that survives save/reopen and call `Premise::identity(selector, key)`;
continue declaring the original name even when it is absent now. Without
this optional hint a plain selector remains a conservative `changed` guard.
Missing or duplicate declared keys refuse `unknown`. The conflict's `id`
names the holder and `place.selector` names its entry. No environment hook is
needed; explicit Rust `Premise` literals add an empty `identities` map. See
the [kit recipe](../platform/kits/call-context.md#nested-paths-and-selector-identity).

Pin the updated SDK and follow the
[per-item kit checklist](../platform/kits/call-context.md#nested-paths-and-selector-identity).
No new environment hook is required. Task consumers must accept structured
JSON in creation solutions; kits must provide example values for required
JSON registers. Group-delete solutions remain child-first. For refined named
resource conflicts, retain stable entry keys and declare identity hints as
the [agent guide](agent.md) describes. Explicit Rust `Premise` literals add
`identities`; existing builder calls and wire premises continue to work.

Generated instructions must describe every stored effect in their
ground truth, including consequences on `sample: false` fields. Current
templates describe one field edit, creation, move or deletion; a mixed effect
is discarded as `instruction-incomplete`, except for the declared move
consequences described above. Derived `~` consequences are
descriptive metadata and are excluded from stored-effect comparison. A kit
keeps its sampling declarations; no extra hook is required.

Creation replay puts only stored register values in `create.fields`, binds
the new object, and follows with the field's container edits (`text.set` and
`text.mark`, `map.set`, `list.insert`, `tree.insert`). It skips derived values
and allocated tool-id fields. Creation-only read-only registers are included.
Saved rich-text runs, including marks, appear in
creation ground truth and instructions, and scoring compares those runs; a
solution that drops marks cannot earn full reward. Task consumers must accept
the new creation solutions and run-valued text, without assuming all creation
values are scalar or all text values are strings.

Numeric sampling now also covers stable/addressable objects' JSON fields and
immediate numeric members. Declare `minimum`, `maximum`, `multipleOf` on a
numeric `json` field, or `members: { roughness: { minimum: 0, maximum: 1 } }`
on an object-valued `json` field. The sampler and atomic batch validation use
the same member bounds. Command schemas accept the same numeric keywords and
publish them to MCP, although this environment still samples model edits.

Other adoption details: insertion and move-destination commands keep declaring
their empty index gap `[i,i)` in `places`/`under`; stale edits before it now
refuse `relocated`. Point-or-name/id unions use `name_params` without treating
coordinates as references. Kits with a separate replica cache override
`KitDocument::batch_applied` so direct and Exchange model transactions refresh
it before later commands. Explicit Rust `FieldDef` literals add `members`.
See the [complete adoption table](../platform/kits/call-context.md#insertion-gaps-and-cached-state).
Historical blob access uses the opt-in [bounded cache](../platform/data-model.md#historical-blob-bytes).
Unavailable reads still require cannot-say from the kit.

Deleting a tree item now compares equal in its receipt
and saved-file reread, and move/create candidates include sibling groups
under tree nodes. Batch ownership cascades make motion/film item deletions
account for their owned comp/sequence and descendants. Type-scoped name
parameters keep scene's object/material names separate, and `model.carried`
receives fields/edits so a parent rename does not claim to move descendants.
Kits adopt the [declarations and hooks](../platform/kits/call-context.md#ownership-names-and-values);
these require no environment-specific editing implementation.

Source failures and wording: generation returns `skipped`,
an ordered list of `{file, reason}`, and the CLI reports each entry on stderr.
An unreadable file does not consume a task slot or abort other files; if every
file is unreadable the result has no tasks and reports them all. Stable-id
incompatibility is still an error. References, holder chains and destination
positions count from the last item for types with a command's
`x-khp-index-order: "reversed"` declaration. Batch indexes stay in stored order.
Boolean instructions use `Set... to <label>` / `not <label>` (the field's
`label`, otherwise its words), and `back to` for inverse tasks.

Blob basis values  now keep their hash and metadata in
`before`, including deletions. This identifies the previous value but does not
make blob edits replayable: the SDK does not retain old bytes across reloads.
Such values still need a kit's blob store to restore them.

Numeric sampling  reads `minimum`, `maximum`, `multipleOf`
from number/integer model fields, including held fields. It samples a different
valid value on that step inside the bounds, or skips the candidate when none
is available. Kits with quantized file values implement
`KitDocument::batch_settler` so ground truth already names the stored value.

`kition-env` (a Rust library) and its command line `kit-env` make any kit that the kits server
runs headless a training and evaluation environment, with no code for that kit. From a folder of
files it **generates** editing tasks with ground truth, **scores** an attempt with a reward that
includes "nothing else changed", and **emits** traces of solved tasks. Everything is
deterministic and offline: no model is called.

What a kit needs: a headless executable and a `kit.json` that declares `agent.objectModel`, so
that the server offers `<prefix>_query` and `<prefix>_batch` (see [agent.md](agent.md) and the
[object model](../platform/sets/object-model.md)), and the ids its tasks and receipts name
objects by surviving saving and reopening the file: tool ids (`toolId` in the schema,
KitObjectModel OM9) count, so a kit that mints new object ids for its other objects on every
read (a text body, a paragraph, a layout) qualifies; a kit that declares no tool ids needs stable
object ids. Objects of a kit that declares tool ids and that have none (a shape on a slide
layout, a paragraph) are never sampled (counted as `no-tool-id`); their changes are told under
the object holding them, as receipts tell them. States read again are compared by pairing their
objects as two reads of a file are (`kition_kdm::reread::diff_paired`), never by object id. An
object with a tool id that a json value or a map names by its object id (a connector's
`look.kind.start`, a click action's slide) is named there by its tool id, which the kit answers
for it, so a reopen that mints new object ids does not read as a change there.
`<prefix>_check` gives the diagnostics; a kit without it can still generate and score, with
`diagnostics` always 1.

## Generating tasks

The examples on this page use a slide kit, whose object model shows every kind of edit; that kit
is not published yet. The published Note, Table and HTML kits work the same way (`--kit kit.note`, `--kit kit.table`, `--kit kit.html`).

```sh
kit-env generate --workspace corpus/ --kit slide --seed 7 --count 200 --inverse-share 0.3 \
  --kits-dir kits > tasks.jsonl
```

For each task, in turn over the workspace's files the kit edits (sorted by path, hidden folders
skipped), a sampler seeded by `seed` and the task's index reads the file's object model through
the agent's tools (`<prefix>_query` with `describe: "*"`, then every object reachable from the
root) and picks an edit kind, then an edit of that kind:

| Kind | Edit | On |
| --- | --- | --- |
| `set-field` | a scalar field to another valid value: another of an enum's values, the other truth value, an integer or number a small step away, or a value the same string field has on another object of the type | enum, boolean, integer, number and string fields other than the object's label and those its schema marks `"sample": false`; also of an object without a tool id that one with a tool id holds, written through it at a path (`{ op: "set", target: <shape>, field: "body.paragraphs.0.text" }`), and a number in its json field, at its top or one member down (a property's `value.v`) |
| `replace-text` | the object's label to a word of a built-in vocabulary | the label: the type's declared `"label"` (a field or a member of a json field, `props.name`), else its `text` field, else its first string field named `text`, `name`, `title`, `label`, `caption` or `content` |
| `delete` | delete the object | an object a list holds that holds no objects itself |
| `move` | to another index in its list, or into the same list field of another object of its parent's type | an object a list holds |
| `create` | a new object at a sampled index, with stored values of an object of its type and its label from the vocabulary; containers are replayed through their edit forms | a list field whose item type is not read-only |

Never sampled as field edits: read-only types and fields (OM8), the field holding a type's tool id (OM9), the
enum of `readOnlyWhen` and the objects it makes read-only, and objects a person cannot name (no
list holds them; counted as `not-describable`). Derived values declared by the type and
reported with `~` are never written back. Creation copies immutable registers from
a same-type example; it does not sample edits to those registers. Keep editor-state fields outside the model.

Each sampled edit runs as one `<prefix>_batch` on a copy of the file in a workspace of the
generator's own (the source files are never changed). It becomes a task only when every check
holds; otherwise it is discarded, recorded in the next task's `resampled` with its reason, and
another edit is sampled (8 attempts a task):

| Reason | The edit was discarded because |
| --- | --- |
| `refused` | the kit refused the batch |
| `new-error` | `<prefix>_check` reports an error diagnostic the file did not have |
| `no-change` | the receipt is empty |
| `no-receipt` | the kit answered no change set (`changesUnavailable`: it reports no `model.version` and `model.changes`) |
| `receipt-differs` | the receipt is not the difference of the file's states read again after saving |
| `long-text` | the change set shows a value only in part (a text over 80 characters, a blob) |
| `not-replayable` | the receipt's own operations do not remake the edit on a fresh copy |
| `inverse-not-restorable` | (inverse tasks) undoing the edit does not restore the original state |
| `not-describable` | an object the instruction names cannot be named unambiguously |
| `no-value` | the sampled field has no other value to take |
| `effect-differs` | (set-field, replace-text) the write changed more than that field: objects created, deleted or moved, or other objects changed (setting an item's `kind` remakes it and its layer goes), so the instruction would not say what it does  |
| `instruction-incomplete` | the stored effects contain more than the instruction's single edit, creation, move or deletion, including effects on fields marked `sample: false`  |

The receipt of the accepted batch (`changes`, as [agent.md](agent.md) describes it) is the ground
truth, with derived metadata removed and creation text restored to its saved runs. An **inverse**
task (`--inverse-share` of them) starts from the edited file and asks to restore what the edit
changed; its ground truth is the receipt of restoring it. A deleted object cannot come back
with its id, so `delete` makes forward tasks only.

### The task record

One JSON object a line, keys sorted:

| Key | Value |
| --- | --- |
| `id` | the first 16 hex digits of SHA-256 over the file's bytes, the seed and the index (little-endian 64-bit) |
| `kit` | the kit's id (`kit.slide`) |
| `file` | the file, relative to the workspace, `/`-separated |
| `seed`, `index` | the run's seed and the task's place in the run |
| `kind` | `set-field`, `replace-text`, `delete`, `move` or `create` (the forward edit's, for an inverse task) |
| `instruction` | one sentence (below) |
| `groundTruth` | the change set: `{ created, changed, moved, deleted }` |
| `inverse` | whether the task starts from the edited file |
| `setup` | inverse tasks only: the `<prefix>_batch` operations that make the edited file from `file` |
| `solution` | the `<prefix>_batch` operations that make the ground truth from the task's starting file, checked when the task was made |
| `resampled` | the edits discarded before this one: `[{ kind, reason }]` |

The same files, seed and options choose the same samples and instructions. Kits
with deterministic allocation give byte-identical lines; a kit that allocates
random ids may give different ids in creation receipts while the task id and
the requested edit remain the same.

### Instructions

Instructions are filled templates, one per edit kind and direction, not natural language. They
name objects as a person reads them in `<prefix>_inspect` and `<prefix>_query`, never by id:
by type (`TextBox` reads `text box`), by its label when no sibling in its list has the same
(`the shape that says "Q3 revenue"`), else by its place among its siblings (`the 2nd shape, which
says "Same"`), and where it is, by the type and position of each object holding it (`On slide
3`). A type without a label is named by position (`slide 3`). The words name the field the quoted
label is: "says" only for text content (a `text` field, or a string field named `text` or
`content`); a `name` is quoted as `the shape named "TextBox 1"`, a `title` as `titled`, a `label` as
`labelled`, a `caption` as `captioned`.

```text
On slide 1, change the text of the shape that says "Q3 revenue" to "Q4 revenue".
On slide 2, change the color of the 3rd shape, which says "Same", to "red".
On slide 1, delete the shape that says "Body".
Move the shape on slide 1 that says "Footer" to slide 2, at position 2.
On slide 3, add a new shape with text "Key results" at position 1.
On slide 1, the text of the shape that says "Budget" was changed; change it back to "Body".
On slide 2, the shape that says "Next steps" was added; delete it.
```

## Scoring

```sh
kit-env score --task task.json --before deck.kslide --after attempt.kslide --kits-dir kits
```

The scorer reads both files through the kit (in a workspace of its own) and compares their
states with the SDK's change sets, so an attempt scores the same whether it was made with the
kit's tools or by any program that rewrote the file. It cuts the ground truth and the attempt's
change set into units: each changed field, each created object (its type and list; its id is the
kit's to give), each moved and each deleted object.

```text
reward = intended × preserved × diagnostics
```

| Component | Value |
| --- | --- |
| `intended` | the share of the ground truth's units the attempt made with the right values: a field's value after; a created object's index and values (fields the kit keeps aside); a moved object's place. Texts are compared trimmed and in Unicode normalisation form C, or as they are with `--exact` |
| `preserved` | `1 / (1 + n)`, `n` the number of objects the attempt changed beyond the ground truth's units; 1 when nothing else changed |
| `diagnostics` | 1 when the attempt brought no new error diagnostic (by code and target), else 0 |

The answer also lists `matched` and `expected` units, the `missing` units, the `collateral`
changes (`{ change, id, type, field, before, after, … }`) and the `newErrors`, so a trainer can
weigh the three components otherwise. Doing nothing scores 0 (`intended` 0); the right edit with
one unrelated object changed scores 0.5. `score_changes` scores an attempt's own receipt
(`changes` and `diagnostics.new`) instead, for a caller that trusts it.

## Traces

```sh
kit-env trace --tasks tasks.jsonl --workspace corpus/ --kits-dir kits [--find] > traces.jsonl
```

A solver picks each next tool call from the observation and the steps so far; the built-in
oracle replays the ground truth the way an agent works: `<prefix>_inspect` with a preview,
`<prefix>_batch` with the task's solution (its receipt says what it changed), `<prefix>_check`.
With `--find` it first reads the object model, `<prefix>_query` with `describe: true` and then
the objects each read names, until every object its batch names has been answered by a read, so
the trace shows how the targets were found rather than only naming them.

One JSON object a line, emitted only when the reward is 1:

```text
{ "task": { …the task record… },
  "steps": [{ "tool": "slide_inspect", "arguments": { … }, "result": { … } }, …],
  "reward": { "reward": 1, "intended": 1, "preserved": 1, "diagnostics": 1, … } }
```

A result is the tool's output, or its failure (`{ error, … }`); previews are `previews: [{
caption, png }]`, and every image (a PNG in base64 or a `data:image/…` URL) is replaced by
`sha256:<hex>` of its bytes.

`kit-env stats --tasks tasks.jsonl` answers `{ tasks, forward, inverse, kinds, resampled,
resampledKinds }`: tasks per kind, and the discarded edits by reason (and by kind and reason).

## The environment API

```rust
let mut env = Environment::new(kit, Path::new("corpus"));
let observation = env.reset(&task).await?; // { task, instruction, path, workspace, tools }
let step = env.step("slide_batch", json!({ "ops": [...] })).await?; // { result, done }
let reward = env.score().await?;
```

`reset` starts an episode in a fresh temporary workspace holding the task's file (an inverse
task's edited by its `setup`) and ends the last one, removing its workspace. `step` passes one
call to the kit's agent tools on that workspace (`path` defaults to the task's file; a tool that
is not the kit's is an error, a path outside the workspace is the tool's refusal) and says `done`
once the step budget (32 unless set) is spent. `score` saves unsaved edits and answers what the
standalone scorer answers for the file as the episode started and as it is now.

Agent-environment frameworks of the reset/step style (an episode starts from a task and answers
an observation; each action is a step; a terminal reward) wrap it directly: the action is a tool
name and its arguments, the observation is the step's `result`, and the reward is `score()` at
the end of the episode (or after any step, for shaped rewards). The library has no transport and
no server; it makes no claim of conformance to any framework's interface.

## Command line

| Command | Does |
| --- | --- |
| `generate --workspace <dir> --kit <id or extension> --seed <n> --count <n> [--inverse-share 0.3] [--kinds <kind>,…]` | tasks on standard output; a summary (tasks, tasks given up, resampled reasons, objects not sampled) on standard error |
| `score --task <file\|-> --before <file> --after <file> [--exact]` | the reward as JSON; the task file holds one task |
| `trace --tasks <tasks.jsonl> --workspace <dir> [--find]` | the oracle's verified traces |
| `stats --tasks <tasks.jsonl>` | the counts above |

Kits are found as `kition-kits` finds them: `--executable <path>` (repeatable), `--kits-dir
<folder>`, `KITION_KIT_<KIT>_BINARY`. Exit codes: 0 done, 1 failed (a kit, a file), 2 wrong usage
(with the usage on standard error).

## Limits, and what a kit can add

- Only the generic edits above, written through the object model. A kit's commands (`<prefix>_run`
  steps that format, lay out or recompute) are not sampled; a kit could later offer command-level
  edits with their own validity rules, or task kinds of its domain (fix a formula, retime a clip).
- Words a kit can give: a type's `"label"` (`props.name`) names its objects and the
  objects holding others (`on the sequence named "Sequence 01"`); a field's `"display": { "kind":
  "time", "perSecond", "fps"? }` shows its values in instructions as timecodes (`00:00:05:00`), the
  ground truth and scores keeping them as stored; `"sample": false` prevents choosing a field
  but does not hide its consequences from completeness checks. A
  hook through which a kit formats any value its own way is not built: the declaration covers
  times, and a hook would be a protocol request per value worded.
- Instructions are templates: "change the color of … to "red"" is not how people phrase every
  request. A kit's own words for its types and fields (a display name in its schema) would make
  them read better; today they are the schema's names in words.
- A label is guessed from field names; a kit could mark the field that says what an object is.
- Derived `~` values are skipped. The schema has no editor-state mark; keep editor state out
  of persistent model fields.
- Objects are named by the ids the tools use. A kit without tool ids whose object ids change when
  the file is reopened cannot be compared from files: `generate` reads each file twice and refuses
  such a kit at once, saying so; a kit with tool ids is refused when they change.
- Objects without a tool id are addressed through the object with one holding them:
  `set` and `text.set` take `field` as a path from the target through owning fields (a ref or map
  declared `owns`, a list by index; not a tree) to a field of a held object, positional
  (`props.children.2.children.7.value.v`) or in the kit's words where the types on the way declare
  `pathName` (`transform/opacity.value.v`), past a json field into its value; `kition_kdm::batch`
  and `@kition/kdm` `batch.ts` resolve them alike (shared fixture `batch-paths.json`). Receipts
  name such a change at that path, so `ops_for` replays it as is, and the premise guard's premise
  for the op is that path. The sampler adds held objects' scalar fields as `set-field`
  candidates, named through their holder (`change the text of the 1st paragraph of the shape that
  says "Q3"`, `change the value v of "transform/opacity" of the layer named "L5"`). A path whose
  first name has no `/` is read as positional: a node named in the kit's words at the top of its
  tree (`transform.value`) is reached by its position only. A held `text` field (rich text) is not
  sampled: `ops_for` replays a receipt's path with `set`.
- An object a ref declared `owns` holds (a video kit's sequence in its project item, a motion
  kit's comp in its item) is named through its holder: the clips of a sequence read `In track 1 in
  video tracks on item 2 on bin 1`. A tree's nodes have places among their siblings.
  The object itself (the sequence) is not named, and counts as `not-describable`.
- A type with no label field (a video kit's clip: `start`, `duration`, `sourceIn`, no name) is
  named by its position only (`the 3rd clip`): a kit makes such tasks read better by giving the
  type a label field the tools show (a clip's `name`, its source's name), or a `pathName`.
- Texts longer than 80 characters are shown in change sets as excerpts, so edits of them are not
  sampled.
