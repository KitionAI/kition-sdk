# `KitModel 1.1`: the Kit Data Model

field metadata: number/integer definitions accept inclusive
`minimum`/`maximum` and positive `multipleOf` (zero-based). A value outside
these limits is invalid. `label` is an optional human field label, used as
the true-state wording of a boolean. These annotations change no stored
representation; both implementations retain them in model describe.

extends numeric limits to `json` fields. Bounds on the field require
a numeric JSON value; `members: { roughness: { minimum: 0, maximum: 1 } }`
instead constrains present immediate numeric members of an object value.
Members stay optional and other members unrestricted. Rust and TypeScript
validate whole-value writes and writes through a JSON path against the same
definition, atomically. These are schema metadata, with no stored-format or
schema-version change. Explicit Rust `FieldDef` literals add `members`.

The core every other set builds on: a kit's document as typed, replicated objects whose every change is a transaction that can be exported, merged with concurrent changes, and undone per author.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as described in RFC 2119.

| Version | Adds |
| --- | --- |
| `KitModel 1.0` | The schema, identity, transactions and origins, per-replica undo, exchange, snapshots, shallow replicas, schema evolution, comments |
| `KitModel 1.1` | Undo scopes (M12a): on one replica, a person's undo and an agent's undo each take back only their own steps |

## Three kinds of change

| Kind | What it is | Replicated | Undoable |
| --- | --- | --- | --- |
| **Command** | A named intent with a parameter schema (`slide.duplicate`). Resolves its targets and emits one transaction | No (its label is recorded with the transaction) | Through its transaction |
| **Transaction** | The atomic group of KDM operations a command produces, with an origin | Yes | Yes, as one step |
| **View operation** | Selection, caret, scroll, zoom, active tool, panel state | No; selection and caret MAY travel as presence, and are reported to the host as [`KitPointer 1.0`](pointer.md) selections | No |

- **M1** Every change to persistent document state MUST be a transaction:
  typing, dragging, inking, menus, scripts, extensions, imports, and agents.
- **M2** View operations MUST NOT be stored in the KDM.
- **M3** A command MUST resolve every target to object ids before it emits
  operations; replaying a command name against another replica's selection
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

| Field kind | Holds | Merge |
| --- | --- | --- |
| `string`, `number`, `integer`, `boolean` | One value | Last writer wins per field |
| `enum` | One of `values` | Last writer wins |
| `json` | Any JSON value, replaced whole | Last writer wins; use it for coupled values (a transform) |
| `blob` | `{ hash, mime, size }` naming content-addressed bytes | Last writer wins |
| `ref` | The id of an object of type `of` | Last writer wins; a dangling reference is a validation state |
| `text` | Unicode text, with the `marks` it declares (rich-text runs) | Sequence merge; concurrent insertions are all kept; marks per M19 |
| `list` | Ordered ids of objects of type `of`, with moves | Sequence merge; a concurrent move never duplicates an item |
| `tree` | Movable tree of nodes naming objects of type `of` | Concurrent moves never form a cycle |
| `map` | String keys to JSON values | Last writer wins per key |

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
  and is not `__proto__`; one key has one `expand` across the whole schema
  (implementations configure the engine per document, not per field). A
  schema that breaks any of these is refused.
- **M4a** A `ref`, `list`, or `tree` target that exists MUST have the type
  named by `of`; a missing target is allowed (a dangling reference is a
  validation state).
- **M5** `schemaVersion` MUST increase when the schema changes. Replicas
  preserve fields they do not know. A document records the `kdm` version and,
  in `meta.schemaVersion`, the schema version it was **created** with; later
  transactions under newer schemas do not change it, except a migration that
  raises it (M20). A replica MUST refuse to load a document of another `kdm`
  version or one whose minimum schema version (M20) is newer than its
  schema; M20 also checks imported changes. Reads MUST
  tolerate objects of undeclared types (read as their `$type` only); objects
  written under an older schema read the container fields a newer schema
  added as empty. A container field cannot be added to existing objects:
  replicas that each created it concurrently would keep only one of the
  containers and drop the other side's edits. Evolve a schema with a new type,
  or a `ref` to a new object, instead.
- **M5a** Author schema version: every commit records, after its origin,
  the schema version of the replica that made it: the commit message is
  `[kind, principal, label, schemaVersion]` (`Origin::encode_commit` and
  `Origin::decode_commit`, `encodeCommit` and `decodeCommit` in
  TypeScript); messages written before this rule have three elements and
  name none. `author_schema_version()` (`authorSchemaVersion()`) answers
  the newest one among a replica's changes. A replica holding changes
  written under a newer schema than its own keeps working: it preserves what
  it does not know (M5), and objects of types its schema lacks read as their
  `$type` only and refuse writes (`unknown-type`), so edits are blocked only
  for them. A host tells the person that a newer kit edited the document and
  offers the update, in a notice that does not block editing; an embedded
  kit's editor reports it to its host (Kit UI protocol `document/schema`). When a newer kit's migration raised the minimum schema
  version (M20), the import is refused instead: the host keeps the document
  read-only, as it last read it, until the kit is updated. Nothing is lost:
  the room keeps every change.
