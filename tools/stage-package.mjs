#!/usr/bin/env node
// The copies of the packed packages that .github/workflows/release.yml publishes, for a rehearsal
// on another npm scope (such as @kitionstage) and for the real release on @kition alike: the same
// path, so what is rehearsed is what ships. Nothing here publishes.
//
// A rehearsal renames: the packed @kition/sdk becomes <scope>/sdk at a version of one's choosing,
// and its optional peer @kition/tessera keeps that name (a consumer aliases it:
// "@kition/tessera": "npm:<scope>/tessera@<version>") with its range set to the exact version of
// the rehearsal Tessera it is checked with; the packed launcher @kition/cli becomes <scope>/cli,
// with optionalDependencies on <scope>/cli-<platform> at the version for exactly the platforms
// built, and its installers (dist/install.sh, dist/install.ps1) name the scope, so they install
// <scope>/cli-<platform>; a packed platform package @kition/cli-<platform> becomes
// <scope>/cli-<platform>. The launcher finds its platform package by its own name
// (packages/kition/src/resolve.ts), so the renamed copy starts the renamed kition.
//
// The real release (@kition) renames nothing: every version source agrees with sdk.json and the
// packages are published at it, the launcher depends on every platform, and @kition/sdk's Tessera
// peer is the range RELEASE_TESSERA_RANGE. Everything else in a copy (files, exports,
// dependencies, README) stays as packed. It works on a copy: the archive or folder it is given, and
// this checkout's tracked files, are never touched.
//
//   node tools/stage-package.mjs target --scope <@scope> --version <version or ''>
//        --platforms <platform,... or ''> --tessera <@scope/tessera@version> --run-number <n>
//       checks a release's inputs against this checkout's version sources and prints the target
//       as JSON: { scope, real, version, platforms, tessera, peer, names }
//   node tools/stage-package.mjs release --target <target.json> --from <archive> --out <empty folder>
//       the copy of a packed @kition/sdk, @kition/cli or @kition/cli-<platform> the release
//       publishes; prints { tarball, name, version, integrity }
//   node tools/stage-package.mjs order --target <target.json> --dir <folder>
//       checks the folder holds exactly the release's copies (cli-<platform>.tgz, cli.tgz,
//       sdk.tgz), each what its name says, and prints them in publishing order, one line each:
//       "<archive> <name> <version> <integrity>"
//
// The rehearsal copies alone, by hand (they refuse @kition):
//   node tools/stage-package.mjs --from <sdk.tgz | unpacked folder> --scope <@scope> --version <version>
//        --tessera <@scope/tessera@version> --out <empty folder outside this checkout>
//       writes <out>/package/ and its archive (npm pack, no scripts) and prints JSON
//       { tarball, name, version, integrity, tessera }
//   node tools/stage-package.mjs --from <cli.tgz | cli-<platform>.tgz> --scope <@scope> --version <version>
//        --platforms <platform,...> --out <empty folder outside this checkout>
//       the same for the launcher or a platform package; prints { tarball, name, version, integrity }
//   node tools/stage-package.mjs --check --scope <@scope> --version <version> (--tessera <spec> | --platforms <list>)
//       only checks them
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrityOf } from './kit-npm.mjs'
import { SDK, TESSERA } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The launcher package (packages/kition), and the platforms it carries kition for. */
export const CLI = '@kition/cli'
export const CLI_PLATFORMS = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))

/** An npm scope: `@` and lowercase letters, digits and hyphens. */
export const SCOPE = /^@[a-z0-9][a-z0-9-]*$/

/** The scope of the real release, which a rehearsal never publishes to. */
export const REAL_SCOPE = '@kition'

/** A semantic version (semver.org's expression), build metadata included. */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** Throws unless `scope` is a rehearsal scope (an npm scope, not @kition). */
export function checkScope(scope) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) throw new Error(`"${scope}" is not an npm scope (${SCOPE.source})`)
  if (scope === REAL_SCOPE) throw new Error(`${REAL_SCOPE} is the real release's scope; a rehearsal publishes to another one, such as @kitionstage`)
  return scope
}

/** Throws unless `version` is a semantic version npm keeps as written. */
export function checkVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`"${version}" is not a semantic version`)
  // npm drops build metadata on publish, so the registry would list another version than asked.
  if (version.includes('+')) throw new Error(`"${version}" has build metadata, which npm drops: use a prerelease (-stage.1)`)
  return version
}

