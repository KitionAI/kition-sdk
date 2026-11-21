#!/usr/bin/env node
// Writes the files of one Kition SDK GitHub Release (`sdk-v<version>`, made by
// .github/workflows/release.yml) beside the platform bundles that tools/sdk-bundle.mjs made and
// the `kition` archives that tools/release-archives.mjs made:
//
//   kition-sdk-<version>.json   the release manifest: the SDK version, tag and commit; each kit
//                               (version, package tag, commit, URL and SHA-256); each platform's
//                               bundle and every executable in it, with its size and SHA-256 and,
//                               for a kit, the kit version it answered kit.initialize with; each
//                               platform's `kition` archive; the kit index snapshot; the install
//                               scripts; and each schema with its URL
//   <schema>.schema.json        the SDK's schemas (schemas/), each its own asset, so the release
//                               gives every schema a stable, versioned address
//   install.sh, install.ps1     the `kition` installers (install/)
//   kits-index.json             (written by tools/kits-index.mjs before this runs) the kit index
//                               gathered from the kit packages' npm metadata when the release was
//                               made: a snapshot; the index `kition` reads is the npm package
//                               of the scope (tools/kit-npm.mjs indexPackage)
//   SHA256SUMS                  every asset, in `sha256sum -c` form
//
//   node tools/sdk-release.mjs --dir <folder of kition-sdk-<version>-<platform>.tar.gz>
//   node tools/sdk-release.mjs --notes <kition-sdk-<version>.json> --scope <@scope>
//       prints the release's notes (Markdown) for the packages of the npm scope it published
//
// Every bundle must be of this SDK's version and commit and hold the same kits; every bundle's
// platform needs its `kition-<version>-<platform>.tar.gz`; kits-index.json must be there, valid
// against schemas/kits-index.schema.json and holding a kit; and no other `.tar.gz` and no other
// `kits-index*.json` may be there (the kit repositories publish the kit packages on npm, and
// tools/kits-index.mjs gathers the kit index from their metadata: docs/sdk/distribution.md). Otherwise
// nothing is written. It publishes nothing.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexPackage } from './kit-npm.mjs'
import { INDEX, schemaProblems } from './kits-index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPOSITORY = 'KitionAI/kition-sdk'

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export const tagOf = (version) => `sdk-v${version}`
export const assetUrl = (version, asset) => `https://github.com/${REPOSITORY}/releases/download/${tagOf(version)}/${asset}`

/** The bundle archives in `dir`, by platform: `kition-sdk-<version>-<platform>.tar.gz`. */
export function bundles(dir, version) {
  const pattern = new RegExp(`^kition-sdk-${version.replace(/\./g, '\\.')}-([a-z0-9]+-[a-z0-9]+)\\.tar\\.gz$`)
  return fs
    .readdirSync(dir)
    .map((file) => [file, file.match(pattern)?.[1]])
    .filter(([, platform]) => platform)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, platform]) => ({ file, platform }))
}

/** The `kition` archives in `dir`, by platform: `kition-<version>-<platform>.tar.gz`. */
export function cliArchives(dir, version) {
  const pattern = new RegExp(`^kition-${version.replace(/\./g, '\\.')}-([a-z0-9]+-[a-z0-9]+)\\.tar\\.gz$`)
  return fs
    .readdirSync(dir)
    .map((file) => [file, file.match(pattern)?.[1]])
    .filter(([, platform]) => platform)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, platform]) => ({ file, platform }))
}

