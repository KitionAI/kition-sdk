# Co-editing: Kition Cloud and Kition Server for integrators

> **Not applicable until Kition One's collaboration is redesigned.** A Kition document is a plain
> model whose changes apply in one order ([data model](../platform/data-model.md)), and the SDK connects no kit replica
> to a room: `@kition/embed`, `@kition/script` and the kit editors do not co-edit. `@kition/sync`
> keeps the protocol's client and types (`SyncClient`, leases, the save state machine, open
> tokens) and `kition-sync-protocol` its Rust types. The text below describes co-editing over a
> merging model and is the starting point for Kition One's design.

People in your web app co-edit a kit document through **Kition Server**, the sync server for the
open protocol `kition-sync/1` ([sync protocol](../platform/reference/sync-protocol.md),
[`KitCollab`](../platform/sets/collab.md)). You never write your own sync server: Kition hosts it
for you as **Kition Cloud** (billed by usage), or you run Kition Server yourself (below). Collaboration is
the only part of the Kition SDK that is paid; embedding, scripts, headless and MCP are free
([licence](README.md#licence)).

Your rooms belong to your **tenant**: a stable name (2 to 40 lowercase letters, digits, and inner
hyphens, such as `acme`). On Kition Cloud, Kition Console registers it and issues its **sync
secret**; running Kition Server yourself, you name it in the server's configuration.

## The server URL

```
wss://sync.kition.ai/v1/t/<tenant>
```

Only your tenant's sync tokens connect there. Pass it to the editor:

```ts
KitionEmbed.mount(element, {
  kit, file, storage,
  identity: {
    user: () => ({ id: me.id, name: me.name }),
    // Asked on every connection: a fresh token from your server.
    token: async () => (await (await fetch('/api/sync-token', { method: 'POST', body: JSON.stringify({ documents: '*' }) })).json()).token,
  },
  collaboration: { server: 'wss://sync.kition.ai/v1/t/acme', room: docId },
})
```

Rooms are private to the tenant: there are no share links (`editor.collab.shareLink()` is
refused). Everyone your server gives a token for a document opens its room: pass the document id
as `collaboration.room`. The first editor of a file without `room` makes the room
(`editor.collab.state.docId` is its id; keep it with the file).

## Sync tokens: your server asks Console

A sync token is short-lived (1 minute to 1 hour) and names one tenant, one person, the documents
it opens (`"*"` or a list of document ids), and the role it grants there (`owner`, `editor`,
`commenter`, `viewer`). **Your server** gets it from Kition Console with your tenant and its
**sync secret**; the sync secret never reaches a browser.

```http
POST https://kition.ai/api/sdk/sync-tokens
Authorization: Bearer <sync secret, kss_…>
Content-Type: application/json

{ "tenant": "acme", "user": { "id": "u-42", "name": "Ann" },
  "documents": ["0192f2d4-7b1a-4c6e-9f10-3a5b6c7d8e9f"], "role": "editor", "ttl": 900 }
```

```json
{ "data": { "token": "ks1.…", "expires": 1800000900, "tenant": "acme",
            "url": "wss://sync.kition.ai/v1/t/acme" } }
```

- `documents` defaults to nothing: say `"*"` for every document of the tenant (needed to make a
  room before its id is known), or list at most 100 ids.
- Your server decides the role: Kition Server gives the person exactly the token's role in the
  tenant's rooms, whatever they had before.
- `401`: the tenant and the secret do not match. `403`: the tenant was revoked. `400`: the
  request is invalid.
- A token is checked when the connection says hello, and the connection closes when the token
  expires; the editor reconnects with a fresh token from `identity.token`.

The example page's server route does this: `examples/embed-app/sync-tokens.mjs`
(`POST /api/sync-token`). With `KITION_SYNC_EXCHANGE`, `KITION_SYNC_SECRET`, and
`KITION_SYNC_TENANT` set it calls Console; without them it signs tokens itself as a self-hosted
server does.

## Running Kition Server yourself

Kition Server runs on your machines (the `kition-server` binary, MySQL 8, and an S3-compatible
bucket). It is not published for download yet, and there is no public container image: Kition
provides it on request. It is free for companies of up to 8
people, with paid Business and Enterprise plans for larger ones, licensed with a `KITION1` licence
([licence format](../platform/licence-format.md)). It starts without one: then at most 8
connections co-edit at once.

```toml
production = true
listen = "0.0.0.0:18300"
public_url = "https://sync.example.com"

[auth]
mode = "tokens"                 # no Kition accounts: only your sync tokens

[selfhost]                      # the tenant your sync tokens are for
tenant = "acme"

[licence]                       # KITION1 licences (a licence and its renewals); or KITION_SERVER_LICENCE_FILE
file = "/etc/kition/licences"

[[tenants.key]]                 # your own key: your server signs the tokens
kid = "acme-sync-1"
public_key = "<base64url Ed25519 public key>"

[storage]
mode = "mysql"                  # URL and keys from KITION_SERVER_MYSQL_URL, KITION_SERVER_S3_*
[storage.s3]
endpoint = "https://s3.example.com"
bucket = "kition-server"
```

- **Your own key**: make an Ed25519 key pair, keep the private key on your token server, list
  the public key under `[[tenants.key]]`. Your server signs tokens in the format above (`ks1.`
  base64url claims, keys sorted, `.` base64url signature over that segment; claims `v`, `typ`
  `"kition-sync"`, `kid`, `iss`, `tenant`, `sub`, `name`, `role`, `docs`, `iat`, `exp`); the
  example's `localSigner` is a working reference. Every key is bound to `selfhost.tenant`.
- **Or Console's keys**: set `tenants.keys_url = "https://kition.ai/api/sdk/sync-keys"`
  and keep exchanging at Console as hosted integrators do.
- Revocation: tokens live an hour at most; remove a key (or let Console rotate its keys) and
  new connections signed with it are refused.
- The licence is checked offline and re-read every hour; without one that applies, the server
  keeps running with at most 8 connections co-editing at once.

Configuration reference and deployment: the Kition Server repository's README ("Integrators" and
"Self-hosting").