/**
 * `<scope>/tessera@<version>`, the published Tessera the rehearsal names (usually a rehearsal of
 * Tessera too; any scope): { scope, name, version }.
 */
export function parseTessera(spec) {
  const match = /^(@[^/]+)\/tessera@(.+)$/.exec(typeof spec === 'string' ? spec : '')
  if (!match || !SCOPE.test(match[1])) throw new Error(`"${spec}" is not <scope>/tessera@<version> (such as @kitionstage/tessera@0.1.1-stage.3)`)
  return { scope: match[1], name: `${match[1]}/tessera`, version: checkVersion(match[2]) }
}

/** Checks the inputs of a rehearsal: { scope, version, tessera: parseTessera(tessera) }. */
export function checkTarget({ scope, version, tessera }) {
  return { scope: checkScope(scope), version: checkVersion(version), tessera: parseTessera(tessera) }
}

/** The platforms of a rehearsal of the command line: `darwin-arm64,linux-x64` or a list, each once, each known. */
export function checkPlatforms(platforms) {
  const list = (typeof platforms === 'string' ? platforms.split(',') : Array.isArray(platforms) ? platforms : []).map((platform) => String(platform).trim()).filter(Boolean)
  if (!list.length) throw new Error(`name at least one platform: ${CLI_PLATFORMS.join(', ')}`)
  for (const platform of list) if (!CLI_PLATFORMS.includes(platform)) throw new Error(`no platform ${platform}: one of ${CLI_PLATFORMS.join(', ')}`)
  if (new Set(list).size !== list.length) throw new Error(`a platform is named twice: ${list.join(', ')}`)
  return list
}

/** The platforms a rehearsal builds when none are named: the organization runs at most 5 macOS jobs at once. */
export const STAGE_PLATFORMS = ['darwin-arm64']

/**
 * The range of @kition/tessera that the real @kition/sdk names as its peer. A rehearsal names the
 * exact version of the rehearsal Tessera instead. The owner chooses it; it is not a version of
 * anything this repository publishes.
 */
export const RELEASE_TESSERA_RANGE = '^0.1.0'

/**
 * The files that hold the version a release publishes, and how each is read: sdk.json, kition's
 * own (kition --version), the launcher's and @kition/sdk's. They move together (sdk.json's
 * $comment); a release whose sources disagree does not start.
 */
export const VERSION_SOURCES = {
  'sdk.json': (text) => JSON.parse(text).version,
  'crates/kition-cli/Cargo.toml': (text) => /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
  'packages/kition/package.json': (text) => JSON.parse(text).version,
  'packages/sdk/package.json': (text) => JSON.parse(text).version,
}

/** Each version source of the checkout at `dir`: [{ file, version }]. */
export function versionSources(dir = root) {
  return Object.entries(VERSION_SOURCES).map(([file, read]) => ({ file, version: read(fs.readFileSync(path.join(dir, file), 'utf8')) ?? null }))
}

/** The one version every source names; throws naming each source when they disagree. */
export function checkVersionSources(sources) {
  const versions = [...new Set(sources.map(({ version }) => version))]
  if (versions.length !== 1 || !versions[0]) {
    throw new Error(`the version sources disagree (${sources.map(({ file, version }) => `${file} ${version ?? 'names none'}`).join(', ')}): they move together, to the version the release publishes`)
  }
  return checkVersion(versions[0])
}

/** Whether `version` is in the caret range `range` (^X.Y.Z, as npm reads it; no prerelease). */
export function inCaretRange(version, range) {
  const parse = (text) => /^(\d+)\.(\d+)\.(\d+)$/.exec(text)?.slice(1).map(Number)
  const low = parse(range.replace(/^\^/, ''))
  const found = parse(version)
  if (!range.startsWith('^') || !low) throw new Error(`${range} is not a caret range ^X.Y.Z`)
  if (!found) return false
  const [major, minor, patch] = found
  const compare = major - low[0] || minor - low[1] || patch - low[2]
  if (compare < 0) return false
  if (low[0] > 0) return major === low[0]
  if (low[1] > 0) return major === 0 && minor === low[1]
  return major === 0 && minor === 0 && patch === low[2]
}

