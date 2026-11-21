#!/usr/bin/env node
// A rehearsal copy of the packed @kition/sdk under another npm scope, for the Stage workflow
// (.github/workflows/stage.yml): @kition/sdk becomes <scope>/sdk at a version of one's choosing, and
// its optional peer @kition/tessera keeps that name (a consumer aliases it:
// "@kition/tessera": "npm:<scope>/tessera@<version>") with its range set to the exact version of
// the rehearsal Tessera it is checked with. Everything else in it (files, exports, dependencies,
// README) stays as packed. It works on a copy: the archive or folder it is given, and this
// checkout's tracked files, are never touched. Nothing is published.
//
//   node tools/stage-package.mjs --from <sdk.tgz | unpacked folder> --scope <@scope> --version <version>
//        --tessera <@scope/tessera@version> --out <empty folder outside this checkout>
//       writes <out>/package/ and its archive (npm pack, no scripts) and prints JSON
//       { tarball, name, version, integrity, tessera }
//   node tools/stage-package.mjs --check --scope <@scope> --version <version> --tessera <spec>
//       only checks the three
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrityOf } from './kit-npm.mjs'
import { SDK, TESSERA } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const inside = (dir, parent) => {
  const relative = path.relative(parent, dir)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Copies the packed package `from` (its archive, or the folder it unpacks to) into `<out>/package`,
 * rewrites its manifest by stageManifest, and packs the copy into `<out>` with npm (no scripts: the
 * manifest keeps `prepack`, which builds from a checkout). `out` is an empty or new folder outside
 * this checkout. Fails when the new archive holds other files than `from` or another manifest.
 */
export function stagePackage({ from, out, scope, version, tessera }) {
  const target = checkTarget({ scope, version, tessera })
  from = path.resolve(from)
  out = path.resolve(out)
  if (!fs.existsSync(from)) throw new Error(`${from} does not exist`)
  if (inside(out, root) || inside(root, out)) throw new Error(`${out} is in this checkout (or holds it): write the rehearsal copy outside it`)
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`)
  const dir = path.join(out, 'package')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.statSync(from).isDirectory()) {
    if (fs.existsSync(path.join(from, 'node_modules'))) throw new Error(`${from} has node_modules: pass the packed package, not a source folder`)
    fs.cpSync(from, dir, { recursive: true })
  } else {
    execFileSync('tar', ['-xzf', from, '-C', dir, '--strip-components=1'])
  }
  const manifestFile = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`${from} has no package.json`)
  const staged = stageManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), { scope, version, tessera })
  fs.writeFileSync(manifestFile, `${JSON.stringify(staged, null, 2)}\n`)

  const listed = (folder) => fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()
  const files = listed(dir)
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const tarball = path.join(out, packed.filename)
  const inArchive = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').filter((file) => !file.endsWith('/')).map((file) => file.replace(/^package\//, '')).sort()
  if (JSON.stringify(inArchive) !== JSON.stringify(files)) throw new Error(`the rehearsal archive holds other files than the package: ${inArchive.filter((file) => !files.includes(file)).concat(files.filter((file) => !inArchive.includes(file))).join(', ')}`)
  const manifestOut = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  if (JSON.stringify(manifestOut) !== JSON.stringify(staged)) throw new Error('the rehearsal archive holds another package.json than the one written')
  return { tarball, name: staged.name, version: staged.version, integrity: integrityOf(fs.readFileSync(tarball)), tessera: `${target.tessera.name}@${target.tessera.version}` }
}

function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name)
    const value = at >= 0 ? argv[at + 1] : undefined
    if (value === undefined || value.startsWith('--')) throw new Error(`needs ${name}`)
    return value
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
