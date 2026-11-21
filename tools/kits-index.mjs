#!/usr/bin/env node
// Gathers the kit index `kition` reads (schemas/kits-index.schema.json, format 1) from the npm
// registry. Each kit repository's Package workflow (KitionAI/kition .github/workflows/kit-package.yml)
// publishes every kit version as npm packages, `@kition/kit-<kit>-<platform>` and
// `@kition/kit-<kit>-ui` (tools/kit-npm.mjs), whose package.json carries a `kition` field with
// what the index needs; this tool reads the registry's metadata of those packages (never their
// tarballs) and writes the index, and the package `@kition/kits-index` that holds it, which
// .github/workflows/kits-index.yml publishes when it changed.
//
//   node tools/kits-index.mjs --modules <file> --out <file> [--registry <address>] [--previous <kits-index.json>]
//        [--package <folder> --version <version>]
//   node tools/kits-index.mjs --modules <file> --dry-run [--registry <address>] [--previous <kits-index.json>]
//
// --modules   KitionAI/kition's kits/modules.json (a file: the workflow checks Kition out), which
//             names each kit
// --registry  the npm registry read (default https://registry.npmjs.org/)
// --out       where the index goes
// --previous  the index published now: the report names the archives that enter or leave (a
//             version listed there and held back now leaves), and a
//             package listed there with the same integrity keeps its size (the registry gives a
//             tarball's size only to a HEAD request of it, or to a one-byte range)
// --package   with --version, also writes the folder of the package @kition/kits-index at that
//             version (package.json and kits-index.json) for `npm publish`
// --dry-run   writes nothing; prints what the index would hold
//
// The rules:
//
// - The registry is the only source: the index holds what the packages' metadata says, nothing
//   carried from an earlier index but a size known for the same integrity, and every kit
//   modules.json names (published-kits.json, the kits the SDK documents and bundles, does not
//   filter it).
// - A version is listed when it has a headless package for at least one platform; its editor
//   package (`ui`) when it has one. An editor package of a version without a headless one is named
//   in the report and left out.
// - A version still being published is held back: a kit's Package workflow publishes a version's
//   packages one after another, and npm shows each a little later. A version that lacks a package
//   (a platform, or `ui`) which the kit's highest listed lower version has is not listed, and the
//   report names it (`held <kit> <version>: still being published ...`); the next version is
//   compared with that same listed one. A kit's first version, and one with the same packages or
//   more, is listed. Holding a version is not an error: a kit that really dropped a platform or its
//   editor shows in the report until a maintainer acts.
// - A package whose tarball npm does not serve yet (a 404 to its HEAD or to its one-byte range; npm
//   lists a version's metadata a minute or two before its tarball) counts as not published in this
//   run: it is left out, so the rule above holds its version back when a lower listed version has
//   that package, and the report says the tarball is not downloadable yet.
// - Every package of a version must say the same kit, id, name, protocol and extensions in its
//   `kition` field, be the role and platform its name says, and have npm's sha512 integrity; any
//   that does not stops the run. So does a registry answer other than the metadata or a 404 (a
//   package never published, or a tarball not served yet), and a tarball whose size cannot be read
//   otherwise: a failure never yields a smaller index.
// - A kit's id, name, extensions and views come from its newest version.
// - The index is checked against the schema and written with kits, versions and platforms in a
//   fixed order, so the same metadata gives the same bytes.
// - An index with no kit is never written (exit status 3): it would replace a good one with
//   nothing.
//
// Every network read goes through one function (`net`), so the tests run on fakes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDEX_PACKAGE, packageName, PLATFORMS, tarballPath } from './kit-npm.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INDEX = 'kits-index.json'
export { PLATFORMS }
export const REGISTRY = 'https://registry.npmjs.org/'
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'kits-index.schema.json'), 'utf8'))
/** The exit status when the index would hold no kit. */
export const EMPTY = 3
/** The index format written. */
export const SCHEMA_VERSION = SCHEMA.properties.schemaVersion.const