/**
 * A release's target from the workflow's inputs: `scope` (@kition for the real release, another
 * scope for a rehearsal), `version` ('' for the default), `platforms` ('' for the default),
 * `tessera` (the published <scope>/tessera@<version> the SDK is checked with) and the workflow's
 * `runNumber`. Every version source must agree (`sources`, default this checkout's).
 *
 * The real release publishes exactly that version, for every platform, with @kition/tessera at a
 * version in RELEASE_TESSERA_RANGE, which its @kition/sdk names as its peer range. A rehearsal
 * publishes <version>-stage.<run number> unless given another, for STAGE_PLATFORMS unless given
 * others, with its peer at the rehearsal Tessera's exact version.
 */
export function releaseTarget({ scope, version = '', platforms = '', tessera, runNumber, sources = versionSources() }) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) throw new Error(`"${scope}" is not an npm scope (${SCOPE.source})`)
  const base = checkVersionSources(sources)
  const real = scope === REAL_SCOPE
  const peer = parseTessera(tessera)
  let list
  if (real) {
    if (version && version !== base) throw new Error(`the real release publishes ${base}, the version every source names, not ${version}: the owner moves sdk.json, crates/kition-cli/Cargo.toml, packages/kition/package.json and packages/sdk/package.json together first`)
    version = base
    if (/-/.test(version)) throw new Error(`the real release does not publish a prerelease (${version})`)
    list = platforms ? checkPlatforms(platforms) : [...CLI_PLATFORMS]
    if ([...list].sort().join() !== [...CLI_PLATFORMS].sort().join()) throw new Error(`the real release publishes kition for every platform (${CLI_PLATFORMS.join(', ')}), not ${list.join(', ')}`)
    list = [...CLI_PLATFORMS]
    if (peer.name !== TESSERA || !inCaretRange(peer.version, RELEASE_TESSERA_RANGE)) throw new Error(`the real release is checked with ${TESSERA} at a published version in ${RELEASE_TESSERA_RANGE}, not ${tessera}`)
  } else {
    if (!version) {
      if (!/^[1-9]\d*$/.test(String(runNumber ?? ''))) throw new Error(`a rehearsal's default version needs the run number, not ${runNumber}`)
      version = `${base}-stage.${runNumber}`
    }
    checkVersion(version)
    list = platforms ? checkPlatforms(platforms) : [...STAGE_PLATFORMS]
  }
  return {
    scope,
    real,
    version,
    platforms: list,
    tessera: `${peer.name}@${peer.version}`,
    peer: real ? RELEASE_TESSERA_RANGE : peer.version,
    names: { platforms: Object.fromEntries(list.map((platform) => [platform, `${scope}/cli-${platform}`])), cli: `${scope}/cli`, sdk: `${scope}/sdk` },
  }
}

/** Throws unless `target` is a release target as releaseTarget gives it (read back from JSON). */
function checkReleaseTarget(target) {
  const again = releaseTarget({ scope: target?.scope, version: target?.version, platforms: target?.platforms?.join(','), tessera: target?.tessera, runNumber: 1, sources: [{ file: 'target', version: target?.real ? target.version : '0.0.0' }] })
  if (JSON.stringify(again) !== JSON.stringify(target)) throw new Error('the release target is not one releaseTarget gives')
  return target
}

/**
 * The installers the launcher carries, and the one line in each that names the npm scope of the
 * packages they install: install/install.sh's `scope='@kition'` and install/install.ps1's
 * `$scope = '@kition'`. A rehearsal's launcher names its own scope there (installerWithScope).
 */
export const INSTALLERS = {
  'install.sh': "^scope='([^'\\n]*)'",
  'install.ps1': "^\\$scope = '([^'\\n]*)'",
}
const scopeLines = (file) => new RegExp(INSTALLERS[file], 'gm')

/** The scope `text` (an installer, by its file name `file`) names; throws unless one line names one. */
export function installerScope(file, text) {
  const found = [...text.matchAll(scopeLines(file))]
  if (found.length !== 1) throw new Error(`${file} names its npm scope on ${found.length} lines, not one (${INSTALLERS[file]})`)
  return found[0][1]
}

/** `text` with its scope line naming `scope`; nothing else changes. */
export function installerWithScope(file, text, scope) {
  if (!SCOPE.test(scope)) throw new Error(`"${scope}" is not an npm scope (${SCOPE.source})`)
  installerScope(file, text)
  return text.replace(scopeLines(file), (line, named) => line.replace(`'${named}'`, `'${scope}'`))
}

/**
 * What is wrong with an installer that should install `scope`'s packages: its scope line names
 * another, or a line of code (not a comment) names @kition by hand rather than through it.
 */
