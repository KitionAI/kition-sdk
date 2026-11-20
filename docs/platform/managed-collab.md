# Managed co-editing: open tokens, rooms per file, saves, host services

This guide describes open tokens, per-file rooms, managed saves and host
services. The contracts are defined in [KitCollab](sets/collab.md), the
[sync protocol](reference/sync-protocol.md) and the
[Kit UI protocol](reference/ui-protocol.md). These interfaces connect a host,
its kit UI frames and Kition Server.

The words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 0. The shape in one paragraph

The **host** (Kition One, or any integrator) owns files, people and
permissions. For every editor it opens it signs a short-lived **open token**
naming exactly one file, the version the session starts from, a `doc_key`,
the person and their permissions. The browser hands that token to the
kit host (the embed, which reads the permissions and watermark from it) and,
as the sync credential, to **Kition Server**, which verifies it offline
against the host's public key. Server keeps at most one room per
`(tenant, file, doc_key)`, so a token can only ever reach its own file's room,
and decides race-free who seeds a missing room. Saves follow one state
machine shared by every editor through Server; each save is one host version
with its authors. Kits never pick files, people or share settings
themselves: they ask the host, and report comment anchors so the host
stores anchored comments.

## 1. Open tokens

### 1.1 Format

```text
ko1.<base64url(claims JSON)>.<base64url(Ed25519 signature over the ASCII of the middle segment)>
```

The same envelope as the sync token `ks1.` ([`KitCollab 1.3`](sets/collab.md)
section 4): verifiers check the signature over the segment bytes as sent and
never re-serialize, so key order is the signer's (signers in the SDK sort keys).

| Claim | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Format version |
| `typ` | `"kition-open"` | Distinguishes it from `kition-sync` tokens |
| `kid` | string | The host key that signed it |
| `iss` | string, 1..128, `[A-Za-z0-9._-]` | The host that signed it (One: `one.<instance id>`); no `:`, so principals stay unambiguous |
| `aud` | string, 1..256 | The Kition Server it is for (that server's configured id) |
| `tenant` | string | Server tenant, the same syntax as `ks1` |
| `sub` | string, 1..128 | The person (host user id) |
| `name` | string, ≤ 128 | Their display name |
| `file` | string, 1..128, `[A-Za-z0-9._:-]` | The host's immutable resource id. Never a path or name |
| `version` | string, 1..128 | The host content revision this session opens |
| `doc_key` | string, 1..128, `[A-Za-z0-9._-]` | The co-editing generation (section 1.3) |
| `perms` | object | `{ edit, comment, download, share, export }`, all booleans |
| `watermark` | `null` or `{ text }`, text ≤ 256 | What the kit host draws over the editor |
| `iat`, `exp` | seconds | `exp - iat` in 1..3600; `iat` at most 60 s ahead |
| `jti` | string, optional | For the host's own audit |

Rules:

- **OT1** `perms.edit` implies `perms.comment`; a token that says otherwise is
  refused (`invalid`). The sync role is `editor` for `edit`, `commenter` for
  `comment` alone, `viewer` otherwise. An open token never grants `owner`.
- **OT2** Verifiers (Server, the kit host) need only the host's public keys:
  no callback asks the host about permissions. Every key is bound to one
  tenant and one issuer: `{ kid, publicKey, tenant, iss }`. A verifier looks
  a key up by `(tenant, kid)` and refuses a key set that holds two keys with
  one `(tenant, kid)` (`duplicate-key`), never choosing one of them.
- **OT3** A verifier refuses: no key of the claims' tenant with the `kid`
  (`unknown-key`); a bad signature; a key whose `iss` is not the claims'
  (`issuer`); an `aud` other than its own id (`audience`); `v` ≠ 1; `typ` ≠
  `kition-open`; a missing or malformed claim; `exp - iat` > 3600 or ≤ 0;
  `iat` more than 60 s ahead; `now >= exp`. Parsing is strict and the same in
  both libraries: canonical unpadded base64url only, no object key twice, no
  fractional or exponent numbers, `name` a string when present.
- **OT6** The connection's principal is `t:<tenant>:<iss>:<sub>`: the same
  user id from another host, or a `ks1` token's `t:<tenant>:<sub>`, is
  another principal.
- **OT4** The host computes `perms` and `exp` from its own authorization at
  signing time (current session, effective role from direct, group and
  inherited grants, grant expiry), and `exp` MUST NOT pass the earliest
  point the effective role can decrease. Inside a token's life the host
  revokes (OT7); short lifetimes (60 to 300 s) bound what a missed event
  could leave.
- **OT7** On every event that can lower a person's role on a file (a
  grant revoked, expired or downgraded, a group change, a restricted folder,
  an account suspended or its sessions reset, the space archived, the file
  deleted), the host revokes `(tenant, iss, sub)`, `(tenant, iss, file)` or
  `(tenant, iss, sub, file)` on the server. The server then closes every
  live open-token connection the revocation covers at once (serving no
  further message from it, whatever it had already sent) and refuses at
  hello any open token it covers that was signed (`iat`) before the
  revocation's second. A downgrade is a revocation followed by the host's
  new token at the lower role: the page reconnects with it. Kition Server
  takes revocations in-process (`App::revoke_open`, for the server a host
  runs itself); the call answers how many connections closed.