/** Orders semver strings: numbers first, then a release after its pre-releases. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s)
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (m && n) return Number(p) - Number(q)
    if (m !== n) return m ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * The problems of `value` against the index schema (or another schema of the same keywords), as
 * `<path>: <what>` lines. A keyword this checker does not know fails, so the schema cannot grow a
 * rule that is silently not checked here. Kit repositories check their fragments with it.
 */
export function schemaProblems(value, schema = SCHEMA, rootSchema = schema, at = '') {
  const problems = []
  const where = at || '/'
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
  for (const [keyword, rule] of Object.entries(schema)) {
    switch (keyword) {
      case '$schema': case '$id': case 'title': case 'description': case '$defs': case '$comment':
        break
      case '$ref': {
        if (!rule.startsWith('#/')) throw new Error(`schema: $ref ${rule} is not local`)
        const target = rule.slice(2).split('/').reduce((node, key) => node?.[key], rootSchema)
        if (!target) throw new Error(`schema: $ref ${rule} names nothing`)
        problems.push(...schemaProblems(value, target, rootSchema, at))
        break
      }
      case 'type': {
        const actual = kind(value)
        if (!(actual === rule || (rule === 'number' && actual === 'integer'))) problems.push(`${where}: is ${actual}, not ${rule}`)
        break
      }
      case 'const':
        if (JSON.stringify(value) !== JSON.stringify(rule)) problems.push(`${where}: is not ${JSON.stringify(rule)}`)
        break
      case 'required':
        if (kind(value) === 'object') for (const name of rule) if (!(name in value)) problems.push(`${where}: has no ${name}`)
        break
      case 'properties':
        if (kind(value) === 'object') for (const [name, sub] of Object.entries(rule)) if (name in value) problems.push(...schemaProblems(value[name], sub, rootSchema, `${at}/${name}`))
        break
      case 'additionalProperties':
        if (kind(value) === 'object') {
          for (const [name, sub] of Object.entries(value)) {
            if (schema.properties && name in schema.properties) continue
            if (rule === false) problems.push(`${where}: ${name} is not allowed`)
            else problems.push(...schemaProblems(sub, rule, rootSchema, `${at}/${name}`))
          }
        }
        break
      case 'propertyNames':
        if (kind(value) === 'object') for (const name of Object.keys(value)) problems.push(...schemaProblems(name, rule, rootSchema, `${at}/${name} (name)`))
        break
      case 'items':
        if (kind(value) === 'array') value.forEach((item, i) => problems.push(...schemaProblems(item, rule, rootSchema, `${at}/${i}`)))
        break
      case 'minItems':
        if (kind(value) === 'array' && value.length < rule) problems.push(`${where}: fewer than ${rule} items`)
        break
      case 'uniqueItems':
        if (rule && kind(value) === 'array' && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) problems.push(`${where}: items repeat`)
        break
      case 'pattern':
        if (typeof value === 'string' && !new RegExp(rule, 'u').test(value)) problems.push(`${where}: ${JSON.stringify(value)} does not match ${rule}`)
        break
      case 'minLength':
        if (typeof value === 'string' && [...value].length < rule) problems.push(`${where}: shorter than ${rule}`)
        break
      case 'minimum':
        if (typeof value === 'number' && value < rule) problems.push(`${where}: less than ${rule}`)
        break
      default:
        throw new Error(`schema: the keyword ${keyword} is not checked by tools/kits-index.mjs; teach schemaProblems it`)
    }
  }
  return problems
}

const VERSION = new RegExp(SCHEMA.$defs.kit.properties.versions.propertyNames.pattern)
const INTEGRITY = new RegExp(SCHEMA.$defs.archive.properties.integrity.pattern)

