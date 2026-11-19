# Getting the SDK

Kition's kits reach an integrator as one versioned **Kition SDK bundle**,
delivered by Kition (the delivery channel, a private registry or a Kition
Console download, is not decided yet). The bundle is free to use in every form,
headless on your servers included, in development and in production, with no
licence key. Only collaboration is paid: running Kition Server yourself
([licence format](licence-format.md)) or co-editing on Kition Cloud.

## 1. What a bundle holds

```text
kition-sdk-<version>/
  manifest.json        SDK version, source commit, platform; every file with size and SHA-256
  SHA256SUMS           sha256sum -c format, every file
  CHANGELOG.md  LICENSE
  npm/                 @kition/embed, @kition/script, @kition/sync, @kition/kdm, @kition/embed-server tarballs
  kits/                kit packages, kition-<kit>-<version>.tgz
  bin/<platform>/      kition-kits-mcp and the kition-<kit> headless executables
  docs/                the SDK guide, and this standard as docs/standard/
```

## 2. Using it

```sh
cd kition-sdk-<version> && shasum -a 256 -c SHA256SUMS

# The npm packages: install the tarballs, or publish them to your own registry
npm install ./npm/kition-embed-<v>.tgz
npm publish ./npm/kition-embed-<v>.tgz --registry <your-private-registry>

# A kit package: unpack it where your kit origin serves it
mkdir -p public/kits && tar -xzf kits/kition-note-<v>.tgz -C public/kits   # → public/kits/note-ui/
```

- **Kit packages** are self-contained (editor, engine, fonts). Serve each
  from an origin other than your page's, with the policy of
  [the embed reference](reference/embed.md) section 3, and pass its base URL
  as the embed's `kit.url` (`https://kits.example.com/note-ui/`).
- **Headless executables** (`bin/<platform>/kition-<kit>`) and `kition-kits-mcp`
  run on your servers; give the executables to `kition-kits-mcp` as
  [`KitAgent 1.4`](sets/agent.md) section 8.1 says. With `--sandbox`
  (`kition-kits-mcp` and `kition-kits serve`) each kit runs under the
  operating system's sandbox on macOS and Linux, with no file but its own
  and no network ([host contract](kits/host.md) H14); it is off by default
  for now and meant to become the default.
  Both programs also accept `--call-timeout-secs` (default 120), `--idle-timeout-secs`
  (default 600), and optional `--memory-limit-mib` (Linux/macOS; refused elsewhere).
  See [process controls](../sdk/process-control.md) for save/restart behaviour, FIFO calls,
  progress, cancellation and the remaining platform limits.
- **Dependencies.** `@kition/script` depends on `@kition/kdm` and `@kition/sync`
  (both in the bundle) and `loro-crdt` (public npm). `@kition/embed` has no
  dependencies. `@kition/embed-server` depends on `@kition/sync` and
  `@kition/embed`.

## 3. Versions

- The SDK has one version, recorded in `manifest.json` and in each package's
  `kitionSdk` field. Each npm package keeps its own semver inside it, and
  each kit package is the version the bundle pins.
- The capability sets have their own versions ([index](index.md) section 3.2).
  The SDK's minor version moves when a set gains members, its major version
  when one breaks.
- Test for capability sets at run time (`supports('KitCollab 1.3')`), never
  for an SDK or package version.

## 4. The kits

The kits in SDK 0.5.1 (its `sdk.json`), with the file types they open
(`formats` in each kit's `kit.json`) and what their editors and agents offer.
A bundle's `manifest.json` names the version of each kit it holds.

| Kit | Opens | Drafts (A12) and object-model tools (A16) | Checks (A21) |
| --- | --- | --- | --- |
| `kit.note` | `.md`, `.markdown` | yes | yes |
| `kit.table` | `.ktable` | yes | yes |
| `kit.html` | `.html`, `.htm` | no | yes |

- An editor of a kit on the Kit Data Model lists the Kit UI capabilities
  `model`, `draft`, `draft-model`, and `check`.
- Headless drafts beside a file (A27) compare object by object when the kit
  declares an object model; other kits compare summaries and renderings.
- `published-kits.json` is the publication allowlist used by artifact sync tools.
  Kits outside it are supplied separately by their authors.