- **OT5** Download, export, share and watermark are *display* permissions the
  kit host enforces in its UI (hiding Export, Print, Download, the share
  button; drawing the watermark). They are not a security boundary against a
  person who can read the document; the host's own HTTP routes enforce them
  for bytes it serves.

### 1.2 Libraries

- Rust: `kition-open-token` (crate `crates/kition-open-token`): `Claims`,
  `Perms`, `Watermark`, `verify(token, keys, now)`, `sign(claims, key)`
  (feature `sign`, for host servers such as One's `server-rs`),
  `role_of(perms)`, `doc_key(file, generation)`.
- TypeScript: `@kition/sync/openToken`: `verifyOpenToken`, `decodeOpenToken`
  (unverified read, for a browser that only needs to show what the token
  says), `signOpenToken` (Node / WebCrypto hosts), `openTokenRole`,
  `deriveDocKey`. Both are held to the same answers by
  `crates/kition-open-token/tests/vectors.json`.

### 1.3 `doc_key`

`doc_key` names one co-editing generation of a file. The host keeps a
`generation` counter per file and MUST bump it whenever the file's content
changes by any path other than a save published *from the room of the current
generation*: an upload or HTTP write, a version restore, an import over it, a
recovery that loses the room. Saves the room publishes keep the
generation, so co-editors are not thrown out on every save. `doc_key` is
`deriveDocKey(file, generation)` = the first 32 characters of
base64url(SHA-256(`"kition-doc-key\n" + file + "\n" + generation`)), or any
other value the host stores. It is not a secret: the token that carries it
is signed, and a `doc_key` alone grants nothing.

Consequences: an old tab whose token names an earlier `doc_key` reaches only
the earlier room, never the new one; the host refuses that room's later
saves because their base version is stale (SV3). A copy is a new `file`,
so a new room, even when its bytes carry the same KDM document id.

## 2. Exact per-file rooms

### 2.1 Tokens never use wildcards

A `ko1` token names one file. There is no `"*"`. Server binds the
connection's principal `t:<tenant>:<iss>:<sub>` (OT6) to the scope
`{ tenant, iss, file, doc_key, role }` (**RM1**). The connection's own token
role decides every request it makes (`changes/push`, `save/*`, `lease/*`,
`presence/set`); a stored membership or role never does (**RM1a**). Every room-addressed request (`room/join`,
`snapshot/get`, `changes/push`, `presence/set`, `blob/*`, `lease/*`,
`history/*`, `preview/get`, `export/get`, `agent/run`, `save/*`) MUST
answer `not-found` unless the room is bound to that `(tenant, iss, file,
doc_key)`; out-of-scope and absent rooms are indistinguishable (**RM2**). A
bound room answers only open-token connections of its generation: a `ks1`
connection, of the same principal or not, gets `not-found` and does not see
it in `rooms/list`; open-token sessions never write a stored membership or
role a `ks1` connection could inherit (**RM2a**).
`room/open`, `room/link`, `room/setRole`, `room/removeMember`,
`room/revokeLink` answer `forbidden` (as CS6). Historic membership never
raises the token's role (**RM3**). `rooms/list` and `rooms/changed` show an
open-token connection only its scoped room (**RM4**).

### 2.2 One room per file generation; who seeds it

Server keeps a unique binding `(tenant, iss, file, doc_key) → docId`. A room's
`docId` is still the KDM replica id, chosen by the seeding replica; the
binding, not the UUID, carries authority, so a UUID claimed by a browser
cannot attach one file's ACL to another file's room.

New request `room/resolve` (sync protocol, open-token connections only):

| | |
| --- | --- |
| Params | `{ claim? }` |
| Result | `{ docId, claimed, save }` |

- `docId` is the bound room's id or `null`.
- With `claim: true` and no room, an `editor` connection gets
  `claimed: true` and holds the **seed claim** for the generation for 60 s
  (renewed by calling again); every other connection gets
  `claimed: false` while it is held. A `viewer` or `commenter` never claims
  (**RM5**).
- The claim ends when its holder's `room/create` succeeds, it disconnects, or
  60 s pass. Server sends `room/resolved { docId }` (notification) to every
  open-token connection of that generation when the room appears.
- `save` is the room's save state (section 3), `null` without a room.

Seeding (the SDK does this; `@kition/embed`'s collaboration session):

1. Before the kit opens, `room/resolve { claim: true }`.
2. `docId` present: the existing room's snapshot becomes the file's stored
   replica and the kit opens it (the existing `prepare` path).
3. `claimed: true`: if the host's replica store holds a checkpoint for this
   file whose stamp is the token's version, the room is seeded from it
   (same `docId`, so recovery keeps identity); otherwise the kit opens the
   stored file and its replica seeds the room. Blobs are uploaded first
   (`blob/put` under the claim), then `room/create`. A `room/create` for a
   generation that already has a room answers `conflict` with
   `data.docId` (**RM6**); one for a `docId` bound to another generation
   answers `conflict` without data.
4. `claimed: false`: wait for `room/resolved` (or poll `room/resolve` every
   2 s) up to 30 s, then go to 2. Past that, the editor opens read-only with
   the reason `unavailable` rather than seeding a second room.
5. A viewer finding no room opens the stored file read-only and not live; the
   embed reports `collab.state.status` `offline` with `docId: null` and
   joins when `room/resolved` arrives.

Pre-room blobs: `blob/has` and `blob/put` for a `docId` with no room
are allowed only to the claim holder, are recorded under its generation, are
counted against the tenant's quota, and are deleted with the claim if no
`room/create` follows within 10 minutes (**RM7**). Everyone else gets
`not-found`.

### 2.3 Durable checkpoints and recovery

Three durable things exist and stay distinct: Server's room (changes since
the seed), the host's **checkpoint** (a KDM snapshot plus blob section, the
host's recovery record), and the host's **versions** (file bytes).

- **CK1** The session holding the save lease writes a checkpoint
  through the host's replica store (`storage.replica.write`, keyed by file,
  stamped with the version it saved) after every successful save, and at
  most every 5 minutes while the room changes. The checkpoint is
  `snapshot/get` of the room at a known `seq`, so it is a state every editor
  converged on.