/** `{ schemaVersion, kits }` with kits, versions and platforms in a fixed order. */
export function ordered(index) {
  const kits = {}
  for (const name of Object.keys(index.kits).sort()) {
    const kit = index.kits[name]
    const versions = {}
    for (const version of Object.keys(kit.versions).sort(compareVersions)) {
      const entry = kit.versions[version]
      const platforms = {}
      for (const platform of Object.keys(entry.platforms).sort()) {
        const { package: name, size, integrity } = entry.platforms[platform]
        platforms[platform] = { package: name, size, integrity }
      }
      versions[version] = { protocol: entry.protocol, platforms }
      if (entry.ui) versions[version].ui = { package: entry.ui.package, size: entry.ui.size, integrity: entry.ui.integrity }
    }
    kits[name] = { id: kit.id, name: kit.name, extensions: kit.extensions, ...(kit.views?.length ? { views: kit.views } : {}), versions }
  }
  return { schemaVersion: SCHEMA_VERSION, kits }
}

/** The index as written: two-space JSON and a final newline. */
export const serialize = (index) => `${JSON.stringify(ordered(index), null, 2)}\n`

/**
 * The npm registry over HTTP: `net(url, { as })` answers the parsed JSON of a 200 (`as: 'json'`),
 * or the size a HEAD request of a tarball gives, else a one-byte range of it (`as: 'size'`); null
 * for a 404 (a package never published; a tarball npm does not serve yet, as for a minute or two
 * after a publish, whether the HEAD or the range answers it); it throws on anything else.
 */
