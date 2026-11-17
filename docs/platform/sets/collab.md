# `KitCollab 1.3`: co-editing

For integrators who let people co-edit kit documents, comment on them, and
sync them across their devices. The client is `@kition/sync`; the server is
Kition Server, over the open sync protocol `kition-sync/1`
([sync protocol reference](../reference/sync-protocol.md)).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

## 1. Versions

| Version | Adds |
| --- | --- |
| `KitCollab 1.0` | Shared editing over `kition-sync/1` with presence, per-author undo (M12), leases (M21), and conflict objects (M22) |
| `KitCollab 1.1` | Comments (M23), the `commenter` role, and member administration (sync protocol 1.6) |
| `KitCollab 1.2` | Sync across a person's devices (sync protocol 1.9, section 3b): the document list (`rooms/list`, `rooms/changed`), private rooms, and the "sync all my documents" account setting (off by default), under rule CS4 |
| `KitCollab 1.3` | Tenant rooms for integrators' products: tenant tokens, CS5 to CS7 (section 4) |
| `KitCollab 1.4` | Managed co-editing (section 4a): host-signed open tokens (OT1 to OT5) for exactly one file, one room per file generation, and the shared save state ([managed-collab.md](../managed-collab.md)) |

The M rules are in [`KitModel 1.0`](model.md). A sync server lists the sets
it serves in `sync/hello` (CS2, [index](../index.md)).

## 2. Rules

- **CS4** Syncing a document to a person's devices (`KitCollab 1.2`)
  attaches a room to the replica a device already has, never converts or
  re-imports it; a device that opens a listed document makes a new local
  replica of the same document (its `docId`) from the room's state, and
  every device keeps a complete local replica, so turning sync off, a plan
  ending, or the server going away never strands a document.

## 3. Agents in co-edited documents

An agent's edits reach a room as the changes of the person who runs it, and
its drafts stay on that person's device until merged (A15); the agent shows
in presence as a peer of its own (A20). See
[`KitAgent 1.4`](agent.md).

## 4. Co-editing in an integrator's product

Integrators co-edit on Kition Cloud (hosted), or on Kition Server they run themselves
(section 5). They never write a sync server of their own. A server that
serves this section lists `KitCollab 1.3` in `sync/hello` (CS2).

**Connecting.** The embed's `collaboration.server` is
`wss://sync.kition.ai/v1/t/<tenant>` (the shared `/v1/sync` also accepts
tenant tokens), and the identity provider's `token` answers a fresh sync
token for each connection ([`KitEmbed`](embed.md) EM1, EM3). Kition gives you
`<console-url>`, the Kition Console address, with your tenant and its sync secret.