- **CK2** Server's own storage is authoritative while it has the room. When
  Server lost it (fresh restore), `room/resolve` answers `null`,
  and the seed step 3 reseeds the room from the newest checkpoint whose
  stamp is the token's version, keeping the `docId`. A checkpoint whose
  stamp is not the current version is not used; the host bumps the
  generation instead (section 1.3), so stale state never reappears.
- **CK3** One backs up its checkpoints with its files; Server backs up its
  rooms. A joint restore needs neither to be newer than the other: CK2 makes
  a missing Server room reseed from One, and a Server room newer than One's
  version keeps its edits until the next save.

### 2.4 Mixed-role tabs in one page

`@kition/embed` gives an editor whose token is an open token a `SyncClient`
of its own identity provider (**RM8**); editors with `ks1` sync tokens keep
sharing one client per server URL, as before. A host opens each file with its
own identity provider, whose `token()` signs that file's open token; two
editors of different files on one page therefore hold separate connections,
each reconnecting with its own token and role, and closing one never hands
its callback to another. Every editor asks its
provider for the first token before it connects, to tell the two apart, and
connects with that token: an open-token editor never joins the connection
sync-token editors share.

## 3. The save state machine

One state per room, kept by Server and broadcast to every connection, so
every editor shows the same "saved / saving / unsaved" state and exactly one
session saves.

