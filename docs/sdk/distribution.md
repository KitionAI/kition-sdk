# Distribution: the SDK release and its bundles

Each Kition SDK version is a GitHub Release of
[KitionAI/kition-sdk](https://github.com/KitionAI/kition-sdk/releases), tagged
`sdk-v<version>`, and the same version of every public `@kition/*` package on npm. Both come from
one build in the repository's release workflow (`.github/workflows/release.yml`). Downloading
them needs no account, no token and no Rust.

## What a release holds

| Asset | What |
| --- | --- |
| `kition-sdk-<version>-<platform>.tar.gz` | The SDK bundle for one platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc), `win32-x64` |
| `kition-sdk-<version>.json` | The release manifest: the SDK commit; each kit's version, package URL and SHA-256, and the tag and commit its executable was built from; each platform's bundle and every executable in it, with its size, SHA-256 and the kit version it answers `kit.initialize` with; each schema with its URL |
| `<name>.schema.json` | The SDK's schemas (`kit.schema.json`, `mcp-tools.schema.json`, `kit-process-protocol.schema.json`, `kits-service.schema.json`), each at a versioned address |
| `SHA256SUMS` | Every asset above, in `sha256sum -c` form |

Every asset also has a build provenance attestation:
`gh attestation verify <file> --repo KitionAI/kition-sdk`.

A bundle unpacks to one folder:

```text
kition-sdk-<version>-<platform>/
  manifest.json        SDK version, source commit, platform; every file with size and SHA-256
  SHA256SUMS           sha256sum -c format, every file
  CHANGELOG.md  LICENSE
  npm/                 @kition/embed, @kition/script, @kition/sync, @kition/kdm, @kition/embed-server tarballs
  kits/                kit packages (kition-<kit>-<version>.tgz), as pinned in Kition's kits.lock.json,
                       and kits/<kit>/kit.json, each package's manifest
  bin/<platform>/      kition-kits, kition-kits-mcp and kition-<kit> for each kit (.exe on Windows)
  docs/                this guide (docs/sdk), the platform documents, the schemas, and the Kit
                       Harness Protocol (KHP) under docs/khp/
```

Each kit executable in `bin/<platform>/` is built from the tag of its kit package
(`package-v<version>` in the kit's repository) and was started on its platform before the release
was made: it answered `kit.initialize` with its package's kit id and version and the SDK's Kit
Process Protocol version, or there is no release.

The `kition` command line takes kits one at a time instead: it downloads each kit's archive
from a kit index into a store under `~/.kition` when it is needed ([cli.md](cli.md)).

## Getting one

```sh
v=0.2.0 p=darwin-arm64
base=https://github.com/KitionAI/kition-sdk/releases/download/sdk-v$v
curl -fsSLO "$base/SHA256SUMS"
curl -fsSLO "$base/kition-sdk-$v.json"
curl -fsSLO "$base/kition-sdk-$v-$p.tar.gz"
grep -E " (kition-sdk-$v.json|kition-sdk-$v-$p.tar.gz)\$" SHA256SUMS | shasum -a 256 -c
tar -xzf "kition-sdk-$v-$p.tar.gz"
cd "kition-sdk-$v-$p" && shasum -a 256 -c SHA256SUMS
```

To pin a version, record the SHA-256 of the bundle, or of each executable you use, from
`kition-sdk-<version>.json` (`platforms.<platform>.binaries`).

Using it:

```sh
npm install ./npm/kition-embed-<v>.tgz              # or the same version from npm
mkdir -p public/kits && tar -xzf kits/kition-note-<v>.tgz -C public/kits   # → public/kits/note-ui/
bin/<platform>/kition-kits-mcp --workspace <folder> --kits-dir kits         # the kits' tools over MCP
bin/<platform>/kition-kits serve --kits-dir kits                            # headless.md
```

`kition-kits` and `kition-kits-mcp` find each kit's executable in `bin/<platform>/` beside the
bundle's `kits/`. A host that starts the kit executables itself (Kit Process Protocol, H11) can
check each one against the SHA-256 the release manifest names for it.

`@kition/script` depends on `@kition/kdm` and `@kition/sync` (in the bundle) and `loro-crdt` (public
npm). `@kition/embed` has no dependencies. `@kition/embed-server` depends on `@kition/sync` and
`@kition/embed`.

## Versions never change once published

A published release, its tag and its assets are never deleted, replaced or moved, and a version
number is never used twice; the same holds for the kit packages (`package-v<version>` in each
kit's repository) and the npm packages. A correction is a new version. The repositories turn on
GitHub's immutable releases, which enforces this for releases.

## Making one locally

`node tools/sdk-bundle.mjs` (`pnpm sdk:bundle`) assembles a bundle on a developer machine with the
executables built there; it publishes nothing. Supply a KHP specification with
`--standard <folder>` (or `KIT_STANDARD_DIR`; a clone of
[kitharness/khp](https://github.com/kitharness/khp)) and a kit lock with `--lock <file>` (or
`KITION_KITS_LOCK`; Kition's `kits/kits.lock.json`). The kit packages are downloaded from their
public release URLs and checked against the size and SHA-256 the lock pins.

```sh
pnpm sdk:bundle -- --archive                       # all kits in sdk.json, no executables
pnpm sdk:bundle -- --kits note --kit-assets <folder-with-tarballs>
KITION_KITS_MCP=<kition-sdk>/target/release/kition-kits-mcp \
KITION_KIT_NOTE_BINARY=<kition-note>/target/release/kition-note \
  pnpm sdk:bundle -- --kits note                   # with executables, for this machine's platform
```

A kit's headless executable builds from its repository with `cargo build --release -p
kition-<kit>`; the fonts it embeds come from the kit's `scripts/fetch-fonts.sh` (its
`docs/development.md`, "Fonts").
