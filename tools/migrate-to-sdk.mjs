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
//   @import, @use and @forward.
// - Package-name lists (a bundler config's exclude, include, dedupe, noExternal and external arrays
//   of plain strings): an old package name becomes the package @kition/sdk (a package name names
//   the package, not a subpath), once per list; a Vite nested dependency such as
//   '@kition/kit-editor > use-sync-external-store/shim' becomes '@kition/sdk > ...' wherever it is
//   quoted. A rewritten `external` is also listed for a person: Rollup's external matches whole
//   module ids, so '@kition/sdk' does not cover '@kition/sdk/editor'.
// - Listed for a person, with the file's line, what it is and what replaces it: any other quoted
//   old name; an old name unquoted (a comment) or regex-escaped (@kition\/kdm, @kition\\/kdm); a
//   package name built from parts (`@kition/${name}`); a path into a kition-sdk checkout's
//   packages/<old folder> (an alias table, an import of packages/kit-dev-host/src/modeSmoke.mjs),
//   with the @kition/sdk subpath that replaces the file when there is one.
// - Package manager hooks (.pnpmfile.cjs, pnpmfile.js and their .mjs/.cjs/.js variants,
//   .yarnrc.yml) name packages and checkout folders, often built from short names: never
//   rewritten; every line that names an @kition package other than @kition/sdk and @kition/tessera,
//   a kition-sdk packages/ folder other than packages/sdk, or an old package's short name, is listed.
// - In each package.json: the old names leave dependencies, devDependencies, peerDependencies and
//   optionalDependencies (and peerDependenciesMeta); @kition/sdk goes once, in sorted position (the
//   other keys keep their order), into the most runtime of dependencies, optionalDependencies and
//   devDependencies that had one (and into peerDependencies when they had one), at `--sdk-spec`
//   (default ^<packages/sdk's version>). When @kition/kit-editor was there, @kition/sdk/editor
//   imports Tessera as the one package @kition/tessera (an optional peer of @kition/sdk): it is
//   added beside @kition/sdk, also in sorted position, at packages/sdk's peer range when the project
//   names no Tessera package. A project that still names Tessera's three old packages
//   (@kition/tessera-ui, -icons, -tokens) gets a note instead: they move to @kition/tessera, in
//   package.json and in the code, with kition-tessera's scripts/migrate-to-tessera.mjs (this tool
//   leaves them alone). An old name in overrides, pnpm.overrides or resolutions is listed for a
//   person: what it points at is the project's choice.
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
// The report ends with two lists: "changed" (each file and its rewrites) and "needs a person"
// (file:line, what is there, what replaces it; lines are the file's as written). --check writes
// nothing and exits 1 when either list has anything; without it, the files are written, both lists
// printed, and the exit is 0.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OLD_TESSERA, PARTS, SDK, TESSERA, packageOf, sdkSpecifier, subpaths } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK_MANIFEST = JSON.parse(fs.readFileSync(path.join(root, 'packages/sdk/package.json'), 'utf8'))

export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.svelte-kit'])
const SOURCES = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|html)$/
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const OLD = new Set(PARTS.map((part) => part.name))

/** Package manager hooks: they name packages and checkout folders, not modules. */
export const isPackageManagerFile = (name) => /^(?:\.?pnpmfile\.[cm]?js|\.yarnrc\.yml)$/.test(name)