| State | Meaning | Left by |
| --- | --- | --- |
| `editing` | People are editing; `dirty` tells whether the room is ahead of the last version | a change (stays), `force-save`, `must-save`, `closed` |
| `force-save` | A save is running now, by one session, for one `trigger`: `user` (Save), `timer` (autosave), `command` (an agent, an API, the host) | `save/end` |
| `must-save` | The last editor left with unsaved changes: the next editor to join MUST save before anything else, or the host saves from the checkpoint | the next save |
| `corrupted` | A save produced bytes the kit or host rejected; saving stops, editing continues; the host keeps the last good version and shows the error | a successful save, or a host restore (new generation) |
| `closed` | Everyone left and the room is clean | the next join |

Requests (sync protocol):

- `save/begin { docId, trigger }` → `{ save, seq, authors, receipt }`. Moves the room to
  `force-save` for this connection (an editor), or answers `conflict` while
  another save runs (the caller waits for `save/changed`). `seq` is the
  room's head; `authors` are `{ principalId, name }` of every principal whose
  changes are in `(savedSeq, seq]`, computed by Server from its change log,
  never from the client. `receipt` is Server's signed save receipt
  (`ksr1.`, `kition_open_token::receipt`): `{ iss: <server id>, aud: <host
  iss>, tenant, file, doc_key, doc_id, seq, trigger, authors, iat, exp }`,
  at most 600 s long. A clean room answers `save.dirty: false` and stays
  `editing`, unless `trigger` is `user`. `save.by` is the saving session
  (connection), never a person.
- `save/end { docId, seq, version | null, error? }`, `version` 1 to 256
  characters, with `error` one of
  `conflict`, `failed`, `corrupted`. Success records `savedSeq = seq` and the
  host `version`; `conflict` and `failed` return to `editing` (dirty);
  `corrupted` moves to `corrupted`.
- `save/changed { docId, save }` (notification) after every transition.
- `save` = `{ status, dirty, headSeq, savedSeq, version, trigger, by, reason }`.
- Server moves `force-save` back to `editing` when its connection drops, and
  `editing` to `must-save`/`closed` when the last editor leaves.

Rules:

- **SV1** One version per save: the saving session writes the kit's bytes with
  the host's conditional write (`expected` = the last saved version, EM3),
  passing `{ trigger, authors, seq, docKey, docId, receipt }`. The host
  verifies the receipt (Server's key, `aud` its own `iss`, unexpired, `file`
  and `doc_key` its own, `seq` not below the last it stored) and stores one
  version with the receipt's authors, never the page's `authors`. Nothing
  else writes versions while a room exists. A save at the same `seq` as the
  last stored one is accepted: `seq` is the Server's head when the save began,
  and the kit's bytes may hold edits the Server has not acknowledged yet (a
  Save right after an edit); the same bytes again write no version.
- **SV2** Autosave is `timer` every 30 s while dirty, and on the last editor's
  close; `user` Save always makes a version. An agent run that saves is
  `command`.
- **SV3** The host refuses (`conflict`) a write whose `docKey` is not the
  file's current generation or whose `expected` is stale; the session reports
  `save/end { error: "conflict" }` and keeps every edit in the room.