- **M6** Check a schema with `cargo run -p kition-kdm --example check-schema -- model/schema.json`.

## Identity

- **M7** A document has a `docId` that never changes when its file is renamed
  or moved. Implementations generate a UUID v7 and accept any UUID when
  loading.
- **M8** Objects have KDM ids (UUID strings), unique across replicas without
  coordination. Implementations generate UUID v7 ids and accept any UUID when
  loading. Engines MAY keep efficient local ids and file-format
  ids, mapped to KDM ids when loading, and MUST NOT allocate new persistent
  ids from a document-local counter. A host MAY create an object under an id
  it chose (`[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`, unique in the document);
  generated ids are UUID v7. An engine's own id that its tools show is a
  field of the object, never its KDM id, and its schema names that field as
  the type's tool id ([`KitObjectModel 1.0`](object-model.md) OM9).
- **M9** Every writable replica session has its own actor id. Two sessions
  MUST NOT share one, including two windows on one device.

## Transactions, origins, undo

- **M10** A transaction is all-or-nothing on every replica: if any operation
  fails, the transaction MUST produce no operations at all, so the replica's
  version and exports are unchanged. Compensating operations (reverting what
  was applied) are not acceptable, because they reach other replicas and
  overwrite their concurrent edits. Implementations stage a transaction's
  operations, validate them against the document plus the transaction's
  pending effects, and apply them only when the transaction succeeds. Reads
  inside a transaction see its pending effects. Implementations MAY keep a
  last-resort revert path for an engine refusal that validation cannot
  foresee; validated input MUST never reach it, and reaching it is a bug in
  the implementation.
- **M10a** A tree node created in a transaction is identified by a handle
  that resolves when the transaction commits; a handle from a failed
  transaction is not found.
- **M10b** A tree names each object with one node. Undo can break that: a
  redo of a node's creation makes a new node when the old one is deleted
  locally, while another replica's concurrent move may keep the old one
  alive, so a merge can leave two nodes naming one object. A kit's repair
  (engine contract E14) restores it for every tree field with
  `tree_dedupe(id, field)` (`treeDedupe` in TypeScript): for each object
  several of the document's nodes name, the node kept is the least by engine
  id (peer, then counter) among those with no ancestor naming the same
  object; each other node, in pre-order, has its children moved in order to
  the end of the kept node's children and is then deleted. The rule reads
  the state alone, so replicas repairing one state concurrently make the
  same moves and deletes. Trees have no other node delete: deleting an
  object leaves its node ([`KitObjectModel`](object-model.md) OM2a).
- **M11** Every transaction carries an origin `{ kind, principal, label }`,
  `kind` one of `person`, `agent`, `extension`, `import`, `system`. Servers
  and hosts MUST NOT use it for authorization. The origin is recorded with
  each commit; reading history back is not yet specified.
- **M12** Undo reverts the replica's own last transaction as an inverse
  operation on the current state; changes from other replicas, including
  later changes to the same object, MUST survive. Undo and redo report the
  objects they change like any other change. Undo groups make several
  transactions one undo step. Transactions with origin `system` (repairs,
  migrations) or `import` (changes merged from a file edited elsewhere) are
  not undo steps: undo skips them like changes from other
  replicas, and they survive the undo of earlier transactions.
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
  transactions as M12 treats other replicas' changes: they survive, including
  later writes to the same register, and an undo of an agent's step keeps
  the person's later typing. Undo groups (M12) span both scopes, so the
  steps of one agent run made inside a group undo as one agent step.
- **M12b** *(1.1) Undo groups across other replicas' changes.* A person's
  undo group stays one undo step when other replicas' changes arrive while
  it is open, also when they touch what the group changed: one Undo takes
  back all of the group's transactions and keeps those changes, and one Redo
  puts the group back. Two groups stay two steps, and each scope's steps stay
  in that scope (M12a). `@kition/kdm` and `kition-kdm` chain the steps an
  import split by the group's run ([undo across remote edits](../undo-across-remote-edits.md)).

  `undo()`, `redo()`, `can_undo()`, and `can_redo()` (`undo()`, `redo()`,
  `canUndo()`, `canRedo()` in TypeScript) work in the `person` scope;
  `undo_in(scope)`, `redo_in(scope)`, `can_undo_in(scope)`, and
  `can_redo_in(scope)` (`undoIn`, `redoIn`, `canUndoIn`, `canRedoIn`) name
  the scope. An engine's `edit.undo` and `edit.redo` work in the scope of the
  origin they run as (a step of `ai/run` runs as `agent`), or in the scope
  their optional `scope` parameter names (`"person"` or `"agent"`), so a
  person's editor can offer "Undo the agent's last change" without the
  agent's Undo ever taking back the person's work. Hosts and kits SHOULD
  offer the person that action wherever they show agent edits (KitAgent A9).

  Several people never share a replica session (M9), so the `person` scope is
  per person; their changes reach each other as other replicas' changes.
