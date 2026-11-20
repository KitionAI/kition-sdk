# Open sync protocol

| | |
| --- | --- |
| Protocol | `kition-sync/1` |
| Version | 1 |
| Part of | [Kition kit platform](../index.md) edition 2026.11, L6 Collaboration ([`KitModel 1.0`](../sets/model.md)) |
| Rust types | `kition-sync-protocol` (crates/kition-sync-protocol (Kition SDK: `crates/kition-sync-protocol`)) |
| Client library | `@kition/sync` (packages/sync (Kition SDK: `packages/sync`)) |
| License | Apache-2.0 |

`kition-sync/1` is how a client keeps a document (a KDM replica,
[`KitModel 1.0`](../sets/model.md)) in sync with a server and with the other people editing
it: joining a room, pushing and pulling changes, carrying presence, and
keeping the blobs a document's media references. It carries no server-side
policy (storage, auth beyond a bearer token, billing); a server builds that on
top of these messages, and any client speaking this protocol can talk to it.

## 1. Transport and framing

Messages travel as JSON-RPC 2.0 (`jsonrpc`, `id`, `method`, `params`,
`result`, `error`) over a WebSocket. A message with a binary payload (KDM
change bytes, a snapshot, a blob) carries a `{"$bin": n}` marker in its JSON
in place of the bytes, and declares `"bins": <count>` on the message itself;
that many binary WebSocket frames follow the text frame, in order, and `n`
indexes into them (`0` is the first frame after the message that declared
it). A message with no binary payload omits `bins` and is one frame.

This is exactly what `kition-sync-protocol`'s `framing` module implements
(`Outgoing` to build frames, `Decoder` to read them back), and what
`@kition/sync`'s `src/framing.ts` mirrors for a JavaScript client: the same
marker and frame order on both sides, so a client in either language talks to
a server in either language. A decoder enforces limits on JSON size, binary
frame size, and bins per message, so a hostile or broken peer cannot exhaust
memory; it never panics on a malformed frame.

Errors use JSON-RPC codes: `-32700`..`-32603` the standard ones, `-32000` for
every error this protocol itself defines, with the stable reason in
`error.data.code` (never `error.code`/`error.message`, which are for logs and
people):

| `error.data.code` | Meaning |
| --- | --- |
| `unauthorized` | The token did not identify a principal. |
| `forbidden` | The principal's role does not allow the request (a viewer's `changes/push`). |
| `not-found` | No such room, blob, or share link. |
| `conflict` | The request collides with existing state (`room/create` for a `docId` that exists). |
| `invalid` | The request's own data is bad (`blob/put` whose `data` does not hash to `hash`). |
| `unavailable` | The connection closed, or otherwise cannot serve the request right now. |
| `rate-limited` | Since 1.5: the connection or its principal sends faster than the server allows; `error.data.retryAfterMs`, when present, is how long to wait. |
| `collab-limit` | The room is at the server's limit of people co-editing at once (`room/join`; Kition Server's free limit); `error.data.limit` is that number. The person can still open, edit, and save the document alone, so a client shows "co-editing is limited to N people on this server" and keeps the editor working without the room. |

A server limits how fast a connection and a principal send (messages and
bytes per second, rooms joined at once, connections at once). It SHOULD
slow a connection down first (stop reading from it for a moment), answer
`rate-limited` only past what a short pause absorbs, and close a connection
that keeps exceeding its limits. A client that gets `rate-limited` waits and
retries; it never drops the request's data.

## 2. Connection

1. The client opens a WebSocket and sends `sync/hello` first; the server MUST
   NOT send anything else before it answers.
2. The server resolves `token` to a principal (a person, or a service
   account) and answers with its own info and the principal's.
3. From then on, either side sends requests and notifications. A client picks
   its own request ids; `@kition/sync` uses increasing numbers.

### `sync/hello`

| | |
| --- | --- |
| Params | `{ protocol, token, client: { name, version }, capabilities }` |
| Result | `{ server: { name, version }, principal: { id, name }, capabilities }` |