export function installerProblems(file, text, scope) {
  const problems = []
  try {
    const named = installerScope(file, text)
    if (named !== scope) problems.push(`${file} installs ${named}'s packages, not ${scope}'s`)
  } catch (error) {
    problems.push(error.message)
  }
  const line = new RegExp(INSTALLERS[file])
  text.split('\n').forEach((code, at) => {
    if (/^\s*#/.test(code) || line.test(code)) return
    if (/@kition(?![a-z0-9-])/.test(code)) problems.push(`${file}:${at + 1} names @kition itself: ${code.trim()}`)
  })
  return problems
}

/**
 * A packed command-line package's manifest as the rehearsal publishes it: @kition/cli becomes
 * <scope>/cli at `version`, depending optionally on <scope>/cli-<platform>@<version> for each of
 * `platforms` and nothing else; @kition/cli-<platform> becomes <scope>/cli-<platform> at `version`
 * (its description names the renamed launcher). Every other field as it was, in its place.
 */
export function stageCliManifest(manifest, { scope, version, platforms }) {
  checkScope(scope)
  checkVersion(version)
  const launcher = `${scope}/cli`
  if (manifest?.name === CLI) {
    const optionalDependencies = Object.fromEntries(checkPlatforms(platforms).map((platform) => [`${launcher}-${platform}`, version]))
    return { ...manifest, name: launcher, version, optionalDependencies }
  }
  const platform = manifest?.name?.startsWith(`${CLI}-`) ? manifest.name.slice(CLI.length + 1) : null
  if (!platform || !CLI_PLATFORMS.includes(platform)) throw new Error(`the package is ${manifest?.name}, not ${CLI} or ${CLI}-<platform>`)
  if (platforms !== undefined && !checkPlatforms(platforms).includes(platform)) throw new Error(`${manifest.name} is not one of the platforms ${checkPlatforms(platforms).join(', ')}`)
  return { ...manifest, name: `${launcher}-${platform}`, version, ...(typeof manifest.description === 'string' ? { description: manifest.description.split(CLI).join(launcher) } : {}) }
}

/**
 * The packed @kition/sdk's manifest as the rehearsal publishes it: name <scope>/sdk, `version`, the
 * peer @kition/tessera at the exact version of `tessera`; every other field as it was, in its place.
 */
export function stageManifest(manifest, { scope, version, tessera }) {
  const target = checkTarget({ scope, version, tessera })
  if (manifest?.name !== SDK) throw new Error(`the package is ${manifest?.name}, not ${SDK}`)
  if (!manifest.peerDependencies || !Object.hasOwn(manifest.peerDependencies, TESSERA)) throw new Error(`${SDK} has no peer ${TESSERA}`)
  return {
    ...manifest,
    name: `${target.scope}/sdk`,
    version: target.version,
    peerDependencies: { ...manifest.peerDependencies, [TESSERA]: target.tessera.version },
  }
}

// Paths given to tar are relative, with forward slashes: Git for Windows' GNU tar reads D:\... as a remote host.
const posixRelative = (from, to) => path.relative(from, to).split(path.sep).join('/') || '.'

const inside = (dir, parent) => {
  const relative = path.relative(parent, dir)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * A packed package's manifest as the release `target` (releaseTarget) publishes it. A rehearsal:
 * stageManifest or stageCliManifest for the target's platforms. The real release: the packed
 * version must be the target's; @kition/sdk names its Tessera peer at the target's range, the
 * launcher depends on every platform package at the version; nothing else changes.
 */
export function releaseManifest(manifest, target) {
  checkReleaseTarget(target)
  const { scope, version, platforms, tessera } = target
  if (!target.real) return manifest?.name === SDK ? stageManifest(manifest, { scope, version, tessera }) : stageCliManifest(manifest, { scope, version, platforms })
  if (manifest?.version !== version) throw new Error(`the package is ${manifest?.name}@${manifest?.version}; the release publishes ${version}`)
  if (manifest.name === SDK) {
    if (!manifest.peerDependencies || !Object.hasOwn(manifest.peerDependencies, TESSERA)) throw new Error(`${SDK} has no peer ${TESSERA}`)
    return { ...manifest, peerDependencies: { ...manifest.peerDependencies, [TESSERA]: target.peer } }
  }
  if (manifest.name === CLI) return { ...manifest, optionalDependencies: Object.fromEntries(platforms.map((platform) => [`${CLI}-${platform}`, version])) }
  const platform = manifest.name?.startsWith(`${CLI}-`) ? manifest.name.slice(CLI.length + 1) : null
  if (!platform || !CLI_PLATFORMS.includes(platform)) throw new Error(`the package is ${manifest.name}, not ${SDK}, ${CLI} or ${CLI}-<platform>`)
  return manifest
}

/**
 * Copies the packed package `from` (its archive, or the folder it unpacks to) into `<out>/package`,
 * rewrites its manifest by `rewrite` (and a launcher's installers to the scope of its new name),
 * and packs the copy into `<out>` with npm (no scripts: the manifest keeps `prepack`, which builds
 * from a checkout). `out` is an empty or new folder outside this checkout. Fails when the new
 * archive holds other files than `from` or another manifest.
 */
function copyPackage({ from, out, rewrite }) {
  from = path.resolve(from)
  out = path.resolve(out)
  if (!fs.existsSync(from)) throw new Error(`${from} does not exist`)
  if (inside(out, root) || inside(root, out)) throw new Error(`${out} is in this checkout (or holds it): write the copy outside it`)
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`)
  const dir = path.join(out, 'package')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.statSync(from).isDirectory()) {
    if (fs.existsSync(path.join(from, 'node_modules'))) throw new Error(`${from} has node_modules: pass the packed package, not a source folder`)
    fs.cpSync(from, dir, { recursive: true })
  } else {
    execFileSync('tar', ['-xzf', path.basename(from), '-C', posixRelative(path.dirname(from), dir), '--strip-components=1'], { cwd: path.dirname(from) })
  }
  const manifestFile = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`${from} has no package.json`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const staged = rewrite(manifest)
  fs.writeFileSync(manifestFile, `${JSON.stringify(staged, null, 2)}\n`)
  // The launcher's installers install the platform package of its own scope.
  if (manifest.name === CLI) {
    for (const installer of Object.keys(INSTALLERS)) {
      const file = path.join(dir, 'dist', installer)
      if (fs.existsSync(file)) fs.writeFileSync(file, installerWithScope(installer, fs.readFileSync(file, 'utf8'), staged.name.split('/')[0]))
    }
  }

  const listed = (folder) => fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()
  const files = listed(dir)
  // npm is npm.cmd on Windows, which Node starts only through a shell.
  const windows = process.platform === 'win32'
  const [packed] = JSON.parse(execFileSync(windows ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', '..'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: windows }))
  const tarball = path.join(out, packed.filename)
  const inArchive = execFileSync('tar', ['-tzf', packed.filename], { cwd: out, encoding: 'utf8' }).trim().split('\n').filter((file) => !file.endsWith('/')).map((file) => file.replace(/^package\//, '')).sort()
  if (JSON.stringify(inArchive) !== JSON.stringify(files)) throw new Error(`the copy's archive holds other files than the package: ${inArchive.filter((file) => !files.includes(file)).concat(files.filter((file) => !inArchive.includes(file))).join(', ')}`)
  const manifestOut = JSON.parse(execFileSync('tar', ['-xOzf', packed.filename, 'package/package.json'], { cwd: out, encoding: 'utf8' }))
  if (JSON.stringify(manifestOut) !== JSON.stringify(staged)) throw new Error("the copy's archive holds another package.json than the one written")
  return { tarball, name: staged.name, version: staged.version, integrity: integrityOf(fs.readFileSync(tarball)) }
}

/**
 * The rehearsal copy of a packed @kition/sdk (with `tessera`) or of the command line (with
 * `platforms`) at `scope` (never @kition) and `version`, by stageManifest or stageCliManifest.
 */
export function stagePackage({ from, out, scope, version, tessera, platforms }) {
  checkScope(scope)
  checkVersion(version)
  let sdk = false
  const result = copyPackage({
    from,
    out,
    rewrite: (manifest) => {
      sdk = manifest.name === SDK
      return sdk ? stageManifest(manifest, { scope, version, tessera }) : stageCliManifest(manifest, { scope, version, platforms })
    },
  })
  if (!sdk) return result
  const target = parseTessera(tessera)
  return { ...result, tessera: `${target.name}@${target.version}` }
}

/** The copy of a packed package that the release `target` publishes (releaseManifest). */
export function releasePackage({ from, out, target }) {
  checkReleaseTarget(target)
  return copyPackage({ from, out, rewrite: (manifest) => releaseManifest(manifest, target) })
}

/** The archive names of the release's copies in the folder `order` reads. */
export const releaseArchives = (target) => [...target.platforms.map((platform) => [`cli-${platform}.tgz`, target.names.platforms[platform]]), ['cli.tgz', target.names.cli], ['sdk.tgz', target.names.sdk]]

/**
 * The release's copies in `dir`, in the order they are published: each platform package, the
 * launcher that depends on them, the SDK; each [{ archive, name, version, integrity }]. Throws
 * unless `dir` holds exactly them, each named and versioned as the target says, the launcher
 * depending on exactly the platform packages and carrying installers of the target's scope, and
 * the SDK naming its Tessera peer at the target's range.
 */
export function publishOrder({ dir, target }) {
  checkReleaseTarget(target)
  const expected = releaseArchives(target)
  const present = fs.readdirSync(dir).filter((file) => file.endsWith('.tgz')).sort()
  const wanted = expected.map(([file]) => file).sort()
  if (JSON.stringify(present) !== JSON.stringify(wanted)) throw new Error(`${dir} holds ${present.join(', ') || 'no archive'}; the release publishes exactly ${wanted.join(', ')}`)
  return expected.map(([file, name]) => {
    // Relative paths: Git for Windows' GNU tar reads D:\... as a remote host.
    const read = (inner) => execFileSync('tar', ['-xzOf', file, `package/${inner}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const manifest = JSON.parse(read('package.json'))
    if (manifest.name !== name || manifest.version !== target.version) throw new Error(`${file} is ${manifest.name}@${manifest.version}, not ${name}@${target.version}`)
    if (name === target.names.cli) {
      const optional = Object.fromEntries(target.platforms.map((platform) => [target.names.platforms[platform], target.version]))
      if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(optional)) throw new Error(`${name} depends on ${JSON.stringify(manifest.optionalDependencies)}, not ${JSON.stringify(optional)}`)
      for (const installer of Object.keys(INSTALLERS)) {
        let text
        try {
          text = read(`dist/${installer}`)
        } catch {
          throw new Error(`${name} carries no dist/${installer}`)
        }
        const problems = installerProblems(installer, text, target.scope)
        if (problems.length) throw new Error(`${name}'s dist/${installer}: ${problems.join('; ')}`)
      }
    }
    if (name === target.names.sdk && manifest.peerDependencies?.[TESSERA] !== target.peer) throw new Error(`${name} names its peer ${TESSERA} at ${manifest.peerDependencies?.[TESSERA]}, not ${target.peer}`)
    const archive = path.join(dir, file)
    return { archive, name, version: manifest.version, integrity: integrityOf(fs.readFileSync(archive)) }
  })
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name)
    const value = at >= 0 ? argv[at + 1] : undefined
    if (value === undefined || value.startsWith('--')) throw new Error(`needs ${name}`)
    return value
  }
  const readTarget = () => JSON.parse(fs.readFileSync(flag('--target'), 'utf8'))
  switch (argv[0]) {
    case 'target':
      console.log(JSON.stringify(releaseTarget({ scope: flag('--scope'), version: flag('--version'), platforms: flag('--platforms'), tessera: flag('--tessera'), runNumber: flag('--run-number') })))
      return
    case 'release':
      console.log(JSON.stringify(releasePackage({ from: flag('--from'), out: flag('--out'), target: readTarget() })))
      return
    case 'order':
      for (const { archive, name, version, integrity } of publishOrder({ dir: flag('--dir'), target: readTarget() })) console.log(`${archive} ${name} ${version} ${integrity}`)
      return
  }
  if (argv.includes('--platforms')) {
    const target = { scope: checkScope(flag('--scope')), version: checkVersion(flag('--version')), platforms: checkPlatforms(flag('--platforms')) }
    if (argv.includes('--check')) {
      console.log(`${target.scope}/cli@${target.version} with ${target.platforms.map((platform) => `${target.scope}/cli-${platform}`).join(', ')}`)
      return
    }
    console.log(JSON.stringify(stagePackage({ from: flag('--from'), out: flag('--out'), ...target })))
    return
  }
  const target = { scope: flag('--scope'), version: flag('--version'), tessera: flag('--tessera') }
  if (argv.includes('--check')) {
    const checked = checkTarget(target)
    console.log(`${checked.scope}/sdk@${checked.version} with ${TESSERA} at ${checked.tessera.name}@${checked.tessera.version}`)
    return
  }
  console.log(JSON.stringify(stagePackage({ from: flag('--from'), out: flag('--out'), ...target })))
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`stage-package: ${error.message}`)
    process.exit(1)
  }
}