- **M13** An editor bound to a KDM field MUST apply every change to that
  field except the ones it published itself: remote changes, undo, and an
  agent on the same replica all reach the editor.

## Exchange

- **M14** A replica exports the changes another replica lacks
  (`export_changes(since)`), imports changes in any order and any number of
  times (`import_changes`), and reports which objects each import changed.
  A shallow replica (M16a) refuses only changes that depend on history
  before its root.
- **M15** Every replica that has the same changes **and the same schema**
  has the same canonical state: the document as JSON with keys sorted
  (`state_json`), identical in the Rust and TypeScript implementations. The
  canonical state follows the reader's schema: undeclared fields are omitted,
  and objects of undeclared types show only `$type`.
- **M16** Snapshots (`snapshot`) are compacted full states for fast opening
  and new replicas.
- **M16a** Shallow replicas: a device MAY hold a large document as a
  **shallow replica**, its current state with only the history after a
  root version. `shallow_snapshot(at)` (`shallowSnapshot` in TypeScript)
  exports the current state with the history after `at` (the engine moves
  the root back past changes made concurrently with `at`; an empty `at`
  keeps the whole history), and `load` opens it as a replica for which
  `is_shallow()` (`isShallow()`) is true and `shallow_root()`
  (`shallowRoot()`) is its root; a snapshot of a shallow replica is
  shallow with the same root. A shallow replica edits, exports, imports,
  merges drafts, and converges like a full one (M14, M15), and its
  canonical state is the same as a full replica's with the same changes.
  It has no history before its root: undo covers only its own transactions
  since it was loaded (as for any loaded replica, M12), and it forks a
  draft (A12) only at its current version. Earlier versions, blame, and
  restores are read from whoever keeps the whole history (the sync server,
  [sync-protocol.md](../reference/sync-protocol.md) sections 3 and 7). Changes that
  depend on history before the root (made by a replica that had not seen
  the root) MUST be refused (`KdmError::HistoryMissing`, reason
  `history-missing`) without changing anything; the host then rebases the
  replica (`rebase(snapshot)`) on a newer snapshot that holds them, which
  keeps the replica's own changes on top and clears its undo history. A
  refused import that raises the minimum schema version (M20) is taken back
  in Rust; the TypeScript engine cannot rebuild a shallow document at an
  earlier version, so there the replica refuses every later change and
  export with the same error, and the host reopens the document once
  updated.
- **M17** Every exported byte string (changes and snapshots) is an envelope:
  the 4 bytes `K D M 0x01`, the 16-byte document UUID, then the engine's
  bytes. A replica MUST refuse bytes without the envelope and changes of
  another document, so two documents can never be merged by mistake.
- **M18** Text positions are local coordinates of each implementation:
  Unicode scalar values in Rust, UTF-16 code units in TypeScript (the units
  of CodeMirror and the DOM). A position inside a character is out of range.
  Positions are never replicated; only the resulting text operations are.
- **M19** Marks: a transaction sets a declared mark over a range of a text
  field (`text_mark(id, field, start, end, key, value)`, `textMark` in
  TypeScript) or removes it (`text_unmark(id, field, start, end, key)`),
  positions per M18 and checked against the text including the
  transaction's earlier edits; an empty range changes nothing. Each mark key
  is its own last-writer-wins value per character: concurrent marks of
  different keys over overlapping ranges all apply, concurrent values of one
  key resolve to one value per character, and concurrent insertions inside
  or next to a marked range are all kept, taking the mark as its `expand`
  says. A key the field does not declare is refused, and so is a `null`
  value (remove a mark with `text_unmark`); values are plain JSON (M4b) and
  read in canonical form. A text field that declares marks reads in the
  canonical state (M15) as its runs, `[{ "insert": "...", "attributes":
  { key: value } }]`: in text order, no run empty, adjacent runs with
  different marks, `attributes` omitted for an unmarked run and holding
  only the reader's declared keys; an empty text is `[]`. A text field
  without marks reads as a string, as before. `text_delta(id, field)`
  (`textDelta`) answers the same runs; `text` still answers the plain
  string. Bridges write a field's new form as a difference
  (`kition_kit::session::write_text`, `write_marks`, `write_rich_text`), not
  a replacement, so concurrent typing in one paragraph keeps both sides.