/** Where a quoted string is a module specifier: the code before the quote ends with one of these. */
const SPECIFIER_LEAD = /(?:\bfrom\s*|\bimport\s*|\b(?:import|require|require\.resolve|import\.meta\.resolve|(?:vi|jest)\.[A-Za-z]+)\s*\(\s*|\bdeclare\s+module\s+|@(?:import|use|forward)\s+(?:url\(\s*)?)$/

/** The old packages' short names, which are also their folders under kition-sdk's packages/. */
const SHORT = PARTS.map((part) => part.dir).sort((a, b) => b.length - a.length).join('|')
/** An old name in any spelling: @kition/<short>, or regex-escaped @kition\/<short>, @kition\\/<short>. */
const OLD_ANY = new RegExp(String.raw`@kition(?:\/|\\\/|\\\\\/)(${SHORT})(?![\w-])`, 'g')
/** A package name built from parts: `@kition/${...}`. */
const BUILT_NAME = /@kition\/\$\{/
/** A path into a kition-sdk checkout's packages/<old folder>, as a path or as path.join's parts. */
const CHECKOUT_PATH = new RegExp(String.raw`packages(?:\/|['"]\s*,\s*['"])(${SHORT})(?![\w-])((?:\/[\w.@-]+)*)`, 'g')
/** Lists of package names in a bundler's config. */
const LIST = /\b(exclude|include|dedupe|noExternal|external)(\s*:\s*\[)([^[\]]*)\]/g
const PLAIN_ITEM = /^(\s*)(['"`])([^'"`]*)\2(\s*)$/
/** A Vite nested dependency: '<package> > <dependency>'. */
const NESTED = /(['"`])(@kition\/[a-z0-9-]+)(\s*>\s*[^'"`]*)\1/g

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length

/** What replaces a path into kition-sdk's packages/<dir><rest>: the @kition/sdk subpath of that file, or the package's. */
function checkoutReplacement(dir, rest) {
  const part = PARTS.find((candidate) => candidate.dir === dir)
  const file = rest.replace(/^\//, '')
  const exact = subpaths().find((entry) => entry.part === part && entry.source === `./${file}`)
  if (exact) return `import ${SDK}${exact.key.slice(1)} instead`
  return `${file ? `${file} is no export of ${SDK}; ` : ''}import from ${SDK}/${part.subpath} (what ${part.name} was), or link kition-sdk's packages/sdk`
}

/** A package-list entry as @kition/sdk names it: an old package -> @kition/sdk, '<old> > <dep>' -> '@kition/sdk > <dep>', an old subpath -> its subpath. */
function listEntry(value) {
  const nested = /^(@kition\/[a-z0-9-]+)(\s*>\s*.*)$/.exec(value)
  if (nested && OLD.has(nested[1])) return `${SDK}${nested[2]}`
  if (OLD.has(value)) return SDK
  return sdkSpecifier(value) ?? value
}

/**
 * `text` with every old module specifier as @kition/sdk names it and old package names in package
 * lists as @kition/sdk: { text, changes: [{ from, to }], notes: [{ line, text }] }, each note naming
 * a line where an old name or a checkout path is left for a person, and what replaces it.
 */
export function migrateText(input) {
  const changes = []
  const notes = []
  // 1. Package-name lists of plain strings: the package, once per list. A dropped entry may take
  // its line with it: `removed` counts those, so a note names the line as written.
  let removed = 0
  const newlines = (part) => part.split('\n').length - 1
  let text = input.replace(LIST, (whole, key, open, body, offset) => {
    const items = body.split(',')
    if (!items.every((item, i) => PLAIN_ITEM.test(item) || (i === items.length - 1 && !item.trim()))) return whole
    const seen = new Set()
    const kept = []
    let renamed = false
    for (const item of items) {
      const match = PLAIN_ITEM.exec(item)
      if (!match) {
        kept.push(item)
        continue
      }
      const [, lead, quote, value, tail] = match
      const next = listEntry(value)
      if (next !== value) {
        renamed = true
        changes.push({ from: `${key}: ${value}`, to: `${key}: ${next}` })
      }
      if (seen.has(next)) continue
      seen.add(next)
      kept.push(`${lead}${quote}${next}${quote}${tail}`)
    }
    if (!renamed) return whole
    const next = `${key}${open}${kept.join(',')}]`
    if (key === 'external') notes.push({ line: lineAt(input, offset) - removed, text: `external now names ${SDK}: Rollup's external matches whole module ids, so '${SDK}' does not cover '${SDK}/editor' and the others; use /^@kition\\/sdk(?:\\/|$)/ there (Vite's ssr.external takes the package name as it is)` })
    removed += newlines(whole) - newlines(next)
    return next
  })
  // 2. Nested dependencies anywhere: '<old> > <dependency>' -> '@kition/sdk > <dependency>'.
  text = text.replace(NESTED, (whole, quote, name, rest) => {
    if (!OLD.has(name)) return whole
    changes.push({ from: `${name}${rest}`, to: `${SDK}${rest}` })
    return `${quote}${SDK}${rest}${quote}`
  })
  // 3. Module specifiers; any other quoted old name is listed.
  const noted = new Set()
  const source = text
  text = source.replace(/(['"`])(@kition\/[a-z0-9-]+(?:\/[^'"`\s]*)?)\1/g, (whole, quote, specifier, offset) => {
    const to = sdkSpecifier(specifier)
    if (!to) return whole
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1
    if (!SPECIFIER_LEAD.test(source.slice(Math.max(lineStart, offset - 80), offset))) {
      const line = lineAt(source, offset)
      const lineEnd = source.indexOf('\n', offset)
      notes.push({ line, text: `${specifier} is named here as something other than an import (${source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 120)}); change it by hand: the package is ${SDK}, this subpath ${to}` })
      noted.add(line)
      return whole
    }
    changes.push({ from: specifier, to })
    return `${quote}${to}${quote}`
  })
  // 4. What is left, line by line: old names in other spellings, names built from parts, checkout paths.
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (noted.has(index + 1)) return
    const found = []
    const names = [...new Set([...line.matchAll(OLD_ANY)].map((match) => match[0]))]
    for (const name of names) {
      const plain = name.replace(/^@kition(?:\/|\\\/|\\\\\/)/, '@kition/')
      found.push(`${name} (${name === plain ? 'unquoted, as in a comment' : 'regex-escaped'}): it is ${sdkSpecifier(plain)} now, of the package ${SDK}`)
    }
    if (BUILT_NAME.test(line)) found.push(`a package name built from parts (@kition/\${...}): make it name ${SDK} (and ${TESSERA}), not the old packages`)
    for (const match of line.matchAll(CHECKOUT_PATH)) found.push(`a path into kition-sdk's packages/${match[1]}${match[2]}: ${checkoutReplacement(match[1], match[2])}`)
    if (found.length) notes.push({ line: index + 1, text: `${found.join('; ')} (${line.trim().slice(0, 120)})` })
  })
  notes.sort((a, b) => a.line - b.line)
  return { text, changes, notes }
}

/**
 * A package manager hook's notes: every line naming an @kition package other than @kition/sdk and
 * @kition/tessera, a kition-sdk packages/ folder other than packages/sdk, or an old package's short
 * name (a list the hook builds the names from). Nothing is rewritten.
 */
export function packageManagerNotes(text) {
  const notes = []
  const short = new RegExp(String.raw`(['"\`])(${SHORT})\1`)
  text.split('\n').forEach((line, index) => {
    const what = []
    if (/@kition\/(?!(?:sdk|tessera)(?![\w-]))/.test(line)) what.push('an @kition package other than @kition/sdk and @kition/tessera')
    if (short.test(line) || new RegExp(CHECKOUT_PATH.source).test(line)) what.push("an old SDK package's short name or folder")
    if (what.length) notes.push({ line: index + 1, text: `${what.join(' and ')} (${line.trim().slice(0, 120)}): link ${SDK} to kition-sdk's packages/sdk (one package for the twelve) and ${TESSERA} to kition-tessera's packages/tessera instead` })
  })
  return notes
}

/** `deps` with `name` at `range` in sorted position: before the first key that sorts after it; the others keep their order. */
function insertSorted(deps, name, range) {
  const next = {}
  let placed = false
  for (const [key, value] of Object.entries(deps)) {
    if (!placed && key > name) {
      next[name] = range
      placed = true
    }
    next[key] = value
  }
  if (!placed) next[name] = range
  return next
}

/**
 * A package.json's object with the old names replaced by @kition/sdk: { manifest, changes, notes }.
 * `sdkSpec` is what @kition/sdk is added at (default ^<packages/sdk's version>), `tesseraSpec` what
 * @kition/tessera is added at (default packages/sdk's peer range); given, each also replaces the
 * project's own entry. `text`, the file as read, gives the notes their lines.
 */
export function migrateManifest(manifest, { sdkSpec, tesseraSpec, text } = {}) {
  const version = sdkSpec ?? `^${SDK_MANIFEST.version}`
  const next = structuredClone(manifest)
  const changes = []
  const notes = []
  const lineOf = (key) => {
    const at = text?.indexOf(JSON.stringify(key)) ?? -1
    return at === -1 ? undefined : lineAt(text, at)
  }
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
    let rebuilt = {}
    let placed = Object.hasOwn(deps, SDK) || !adds
    for (const [name, range] of Object.entries(deps)) {
      if (!OLD.has(name)) {
        rebuilt[name] = range
        continue
      }
      changes.push({ from: `${section}: ${name}@${range}`, to: placed ? `(${SDK} ${adds ? 'already there' : `in ${home}`})` : `${section}: ${SDK}@${version}` })
      placed = true
    }
    if (adds && !Object.hasOwn(deps, SDK)) rebuilt = insertSorted(rebuilt, SDK, version)
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
      next[at] = insertSorted(next[at] ?? {}, TESSERA, range)
      changes.push({ from: `${at}: (Tessera ${hadEditor ? 'came with @kition/kit-editor' : `was ${oldTessera.join(', ')}`})`, to: `${at}: ${TESSERA}@${range}` })
    }
  }
  if (oldTessera.length) notes.push({ line: lineOf(oldTessera[0]), text: `${oldTessera.join(', ')}: Tessera is one package now, ${TESSERA}, which ${SDK}/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs <folder> (its package.json and its imports)` })
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
      if (OLD.has(name)) notes.push({ line: lineOf(key), text: `${where}: ${key} -> ${JSON.stringify(overrides[key])} names ${name}; point it at ${SDK} by hand` })
    }
  }
  return { manifest: next, changes, notes }
}

/** The files `migrateFolder` reads under `dir`: package.json files, hooks and sources, lockfiles never. */
function* filesUnder(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) yield* filesUnder(path.join(dir, entry.name))
    } else if (entry.isFile() && !LOCKFILES.includes(entry.name) && (entry.name === 'package.json' || isPackageManagerFile(entry.name) || SOURCES.test(entry.name))) {
      yield path.join(dir, entry.name)
    }
  }
}

