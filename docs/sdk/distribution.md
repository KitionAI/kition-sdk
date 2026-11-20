# Distribution: the SDK release and its bundles

Each Kition SDK version is a GitHub Release of
[KitionAI/kition-sdk](https://github.com/KitionAI/kition-sdk/releases), tagged
`sdk-v<version>`, and the same version of every public `@kition/*` package and of `kition` on
npm. Both come from one build in the repository's release workflow
(`.github/workflows/release.yml`). Downloading them needs no account, no token and no Rust.

## What a release holds

| Asset | What |
| --- | --- |
| `kition-sdk-<version>-<platform>.tar.gz` | The SDK bundle for one platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc 2.17 or later), `win32-x64` |
| `kition-<version>-<platform>.tar.gz` | The `kition` command line for one platform: `kition` (`kition.exe` on Windows) and `LICENSE` ([cli.md](cli.md)) |
| `install.sh`, `install.ps1` | The `kition` installers for macOS and Linux, and for Windows |
| `kits-index.json` | A snapshot of the kit index as of the release, for the `kition` versions released before the branch `kits-index` existed (0.3.0, 0.4.0); not the index `kition` reads ([below](#the-snapshot-in-each-release)) |
| `kition-sdk-<version>.json` | The release manifest: the SDK commit; each kit's version, package URL and SHA-256, and the tag and commit its executable was built from; each platform's bundle and every executable in it, with its size, SHA-256 and the kit version it answers `kit.initialize` with; each platform's `kition` archive (`cli`), the kit index snapshot (`index`) and the installers, each with its size, SHA-256 and URL; each schema with its URL |
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
from a kit index into a store under `~/.kition` when it is needed ([cli.md](cli.md)). Its own
archives are assets of the release; the kit archives are assets of each kit's repository, and the
index is gathered from them (below). A release holds no kit archive; its `kits-index.json` is
only a snapshot of that index (below).

## `kition` and its installers

`kition-<version>-<platform>.tar.gz` holds `kition` built for the platform, with no kit;
`kition --version` names `<version>`. `install.sh` and `install.ps1` download the one for their
machine from the latest release (or a version given), check it against `SHA256SUMS`, and install
it as `~/.kition/bin/kition` ([cli.md](cli.md#installing-it)):

```sh
curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh
```

The npm package `@kition/cli-<platform>` carries the same `kition` as `bin/kition`, and the npm
package `@kition/cli`, which depends on every one of them as an optional dependency, gives the
`kition` command that starts it (`npm install -g @kition/cli`, `npx -y @kition/cli <command>`;
[cli.md](cli.md#installing-it)). The executables a release ships, `kition` among them,
are built with the workspace's `dist` profile (LTO, one code unit, symbols stripped).

## Linux: the glibc floor

The Linux executables of a release (`kition`, `kition-kits`, `kition-kits-mcp` and every kit's)
run on glibc 2.17 and later: CentOS 7, RHEL 7, Debian 8, Ubuntu 14.04 and every newer glibc
distribution, on x64 and arm64. The release workflow links them against glibc 2.17 with
[cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) (`--target <triple>.2.17`) rather
than against its build machine's glibc, and fails the build when one of them needs a newer
`GLIBC_` symbol version (`node tools/glibc-floor.mjs --max 2.17 <file>...`, which reads each
file's ELF version needs). Linux with the musl C library (Alpine) is not supported.

## Kit archives and the kit index

Each kit repository publishes its own archives. A kit's `package-v<version>` Release (in
`KitionAI/kition-<kit>`, made by the kit's Package workflow: Kition's `docs/kits.md`, section 4b)
holds, beside the kit's package:

- `kition-<kit>-<version>-<platform>.tar.gz` for each platform: `kit.json` and `kition-<kit>`
  (`.exe` on Windows) at its top, as `kition kit install` unpacks it;
- `kits-index-<kit>-<version>.json`, the index fragment: a kit index of that one kit version, with
  each archive's absolute address in the Release, size and SHA-256. It is published once and never
  replaced, so it can list fewer platforms than the Release holds (a platform added by a later
  run).

So a kit version is installable as soon as its Release has its archives and fragment; no SDK
release is needed.

`kition` reads the index gathered from those Releases,
`https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json`: the one file
of the branch `kits-index` of this repository. `.github/workflows/kits-index.yml` makes it, by hand
and every hour, with `tools/kits-index.mjs`:

- For every kit Kition's `kits/modules.json` names, it lists the repository's `package-v*`
  Releases and reads each one's fragment. The kit repositories are the only source: nothing is
  carried from an earlier index, and every kit is in it, not only those in
  `published-kits.json` (the kits this SDK documents and bundles).
- A Release without a fragment is skipped and named in the run's report. An archive the Release
  holds that its fragment does not list is added from the Release's asset metadata: its size, and
  the SHA-256 GitHub gives as its digest (or, without one, from downloading it).
- A fragment that is not an index of that one kit version, or that names an archive the Release
  no longer holds, or at another address, size or SHA-256 than the Release's, stops the run; so
  does a repository whose Releases cannot be listed or a fragment that cannot be read. A failure
  never publishes a smaller index.
- A kit's id, name and extensions come from its newest version's fragment; the extensions it only
  views (its `kit.json`'s `view` formats, which fragments do not carry) come from the `kit.json` at
  that version's tag, listed as the kit's `views`, so a gateway opens them read-only before the kit
  is installed. When that `kit.json` cannot be read the kit has no `views` and the run says so.
  Each version keeps the Kit Process Protocol its fragment declares. The index is checked against
  its schema and written in a fixed order, so the same Releases give the same bytes.
- An index with no kit is never published: the one published stays.
- The workflow commits the index on the branch only when its bytes changed, without force, so the
  branch's history is the index's history.

**This is the one mutable thing the repository publishes.** Everything else, releases and their
assets among them, never changes once published (below); the index changes whenever a kit
repository publishes a version. It is a branch rather than a release asset because this
repository's releases are immutable.

To run it by hand (read-only; `GH_TOKEN`, when set, is used for the GitHub API):

```sh
node tools/kits-index.mjs --dry-run                       # what the index would hold
node tools/kits-index.mjs --out kits-index.json \
  --previous <published kits-index.json>                  # write it; name what enters and leaves
```

### The snapshot in each release

The index `kition` reads is the one on the branch `kits-index`, above. Each SDK release also
carries `kits-index.json`: the same index, gathered by `tools/kits-index.mjs` in the release
workflow when the release is made, and never changed afterwards. It is there for the `kition`
versions released before the branch existed, 0.3.0 and 0.4.0, whose default index is
`https://github.com/KitionAI/kition-sdk/releases/latest/download/kits-index.json`: through it
they find the kit versions published up to the latest release, not those published since. Upgrade
`kition`, or point one of them at the branch with
`KITION_INDEX=https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json`,
to see every version.

The release workflow gathers the snapshot itself rather than copying the branch's file, so a
release does not depend on the branch. A failure, or a gathered index with no kit, stops the
release: none goes without it. `tools/sdk-release.mjs` checks it against
`schemas/kits-index.schema.json`, names it in the release manifest (`index`) and in `SHA256SUMS`,
and refuses any other `kits-index*.json` beside it; kit archives are still refused.

## Getting one

```sh
v=0.5.2 p=darwin-arm64
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
kit's repository), their archives and index fragments, and the npm packages. A correction is a
new version. The repositories turn on GitHub's immutable releases, which enforces this for
releases. The kit index on the branch `kits-index` is the one exception (above).

## When a release stops half-way

The release workflow builds and checks everything before it publishes anything. It then makes
the GitHub Release as a draft (no tag yet; it can still be deleted), publishes the npm packages
(a version published on npm can never be published again, so this is the step that cannot be
undone), and publishes the draft last. On npm the scoped `@kition/*` packages go first, then
`@kition/cli-<platform>`, then `kition`, which depends on them.

- **It stopped before npm, or part-way through npm** (a refused token, the registry down): run it
  again from the same commit, best with "Re-run failed jobs", which keeps the executables already
  built. The draft is replaced, every npm version already published is skipped, and the rest is
  published. A draft from another commit stops the run: npm may hold packages published from that
  commit; run again from it, or delete the draft when npm holds no package of the version.
- **The release is published, and npm lacks packages of its version** (`kition`'s first publish
  refused by an `NPM_TOKEN` that may only publish `@kition/*`, for example): give the token the
  right, then run the workflow from the tag `sdk-v<version>` ("Use workflow from", the tag) with
  the same `kition_commit`. The run sees the release published from that commit and publishes
  only what npm lacks: no draft, no bundle, no new release. The `@kition/cli-<platform>` packages
  carry the `kition` of the release's own `kition-<version>-<platform>.tar.gz`, checked against
  its `SHA256SUMS`, not a new build. From any other commit the run stops.

## After a release

`.github/workflows/npm-smoke.yml`, run by hand with the version, installs `@kition/cli` from the npm
registry on macOS (arm64, x64), Linux (x64, arm64) and Windows, installs a kit, and starts the
command that `kition agent add` registers (from the global install, and through `npx`) as an agent
does, asking it for its tools over MCP. On Alpine it checks that the command names musl as the
reason it does not run. It publishes nothing.

`.github/workflows/npm-deprecate.yml`, run by hand with package names and a message, marks
`@kition` packages that a release replaced as deprecated on npm.

## Making one locally

`node packages/kition/scripts/platform-package.mjs` writes `@kition/cli-<platform>` from a built
`kition`, and `link --local` makes a packed `@kition/cli` depend on such packed packages by their
files, so `npm install -g --prefix <folder> kition.tgz` installs both as npm installs them from the
registry, with nothing published:

```sh
cargo build --release -p kition-cli
node packages/kition/scripts/platform-package.mjs platform --platform darwin-arm64 --kition target/release/kition --out target/kition/npm
mkdir -p target/kition/packed && npm pack target/kition/npm/darwin-arm64 --pack-destination target/kition/packed
node tools/pack-public-packages.mjs kition         # target/npm-pack/kition.tgz
node packages/kition/scripts/platform-package.mjs link --local --launcher target/npm-pack/kition.tgz --out target/kition/packed
npm install -g --prefix /tmp/kition-npm target/npm-pack/kition.tgz && /tmp/kition-npm/bin/kition --version
```


`node tools/sdk-bundle.mjs` (`pnpm sdk:bundle`) assembles a bundle on a developer machine with the
executables built there; it publishes nothing. `tools/release-archives.mjs` makes the `kition`
archives from a folder of `bin-<platform>/` folders, each holding `kition`; `--version` names a
rehearsal's own version:

```sh
node tools/release-archives.mjs --bin <folder> --out <release folder> --version 0.5.2
```

Served over HTTP as `<url>/releases/download/sdk-v<version>/` and `<url>/releases/latest/download/`,
such a folder is a release `install.sh` installs from (`KITION_RELEASES_URL=<url>/releases`).
`kition` installs kits from any index named with `KITION_INDEX` or `--index`: a kit's fragment, or
one `tools/kits-index.mjs --out` wrote. Supply a KHP specification with
`--standard <folder>` (or `KIT_STANDARD_DIR`; a clone of
[kitharness/kitharness](https://github.com/kitharness/kitharness)) and a kit lock with `--lock <file>` (or
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
