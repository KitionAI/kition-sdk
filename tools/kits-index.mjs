#!/usr/bin/env node
// Gathers the kit index `kition` reads (schemas/kits-index.schema.json) from the kit repositories.
// Each kit repository publishes its own archives: its `package-v<version>` GitHub Release holds
// `kition-<kit>-<version>-<platform>.tar.gz` for each platform and the index fragment
// `kits-index-<kit>-<version>.json`, a kit index of that one kit version with absolute addresses
// (KitionAI/kition docs/kits.md, section 4b). This tool merges the fragments into one index;
// .github/workflows/kits-index.yml publishes it at the address `kition` reads by default.
//
//   node tools/kits-index.mjs --out <file> [--modules <file or URL>] [--previous <kits-index.json>]
//   node tools/kits-index.mjs --dry-run   [--modules <file or URL>] [--previous <kits-index.json>]
//
// --modules   KitionAI/kition's kits/modules.json, which names each kit and its repository
//             (default: the one on its main branch)
// --out       where the index goes; nothing else is written
// --dry-run   writes nothing; prints what the index would hold
// --previous  an index to compare with (the one published): the report names the kit versions
//             and platforms that would enter or leave it
//
// GH_TOKEN (or GITHUB_TOKEN), when set, is sent to the GitHub API; without one it reads the
// public repositories anonymously (60 API requests an hour).
//
// The rules:
//
// - The kit repositories are the only source: the index holds what their fragments say, nothing
//   carried from an earlier index, and every kit modules.json names (published-kits.json, the
//   kits the SDK documents and bundles, does not filter it).
// - A `package-v*` Release without a fragment is skipped and named in the report.
// - A fragment is published once and never replaced, so it can lack a platform whose archive was
//   added to the Release later: such an archive is added from the Release's asset metadata (its
//   size, and its SHA-256 from GitHub's `digest`, or from downloading it when GitHub gives none).
// - A fragment that is not a kit index of that one kit version, an archive it names that the
//   Release no longer holds, or one whose size or SHA-256 differs from the Release's, stops the
//   run. So does a repository whose Releases cannot be listed and a fragment that cannot be read:
//   a failure never yields a smaller index.
// - A kit's id, name and extensions come from the fragment of its newest version; each version
//   keeps the protocol its own fragment declares.
// - The index is checked against the schema and written with kits, versions and platforms in a
//   fixed order, so the same Releases give the same bytes.
// - An index with no kit is never written (exit status 3): it would replace a good one with
//   nothing.
//
// Every network read goes through one function (`net`), so the tests run on fakes.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INDEX = 'kits-index.json'
export const MODULES_URL = 'https://raw.githubusercontent.com/KitionAI/kition/main/kits/modules.json'
export const PLATFORMS = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'kits-index.schema.json'), 'utf8'))
const API = 'https://api.github.com'
const TAG_PREFIX = 'package-v'
const PER_PAGE = 100
/** The exit status when the index would hold no kit. */
export const EMPTY = 3

export const fragmentName = (kit, version) => `kits-index-${kit}-${version}.json`
export const kitArchive = (kit, version, platform) => `kition-${kit}-${version}-${platform}.tar.gz`

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
        const { url, size, sha256 } = entry.platforms[platform]
        platforms[platform] = { url, size, sha256 }
      }
      versions[version] = { protocol: entry.protocol, platforms }
    }
    kits[name] = { id: kit.id, name: kit.name, extensions: kit.extensions, versions }
  }
  return { schemaVersion: 1, kits }
}

/** The index as written: two-space JSON and a final newline. */
export const serialize = (index) => `${JSON.stringify(ordered(index), null, 2)}\n`

/**
 * The network as the GitHub API and release downloads give it: `net(url, { as })` answers the
 * parsed JSON (`as: 'json'`) or the bytes (`as: 'bytes'`) of a 2xx answer and throws on anything
 * else. `token` goes to the GitHub API only.
 */