- **SV3a** A `version` in the save state is what a page reported in
  `save/end`. A host that reads it checks that it holds that version for that
  `doc_key` and `seq`; the page's own next write still carries `expected`, so
  a false version only makes that write conflict.
- **SV5** Keep my copy (`@kition/embed` 0.3). After the file moved to a later
  generation (1.3), a session's room can save no more. A save there is a
  conflict unless the person chose to keep their copy, which the kit shows as
  saving over the file's current version (`expected` = the current stamp).
  Then, when the new generation has no room yet, the embed writes the kit's
  bytes as the file's content with the host's conditional write (no receipt:
  the host starts the next generation, 1.3), waits for the token to name it,
  prepares that generation's room and opens the kit on it, live. When the new
  generation has a room (people co-edit the new version), the save is a
  conflict asking the person to open the file again; applying the copy as an
  edit in that room needs a kit operation the Kit UI protocol does not have
  yet. The other writer's version is replaced only by that explicit choice,
  never silently, and the copy is never left only in the earlier room. While
  the editor moves, the page's save (closing the tab) waits and saves in the
  new generation; a save the replaced kit sends meanwhile is refused.
- **SV4** `must-save` is completed by whichever editor joins next (its SDK
  calls `save/begin` with `trigger: "command"` as soon as it is online), so a
  crash of the last editor loses no acknowledged change.
- **SV6** The room keeps unsaved edits. An edit belongs to the file's room as soon as Server
  acknowledges it, not to the page that made it: a failed save, a closed or
  reloaded tab, a revoked or downgraded connection, or a page that signs out
  never discards it. Everyone who opens the file in that generation, the
  person who made the edit included, sees the room's state, and edits from
  several people merge there. The file changes only through a successful save
  (SV1); until then the host's file and its versions stay as they were. A
  person whose access ends gets no more of the room: their connection
  closes, and nothing the room holds reaches them again. Edits that never
  reached Server (sent while offline, refused for a role) are the page's
  alone and go with it. A write outside the room starts the next generation
  (1.3), whose room is seeded from the file; the earlier room's unsaved edits
  then reach the file only through "keep my copy" (SV5).

SDK: `@kition/sync`'s `SaveMachine` (pure transitions, the same in every
client and in tests) and `SyncClient.saveBegin/saveEnd/onSave`; the Rust
types are in `kition-sync-protocol::messages` (`SaveState`, `SaveStatus`,
`SaveTrigger`, `SaveBeginParams` ...), for Server.

## 4. Host services and comment anchors

### 4.1 `host/service` (Kit UI protocol, capability `service:<id>`)

A kit asks the host for anything that needs the host's people, files,
dialogs or permissions, so every kit behaves like a native part of the host.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `host/service` | kit to host | `{ service, params }` | `{ ...per service }` |

| `service` | Params | Result |
| --- | --- | --- |
| `file.pick` | `{ purpose, accept }` | `{ files }`, grants as `files/pick` answers them (7g); empty when cancelled |
| `image.insert` | `{ accept? }` | `{ image: { name, mime, bytes } \| null }` |
| `people.mention` | `{ query, limit? }` | `{ people: [{ id, name, avatar? }] }`; only people the host lets this person see |
| `people.notify` | `{ people: [id], message, anchor? }` | `{ notified: [id] }` |
| `share.open` | `{}` | `{ done }`; the host's share dialog |
| `file.rename` | `{ name? }` | `{ name \| null }` |
| `file.saveAs` | `{ name?, format?, bytes }` | `{ path \| null }` |
| `access.request` | `{ perm: "edit" \| "comment" }` | `{ requested }` |
| `editor.close` | `{}` | `{ closed }` |
| `comment.create` | `{ anchor, text? }` | `{ thread \| null }`, the host's thread id |

- **UI-V1** A kit sends `host/service` only for a service the host lists as
  `service:<id>` and only from a person's gesture (`people.mention` also while
  they type after `@`). Refusals are `-32000` with `error.data.reason` one of
  `not-allowed`, `no-gesture`, `cancelled`, `not-found`, `failed`.
