# The object model: `@kition/script`

`@kition/script` lets a script read and edit a kit's document as typed objects
(`KitObjectModel 1.0`, [`KitObjectModel 1.0`](../sets/object-model.md)), in a page
or in Node, with the same code. It works with every kit on engine contract 2
and needs nothing from the kit beyond its change exchange and its commands.

## Open a document

```ts
import { openDocument } from '@kition/script'
import '@kition/script/kits/note' // registers Note's schema; brings its typings
import type { Note, NoteCommands } from '@kition/script/kits/note'

// In a page: an @kition/embed editor mounted with `model: true`.
const doc = await openDocument<Note, NoteCommands>(editor)

// In Node: the kit's engine from its package (`<kit>-ui/`), no page.
import { openKitPackage } from '@kition/script/node'
const notePackage = await openKitPackage('<kits>/note-ui')
const file = notePackage.create('Review.md') // or notePackage.open(name, bytes)
const doc2 = await file.model<Note, NoteCommands>()

// In Node, the kit's native executable over the Kit Process Protocol (see "Headless kits").
import { openHeadless } from '@kition/script/node'
const native = await openHeadless('<kition-note>/target/debug/kition-note', 'Review.md')
const doc3 = await native.model<Note, NoteCommands>()

// A shared document in a sync server's room (see "Sync rooms"), in Node or a page.
import { openRoom } from '@kition/script/node' // or '@kition/script'
const doc4 = await openRoom<Note, NoteCommands>({ server: 'https://sync.kition.ai', token, shareLink })
```

`openDocument` also takes a `KitConnection` (`@kition/kit-host`) of a kit with
the `replica` capability, a kit engine with `options.kit`, or any `ModelPort`.
Options: `schema` (when the kit is not registered), `origin` (what every
batch records, `extension`/`script` by default).

## Proxies and `sync()`

```ts
const result = await doc.run(async (context) => {
  context.commands.run('text.insert', { at: 0, text: '# Review\n\n' })
  context.root.load(['body'])
  await context.sync()                         // one model/batch
  context.root.body.insert(0, 'Quarterly ')
  await context.sync()
  return context.root.id
})                                             // what is still queued is sent when the script returns
```

- Writes (property assignments, `list.add`, `insert`, `move`, `remove`,
  `text.*`, `map.*`, `tree.add`, `tree.insert`, `tree.move`,
  `object.delete()`) and commands are queued; reads are
  queued with `load(fields?)`. `sync()` sends them as one batch; each run of
  model operations between commands is one transaction.
- Reading a field that was not loaded throws `PropertyNotLoadedError`; a new
  object's `id` and a command's `value` throw `NotSyncedError` until the next
  `sync()`.
- A tree field (`ModelTree`, such as a drawing's layers) names objects by
  themselves: `layers.add(fields, { parent: group })` adds a new object as the
  last child of `group` (a root without `parent`), `insert(item, { parent })`
  adds an existing one, `move(item, parent)` moves it with its subtree, and
  after `load()` + `sync()`, `nodes` lists `{ object, parent }` in pre-order
  and `children(parent?)` the children. Deleting an object with children in a
  tree is refused: move or delete them first.
- Content a kit keeps verbatim but does not model (opaque objects,
  preserved file parts or unmodelled XML) is
  read-only through the object model ([`KitObjectModel 1.0`](../sets/object-model.md) OM8): the schema marks a
  field `readOnly`, a type `readOnly`, or a type `readOnlyWhen` an enum field
  holds some values. Loads read it; a write to it fails the batch with
  `read-only` at that operation, and the batch changes nothing. Commands
  still go through the kit. `describe()` answers the marks, and the
  generated typings make a read-only field a `readonly` property that
  `<Type>Fields` leaves out.
- An object's `id` is the one the kit's own tools give it where its schema
  declares a tool id for the type ([`KitObjectModel 1.0`](../sets/object-model.md)
  OM9: `item:10`, `story:11/table:2`), the KDM object id otherwise;
  `context.object(id, type)`, targets, and ref fields take either. A new
  object's `id` after `sync()` is its tool id once the kit has given it one.
  Selections (`selection` events) carry KDM object ids.
- A ref field takes an object proxy or an id; a text field takes a string
  (replacing the text) or its `ModelText` methods. Positions count Unicode
  scalar values.
- `doc.batch(request)` sends a batch in its wire form; `doc.describe()`
  answers the schema, the root's id, and the commands; `doc.commands.list()`,
  `enabled(id)`, and `run(id, params)` act right away.
- `doc.on('changed', ({ origin, version }) => …)`: `local` after this
  handle's own edits, `kit` when the document moved otherwise (a person, a
  command, a collaborator; in a page, from `replica/changed`).