export function registryNet({ fetchImpl = globalThis.fetch } = {}) {
  return async (url, { as = 'json' } = {}) => {
    const headers = { 'User-Agent': 'kition-sdk tools/kits-index.mjs', Accept: 'application/json' }
    const response = await fetchImpl(url, { method: as === 'size' ? 'HEAD' : 'GET', headers, redirect: 'follow' })
    if (response.status === 404) return null
    if (!response.ok) {
      const detail = as === 'size' ? '' : (await response.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ')
      throw new Error(`${url}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
    }
    if (as === 'size') {
      const size = Number(response.headers.get('content-length'))
      if (Number.isSafeInteger(size) && size > 0) return size
      // registry.npmjs.org answers a tarball's HEAD without Content-Length; the total of a
      // one-byte range (Content-Range: bytes 0-0/<size>) is the size.
      const ranged = await fetchImpl(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow' })
      await ranged.body?.cancel().catch(() => {})
      if (ranged.status === 404) return null
      const total = ranged.status === 206 ? Number(/^bytes 0-0\/([0-9]+)$/.exec(ranged.headers.get('content-range') ?? '')?.[1]) : NaN
      if (!Number.isSafeInteger(total) || total < 1) throw new Error(`${url}: no size (Content-Length of a HEAD, or Content-Range of a one-byte range)`)
      return total
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`${url}: not JSON (${error.message})`)
    }
  }
}

/** The kits KitionAI/kition's kits/modules.json names, sorted. */
export function kitsOfModules(modules) {
  const kits = Object.keys(modules)
    .filter((name) => !name.startsWith('$'))
    .map((kit) => {
      if (!/^[a-z][a-z0-9]*$/.test(kit)) throw new Error(`modules.json: ${JSON.stringify(kit)} is not a kit name`)
      return kit
    })
    .sort()
  if (!kits.length) throw new Error('modules.json names no kit')
  return kits
}

/**
 * npm's own placeholder of a package's first publish ("staged publishing"): the version
 * `0.0.0-stage`, with no `kition` field, which npm adds beside the version published and keeps.
 * It is no version of a kit.
 */
const isNpmPlaceholder = (version, manifest) => version === '0.0.0-stage' && manifest?.kition === undefined

const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/**
 * One version's package `name` (role `ui` or a platform) from its registry `manifest`, checked:
 * `{ kition, entry: { package, integrity } }`.
 */
function readPackage(name, kit, part, version, manifest) {
  const where = `${name}@${version}`
  const kition = manifest?.kition
  if (!kition || typeof kition !== 'object') throw new Error(`${where} has no kition field`)
  if (manifest.name !== name || manifest.version !== version || kition.version !== version) throw new Error(`${where}: its package.json is ${manifest.name}@${manifest.version} (kition.version ${kition.version})`)
  if (kition.kit !== kit || kition.id !== `kit.${kit}`) throw new Error(`${where}: its kition field is the kit ${kition.kit} (${kition.id}), not ${kit}`)
  if (part === 'ui' ? kition.role !== 'ui' : kition.role !== 'headless' || kition.platform !== part) throw new Error(`${where}: its kition field is role ${kition.role} ${kition.platform ?? ''}, not ${part === 'ui' ? 'ui' : `headless ${part}`}`)
  if (typeof kition.name !== 'string' || !kition.name.trim()) throw new Error(`${where}: its kition field has no name`)
  if (!/^kition-kit\/[0-9]+$/.test(String(kition.protocol))) throw new Error(`${where}: its kition field names no protocol`)
  if (!Array.isArray(kition.extensions) || !kition.extensions.length || !kition.extensions.every((ext) => /^[a-z][a-z0-9]*$/.test(ext))) throw new Error(`${where}: its kition field lists no extensions`)
  if (kition.views !== undefined && (!Array.isArray(kition.views) || !kition.views.every((ext) => /^[a-z][a-z0-9]*$/.test(ext)))) throw new Error(`${where}: its kition field's views are not extensions`)
  const integrity = manifest.dist?.integrity
  if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) throw new Error(`${where} has no sha512 integrity (dist.integrity)`)
  return { kition, entry: { package: name, integrity } }
}

/**
 * The size of `name`@`version`'s tarball: the previous index's for the same integrity, else asked
 * of the registry; null when the registry does not serve the tarball yet (a 404).
 */
async function sizeOf(net, registry, previousSizes, entry, version) {
  const known = previousSizes.get(`${entry.package}@${version} ${entry.integrity}`)
  if (known) return known
  try {
    return await net(`${registry}${tarballPath(entry.package, version)}`, { as: 'size' })
  } catch (error) {
    throw new Error(`the size of ${entry.package}@${version} cannot be read: ${error.message}`)
  }
}

/** The sizes of the packages of `previous`, by `<package>@<version> <integrity>`. */
function sizesOf(previous) {
  const sizes = new Map()
  for (const kit of Object.values(previous?.kits ?? {})) {
    for (const [version, entry] of Object.entries(kit.versions ?? {})) {
      for (const archive of [...Object.values(entry.platforms ?? {}), ...(entry.ui ? [entry.ui] : [])]) {
        if (archive?.package && archive.integrity && archive.size) sizes.set(`${archive.package}@${version} ${archive.integrity}`, archive.size)
      }
    }
  }
  return sizes
}

/** The packages of a gathered version: its platforms, sorted, then `ui` when it has an editor. */
const partsOf = ({ platforms, ui }) => [...Object.keys(platforms).sort(), ...(ui ? ['ui'] : [])]

/**
 * The kit index gathered from the registry's metadata of each kit's packages, and a report:
 * `{ index, report: [{ kit, versions, editors, uiOnly }], held: [{ kit, version, preceding, missing }],
 * notReady: [{ kit, version, part }] }`. `held` names the versions still being published, left out
 * of the index: each lacks the packages `missing` (platforms, `ui`) that `preceding`, the kit's
 * highest listed lower version, has. `notReady` names the packages whose metadata npm lists but
 * whose tarball it does not serve yet (a 404): they count as not published in this run.
 */
export async function gatherIndex({ kits, net, registry = REGISTRY, previous = null }) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const previousSizes = sizesOf(previous)
  const index = { schemaVersion: SCHEMA_VERSION, kits: {} }
  const report = []
  const held = []
  const notReady = []
  for (const kit of kits) {
    /** version → { kition, platforms, ui } */
    const versions = new Map()
    for (const part of [...PLATFORMS, 'ui']) {
      const name = packageName(kit, part)
      let packument
      try {
        packument = await net(`${base}${name.replace('/', '%2f')}`, { as: 'json' })
      } catch (error) {
        throw new Error(`the metadata of ${name} cannot be read: ${error.message}`)
      }
      if (packument === null) continue
      for (const [version, manifest] of Object.entries(packument?.versions ?? {})) {
        if (isNpmPlaceholder(version, manifest)) continue
        if (!VERSION.test(version)) throw new Error(`${name} lists the version ${JSON.stringify(version)}, which is not semver`)
        const { kition, entry } = readPackage(name, kit, part, version, manifest)
        let found = versions.get(version)
        if (!found) versions.set(version, (found = { kition, platforms: {}, ui: null }))
        for (const field of ['name', 'protocol']) if (found.kition[field] !== kition[field]) throw new Error(`${name}@${version} says ${field} ${JSON.stringify(kition[field])}; the other packages of ${kit} ${version} say ${JSON.stringify(found.kition[field])}`)
        for (const field of ['extensions', 'views']) if (!sameList(found.kition[field], kition[field])) throw new Error(`${name}@${version} lists other ${field} than the other packages of ${kit} ${version}`)
        const size = await sizeOf(net, base, previousSizes, entry, version)
        if (size === null) {
          notReady.push({ kit, version, part })
          continue
        }
        const sized = { ...entry, size }
        if (part === 'ui') found.ui = sized
        else found.platforms[part] = sized
      }
    }
    const headless = [...versions.keys()].filter((version) => Object.keys(versions.get(version).platforms).length).sort(compareVersions)
    const uiOnly = [...versions.keys()].filter((version) => !headless.includes(version) && versions.get(version).ui).sort(compareVersions)
    // A version still being published: it lacks a package the highest listed lower version has.
    const listed = []
    for (const version of headless) {
      const preceding = listed[listed.length - 1]
      const missing = preceding ? partsOf(versions.get(preceding)).filter((part) => !partsOf(versions.get(version)).includes(part)) : []
      if (missing.length) held.push({ kit, version, preceding, missing })
      else listed.push(version)
    }
    report.push({ kit, versions: listed, editors: listed.filter((version) => versions.get(version).ui), uiOnly })
    if (!listed.length) continue
    const newest = versions.get(listed[listed.length - 1]).kition
    index.kits[kit] = {
      id: newest.id,
      name: newest.name,
      extensions: newest.extensions,
      ...(newest.views?.length ? { views: newest.views } : {}),
      versions: Object.fromEntries(
        listed.map((version) => {
          const { kition, platforms, ui } = versions.get(version)
          return [version, { protocol: kition.protocol, platforms, ...(ui ? { ui } : {}) }]
        }),
      ),
    }
  }
  const problems = schemaProblems(ordered(index))
  if (problems.length) throw new Error(`the gathered index is not a kit index:\n  ${problems.join('\n  ')}`)
  return { index: ordered(index), report, held, notReady }
}

/** `<kit> <version> <platform>` lines of every package in `index`. */
const entries = (index) =>
  Object.entries(index?.kits ?? {}).flatMap(([kit, { versions }]) =>
    Object.entries(versions).flatMap(([version, { platforms, ui }]) => [...Object.keys(platforms), ...(ui ? ['ui'] : [])].map((platform) => `${kit} ${version} ${platform}`)),
  )

/** What enters and what leaves `previous` when `index` replaces it. */
export function compareIndexes(previous, index) {
  const before = new Set(entries(previous))
  const after = new Set(entries(index))
  return { entering: [...after].filter((line) => !before.has(line)).sort(), leaving: [...before].filter((line) => !after.has(line)).sort() }
}

/** The report as text lines. */
export function reportLines({ index, report, held, notReady }, previous) {
  const lines = []
  for (const { kit, versions, editors, uiOnly } of report) {
    lines.push(`${kit}: ${versions.length ? versions.join(', ') : 'no version'}`)
    const without = versions.filter((version) => !editors.includes(version))
    if (versions.length && without.length) lines.push(`  no editor package: ${without.join(', ')}`)
    if (uiOnly.length) lines.push(`  an editor package without a headless one, left out: ${uiOnly.join(', ')}`)
    const heldOfKit = held.filter((entry) => entry.kit === kit)
    const waiting = (version) => notReady.filter((entry) => entry.kit === kit && entry.version === version).map(({ part }) => part)
    for (const { version, preceding, missing } of heldOfKit) {
      const many = missing.length > 1
      const tarballs = missing.filter((part) => waiting(version).includes(part))
      const why = tarballs.length ? `; the ${tarballs.join(', ')} tarball${tarballs.length > 1 ? 's are' : ' is'} not downloadable yet` : ''
      lines.push(`  held ${kit} ${version}: still being published (no ${missing.join(', ')} package${many ? 's' : ''}; ${preceding} has ${many ? 'them' : 'one'}${why})`)
    }
    const elsewhere = notReady.filter((entry) => entry.kit === kit && !heldOfKit.some(({ version }) => version === entry.version))
    if (elsewhere.length) lines.push(`  a tarball not downloadable yet, left out for now: ${elsewhere.map(({ version, part }) => `${version} ${part}`).join(', ')}`)
  }
  const kits = Object.keys(index.kits)
  lines.push(
    kits.length
      ? `${INDEX}: ${kits.length} of ${report.length} kits (${kits.map((kit) => `${kit} ${Object.keys(index.kits[kit].versions).join(' ')}`).join('; ')})`
      : `${INDEX} would be empty: none of the ${report.length} kits has a published headless package; nothing is written`,
  )
  if (previous) {
    const { entering, leaving } = compareIndexes(previous, index)
    lines.push(`compared with the previous index: ${entering.length} packages enter, ${leaving.length} leave`)
    for (const line of entering) lines.push(`  + ${line}`)
    for (const line of leaving) lines.push(`  - ${line}`)
  }
  return lines
}

/** The package @kition/kits-index at `version` holding `index`, written into `folder`. */
export function writeIndexPackage(folder, index, version) {
  if (!VERSION.test(version)) throw new Error(`${JSON.stringify(version)} is not a version (semver)`)
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
  const manifest = {
    name: INDEX_PACKAGE,
    version,
    description: `The kit index kition reads: every published Kition kit's npm packages, with their sizes and integrity (format ${SCHEMA_VERSION}, kition-sdk schemas/kits-index.schema.json). Published by kition-sdk's kits-index workflow.`,
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/KitionAI/kition-sdk.git' },
    files: [INDEX],
  }
  fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(folder, INDEX), serialize(index))
  return folder
}

/** The command line; answers its exit status. */
export async function main(args, { net = registryNet(), out: write = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  const valued = ['--out', '--modules', '--previous', '--registry', '--package', '--version']
  const flag = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const out = flag('--out')
  const dryRun = args.includes('--dry-run')
  const unknown = args.filter((arg, i) => arg.startsWith('--') && arg !== '--dry-run' && !valued.includes(arg) && !(i > 0 && valued.includes(args[i - 1])))
  if ((!out && !dryRun) || (out && dryRun) || !flag('--modules') || unknown.length || Boolean(flag('--package')) !== Boolean(flag('--version'))) {
    err('usage: kits-index.mjs --modules <file> (--out <file> [--package <folder> --version <version>] | --dry-run) [--registry <address>] [--previous <kits-index.json>]\n')
    return 2
  }
  try {
    const modules = JSON.parse(fs.readFileSync(flag('--modules'), 'utf8'))
    const previousFile = flag('--previous')
    const previous = previousFile && fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : null
    const gathered = await gatherIndex({ kits: kitsOfModules(modules), net, registry: flag('--registry') ?? REGISTRY, previous })
    write(`${reportLines(gathered, previous).join('\n')}\n`)
    if (!Object.keys(gathered.index.kits).length) return EMPTY
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
      fs.writeFileSync(out, serialize(gathered.index))
      write(`wrote ${out}\n`)
      if (flag('--package')) write(`wrote ${writeIndexPackage(flag('--package'), gathered.index, flag('--version'))}\n`)
    }
    return 0
  } catch (error) {
    err(`kits-index: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
