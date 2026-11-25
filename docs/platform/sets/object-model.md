# `KitObjectModel 1.0`: scripting a document

clarifications: batch `delete` recursively removes objects held by
owning lists/trees and refs/maps declared `owns`, children first. Non-owning
refs do not cascade. Every deletion is in the receipt, subject to normal
holder attribution; an explicit delete later in the same transaction may
name a descendant already cascaded, while a missing object is still an error.
Read-only descendants refuse the whole transaction.

A node's children in a tree field held by another object are a separate case:
deleting that node refuses while it has live children. Delete descendants
child-first (or move them) before deleting the node, in the same batch. Deleting
the tree's owner still traverses the tree as an owning field. See the explicit
[tree deletion contract](../data-model.md).

Number/integer fields may declare `minimum`, `maximum`, and positive
`multipleOf`, with inclusive bounds and multiples measured from zero. Rust
and TypeScript validate them and expose them in describe. The optional field
`label` supplies human wording (a boolean's true state). The headless SDK's
optional `KitDocument::batch_settler` runs after each run of model operations
inside its transaction, so loads and receipts use file precision. Its error
rolls back that transaction; read-only loads never call it.

`json` fields accept the same limits for numeric JSON values. For
an object-valued JSON field, `members` constrains immediate named members:

```json
{"kind":"json","members":{"roughness":{"minimum":0,"maximum":1,"multipleOf":0.1}}}
```

Absent members remain optional; present constrained members must be numeric.
Other members remain unrestricted. Whole-value and member-path `set` validate
the resulting JSON atomically in Rust and TypeScript. Raw describe retains
these definitions; generated JSON Schema uses numeric `properties` without
requiring members or forbidding additional properties. Limits on a numeric
JSON value generate `type: "number"` with standard numeric keywords.
`KitDocument::batch_applied` notifies kits after each successful model-operation
transaction on both headless paths; override it to refresh separate caches
before subsequent commands. It runs after commit, makes no edit itself, and
is not called for read-only or rolled-back transactions.

For integrators who read and edit a kit's document from code, in a page or in Node, with typed objects. The SDK package is `@kition/script`; the full API is in [the object model reference](../reference/object-model.md).

The object model is how scripts, extensions, and embedders read and edit a
document as typed objects. It travels as two methods on every transport (Kit
UI protocol `model/describe` and `model/batch`; Kit Process Protocol `model.describe`
and `model.batch`, each with `documentId`). The reference implementations are
`kition_kdm::batch` (Rust) and `@kition/kdm`'s `batch.ts` (TypeScript), run on
the same fixtures; `@kition/script` is the scripting library over them
([object-model.md](../reference/object-model.md)).

- **OM1** `model/describe {}` answers `{ capability: "KitObjectModel 1.0",
  kit, schemaVersion, root, rootId, types, commands }`: `types` is the
  schema's (each field's `kind`, `of`, `values`, `optional`, mark keys, and
  `readOnly`; each type's `readOnly` or `readOnlyWhen`, OM8, and `toolId`, OM9),
  `rootId` the id of the one object of the root type (or `null`), `commands`
  the command catalogue (engine rule E7, [engine contract](../kits/engine.md)).
- **OM1a** A JSON Schema made from `model/describe` (KHP A16a's `describe: "*"`)
  keeps what a writer needs in JSON Schema's own vocabulary: `enum` for an
  enum's values, `readOnly: true` for a read-only field or type (OM8; a type
  read-only by `readOnlyWhen` says so in its `description`). Two annotations
  carry what JSON Schema has no word for: `"x-kdm-ref": "<type>"` on a string
  that holds the id of another object of that type (a `ref` field, and the
  items of a `list` or `tree`), and `"x-kdm-ops": [...]` on a container field
  (`text`, `list`, `tree`, `map`), naming the batch operations that change
  it; a field with `x-kdm-ops` is never the `field` of a `set`. The one-line
  listing (`describe: true`) marks the same: `ref to <type>`, `text (text.*
  ops, not set)`, `enum a|b|c`, `, read-only`, and `(read-only)` or
  `(read-only when <field> is <value>)` after a type's name. Where the kit
  declares tool ids (OM9), a type's schema carries its `toolId` as
  `"x-kdm-id"` and says how its ids read, and the listing marks `(ids
  item:<number>)`, `(ids <Story id>/table:<number>)`, or `(object ids)`
  after each type's name.
- **OM2** `model/batch { origin?, ops, load? }` answers `{ refs, results,
  loaded }`. Operations: `create { type, fields?, in?: "<target>.<field>",
  at?: "end" | index, parent?, ref?, id? }` (into a list field at `at`, or
  into a tree field under `parent`), `set { target, field, value }` (`field` may
  be a path from the target: through owning fields, a ref or map
  declared `owns` and a list by index, to a field of a held object without a
  tool id, `body.paragraphs.0.text`; or the same in the kit's words where the
  types on the way declare `pathName`, `transform/opacity.value.v`; past a
  `json` field the rest is a path inside its value. Refused as `invalid-op`: a
  path through a ref that does not own, into an object with a tool id of its
  own, past a list's end, through a tree, or to no field; the shared fixture
  `batch-paths.json`), `delete {
  target }` (the object also leaves every list holding it), `text.insert {
  target, field, index, text }`, `text.delete { …, index, count }`, `text.set
  { …, text }`, `text.mark { …, start, end, key, value }`, `text.unmark { …,
  start, end, key }`, `list.insert { target, field, index | "end", item }`,
  `list.move { …, from, to }` (`to` is a gap counted before the item leaves,
  so `to` equal to the length moves it to the end), `list.remove { …, index }`,
  `map.set { target, field, key, value }`, `map.delete { …, key }`,
  `tree.insert { target, field, item, parent? }`, `tree.move { target, field,
  item, parent? }`, and `command { id, params? }`. `results[i]` is a created object's id or a
  command's result, otherwise `null`. `load: [{ target, fields? }]` answers
  `{ id, type, fields }` (every field the schema declares is in `fields`, one
  named `id` or `type` too: a tool id's field may be named `id`): registers as values, text as a string (as runs
  `{ insert, attributes? }` when the field declares marks), lists as ids, maps
  as objects, trees as `{ object, parent }` in pre-order.
- **OM2a** A tree node is named by the object it names; `parent` is an
  object in the same tree (absent or `null`: a root). A node created or moved
  becomes the last child of its parent. `tree.insert` adds an object that is
  not in the tree yet (`invalid-value` otherwise); `tree.move` refuses a move
  that makes a node its own ancestor (`invalid-value`) and an object that is
  not in the tree (`not-found`). `at` other than `"end"` is `invalid-op` in a
  tree. Deleting an object leaves its node in the tree, skipped by `load` and
  by readers with its subtree; `delete` is refused (`invalid-value`) while the
  node has children whose objects exist, so no object loses its place
  silently.
- **OM2b** A `set` or a `create` that gives a `ref` field the id of no
  object fails with `not-found` at that operation, naming the field, the type
  it refers to, and what to give instead (an existing object's id, or the
  `$name` of one created earlier in the batch). `null` clears an optional
  reference. A reference may still dangle afterwards, when its object is
  deleted (M4a); the batch only refuses to write one.
- **OM3** A target is an object id (a tool id where the type declares one,
  OM9), `root`, or a `$` reference bound by an earlier `create` of the same
  batch. A string equal to a bound reference,
  anywhere in `fields`, `value`, `item`, or a command's `params`, becomes its
  id; `refs` answers every binding. Text positions count Unicode scalar
  values (M18).
- **OM4** Each run of model operations between commands is one transaction
  with the batch's origin: all or nothing. A failing step stops the batch;
  earlier steps stay. The error is `{ code, index, message }`, `code` one of
  `invalid-op`, `not-found`, `invalid-value`, `read-only`, `command-failed`,
  `index` the failing operation (`null` for the batch or a `load`).
- **OM4a** An agent's `<prefix>_batch` (KHP A16) is one change, and a failed
  call leaves the document as it was (KHP A18), whatever OM4 lets a batch
  keep. A batch whose only operations are model operations is one
  transaction already, and so is a batch of one command. A batch that runs a
  command among other operations is taken back when it fails, as a failed
  `<prefix>_run` is (KHP A53): a headless document with no unsaved edits is
  opened again from its file, a headless draft from what was stored. Where
  only undo could take the command back (the file is open in its editor, or
  the headless document has unsaved edits), the batch is refused before
  anything runs, with `unsupported` and a message that says to run the
  command with `<prefix>_run` and the other operations in their own batch.
  Operations after a command are checked as they run: they read what the
  command did, so no layer can check them before it runs.
  (`kition-kits` and `@kition/embed`'s agent port.)
- **OM5** The origin is `{ kind, principal, label? }` with kind `person`,
  `agent`, or `extension`, and `extension`/`script` when absent. A read-only
  document refuses a batch that writes (`read-only`) and answers one that only
  loads.
- **OM6** A host MAY answer the object model itself over a kit that does not:
  it keeps its own replica of the document (same schema), catches it up from
  the kit's change exchange (`replica/export`, or the engine's
  `exportChanges`), runs the model operations on it, hands the new changes to
  the kit (`replica/import`, `importChanges`) as a collaborator's, and runs
  commands through the kit (`ai/run`, `executeAs`). Edits made this way are
  not in the person's undo history; a kit that answers `model/*` itself (the
  `kition-kit`'s `export_kit_session!` does) makes a batch one undo step.
- **OM7** A headless executable that serves `model.describe` and
  `model.batch` lists both in `capabilities.features` of `kit.initialize`, and
  its manifest lists them in `headless.features` (manifest rule K9, [manifest](../kits/manifest.md)).
  `kition-kit-server` adds them for every backend that serves `model.*`.
- **OM8** Read-only content: content a kit keeps verbatim but does not model
  (a shape it only preserves, a package part it keeps byte for byte, kept
  OLE or VML) is marked in the KDM schema, and the object model reads it but
  never writes it. A field takes `"readOnly": true`; a type takes
  `"readOnly": true` (every object of it) or `"readOnlyWhen": { "field",
  "values" }` (the objects whose enum `field` holds one of `values`; `field`
  is an enum field of the type, `values` some of its values, and the two
  keys exclude each other). A batch fails with `read-only` at the operation
  that would `set`, `delete`, or run a `text.*`, `list.*`, `map.*`, or
  `tree.*` operation on a read-only object or field, `create` a read-only
  object or give a read-only field a value, `set` the field that would make
  an object read-only, `create` into a read-only object's list or tree, or
  `delete` an object from the list of a read-only object or field. The check
  comes before the operation's own arguments. Placing a read-only object in a
  writable list or tree (`list.insert`, `list.move`, `list.remove`,
  `tree.*` on the writable owner) is allowed, and so are writes to a writable
  object held by a read-only one. Loads answer read-only content as any
  other. Commands still go through the kit, and the kit's own transactions
  (import, its commands) write it. The marks change nothing in
  the stored document: adding or removing them needs no new schema version
  (M20), and a document reads the same under a schema with or without them.
- **OM9** *Tool ids.* A kit whose own tools name objects by ids of its own
  (inspect, commands, diagnostics, hit: `item:10`, a layer number) gives
  the object model those ids, so a document has one id space at the tool
  interface (KHP A47) and an id one tool answers works in every other, in
  this call or a later one (A46). A type declares it in the KDM schema:

  ```json
  "Item":  { "fields": { "number": { "kind": "integer", "optional": true, "readOnly": true }, … },
             "toolId": { "field": "number", "prefix": "item:" } },
  "Table": { "fields": { "number": { "kind": "integer", "optional": true, "readOnly": true }, … },
             "toolId": { "field": "number", "prefix": "table:", "parent": "Story" } }
  ```

  `field` is a `readOnly` `integer` or `string` field of the type holding
  the id the kit gives the object: only the kit writes it (when it reads a
  file, in its commands, and for what a batch created); make it `optional` so a batch can create the type.
  `prefix` (default empty: ASCII letters, digits, `_`, `-`, `:`, `/`, a
  letter first, at most 32) comes before the value: `item:10`. `parent` is a
  type with a `toolId` whose objects hold this type's in a `list`, `tree`, or
  `ref` field: the id is the holder's id, `/`, and the type's own part
  (`story:11/table:2`). A schema whose `toolId` names a field that is not
  read-only or not an integer or string, a bad prefix, or a parent without a
  `toolId`, holding no field of the type, or leading back to it, is refused.

  An id is unique among the document's live objects: its domain is its
  prefix and, with `parent`, its holder. Types that share a prefix (and a
  parent type) share one sequence of values, which the kit keeps unique;
  values unique only per type take a prefix per type, and values unique only
  within a holder take a `parent`. An object has a tool id when its field
  holds a value, it has one holder of its parent type and that holder has a
  tool id, and no other live object renders the same id. Every other object
  answers its object id: a type without `toolId`, an object the kit has not
  numbered yet, and objects whose ids collide (two replicas that numbered
  concurrently, until the kit's repair numbers one again).

  With the declaration, `model/batch` answers tool ids wherever it answers
  an object (`results` of `create`, `refs`, a load's `id` and the ids its
  `ref`, `list`, and `tree` fields hold, `rootId`, and messages that name
  objects) and takes them wherever it takes one (targets, `in`, `item`,
  `parent`, and `ref` values; an object id still names its object). A `$`
  reference in a command's `params` becomes the object's tool id, since
  commands take the kit's ids. Ids are read before each run of operations
  and after the batch: an object the batch created is named by its `$`
  reference within the batch and answered with the id the kit gave it (its
  object id until it has one). A target that names no object is
  `not-found` and lists the ids it may have meant (those ending in the same
  value, or those of its domain when there are few; KHP A48); one that
  several objects render is `invalid-op` and lists them with their types
  (A44). A draft's comparison names objects the same way. The object id
  stays the identity replicas, `kition-sync/1`, selections (`KitPointer
  1.0`), and `@kition/script`'s `selection` event carry. A schema without
  `toolId` answers object ids as before. Like OM8's marks, `toolId` changes
  nothing stored. (`kition_kdm::tool_ids`, `@kition/kdm`'s `toolIds.ts`; the
  shared fixture `tool-ids.json`.)

  A field declared `"position": true` says where its object is, not what it
  is (a clip's `start` and `duration` on its track, a row's index): agent
  tools read its change as a move of the object (the premise guard's
  `relocated`; a command declared position-independent is not refused for
  it), and two reads of a file compare objects without it when they look for
  renumbered tool ids. Like `owns`, it changes nothing stored
  (`FieldDef::position`, `@kition/kdm`'s `FieldDef.position`).

  An object without a tool id of its own is a part of the nearest object
  holding it that has one: held through a `list` or `tree` field, or a `ref`
  field declared `"owns": true` (a shape's text body; a ref without it only
  points, as a picture points to media other pictures share), or a `map`
  field declared `"owns": true` (a table's cells: under each key, the object
  the value names, or each member of an object value that names one, such as
  a cell's `{ "body": <id>, … }`; only `ref` and `map` fields take `owns`).
  Change sets (receipts, `others`, a draft's comparison) tell such an
  object's changes as edits of that holder, at the path from it: field names,
  positions and map keys (with the member) joined by `.`, as the tools'
  `follow` paths read (`body.paragraphs.0.text`,
  `table.cells.<key>.body.paragraphs.0.text`), so the ids of held objects
  never reach the agent while a holder with a tool id exists. An object
  deleted at a path and another created at the same path are one object
  changed there (a paragraph replaced, a text body made again): only the
  values that differ are told, at `<path>.<field>`. A kit gives its owning
  refs and maps `owns`; without it, text inside a shape is told by its
  paragraphs' object ids. (`ToolIds::attributed`, `StateDiff::with_tool_ids`;
  the shared fixtures `attribution.json`, `map-ownership.json`.)

  A type may also declare how its objects are named in a path as the kit's
  commands name them: `"pathName": "name"` (a `string` or `enum` field) or
  `"pathName": "meta.match"` (a member of a `json` field). Among the items of
  a `list` holding them, each is named by that text; by `#<n>` (its place
  from 1) when the text is empty, a number, or holds `/`, `.`, `#` or `@`;
  and `<name>#<n>` for the n-th item of one name after the first. An edit
  inside a held object then carries `named` beside its positional `field`:
  the names of the objects on the way joined by `/`, then the path below the
  last of them; the fields leading to the first and between them are not
  written (`{ "field": "props.children.2.children.7.value.v", "named":
  "transform/opacity.value.v" }`, a key `transform/opacity.keys.0.time`).
  (`ToolIds::named_path`; the shared fixture `path-names.json`.)

  Words for people: a type's `"label": "props.name"` (a `string`, `text` or
  `enum` field, or a member of a `json` field) says what names its objects; a
  field's `"display": { "kind": "time", "perSecond": 254016000000, "fps": 30 }`
  shows a tick count as a timecode (`00:00:05:00`, or `00:00:05.000` without
  `fps`); a field's `"sample": false` keeps edits of it out of sampled tasks
  (an item's `kind`, whose change remakes the item). `describe` answers them;
  the shared fixture `words-schema.json`.
