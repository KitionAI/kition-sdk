# Distribution: the SDK release and its bundles

> The per-platform SDK bundle is being retired as the way customers get the kits. Get them with
> `kition` and the kit store instead: `npm install -g @kition/cli`, then `kition kit install
> <kit>` ([cli.md](cli.md)); the kits and the kit index are on npm
> ([below](#kit-packages-and-the-kit-index)). This page describes what the release workflow
> produces today, the bundle included.

Each Kition SDK version is one version of `kition` on npm (`@kition/cli` and
`@kition/cli-<platform>`) and of the SDK's TypeScript libraries (`@kition/sdk`, one package with a
subpath per library), and a GitHub Release of
[KitionAI/kition-sdk](https://github.com/KitionAI/kition-sdk/releases), tagged
`sdk-v<version>`, with the SDK bundles. Both come from one build in the repository's release
workflow (`.github/workflows/release.yml`), which also rehearses the release on another npm scope
([below](#releasing-and-rehearsing)). Downloading them needs no account, no token and no Rust.

What a person or an agent installs comes from npm: `kition` (the packages `@kition/cli` and
`@kition/cli-<platform>`, and the installers `install.sh` and `install.ps1`, which download the
latter), every kit (`@kition/kit-<kit>-<platform>`, `@kition/kit-<kit>-ui`) and the kit index
(`@kition/kits-index`). Nothing in that path downloads from GitHub, so it works wherever an npm
registry answers: `registry.npmjs.org`, its mirror `registry.npmmirror.com` (reachable from
mainland China), or a registry the person names ([cli.md](cli.md#the-registries)).

## What a release holds

| Asset | What |
| --- | --- |
| `kition-sdk-<version>-<platform>.tar.gz` | The SDK bundle for one platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc 2.17 or later), `win32-x64` |
| `kition-<version>-<platform>.tar.gz` | The `kition` command line for one platform: `kition` (`kition.exe` on Windows) and `LICENSE`, the bytes the release puts in `@kition/cli-<platform>`; a run that publishes a released version's missing npm packages takes `kition` from it ([below](#when-a-release-stops-half-way)) |
| `install.sh`, `install.ps1` | The `kition` installers for macOS and Linux, and for Windows; the same files are in `@kition/cli` as `dist/install.sh` and `dist/install.ps1` |
| `kits-index.json` | A snapshot of the kit index as of the release, a record; not the index `kition` reads ([below](#the-snapshot-in-each-release)) |
| `kition-sdk-<version>.json` | The release manifest: the SDK commit; each kit's version, npm package and integrity, and the commit its executable was built from; each platform's bundle and every executable in it, with its size, SHA-256 and the kit version it answers `kit.initialize` with; each platform's `kition` archive (`cli`), the kit index snapshot (`index`) and the installers, each with its size, SHA-256 and URL; each schema with its URL |
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
  kits/                each kit's editor package (kition-kit-<kit>-ui-<version>.tgz, as npm packs
                       @kition/kit-<kit>-ui), as pinned in Kition's kits.lock.json, and
                       kits/<kit>/kit.json, each package's manifest
  bin/<platform>/      kition-kits, kition-kits-mcp and kition-<kit> for each kit (.exe on Windows)
  docs/                this guide (docs/sdk), the platform documents, the schemas, and the Kit
                       Harness Protocol (KHP) under docs/khp/
```

Each kit executable in `bin/<platform>/` is built from the commit its editor package was built
from (the `commit` Kition's `kits/kits.lock.json` pins for it, which the package's `kition.build`
field names) and was started on its platform before the release
was made: it answered `kit.initialize` with its package's kit id and version and the SDK's Kit
Process Protocol version, or there is no release.

The `kition` command line takes kits one at a time instead: it downloads each kit's npm package,
as the kit index names it, into a store under `~/.kition` when it is needed ([cli.md](cli.md)).
Each kit repository publishes its own packages, and the index is gathered from their registry
metadata (below). A release publishes no kit package; its `kits-index.json` is only a snapshot of
that index (below).

## `kition` and its installers

The npm package `@kition/cli-<platform>` carries `kition` built for the platform, with no kit,
as `bin/kition` (`bin/kition.exe` on Windows); `kition --version` names its version. The npm
package `@kition/cli`, which depends on every one of them as an optional dependency, gives the
`kition` command that starts it (`npm install -g @kition/cli`, `npx -y @kition/cli <command>`;
[cli.md](cli.md#installing-it)). The DeepSeek Harness plugin `@kition/dsh-kits` depends on
`@kition/cli` at its own version, so installing it brings that `kition`, which it starts directly
(the plugin is frozen until after the launch: the release does not publish it, and its README says
how to install it from a kition-sdk checkout). The executables a release ships, `kition` among them,
are built with the workspace's `dist` profile (LTO, one code unit, symbols stripped).

Without Node.js, `install.sh` and `install.ps1` install the same `kition`: they read the metadata of
`@kition/cli-<platform>` (its latest version, or a version given) from the first registry of the
list `kition` itself uses that answers, download its tarball from that registry, check it against
the integrity (SHA-512) the metadata gives, and install its `bin/kition` as `~/.kition/bin/kition`;
they need `curl` (or `wget`) and `tar` (Windows: PowerShell and `tar.exe`), not npm. They ride in
`@kition/cli`, so any server of npm packages' files serves them ([cli.md](cli.md#installing-it)):

```sh
curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh
```

## Linux: the glibc floor

The Linux executables of a release (`kition`, `kition-kits`, `kition-kits-mcp` and every kit's)
run on glibc 2.17 and later: CentOS 7, RHEL 7, Debian 8, Ubuntu 14.04 and every newer glibc
distribution, on x64 and arm64. The release workflow links them against glibc 2.17 with
[cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) (`--target <triple>.2.17`) rather
than against its build machine's glibc, and fails the build when one of them needs a newer
`GLIBC_` symbol version (`node tools/glibc-floor.mjs --max 2.17 <file>...`, which reads each
file's ELF version needs). Linux with the musl C library (Alpine) is not supported.

## Kit packages and the kit index

Each kit repository publishes its own packages on npm, with its Package workflow (Kition's
`docs/kits.md`, section 4b, which writes and checks them with this repository's
`tools/kit-npm-package.mjs`). For a kit version `<version>` (its `kit.json` `version`):

| Package | What |
| --- | --- |
| `@kition/kit-<kit>-<platform>@<version>` | The headless kit for one platform (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`; npm `os`, `cpu`, and `libc` on Linux): `kit.json` and `kition-<kit>` (`.exe` on Windows) at the package's top |
| `@kition/kit-<kit>-ui@<version>` | The editor: the folder `<kit>-ui/` (`index.html`, the engine, fonts, the kit's `kit.json`) |

These are `@kition`'s names. The tools, the workflows and `kition` read another npm scope from
`KITION_NPM_SCOPE` (for a rehearsal on `@kitionstage`); a scope other than `@kition` names its
packages by layout 1: `<scope>/<kit>-<platform>`, `<scope>/<kit>` (the editor) and `<scope>/kits`
(the index), and in it no kit may be named like another package of the scope (`cli`, `sdk`, `kits`,
`tessera`, ...; `tools/kit-npm.mjs` `NOT_KIT_NAMES`).

The release is rehearsed on such a scope by `.github/workflows/release.yml` itself, with a stage
scope ([below](#releasing-and-rehearsing)): it publishes copies of the command line's packages
renamed `<scope>/cli-<platform>` and `<scope>/cli`, and of the SDK renamed `<scope>/sdk`, at a
prerelease version. The launcher starts the platform package of its own name
(`<launcher>-<platform>`) and, published elsewhere than `@kition`, sets `KITION_NPM_SCOPE` to its
scope when it is not set, so `npx -y @kitionstage/cli@<version> kit install note` installs the
staged kit; its `install.sh` and `install.ps1` name the scope on their one scope line, so they
install `<scope>/cli-<platform>`.

The files are those of the kit's archives before npm (the same names and bytes); only the container
is npm's, a `.tgz` with everything under `package/` beside a `package.json`. Each `package.json`
carries a `kition` field (`tools/kit-npm.mjs`): `kit`, `id`, `name`, `version`, `role` (`headless`
or `ui`), `platform` (headless), `protocol` (the Kit Process Protocol it speaks), `extensions` (the
file types it edits), `views` (those it only views), and `build`, the commits it was built from.
The rest of the `package.json` introduces the kit on npm, from kition-sdk's
`templates/community/repositories.json` (a kit not there is refused): `description` is the kit's
one-sentence description (a headless package's adds `(<platform> executable)`), `repository`,
`homepage` and `bugs` its GitHub repository, and `keywords`. A headless package also ships a short
`README.md`; the editor package's README (the kit, what the package holds, how `kition` installs it
and how to embed it, its formats, the Kition family) is its `package.json`'s `readme`, because
`kition` and Kition take the package's top to hold only `<kit>-ui/`. A
version is published once: the workflow publishes only what npm lacks, counts a version npm has
with the same bytes (npm's integrity) as done, and stops when npm has other bytes. So a kit version
is installable as soon as its packages are on npm; no SDK release is needed.

The sizes, as of the kit archives published before npm: the largest headless one is Layout's for
`darwin-x64`, 49.2 MB compressed, and the largest editor one in Kition's kit lock is Table's,
22.2 MB. npm's registry has no documented package size limit; uploads of a few hundred megabytes are
refused in practice, so the kits are far below it.

`kition` reads the kit index from the npm package `@kition/kits-index`, the file `kits-index.json`
in its `latest` version. `.github/workflows/kits-index.yml` publishes it when a maintainer starts
it (by hand; it has no schedule), with `tools/kits-index.mjs`. Its `scope` input (default
`@kition`, passed on as `KITION_NPM_SCOPE`) gathers another npm scope's kits, named by layout 1
(`<scope>/<kit>-<platform>`, `<scope>/<kit>`), into `<scope>/kits`:

- For every kit Kition's `kits/modules.json` names, it reads the registry's metadata of the kit's
  packages: every version that has at least one headless package, each package's tarball size and
  npm integrity, and the `kition` field. No tarball is downloaded. The registry is the only source:
  nothing is carried from an earlier index but the sizes of the same bytes, and every kit is in it,
  not only those in `published-kits.json` (the kits this SDK documents and bundles).
- A withdrawn version is never listed. npm lets no version be replaced, and unpublishing is not
  practical, so a version published by mistake stays on npm: Table was published as 0.5.8 before
  its first version, 0.1.0, and `kition kit install table` took 0.5.8 as the highest. This
  repository's `kits-withdrawn.json` names such versions per kit (`{ "table": ["0.5.8"] }`), and the
  tool reads it by default (`--withdrawn <file>` names another). A withdrawn version is skipped
  before anything else: its metadata is not checked, no size is asked for it, the rule below does
  not compare a later version with it, and the report names it under its kit (`withdrawn, left
  out: 0.5.8`); with `--previous` its packages leave. A withdrawn version npm does not list is not
  named. A list that is not an object of kit names to non-empty lists of distinct versions, or
  that names a kit `kits/modules.json` does not have, stops the run.
- A version still being published is held back. A kit's Package workflow publishes a version's
  packages one after another over several minutes, and npm shows each a little later; an index
  gathered in between listed Layout 0.1.4 without its editor, and `kition kit install layout` took
  it over 0.1.3, which has one. So a version that lacks a package (a platform, or the editor) which
  the kit's highest listed lower version has is not listed; the next version is compared with that
  same listed one. A kit's first version, and a version with the same packages or more, is listed.
  The report names each held version (`held layout 0.1.4: still being published (no ui package;
  0.1.3 has one)`), and with `--previous` its packages leave; holding is not an error, so a kit
  that really dropped a platform or its editor stays visible there until its maintainer acts.
- A package whose tarball npm does not serve yet counts as not published in that run: for a minute
  or two after a publish, npm's metadata lists the version while its tarball answers 404 (to the
  size request, a HEAD or a one-byte range). The package is left out, so the version is held back
  when a lower listed version has that package (`held doc 0.1.4: still being published (no
  darwin-arm64 package; 0.1.3 has one; the darwin-arm64 tarball is not downloadable yet)`), and a
  kit's first version is listed without it; the report names it, and a later run lists it. A size
  the previous index gives for the same integrity needs no request.
- Each index entry names, per platform and for the editor, the package, its size and its integrity.
  `kition` downloads that package from whichever registry answers and refuses it unless its bytes
  have that size and integrity, and its `package.json` names that package and version.
- A package whose `kition` field is missing, or disagrees with the version's other packages (id,
  protocol, extensions), stops the run; so does a registry that cannot be read (any answer but the
  metadata, a size, or a 404). A failure never publishes a smaller index.
- A kit's id, name, extensions and views come from its newest version's `kition` field, so a
  gateway opens the views read-only before the kit is installed. Each version keeps the Kit
  Process Protocol its packages declare. The index is checked against its schema and written in a
  fixed order, so the same packages give the same bytes.
- An index with no kit is never published: the one published stays.
- The workflow publishes a new version of `@kition/kits-index` (`0.1.<n>`, one more than the
  last) only when the index's bytes changed, and tags it `latest`. The versions
  of `@kition/kits-index` are the index's history. It then waits until npm shows that version
  with its bytes (its metadata, `latest` pointing at it, its tarball with the integrity the
  metadata gives), asking every 30 seconds for at most 40 minutes
  (`node tools/kit-npm-package.mjs visible`), and fails after that, naming what npm still lacks.
- npm's placeholder of a first publish is never read. For several minutes after a package name is
  first published (12 to 24 minutes for a 30 MB package), npm lists only the version
  `0.0.0-stage` and points `latest` at it. The gatherer leaves that version out of every kit
  package, in both layouts; a workflow run whose published index's `latest` is still the
  placeholder stops before publishing; and `kition` says `<index package> is being published on
  npm (it shows only npm's placeholder 0.0.0-stage yet); try again in a few minutes`, showing the
  installed kits or the index it read before.

**This is the one thing the repository publishes that moves.** Every package version, release and
asset never changes once published (below); the index's `latest` moves whenever a kit repository
publishes a version.

To run it by hand (read-only):

```sh
node tools/kits-index.mjs --modules <kition>/kits/modules.json --dry-run      # what the index would hold
node tools/kits-index.mjs --modules <kition>/kits/modules.json --out kits-index.json \
  --previous <published kits-index.json>                  # write it; name what enters and leaves
```

`--registry <address>` reads another registry (a mirror, or a test's); `--withdrawn <file>` reads
another list of withdrawn versions than `kits-withdrawn.json`; `--package <folder> --version
<version>` also writes the npm package the workflow publishes.

### The kitions before npm

`kition` 0.5.2 and earlier read the index from GitHub: 0.5.x from the branch `kits-index` of this
repository (`https://raw.githubusercontent.com/KitionAI/kition-sdk/kits-index/kits-index.json`),
0.3.0 and 0.4.0 from the latest release's `kits-index.json`, and they download kits from GitHub
Releases. The branch is no longer written: it stays as it was, the last index of the GitHub
Releases, so those kitions keep installing the kit versions it lists and see none published since.
The latest release's `kits-index.json` names npm packages, which they cannot read and refuse.
Upgrade `kition` to install kits from npm.

### The snapshot in each release

Each SDK release also carries `kits-index.json`: the index gathered by `tools/kits-index.mjs` in
the release workflow when the release is made, and never changed afterwards, a record of the kit
versions published as of the release. `kition` does not read it.

The release workflow gathers the snapshot itself rather than copying the published package, so a
release does not depend on it. A failure, or a gathered index with no kit, stops the release: none
goes without it. `tools/sdk-release.mjs` checks it against `schemas/kits-index.schema.json`, names
it in the release manifest (`index`) and in `SHA256SUMS`, and refuses any other `kits-index*.json`
beside it; kit packages are refused too.

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

`@kition/script` depends on `@kition/kdm` (in the bundle). `@kition/embed` has no dependencies. `@kition/embed-server` depends on `@kition/sync` and
`@kition/embed`.

## Versions never change once published

A published release, its tag and its assets are never deleted, replaced or moved, and a version
number is never used twice; the same holds for every npm package, the kit packages among them
(npm itself refuses a version published before, even after an unpublish). A correction is a new
version. The repositories turn on GitHub's immutable releases, which enforces this for releases.
The `latest` tag of `@kition/kits-index` is the one thing that moves (above).

## Releasing and rehearsing

`.github/workflows/release.yml` is the one path of the real release and of its rehearsal on another
npm scope, so what is rehearsed is what ships. It is started by hand. Its inputs, all checked by
`node tools/stage-package.mjs target` before anything is built:

| Input | Rehearsal (any scope but `@kition`) | Real release (`@kition`) |
| --- | --- | --- |
| `scope` | `@kitionstage`, the default | `@kition`, given explicitly |
| `version` | `<sdk.json version>-stage.<run number>` when empty | `sdk.json`'s; given or empty. `sdk.json`, `crates/kition-cli/Cargo.toml`, `packages/kition/package.json` and `packages/sdk/package.json` must all name it, else nothing starts |
| `platforms` | `darwin-arm64` when empty (the organization runs at most 5 macOS jobs at once) | every platform; naming fewer stops the run |
| `tessera` | the published `<scope>/tessera@<version>`, such as `@kitionstage/tessera@0.1.1-stage.2`; `<scope>/sdk` names its peer `@kition/tessera` at exactly that version | `@kition/tessera` at a published version in `^0.1.0`; `@kition/sdk` names its peer at `^0.1.0` |
| `kition_commit` | empty: `kition`, `kition-kits` and `kition-kits-mcp` only, no kits, bundles or release files; given: as the real release builds them (the release files are an artifact of the run), from a lock that pins every published kit on npm in the rehearsal's scope | the KitionAI/kition commit whose `kits/kits.lock.json` pins every published kit on npm in `@kition` (below), the kits built for the SDK bundles |
| `kit` | `note`: each platform's copy of `kition` installs it from the scope before anything is published | the same |
| npm token | `NPM_TOKEN_STAGE` | `NPM_TOKEN` |

```sh
# A rehearsal
gh workflow run release.yml -R KitionAI/kition-sdk -f scope=@kitionstage -f tessera=@kitionstage/tessera@0.1.1-stage.2
# The real release
gh workflow run release.yml -R KitionAI/kition-sdk -f scope=@kition -f version=0.1.0 \
  -f tessera=@kition/tessera@0.1.0 -f kition_commit=<KitionAI/kition commit>
```

Both build `kition` (and the kits' executables and the SDK bundles) on each platform's runner,
`@kition/sdk` with its pack check, its smoke check and its editor worker in Chromium against the
Tessera given, and copies of the packed packages (`tools/stage-package.mjs release`): a rehearsal
renames them to its scope and version; the real release keeps their names and versions, the
launcher depending on every platform package. Each platform's copy runs with the launcher's copy
there (`--version`, and the kit installed from the scope). Then `tools/stage-package.mjs order`
checks the copies are exactly `<scope>/cli-<platform>` for each platform, `<scope>/cli` and
`<scope>/sdk`, and npm is asked about each one (`tools/kit-npm-package.mjs state`): a version npm
has with the same bytes is done, one with other bytes stops the run before anything is published.
They are published in that order, each with `--tag latest` and provenance, and the run waits until
npm serves each one with its bytes.

Only the real release makes the GitHub Release (a draft, then published once npm has every
package), with its notes (`node tools/sdk-release.mjs --notes`, naming `@kition/cli`, its
installers, `@kition/sdk` and the scope's kit index), its provenance attestations, and asks
npmmirror to copy the packages. A rehearsal makes no tag, no release and no notes on GitHub: its
release files are an artifact of the run, and its step summary gives the lines a kit puts in
`web/package.json` (`"@kition/sdk": "npm:<scope>/sdk@<version>"`, `"@kition/tessera":
"npm:<tessera>"`).

Not published: the SDK's twelve library packages (`@kition/kdm`, `@kition/kit-editor`, ...), which
`@kition/sdk` carries; the kit packages and the kit index (above); and the DeepSeek Harness plugin
`@kition/dsh-kits`, frozen until after the launch.

### Cutover to the new layout

On release day `@kition` moves from the legacy layout (`@kition/kit-<kit>-<platform>`,
`@kition/kit-<kit>-ui`, `@kition/kits-index`) to layout 1 (`@kition/<kit>-<platform>`,
`@kition/<kit>`, `@kition/kits`), as `@kitionstage` has it. Everything that changes:

1. `crates/kition-cli/src/registry.rs`: `LEGACY_LAYOUT_SCOPES` (line 35) becomes empty; then
   `Layout::Legacy` and its arms go (lines 114 and 120), and the tests that expect
   `@kition/kits-index` and `@kition/kit-<kit>-*` names (`registry.rs` tests, `tests/registry.rs`,
   `tests/store.rs`, `tests/editors.rs`, `tests/cli.rs`, `tests/doctor.rs`, `tests/support/mod.rs`)
   name the layout 1 packages.
2. `crates/kition-cli/src/index.rs`: `DEFAULT_INDEX` (line 29) becomes `npm:@kition/kits`, with its
   doc comments (lines 8 and 27); `crates/kition-cli/src/commands/help.rs` line 37.
3. `sdk.json`: `binaries.cli.defaultIndex` becomes `npm:@kition/kits` (`crates/kition-cli/src/main.rs`
   checks it equals `DEFAULT_INDEX`).
4. `tools/kit-npm.mjs`: `LEGACY_LAYOUT_SCOPES` (line 58) becomes empty; then the legacy branches of
   `packageName` and `indexPackage` go, and `tools/kit-npm.test.mjs` and `tools/kits-index.test.mjs`
   follow. The release notes then name `@kition/kits` by themselves (`indexPackage`).
5. KitionAI/kition `scripts/lib/kitNpm.mjs`: its `LEGACY_LAYOUT_SCOPES` (line 35) likewise, and
   `kits/kits.lock.json` pinned on npm in `@kition` by its `scripts/pin-kits.mjs` once the kits are
   published under the layout 1 names. An npm pin names no package: it is `{ scope, version,
   commit, sdkCommit, tesseraCommit, fontsCommit, editor: { integrity, size }, platforms:
   { <platform>: { integrity, size } } }`, and the kit (its key) and `scope` name the packages by
   `tools/kit-npm.mjs` `packageName` (Kition's `uiPackageName` and `headlessPackageName`), so a
   lock pinned before the layout moves needs no change but a new pin. `tools/kit-lock.mjs` reads it
   for the release (every published kit, in the release's scope) and for `tools/sdk-bundle.mjs`
   (the editor package's integrity and size). Kition's lock on `main` still pins GitHub Release
   assets (`repository`, `tag`, `asset`, `size`, `sha256`), which the release refuses, naming each
   kit: the real release, and a rehearsal with `kition_commit`, cannot start before every published
   kit is pinned on npm.
6. Each kit repository's Package workflow publishes its version under the layout 1 names (it takes
   the layout from `tools/kit-npm.mjs`), and `.github/workflows/kits-index.yml` (scope `@kition`)
   then publishes the first `@kition/kits`.
7. `tools/kit-npm-package.mjs` and `tools/sync-community.mjs`: `README_EMBED_SPECIFIER` (lines 50
   and 76) becomes `@kition/sdk/embed`, once `@kition/sdk` is on npm.
8. `tools/sdk-package.mjs` `CLIENT_NAMES` (line 101): the owner decides whether the client names
   sent to servers become `@kition/sdk/...`.
9. The versions, all at once (the owner's step): `sdk.json`, `crates/kition-cli/Cargo.toml` (and
   `Cargo.lock`), `packages/kition/package.json`, `packages/sdk/package.json` and the DeepSeek Harness
   plugin's dependency on `@kition/cli`, with a CHANGELOG.md entry; the release refuses to start
   while they disagree.
10. Docs that name the legacy packages: this page (the kit package table and the kit index
    sections), `docs/sdk/cli.md` (lines 422, 517 to 519 and 557), `README.md`, and
    `.github/workflows/kits-index.yml`'s header.
11. After the release: `.github/workflows/npm-deprecate.yml` for the packages `@kition/sdk`
    replaced (the twelve libraries) and the legacy kit and index packages.

## When a release stops half-way

The release workflow builds and checks everything before it publishes anything. It then makes
the GitHub Release as a draft (no tag yet; it can still be deleted), publishes the npm packages
(a version published on npm can never be published again, so this is the step that cannot be
undone), and publishes the draft last. On npm `@kition/cli-<platform>` goes first for each
platform, then `@kition/cli`, which depends on them, then `@kition/sdk`.

- **It stopped before npm, or part-way through npm** (a refused token, the registry down): run it
  again from the same commit, best with "Re-run failed jobs", which keeps the executables already
  built. The draft is replaced, every npm version already published with the same bytes counts as
  done, and the rest is published. A draft from another commit stops the run: npm may hold
  packages published from that commit; run again from it, or delete the draft when npm holds no
  package of the version.
- **The release is published, and npm lacks packages of its version** (a first publish refused by
  an `NPM_TOKEN` that may not publish a new name, for example): give the token the right, then run
  the workflow from the tag `sdk-v<version>` ("Use workflow from", the tag) with the same inputs.
  The run sees the release published from that commit and publishes only what npm lacks: no draft,
  no bundle, no new release. The `@kition/cli-<platform>` packages carry the `kition` of the
  release's own `kition-<version>-<platform>.tar.gz`, checked against its `SHA256SUMS`, not a new
  build. From any other commit the run stops.
- **npm already has one of the packages at the version with other bytes** (`@kition/cli` 0.5.2, for
  one, published before the gateway command): the run stops before publishing anything, since npm
  never replaces a version. Move every version source to a new version and release again. Every
  platform's `kition` must also answer `kition gateway --help` in its smoke test before anything is
  published.

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

`install.sh` installs from any registry named with `KITION_NPM_REGISTRY` (a local one such as
Verdaccio, with `@kition/cli-<platform>` published to it, or `npm pack`'s tarball served in the
registry's layout, as `tools/install-script.test.mjs` does). `kition` installs kits from the
registries in the same way, and from any index named with `KITION_INDEX` or `--index`: one
`tools/kits-index.mjs --out` wrote, whose packages are on those registries. Supply a KHP specification with
`--standard <folder>` (or `KIT_STANDARD_DIR`; a clone of
[kitharness/kitharness](https://github.com/kitharness/kitharness)) and a kit lock with `--lock <file>` (or
`KITION_KITS_LOCK`; Kition's `kits/kits.lock.json`, an npm pin per kit as `tools/kit-lock.mjs`
reads it). The editor packages are downloaded from the npm registries (`KITION_NPM_REGISTRY`, the
`.npmrc`'s, npmjs.org, npmmirror.com) and checked against the integrity and size the lock pins.

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