- **UI-V2** A kit that has a host service MUST NOT show its own version of it
  (its own share dialog, its own file browser, its own people list).
- **UI-V3** Hosts check every parameter (sizes as UI-S4; `bytes` at most the
  host's file limit; `message` at most 2 000 characters).
- **UI-V4** to **UI-V6**: services are offered and served
  only under the document's permissions (comment rights for comments,
  mentions and notices; edit for pick, insert and rename; download or export
  for save-as; share for sharing); hosts treat every request as unsolicited
  (their own dialog for rename and save-as, notices only confirmed or with a
  posted comment, mentions and notices rate-limited); anchors and text are
  plain text without control or bidirectional formatting characters (Kit UI
  protocol section 7k).

### 4.2 Comment anchors

An **anchor** is `{ ids, range?, quote?, page?, label? }`: the selection's
object ids (`KitPointer 1.0` PT7, at most 256), an optional text range in the
first id's text, the quoted text, the page, and a short label the host shows
in its comment list. Kits produce anchors from their selection; hosts store
them with their own comment threads.

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| `comments/show` | host to kit (notification), `comment-anchors` | `{ threads: [{ id, anchor, resolved, count }] }` | |
| `comments/locate` | host to kit, `comment-anchors` | `{ anchors: [anchor] }` | `{ found: [bool] }` |
| `comments/activated` | kit to host (notification), `comment-anchors` | `{ id }` | |

A kit that lists `comment-anchors` draws a marker per shown thread and sends
`comments/activated` when the person clicks one; the host opens that thread.
Kits with comments in their own document (M23) keep them; a host that stores
comments itself lists `comment-anchors` and the kit sends `comment.create`
instead of writing a thread.

SDK: Kit UI protocol section 7k; `@kition/kit-ui-protocol` types and checks
(`HOST_SERVICES`, `KitServiceParams`, `KitCommentAnchor`,
`parseServiceParams`, `parseCommentAnchor`), `@kition/kit-host` `mountKit`'s
`services` and `comments` handlers (listing `service:<id>` and
`comment-anchors`, refusing others) plus `showComments` / `locateComments`,
and `@kition/kit-editor`'s `HostConnection.service`, `hasService`,
`onComments`, `activateComment`, `locateComments`.

## 5. Kit integration

The managed-collaboration interfaces are the same for every kit. Kits must
implement the replica, save and host-service contracts they advertise.

## 6. Server integration

1. Verify `ko1.` tokens at `sync/hello` with `kition-open-token`
   (`HostKeys::verify(token, <server id>, now)`): keys
   `[[tenants.open_key]]` `{ kid, public_key, tenant, iss }`, every key bound
   to one tenant and one issuer (on a multi-tenant server too), looked up by
   `(tenant, kid)`; refuse a key set with duplicate `(tenant, kid)`; `aud` is
   the server's configured id. Principal `t:<tenant>:<iss>:<sub>`; scope
   `{ tenant, iss, file, doc_key, role }`; hello answers
   `open: { tenant, iss, file, docKey, role, perms }` and lists
   `KitCollab 1.4` and `open-rooms`. Close at `exp` (as CS7).
2. Store the generation `(tenant, iss, file, doc_key)` on rooms, unique;
   `room/create` from an open connection binds it (RM6), only for an editor
   and only for the seed claim's holder while one holds it.
3. RM2 on every room-addressed request, including `blob_access` for missing
   rooms and `blob/has`.
4. RM2a: bound rooms answer only open-token connections of their
   generation; open sessions never write `room_members` rows (or any stored
   role) that a `ks1` connection of the same principal could inherit.
5. RM1a: `changes/push`, `save/*`, `lease/*`, `presence/set` use the
   connection's token role, never a stored membership; `save.by` is the
   session id.
6. `rooms/list` and `rooms/changed` filtered by the connection's token scope,
   for `ks1` document lists too.
7. `room/resolve` with the seed claim, and `room/resolved` (RM5).
8. Pre-room blobs kept per generation (RM7): references recorded under the
   claim's generation, invisible to other generations' `blob/has`, moved to
   the room on its creation, deleted with the claim after 10 minutes.