`protocol` is `"kition-sync/1"`. `capabilities` on both sides name optional
extensions. A server lists `leases` when it keeps leases (section 8, since
1.5), and `headless` when it runs kits headless (section 8a, since 1.7); a server may list its own names too (Kition Server lists `sync` for a
principal entitled to co-edit). A server also lists the
capability sets it serves for the principal, such as `"KitModel 1.0"` and
`"KitCollab 1.0"` ([capability sets](../index.md#3-capability-sets), CS2); a
script tests them with `@kition/script`'s `supports`. `@kition/sync`'s
`SyncClient` reads them from each handshake: `capabilities` is the whole list,
`capabilitySets` its `Name major.minor` entries, and `supports(set)` tests one
(a reconnect may change them; read them again when the state turns `online`).
A client lists none today.
A server that does not recognize `token` answers `unauthorized`.

## 3. Rooms

A **room** is one document's live collaboration session, named by its
`docId` (the document's KDM replica id). A room has one **role** per
principal: `owner` (made it, or the server otherwise designates it),
`editor` (may push changes and set presence), `commenter` (since 1.6: may
read, set presence, and push changes that touch only comments, `KitModel 1.0`
M23), or `viewer` (may read and set presence, never push: a viewer
shares where it looks, never an edit). Roles rank
`viewer` < `commenter` < `editor` < `owner`.

### `room/create`

| | |
| --- | --- |
| Params | `{ docId, snapshot, name, kit, private }` |
| Result | `{ shareLink }` |

Makes a room from a KDM `snapshot` (the document's full state so far, with no
changes yet); the caller becomes its `owner`. `name` is the document's
display name and `kit` its kit id (for example `kit.sheet`), shown in a
person's document list (section 3b) and a server's own UI. Fails `conflict`
if `docId` already has a room. `shareLink` is an opaque URL a server mints
for sharing; its shape is a server's own choice.

Since 1.9, `private: true` makes a **private room** (section 3b): it syncs
the document to its owner's own devices, and `shareLink` is `null` — the
room has no link until its owner mints one with `room/link`, which shares it
from then on. A 1.8 server ignores `private` and answers a link.

### `room/open`

| | |
| --- | --- |
| Params | `{ shareLink }` |
| Result | `{ docId, name, kit, role }` |

Resolves a `shareLink` (as `room/create` answered it) to the room it points
to, and the role the caller would join it with, without joining it. A client
uses this to show what a link leads to — a join prompt, a read-only
notice — before committing to `room/join`'s history transfer. `role` is
the role the link grants (`editor` for `room/create`'s link, whatever
`room/link` minted it with) for a principal with no role in the room yet; a
member keeps a higher role it already has. Fails `not-found` for an unknown or
revoked link.

### `room/link`

| | |
| --- | --- |
| Params | `{ docId, role }` |
| Result | `{ shareLink }` |

Since 1.4. Mints another share link to `docId`'s room that grants `role`
(`editor`, `commenter` since 1.6, or `viewer`; never `owner`), for example a view-only link next to
the editing link `room/create` answered. The caller must be a member of the
room, and a link never grants more than the caller's own role: a viewer may
mint only viewer links. Since 1.9, the owner's `room/link` on a private room
makes it shared (`private` turns `false` in `rooms/list`); the room, its
document, and its history stay as they are. Fails `not-found` for an unknown room (or one the
caller is not a member of), `forbidden` for a role the caller may not grant,
and `invalid` for a role that is not `editor`, `commenter`, or `viewer`. A client that
needs a view-only link from a 1.3 server (which answers JSON-RPC
`-32601`, method not found) has none to offer.

### `room/join`

| | |
| --- | --- |
| Params | `{ docId, since, limit, shallow, prefer }` |
| Result | `{ changes, seq, more, presence, role, snapshot, shallow }` |

Joins `docId`'s room (first making the caller a member with the room's
default role for a new member — `editor` — unless overridden), and answers
changes the room has recorded after `since`, up to one page. Catch-up is by
this server sequence, never a KDM version: the server compares plain
integers and so never needs a replica of its own to answer `room/join`.
`since` is the highest `seq` the caller already has every change up to;
`null` (or omitting it) means "everything, from the room's snapshot." A
client that already has some history sends its own last-seen `seq` and gets
only what it is missing. `presence` is every member currently in the room
(section 5). Fails `not-found` for an unknown `docId`; a client with no
snapshot at all gets one from `snapshot/get` first.

A room can have more changes than fit in one message's binary frames (the
framing limit, section 1), so `room/join` pages: the server returns at most
`min(limit, 512)` changes (`limit` omitted: 512). When there are more changes
after the page it returned, `more` is `true` and `seq` is the **last included
change's** `seq` (not the room's latest); the caller repeats `room/join` with
`since` set to this `seq` to fetch the next page. When `more` is `false`,
`changes` reaches the room's latest and `seq` is that latest, so the caller
always knows where it now stands even when `changes` is empty. `presence`
and `role` reflect the state as of the last page; a caller paging through
several pages only needs to keep the ones from its last `room/join`. Joining
marks the connection as a room member (for `changes/pull`) from the first
page on, so no change is missed between pages: a `changes/pull` for a change
already included in an earlier page is a harmless duplicate (KDM import is
idempotent), never a gap.

A server keeps a room's changes one by one for a retention window and
compacts older ones into snapshots (section 7). Since 1.5, a `since` older
than the oldest change it still keeps cannot be answered change by change:
the server then answers `snapshot: true`, and `changes[0]` is a snapshot of
the document (a full KDM export, imported like any change set: KDM import
merges it) as of some `seq` after `since`, followed by the changes after that
snapshot. `seq` and `more` keep their meaning. A 1.4 client imports the
snapshot as a change without knowing, which is just as correct.

Since 1.8, a client with no replica of the document yet (`since: null`) may
start from a **shallow snapshot** instead (section 3, "Shallow replicas"):
`shallow: true` asks for one, `prefer: "shallow"` lets the server give one
when the document is past its size threshold (`prefer: "full"`, or omitting
both, asks for the behavior above). The server then answers `snapshot: true,
shallow: true`, `changes` holding only the shallow snapshot of the room's
latest state, `seq` the room's latest, and `more: false`. The client loads
`changes[0]` as a new replica; it never imports a shallow snapshot into a
replica it has. A server ignores `shallow` and `prefer` with any other
`since`, and a 1.7 server ignores them altogether (the client sees no
`shallow` in the result).

A client reconnecting after a disconnect sends `room/join` again for every
room it had joined, with the highest `seq` it had itself seen for that room
(from an earlier `room/join`, a `changes/pull`, or its own `changes/push`
being acked — whichever is highest), so it catches up on whatever it missed
while offline instead of asking for everything again, paging as above if it
missed enough to need more than one page. KDM import is idempotent, so a
client that happens to receive its own change back this way is harmless;
this protocol does not filter it out.

### `room/leave` (notification)

| | |
| --- | --- |
| Params | `{ docId }` |

Leaves the room; the server drops the caller from its member list and
presence.

### `snapshot/get`

| | |
| --- | --- |
| Params | `{ docId, shallow, prefer }` |
| Result | `{ snapshot, seq, shallow }` |

