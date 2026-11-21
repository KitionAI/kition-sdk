#!/usr/bin/env node
// Moves a consumer project from the SDK's twelve library packages to @kition/sdk, by the mapping in
// tools/sdk-package.mjs (`@kition/kit-editor/styles.css` -> `@kition/sdk/editor/styles.css`):
//
//   node tools/migrate-to-sdk.mjs <folder> [--check] [--sdk-spec <spec>] [--tessera-spec <spec>]
//
// - In code, styles and pages (.js .jsx .mjs .cjs .ts .tsx .mts .cts .vue .svelte .css .scss .less
//   .html): every module specifier that is one of the old names or a subpath of one becomes its
//   @kition/sdk subpath: `from '...'`, `import '...'`, import(), require(), require.resolve(),
//   import.meta.resolve(), a test runner's vi.*()/jest.*(), `declare module '...'`, and CSS's
//   @import, @use and @forward. Any other quoted old name (a package name in a config, such as
//   Vite's resolve.dedupe or optimizeDeps, where a subpath is no package) is listed for a person.
// - Package manager hooks (.pnpmfile.cjs, .pnpmfile.mjs, .yarnrc.yml) name packages, not modules:
//   never rewritten; an old name there is listed for a person.
// - In each package.json: the old names leave dependencies, devDependencies, peerDependencies and
//   optionalDependencies (and peerDependenciesMeta); @kition/sdk takes the place of the first, once,
//   in the most runtime of dependencies, optionalDependencies and devDependencies that had one (and
//   in peerDependencies when they had one), at `--sdk-spec` (default ^<packages/sdk's version>). When
//   @kition/kit-editor was there, @kition/sdk/editor imports Tessera as the one package
//   @kition/tessera (an optional peer of @kition/sdk): it is added beside @kition/sdk at
//   packages/sdk's peer range when the project names no Tessera package. A project that still names
//   Tessera's three old packages (@kition/tessera-ui, -icons, -tokens) gets a note instead: they
//   move to @kition/tessera, in package.json and in the code, with kition-tessera's
//   scripts/migrate-to-tessera.mjs (this tool leaves them alone). An old name in overrides,
//   pnpm.overrides or resolutions is listed for a person: what it points at is the project's choice.
// - --sdk-spec <spec> and --tessera-spec <spec> name what package.json gets for @kition/sdk and
//   @kition/tessera, exactly as given: a range, or an npm alias such as
//   npm:@kitionstage/sdk@0.5.2-stage.4 (a rehearsal, the Stage workflow's lines). Given, they also
//   replace the entry a project has already (a project moved before, now pointed at a rehearsal).
//   --tessera-spec adds @kition/tessera for the editor even when Tessera's old packages are there
//   (still with the note: migrate-to-tessera.mjs then drops them and keeps this entry).
// - Lockfiles (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, yarn.lock, bun.lock,
//   bun.lockb) are never touched: run the package manager's install afterwards. node_modules, .git
//   and build output (dist, build, target, coverage, .next, .turbo) are skipped.
//
// --check writes nothing, lists what would change, and exits 1 when anything would.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OLD_TESSERA, PARTS, SDK, TESSERA, packageOf, sdkSpecifier } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK_MANIFEST = JSON.parse(fs.readFileSync(path.join(root, 'packages/sdk/package.json'), 'utf8'))

export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.svelte-kit'])
const SOURCES = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|html)$/
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const OLD = new Set(PARTS.map((part) => part.name))

