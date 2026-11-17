#!/usr/bin/env node
// Writes the files of one Kition SDK GitHub Release (`sdk-v<version>`, made by
// .github/workflows/release.yml) beside the platform bundles that tools/sdk-bundle.mjs made:
//
//   kition-sdk-<version>.json   the release manifest: the SDK version, tag and commit; each kit
//                               (version, package tag, commit, URL and SHA-256); each platform's
//                               bundle and every executable in it, with its size and SHA-256 and,
//                               for a kit, the kit version it answered kit.initialize with; and
//                               each schema with its URL
//   <schema>.schema.json        the SDK's schemas (schemas/), each its own asset, so the release
//                               gives every schema a stable, versioned address
//   SHA256SUMS                  every asset, in `sha256sum -c` form
//
//   node tools/sdk-release.mjs --dir <folder of kition-sdk-<version>-<platform>.tar.gz>
//
// Every bundle must be of this SDK's version and commit and hold the same kits, or nothing is
// written. It publishes nothing.
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

/** The manifest.json inside a bundle archive (`<folder>/manifest.json`). */
export function bundleManifest(archive) {
  const folder = path.basename(archive).replace(/\.tar\.gz$/, '')
  return JSON.parse(execFileSync('tar', ['-xzOf', archive, `${folder}/manifest.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
}

/**
 * The release manifest from each platform bundle's manifest (`found`: `{ platform, file, size,
 * sha256, manifest }`) and the schemas (`{ file, size, sha256 }`).
 */
export function releaseManifest(version, found, schemas) {
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
  return {
    name: 'kition-sdk',
    version,
    tag: tagOf(version),
    repository: REPOSITORY,
    commit: first.manifest.source.commit,
    kits: first.manifest.kits.map(({ file, manifest: kitJson, ...kit }) => ({ ...kit, asset: path.posix.basename(file), manifest: kitJson })),
    packages: first.manifest.packages.map(({ name, version: v, size, sha256: sum, file }) => ({ name, version: v, file, size, sha256: sum })),
    schemas: schemas.map(({ file, size, sha256: sum }) => ({ file, size, sha256: sum, url: assetUrl(version, file) })),
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

/** Writes the release files in `dir`; answers the manifest. */
export function writeRelease(dir, version) {
  const found = bundles(dir, version).map(({ file, platform }) => {
    const archive = path.join(dir, file)
    return { platform, file, size: fs.statSync(archive).size, sha256: sha256(archive), manifest: bundleManifest(archive) }
  })
  const schemas = fs
    .readdirSync(path.join(root, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .sort()
    .map((file) => {
      fs.copyFileSync(path.join(root, 'schemas', file), path.join(dir, file))
      return { file, size: fs.statSync(path.join(dir, file)).size, sha256: sha256(path.join(dir, file)) }
    })
  const manifest = releaseManifest(version, found, schemas)
  const manifestFile = `kition-sdk-${version}.json`
  fs.writeFileSync(path.join(dir, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`)
  const assets = [...found.map(({ file }) => file), ...schemas.map(({ file }) => file), manifestFile].sort()
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