/** The manifest.json inside a bundle archive (`<folder>/manifest.json`). */
export function bundleManifest(archive) {
  const folder = path.basename(archive).replace(/\.tar\.gz$/, '')
  return JSON.parse(execFileSync('tar', ['-xzOf', archive, `${folder}/manifest.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
}

/**
 * The release manifest from each platform bundle's manifest (`found`: `{ platform, file, size,
 * sha256, manifest }`), the schemas and installers (`{ file, size, sha256 }`), the `kition`
 * archives (`cli`: `{ platform, file, size, sha256 }`) and the kit index snapshot (`index`: `{ file,
 * size, sha256 }`).
 */
export function releaseManifest(version, found, schemas, { cli = [], index = null, installers = [] } = {}) {
  if (!found.length) throw new Error(`no kition-sdk-${version}-<platform>.tar.gz`)
  const [first] = found
  const kits = (manifest) => JSON.stringify(manifest.kits.map(({ kit, version: v, sha256: sum }) => [kit, v, sum]))
  for (const { platform, manifest } of found) {
    if (manifest.version !== version) throw new Error(`the ${platform} bundle is ${manifest.version}, not ${version}`)
    if (manifest.platform !== platform) throw new Error(`the ${platform} bundle says it is for ${manifest.platform}`)
    if (!manifest.source?.clean) throw new Error(`the ${platform} bundle was made from a checkout with changes`)
    if (manifest.source.commit !== first.manifest.source.commit) throw new Error(`the ${platform} bundle is from ${manifest.source.commit}, ${first.platform} from ${first.manifest.source.commit}`)
    if (kits(manifest) !== kits(first.manifest)) throw new Error(`the ${platform} bundle holds other kits than the ${first.platform} bundle`)
    for (const kit of manifest.kits) {
      if (!manifest.binaries.some((binary) => binary.kit === kit.kit && binary.kitVersion === kit.version)) {
        throw new Error(`the ${platform} bundle has no kition-${kit.kit} that answers ${kit.version}`)
      }
    }
  }
  for (const { platform } of found) {
    if (!cli.some((entry) => entry.platform === platform)) throw new Error(`no kition-${version}-${platform}.tar.gz for the ${platform} bundle`)
  }
  if (!index) throw new Error(`no ${INDEX} (tools/kits-index.mjs --out writes it)`)
  return {
    name: 'kition-sdk',
    version,
    tag: tagOf(version),
    repository: REPOSITORY,
    commit: first.manifest.source.commit,
    kits: first.manifest.kits.map(({ file, manifest: kitJson, ...kit }) => ({ ...kit, asset: path.posix.basename(file), manifest: kitJson })),
    packages: first.manifest.packages.map(({ name, version: v, size, sha256: sum, file }) => ({ name, version: v, file, size, sha256: sum })),
    schemas: schemas.map(({ file, size, sha256: sum }) => ({ file, size, sha256: sum, url: assetUrl(version, file) })),
    cli: Object.fromEntries(cli.map(({ platform, file, size, sha256: sum }) => [platform, { file, size, sha256: sum, url: assetUrl(version, file) }])),
    index: { file: index.file, size: index.size, sha256: index.sha256, url: assetUrl(version, index.file) },
    installers: installers.map(({ file, size, sha256: sum }) => ({ file, size, sha256: sum, url: assetUrl(version, file) })),
    platforms: Object.fromEntries(
      found.map(({ platform, file, size, sha256: sum, manifest }) => [
        platform,
        {
          bundle: file,
          size,
          sha256: sum,
          url: assetUrl(version, file),
          folder: file.replace(/\.tar\.gz$/, ''),
          binaries: manifest.binaries,
        },
      ]),
    ),
  }
}

/**
 * Refuses any `.tar.gz` in `dir` that is not one of `known` (the bundles and the `kition`
 * archives), so no stray archive, such as a kit archive, is published with the release.
 */
export function strayArchives(dir, known) {
  const stray = fs.readdirSync(dir).filter((name) => name.endsWith('.tar.gz') && !known.has(name)).sort()
  if (stray.length) throw new Error(`${stray.join(', ')}: neither a bundle nor a kition archive of this version; kit archives are published by the kit repositories`)
}

/**
 * The kit index snapshot in `dir` (`kits-index.json`, as tools/kits-index.mjs wrote it), or null
 * when there is none. It must be valid against schemas/kits-index.schema.json and hold a kit; any
 * other `kits-index*.json` there (a kit's fragment, say) is refused.
 */
export function indexSnapshot(dir) {
  const stray = fs.readdirSync(dir).filter((name) => /^kits-index.*\.json$/.test(name) && name !== INDEX).sort()
  if (stray.length) throw new Error(`${stray.join(', ')}: a release carries one kit index, ${INDEX}`)
  const file = path.join(dir, INDEX)
  if (!fs.existsSync(file)) return null
  let body
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${INDEX} is not JSON: ${error.message}`)
  }
  const problems = schemaProblems(body)
  if (problems.length) throw new Error(`${INDEX} is not valid against kits-index.schema.json: ${problems.join('; ')}`)
  if (!Object.keys(body.kits).length) throw new Error(`${INDEX} holds no kit`)
  return { file: INDEX, size: fs.statSync(file).size, sha256: sha256(file) }
}

/** The release files in `dir` copied from the repository: `schemas/*.schema.json` and `install/*`. */
function copyAssets(dir, from, filter) {
  return fs
    .readdirSync(path.join(root, from))
    .filter(filter)
    .sort()
    .map((file) => {
      fs.copyFileSync(path.join(root, from, file), path.join(dir, file))
      return { file, size: fs.statSync(path.join(dir, file)).size, sha256: sha256(path.join(dir, file)) }
    })
}

/** Writes the release files in `dir`; answers the manifest. */
export function writeRelease(dir, version) {
  const described = (file) => ({ file, size: fs.statSync(path.join(dir, file)).size, sha256: sha256(path.join(dir, file)) })
  const found = bundles(dir, version).map(({ file, platform }) => ({ platform, ...described(file), manifest: bundleManifest(path.join(dir, file)) }))
  const cli = cliArchives(dir, version).map(({ file, platform }) => ({ platform, ...described(file) }))
  strayArchives(dir, new Set([...found, ...cli].map(({ file }) => file)))
  const index = indexSnapshot(dir)
  const schemas = copyAssets(dir, 'schemas', (file) => file.endsWith('.schema.json'))
  const installers = copyAssets(dir, 'install', (file) => /^install\.(sh|ps1)$/.test(file))
  const manifest = releaseManifest(version, found, schemas, { cli, index, installers })
  const manifestFile = `kition-sdk-${version}.json`
  fs.writeFileSync(path.join(dir, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`)
  const assets = [...found, ...cli, ...schemas, ...installers, ...(index ? [index] : [])].map(({ file }) => file).concat(manifestFile).sort()
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), assets.map((file) => `${sha256(path.join(dir, file))}  ${file}`).join('\n') + '\n')
  return manifest
}

/**
 * The GitHub Release's notes for the release manifest `m`, naming the npm packages of `scope` that
 * the release published: the command line `<scope>/cli` (and the installers it carries, which
 * download `<scope>/cli-<platform>`), the SDK `<scope>/sdk`, and the kit index of the scope's
 * layout (tools/kit-npm.mjs indexPackage).
 */
export function releaseNotes(m, { scope }) {
  const cli = `${scope}/cli`
  const sdk = `${scope}/sdk`
  const kits = m.kits.map((k) => `- ${k.id} ${k.version}: npm ${k.package}@${k.version} (${k.integrity}), built from ${k.commit}`).join('\n')
  const platforms = Object.entries(m.platforms).map(([p, b]) => `- ${p}: ${b.bundle} (sha256 ${b.sha256})`).join('\n')
  const archives = Object.entries(m.cli).map(([p, a]) => `- ${p}: ${a.file} (sha256 ${a.sha256})`).join('\n')
  return [
    `Kition SDK ${m.version}, built from ${m.commit}.`,
    '',
    'Install kition (kits download on first use into ~/.kition/kits), from npm or its mirrors:',
    `- npm (Node.js 20 or later): npm install -g ${cli}, or npx -y ${cli} <command>`,
    `- macOS, Linux, without Node.js: curl -fsSL https://unpkg.com/${cli}@${m.version}/dist/install.sh | sh (it downloads ${cli}-<platform> from registry.npmjs.org, else registry.npmmirror.com, checking npm's integrity)`,
    `- Windows, without Node.js: irm https://unpkg.com/${cli}@${m.version}/dist/install.ps1 | iex`,
    '',
    `The SDK's TypeScript libraries are one npm package, ${sdk} (${sdk}/embed, ${sdk}/script, ${sdk}/kdm, ${sdk}/editor, ...): npm install ${sdk}@${m.version}; a kit editor also installs its optional peer @kition/tessera.`,
    '',
    'kition:',
    archives,
    '',
    `kition installs kits from the npm packages the kit index ${indexPackage(scope)} lists (registry.npmjs.org, its mirror registry.npmmirror.com, or KITION_NPM_REGISTRY).`,
    `The kits-index.json of this release is a snapshot of that index as of the release (sha256 ${m.index.sha256}).`,
    '',
    'Kits:',
    kits,
    '',
    'SDK bundles (bin/<platform>/ holds kition-kits, kition-kits-mcp and each kit executable):',
    platforms,
    '',
    `Every executable with its SHA-256 and the kit version it answers: kition-sdk-${m.version}.json. All assets: SHA256SUMS. Provenance: gh attestation verify <file> --repo ${m.repository}.`,
    'See docs/sdk/distribution.md.',
  ].join('\n')
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (name) => {
    const at = process.argv.indexOf(name)
    return at > 0 ? process.argv[at + 1] : null
  }
  const dir = value('--dir')
  const notes = value('--notes')
  if (!dir && !(notes && value('--scope'))) {
    process.stderr.write('usage: sdk-release.mjs --dir <folder of kition-sdk-<version>-<platform>.tar.gz> | --notes <kition-sdk-<version>.json> --scope <@scope>\n')
    process.exit(2)
  }
  try {
    if (notes) {
      process.stdout.write(`${releaseNotes(JSON.parse(fs.readFileSync(notes, 'utf8')), { scope: value('--scope') })}\n`)
    } else {
      const { version } = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8'))
      const manifest = writeRelease(path.resolve(dir), version)
      process.stdout.write(`${manifest.tag}: ${Object.keys(manifest.platforms).join(', ')}; kits ${manifest.kits.map((kit) => `${kit.kit} ${kit.version}`).join(', ')}\n`)
    }
  } catch (error) {
    process.stderr.write(`sdk-release: ${error.message}\n`)
    process.exit(1)
  }
}