/** Where a quoted string is a module specifier: the code before the quote ends with one of these. */
const SPECIFIER_LEAD = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require|require\.resolve|import\.meta\.resolve|(?:vi|jest)\.[A-Za-z]+)\s*\(\s*|\bdeclare\s+module\s+|@(?:import|use|forward)\s+(?:url\(\s*)?)$/

/**
 * `text` with every old module specifier as @kition/sdk names it: { text, changes: [{ from, to }],
 * notes: [...] }, the notes naming each other quoted old name (line and text) for a person.
 */
export function migrateText(text) {
  const changes = []
  const notes = []
  const next = text.replace(/(['"`])(@kition\/[a-z0-9-]+(?:\/[^'"`\s]*)?)\1/g, (whole, quote, specifier, offset) => {
    const to = sdkSpecifier(specifier)
    if (!to) return whole
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1
    if (!SPECIFIER_LEAD.test(text.slice(Math.max(lineStart, offset - 80), offset))) {
      const line = text.slice(0, offset).split('\n').length
      notes.push(`line ${line}: ${specifier} is named here as something other than an import (${text.slice(lineStart, text.indexOf('\n', offset) === -1 ? undefined : text.indexOf('\n', offset)).trim().slice(0, 120)}); change it by hand (the package is ${SDK}, its subpath ${to})`)
      return whole
    }
    changes.push({ from: specifier, to })
    return `${quote}${to}${quote}`
  })
  return { text: next, changes, notes }
}

/** Package manager hooks: they name packages, not modules. */
export const PACKAGE_MANAGER_FILES = ['.pnpmfile.cjs', '.pnpmfile.mjs', '.yarnrc.yml']

/**
 * A package.json's object with the old names replaced by @kition/sdk: { manifest, changes, notes }.
 * `sdkSpec` is what @kition/sdk is added at (default ^<packages/sdk's version>), `tesseraSpec` what
 * @kition/tessera is added at (default packages/sdk's peer range); given, each also replaces the
 * project's own entry.
 */
export function migrateManifest(manifest, { sdkSpec, tesseraSpec } = {}) {
  const version = sdkSpec ?? `^${SDK_MANIFEST.version}`
  const next = structuredClone(manifest)
  const changes = []
  const notes = []
  const has = (section) => Object.keys(next[section] ?? {}).some((name) => OLD.has(name))
  // @kition/sdk goes once into the most runtime of dependencies, optionalDependencies and
  // devDependencies that named an old package (the others only lose them); peerDependencies keep
  // their own entry.
  const home = ['dependencies', 'optionalDependencies', 'devDependencies'].find(has)
  const hadEditor = SECTIONS.some((section) => Object.hasOwn(next[section] ?? {}, '@kition/kit-editor'))
  for (const section of SECTIONS) {
    const deps = next[section]
    if (!deps || typeof deps !== 'object' || !has(section)) continue
    const adds = section === home || section === 'peerDependencies'
    const rebuilt = {}
    let placed = Object.hasOwn(deps, SDK) || !adds
    for (const [name, range] of Object.entries(deps)) {
      if (!OLD.has(name)) {
        rebuilt[name] = range
        continue
      }
      changes.push({ from: `${section}: ${name}@${range}`, to: placed ? `(${SDK} ${adds ? 'already there' : `in ${home}`})` : `${section}: ${SDK}@${version}` })
      if (!placed) {
        rebuilt[SDK] = version
        placed = true
      }
    }
    next[section] = rebuilt
  }
  // An entry the project has already takes a spec given.
  const respec = (name, spec) => {
    for (const section of SECTIONS) {
      const deps = next[section]
      if (!deps || typeof deps !== 'object' || !Object.hasOwn(deps, name) || deps[name] === spec) continue
      changes.push({ from: `${section}: ${name}@${deps[name]}`, to: `${section}: ${name}@${spec}` })
      deps[name] = spec
    }
  }
  if (sdkSpec !== undefined) respec(SDK, sdkSpec)
  // Tessera came with @kition/kit-editor; @kition/sdk/editor imports it as @kition/tessera, an
  // optional peer of @kition/sdk. Its three old packages move with kition-tessera's own codemod.
  const oldTessera = [...new Set(SECTIONS.flatMap((section) => Object.keys(next[section] ?? {}).filter((name) => OLD_TESSERA.includes(name))))]
  const hasTessera = SECTIONS.some((section) => Object.hasOwn(next[section] ?? {}, TESSERA))
  if (hasTessera) {
    if (tesseraSpec !== undefined) respec(TESSERA, tesseraSpec)
  } else {
    // Beside @kition/sdk for the editor; with a spec given, beside Tessera's old packages too.
    const at = hadEditor && home ? home : tesseraSpec !== undefined ? SECTIONS.find((section) => Object.keys(next[section] ?? {}).some((name) => OLD_TESSERA.includes(name))) : undefined
    if (at && (tesseraSpec !== undefined || !oldTessera.length)) {
      const range = tesseraSpec ?? SDK_MANIFEST.peerDependencies[TESSERA]
      next[at] = { ...next[at], [TESSERA]: range }
      changes.push({ from: `${at}: (Tessera ${hadEditor ? 'came with @kition/kit-editor' : `was ${oldTessera.join(', ')}`})`, to: `${at}: ${TESSERA}@${range}` })
    }
  }
  if (oldTessera.length) notes.push(`${oldTessera.join(', ')}: Tessera is one package now, ${TESSERA}, which ${SDK}/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs <folder> (its package.json and its imports)`)
  const meta = next.peerDependenciesMeta
  if (meta && typeof meta === 'object') {
    const old = Object.keys(meta).filter((name) => OLD.has(name))
    if (old.length) {
      const optional = old.every((name) => meta[name]?.optional)
      for (const name of old) delete meta[name]
      if (!meta[SDK]) meta[SDK] = { optional }
      changes.push({ from: `peerDependenciesMeta: ${old.join(', ')}`, to: `peerDependenciesMeta: ${SDK}` })
    }
  }
  for (const [where, overrides] of [['overrides', next.overrides], ['pnpm.overrides', next.pnpm?.overrides], ['resolutions', next.resolutions]]) {
    for (const key of Object.keys(overrides ?? {})) {
      const name = packageOf(key.replace(/@[^@/]*$/, '').replace(/^.*>/, ''))
      if (OLD.has(name)) notes.push(`${where}: ${key} -> ${JSON.stringify(overrides[key])} names ${name}; point it at ${SDK} by hand`)
    }
  }
  return { manifest: next, changes, notes }
}

/** The files `migrateFolder` reads under `dir`: package.json files and sources, lockfiles never. */
function* filesUnder(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) yield* filesUnder(path.join(dir, entry.name))
    } else if (entry.isFile() && !LOCKFILES.includes(entry.name) && (entry.name === 'package.json' || PACKAGE_MANAGER_FILES.includes(entry.name) || SOURCES.test(entry.name))) {
      yield path.join(dir, entry.name)
    }
  }
}