The document's full KDM state as of `seq`, for a client with no history of
the room at all (a fresh participant, one that discarded its local replica).
`seq` is the change sequence the snapshot already reflects, so a client that
then also fetches changes after it (if any) does not double-apply them.

Since 1.8, `shallow: true` asks for a shallow snapshot (section 3, "Shallow
replicas") of the room's latest state, and `prefer: "shallow"` lets the
server choose one for a document past its size threshold; the result then
says `shallow: true`, and `seq` is the room's latest. Otherwise (`prefer:
"full"`, neither, or a 1.7 server) the answer is the full snapshot as above,
without `shallow`.

### Shallow replicas

Since 1.8. A device may hold a large document as a **shallow replica**
([`KitModel 1.0`](../sets/model.md) M16a): its current state with only
recent history, which loads and syncs faster and takes less memory and
disk. It edits, pushes, pulls, and merges like a full replica; reading
history before its root (history views, blame, restoring an old version)
goes to the server (section 7), which always keeps the whole history.

- **Building one.** The server builds a shallow snapshot from its own copy
  of the document (its latest snapshot and the changes after it), rooted at
  a version it chooses: Kition Server roots it at its latest compaction
  (section 7), so the history since then travels with it. The KDM moves the
  root back past changes made concurrently with it, so every change the
  server has imports into the shallow replica.
- **Threshold.** With `prefer: "shallow"` the server decides; a deployment
  sets the threshold (Kition Server, by default: a latest snapshot of at least
  8 MiB, or a room that has taken at least 10,000 changes). `shallow: true` asks for one whatever
  the size.
- **Changes from before the root.** A replica that edited offline from a
  version older than the shallow replica's root makes changes that depend on
  history the shallow replica lacks. The server takes them (it has the
  history) and relays them as usual; the shallow replica refuses the import
  (KDM `history-missing`) without changing, fetches a new shallow snapshot
  (`snapshot/get` with `shallow: true`, rooted early enough for them), and
  rebases on it (`Replica::rebase`, `rebase` in TypeScript), which keeps its
  own changes, pushed or not, on top. It stays joined: it keeps the
  `changes/pull` notifications that arrive meanwhile and imports them after
  the rebase (KDM import is idempotent, so those the snapshot already holds
  are harmless).
- **Pushing.** A shallow replica's pushes are ordinary change sets: the
  server checks and stores them like any other (section 4). `room/create`
  still takes a full snapshot: a room starts with its whole history.

## 3a. Members

Since 1.6. A room's owner administers who may do what in it; its editors may
see the list. A server answers JSON-RPC `-32601` (method not found) for these
before 1.6.

### `room/members`

| | |
| --- | --- |
| Params | `{ docId }` |
| Result | `{ members, links }` |

`members` is every member of the room, each `{ principalId, name, role }`
(`name` the display name the principal last joined with), the owner first,
then by name. `links` is every share link that still works, each
`{ shareLink, role, createdBy }`. The caller must be the room's `owner` or an
`editor` (`forbidden` otherwise); `not-found` for an unknown room.

### `room/setRole`

| | |
| --- | --- |
| Params | `{ docId, principalId, role }` |
| Result | `{}` |

Changes another member's role to `editor`, `commenter`, or `viewer`. Only the
owner may (`forbidden` otherwise); `invalid` for `owner` or for the caller's
own role; `not-found` for a principal that is not a member. The member's
connections in the room get `room/access` with the new role and work under it
from then on (a viewer's next push is refused).

### `room/removeMember`

| | |
| --- | --- |
| Params | `{ docId, principalId }` |
| Result | `{}` |

Removes another member from the room. Only the owner may (`forbidden`
otherwise); `invalid` for the caller itself; `not-found` for a principal that
is not a member. Their connections leave the room (they get `room/access` with
`role: null`, their presence and leases end), and every later request of
theirs for the room fails as for any non-member. Removing a member does not
revoke the links they could open again: revoke those too (`room/revokeLink`)
to keep them out.

### `room/revokeLink`

| | |
| --- | --- |
| Params | `{ docId, shareLink }` |
| Result | `{}` |

Revokes a share link of the room: `room/open` answers `not-found` for it from
then on, and a role it granted but `room/join` has not turned into membership
yet is dropped. Members who joined through it stay members. Only the owner may
(`forbidden` otherwise); `not-found` for a link that is not one of the room's.

### `room/access` (notification, server to client)

| | |
| --- | --- |
| Params | `{ docId, role }` |

The receiver's role in the room changed (`room/setRole`), or it was removed
(`role: null`; it is no longer joined, and a client does not re-join it on a
reconnect).

## 3b. A person's documents

Since 1.9. A person who edits on more than one device (a desktop and a
laptop, two workspaces) syncs their documents through the server: every
room they are a member of is in their **document list**, which any of their
devices reads, and a document nobody else needs is synced as a **private
room**. Nothing here converts a document: syncing attaches a room to the
replica a device already has (rule S24; [`KitCollab 1.2`](../sets/collab.md)), and every device keeps a complete local replica, so
a person who stops syncing (or whose plan ends) keeps every document.

- **Private rooms.** `room/create` with `private: true`. Only the owner is a
  member; there is no share link, so nobody can open it. Its owner's other
  devices join it like any room they are a member of (`room/join`, which a
  member never needs a link for). The owner shares it later with
  `room/link`, which makes it an ordinary room.
- **Opening a listed document on another device.** The device gets the
  room's state (`snapshot/get`, and `blob/has`/`blob/get` for its blobs),
  makes a local file of it as a new replica of the same document (the same
  `docId`), and joins the room from the snapshot's `seq` as usual.
- **"Sync all my documents".** An account setting (`syncAll`, default
  `false`): when it is on, a client makes a private room for every document
  the person opens that has no room yet, on every device they use. Without
  it a person turns syncing on per document. The setting is the server's,
  so every device reads the same one (`account/settings`) and hears it
  change (`account/changed`).
- **After Pro.** A server that limits co-editing to an entitled principal
  (Kition Server) still answers `rooms/list` and `account/settings` to a
  principal it no longer entitles, and lets a member read a room's state and
  blobs (`snapshot/get`, `blob/has`, `blob/get`) so they can always download
  their documents; joining, pushing, and creating rooms stay refused.

### `rooms/list`

| | |
| --- | --- |
| Params | `{ cursor, limit }` |
| Result | `{ rooms, cursor }` |

One page of the rooms the caller is a member of (any role), most recently
changed first: each `{ docId, name, kit, role, updated, size, private }`,
with `updated` the time of the room's latest change (or its creation) in
milliseconds since the Unix epoch, `size` about how many bytes the server
keeps for the document's current state (its latest snapshot and the changes
after it; a hint for a person choosing what to open, not a quota), and
`private` whether it is a private room. `cursor` (omitted: the first page)
is the previous page's `cursor`; a result's `cursor` is `null` on the last
page. `limit` caps the page (Kition Server: 100 by default, at most 200). A
cursor is opaque; a room that changes while a client pages may show twice
or move past the cursor, so a client keys the list by `docId` and follows
`rooms/changed` rather than paging again.

### `rooms/changed` (notification, server to client)

| | |
| --- | --- |
| Params | `{ docId, room }` |

The receiver's document list changed: `room` is the entry as `rooms/list`
would answer it now (a room it made or joined, a new role, a private room
shared), or `null` when it is no longer a member (removed). A server sends it
to every connection of the principal, the one that caused it too. It is not
sent for every change pushed to a room: `updated` moves without one, and a
client reads it again with `rooms/list`.

### `account/settings`

| | |
| --- | --- |
| Params | `{}` |
| Result | `{ syncAll }` |

The caller's account settings: `syncAll` (default `false`), "sync all my
documents" above. A server keeps them per principal.

### `account/update`

| | |
| --- | --- |
| Params | `{ syncAll }` |
| Result | `{ syncAll }` |

Changes the settings it names (each optional) and answers them all as they
now are. Every connection of the principal, the caller's too, gets
`account/changed`. Only an entitled principal may (Kition Server: `forbidden`
otherwise).

### `account/changed` (notification, server to client)

| | |
| --- | --- |
| Params | `{ syncAll }` |

The receiver's account settings changed (on any of their connections).

## 3c. Open-token rooms

A server that lists the capability `open-rooms` takes **open tokens**
(`ko1.`, [`KitCollab 1.4`](../sets/collab.md) section 4a) as `token` in
`sync/hello`. Such a connection reaches exactly one **file generation**, the
token's `(tenant, iss, file, doc_key)`, and the server keeps at most one room per
generation ([managed-collab.md](../managed-collab.md) rules RM1 to RM7):

- `sync/hello`'s result carries `open: { tenant, iss, file, docKey, role, perms }`;
  `role` is `editor`, `commenter` or `viewer` from the token's permissions,
  never `owner`. Every request of the connection (`changes/push`, `save/*`,
  `lease/*`, `presence/set`) is decided by the connection's token role, never
  by a stored membership or role.
- A room bound to a generation answers only open-token connections of that
  generation: every other connection, a `ks1` one of the same principal
  included, gets `not-found` for it, and its `rooms/list` does not list it.
  An open-token connection never writes a stored membership or role another
  connection could inherit; presence and saves know it by its session.
- Every request naming a `docId` answers `not-found` unless that room is the
  generation's (a room of another file or generation and an absent room are
  indistinguishable); `room/open`, `room/link`, `room/members`,
  `room/setRole`, `room/removeMember` and `room/revokeLink` answer
  `forbidden`; `rooms/list` and `rooms/changed` show only the generation's
  room.
- `blob/has` and `blob/put` for a `docId` with no room are served only to the
  connection holding the generation's seed claim, and are kept per
  generation: another generation probing or uploading the same `docId` sees
  none of them, and only the room that generation makes takes them over.

### `room/resolve`

| | |
| --- | --- |
| Params | `{ claim? }` |
| Result | `{ docId, claimed }` |

`docId` is the generation's room, or `null`. With `claim: true`, an
`editor` connection of a generation without a room takes its **seed claim**
when no other connection holds it (`claimed: true`), for 60 seconds, renewed
by asking again; it ends when the holder's `room/create` succeeds or it
disconnects. Others answer `claimed: false`. A `viewer` or `commenter` never
claims. Answers `forbidden` on a connection without an open token.

### `room/resolved` (notification, server to client)

`{ docId }`: the connection's generation now has a room, sent to every
open-token connection of that generation when `room/create` makes it.

### `room/create` on an open-token connection

Only an `editor` makes the room (`forbidden` otherwise), and only the seed
claim's holder while another connection holds it (`conflict` otherwise); the
room is bound to the generation; its creator joins with the token's role, not
`owner`, and the result's `shareLink` is `null`. A generation that already
has a room answers `conflict` with `error.data.docId` naming it, so the
caller opens that room instead (`@kition/sync`'s `SyncRpcError.boundDocId`);
a `docId` whose room belongs elsewhere answers `conflict` without it.

## 3d. Saves

A server that lists `open-rooms` keeps one **save state** per room and
applies every event to it in order ([managed-collab.md](../managed-collab.md)
section 3; `kition-sync-protocol`'s `save::transition` and `@kition/sync`'s
`saveTransition` are the rules, held to the same table):
`{ status, dirty, headSeq, savedSeq, version, trigger, by, reason, savingSeq }`,
`status` one of `editing`, `force-save`, `must-save`, `corrupted`, `closed`.
A change, an editor's join and leave, and the two requests below move it;
`room/resolve` answers it as `save`.

### `save/begin`

| | |
| --- | --- |
| Params | `{ docId, trigger }` |
| Result | `{ save, seq, authors, receipt }` |

An editor of the joined room starts a save, `trigger` one of `user`,
`timer`, `command`. The room moves to `force-save` by the caller, to write
`seq`; `authors` (`{ principalId, name }`) are every principal whose changes
are in `(savedSeq, seq]`, from the server's own log. `receipt` is the
server's signed save receipt (`ksr1.`, `kition-open-token`'s `receipt`
module): `{ v, typ: "kition-save", kid, iss, aud, tenant, file, doc_key,
doc_id, seq, trigger, authors: [{ principal, name }], iat, exp }`, `aud` the
host's `iss`, at most 600 seconds long. The page passes it to the host's
write; the host verifies it with the server's key and takes the authors,
`seq` and generation from it, never from the page. `save.by` names the
session (connection) that saves, not a person. A clean room answers its
state unchanged unless `trigger` is `user`. Another session's running save
answers `conflict`; a viewer or commenter `forbidden`.

### `save/end`

| | |
| --- | --- |
| Params | `{ docId, seq, version, error? }` |
| Result | `{}` |

The caller's save of `seq` wrote the host's `version` (1 to 256 characters),
or failed with
`error` `conflict`, `failed` (the room stays dirty, `editing`) or `corrupted`
(the room moves to `corrupted`; saving resumes with the next good save).
Another session's call answers `forbidden`; a `seq` other than the save's, or
neither `version` nor `error`, `invalid`.

### `save/changed` (notification, server to client)

`{ docId, save }` to every member after every change of the state. When the
last editor leaves a dirty room it is `must-save`, and the next editor to join
saves first (`trigger: "command"`); a clean room is `closed`. A `version`
here is what a page reported: a host that reads it (to show it, or to
compare) checks that it has that version for that `doc_key` and `seq`.

## 4. Changes

### `changes/push`

| | |
| --- | --- |
| Params | `{ docId, changes }` |
| Result | `{ seq }` |

Pushes one batch of local KDM changes; the server assigns it the room's next
`seq` and relays it to every other member as `changes/pull`. Fails
`forbidden` for a `viewer`; fails `not-found` for a room the caller has not
joined.

Clients are untrusted. Since
1.5 a server checks every pushed change before it stores or relays it:

- **Encoding.** `changes` is a KDM change set (the KDM envelope naming the
  room's `docId`, then the engine's update bytes, which decode with a valid
  checksum); not a snapshot. Otherwise `invalid`.
- **Actors.** Every replica (KDM actor) whose new operations the change
  carries belongs to the pushing principal: an actor belongs to the first
  principal that brought operations of it to the room (the room's creation
  snapshot's actors belong to its owner). A change carrying new operations
  of another principal's actor fails `forbidden`. Operations the room already
  has (a replica sending back what it imported) are not new and are allowed.
- **Schema.** The change applies to the document without changing its
  identity (`meta.docId`, `meta.kit`, `meta.kdm`), and raises the document's
  minimum schema version (`KitModel 1.0` M20) only from a `system`
  transaction. Otherwise `invalid`.

- **Comments only.** Since 1.6, for a `commenter`, every operation the change
  carries targets an object of type `CommentThread` or `Comment` (`KitModel 1.0`
  M23): the object's entry in the KDM `objects` map or a container inside
  that object, the type read from the document before or after the change.
  Every `Comment` it writes an `author` to names the pushing principal. The
  server reads only the KDM format for this, never the kit. Otherwise
  `forbidden`.

- **Server validation.** Since 1.7, for a room whose kit's manifest sets
  `collaboration.serverValidation: true` (manifest rule K13, for kits with
  strong invariants), a server that runs the kit headless (section 8a)
  applies the change to the room's document in the kit, whose merge repair
  (`validate`) runs; when the kit refuses it (`validate` cannot repair the
  result) the push fails `invalid` with `error.data.refused: "kit"`. A
  server that cannot run the kit at that moment fails the push
  `unavailable`, so the client keeps the change and pushes it again later;
  it never stores an unchecked change for such a room.

A refused change changes nothing on the server: it is neither stored nor
relayed, and the error's message says which check failed.

### `changes/pull` (notification, server to client)

| | |
| --- | --- |
| Params | `{ docId, changes, seq, from }` |

Another member's pushed changes; `from` is their principal id. A client
applies these to its local replica in the order they arrive.

## 5. Presence

Presence is ephemeral: the server never persists it, and a reconnect starts
with none until the client sets it again.

### `presence/set` (notification, client to server)

| | |
| --- | --- |
| Params | `{ docId, state }` |

`state` is a kit's own shape (a cursor position, a selection, a viewport) —
opaque to this protocol. Every member of the room sets it, a `viewer` too.
A host relaying a kit's presence (Kit UI protocol section 7e) puts it there
as `{ kit, selection, caret?, viewport? }`.

### `presence/update` (notification, server to client)

| | |
| --- | --- |
| Params | `{ docId, peers }` |

Replaces the room's whole peer list for `docId`; `peers` is every member's
`{ principalId, name, color, state }`. A client that wants only what changed
diffs this against what it already has.

## 6. Blobs

Blobs are the binary media a document's KDM replica references (an image, an
embedded font) and are addressed by content: the lowercase hex SHA-256 of
their bytes.

Since 1.5 blobs are **scoped to documents**: every blob message names the
`docId` it is for. `blob/put` records that `docId` references the blob (a
server stores the bytes once, whatever number of documents reference them),
and `blob/has` and `blob/get` answer only blobs `docId` references. Knowing a
hash is therefore never enough to read a blob: the reader must be able to
read a room that references it, and a room references only what someone who
had the bytes uploaded to it. A server counts the documents referencing each
blob and may delete a blob no document references any more. A 1.4 request
without `docId` fails (`-32602`, invalid params).

### `blob/has`

| | |
| --- | --- |
| Params | `{ docId, hashes }` |
| Result | `{ missing }` |

`missing` is every hash `docId` does not reference, including one another
document references (upload it for this one). For an existing room the
caller must have a role in it (`forbidden` otherwise).

### `blob/put`

| | |
| --- | --- |
| Params | `{ docId, hash, mime, data }` |
| Result | `{}` |

The server verifies `data` hashes to `hash` and fails `invalid` otherwise,
rather than storing bytes under a hash that does not actually describe them.
For an existing room the caller must be its `owner` or an `editor`
(`forbidden` otherwise); a `docId` with no room yet is allowed, so a client
uploads a document's blobs before `room/create` makes its room.

### `blob/get`

| | |
| --- | --- |
| Params | `{ docId, hash }` |
| Result | `{ data, mime }` |

Fails `not-found` for an unknown room, and `forbidden` when the caller has
no role in the room or `docId` does not reference `hash`. A client SHOULD verify
`data` hashes to the `hash` it asked for before trusting it, the same way the
server does on `blob/put`: a corrupted store or a misbehaving server then
surfaces as a client-side failure instead of silently wrong bytes.

## 7. History

Since 1.5. A server keeps every change of a room for a retention window (a
deployment's choice; Kition Server keeps 30 days by default) and periodically
**compacts** a room: it records a snapshot of the document as of a `seq`,
which `snapshot/get` then answers, and drops changes older than the window
that a snapshot already reflects. History reads go through these methods;
every member of the room (any role) may read, owners and editors may restore.

### `history/list`

| | |
| --- | --- |
| Params | `{ docId, before, limit }` |
| Result | `{ checkpoints, more }` |

The room's **checkpoints**, newest first, each `{ seq, firstSeq, time,
principalId, changes, kind }`: `kind: "changes"` is a run of consecutive
changes one principal pushed close together in time (`firstSeq`..`seq`,
`changes` of them, `time` the last one's, in milliseconds since the Unix
epoch); `kind: "snapshot"` is a snapshot the server compacted history into
(`principalId` `null`, `changes` `0`), the only checkpoints left from before
the retention window. `before` (omitted: the latest) lists only checkpoints
whose `seq` is below it, at most `limit` (a server caps it; 100 by default);
`more` says older ones remain, fetched with `before` set to the last
checkpoint's `firstSeq`.

### `history/get`

| | |
| --- | --- |
| Params | `{ docId, seq }` |
| Result | `{ snapshot, seq }` |

A snapshot of the document as of `seq` (every change up to it). Within the
retention window that is exactly `seq`; before it, the nearest snapshot at or
before `seq`, whose `seq` the result names. Fails `not-found` for a `seq`
the room does not have yet.

### `history/restore`

| | |
| --- | --- |
| Params | `{ docId, seq }` |
| Result | `{ seq, restored }` |

Restores the document's state as of `seq` (as `history/get` reads it) as
**one new change** on top of the current state: nothing is rewritten, so
the restore is itself in the history and can be undone by restoring again.
The caller must have joined the room as its `owner` or an `editor`
(`forbidden` otherwise). The server makes the change, appends it, and sends
it to every member as `changes/pull` (the caller too, with `from` the
caller's principal id); `seq` is its `seq`, or `null` when the document was
already in that state. `restored` is the `seq` whose state was restored.
Fails `invalid` when the restore would cross a migration that raised the
document's minimum schema version (rule M20): restore to a later checkpoint.

## 8. Leases

Since 1.5, for servers that list the `leases` capability. Some edits do not
merge meaningfully: two people repainting the same pixels, two full rewrites
of one PDF, two conflicting constraint solves. A kit lists the scopes it
coordinates this way in `kit.json` `collaboration.leases` (Kit Harness
Protocol 2.0, rule M21), and the session editing one first takes a short
**lease** on it from the server. Everything else never waits for the network.

A lease covers one **scope** in one room: a KDM object id (a layer, a content
stream), a name the kit defines (`layer:<id>/pixels`), or `*`, the whole
document. Two scopes collide when they are equal or when either is `*`;
scopes are opaque strings to the server, 1 to 256 bytes. A lease belongs to
the **session** (the connection) that took it, not to the principal: the same
person's second window is refused like anyone else's.

A lease is **advisory coordination, not access control**: the server never
refuses `changes/push` because of one. A kit asks before editing a leased
object and stops when refused; an edit made offline (no server to ask) is
allowed and, if another session held the lease meanwhile, lands as a
**conflict object** that keeps both versions (`KitModel 1.0` M22).

A lease is `{ scope, principalId, name, session, ttl }`: who holds it, the
holder's session (opaque; it is what tells a client its own leases from
others'), and `ttl`, the milliseconds it had left when sent. `ttl` is
informational: a client treats a lease as held until `lease/changed` drops
it, never expiring one on its own clock.

### `lease/acquire`

| | |
| --- | --- |
| Params | `{ docId, scope, ttl }` |
| Result | `{ lease }` |

Takes the lease on `scope` for `ttl` milliseconds (omitted: 30 000; a server
clamps it to between 1 000 and 120 000), or **renews** it when the caller's
session already holds it (the expiry moves to now + `ttl`; the room's lease
list does not change, so nothing is broadcast). The caller must have joined
the room as its `owner` or an `editor`: a viewer is refused `forbidden`, and
a room the caller has not joined `not-found`. When another session holds a
colliding scope, the request fails `conflict` with that lease in
`error.data.lease`, so the kit can say who is editing. A bad scope fails
`invalid`, and so does a session holding too many leases in one room (Kition
Server: 64).

### `lease/release`

| | |
| --- | --- |
| Params | `{ docId, scope }` |
| Result | `{}` |

Ends the caller's lease on `scope`. Releasing a lease the caller does not
hold (it expired, another session holds it, there is none) changes nothing
and still succeeds.

### `lease/changed` (notification, server to client)

| | |
| --- | --- |
| Params | `{ docId, leases }` |

Replaces the room's whole lease list for `docId`. The server sends it to every
member of the room whenever a lease starts or ends (acquired, released,
expired, or its session left the room or disconnected), and to a joining
connection right after its `room/join` answer when the room has any lease.

Leases are bound to live sessions, so a server keeps them in memory: a
restart closes every session and with them every lease, and a client that
reconnects starts with none (its `room/join` brings the current list). A
client renews a lease it still needs well before its `ttl` passes (at half
of it, say); `@kition/sync`'s `leases.hold` does.

## 8a. Server-side kits

Since 1.7. A server may run the same kit engines the editors run, headless,
over the Kit Process Protocol (Kit Harness Protocol; the kits' native executables and
their replica methods `model.open`, `model.import`, `model.export`,
`model.save`, [object-model.md](object-model.md)): it never has an
implementation of a kit of its own. It lists `headless` in `sync/hello` when
it does. Each method below needs a kit for the room's `kit`; for a kit the
server does not run, or when every kit process is busy past what it queues,
it answers `unavailable`. `not-found` is for an unknown room, `forbidden`
for a caller with no role in it (any role may read a preview or an export).

### `preview/get`

| | |
| --- | --- |
| Params | `{ docId, page?, size? }` |
| Result | `{ image, mimeType, width, height, seq }` |

A picture of the document as of the room's latest change (`seq`), rendered
by the kit: the first page, or the zero-based `page` for a kit that pages
(slides, sheets; a kit that does not ignores it), at most `size` pixels on
its longest side (a server default and cap apply). `image` is binary
(`{"$bin": n}`). A server caches previews by `docId`, `seq`, `page`, and
`size`, so asking again for an unchanged room is cheap.

### `export/get`

| | |
| --- | --- |
| Params | `{ docId, format? }` |
| Result | `{ data, name, format, seq }` |

The document as of `seq` as a file in `format` (one the kit saves; the
kit's native format when omitted), saved by the kit. `name` is the room's
name with the format's extension. `data` is binary. A format the kit does not
save fails `invalid`.

### `agent/run`

| | |
| --- | --- |
| Params | `{ docId, batch, prompt? }` |
| Result | `{ seq, result }` |

A server-side agent's edit: the server runs `batch` (an object-model batch,
Kit [`KitObjectModel 1.0`](../sets/object-model.md): `{ ops, load? }`, without `documentId`) on
the room's document in the kit, as an agent acting for the caller, and makes
what it changed one new change of the room, which every member (the caller
too) receives as `changes/pull`. The caller must have joined the room as its
`owner` or an `editor` (`forbidden` otherwise). The server sets the batch's
`origin` itself — `{ kind: "agent", principal: <the caller>, label:
prompt }` — whatever the batch says, and the change's actor belongs to the
server's agent principal (`server:agent`), never to a person, so no client
may push as it. `result` is the batch's answer (`{ refs, results, loaded }`);
`seq` is the change's (`null` when the batch changed nothing). A batch the
kit refuses fails `invalid` with the object model's error in
`error.data.model` (`{ code, index, message }`). This step runs batches
only; a model that writes them (an LLM) is the caller's.

## 9. Libraries

- `@kition/sync` (client): `SyncClient` — `connect`, `join`, `leave`, `push`,
  `onChanges`, `setPresence`, `onPresence`, `blobs.has`/`put`/`get` (each with
  the `docId`), `snapshot`, shallow starts (the `start` option, or a
  `start` argument to `snapshot` and `join`: `{ shallow: true }` or
  `{ prefer: "shallow" }`, 1.8; a re-join after a reconnect and
  `startRelay` never ask for one), `createRoom`, `openRoom`, `createLink`,
  `history`, `historyAt`, `restore`, `members`, `setRole`, `removeMember`,
  `revokeLink`, `onAccess` (1.6), `preview`, `exportFile`, `runAgent` (1.7),
  `createPrivateRoom`, `listRooms`, `onRoomsChanged`, `accountSettings`,
  `updateAccountSettings`, `onAccountChanged` (1.9),
  `leases` (`acquire`, `release`, `hold`, `list`, `onChanged`, `mine`),
  `onState` — reconnects with backoff
  (equal jitter, capped) and queues pushes made while offline, sending them
  in order once rejoined. Framework-free; depends on nothing beyond Web
  Crypto (`SHA-256`) and the WebSocket-shaped `SyncTransport` it is given.
- `@kition/script` (object model): `openRoom` keeps a KDM replica of a room in
  a script (Node or a page), runs object-model batches on it, pushes their
  changes, and sends commands as `agent/run` on a server that lists
  `headless`; `createRoom` shares a document ([object-model.md](object-model.md),
  "Sync rooms").
- `kition-sync-protocol` (Rust): the message types (`messages`), the wire
  envelope and its parsing (`protocol`), and the binary framing (`framing`)
  — no server or client logic; a server and a client each build their own
  behavior on these types.

## 10. Rules

- **S1** A server MUST answer `sync/hello` before any other message, and a
  client MUST send it first.
- **S2** `room/open` MUST NOT itself join the room or change membership; only
  `room/join` does.
- **S3** A server MUST reject `changes/push` from a `viewer` (`forbidden`)
  and MUST NOT relay it.
- **S4** `blob/put` MUST verify the declared `hash` against `data` before
  storing it.
- **S5** A client reconnecting MUST re-send `room/join` (with the highest
  `seq` it had itself seen for that room) for every room it had joined before
  resuming pushes, so it never pushes a change built on history it has not
  caught up on.
- **S6** A server MUST answer `room/join`'s `seq` as the room's latest when
  `more` is `false` (even when `changes` is empty), and as the last included
  change's `seq` when `more` is `true`, so a client always learns where it
  now stands or exactly where to resume paging.
- **S7** A server MUST return at most `min(limit, 512)` changes from
  `room/join` (default 512 when `limit` is omitted), and MUST set `more` to
  `true` whenever changes remain after the page it returned, so a room with
  more changes than fit in one message's binary frames can still be joined.
- **S8** Since 1.5, a server MUST answer `blob/has` and `blob/get` only for
  blobs the named `docId` references and only to a principal with a role in
  its room, and MUST record a reference only from a `blob/put` whose `data`
  it verified (S4), so knowing a hash never grants its bytes.
- **S9** Since 1.5, a server MUST refuse (and neither store nor relay) a
  pushed change that is not a KDM change set of the room's document, that
  carries new operations of an actor belonging to another principal
  (`forbidden`), or that changes the document's identity or raises its
  minimum schema version outside a `system` transaction (`invalid`).
- **S10** Since 1.5, a server that no longer keeps the changes after a
  `room/join`'s `since` MUST answer `snapshot: true` with a snapshot as
  `changes[0]`, never silently skip the changes it dropped.
- **S11** Since 1.5, a server that lists `leases` MUST grant a scope to at
  most one session at a time (a scope and `*` collide with each other and
  with themselves), MUST refuse `lease/acquire` from a `viewer`
  (`forbidden`), and MUST answer a collision `conflict` with the current
  holder's lease in `error.data.lease`.
- **S12** Since 1.5, a server MUST end a lease when its `ttl` passes without a
  renewal, when its holder releases it, and when its holder's session leaves
  the room or disconnects, and MUST send `lease/changed` to the room's
  members each time a lease starts or ends.
- **S13** A client MUST NOT treat a lease as ended until `lease/changed` drops
  it, and MUST NOT treat a lease as a reason to refuse or drop changes it
  receives: leases coordinate editing; they never decide what merges.
- **S14** Since 1.6, a server MUST refuse (`forbidden`, neither storing nor
  relaying it) a change pushed by a `commenter` that carries an operation on
  anything but a `CommentThread` or `Comment` object, or that writes a
  `Comment` `author` other than the pushing principal; a `commenter` MUST NOT
  restore history, acquire leases, or upload blobs to the room.
- **S15** Since 1.6, only a room's `owner` may change roles, remove members,
  or revoke links, and never their own role or membership; a server MUST tell
  the affected member's connections with `room/access` and MUST apply a new
  role to the very next request of theirs.
- **S16** Since 1.6, a revoked link MUST NOT resolve (`room/open` answers
  `not-found`), and a removed member MUST NOT read or push to the room until
  they join again through a link that still works.
- **S17** Since 1.7, a server that lists `headless` MUST run the room's own
  kit for `preview/get`, `export/get`, `agent/run`, and server validation,
  never an implementation of its own, and MUST answer `unavailable` rather
  than guess when it cannot.
- **S18** Since 1.7, for a room whose kit sets
  `collaboration.serverValidation`, a server that validates MUST NOT store or
  relay a pushed change the kit refused, nor one it could not check.
- **S19** Since 1.7, `agent/run` MUST set the batch's origin to `agent` for
  the calling principal, MUST record the change's actor as the server's own,
  and MUST refuse a caller who may not edit the room.
- **S20** Since 1.8, a server that answers a shallow snapshot MUST build it
  from the whole history it keeps, as of the `seq` it answers, and MUST keep
  that history: history reads, restores, and full snapshots still answer
  from it. It MUST answer a shallow start only to `snapshot/get` and to a
  `room/join` with `since: null`, MUST say so (`shallow: true`), and MUST
  refuse a shallow snapshot as `room/create`'s snapshot (`invalid`).
- **S21** Since 1.8, a client MUST NOT import a shallow snapshot into a
  replica it has; it loads one as a new replica, or rebases a shallow
  replica on it (section 3, "Shallow replicas").
- **S22** Since 1.9, `rooms/list` MUST answer only rooms the caller is a
  member of, and a private room MUST have no share link (`room/open` cannot
  reach it, `room/join` admits only its members) until its owner mints one.
- **S23** Since 1.9, a server MUST send `rooms/changed` to every connection
  of a principal whose document list gained, lost, or changed a room
  (created, joined, role changed, removed, private room shared), and
  `account/changed` to every connection of a principal whose settings
  changed.
- **S24** Since 1.9, syncing a document to a person's devices MUST attach a
  room to the replica a device has, never convert or re-import it, and a
  client MUST keep a complete local replica of every synced document, so
  that turning sync off, losing access, or the server going away never
  loses a document.
