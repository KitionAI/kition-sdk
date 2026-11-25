# `KitModel 1.1`: the Kit Data Model

field metadata: number/integer definitions accept inclusive
`minimum`/`maximum` and positive `multipleOf` (zero-based). A value outside
these limits is invalid. `label` is an optional human field label, used as
the true-state wording of a boolean. These annotations change no stored
representation; both implementations retain them in model describe.

extends numeric limits to `json` fields. Bounds on the field require
a numeric JSON value; `members: { roughness: { minimum: 0, maximum: 1 } }`
instead constrains present immediate numeric members of an object value.
Members stay optional and other members unrestricted. The KDM
validates whole-value writes and writes through a JSON path against the same
definition, atomically. These are schema metadata, with no stored-format or
schema-version change. Explicit Rust `FieldDef` literals add `members`.

The core every other set builds on: a kit's document as typed objects whose every change is a transaction, applied in one order, exported to the replicas that follow it, and undone per author.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as described in RFC 2119.

| Version | Adds |
| --- | --- |
| `KitModel 1.0` | The schema, identity, transactions and origins, per-replica undo, exchange, snapshots, schema evolution, comments |
| `KitModel 1.1` | Undo scopes (M12a): on one replica, a person's undo and an agent's undo each take back only their own steps |

## Three kinds of change

| Kind | What it is | Exported as a change | Undoable |
| --- | --- | --- | --- |
| **Command** | A named intent with a parameter schema (`slide.duplicate`). Resolves its targets and emits one transaction | No (its label is recorded with the transaction) | Through its transaction |
| **Transaction** | The atomic group of KDM operations a command produces, with an origin | Yes | Yes, as one step |
| **View operation** | Selection, caret, scroll, zoom, active tool, panel state | No; selection and caret are reported to the host as [`KitPointer 1.0`](pointer.md) selections | No |

- **M1** Every change to persistent document state MUST be a transaction:
  typing, dragging, inking, menus, scripts, extensions, imports, and agents.
- **M2** View operations MUST NOT be stored in the KDM.
- **M3** A command MUST resolve every target to object ids before it emits
  operations; replaying a command name against another session's selection
  is not a valid change.

## Schema

A kit on the KDM ships `model/schema.json`:

```json
{
  "kdm": 1,
  "kit": "kit.example",
  "schemaVersion": 1,
  "root": "Page",
  "types": {
    "Page": { "fields": { "title": { "kind": "string" }, "shapes": { "kind": "list", "of": "Shape" } } },
    "Shape": { "fields": { "x": { "kind": "number" }, "label": { "kind": "text" } } }
  }
}
```

| Field kind | Holds |
| --- | --- |
| `string`, `number`, `integer`, `boolean` | One value |
| `enum` | One of `values` |
| `json` | Any JSON value, replaced whole; use it for coupled values (a transform) |
| `blob` | `{ hash, mime, size }` naming content-addressed bytes |
| `ref` | The id of an object of type `of`; a dangling reference is a validation state |
| `text` | Unicode text, with the `marks` it declares (rich-text runs, M19) |
| `list` | Ordered ids of objects of type `of`, with moves |
| `tree` | Nodes in order under parents, each naming one object of type `of` (M10b) |
| `map` | String keys to JSON values |