- **M20** Minimum schema version: a document's minimum schema version is the
  version it was created with, raised by migrations that rewrite it into a
  form older readers would misread. A `system` transaction raises it
  (`Tx::raise_schema_version(version)`, `raiseSchemaVersion` in TypeScript),
  in the transaction that rewrites the document, to at most the
  transaction's own schema version; a raise in any other transaction is
  refused, so a raise is never an undo step. The minimum is monotonic: a
  raise to the current or a lower version changes nothing, and concurrent
  raises keep the largest. It is replicated data: each raise records its
  version as a key (decimal, value `true`) of the root map `schemaRaises`
  and rewrites `meta.schemaVersion`, which builds before M20 check; the
  minimum is the largest of `meta.schemaVersion` and those keys
  (`min_schema_version()`, `minSchemaVersion()`). The canonical state (M15)
  shows the minimum as `meta.schemaVersion` and does not show
  `schemaRaises`. A replica whose schema is older than the minimum MUST
  refuse to load the document and to import changes that raise it there
  (`KdmError::NewerSchema`, reason `newer-schema`): a refused import
  changes nothing (state, version, exports, pending changes), though it
  may clear the replica's undo history; the host keeps the document
  read-only as it last read it and asks for an update (M5a).

- **M21** Coordinated objects: some edits do not merge meaningfully when two
  people make them at once (two people repainting one layer's pixels, two full
  rewrites of a PDF, two constraint solves). A kit takes a **lease** on such an
  object's scope before editing it (a KDM object id, a name of its own such as
  `layer:<objectId>`, or `*` for the whole document), through its host (Kit UI
  protocol section 7b), which takes it from the sync server (sync protocol
  section 8); it does not start the edit while another session holds the
  scope, and releases the lease when the edit ends. An agent's edits on the
  live document (`ai/run` steps) take the leases the person's would. Leases are advisory: they
  never change what merges, and an edit made with no server to ask (offline)
  is allowed. A kit lists the scopes it leases in `kit.json`
  `collaboration.leases` (patterns such as `layer:{objectId}`, or `*`), so a
  host can tell which of its edits coordinate.
- **M22** Conflict objects: a repair pass (`validate`) that cannot resolve a
  merge by itself (an edit made against state another peer replaced, an edit
  made offline while another session held its lease) records a **conflict
  object** that keeps what could not be kept. Its type is `Conflict`, declared
  exactly as `kition_kdm::conflict::CONFLICT_TYPE_JSON` (`kind`, `summary`,
  `objects`, `kept`, `by`); its id is `conflict_id(kind, key)`, a function of
  what the conflict is about, so every replica's repair records the same
  object and replicas that record it concurrently keep one. The repair that
  records a conflict also repairs its cause, so it does not record it again.
  A later transaction resolves a conflict by deleting the object. The editor
  reports the unresolved conflicts to its host (Kit UI protocol section 7c),
  which shows a non-blocking notice. `kition_kdm::conflict` (`record_conflict`,
  `conflicts`, `resolve_conflict`) implements it.
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
  `Comment` objects is then a comment, which is all a principal with the sync
  protocol's `commenter` role may push ([sync-protocol.md](../reference/sync-protocol.md)
  1.6). A kit whose file format keeps comments maps them onto these objects
  on import and back on export. Comment threads are collaboration objects: an
  editor with no co-editing session shows the threads others wrote as
  read-only history (a person may still add their own). `kition_kdm::comment`
  (`add_thread`, `reply`, `set_resolved`, `delete_comment`, `threads`) and
  `@kition/kdm` (`addThread`, `reply`, `setResolved`, `deleteComment`,
  `commentThreads`) implement it; `@kition/kit-editor`'s `CommentsPanel` and
  `useCommentAnchors` show threads in an editor. A kit whose engine writes
  comments through commands lists them in `kit.json` as
  `collaboration.comments.commands` (K13), such as `comment.add`,
  `comment.reply`, `comment.resolve`, and `comment.delete`; its editor passes
  the same list to `@kition/kit-editor` (`KitModuleManifest.commentCommands`). A
  commenter's document opens read-only with `document.comments.canComment`
  (Kit UI protocol section 3): the editor refuses every edit as for a viewer
  (UI-K7) except these commands, and each of them runs under a backstop that
  reads the change it made as the sync server reads a commenter's push: when
  it touches anything but `CommentThread` and `Comment` objects, it is undone
  and refused (`read-only`). Undo and Redo take back and bring back the
  commenter's own comment changes: only as many steps as their comment
  commands made in the session, each under the same backstop (an Undo that
  would reach anything else is refused and taken back). Save and the file
  commands stay refused; a commenter's comments reach others through the
  replica, and the file is not theirs to save. An editor hides from a
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