/** Migrates every file under `dir` (writes nothing with `check`): [{ file, changes, notes }] of the files that change or need a hand. */
export function migrateFolder(dir, { check = false, sdkSpec, tesseraSpec } = {}) {
  const report = []
  for (const file of filesUnder(dir)) {
    const text = fs.readFileSync(file, 'utf8')
    if (path.basename(file) === 'package.json') {
      let manifest
      try {
        manifest = JSON.parse(text)
      } catch {
        continue
      }
      const migrated = migrateManifest(manifest, { sdkSpec, tesseraSpec })
      if (!migrated.changes.length && !migrated.notes.length) continue
      if (!check && migrated.changes.length) fs.writeFileSync(file, `${JSON.stringify(migrated.manifest, null, text.match(/^\{\n(\s+)/)?.[1] ?? 2)}${text.endsWith('\n') ? '\n' : ''}`)
      report.push({ file, changes: migrated.changes, notes: migrated.notes })
      continue
    }
    const migrated = migrateText(text)
    if (PACKAGE_MANAGER_FILES.includes(path.basename(file))) {
      const named = [...new Set([...migrated.changes.map(({ from }) => from), ...migrated.notes.map((note) => /: (@kition\/[^ ]+) is named/.exec(note)?.[1])])].filter(Boolean)
      if (named.length) report.push({ file, changes: [], notes: [`a package manager hook naming ${named.join(', ')}: point it at ${SDK} by hand`] })
      continue
    }
    if (!migrated.changes.length && !migrated.notes.length) continue
    if (!check && migrated.changes.length) fs.writeFileSync(file, migrated.text)
    report.push({ file, changes: migrated.changes, notes: migrated.notes })
  }
  return report
}

function main(argv) {
  const usage = () => {
    console.error('usage: migrate-to-sdk.mjs <folder> [--check] [--sdk-spec <spec>] [--tessera-spec <spec>]')
    process.exit(2)
  }
  const options = {}
  const folders = []
  let check = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--sdk-spec' || arg === '--tessera-spec') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) usage()
      options[arg === '--sdk-spec' ? 'sdkSpec' : 'tesseraSpec'] = value
    } else if (arg.startsWith('--')) usage()
    else folders.push(arg)
  }
  if (folders.length !== 1) usage()
  const dir = path.resolve(folders[0])
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`migrate-to-sdk: ${folders[0]} is not a folder`)
    process.exit(2)
  }
  const report = migrateFolder(dir, { check, ...options })
  let changed = 0
  for (const { file, changes, notes } of report) {
    const where = path.relative(process.cwd(), file) || file
    if (changes.length) changed++
    console.log(`${where}:`)
    const counted = new Map()
    for (const { from, to } of changes) counted.set(`${from} -> ${to}`, (counted.get(`${from} -> ${to}`) ?? 0) + 1)
    for (const [line, times] of counted) console.log(`  ${line}${times > 1 ? ` (${times})` : ''}`)
    for (const note of notes) console.log(`  by hand: ${note}`)
  }
  const byHand = report.reduce((sum, { notes }) => sum + notes.length, 0)
  console.log(`${changed} file(s) ${check ? 'would change' : 'changed'}${byHand ? `, ${byHand} place(s) to change by hand` : ''}${check || !changed ? '' : '; run the package manager\'s install (lockfiles were not touched)'}`)
  process.exit(check && changed ? 1 : 0)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