9. `save/begin`, `save/end`, `save/changed`; persist the save state; compute
   `authors` from the change log; sign the save receipt
   (`kition_open_token::receipt::sign`, server key published to hosts); bound
   `version` to 256 characters; `must-save` / `closed` on the last leave.
10. Forbid `room/open|link|members|setRole|removeMember|revokeLink` for open
    tokens.
11. Answer `collab-limit` (with `limit`) on `room/join` past the free limit.
12. OT7: `App::revoke_open` closes the live connections a revocation
    by `(tenant, iss, sub)`, `(tenant, iss, file)` or both covers, and
    refuses the open tokens signed before it.

## 7. Host integration

1. Sign open tokens in `server-rs` with `kition-open-token` (`sign` feature)
   from its own session and ACL under its authorization barrier; never take
   user, role, file or tenant from the request. `iss` is `one.<instance id>`
   (no `:`), `aud` the Kition Server's id. Short `exp` (OT4).
2. Keep a `generation` per file and bump it as section 1.3 says; derive
   `doc_key`.
3. Publish its token public keys to Server as
   `{ kid, public_key, tenant, iss }`, one `kid` per key.
4. Mount every file with its own identity provider whose `token()` fetches that
   file's open token, with `collaboration.open: true` so any other token is
   refused (RM8); the embed
   refuses a token for another file than `file.id`, so `file.id` is the
   resource id the token's `file` names. Drop the filename-to-share-link
   registration.
5. Back `storage.replica` with the server (checkpoints, CK1). In
   `storage.write`, verify `save.receipt` with Server's receipt key (SV1:
   `aud` One's `iss`, unexpired, `file` and `doc_key` the file's current
   generation, `seq` not below the last stored) and store one immutable revision
   with the receipt's authors; refuse (`conflict`) a stale `docKey` or
   `expected` (SV3). Treat a save state's `version` as a page's report and
   check it against its own revisions (SV3a).
6. Serve the Kit UI host services (section 4) under UI-V4 to UI-V6: confirm
   rename and save-as in its own dialog, send `people.notify` only after the
   person confirms or with a comment they posted, rate-limit `people.mention`
   and `people.notify`, render anchors and comment text as text only; store
   comment threads with anchors.
7. Return `503` while managed co-editing is unavailable.

## 8. SDK status

The SDK provides these integration points:

- Open tokens: `kition-open-token` and `@kition/sync/openToken`; Kit UI protocol
  `document.permissions` and `document.watermark`.
- Per-file rooms: sync protocol section 3c (`room/resolve`, `room/resolved`, the
  hello `open` scope, bound `room/create`), with the reference server in
  `packages/sync/test/helpers.ts`; `@kition/embed` gives each open-token
  editor its own connection for its file, seeds a room once, reseeds from the
  checkpoint (CK2), and lets a viewer join once an editor made the room. An
  editor opening the room keeps a stored checkpoint of the room's document
  stamped with the file's version, whether or not its page has a record of the
  room; otherwise it stores the room's snapshot brought up to the last save
  (`savedSeq`), never a state older than the file.
- Managed saves: `saveTransition` / `save::transition` and `save/*`; the embed runs
  every save of a managed room through `runSave`, passes
  `{ trigger, seq, authors, docKey, docId }` to `storage.write`, follows
  every session's version, autosaves (SV2), saves `must-save` rooms first
  (SV4), writes the checkpoint after a save (CK1), and reports
  `collab.state.save`.
- Host services: Kit UI protocol section 7k in kit-ui-protocol, kit-host and kit-editor.

Limits: a kit whose replica imports do not mark it unsaved answers a
`must-save` save with nothing to write; the embed asks it again for five
seconds, after which the room stays `must-save` for the next editor. Every
editor asks for its token before connecting, so an open-token editor never
shares a sync-token connection, `collaboration.open` or not; `open: true`
only makes an editor refuse any other token (Kition One sets it on all).