- **M4** `kdm` MUST be `1`. Type and field names starting with `$` are
  reserved: a schema that declares one is refused. `ref`, `list`, and `tree` MUST name a declared type in `of`, and
  only they take `of`; an `enum` MUST list `values`, and only it takes
  `values`. Fields are required unless `optional`. `integer` values MUST be
  exact in every implementation (|v| ≤ 2^53). A field MAY take `readOnly`
  and a type `readOnly` or `readOnlyWhen` ([`KitObjectModel 1.0`](object-model.md), OM8), and a type
  `toolId` (`{ field, prefix?, parent? }`, OM9: the read-only field holding
  the id the kit's tools give its objects); they bind the object model only.
- **M4b** Every stored value (register fields, `json` and `blob` values,
  and `map` values) MUST be plain JSON: null, booleans, strings, finite
  numbers, arrays, and objects, so every implementation reads the same value.
  Integer-typed values (a Rust `i64`, a JSON integer) MUST lie within ±2^53;
  doubles of any finite magnitude are allowed. An object key named
  `__proto__` is refused at any depth inside a value. Binary values, dates,
  NaN, and infinities are refused. (Map keys, type names, and field names
  named `__proto__` are allowed: implementations read them key by key.)
- **M4c** A `text` field MAY declare `marks`, the run properties its
  characters carry (bold, a font, a link, an object anchor), each with how it
  grows when text is typed at a marked range's end:

  ```json
  "text": { "kind": "text", "marks": { "bold": { "expand": "after" }, "link": { "expand": "none" } } }
  ```

  `expand` is `after` (text typed right after the range takes the mark: bold,
  italic), `before`, `both`, or `none` (links, anchors); it is required, and
  `expand` is the mark definition's only key. Only `text` fields take
  `marks`. A mark key is not empty, does not start with `$`, holds no `:`,
  and is not `__proto__`; one key has one `expand` across the whole schema.
  A schema that breaks any of these is refused.
- **M4a** A `ref`, `list`, or `tree` target that exists MUST have the type
  named by `of`; a missing target is allowed (a dangling reference is a
  validation state).
- **M5** `schemaVersion` MUST increase when the schema changes. Replicas
  preserve fields they do not know. A document records the `kdm` version and,
  in `meta.schemaVersion`, its minimum schema version (M20): the version it
  was created with, raised only by a migration. A replica MUST refuse to load
  a document of another `kdm` version or one whose minimum schema version is
  newer than its schema; M20 also checks imported changes. Reads MUST
  tolerate objects of undeclared types (read as their `$type` only). A new
  schema version MAY add fields of any kind to existing types: an object
  that does not hold a field reads it as empty (`null` for a register, an
  empty text, list, map or tree), and a container field is made by its first
  write.
- **M5a** Author schema version: every commit records, after its origin,
  the schema version of the replica that made it: the commit message is
  `[kind, principal, label, schemaVersion]` (`Origin::encode_commit` and
  `Origin::decode_commit`, `encodeCommit` and `decodeCommit` in
  TypeScript), carried in each change and never in a file.
  `author_schema_version()` (`authorSchemaVersion()` on an engine) answers
  the newest one among the changes a replica applied in its session, or the
  one its snapshot records. A replica holding changes
  written under a newer schema than its own keeps working: it preserves what
  it does not know (M5), and objects of types its schema lacks read as their
  `$type` only and refuse writes (`unknown-type`), so edits are blocked only
  for them. A host tells the person that a newer kit edited the document and
  offers the update, in a notice that does not block editing; an embedded
  kit's editor reports it to its host (Kit UI protocol `document/schema`). When a newer kit's migration raised the minimum schema
  version (M20), the import is refused instead: the host keeps the document
  read-only, as it last read it, until the kit is updated.
- **M6** Check a schema with `cargo run -p kition-kdm --example check-schema -- model/schema.json`.

## Identity

- **M7** A document has a `docId` that never changes when its file is renamed
  or moved. Implementations generate a UUID v7 and accept any UUID when
  loading.
- **M7a** A copy of a document under a new `docId` is a new document:
  `copy_as_new_document(doc_id, actor)` answers a replica of `doc_id` with
  the same objects, ids and values, on a new lineage (M14), with an empty
  change log and empty undo, and refuses (`invalid-value`) the source's own
  `docId`. Copies and their source refuse each other's bytes (M17). Hosts
  use it for templates, copied files and repeated uploads; a fork (A12)
  keeps the `docId` and is merged back, a copy never is. For a kit whose
  files embed the model, a host reads the `docId` a file carries and makes a
  file into a new document through the kit, without knowing its format: the
  Kit Process Protocol's `document.identity` and `document.fork`
  ([section 5.6](../reference/kit-process-protocol.md#56-document-identity-and-forks),
  feature `document.identity`).
- **M8** Objects have KDM ids (UUID strings), unique without coordination. Implementations generate UUID v7 ids and accept any UUID when
  loading. Engines MAY keep efficient local ids and file-format
  ids, mapped to KDM ids when loading, and MUST NOT allocate new persistent
  ids from a document-local counter. A host MAY create an object under an id
  it chose (`[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`, unique in the document);
  generated ids are UUID v7. An engine's own id that its tools show is a
  field of the object, never its KDM id, and its schema names that field as
  the type's tool id ([`KitObjectModel 1.0`](object-model.md) OM9).
- **M9** Every writable replica session has its own actor id, recorded with
  each change it writes. Two sessions MUST NOT share one, including two
  windows on one device.

## Transactions, origins, undo

- **M10** A transaction is all-or-nothing: if any operation fails, the
  transaction MUST change nothing, so the replica's version and exports are
  unchanged. Implementations stage a transaction's operations, validate
  them against the document plus the transaction's pending effects, and
  apply them only when the transaction succeeds; reads inside a transaction
  see its pending effects. Applying records what each operation's inverse
  needs, and an operation that still fails to apply takes back the ones
  applied before it, so no partial change is ever logged or exported. A
  transaction that succeeds is one change, numbered one after the replica's
  version (M14).
- **M10a** A tree node created in a transaction is identified by a handle
  that resolves when the transaction commits; a handle from a failed
  transaction is not found.
- **M10b** A tree names each object with at most one node, and the node is
  the object's id: creating a node for an object the tree already holds is
  refused (`invalid-value`). Deleting an object takes its node out of every
  tree holding it, and is refused while its node has children naming live
  objects ([`KitObjectModel`](object-model.md) OM2a).
- **M11** Every transaction carries an origin `{ kind, principal, label }`,
  `kind` one of `person`, `agent`, `extension`, `import`, `system`. Servers
  and hosts MUST NOT use it for authorization. The origin is recorded with
  each change (M5a); reading history back across sessions is not specified.
- **M12** Undo takes back the replica's own last step of a scope (M12a) by
  applying its inverse operations to the current state as a new change;
  later changes of other scopes and imported changes, including later
  changes to the same object, MUST survive. The inverses are carried over
  the changes logged since the step: text and list positions move with what
  was inserted or deleted before them, and a deleted range drops what is
  gone. A register or map key someone else wrote since keeps that value, and
  an operation whose object is gone is skipped. Undo and redo report the
  objects they change like any other change. Undo groups make several
  transactions one undo step. A step whose changes come to nothing (Enter,
  then Backspace, in one group; a value written and written back) is no
  step to undo: undo and redo pass over it and take back the step before it
  in the same call, as they pass over a step whose changes others took
  back. Until an undo passes over it, `can_undo` still counts it; an undo
  that finds nothing to take back changes nothing and answers false. A
  scope keeps at most 100 steps. Transactions with origin `system`
  (migrations) or `import` (a file changed elsewhere, written over the
  document) are not undo steps: undo skips them like imported changes, and
  they survive the undo of earlier transactions.
- **M12a** *(1.1) Undo scopes.* A replica keeps one undo history per **undo
  scope**, and every transaction that is an undo step joins exactly one:

  | Origin `kind` | Scope |
  | --- | --- |
  | `person`, `extension` | `person`: the person at this replica, and the scripts and extensions they run |
  | `agent` | `agent`: the agents working for that person on this replica (`ai/run`, agent tools) |
  | `import`, `system` | none (not undo steps, M12) |

  A draft merge (`merge_changes`, KitAgent A14) is the exception: it is
  labelled `agent` but is the person's step, so the person's Undo takes the
  whole merge back. Undo and redo in one scope treat every other scope's
  transactions as M12 treats imported changes: they survive, including
  later writes to the same register, and an undo of an agent's step keeps
  the person's later typing. Undo groups (M12) span both scopes, so the
  steps of one agent run made inside a group undo as one agent step.
- **M12b** *(1.1) Undo groups across imported changes.* A person's undo
  group stays one undo step when imported changes arrive while it is open,
  also when they touch what the group changed: one Undo takes back all of
  the group's transactions and keeps those changes, and one Redo puts the
  group back. Two groups stay two steps, and each scope's steps stay in that
  scope (M12a) ([undo across remote edits](../undo-across-remote-edits.md)).

  `undo()`, `redo()`, `can_undo()`, and `can_redo()` (`undo()`, `redo()`,
  `canUndo()`, `canRedo()` on an engine) work in the `person` scope;
  `undo_in(scope)`, `redo_in(scope)`, `can_undo_in(scope)`, and
  `can_redo_in(scope)` name the scope. An engine's `edit.undo` and `edit.redo` work in the scope of the
  origin they run as (a step of `ai/run` runs as `agent`), or in the scope
  their optional `scope` parameter names (`"person"` or `"agent"`), so a
  person's editor can offer "Undo the agent's last change" without the
  agent's Undo ever taking back the person's work. Hosts and kits SHOULD
  offer the person that action wherever they show agent edits (KitAgent A9).

  Several people never share a replica session (M9), so the `person` scope is
  per person.
- **M13** An editor bound to a KDM field MUST apply every change to that
  field except the ones it published itself: imported changes, undo, and an
  agent on the same replica all reach the editor.

## Exchange

- **M14** A replica's version is `(lineage, seq)`: a random UUID naming its
  line of changes and the number of that line's changes its state holds.
  `Version::encode()` is 24 bytes (the lineage, then `seq` as 8 bytes
  big-endian) or, for the empty version, none; equal versions are equal
  bytes. A new lineage starts with `create`, with loading content (M16b) and
  with `copy_as_new_document` (M7a); loading a snapshot and forking continue
  one. A replica exports what a replica at `since` lacks
  (`export_changes(since)`): the changes after `since`, in order, when
  `since` is on its lineage and its change log holds it, else a snapshot
  (M16). It imports changes in order (`import_changes`): changes it already
  has are skipped, so importing twice is harmless; the first new one MUST
  follow its version, and changes that do not, changes of another lineage,
  and changes whose operations' preconditions do not hold are refused
  (`KdmError::Stale`, reason `stale`) without changing anything. A snapshot
  imports when it is on the replica's lineage and not behind it, or into a
  replica that has applied nothing; it replaces the state. Each import
  reports which objects it changed. The change log holds at most 10,000
  changes or 64 MB and drops its oldest beyond either; a version older than
  it is answered with a snapshot, or with `history-missing` by `fork_at` and
  `changes_since`.
- **M15** Every replica that has the same state **and the same schema** has
  the same canonical state: the document as JSON with keys sorted
  (`state_json`). The canonical state follows the reader's schema:
  undeclared fields are omitted, and objects of undeclared types show only
  `$type`. `@kition/kdm` reads the same canonical state from a snapshot and
  the changes after it.
- **M16** A snapshot (`snapshot`) is the document's content (M16b) with its
  version: for the host's store, drafts, a page's mirror and new replicas.
  `load` opens content or a snapshot.
- **M16b** A person's file holds no history. A kit whose file embeds its
  model MUST write `content_snapshot()` into the file (`content.json`, data
  model section 7.4), and MUST NOT write `snapshot()` there. The content
  holds the state alone: no version, lineage, actor, origin or time, so a
  document saved again unchanged is the same bytes, and two people who save
  the same state write the same bytes. It loads as the same document (same
  `docId` and object ids) on a new lineage.
- **M17** Changes and snapshots name their document (`docId`). A replica
  MUST refuse another document's (`KdmError::WrongDocument`), so two
  documents can never be mixed by mistake.
- **M18** Text positions are local coordinates of each implementation:
  Unicode scalar values in Rust, UTF-16 code units in TypeScript (the units
  of CodeMirror and the DOM). A position inside a character is out of range.
  A change's text operations count Unicode scalar values; `@kition/kdm`
  converts where it answers UTF-16.
- **M19** Marks: a transaction sets a declared mark over a range of a text
  field (`text_mark(id, field, start, end, key, value)`) or removes it
  (`text_unmark(id, field, start, end, key)`), positions per M18 and checked
  against the text including the transaction's earlier edits; an empty range
  changes nothing. Each mark key has one value per character, and a later
  mark of a key replaces the earlier one over its range. Text inserted takes
  a key from its neighbours: from the run before it when the key's `expand`
  is `after` or `both`, from the run after it when it is `before` or `both`,
  and inside a run whose neighbours hold the same value of the key. A key the
  field does not declare is refused, and so is a `null` value (remove a mark
  with `text_unmark`); values are plain JSON (M4b) and read in canonical
  form. A text field that declares marks reads in the canonical state (M15)
  as its runs, `[{ "insert": "...", "attributes": { key: value } }]`: in
  text order, no run empty, adjacent runs with different marks,
  `attributes` omitted for an unmarked run and holding only the reader's
  declared keys; an empty text is `[]`. A text field without marks reads as
  a string. `text_delta(id, field)` (`textDelta`) answers the same runs;
  `text` answers the plain string. Bridges write a field's new form as a
  difference (`kition_kit::session::write_text`, `write_marks`,
  `write_rich_text`), not a replacement, so undo takes back only what
  changed.
- **M20** Minimum schema version: a document's minimum schema version is the
  version it was created with, raised by migrations that rewrite it into a
  form older readers would misread. A `system` transaction raises it
  (`Tx::raise_schema_version(version)`), in the transaction that rewrites
  the document, to at most the transaction's own schema version; a raise in
  any other transaction is refused, so a raise is never an undo step. The
  minimum is monotonic: a raise to the current or a lower version changes
  nothing. It is `meta.schemaVersion` in the canonical state and
  `schemaVersion` in the content (`min_schema_version()`,
  `minSchemaVersion()`). A replica whose schema is older than the minimum
  MUST refuse to load the document and to import changes that raise it there
  (`KdmError::NewerSchema`, reason `newer-schema`): a refused import
  changes nothing; the host keeps the document read-only as it last read it
  and asks for an update (M5a).

- **M21** Coordinated objects: some edits make no sense for two people at
  once (two people repainting one layer's pixels, two full rewrites of a PDF,
  two constraint solves). A kit takes a **lease** on such an object's scope
  before editing it (a KDM object id, a name of its own such as
  `layer:<objectId>`, or `*` for the whole document), through its host (Kit
  UI protocol section 7b); it does not start the edit while another session
  holds the scope, and releases the lease when the edit ends. An agent's
  edits on the live document (`ai/run` steps) take the leases the person's
  would. A kit lists the scopes it leases in `kit.json`
  `collaboration.leases` (patterns such as `layer:{objectId}`, or `*`), so a
  host can tell which of its edits coordinate.
- **M23** Comments: people discuss a document in **comment threads** kept
  beside its content. A thread is an object of the reserved type
  `CommentThread` (`anchor`, `resolved`, `comments`), each of its comments an
  object of the reserved type `Comment` (`author`, `name`, `body`, `created`),
  declared as `kition_kdm::comment::COMMENT_THREAD_TYPE_JSON` and
  `COMMENT_TYPE_JSON` (`@kition/kdm`: `COMMENT_THREAD_TYPE_DEF`,
  `COMMENT_TYPE_DEF`); a kit MAY add optional register fields to either
  (initials a file format keeps). `anchor` is JSON naming the commented
  `object` by id, optionally a `field` of it, a `range` (`{start, end}`,
  character offsets in a `text` field when the thread was made), and the
  `quote` the range held then; a kit MAY add keys of its own (a point on a
  slide). `author` is the principal id of the writer (for comments imported
  from a file, the file's author name), `name` their display name, `created`
  ISO 8601 UTC, and `body` text. Comments MUST NOT be stored in the content
  (no comment marks or fields on content objects), and content MUST NOT
  reference a comment: a change that touches only `CommentThread` and
  `Comment` objects is then a comment, which is all a commenter may make. A kit whose file format keeps comments maps them onto these objects
  on import and back on export. An editor shows the threads others wrote as
  read-only history (a person may still add their own). `kition_kdm::comment`
  (`add_thread`, `reply`, `set_resolved`, `delete_comment`, `threads`)
  implements it, and `@kition/kdm`'s `commentThreads` reads the threads; `@kition/kit-editor`'s `CommentsPanel` and
  `useCommentAnchors` show threads in an editor. A kit whose engine writes
  comments through commands lists them in `kit.json` as
  `collaboration.comments.commands` (K13), such as `comment.add`,
  `comment.reply`, `comment.resolve`, and `comment.delete`; its editor passes
  the same list to `@kition/kit-editor` (`KitModuleManifest.commentCommands`). A
  commenter's document opens read-only with `document.comments.canComment`
  (Kit UI protocol section 3): the editor refuses every edit as for a viewer
  (UI-K7) except these commands, and each of them runs under a backstop that
  reads the change it made: when it touches anything but `CommentThread` and `Comment` objects, it is undone
  and refused (`read-only`). Undo and Redo take back and bring back the
  commenter's own comment changes: only as many steps as their comment
  commands made in the session, each under the same backstop (an Undo that
  would reach anything else is refused and taken back). Save and the file
  commands stay refused: the file is not theirs to save. An editor hides from a
  commenter the commands it refuses them, rather than showing them disabled,
  and keeps offering the comment commands, Undo, and Redo.
  `@kition/kdm`'s `ChangeAudit` and `touchesOnlyComments` read a change that
  way.
- **M24** *(proposed)* Lossless round trip: content of an imported file that
  the kit's schema does not model (an unknown shape, a package part, an
  extension element) MUST be kept as **opaque objects**, with the
  relationships that tie it to the rest of the file, and written back
  unchanged by export when the content it depends on is unchanged. Opaque
  objects are read-only through the object model (OM8) and are never
  counted as editable content. The round trip test (import, export,
  re-import of the kit's fixture corpus) includes fixtures with such
  content and requires it to survive.
