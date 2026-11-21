#!/usr/bin/env node
// KitionAI/kition's kit lock (kits/kits.lock.json) as kition-sdk reads it: the release's kit check
// (.github/workflows/release.yml) and the SDK bundle (tools/sdk-bundle.mjs) take the kits it pins.
// Kition's scripts/pin-kits.mjs writes it and its scripts/lib/kitPackages.mjs is the reference;
// this reads the one form a release builds from, an npm pin per kit:
//
//   "note": {
//     "scope": "@kition", "version": "0.1.5",
//     "commit": "<40 hex>", "sdkCommit": "<40 hex>", "tesseraCommit": "<40 hex>", "fontsCommit": "<40 hex>",
//     "editor": { "integrity": "sha512-<base64>", "size": <tarball bytes> },
//     "platforms": { "darwin-arm64": { "integrity": "sha512-<base64>", "size": <tarball bytes> }, ... }
//   }
//
// The entry names no package: the kit (its key) and its scope name them by tools/kit-npm.mjs
// `packageName` (the editor `ui`, each platform's headless package), so nothing derivable is
// written twice. A GitHub Release pin (repository, tag, asset, size, sha256), which Kition still
// reads until its kits are pinned on npm, is refused here: the release takes kits from npm only.
//
//   node tools/kit-lock.mjs <kits.lock.json> [--scope <scope>] [--kits board,cad,...]
//     checks the pins of the kits named (default: published-kits.json), in `scope` when given, and
//     prints `<kit> <version> <editor package> <commit>` per kit; exits 1 naming every problem.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkScope, packageName, PLATFORMS } from './kit-npm.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The build commits every pin carries, as the packages' `kition.build` names them. */
const BUILD_COMMITS = ['commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit']
/** The fields of an npm pin, in the order Kition writes them. */
export const PIN_FIELDS = ['scope', 'version', ...BUILD_COMMITS, 'editor', 'platforms']
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const isSize = (value) => Number.isSafeInteger(value) && value > 0

/** Why `tarball` is not `{ integrity, size }` of an npm tarball, as a list. */
function tarballProblems(what, tarball) {
  if (!tarball || typeof tarball !== 'object' || Array.isArray(tarball)) return [`${what} is not { integrity, size }`]
  const problems = []
  const extra = Object.keys(tarball).filter((key) => !['integrity', 'size'].includes(key))
  if (extra.length) problems.push(`${what} has ${extra.join(', ')} beside integrity and size`)
  if (!INTEGRITY.test(String(tarball.integrity))) problems.push(`${what}.integrity ${tarball.integrity ?? 'missing'} is not an npm integrity (sha512-<base64>)`)
  if (!isSize(tarball.size)) problems.push(`${what}.size ${tarball.size ?? 'missing'} is not a size in bytes`)
  return problems
}

/**
 * `kit`'s pin `entry` with its packages named: `{ kit, scope, version, commit, sdkCommit,
 * tesseraCommit, fontsCommit, editor: { package, integrity, size }, platforms: { <platform>:
 * { package, integrity, size } } }`. Throws naming every problem: a field missing, malformed or
 * not a pin's, a platform kition is not built for, a kit name the scope's layout refuses, another
 * scope than `scope` (when given), or a GitHub Release pin.
 */
export function lockPin(kit, entry, { scope } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${kit}: the lock pins no ${kit}`)
  if ('repository' in entry || 'asset' in entry) {
    throw new Error(`${kit}: a GitHub Release pin (repository ${entry.repository}, asset ${entry.asset}); the release takes kits from npm only: pin ${kit} on npm with KitionAI/kition's scripts/pin-kits.mjs (KITION_NPM_SCOPE=${scope ?? '<scope>'})`)
  }
  const problems = []
  const extra = Object.keys(entry).filter((key) => !PIN_FIELDS.includes(key))
  if (extra.length) problems.push(`${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not a pin's (${PIN_FIELDS.join(', ')})`)
  if (!VERSION.test(String(entry.version))) problems.push(`version ${entry.version ?? 'missing'} is not a version`)
  const commits = BUILD_COMMITS.filter((key) => !COMMIT.test(String(entry[key])))
  if (commits.length) problems.push(`no valid ${commits.join(', ')}`)
  let editorPackage = null
  try {
    checkScope(entry.scope, 'scope')
    editorPackage = packageName(kit, 'ui', entry.scope)
  } catch (error) {
    problems.push(error.message)
  }
  if (scope && entry.scope !== scope) problems.push(`scope ${entry.scope} is not the release's ${scope}`)
  problems.push(...tarballProblems('editor', entry.editor))
  const platforms = {}
  if (!entry.platforms || typeof entry.platforms !== 'object' || Array.isArray(entry.platforms)) problems.push('platforms is not { <platform>: { integrity, size } }')
  else {
    for (const [platform, tarball] of Object.entries(entry.platforms)) {
      if (!PLATFORMS.includes(platform)) {
        problems.push(`platform ${platform} is not one of ${PLATFORMS.join(', ')}`)
        continue
      }
      problems.push(...tarballProblems(`platforms.${platform}`, tarball))
      if (editorPackage) platforms[platform] = { package: packageName(kit, platform, entry.scope), integrity: tarball?.integrity, size: tarball?.size }
    }
  }
  if (problems.length) throw new Error(`${kit}: ${problems.join('; ')}`)
  return {
    kit,
    scope: entry.scope,
    version: entry.version,
    ...Object.fromEntries(BUILD_COMMITS.map((key) => [key, entry[key]])),
    editor: { package: editorPackage, integrity: entry.editor.integrity, size: entry.editor.size },
    platforms,
  }
}

/** The lock file `file` (its `$comment` aside): `{ <kit>: entry }` as written. */
export function readLock(file) {
  const { $comment: _comment, ...kits } = JSON.parse(fs.readFileSync(file, 'utf8'))
  return kits
}

/** The pins of `kits` in the lock file `file` (`lockPin` each); throws naming every kit's problems. */
export function lockPins(file, kits, { scope } = {}) {
  const lock = readLock(file)
  const pins = []
  const problems = []
  for (const kit of kits) {
    try {
      pins.push(lockPin(kit, lock[kit], { scope }))
    } catch (error) {
      problems.push(error.message)
    }
  }
  if (problems.length) throw new Error(`${path.basename(file)} pins kits a release cannot take:\n  ${problems.join('\n  ')}`)
  return pins
}

function main(argv) {
  const file = argv.find((arg, index) => !arg.startsWith('--') && !['--scope', '--kits'].includes(argv[index - 1]))
  const option = (name) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  if (!file) {
    console.error('usage: node tools/kit-lock.mjs <kits.lock.json> [--scope <scope>] [--kits board,cad,...]')
    process.exit(2)
  }
  const kits = option('--kits')?.split(',').filter(Boolean) ?? JSON.parse(fs.readFileSync(path.join(root, 'published-kits.json'), 'utf8'))
  try {
    for (const pin of lockPins(file, kits, { scope: option('--scope') })) console.log(`${pin.kit} ${pin.version} ${pin.editor.package} ${pin.commit}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
