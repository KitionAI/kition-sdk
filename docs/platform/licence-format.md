# Licence format (`KITION1`)

| | |
| --- | --- |
| Status | Version 1 (payload `v: 1`, token prefix `KITION1.`) |
| Licensed products | **Kition One** (`product: "one"`) and **Kition Server** (`product: "server"`). Nothing else Kition makes is licensed: the kits are free in every form |
| Verifier | Rust crate `kition-license`, module `kition1` (`crates/kition-license/src/kition1.rs`), no_std, native and wasm32 |
| Tests | `crates/kition-license/tests/kition1.rs` |
| Issuer | Kition Console (signing service; the private keys live only in its secret configuration) |

One format and one verifier for both products. A licence says who it is for, how much it
covers (One: users; Server: plan) and when it runs. It has **no feature list** (every
installation gets every feature), and it is **not bound to a machine or a version**. It is
checked offline: no activation, no phoning home, no usage reporting.

Kition Cloud needs no licence: it is billed by usage, and an integrator's server exchanges its
tenant's sync secret for sync tokens ([`KitCollab`](sets/collab.md) section 4).

## 1. Token

```text
token     = "KITION1." base64url(payload) "." base64url(signature)   ; RFC 4648 §5, no padding
payload   = canonical JSON of the claims (UTF-8 bytes)
signature = Ed25519(private key of kid, payload bytes)               ; 64 bytes
```

The signature covers the exact payload bytes (the decoded JSON, not its base64 text). The issuer
writes **canonical JSON**: object keys sorted by byte order, no whitespace, integers for numbers.
The verifier never re-serializes; it verifies the bytes as they stand, so a payload in any key
order that was signed verifies. Surrounding whitespace in a pasted token is ignored.

## 2. Claims

| Claim | Type | Meaning |
| --- | --- | --- |
| `v` | number | Payload version, `1`. Another version is refused (`version`) |
| `lid` | string | Licence id, unique per issued licence; a renewal or change is a new `lid`. Products key their records and dismissed banners on it. 1 to 64 of `[A-Za-z0-9_-]` |
| `kid` | string | The signing key's id; verified with the compiled-in public key of that id. 1 to 64 of `[A-Za-z0-9_-]` |
| `product` | `"one"` \| `"server"` | The product licensed |
| `customer` | `{ org: string, email: string }` | The licensee's organisation and contact; both non-empty |
| `seats` | number | **One only, required**: licensed users in total, the 8 free users included (a 33-person team: `33`), so more than 8. Must be absent for Server |
| `tier` | `"free"` \| `"business"` \| `"enterprise"` | **Server only, required**: the plan. `free` is the yearly free key for companies of up to 8 employees, open-source projects, and development and test. Must be absent for One |
| `employees` | string, optional | **Server only**: the company's self-reported employee band (`"1-8"`, `"9-200"`, `"201+"`), informational |
| `issued_at` | number | Unix seconds |
| `starts_at` | number | Unix seconds; before this the licence does not apply yet |
| `expires_at` | number | Unix seconds; the term ends here and grace begins |
| `grace_days` | number, optional | Days after `expires_at` that still run as licensed; default `14` |
| `env` | `"prod"` \| `"test"` | `test` licences are for development, CI and staging only |

A payload with any other field (a `features` field included), a missing required field, the
other product's field, One `seats` of 8 or fewer (no licence is needed for 8), a `lid` or `kid`
outside its character set or length (no surrounding whitespace), empty `org` or `email`,
`issued_at` after `expires_at`, or `starts_at` not before `expires_at` is `malformed`. A token
longer than 8 KiB is `malformed` before it is decoded.

Example payload (canonical):

```json
{"customer":{"email":"it@example.com","org":"Example & Co"},"env":"prod","expires_at":1831536000,"grace_days":14,"issued_at":1799913600,"kid":"prod-1","lid":"lic_one_1","product":"one","seats":33,"starts_at":1799913600,"v":1}
```

## 3. Verification

`verify_pinned(token, product)` (the compiled-in keys) or `verify(token, keys, product)`; the
first failure is the answer, with its code:

1. `KITION1.` prefix, two base64url segments, the payload valid claims (`malformed`).
2. `v` is 1 (`version`).
3. A compiled-in key has `kid` (`unknown-key`); the signature verifies, strict Ed25519
   (`signature`).
