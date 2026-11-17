# Distribution: the SDK bundle

`node tools/sdk-bundle.mjs` (`pnpm sdk:bundle`) assembles one versioned bundle on a developer
machine. The command writes local artifacts and publishes nothing. Supply a KHP
specification with `--standard <folder>` (or `KIT_STANDARD_DIR`) and a kit lock
with `--lock <file>` (or `KITION_KITS_LOCK`). Selected kit assets and executables
are separate inputs; they are not needed to build or test the SDK libraries.

```text
kition-sdk-<version>/
  manifest.json        SDK version, source commit, platform; every file with size and SHA-256
  SHA256SUMS           sha256sum -c format, every file
  CHANGELOG.md  LICENSE
  npm/                 @kition/embed, @kition/script, @kition/sync, @kition/kdm, @kition/embed-server tarballs
  kits/                kit packages (kition-<kit>-<version>.tgz), as pinned in Kition's kits.lock.json
  bin/<platform>/      kition-kits-mcp and kition-<kit> executables, when built on this machine
  docs/                this guide (docs/sdk) and the Kit Harness Protocol (KHP)
                       (a supplied specification under docs/khp/)
```

Making one:

```sh
pnpm sdk:bundle -- --archive                       # all kits in sdk.json, downloads with gh
pnpm sdk:bundle -- --kits note --kit-assets <folder-with-tarballs>
KITION_KITS_MCP=<kition-sdk>/target/release/kition-kits-mcp \
KITION_KIT_NOTE_BINARY=<kition-note>/target/release/kition-note \
  pnpm sdk:bundle -- --kits note                   # with executables
```

Kit tarballs are checked against the size and SHA-256 the lock pins.

Using one:

```sh
cd kition-sdk-<version> && shasum -a 256 -c SHA256SUMS
npm install ./npm/kition-embed-<v>.tgz              # or publish the tarballs to your registry:
npm publish ./npm/kition-embed-<v>.tgz --registry <registry-url>
mkdir -p public/kits && tar -xzf kits/kition-note-<v>.tgz -C public/kits   # → public/kits/note-ui/
```

`@kition/script` depends on `@kition/kdm` and `@kition/sync` (in the bundle) and `loro-crdt` (public
npm). `@kition/embed` has no dependencies. `@kition/embed-server` depends on `@kition/sync` and
`@kition/embed`.