- `doc.on('saved' | 'conflict' | 'presence' | 'selection', …)` hears what the
  document's source reports; `doc.supports(event)` tells which it does.
  `saved` (`{ version, uri? }`): an `@kition/embed` editor wrote the storage
  (its new version), a headless kit saved (`document.didSave`, the file's
  `uri`), or a Node package document's `save()` made the bytes. `conflict`
  (`{ message }`): an embed editor's save was refused because the file
  changed elsewhere (`EmbedConflictError`); nothing was overwritten.
  `presence` (`{ peers }`): the people in an embed editor's collaboration
  room. `selection` (`{ ids }`, KDM object ids): what the person selected in
  a kit editor, from the kit's `selection/changed` (Kit UI protocol section
  7h, the objects of the selection) or `presence/set` (section 7e) when its
  connection hears them (`KitConnection.onPresence`), or from a
  custom `ModelPort` with `events` and `on`.

## How it works

The library keeps its own replica of the document (the kit's schema, its own
actor), catches it up with the kit's changes before each read and write, runs
the batch on it (`@kition/kdm`'s `runBatch`), and hands the new changes to the
kit, which takes them as a collaborator's: its merge repair runs, and the
editor shows them. Commands run in the kit (`ai/run` in a page, `executeAs`
on an engine). Script edits made this way are not in the person's undo
history. A kit that answers the `model` capability itself
([ui-protocol.md](ui-protocol.md) section 7a) gets each batch instead (with
the kit's schema, for an engine that does not describe its own), and the batch
is a step of the person's undo history: every kit editor built on
`@kition/kit-editor` does when its engine exchanges changes. `openDocument`
prefers it (`ModelPort.model`, given by `portFromConnection` and by an
`@kition/embed` editor whose kit lists `model` when `modelPort()` is called).

The Rust side is the same: `kition_kdm::batch` is the interpreter,
`kition_kit::session::model` serves it directly on a `KitSession`
(`export_kit_session!` adds `modelDescribe` and `modelBatch`) or through an
`Exchange` over any `ReplicaPort`, and `kition-headless` answers the Kit Process
Protocol's `model.describe` and `model.batch` for kits built with
`run_manifest_model` (see [Headless kits](#headless-kits)).

## Headless kits

A kit's native executable (for example `kition-note`) serves its documents on
the Kit Process Protocol's `headless` surface, for agents and scripts with no page. Kits
serve the object model there too, so the same script runs against the native
engine:

```ts
import { openHeadless } from '@kition/script/node'
import '@kition/script/kits/note'

const file = await openHeadless('<kition-note>/target/debug/kition-note', 'Review.md', {
  create: { format: 'markdown' }, // when the file does not exist yet
})
const doc = await file.model<Note, NoteCommands>()
await doc.commands.run('text.insert', { at: 0, text: '# Review\n\n' })
await file.save()                    // document.save
await file.shutdown()                // kit.shutdown; the process exits
```

- `openHeadless(binary, file, options?)` launches the executable as the Kit Process
  Protocol host (`--kition-kit`, a fresh `KITION_KIT_TOKEN`, a private socket
  or named pipe as `KITION_KIT_ENDPOINT`, `KITION_KIT_SURFACE=headless`),
  waits for its ready line, sends `kit.initialize` with the file's folder as
  the one workspace root (`options.root` to choose another), and opens the
  file (`document.open`, with `create` when it is missing).
- `HeadlessKit.launch(binary, { root })` keeps the kit for several documents
  (`kit.open(path, { readOnly?, create? })`); `HeadlessKit.connect` takes an
  existing `KitProtocolConnection`.
- A `HeadlessDocument` has `model(options?)`, `commands()` (`commands.list`),
  `execute(command, params)` (`commands.execute`, outside the object model),
  `save()`, `saveAs(path, format?)`, `close(discardChanges?)`, and `state`
  (the last `document.didChangeState`).
- Each `sync()` is one `model.batch` request; the kit runs it, so no replica
  is kept in Node. The schema for proxies is the registered kit's
  (`@kition/script/kits/*`) or, when none is, the one `model.describe` answers.
  Object-model failures arrive as `BatchError` (from the error's
  `data.model`), other protocol errors as `KitProtocolError` with the Kit Process
  Protocol `reason`. `changed` fires `local` after a batch; one host owns the
  kit, so nothing else moves the document.
- A read-only document (`readOnly: true`) refuses batches that write
  (`read-only`) and answers reads.
- A batch's `command` operations pass the check `commands.execute` applies,
  for whom the batch runs (its `origin`; an `agent` batch gets the agent's
  limits): the command exists, names no file the kit did not declare safe,
  is not kept from the agent by the manifest (`agent.include`,
  `agent.exclude`), and has the parameters its schema states. Every command
  operation is checked before anything runs; a refused one fails the whole
  batch with the error `commands.execute` answers for it
  (`command_not_found`, `command_disabled`, `invalid_params`) and
  `data.model` `{ code, index, message }` with the A18 code
  (`unknown-command`, `not-allowed`, `invalid-params`). What a kit's own
  dispatcher runs inside an operation is checked the same way (engine
  contract E21). On the agent's connection a batch's `origin.kind` is
  `agent`; any other is refused `role_forbidden`.

### Replica methods

A server runs the same headless executables on a sync room's state, which has
no file (Kition Server's headless kit pool: previews, exports, server
validation, and server-side agents, [sync-protocol.md](sync-protocol.md)
section 8a). A kit whose engine can open a replica (`ReplicaPort::model_open_replica`,
its `open_with_replica(name, &[], snapshot, blobs)`) lists these features in
`kit.initialize` beside `model.describe` and `model.batch`; `kition-headless`
serves them for kits built with `run_manifest_model`. Bytes travel as base64
strings.

| Method | Params | Result |
| --- | --- | --- |
| `model.open` | `{ name, snapshot, blobs?, readOnly? }` | `{ documentId, title, format, readOnly }` |
| `model.import` | `{ documentId, changes, blobs? }` | `{}` |
| `model.export` | `{ documentId, since? }` | `{ changes, blobs? }` |
| `model.save` | `{ documentId, format? }` | `{ data, format, name }` |

- `model.open` opens `snapshot` (a KDM snapshot or full change export) as a
  new replica under a fresh actor, named `name` (a plain file name in one of
  the kit's formats). `blobs` are the media it references, encoded as
  `(64-char hex SHA-256, u64 LE length, bytes) * N`. Nothing is written; the
  document is never saved to a file. A kit that cannot open a replica
  answers `unsupported_format`.
- `model.import` takes changes as from a collaborator; the kit's merge repair
  (`validate`) runs. When the kit refuses them (the changes do not apply, or
  `validate` cannot repair the result) it answers `invalid_params` with
  `data.refused: true` and closes the document, which may hold part of what
  it refused. `blobs` (encoded as for `model.open`) are the media the
  changes reference, added before the changes, as a page's `addBlobs` before
  `importChanges` (engine contract 2 ([engine contract](../kits/engine.md))); changes whose blobs come later
  still import. Damaged blobs refuse the call (`invalid_params`, without
  `refused`) before anything is imported, and the document stays open.
- `model.export` answers the document's changes since the encoded KDM
  version `since` (every change when omitted), in the KDM envelope; every
  change always opens with `model.open` (KitModel M14: a shallow replica,
  such as a file `document.fork` made, answers its snapshot). A kit
  whose changes reference blobs (such as painted pixels) also answers
  `blobs`, the ones a replica at `since` needs for them (every blob the
  document references when `since` is omitted), encoded as for `model.open`;
  a caller stores them beside the changes. A kit without blobs omits it.
- A kit whose documents reference blobs needs them on every open and import:
  a server sends `blobs` with `model.open` and with each `model.import`
  (the blobs pushed with the change); without them the kit cannot read,
  render, or save what the changes reference.
- `model.save` answers the document as file bytes in `format` (one the kit
  saves; the document's own by default) without writing a file.

How kits serve it: a contract 2 kit's engine implements
`kition_kit::session::model::ReplicaPort` (its `exportChanges`,
`importChanges`, `executeAs`, schema, and commands; about fifteen lines) and
its executable's `main` calls `kition_headless::run_manifest_model` instead of
`run_manifest`. The headless server keeps an `Exchange` (a scratch replica)
per open document, so batches arrive in the engine as another actor's changes
and its merge repair runs, as in a page. A kit with its own backend
answers `KitBackend::model` itself with the same `Exchange`.

After saving, reopen the file in a new kit process to verify the persisted edit.

## Sync rooms

A document shared in a sync server's room (`kition-sync/1`,
[sync-protocol.md](sync-protocol.md)) opens with no kit and no page:
`openRoom` joins the room and keeps a KDM replica of it in the script.

```ts
import { createRoom, openRoom } from '@kition/script/node' // the same in '@kition/script', in a page
import '@kition/script/kits/note'

const doc = await openRoom<Note, NoteCommands>({
  server: 'http://127.0.0.1:18300', // ws(s)://…/v1/sync, or a server address whose root means /v1/sync
  token: 'dev-alice',               // or tokenProvider: () => fetchToken(), asked on every connection
  docId, kit: 'kit.note',           // or shareLink (room/open; it names the kit)
})
doc.on('changed', (event) => { /* event.origin is 'kit' for another member's change */ })
await doc.run(async (context) => { /* proxies and sync(), as anywhere */ })
doc.close()                        // room/leave, and the connection closes
```

- `openRoom({ server, token | tokenProvider, docId | shareLink, kit?, schema?,
  origin?, createTransport?, commandTimeout?, onError? })` connects a
  `SyncClient` (`@kition/sync`) over the global `WebSocket` (Node 22 or later,
  or a page; `createTransport` for another), resolves a `shareLink` with
  `room/open`, joins the room (`room/join`, every page), loads its snapshot
  (`snapshot/get`, or the join's own when it answers `snapshot: true`), and
  imports the changes after it. It answers once the replica holds the room.
  `kit` is required with `docId` and checked against the room's with
  `shareLink`; the schema is the registered kit's (`@kition/script/kits/*`;
  `@kition/script/node` registers every generated kit).
- Each run of model operations in a batch is one change: it is made on a
  draft of the replica (`Replica.fork`), pushed (`changes/push`), and kept
  only once the room took it, so a change the server refuses leaves nothing
  behind (`read-only` for `forbidden`, `invalid-value` otherwise). A batch
  therefore settles when the room has its changes; offline, it waits for the
  connection to come back (the client queues the push). Changes carry the
  handle's `origin`, `extension`/`script` by default.
- Other members' changes (`changes/pull`, and a reconnect's catch-up) are
  imported as they arrive and fire `changed` with `origin: 'kit'`; the
  handle's own batches fire `local`. `presence` is reported too (`peers` on
  each `presence/update`), and `doc.peers` holds the last list.
- Roles follow the room (`doc.role`, `doc.onRole`, `room/access`): a
  `viewer`'s batches only read (a batch that writes fails `read-only`); a
  `commenter`'s writes may touch only `CommentThread` and `Comment` objects
  (rule M23; checked here with `@kition/kdm`'s `ChangeAudit` before the push,
  `read-only` otherwise; the server also checks each `Comment`'s `author` is
  the commenter, `doc.principal.id`). A member the owner removes keeps
  reading what the handle holds and writes nothing.
- Commands need the kit's engine, which the script does not have. On a
  server that runs kits headless (it lists `headless` in `sync/hello`,
  protocol 1.7; `doc.runsCommands`), each `command` operation is sent as
  `agent/run` (`{ ops: [the command] }`), for an owner or an editor: the
  server's kit runs it with the origin the server sets (`agent` for the
  caller), and the batch goes on once the change it made has arrived
  (`commandTimeout`, 30 seconds by default), so the operations after it read
  its result. Any other server, and a viewer's or commenter's handle, refuses
  commands: the batch fails `command-failed` at the command, with a message
  that names the reason. `commands.list()` is empty: the kit's catalogue does
  not travel over the sync protocol.
- `createRoom({ server, token, kit, name, document })` shares a document as a
  new room (`room/create`) and answers `{ docId, shareLink }`; `document` is
  a KDM snapshot or full change export (an engine's `exportChanges` from
  nothing).
- `doc.sync` is the `SyncClient` (share links, members, history, previews,
  leases), `doc.capabilities` the server's `sync/hello` list (for
  `supports`), `doc.snapshot()` the document as the handle holds it.

`packages/script/test/room.test.ts`
runs against `@kition/sync`'s `FakeServer`, and `room.server.test.ts` against
a real server when `KITION_SYNC_SERVER` is set.

## Typings

`packages/script/scripts/generate-kit.mjs` writes a kit's typings and its
descriptor from its schema (the file its `kit.json` names in `model.schema`)
and its command catalogue (captured from the kit's package in Node):

```sh
node packages/script/scripts/generate-kit.mjs --schema <kition-note>/crates/kdm/kdm-model/model/schema.json \
  --package <kits>/note-ui --name Note --out packages/script/kits/note.ts
```

It gives an interface per type (`Note`, `CommentThread`, `Comment`, …) with
typed lists, texts, maps, and refs; `<Type>Fields` for `list.add`; and
`<Name>Commands`, every command's parameters. A read-only field (OM8) is a
`readonly` property left out of `<Type>Fields`, and a read-only type says so in
its comment. The output is checked in. A
field named like a proxy's own member (`id`, `type`, `load`, …) is left out of
its interface (read it with `toJSON()`); `<Type>Fields` still takes it.

Every published kit with an object model has one, generated from the
package pinned in Kition's `kits/kits.lock.json`: its command catalogue, and
its `model/schema.json`, or for a package that ships none, the schema in the
kit's repository at the commit the package was built from (`commit` in the
lock). `packages/script/scripts/sync-kits.mjs` regenerates kits in
`published-kits.json` from the
pinned packages (`--kits <dir>`, default Kition's `public/kits`; each
package's `kit-ui.json` must name the pinned version and commit) and
`--check` reports a module that differs. `openKitPackage` opens a package's
documents with the schema it ships, before the bundled one, and the tests
check the bundled schemas equal the shipped ones:

| Kit | Module | Name | Root |
| --- | --- | --- | --- |
| `kit.note` | `@kition/script/kits/note` | `Note` | `Note` |

`@kition/script/kits` registers them all (their typings stay per kit, since type
names overlap). `@kition/script/node` and `@kition/extensions` import it, so a
Node script or an extension opens a document of any of these kits with no
`registerKit`. Regenerate a kit's module when its schema or commands change
(`--name` as in the table).

## Capability sets

A script tests what its environment serves with a capability set (Kit
[capability sets](../index.md#3-capability-sets)), never with a product or version check:

```ts
import { advertiseCapabilitySets, supports } from '@kition/script'

if (supports('KitCollab 1.0')) {
  // the document is co-edited: expect remote changes between loads
}
```

`supports(required, sets?)` answers whether `sets` (by default what the
environment advertised) has the same set at the same major version with at
least the required minor version. `@kition/script` serves `KitModel 1.0` and
`KitObjectModel 1.0` by itself; a host adds what it serves with
`advertiseCapabilitySets` (its Kit UI `capabilitySets`, or a sync server's
`sync/hello` capabilities).