export function githubNet({ token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  return async (url, { as = 'json' } = {}) => {
    const headers = { 'User-Agent': 'kition-sdk tools/kits-index.mjs' }
    if (url.startsWith(`${API}/`)) {
      headers.Accept = 'application/vnd.github+json'
      headers['X-GitHub-Api-Version'] = '2022-11-28'
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const response = await fetchImpl(url, { headers, redirect: 'follow' })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ')
      throw new Error(`${url}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
    }
    if (as === 'bytes') return Buffer.from(await response.arrayBuffer())
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`${url}: not JSON (${error.message})`)
    }
  }
}

/** Every Release of `repository`, page by page; a page that cannot be read stops the run. */
export async function listReleases(net, repository) {
  const releases = []
  for (let page = 1; ; page += 1) {
    let batch
    try {
      batch = await net(`${API}/repos/${repository}/releases?per_page=${PER_PAGE}&page=${page}`, { as: 'json' })
    } catch (error) {
      throw new Error(`the Releases of ${repository} cannot be listed: ${error.message}`)
    }
    if (!Array.isArray(batch)) throw new Error(`the Releases of ${repository} cannot be listed: the answer is not a list`)
    releases.push(...batch)
    if (batch.length < PER_PAGE) return releases
  }
}

/** The kits and their repositories in KitionAI/kition's kits/modules.json, by name. */
export function kitsOfModules(modules) {
  const kits = Object.entries(modules)
    .filter(([name]) => !name.startsWith('$'))
    .map(([kit, entry]) => {
      if (!/^[a-z][a-z0-9]*$/.test(kit)) throw new Error(`modules.json: ${JSON.stringify(kit)} is not a kit name`)
      if (typeof entry?.repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(entry.repository)) throw new Error(`modules.json: ${kit} names no repository (owner/name)`)
      return { kit, repository: entry.repository }
    })
    .sort((a, b) => a.kit.localeCompare(b.kit))
  if (!kits.length) throw new Error('modules.json names no kit')
  return kits
}

const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const digestOf = (asset) => (typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest) ? asset.digest.slice(7) : null)

/** The one kit version a fragment holds, checked: `{ id, name, extensions, protocol, platforms }`. */
function readFragment(fragment, kit, version, where) {
  const problems = schemaProblems(fragment)
  if (problems.length) throw new Error(`${where} is not a kit index:\n  ${problems.join('\n  ')}`)
  const kits = Object.keys(fragment.kits)
  if (kits.length !== 1 || kits[0] !== kit) throw new Error(`${where} holds ${kits.join(', ') || 'no kit'}, not ${kit} alone`)
  const entry = fragment.kits[kit]
  const versions = Object.keys(entry.versions)
  if (versions.length !== 1 || versions[0] !== version) throw new Error(`${where} holds ${kit} ${versions.join(', ') || 'no version'}, not ${version} alone`)
  return { id: entry.id, name: entry.name, extensions: entry.extensions, ...entry.versions[version] }
}

/**
 * The kit index gathered from the kit repositories' fragments, and a report:
 * `{ index, report: { kits: [{ kit, repository, versions, skipped: [{ tag, why }], added: [{ version, platform }] }] } }`.
 * `kits` is kitsOfModules' list; `net` is the network (githubNet).
 */
export async function gatherIndex({ kits, net }) {
  const index = { schemaVersion: 1, kits: {} }
  const report = []
  for (const { kit, repository } of kits) {
    const releases = await listReleases(net, repository)
    const done = { kit, repository, versions: [], skipped: [], added: [] }
    const found = []
    for (const release of releases) {
      if (release.draft || typeof release.tag_name !== 'string' || !release.tag_name.startsWith(TAG_PREFIX)) continue
      const tag = release.tag_name
      const version = tag.slice(TAG_PREFIX.length)
      if (!VERSION.test(version)) {
        done.skipped.push({ tag, why: 'the tag is not package-v<version>' })
        continue
      }
      const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))
      const fragmentAsset = assets.get(fragmentName(kit, version))
      if (!fragmentAsset) {
        done.skipped.push({ tag, why: `no ${fragmentName(kit, version)}` })
        continue
      }
      const where = `${repository} ${tag} ${fragmentAsset.name}`
      let fragment
      try {
        fragment = await net(fragmentAsset.browser_download_url, { as: 'json' })
      } catch (error) {
        throw new Error(`${where} cannot be read: ${error.message}`)
      }
      const entry = readFragment(fragment, kit, version, where)
      if (entry.id !== `kit.${kit}`) throw new Error(`${where}: its id is ${entry.id}, not kit.${kit}`)

      // Each archive the fragment names must be the Release's asset of that name, as published.
      const platforms = {}
      for (const [platform, archive] of Object.entries(entry.platforms)) {
        const name = kitArchive(kit, version, platform)
        const asset = assets.get(name)
        if (!asset) throw new Error(`${where} lists ${name}, which the Release does not hold`)
        if (archive.url !== asset.browser_download_url) throw new Error(`${where} gives ${platform} the address ${archive.url}; the Release's ${name} is at ${asset.browser_download_url}`)
        if (archive.size !== asset.size) throw new Error(`${where} says ${name} is ${archive.size} bytes; the Release's is ${asset.size}`)
        let sum = digestOf(asset)
        if (!sum) sum = sha256Of(await download(net, asset, `${repository} ${tag}`))
        if (archive.sha256 !== sum) throw new Error(`${where} gives ${name} the SHA-256 ${archive.sha256}; the Release's is ${sum}`)
        platforms[platform] = { url: archive.url, size: archive.size, sha256: archive.sha256 }
      }
      // An archive the Release holds that its fragment does not list (added after the fragment).
      for (const platform of PLATFORMS) {
        if (platforms[platform]) continue
        const asset = assets.get(kitArchive(kit, version, platform))
        if (!asset) continue
        const sum = digestOf(asset) ?? sha256Of(await download(net, asset, `${repository} ${tag}`))
        if (!Number.isInteger(asset.size) || asset.size < 1) throw new Error(`${repository} ${tag} ${asset.name} has no size`)
        platforms[platform] = { url: asset.browser_download_url, size: asset.size, sha256: sum }
        done.added.push({ version, platform })
      }
      found.push({ version, entry, platforms })
      done.versions.push(version)
    }
    done.versions.sort(compareVersions)
    if (found.length) {
      found.sort((a, b) => compareVersions(a.version, b.version))
      const newest = found[found.length - 1].entry
      index.kits[kit] = {
        id: newest.id,
        name: newest.name,
        extensions: newest.extensions,
        versions: Object.fromEntries(found.map(({ version, entry, platforms }) => [version, { protocol: entry.protocol, platforms }])),
      }
    }
    report.push(done)
  }
  const result = ordered(index)
  const problems = schemaProblems(result)
  if (problems.length) throw new Error(`the index gathered would not be a kit index:\n  ${problems.join('\n  ')}`)
  return { index: result, report }
}

async function download(net, asset, where) {
  try {
    const bytes = await net(asset.browser_download_url, { as: 'bytes' })
    if (bytes.length !== asset.size) throw new Error(`${bytes.length} bytes, and the Release says ${asset.size}`)
    return bytes
  } catch (error) {
    throw new Error(`${where} ${asset.name} cannot be downloaded to hash it (GitHub gives no digest): ${error.message}`)
  }
}

/** `<kit> <version> <platform>` lines of every archive in `index`. */
const entries = (index) =>
  Object.entries(index?.kits ?? {}).flatMap(([kit, { versions }]) => Object.entries(versions).flatMap(([version, { platforms }]) => Object.keys(platforms).map((platform) => `${kit} ${version} ${platform}`)))

/** What enters and what leaves `previous` when `index` replaces it. */
export function compareIndexes(previous, index) {
  const before = new Set(entries(previous))
  const after = new Set(entries(index))
  return { entering: [...after].filter((line) => !before.has(line)).sort(), leaving: [...before].filter((line) => !after.has(line)).sort() }
}

/** The report as text lines. */
export function reportLines({ index, report }, previous) {
  const lines = []
  for (const { kit, repository, versions, skipped, added } of report) {
    lines.push(`${kit} (${repository}): ${versions.length ? versions.join(', ') : 'no version'}`)
    for (const { tag, why } of skipped) lines.push(`  skipped ${tag}: ${why}`)
    for (const { version, platform } of added) lines.push(`  added ${version} ${platform} from the Release (its fragment does not list it)`)
  }
  const kits = Object.keys(index.kits)
  const skipped = report.reduce((sum, { skipped }) => sum + skipped.length, 0)
  lines.push(
    kits.length
      ? `${INDEX}: ${kits.length} of ${report.length} kits (${kits.map((kit) => `${kit} ${Object.keys(index.kits[kit].versions).join(' ')}`).join('; ')}); ${skipped} Releases skipped`
      : `${INDEX} would be empty: none of the ${report.length} kits has a Release with a fragment (${skipped} Releases skipped); nothing is written`,
  )
  if (previous) {
    const { entering, leaving } = compareIndexes(previous, index)
    lines.push(`compared with the previous index: ${entering.length} archives enter, ${leaving.length} leave`)
    for (const line of entering) lines.push(`  + ${line}`)
    for (const line of leaving) lines.push(`  - ${line}`)
  }
  return lines
}

async function readSource(net, source) {
  if (/^https?:\/\//.test(source)) return net(source, { as: 'json' })
  return JSON.parse(fs.readFileSync(source, 'utf8'))
}

/** The command line; answers its exit status. */
export async function main(args, { net = githubNet(), out: write = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  const flag = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const out = flag('--out')
  const dryRun = args.includes('--dry-run')
  const known = new Set(['--out', '--modules', '--previous', '--dry-run'])
  const unknown = args.filter((arg, i) => arg.startsWith('--') && !known.has(arg) && !(i > 0 && ['--out', '--modules', '--previous'].includes(args[i - 1])))
  if ((!out && !dryRun) || (out && dryRun) || unknown.length) {
    err('usage: kits-index.mjs (--out <file> | --dry-run) [--modules <file or URL>] [--previous <kits-index.json>]\n')
    return 2
  }
  try {
    const modules = await readSource(net, flag('--modules') ?? MODULES_URL)
    const previousFile = flag('--previous')
    const previous = previousFile ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : null
    const gathered = await gatherIndex({ kits: kitsOfModules(modules), net })
    write(`${reportLines(gathered, previous).join('\n')}\n`)
    if (!Object.keys(gathered.index.kits).length) return EMPTY
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
      fs.writeFileSync(out, serialize(gathered.index))
      write(`wrote ${out}\n`)
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