**Rooms.** The first editor mounts without `room`: the embed creates the
room, and its id is `collab.state.docId` (the document's KDM id). Store it
with your file and pass it as `collaboration.room` to every later editor of
that file, yours and your colleagues'. Tenant rooms have no share links. A
token for `documents: "*"` covers every document of the tenant, and so can
create rooms; a token that lists ids covers only those.

**Getting a token.** Only the integrator's server asks for tokens, never a
page:

```text
POST <console-url>/api/sdk/sync-tokens        (Kition Console)
Authorization: Bearer <sync secret>
{ tenant, user: { id, name }, documents: "*" | [uuid, ... up to 100],
  role: "owner" | "editor" | "commenter" | "viewer", ttl: 60..3600 (default 900) }
→ { data: { token, expires, tenant, url } }
```

- Kition Console issues the tenant's sync secret when it registers the tenant:
  `kss_` + base64url(HMAC-SHA256(exchange secret, `"kition-sync-secret\n"` +
  the tenant)). It MUST stay on the integrator's server. No licence is
  involved: Kition Cloud is billed by usage.
- Errors: `401` the tenant and the secret do not match; `403` the tenant was
  revoked; `400` a bad request; `503` the exchange is not configured.
- `GET <console-url>/api/sdk/sync-keys` answers the public keys tokens are signed with:
  `{ data: { keys: [{ kid, publicKey, issuer }] } }`.

**Tokens.** `ks1.` + base64url(claims JSON, keys sorted) + `.` +
base64url(Ed25519 signature over that segment). Claims:
`{ v: 1, typ: "kition-sync", kid, iss, tenant, sub, name, role, docs: "*" | [ids], iat, exp }`.

**What the server enforces.**

- **CS5** A server verifies a token offline against its configured keys (a
  key bound to a tenant signs only for it) and refuses `v` other than 1, a
  `typ` other than `kition-sync`, `exp - iat` over 3600 seconds, `iat` more
  than 60 seconds ahead, `now >= exp`, `docs` empty or over 100, and a bad
  `tenant` or `sub`.
- **CS6** The connection's principal is `t:<tenant>:<sub>` with exactly the
  token's role. It reaches only rooms its tenant owns and the token's
  documents; rooms it creates are private (an editor or owner on a named
  document). `room/open`, `room/link`, `room/setRole`, `room/removeMember`,
  and `room/revokeLink` answer `forbidden`: tenant rooms have no share links,
  so the embed's `collab.shareLink()` answers `read-only` in them
  ([`KitEmbed`](embed.md) EM20). Kition accounts never reach
  tenant rooms.
- **CS7** The server closes the connection at `exp`. Revoking access is key
  rotation plus short token lifetimes.

## 4a. Managed co-editing: open tokens (`KitCollab 1.4`)

A host that owns files and permissions (Kition One, an integrator's
embed server) signs an **open token** for each editor it opens instead
of asking Console for a sync token: `ko1.` + base64url(claims JSON) + `.` +
base64url(Ed25519 signature over that segment). Claims:
`{ v: 1, typ: "kition-open", kid, iss, aud, tenant, sub, name, file, version,
doc_key, perms: { edit, comment, download, share, export }, watermark:
{ text } | null, iat, exp, jti? }`. The kit host reads `perms` and
`watermark` (Kit UI protocol `document.permissions`, `document.watermark`);
Kition Server takes the token as the connection's credential, verifies it
offline against the host's keys (each bound to one tenant and one issuer,
looked up by tenant and `kid`; `aud` names the server), and grants `editor` (`edit`), `commenter`
(`comment` alone) or `viewer`, never `owner`, on that one file's room
(OT1 to OT5 in [managed-collab.md](../managed-collab.md) section 1). There is
no wildcard: a token names one `file` and one `doc_key`. `kition-open-token`
(Rust) and `@kition/sync/openToken` (TypeScript) sign and verify them, held to
the same vectors.

**Rooms.** The server keeps one room per `(tenant, file, doc_key)` and the
token reaches only that one ([sync protocol](../reference/sync-protocol.md)
section 3c). The embed mounts without `collaboration.room`: before the kit
opens, it asks `room/resolve`; with a room, it opens the room's document; with
none, one editor takes the seed claim and seeds the room, from the replica
the host keeps for this version of the file when there is one (so the
document keeps its id after the server lost the room), else from the kit's
replica of the file; other editors wait for it. A viewer never seeds: it
sees the saved file until an editor has opened it. Each open-token editor
has a connection of its own identity provider, so a page can hold an editor
of one file and a viewer of another ([managed-collab.md](../managed-collab.md)
section 2).

## 5. Running Kition Server

An integrator runs Kition Server (free for companies of up to 8 people;
Business and Enterprise plans are paid, with a `KITION1` licence,
[licence-format.md](../licence-format.md)) with token authentication
(`auth.mode = "tokens"`):

- its tenant as `[selfhost] tenant`; its licences in `[licence] file`,
  verified offline; without one that applies, at most 8 connections co-edit
  at once;
- token keys as `[[tenants.key]]` entries (`kid`, `public_key`, `tenant?`)
  and/or a `[tenants] keys_url` (HTTPS in production) refreshed every
  `refresh_secs` (default 600); every key is bound to `selfhost.tenant`.

The rules of section 4 apply unchanged.

## 6. Conformance

A server conforms when it passes the sync protocol's rules
([sync protocol reference](../reference/sync-protocol.md) section 10) for
the versions it lists; a kit conforms when it passes the convergence suite
([kit levels](../kits/levels.md), L6). See
[conformance.md](../conformance.md).