/** Migrates every file under `dir` (writes nothing with `check`): [{ file, changes, notes }] of the files that change or need a person. */
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
      const migrated = migrateManifest(manifest, { sdkSpec, tesseraSpec, text })
      if (!migrated.changes.length && !migrated.notes.length) continue
      if (!check && migrated.changes.length) fs.writeFileSync(file, `${JSON.stringify(migrated.manifest, null, text.match(/^\{\n(\s+)/)?.[1] ?? 2)}${text.endsWith('\n') ? '\n' : ''}`)
      report.push({ file, changes: migrated.changes, notes: migrated.notes })
      continue
    }
    if (isPackageManagerFile(path.basename(file))) {
      const notes = packageManagerNotes(text)
      if (notes.length) report.push({ file, changes: [], notes })
      continue
    }
    const migrated = migrateText(text)
    if (!migrated.changes.length && !migrated.notes.length) continue
    if (!check && migrated.changes.length) fs.writeFileSync(file, migrated.text)
    report.push({ file, changes: migrated.changes, notes: migrated.notes })
  }
  return report
}

/** The report's two lists, as printed: "changed" and "needs a person". */
export function formatReport(report, { check = false, cwd = process.cwd() } = {}) {
  const where = (file) => path.relative(cwd, file) || file
  const changed = report.filter(({ changes }) => changes.length)
  const people = report.flatMap(({ file, notes }) => notes.map((note) => ({ file, ...note })))
  const out = [`changed${check ? ' (would change; --check writes nothing)' : ''}: ${changed.length} file(s)`]
  for (const { file, changes } of changed) {
    out.push(`  ${where(file)}`)
    const counted = new Map()
    for (const { from, to } of changes) counted.set(`${from} -> ${to}`, (counted.get(`${from} -> ${to}`) ?? 0) + 1)
    for (const [line, times] of counted) out.push(`    ${line}${times > 1 ? ` (${times})` : ''}`)
  }
  out.push(`needs a person: ${people.length} place(s)`)
  for (const { file, line, text } of people) out.push(`  ${where(file)}${line ? `:${line}` : ''}: ${text}`)
  out.push(`${changed.length} file(s) ${check ? 'would change' : 'changed'}, ${people.length} place(s) need a person${check || !changed.length ? '' : "; run the package manager's install (lockfiles were not touched)"}`)
  return { text: `${out.join('\n')}\n`, changed: changed.length, people: people.length }
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
  const { text, changed, people } = formatReport(migrateFolder(dir, { check, ...options }), { check })
  process.stdout.write(text)
  process.exit(check && (changed || people) ? 1 : 0)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