4. The key's environment is the payload's `env`: a test key cannot sign a production licence
   (`key-env`).
5. A build without the `test-licences` cargo feature refuses `env: "test"` licences with a clear
   message (`test-licence`: "this is a test licence; production builds accept only production
   licences"). The feature is off by default and never in a release; with it, a build also holds
   the test public keys and accepts both environments. Which licences a build accepts is fixed
   at compile time, not by a runtime argument.
6. `product` is the running product (`product`). One's built-in Server is handed One's licence
   and verifies it as `one`.

A licence that passes is a `Verified` value (read-only; only the verifier makes one). `decode`
reads a token without checking it and gives an `Unverified` value, for showing what a pasted
token claims; it cannot be given to `status`. Dates are not checked here: an expired licence
still verifies, so the product can compute grace.

## 4. Status

`status(product, licences, now, used)` is pure and offline. `licences` are the verified licences
installed (none, one, or a licence and its renewals); `used` is what is in use now: One, active
users who are not guests (deactivated members do not count); Server, concurrent co-editors.
Licences for another product are ignored.

**Which licence applies**: of those started (`starts_at ≤ now`) and not past grace, the one with
the latest `expires_at`; its seats are the limit. **Renewals**: the term runs on through any
licence that starts by the end of the applying one's grace and expires later, so a renewal
installed early (its `starts_at` at the old expiry, or overlapping, or within the grace) stops the
reminders and never drops a paying customer to the free rule. With none applying, the term is
`Expired` if a licence ran out, else `Free`. A renewal starting after the old one's grace leaves a
gap that runs under the free rule.

Term (time only):

| Term | When |
| --- | --- |
| `Free` | No licence applies and none ran out (none, or not started yet) |
| `Licensed` | `now < expires_at`, before the first reminder |
| `Expiring { days }` | `days` (whole days, rounded up) to `expires_at` ≤ the first reminder: One reminds at **60, 30 and 7** days (`reminder_stage()` gives the stage, one dismissible banner per `lid` and stage); Server from **30** days |
| `Grace { days_left }` | `expires_at ≤ now < expires_at + grace_days` days; runs as licensed |
| `Expired` | No licence applies and one is past grace: the free rule again |

Limits:

| | `limit` (users / co-editors) | `collab_limit()` |
| --- | --- | --- |
| One, licence applies (Licensed, Expiring, Grace) | `seats` | none (unlimited) |
| Server, licence applies (any tier, `free` included) | none | none (unlimited) |
| No licence, or past grace (either product) | 8 | **8** concurrent co-editors |

`state()` gives the one headline state, most urgent first: `Expired`, `Grace`, `OverSeats { used,
limit }` (when `used > limit`), `Expiring`, then `Licensed` or `Free`. **Over seats is a reminder
only**: nothing is blocked or made read-only for it, and nothing is reported. The only enforcement
is `collab_limit()`, applied by Kition Server (standalone or built into One) when a co-editor joins
a room: the ninth is refused co-editing; opening, editing, saving and exporting still work.
Deleting a licence does not help: no licence and an expired one are the same state.

## 5. Keys and rotation

- Console signs with one Ed25519 key pair per environment at a time, each named by `kid`
  (`prod-…`, `test-…`). The private keys are secrets: in Console's secret configuration or on
  the owner's machine, never in Git.
- The public keys are compiled into the verifier, by `kid` with their `env`: `kition1::PROD_KEYS`
  always, `kition1::TEST_KEYS` only with the `test-licences` feature, so a release binary holds no
  test key. Both are empty until the owner generates the production and test key pairs.
- Rotating: make a new pair with a new `kid`, compile its public key into a release, then switch
  Console to it. Keep the old public key until every licence it signed is past grace, then remove
  it in a later release. There is no revocation list (it would need a network); a leaked licence
  is answered by the agreement and by not renewing it.

## 6. Known limits

Recorded, not handled in version 1:

- **Clock rollback.** Status uses the machine's clock; setting it back extends a licence. The
  format is an offline honour system backed by the agreement. A later version may keep a
  high-water mark of the latest time seen and judge by it.
- **No cap on `grace_days`.** The verifier takes whatever Console signed. Console must write 14;
  a cap in the verifier can come later.
- **Key pairs per format.** The older SDK key format and `KITION1` must be signed with separate
  key pairs (different `kid`s and seeds), so a key of one can never be read as the other.
