#!/usr/bin/env node
// Writes the files of one Kition SDK GitHub Release (`sdk-v<version>`, made by
// .github/workflows/release.yml) beside the platform bundles that tools/sdk-bundle.mjs made and
// the archives and kit index that tools/release-archives.mjs made:
//
//   kition-sdk-<version>.json   the release manifest: the SDK version, tag and commit; each kit
//                               (version, package tag, commit, URL and SHA-256); each platform's
//                               bundle and every executable in it, with its size and SHA-256 and,
//                               for a kit, the kit version it answered kit.initialize with; each
//                               platform's `kition` archive; the kit archives this release adds and
//                               the kit index; the install scripts; and each schema with its URL
//   <schema>.schema.json        the SDK's schemas (schemas/), each its own asset, so the release
//                               gives every schema a stable, versioned address
//   install.sh, install.ps1     the `kition` installers (install/)
//   SHA256SUMS                  every asset, in `sha256sum -c` form
//
//   node tools/sdk-release.mjs --dir <folder of kition-sdk-<version>-<platform>.tar.gz>
//
// Every bundle must be of this SDK's version and commit and hold the same kits; every bundle's
// platform needs its `kition-<version>-<platform>.tar.gz`; kits-index.json must list every kit
// version the bundles hold for every platform; and every other `.tar.gz` there must be an archive
// the index names. Otherwise nothing is written. It publishes nothing.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * archives (`cli`: `{ platform, file, size, sha256 }`), the kit index (`index`: `{ file, size,
 * sha256, body }`) and the kit archives in this release (`kitArchives`: `{ kit, version, platform,
 * file, size, sha256 }`, each as the index names it).
 */
export function releaseManifest(version, found, schemas, { cli = [], index = null, kitArchives = [], installers = [] } = {}) {
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
  if (!index) throw new Error('no kits-index.json (tools/release-archives.mjs writes it)')
  for (const kit of first.manifest.kits) {
    for (const { platform } of found) {
      if (!index.body.kits[kit.kit]?.versions[kit.version]?.platforms[platform]) throw new Error(`kits-index.json lists no ${kit.kit} ${kit.version} for ${platform}`)
    }
  }
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
    kitArchives: kitArchives.map(({ kit, version: v, platform, file, size, sha256: sum, url }) => ({ kit, version: v, platform, file, size, sha256: sum, url })),
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
 * The kit archives in `dir` that `index` names (an archive whose address ends in its file name),
 * checked against the size and SHA-256 the index gives. Any other `.tar.gz` in `dir` that is not
 * one of `known` is refused, so no stray archive is published.
 */
export function indexedArchives(dir, index, known) {
  const named = new Map()
  for (const [kit, entry] of Object.entries(index.kits)) {
    for (const [version, { platforms }] of Object.entries(entry.versions)) {
      for (const [platform, archive] of Object.entries(platforms)) named.set(archive.url.slice(archive.url.lastIndexOf('/') + 1), { kit, version, platform, ...archive })
    }
  }
  const found = []
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.tar.gz')).sort()) {
    if (known.has(file)) continue
    const entry = named.get(file)
    if (!entry) throw new Error(`${file} is neither a bundle, a kition archive nor an archive kits-index.json names`)
    const archive = path.join(dir, file)
    const size = fs.statSync(archive).size
    const sum = sha256(archive)
    if (size !== entry.size || sum !== entry.sha256) throw new Error(`${file} is ${size} bytes, sha256 ${sum}; kits-index.json says ${entry.size} bytes, sha256 ${entry.sha256}`)
    found.push({ ...entry, file })
  }
  return found
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
  const index = fs.existsSync(path.join(dir, 'kits-index.json')) ? { ...described('kits-index.json'), body: JSON.parse(fs.readFileSync(path.join(dir, 'kits-index.json'), 'utf8')) } : null
  const kitArchives = index ? indexedArchives(dir, index.body, new Set([...found, ...cli].map(({ file }) => file))) : []
  const schemas = copyAssets(dir, 'schemas', (file) => file.endsWith('.schema.json'))
  const installers = copyAssets(dir, 'install', (file) => /^install\.(sh|ps1)$/.test(file))
  const manifest = releaseManifest(version, found, schemas, { cli, index, kitArchives, installers })
  const manifestFile = `kition-sdk-${version}.json`
  fs.writeFileSync(path.join(dir, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`)
  const assets = [...found, ...cli, ...kitArchives, ...schemas, ...installers, ...(index ? [index] : [])].map(({ file }) => file).concat(manifestFile).sort()
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), assets.map((file) => `${sha256(path.join(dir, file))}  ${file}`).join('\n') + '\n')
  return manifest
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--dir')
  const dir = at > 0 ? process.argv[at + 1] : null
  if (!dir) {
    process.stderr.write('usage: sdk-release.mjs --dir <folder of kition-sdk-<version>-<platform>.tar.gz>\n')
    process.exit(2)
  }
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8'))
    const manifest = writeRelease(path.resolve(dir), version)
    process.stdout.write(`${manifest.tag}: ${Object.keys(manifest.platforms).join(', ')}; kits ${manifest.kits.map((kit) => `${kit.kit} ${kit.version}`).join(', ')}\n`)
  } catch (error) {
    process.stderr.write(`sdk-release: ${error.message}\n`)
    process.exit(1)
  }
}
