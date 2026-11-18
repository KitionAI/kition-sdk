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
| `kition-<version>-<platform>.tar.gz` | The `kition` command line for one platform: `kition` (`kition.exe` on Windows) and `LICENSE` ([cli.md](cli.md)) |
| `kition-<kit>-<kitVersion>-<platform>.tar.gz` | One kit version for one platform, as `kition` installs it: `kit.json` and `kition-<kit>` (`.exe` on Windows). Only kit versions no earlier release published |
| `kits-index.json` | The kit index ([`kits-index.schema.json`](../../schemas/kits-index.schema.json)): every published kit version still downloadable, from this release and the earlier ones |
| `install.sh`, `install.ps1` | The `kition` installers for macOS and Linux, and for Windows |
| `kition-sdk-<version>.json` | The release manifest: the SDK commit; each kit's version, package URL and SHA-256, and the tag and commit its executable was built from; each platform's bundle and every executable in it, with its size, SHA-256 and the kit version it answers `kit.initialize` with; each platform's `kition` archive (`cli`), the kit archives this release adds (`kitArchives`), the index (`index`) and the installers, each with its size, SHA-256 and URL; each schema with its URL |
| `<name>.schema.json` | The SDK's schemas (`kit.schema.json`, `mcp-tools.schema.json`, `kit-process-protocol.schema.json`, `kits-service.schema.json`, `kits-index.schema.json`), each at a versioned address |
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
from a kit index into a store under `~/.kition` when it is needed ([cli.md](cli.md)). Its
archives, the kit archives and the index are assets of the same release (below).

## `kition` and its installers

`kition-<version>-<platform>.tar.gz` holds `kition` built for the platform, with no kit;
`kition --version` names `<version>`. `install.sh` and `install.ps1` download the one for their
machine from the latest release (or a version given), check it against `SHA256SUMS`, and install
it as `~/.kition/bin/kition` ([cli.md](cli.md#installing-it)):

```sh
curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh
```

The npm package `@kition/kits-mcp-<platform>` carries the same `kition` as `bin/kition`, and
`@kition/kits-mcp` starts it as `kition mcp`. The executables a release ships, `kition` among them,
are built with the workspace's `dist` profile (LTO, one code unit, symbols stripped).

## Kit archives and the kit index

`kition` reads `https://github.com/KitionAI/kition-sdk/releases/latest/download/kits-index.json`:
the index of whichever release is the latest. That index must list every kit version that can
still be downloaded, while a release builds only the kit versions Kition's kit lock pins now, and a
published release never changes. So each release's index carries the previous one forward
(`tools/release-archives.mjs`):

- The release workflow downloads the latest release's `kits-index.json` and starts from it. A
  latest release without one (one made before `kition`) starts the index afresh; a release it
  cannot read stops the run, so a version is never dropped by accident.
- Every entry of the previous index stays as it was, with its absolute address in the release
  that holds the archive: an archive is published once, by the first release that builds its kit
  version for its platform, and every later index points there.
- A kit version and platform this release builds that the index does not list yet becomes an
  archive of this release, `kition-<kit>-<kitVersion>-<platform>.tar.gz`, listed at its absolute
  address. One the index lists already gets no new archive; the one published first stays. Its
  Kit Process Protocol must be the same as this build's, or the run stops: a changed kit is a new
  kit version.
- Only kits in `published-kits.json` enter the index, and a kit taken off that list leaves it
  (its archives stay in the releases that published them).
- A kit's id, name and extensions follow the kit.json of its newest version.

The index is checked against its schema, and the release manifest checks that it lists every kit
version the bundles hold, for every platform, and that every kit archive in the release is one it
names, with the size and SHA-256 it gives.

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
executables built there; it publishes nothing. `tools/release-archives.mjs` makes the `kition` and
kit archives and the index from a folder of `bin-<platform>/` folders, each holding `kition`, the
kit executables, their `handshakes.json` (`node tools/kit-handshake.mjs --record <folder>`) and
`kits/<kit>/kit.json`; `--previous <kits-index.json>` carries an index forward, and `--base-url`
and `--version` name a rehearsal's own release:

```sh
node tools/release-archives.mjs --bin <folder> --out <release folder> \
  --previous kits-index.json --base-url http://127.0.0.1:8000/releases/download/sdk-v0.3.0
```

Served over HTTP as `<url>/releases/download/sdk-v<version>/` and `<url>/releases/latest/download/`,
such a folder is a release `install.sh` installs from (`KITION_RELEASES_URL=<url>/releases`) and
`kition` installs kits from (`KITION_INDEX=<url>/releases/latest/download/kits-index.json`). Supply a KHP specification with
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
