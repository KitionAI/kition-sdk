# The Kit Data Model: an introduction

Tree structural changes are told by the affected items'
`created`, `moved`, `deleted` entries, without an empty-edits holder entry.
Batch deletion walks `owns` refs/maps and owning lists/trees, children before
holders, atomically; a non-owning ref is left alone. Rust and TypeScript use
the new shared `delete-owned.json` fixture, leaving older fixtures intact.
Tool-id-less parts retain normal holder attribution. Command name resolution
honors parameter type declarations and additional `name_params`; deleted
objects' names are retained in journal values for the guard. Carried effects
are computed from each changed/moved entry, including fields and edits, so
content changes such as renames do not imply spatial movement.

Environment metadata: a field's optional `label` is its
human wording, used as the positive state of a boolean. Rust and TypeScript
preserve it in model describe. Reversed ordinal words come from command index
declarations and do not reverse canonical lists, trees or batch indexes.
Unreadable environment input files are reported and skipped individually.

## Positional Batches And Replay

The SDK automatically derives gap/window premises for model creation at an
index, list insert/move and tree insert/move. Destination gaps hold their
neighbours and boundaries, and moves hold their source. Nested container paths
resolve through lists and owned refs at supported path depths. Move indexes use
pre-removal coordinates. Kits update the SDK without a new schema property or
hook; use either `target:"comp:1", field:"layers"` or the actual nested holder
path. A raw operation on a nested holder path (`target: 1, field: "comp.layers"`,
the place a receipt's move names) is checked with the `batchOps` contract of the
object holding its last field (the comp's `list.move.layers`), on that object; an
operation that object declares no contract for still refuses. A receipt's parent
is a `target` as given, the number `1` or the string `"1"`. Strictly unrelated
later list edits remain independent.

Environment creation replay reconstructs the owning graph: create referenced
objects first, bind their refs, restore their containers and then create the
owner. Kits keep `owns: true` and expose complete values/loads. Consumers of
task solutions accept multiple operations for one conceptual creation. The
saved-state replay checks preserve object/reference identity under consistent
renaming of fresh ids. No KDM storage-format change is needed. See the
[batch validation and replay contract](kits/call-context.md#batch-validation-and-replay)
for the required declarations and retention limits.

## Historical Blob Bytes

Rust `blob_source` and batch settling/conditional-limit hooks belong to the SDK's
`session` feature. Core kit contracts build without KDM or that feature.

List windows hold membership even when a command addresses the holder
by id. Ordinal windows use `[from,to)`; time/space windows use `time.start` and
optionally `end` or `duration`. With neither, `start` is a point ordering field
(for example a key's time). Entries inserted, removed or moved into/out of the
window refuse, including changes later reversed in the journal. Changes outside
the window and member content not otherwise held remain independent.

An ordinal window holds which objects are at its positions `[from,to)`, the
indexes the kit answers for the list as it is now, which name the same positions
in every version of the list. Each change by another writer is read in the list
just before and just after it: it refuses when it creates or deletes an object
inside the window, moves one across an end of it (in or out, to another list
too), shifts one across an end by inserting or removing items before the window
(the window counts positions, so an insertion or removal before `from` changes
which objects are in it), or changes a member's `position` field. A reorder among
the members (every object stays inside) applies, as do edits after `to` and
member content not otherwise held; hold an exact order with an id's position
premise (`positions: [<list field>]`) or `orders`. A window over a whole list
starts at 0 and ends past the last item, `[0, n+1)` for the `n` members there
are now: the kit answers it after others' changes, so a window ending at `n`
would leave a removed last member (at index `n` before its removal) outside it.
`[i,i)` is an insertion gap, which holds its two neighbours.

The SDK retains historical bytes across headless file reloads. Complete blob
references remain in journal `before` values; public `after` values remain size
summaries. A kit opts in with `KitDocument::blob_source()`, returning its open
session's `BlobSource`. Headless advertises `model.describe.blobBytes: true`
and serves ranged `model.blob.read {hash,offset,length}` requests. Custom kit
servers implement these methods themselves. Existing kits do not opt in and
their existing `covered` hooks continue to work.

Before issuing a revision and before replacing an outgoing session on an
outside reread, the manager follows the entire owning object graph, including
maps, and captures referenced blobs recursively inside values. After an accepted
write it captures newly referenced hashes for the appended revision. All this
runs under the existing per-document ordering. It reads the outgoing session,
never the overwritten file, validates the complete size and SHA-256, and accepts
no partial/corrupt capture. Repeated hashes share bytes inside that journal.

The cache has a **64 MiB per-journal** default cap, set with
`KitManager::with_history_blob_limit(bytes)`, including zero to disable retention.
FIFO byte eviction is independent of entry/object journal eviction: an answerable
basis does not guarantee retained bytes. Reference snapshots have a separate
20,000-membership budget; the oldest snapshots are dropped when it is exceeded.
Expired snapshots and unreferenced bytes are pruned on capture. Oversized blobs
and captures beyond the budget stay unavailable. Cache allocations live with the
manager; closing a kit session does not discard answerable history. Server
restart and journal abandonment do not promise historical bytes or revisions.

During a guarded callback the host lends a random capability bound to the kit,
document journal and basis. `history.blob.read {token,hash,offset,length}` checks
the capability, basis coverage and reference membership on every chunk, then
answers `{available:true,hash,size,data:<base64>}` or `{available:false,reason}`.
Chunks are at most 1 MiB. Reasons are `invalid-token`, `basis-expired`,
`not-at-basis`, `unsupported`, `capture-unavailable`, `bytes-unavailable` and
`invalid-range`. `bytes-unavailable` includes missing/corrupt capture and byte
eviction; it never means an empty blob or a negative hit. The capability expires
at callback completion or cancellation. Cache reads acquire no kit/document
request lock, so a nested host read cannot deadlock that callback.

Kits implement `covered_at(command,params,objects,history)` and use
`HistoricalBlobs::read(hash,offset,length)` for a prior tile. Its default delegates
to `covered`. Unavailable bytes must produce `covered: None`; the guard refuses
`unknown`. The mock proves an outside tile replacement still permits picking an
unchanged pixel, detects a removed picked pixel, and refuses unknown after byte
eviction. Cache tests prove per-kit authorization, reference membership, byte
eviction, journal expiry and capability revocation. also proves capture
and reads across 1 MiB chunk boundaries, SHA-256 refusal for corrupt sources,
retention across document close/reopen and worker restart within one manager,
and `unknown` for an old basis after manager restart. No disk-persistent blob
history is implemented. Kits must return exact ranges and complete sizes, and
must propagate unavailable history as cannot-say.

For opted-in blob documents the manager also retains one latest complete model
checkpoint, only at the current journal revision, capped separately by the same
configured byte limit (serialized JSON) and 20,000 objects. It supplies the
before-model when a document or worker has already closed; without an available
checkpoint the reread remains `unknown`. No checkpoint is used to override an
open session whose version unexpectedly changed.

## Region Content And Model Metadata

`Under.content` holds `{id,field,region}` dependencies independent of ordinary
whole-field premises. The guard reconstructs the field at basis and asks
`context.content`, implemented by `KitDocument::content_at(ContentAsk,history)`,
whether content in the kit-defined region changed. `Some(false)` permits,
`Some(true)` refuses `changed`, and unavailable comparison refuses `unknown`.
A kit can hash the reconstructed old region using historical bytes and the
current region; hashes never need to be stored in the file. The mock's 2x2 tile
proves same-tile edits elsewhere permit and relevant edits refuse, from another
agent and from an outside reread. An observe-time fingerprint alternative was
not chosen because future write regions are not known at the observation.

JSON `members` keys now address nested numeric leaves (`a.b`, `a[]`, `a[].b`,
including repeated arrays). requires numbers at bounded scalar paths:
strings and booleans refuse, and null requires `nullable: true` on the member
limits. Arrays and objects remain valid, with deeper declarations checked
independently. Declare both `resolution` and `resolution[]` for number-or-array
values. Both batch engines validate whole reconstructed values and the
environment sampler follows these paths. Kits update Rust and TypeScript
together; explicit Rust `NumberLimits` literals add `nullable: false`.

Maps also accept `members`: `{"style":{"multipleOf":1},"*.count":{"minimum":0,"multipleOf":1,"nullable":true}}`
checks an exact key and each record's count, including `map.set`. Nested integers
use `multipleOf: 1`; nullable integer registers use `optional: true` with their
usual bounds. `KitDocument::value_limits` returns an owned callback taking
`{id,type,fields}` and a concrete path such as `value.v`. Return `NumberLimits`
for that object's current register/map metadata or `None`. Batch creates,
register writes, map sets and map deletes validate in the transaction and roll
back on failure, including when removing metadata narrows another value's limits. Model loads
add `limits: {path: NumberLimits}` for the environment's sampler. Static limits
still apply; the callback supplies additional limits. Custom batch adapters
implement `BatchTarget::value_limits`; kits using session/exchange get it automatically.

A tree field may declare `cascade: true`. The default remains child-first for
node deletion; the opt-in deletes the complete subtree descendant-first in one
transaction, with every addressable node in the receipt. Rust `FieldDef` literals
add `cascade`; TypeScript readers accept the optional property. Owning-map
records are now included in environment snapshots, normalized across rereads,
and sampled for field edits. Kits keep declaring `owns: true` and returning the
referenced records. See the [call-context guide](kits/call-context.md#model-declarations-and-history)
for model declarations and retention limits.

Numeric fields accept JSON-schema `minimum`, `maximum`,
`multipleOf` in Rust and TypeScript; both validate writes and expose the limits
in model describe. `multipleOf` is positive and zero-based. A kit may settle a
batch to file precision through `KitDocument::batch_settler`; its writes share
the batch transaction and receipt. The closure must be deterministic and
idempotent and must not write files itself.

> This guide explains the data model. The normative text is
> [`KitModel 1.0`](sets/model.md) (the M rules), the performance rules P1 to
> P5 in [the engine contract](kits/engine.md#performance-rules), the levels
> L5 and L6 and the convergence suite in [levels](kits/levels.md), and the
> [sync protocol](reference/sync-protocol.md).
>
> The Kit Data Model is part of the **Kition kit platform**, not of the Kit
> Harness Protocol (KHP). KHP does not require it: a third-party kit gets
> safe AI edits from drafts in file mode. The KDM is what lets Kition's own
> kits co-edit, merge, and keep history, with a shared document contract.

## Summary

1. **What the KDM is.** One data model shared by all of Kition's kits. Each
   kit declares in a schema which objects and fields its documents are made
   of; the data is stored as nine replicable primitives, running on Loro 1.16
   (a CRDT library). **A document is not a file but a history of mergeable
   operations, each with an author**; docx, pptx, psd, and md are only
   formats it imports and exports.
2. **The design in one sentence.** One authoritative replica per document
   (the KDM); every change is a transaction; every transaction carries an
   origin (person, agent, script, import, system); merging is deterministic;
   after a merge the kit applies a deterministic repair, and what it cannot
   repair becomes a conflict object.
3. **What it gives collaboration and sync.**
   - **Offline first, with a thin server.** Content merges on every device;
     the server orders nothing and only handles membership, permissions,
     persistence, blobs, and compaction. The server is cheap and easy to
     self-host: one Rust program.
   - **Collaboration written once for every kit.** Co-editing, undo,
     history, permissions, and agent access live in the KDM layer; a kit
     writes only its own domain rules.
   - **People and agents take the same path.** An agent is a collaborator:
     its changes are visible and can be undone per person; large changes go
     through a draft (a branch) and are merged after the person confirms.
4. **What it gives version control of content later.** Git's core (the full
   history graph, checking out a version, forking, diffing, reverting,
   commits with authors) is already in Loro and the KDM: a draft is a
   branch, a conflict object is a merge conflict, a `BlobRef` is Git LFS, the
   Kition Server's change log is the remote repository, and the pool of
   headless kits is CI. What remains to build is a version layer (names,
   three-way comparison, merge requests) and a semantic diff per kit. The
   three hard parts (structured data, mergeable history, agents as
   collaborators) already exist.
5. **What to hold on to now.** Freeze each kit's schema before the first
   release; bring Table and Film to engine contract 2 and give Layout a schema; do not
   hard-code a history retention of "30 days only", so that branches can be
   merged later.

## 1. Where the KDM sits

![Kition's layered architecture](layers.svg)

```text
 Consumers  ┌──────────────┬─────────────────┬──────────────────┬────────────────────┐
            │ People       │ Integrators     │ Automation       │ AI (MCP, DSH, ACP) │
            │ (kit editor) │ (embed SDK)     │ (object model)   │                    │
            └──────┬───────┴────────┬────────┴─────────┬────────┴──────────┬─────────┘
                   ▼                ▼                  ▼                   ▼
 Session    ┌──────────────────────────────────────────────────────────────────────┐
            │ Kit session: commands → transactions, object model, events,          │
            │ presence, undo scopes                                                │
            └────────────────┬───────────────────────────────────┬─────────────────┘
 Kit        ┌────────────────▼──────────────────┐   ┌────────────▼────────────────┐
            │ Kit engine (Rust or TypeScript):  │   │ Import and export (pptx,    │
            │ domain rules, checks, layout,     │   │ docx, xlsx, dxf, pdf, psd,  │
            │ rendering, tools                  │   │ md,...)                    │
            └────────────────┬──────────────────┘   └─────────────────────────────┘
 Data       ┌────────────────▼─────────────────────────────────────────────────────┐
            │ KDM replica: schema, ids, CRDT state, change log, version vector,    │
            │ blobs (by hash)                                                      │
            └────────────────┬───────────────────────────────────┬─────────────────┘
                             ▼ local store                       ▼ sync protocol kition-sync/1
              workspace +.kition folder              Kition Server (Rust, paid or self-hosted):
              (free edition: one replica per device)  rooms, auth, change log, blobs, headless kits
```

**Five rules** keep the layers apart:

1. **One authority per document.** A co-edited document is what its KDM
   replica says; the domain model inside a kit engine is only a view computed
   from the KDM. **Two full copies are never synchronised by replacing one
   with the other.**
2. **Every change is a transaction.** Typing, dragging, menus, scripts,
   extensions, imports, and agents all go through the same session and
   produce transactions. There is no back door.
3. **Files are an exchange format, not the state.** `.pptx`, `.docx`, and
   `.md` are imported into the model and exported from it. For a single user,
   the files in the workspace are still the person's own files.
4. **Private state is not replicated.** Selection, caret, zoom, viewport, tool
   state, caches, layout results, and renderings are never replicated as
   document data; selection and caret travel as presence.
5. **One contract everywhere.** The page's worker, the headless executable,
   and the server run the same kit engine.

## 2. Core concepts

| Concept | Meaning |
| --- | --- |
| Document | One logical document with a permanent `docId` (UUID v7); renaming or moving the file does not change it |
| Replica | A document's KDM state on one device or in one server process |
| Actor | The session identity of a replica that makes changes: a random 64-bit peer id, a new one for every writable session |
| Principal | An authenticated person, agent, or service. **Authorisation looks only at the principal and never trusts an actor the client claims** |
| Change | An immutable, causally ordered unit made by one actor, identified by `(actorId, counter)` |
| Transaction | The atomic operations one command makes; one undo step; carries an `origin` |
| Origin | `{ kind: person / agent / extension / import / system, principal, label, group? }` |
| Object | An addressable entity in the KDM with an `ObjectId` (UUID v7) and a schema type; the id is stable within an opening of the file, and across a reopen only where the file stores it ("Ids within an opening and across a reopen" below) |
| Blob | Immutable binary data, addressed by SHA-256 |
| Version | A version vector or frontier that says exactly which changes a state holds |

**Ids.** The KDM generates every `ObjectId` (UUID v7), so two replicas never
collide and creating an object needs no coordination. A kit engine may keep
efficient local ids inside (`u32`, DXF handles, PDF object numbers); each kit
keeps an `ObjectId ↔ local id` map, rebuilt on load and never replicated.
Import records the source format's ids as attributes, so a second import of
the same file matches them.

**Tool ids.** The `ObjectId` is the identity replicas and the sync protocol
use; it is not what a person or an agent should have to handle beside the
kit's own ids. A kit whose tools (inspect, commands, diagnostics) name
objects by its own ids stores that id in a read-only field and names the
field in its schema (`"toolId": { "field", "prefix"?, "parent"? }`,
[`KitObjectModel 1.0`](sets/object-model.md) OM9); the object model then
answers and takes it instead of the `ObjectId`, so a document has one id
space at the tool interface (KHP A47). The kit keeps the value unique in
its domain (its prefix, and its holder when the type names a `parent`); an
object without a value of its own (not numbered yet, or colliding after two
replicas numbered concurrently) answers its `ObjectId` until the kit's
repair numbers it.

**Ids within an opening and across a reopen.** Within one opening of a
file, from open to close and across every save, a kit keeps every
`ObjectId` and every tool id of an existing object; only objects created
since get new ids. Across a reopen, ids are stable only where the kit's file
stores them. A kit that stores its replica in its file keeps every
`ObjectId`, and a tool id the file stores (a kit's own id in a read-only
field, above) survives in every kit. A kit that builds its replica from the
file on every open (for example, a kit importing a format such as PSD or
IDML) mints a new `docId` and new `ObjectId`s each time, so an `ObjectId`
does not survive a reopen; nor does a tool id the kit numbers on open
instead of reading it from the file. A kit says which of its ids survive a
reopen in its guide for models (`agent/guide.md`, [manifest](kits/manifest.md)
K17). An agent observes the document again after a reopen and takes ids
from that observation: an id read before the reopen names nothing it can
rely on unless the kit's guide says that id survives. The platform
does not derive `ObjectId`s from the file: two replicas that each built the
same file and later synced would hold every object twice, created by two
actors under one id, and the CRDT keeps one side's containers for such an
id and drops the other's edits (as for a container field added to an
existing object, section 4), while lists holding the object would hold it
twice. A document is shared by every replica starting from one replica (a
room's seed, a draft's fork), never by building it twice; tool ids the file
stores are the stable names across opens.

**A copy is a new document.** A template instantiated twice, a copied file,
or the same bytes uploaded twice must become independent documents, each with
its own co-editing room, never two copies of one `docId`.
`Replica::copy_as_new_document(doc_id, actor)` (`copyAsNewDocument` in
TypeScript) makes one: a replica of the new `doc_id` with the same objects,
`ObjectId`s, tree node ids and values, written into both places the id lives
(the document's `meta` and the byte envelope). It carries no history: the copy
is a shallow replica rooted at its own first change, so deleted content,
earlier versions and the source's `docId` stay behind, it forks a draft only
at its current version, and its undo starts empty. Asked for every change
(`export_changes` since the empty version), it answers its snapshot, which
loads as the copy (M14), so the object model over a kit's change exchange
and an agent's draft (`model.export`, then `model.open`) work on a copy as on
any document, with nothing in the kit. A blob is its
content-addressed reference, kept as it is; a host whose blob store is per
document copies the referenced blobs with it. Copies refuse each other's and
the source's changes, drafts and snapshots (`WrongDocument`). There is no
option to keep the history: the copy would share the source's change ids, its
earlier versions would name the source's `docId`, and deleted content would
travel. A kit that also writes the `docId` outside its replica (a container's
manifest, a database row) writes the new one there too.

A copy's root is the document's **birth**: no replica of the new `docId` can
hold history before it. The change that makes the copy records that root (a
root map `birth`, key `root`, outside `meta`, so the canonical state stays the
source's), and `carries_whole_history()` (`carriesWholeHistory()`) answers
true for a full replica and for a shallow one whose state **at its root**
records its root as the birth: the copy, every replica loaded from it, its
snapshots and drafts. A shallow snapshot taken after more changes does not,
and neither does a later change that writes another birth (only the state at
the root counts). A sync server reads it from the bytes alone to accept a
copy's snapshot as a new room's first state (sync protocol S20), so a copy is
co-edited as its own document. Copies made before the birth was recorded
(board 0.1.4-dev builds only; no released artifact) record none, and a server
refuses them like any truncated replica: copy them again.

**Two reads of one file compared.** When another program changes a file
and a kit reads it again, what changed is found by pairing the objects of
the two reads, never by `ObjectId` alone (`kition_kdm::reread`). Pairing is
per object, never all or nothing: an id both reads have pairs that object
(a tool id, a root whose id is the same on every read, an `ObjectId` a kit
kept), and the roots always pair. Only when at least half of the other
objects without tool ids kept their ids does the kit keep object ids, and
then an id only one read has is an object only that read has. Otherwise,
from every pair, the objects the two hold through the same owning field: a
ref's with the other's, a map's under the same key (ids in keys read
through the pairing), a list's (or a tree's, under paired parent nodes) by
equal content first and then in order between the paired items that keep
their order, so a paragraph inserted leaves the others unchanged. Objects
nothing holds pair by equal content. Content is read without ids (a ref
that only points reads as its target's tool id, or its type), and a ref to
an object paired across the reads compares equal. What stays unpaired was
deleted or created. Changes of objects that have no tool id and no holder
with one (masters, layouts, shared media, the root) are counted by type
(`unnamed`), never listed by ids minted on that read; but a root whose id is
the same in both reads is listed by it when a field of its own (or a derived
value) changed, not only a list or tree it holds.

*Deleted objects in trees*. Deleting an object (`Tx::delete`)
keeps its node in every tree holding it: the canonical state holds the node
(the shared batch fixtures say so for both implementations), and every read
skips it with its subtree (`Replica::tree`, `Tx::tree`, a load). Change sets
compare the trees as read: a write's (`changes_since`, which reads the trees
that held a deleted object too), a draft's (`diff_states`) and two reads of a
file (`reread`) tell a plain deletion at the node's place (`at: { parent,
field, index }`, the later siblings' indexes shifted), never a node of no
type moved to `null`. An object whose node has children naming live objects
is not deleted (`invalid-value`): delete or move the children first, in one
transaction children before their parent.

*Ids inside values.* An object id may sit in any value that is not text: a
ref, a list, a map's values and keys, a json value at any depth
(`look.kind.fill.media`, a paragraph's `endProps`), a json object's keys.
In fields of those kinds, never in a `string` or `text` field, a string is
an id when the whole string is the id of an object of the read, and a key
when the whole key is one or each of its `:`-separated segments that is one
(`<row id>:<col id>`); no substring and no other separator is read as an id,
so no text a person typed is mistaken for one. Contents are compared and
fingerprinted with each such id read through the pairing, so a value that
differs only by the ids of paired objects is unchanged. A load answers ids
in refs, lists and trees by tool ids but ids inside json and maps as the kit
stored them; the agent tools' server asks the kit for the tool id of each
string there of the form of a minted id (a UUID) that names no object of the
read, so a connector naming a shape by its object id names it alike in both
reads.

*Renumbered tool ids.* Another program may move tool ids between objects
(two shapes swap their numbers, content unchanged). When an object paired
by its tool id differs from its partner (without the tool id's own field)
and equals the partner of another object paired by tool id that differs
too, the tool ids were renumbered: those objects are left out of the change
and named in `renumbered`, never told as changed into each other's content.

## 3. Nine data primitives

| Primitive | Merge semantics | Used for |
| --- | --- | --- |
| `Record<T>` | Named fields; each scalar field is last-writer-wins | Shape properties, cell styles, layer settings |
| `Map<K, V>` | A keyed collection; additions win | Objects by id, styles by name |
| `List<V>` | A sequence with stable element identity | Paragraph runs, keyframes, path points |
| `MovableList<V>` | A list with atomic moves: concurrent moves never duplicate an item | Slides, layers, tracks, sheet order |
| `Tree<V>` | A movable tree that prevents cycles | Layout items, vector groups, board frames, outlines |
| `Text` | Unicode text with marks (rich text) and stable anchors | Markdown, Word body, text boxes, cell text |
| `Counter` | A commutative counter | Rare: statistics, numbering seeds |
| `BlobRef` | `{ hash, mime, size, name? }`, a reference to a blob | Images, video, fonts, embedded PDFs |
| `Ref<T>` | A reference to another object; a dangling reference is a validation state, not a crash | A slide's layout, links between records |

## 4. Schema

Each kit ships `model/schema.json` in its package, versioned apart from the
kit. The schema states object types, their fields and primitives,
references, and invariants. A simplified example:

```json
{
  "kdm": 1,
  "kit": "kit.slide",
  "schemaVersion": 3,
  "root": "Slides",
  "types": {
    "Slides": { "fields": {
      "slides":  { "movableList": { "ref": "Slide", "owned": true } },
      "masters": { "map": { "ref": "Master", "owned": true } }
    }},
    "Slide": { "fields": {
      "layout": { "ref": "Layout" },
      "shapes": { "tree": { "ref": "Shape", "owned": true } },
      "notes":  { "text": true }
    }},
    "Shape": { "fields": {
      "transform": { "record": "Transform", "merge": "atomic" },
      "fill":      { "record": "Fill" },
      "image":     { "blob": true, "optional": true }
    }}
  },
  "invariants": ["slide.layout.exists", "table.spans.valid"]
}
```

- **`"merge": "atomic"`**: coupled fields (position and size) merge as one
  value, so a merge never gives "A's position with B's size".
- **The schema is the single source**: the object model's types, the agent's
  tools and their documentation, validation, migrations, and conformance
  tests are all generated from it.
- **A hard limit on evolution**: an existing object type cannot gain a
  container field (concurrent creation would lose one side's edits); only new
  types or `ref`s can be added. That is why **schemas are frozen before the
  first release**.

## 5. Merging: strategies, repairs, conflicts, leases

### 5.1 Eight merge classes

| Class | Kits | Strategy |
| --- | --- | --- |
| Structured objects | slide, vector, layout, board, cad | Merge by field; coupled fields are `atomic`; order and parenthood use `Tree` and `MovableList`; delete wins over edit (the edit stays in history) |
| Rich text | note, doc, and the text in every kit | `Text` with marks and anchors; comments are anchored in the text, not by offsets |
| Database | table | Records keyed by row; merge by field; schema changes are typed operations; computed values are derived, never replicated |
| Grid | sheet | Rows and columns are `MovableList`s with stable ids; cells are stored by `(rowId, colId)`; formulas reference ids, and A1 notation is only for display |
| Timeline | film, motion | Clips and keyframes have stable ids; split, trim, and ripple edits are single operations; overlaps are repaired by the kit's rules |
| Raster | photo | Layers are structured objects; pixels are deterministic stroke operations or tiled blobs; concurrent pixels on the same layer need a lease |
| Overlay and coordination | pdf, cad constraints | The PDF's original bytes stay as they are; annotations, form fields, and page order are objects; editing content streams or solving constraints needs a lease |
| Binary blobs | all | Stored by hash, transferred separately, referenced by `BlobRef` |

### 5.2 Repairs after a merge, and conflict objects

Two transactions that are each valid can merge into an invalid result (a
merged cell spanning a deleted column; two clips overlapping on a track that
forbids overlap). Each kit implements a repair:

```text
merged KDM state → kit.validate(changed objects) → repair transaction (origin: system)
```

- A repair MUST be a **deterministic function** of the merged state, so every
  replica computes the same repair and recognises someone else's identical
  repair as already done.
- What needs a person's judgement (two contradictory constraints) becomes a
  **conflict object** in the model; the interface lets the person choose, and
  one transaction resolves it.

### 5.3 Leases

Some edits make no sense to merge: two people painting the same pixels,
editing the same PDF content stream, or solving the same CAD constraints. A
kit marks such objects `coordination: "lease"` and takes a short lease from
the server before editing. Offline edits are still allowed, but if someone
edited under a lease meanwhile, the result becomes a conflict object with
both versions kept. **Every other object never waits for the network.**

### 5.4 Lossless round trips

Content an import does not recognise is stored as **opaque objects** (Slide's
`Opaque`, Doc's pass-through parts), with their relationships, and written
back unchanged on export. Opaque objects are read-only and do not count as
editable. The principle: **where the model cannot express something, make it
explicitly read-only rather than silently drop it.**

## 6. Transactions: validate, then apply

- Do not commit a failed transaction and then broadcast a rollback: that rollback
  can overwrite concurrent changes on other replicas.
- Loro has no public abort, so both implementations are **staged**: a
  transaction is validated on an overlay of the document plus the pending
  changes, and applied only when it succeeds.
- Exports carry a document envelope (`KDM\x01` plus the document's UUID), so a
  misrouted message never merges two documents into one.
- Values are plain JSON, integers within ±2^53, with no nested `__proto__`,
  so every implementation reads the same value.

## 7. Storage

### 7.1 The local store (all the free edition needs)

```text
<workspace>/
  Launch.pptx                        the person's file (exchange format)
.kition/docs/<docId>/
    snapshot.bin                     the latest compacted snapshot
    changes/<seq>.bin                changes since the snapshot (append only)
    blobs/<sha256>                   blobs the file does not hold
    meta.json                        docId, kit, schemaVersion, file binding, file stamp, exported version
```

- Changes are appended and fsynced; snapshots are written by atomic rename.
  A store has one writer at a time (a lock file).
- KDM state is saved continuously; "Save" means exporting the exchange file.
  A new native format can use the KDM container directly, with no export.
- File binding: when the file changes outside Kition, a kit whose engine
  merges a newer file into its stored replica (it declares so; Kit UI
  protocol UI-R1) opens the stored replica with the new file, and the
  difference is applied to it as one `system` transaction labelled `import`
  (section 7.3, step 4), keeping the document's id, comment threads and
  history; **unsaved local edits are never lost**. The host hands the stored
  replica over whatever the file's stamp; the kit decides. A kit whose engine
  cannot merge opens the changed file plainly, and its history starts over
  as another lineage (section 7.2).

### 7.2 History

- Every change carries its author, origin, and causal dependencies; Loro
  keeps the full operation history graph.
- Local version history exists. The host names versions of the stored replica as
  **checkpoints** (`{ id, time, origin, author?, label?, description?, version }`): each is a
  reference to a replica version in the store, never a copy. A kit records one together with the
  replica write that holds its version (the write carries the version its snapshot holds, taken
  with the saved bytes, Kit UI protocol UI-R6), lists them, renames or deletes its own (`origin: kit`),
  and reads the blobs (or, on request, a snapshot) at a version (Kit UI protocol section 7m).
  Labelled checkpoints are never thinned; unlabelled ones are, under a cap of their own. When
  the stored replica is replaced by one of another lineage, labelled checkpoints stay listed as
  unavailable. A file changed outside and merged into the stored replica as one `import` change
  (section 7.1) continues the lineage: every checkpoint stays available. The host tells lineage
  by the replica written, never by the file's stamp. There are no branches.
- **Version bytes.** A version (`Version::encode`, `Version.encode()`; `replica/version`, a replica
  write's and a checkpoint's `version`) encodes canonically: equal versions are equal bytes in the
  Rust and the TypeScript KDM, whichever replica or order of imports made them, so a host
  compares and stores them as opaque bytes (Kit UI protocol UI-R7). The bytes are the engine's
  version-vector format (a postcard map: the entry count, then each actor id and its counter as
  varints, the counter zigzagged) with the entries sorted by actor id, ascending as numbers; the
  engine writes its entries in its hash map's order, which two equal versions need not share, so
  the KDM writes them itself. The versions the KDM keeps inside the document (a seal's version,
  a copy's or rebirth's birth) are written the same way. `crates/kition-kdm/tests/fixtures/version-bytes.json`
  holds versions and their bytes; both implementations' tests read it.
- A person's **view state** of a document (where they were, zoom, open panels) is neither content
  nor history: the host keeps it per document and per person or device in its own app data, never
  in the workspace, the replica, or the file (Kit UI protocol section 7n).
- The Kition Server keeps the full change history (30 days proposed)
  plus older snapshots; a large document can use a **shallow replica**
  (current state only, history fetched from the server on demand).

### 7.3 A file holds no history

The person's file holds the document's content; its history lives in the
store above (owner, 2026-11-22; rule [M16b](sets/model.md)). A kit whose file
embeds its replica writes `Replica::content_snapshot()` there, never
`Replica::snapshot()`:

| Bytes | Holds | Goes to |
| --- | --- | --- |
| `snapshot()` | state and every change: deleted content, overwritten values, each change's origin (person, agent, label) | the history store, a sync server, new replicas |
| `content_snapshot()` | state, and of the history only a `system` seal | the person's file |

`content_snapshot()` seals first: unless the last change already is a seal,
it commits one `system` change (`content-seal`) on top of every head, then
answers a shallow snapshot rooted at it. Without the seal a shallow snapshot
at the current version keeps history: after an import of concurrent changes
its root moves back to their last common version, and with one head that
change's origin stays. The seal is a real change: the host stores it and
pushes it to the room like any other; it is no undo step. What still
survives in the file: the actor ids inside element ids (which replica wrote
each character, item or node, as numbers) and the seal's lamport number. A
save with no change since commits nothing and writes the same bytes, whatever
was read in between: the engine creates an empty root map the first time a
read names it, and an export writes it, so the export first creates every
root the KDM reads (`meta`, `objects`, `seal`, `birth`, `schemaRaises`).

Saving gives the file the content bytes and the store the full bytes. Every
host calls the engine's `prepareSave` right before `save` (engine rule E4,
host rule H4): the editor worker, `kition-headless` (and so the kit server and
the HTTP kits), the convergence harness. The seal happens there, in the live
replica, so the document's next edits follow it and a replica opened from the
file takes them. The editor then takes the store's `snapshot()` after `save`:
the store holds the seal.

What a kit whose file holds its replica does:

1. **Prepare.** `KitDocument::prepare_save(&mut self)`: `self.session.seal()`
   (TypeScript: `KitModel.prepareSave(view, replica)`: `replica.seal()`).
   `kition_kit::testing::check_contract` calls it before it saves, as a host
   does, so a kit's contract edit need not seal.
2. **Save.** `KitDocument::save(&self)` writes
   `replica.sealed_content_snapshot()` into the file (TypeScript:
   `replica.sealedContentSnapshot()`, or `replica.contentSnapshot()` in
   `export`, which seals itself). It never writes `snapshot()`. A replica
   loaded from content bytes answers those same bytes while it stays at their
   version, so an unchanged save writes the file it read, byte for byte: no
   kit caches the bytes.
3. **Open, file alone.** `Replica::load(schema, content, actor)`: a shallow
   replica rooted at the file's seal. It edits, syncs, forks drafts and
   answers `changes_since` at every version since the file
   (`Replica::reaches`); versions before the file are `history-missing`.
4. **Open, with the host's stored replica** (`openReplica`, the store of
   `<workspace>/.kition/docs/<docId>/`): `kition_kit::session::take_file(&mut
   stored, &file)`. The host hands the stored replica over whatever its file
   stamp, and a kit whose engine does this declares so (Kit UI protocol
   UI-R1) and opens with it also when the file changed outside since. When the stored replica has the file's version it does
   nothing; when the file's history reaches the stored replica's version it
   imports the file's changes; otherwise (the file was saved from changes the
   store lacks: another machine, a store that is gone) it writes the file's
   state over the stored one as one `system` transaction labelled `import`,
   keyed by object id (`write_state`: registers, refs, text with marks,
   lists, maps, trees; a new object is made with its registers and refs
   together, so a required ref is never missing; a tree node of a deleted object, which the KDM keeps
   and the file's state names, is never made again).
5. **Read the history a stored replica holds.** A replica that started from a file
   is rooted at the file's seal and grows with every change since; stored and
   loaded again, it keeps that root. `Replica::earliest_readable()`
   (`Replica.earliestReadable()`) is the earliest version whose state it can
   read: the seal's version, where its state is the file's content
   (`Version::empty()` on a full replica). `fork_at` reads the state at it and at
   every later version it has. `Replica::history_since(&since)`
   (`Replica.historySince(since)`) lists the changes after `since`, oldest first
   (causal order; concurrent ones by Lamport number, then actor), each with its
   origin and the version it makes with the changes it depends on, so a kit cuts
   per-object history at each change or at the host's checkpoints. From
   `earliest_readable()` the list holds every change since the file.
   `shallow_root()` is the engine's root, the version just before the seal's own
   operation: neither readable nor `reaches`. Versions before the seal are
   `history-missing`. Nothing of this is in the file's bytes: it is read from the
   stored replica's history. The TypeScript engine forks a shallow document only
   as a whole, so a TypeScript replica loaded from a later stored snapshot reads
   state from the version it was loaded at on (its `earliestReadable()`), while
   `historySince` lists every change since the seal.
6. **Tests.** `Replica::snapshot_origins(bytes)` (`Replica.snapshotOrigins`)
   lists the origins of the changes some bytes hold: a content snapshot holds
   one, the seal. No kit test needs the engine (`loro`) itself.

What a kit used to keep in its file beside the content goes to the host: named versions (saved
versions, record history) are checkpoints of the store (section 7.2, Kit UI protocol section 7m),
recorded with the replica write of a save; a person's view state goes to the host's `view-state`
(section 7n). A host without these capabilities offers neither, and the kit keeps them for the
session only.

A file is a shallow replica that does not carry the document's whole history
(sync protocol S20). A document known only from its file (no store, no room)
starts a room after `rebirth()`, which makes its current version the birth.

### 7.4 The content encoding

What a kit writes into a person's file is `content.json`: the document's state in one deterministic
JSON encoding (`kition_kdm::content`; plan 2026-11-24, plain model, section 2). It is the one part
of the KDM that cannot change after the first public release, so every rule below is a test
(`crates/kition-kdm/tests/content.rs`) and the canonical fixtures under
`crates/kition-kdm/tests/fixtures/content/` are its bytes. Only Rust writes it; other
implementations read it.

```text
{"kdm":1,"kit":"kit.board","docId":"0193a5c4-0000-7000-8000-000000000001","schemaVersion":1,"objects":{
"0193a5c4-0000-7000-8000-0000000000a1":{"$type":"Board","pages":["0193a5c4-0000-7000-8000-0000000000b2"],"title":"Q4"},
"0193a5c4-0000-7000-8000-0000000000b2":{"$type":"Page","body":[{"insert":"Ship "},{"attributes":{"bold":true},"insert":"it"}],"name":"Page 1"}
}}
```

| # | Rule |
| --- | --- |
| C1 | UTF-8 without a byte order mark. Lines end with `\n`, the last line too. |
| C2 | The first line is the header: `kdm` (1), `kit`, `docId`, then, in a snapshot only, `version` as `{"lineage":"<uuid>","seq":<n>}` (with `"authorSchemaVersion":<n>` after `seq` when the replica knows the newest schema version a change was written under, rule M5a), then `schemaVersion` (the minimum schema version, rule M20), then `"objects":{`, in this order. |
| C3 | Then one line per object, `"<id>":{...}`, with a `,` after each but the last, ids in ascending order of their UTF-8 bytes; then the line `}}`. A document without objects is the header and `}}`. There is no other whitespace. |
| C4 | Inside an object, at every depth, keys are in ascending order of their UTF-8 bytes (not UTF-16 code units: U+FF5A sorts before U+1F600). `$type` holds the object's type. |
| C5 | A field holding `null`, an empty text, an empty list, an empty map or an empty tree is left out; reading, a field left out is empty (`null` for a register). A register holding `""`, `[]`, `{}`, `0` or `false` is written. So adding a field to a type does not change an older document's bytes. |
| C6 | A number that is whole and within ±2^53 is an integer (`-0` is `0`, `5.0` is `5`). An integer beyond ±2^53 is refused. Any other number is written in its shortest round-trip digits (the fewest decimal digits that read back as the same double), laid out by where its decimal point falls, with `p` such that the value is `0.<digits> × 10^p` and `n` digits: when `0 <= p - n` and `p <= 16`, the digits, `p - n` zeros and `.0` (`9007199254740994.0`); else when `0 < p <= 16`, the digits with a decimal point after the `p`-th (`123456789.125`); else when `-5 < p <= 0`, `0.`, `-p` zeros and the digits (`0.1`, `0.0001`, `0.00001`; `1e-6` is past it); else the first digit, `.` and the rest when there is a rest, `e` and `p - 1` without `+` (`1e21`, `1e16`, `1.5e-7`, `5e-324`, `1.7976931348623157e308`). The layout is the KDM's own, not a JSON library's (whose output may change between its versions). |
| C7 | In strings only `"`, `\` and U+0000 to U+001F are escaped: `\b`, `\f`, `\n`, `\r`, `\t`, the others `\u00xx` in lower case. Every other character is written as itself (`/`, U+007F, U+2028, characters outside the BMP). |
| C8 | A text field that declares marks is its runs, `[{"attributes":{...},"insert":"..."}]`, `attributes` left out of a run without marks, adjacent runs with different marks, no empty run (rule M19); one that declares no marks is a string. A list is an array of object ids; a map is an object; a tree is an array of `{"children":[...],"object":"<id>"}`, siblings in order; a blob is its value `{"hash","mime","size"}` (its bytes are in the container's `blobs/`). |
| C9 | Fields the reader's schema does not declare (an object written under another schema version) are kept as they are. |
| C10 | The content holds no version, lineage, actor, origin or time. A **snapshot** (the host's stored state, a draft's base, a new replica) is the same encoding with its `version` (C2); a file never holds one. |

What follows: a document saved again unchanged is the same bytes (the content depends on the state
alone), and two people who save the same state write the same bytes. A container's DEFLATE output
depends on the compressor, so byte equality of a zipped file holds for one kit build; across builds
the `content.json` inside is the same.

## 8. Collaboration and sync (Kition Server)

### 8.1 Model

- Each device holds a full (or shallow) replica of the documents it opens.
- **The server relays and stores changes but is not the authority on content
  order**: merging is deterministic and converges in any order. The server is
  the authority only on **membership, permissions, persistence, blobs, and
  compaction**.
- The protocol and the clients are open; the server is a private Rust
  program with pluggable storage that can be self-hosted.

### 8.2 The protocol `kition-sync/1`

JSON-RPC 2.0 over WebSocket (change payloads in binary frames); the full
text is the [sync protocol reference](reference/sync-protocol.md):

| Message | Direction | Meaning |
| --- | --- | --- |
| `sync/hello` | client → server | Authentication, client information, capabilities; the server checks authorisation and answers the capability sets it serves |
| `room/join` | client → server | `docId` and version vector; the server answers the missing changes and the room's presence |
| `changes/push` | client → server | Encoded changes; the server checks permissions, stores them, and answers sequence numbers |
| `changes/pull` | server → client | Others' changes, in the order the server received them (any order converges) |
| `presence/*` | both | Ephemeral state, never stored |
| `blob/has`, `blob/put`, `blob/get` | both | Content-addressed blob transfer, resumable |
| `lease/*` | both | Leases |
| `snapshot/get` | client → server | A compacted snapshot for a new device |

**Offline flow**: edits commit locally first; on reconnecting, `room/join`
exchanges version vectors and each side sends what the other lacks; every
replica runs the merge and the deterministic repairs.

### 8.3 Server components

| Component | Responsibility |
| --- | --- |
| Gateway | WebSocket sessions, authentication, rate limits |
| Rooms | Each document's set of actors, broadcast, presence |
| Change store | One append-only log per document with server sequence numbers; snapshots and compaction, keeping enough history for old replicas |
| Blob store | Content-addressed object storage, reference-counted per document, access limited to the room's members |
| Permissions | owner, editor, commenter, viewer; share links; changes without write permission refused |
| Headless kit pool | The same kit engines on the server: previews, exports, search indexing, validating untrusted changes, server-side agents |

**Trust**: clients are not trusted. The server checks that every change's
actor belongs to the authenticated session, that the principal may write,
and that the change decodes under the document's schema version. A kit with
strong invariants can turn on **server validation**: a headless kit applies
the change and the server refuses what the kit cannot repair.

**Schema evolution**: every change carries its author's schema version; a
replica on an older version keeps the fields it does not know and asks the
person to update the kit before editing the objects concerned; migrations
are `system` transactions with a deterministic migration id, run once per
document.

## 9. Undo and AI

### 9.1 Undo

- **Undo per person**: a person's undo takes back only their own most recent
  transaction group, never someone else's: not another person's (each has a
  replica of their own) and not an agent's on the person's own replica
  ([`KitModel 1.1`](sets/model.md) M12a, undo scopes).
- Undo applies inverse **operations** to the current state; it does not
  restore a snapshot. When someone else changed an undone field afterwards,
  their newer value is kept.
- Changes an agent makes for a person form their own group, labelled as made
  by the agent, and the person who started the agent undoes them.

### 9.2 AI: the agent is a collaborator

- An agent opens a session with origin `agent`, appears in presence, and
  edits through transactions, with the same permissions as a person.
- Tools: `<prefix>_inspect`, `_commands`, and `_run`, plus `<prefix>_query`
  (read objects by type, id, or condition) and `<prefix>_batch` (edit in
  bulk), generated from the schema; resources `kit://<docId>/objects/<id>`.
  These are KHP's tools; KHP makes `_query` and `_batch` optional and does
  not require them to come from a KDM schema.
- Transports: Kition's own agent, MCP, DeepSeek Harness, and the Agent Client
  Protocol share one implementation.

| Mode | How | When |
| --- | --- | --- |
| Live | The agent edits the shared replica; the person sees every step and can undo the agent's group | Small, conversational edits |
| Draft | The replica is forked into a draft (a KDM branch with its own actor); the agent edits and verifies it and marks it **Ready**; the person sees the comparison with the current document and chooses **Merge** or **Discard**; **Reopen** sends it back to the agent | Large or risky edits, batch work, server-side agents |

The agent may call Ready and Reopen; **Merge and Discard need the person's
confirmation and are never under the model's control**. A merge is a CRDT
import, so what others changed while the draft was open is kept.

### 9.3 A writing format for models

The KDM is designed for replication and merging; it is verbose, and models
that write it directly make mistakes and spend tokens. Each kit therefore
adds its own writing format on top (Markdown for notes, CSV for tables, a
Marp-like format for slides, a Mermaid-like format for boards), which the kit
compiles into KDM operations and validates.

## 10. Performance Rules

| Rule | Contract |
| --- | --- |
| P1 | Large collections use one object per record rather than plain values in one map |
| P2 | Bulk imports run at document creation outside undo history |
| P3 | Large interactive changes are split into bounded transactions |
| P4 | Bulk work runs within the engine's WebAssembly module |
| P5 | Saves write incremental changes; compaction writes a full snapshot |

See the [engine performance rules](kits/engine.md#performance-rules) for limits.

## 12. Why this way of collaborating

### 12.1 Compared with other approaches

| Approach | Typical products | Problem | What the KDM does |
| --- | --- | --- | --- |
| File locks, check-out and check-in | SharePoint, early online office suites | One editor at a time; offline work is merged by hand | Everyone edits at once, offline too, and reconnecting merges automatically |
| Upload the whole file, last save wins | File sync services, many in-house editors | Silently overwrites others' edits | Merges by field, by character, by object; never replaces the whole document |
| Server-ordered operational transformation | Google Docs, Univer, most online office suites | Must be online; the server implements transformations for every format, heavy and costly; each product writes it again | A CRDT: merging happens on clients; the server does not understand content and only relays and stores |
| Server authority with sync written per product | Figma, Lark's suites | Done well, but each product needs its own team | All kits share one set of primitives and one protocol; collaboration is written once |
| A different CRDT library per kit | Assembled from Yjs | Kits disagree on semantics; undo, permissions, and agents are done again for each | One schema, one transaction model, one origin and undo model |

### 12.2 What it gives the product

1. **Offline first.** The free edition has no server: documents live in the
   person's own folder, and syncing starts only with Kition Server.
2. **A thin, cheap server.** The server does not merge content; its main
   costs are storage and relaying. It is one Rust program with pluggable
   storage, and self-hosting it is one Docker command.
3. **Collaboration once for every kit.** A new kit writes its schema and its
   domain repairs, and gets co-editing, history, undo, permissions, comments,
   and agent tools.
4. **People and agents are the same kind of collaborator.** Every agent step
   has an origin, is visible, and can be undone per person; large edits go
   through a draft the person merges. "The agent broke my document" has a
   safety net.
5. **The same across languages.** Rust and TypeScript replicas are
   byte-identical, so the desktop, the web, the server, and headless
   executables compute the same results; the server can preview, export,
   and validate with the same kit engine.
6. **What was said to be impossible.** Concurrent row and column inserts and
   deletes are a common argument against CRDTs for spreadsheets; the KDM gets
   them right with stable row and column ids and formulas that reference
   ids, and a reference to a deleted row becomes `#REF!` on every replica.
7. **No data loss by design.** Validate, then apply; unknown fields are kept
   as they are; unrecognised content is kept as opaque objects and written
   back; unsaved local edits are never lost.
8. **Kits depend on KDM types, not on Loro**, so the underlying library can
   be replaced later.

## 13. Later: version control for content

### 13.1 Why the KDM is the right starting point

Documents have no equivalent of a Git hosting service because documents are
binary and Git compares lines; live co-editing (Google Docs, Figma) lets many
people edit at once but has no branches, merge requests, or checks after a
merge. **In Kition neither premise holds**:

- A document is not binary but **structured objects with stable ids plus a
  history of operations with authors**; only blobs are binary, stored by hash,
  and merging only decides which blob is referenced.
- The KDM already has both live co-editing and branches (drafts).

### 13.2 What the KDM already has for each part

| Version control feature | Already in the KDM | Still to build |
| --- | --- | --- |
| Commit | A transaction, with its origin: who, as whom, which agent, which task | Commit messages, the objects read |
| Log | Loro's full operation history graph; local version history | A view grouped by commit |
| Checkout | Loro `checkout` (read-only view of an old version) | — |
| Revert | Loro `revertTo` writes inverse operations and keeps history; undo per person | Revert everything one agent did (partly there) |
| Branch | A KDM draft = Loro `fork`, with its own actor | Names, lists, permissions |
| Merge request | A draft's Ready → compare → Merge / Discard / Reopen flow | Comments, AI summaries, partial acceptance, showing check results |
| Merge conflict | Conflict objects (a type in the data model); deterministic repairs after merges | **Three-way comparison**: show both sides when both changed one field, instead of last-writer-wins |
| Diff | Loro `diff` for data changes; stable object ids align exactly | Each kit turns changes into words people read ("slide 3's title changed", "2 shapes deleted") |
| Blame | Every operation has a peer and a Lamport time, mapped to a person or agent | A view |
| Large file storage | `BlobRef`, the blob store by hash, reference counts per document | — |
| Remote repository | Kition Server's append-only change log, snapshots, compaction, shallow replicas | Retention "at least to the fork point of the oldest unmerged branch" |
| Permissions | owner, editor, commenter, viewer; the server refuses changes beyond them | Permissions per branch and per object scope (an agent may change only volume 3) |
| CI | The headless kit pool runs the same engine on the server to check, preview, and export; the kit's `validate` | Checks after a merge that turn failures into repair tasks |
| Visual diff | The same kit engine renders before and after | A diff mode in kit editors |
| API first | The object model and the query and batch tools; agents never read files directly | — |

### 13.3 Advantages

1. **The two hardest parts exist.** Storing and merging history is in the
   KDM and Loro; what remains is the version layer and its interface.
2. **Merges more precise than Git.** Git merges by line; the KDM by
   character, cell, object, and field. Two people changing different shapes
   on one slide, or different cells of one table, do not conflict.
3. **Live editing and branches share one history.** People co-editing merge
   automatically through the CRDT; agents work on branches and merge back
   with a three-way comparison. Both modes use the same operation history;
   they differ only in whether "both sides changed it" is shown at merge time.
4. **Ready for many agents.** Every change has an origin, so it can be traced,
   undone, and limited per agent; agents read only the objects they need
   through the API; agents can run on the server.
5. **One version layer for every kind of content.** The version layer and the
   merge request interface are written once; each kit implements only its
   semantic diff and its conflict rules.
6. **The Git ecosystem first.** Stable ids let the KDM export an expanded
   format (one text file per object) with `git merge` and `git diff` drivers,
   to test demand on existing Git hosts before building a version layer.

### 13.4 Things to watch

| Issue | Approach |
| --- | --- |
| Live mode lets delete win, while branches must show "deleted on one side, edited on the other" as a conflict | State both rule sets in the KDM text; let a schema mark fields that merge automatically even when both sides changed them (such as a last-modified time) |
| A 30-day history retention would make three-way comparison impossible for long branches | Retain history at least to the fork point of the oldest unmerged branch |
| Cherry-pick and rebase are hard on a CRDT | Not in a first version; have an agent redo the work on a new branch instead |
| Three-way comparison of large documents and long branches may be slow | Measure on the KDM; compute on the server, with shallow replicas on clients |
| A version layer built directly on Loro's history graph makes replacing the library harder | The version layer's interface uses only KDM types and never exposes Loro |

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Changing a schema after the first release is costly (no container fields on existing objects) | Freeze before the first release; afterwards only new types or `ref`s |
| Layout is not deterministic: the same document paginates differently on different machines | The KDM stores only content and the engine computes layout; fonts are packaged and layout algorithms made deterministic |
| Wrong merge semantics: coupled fields split, or non-deterministic repairs make replicas diverge | `atomic` groups; repairs are deterministic functions; the L6 convergence suite |
| History grows without bound | Compaction and shallow replicas; retention set by what branches need |
| Too tightly bound to Loro | The public API uses only KDM types; the text fixes semantics, not the implementation |
| Loro's performance traps (superlinear undo, slow imports into large maps, no abort) | Rules P1 to P5; staged transactions |

## 15. Contract boundaries

- The KDM runs on Loro 1.16 and its public API never exposes Loro.
- Collaboration is offline first: the server orders no content and handles
  only membership, permissions, persistence, blobs, and compaction.
- The KDM is part of the Kition kit platform, not of KHP: KHP
  requires no data model, and third-party kits get safe AI edits from drafts
  in file mode. Co-editing interfaces belong to the platform.
