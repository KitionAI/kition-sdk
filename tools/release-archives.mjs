#!/usr/bin/env node
// Writes the `kition` and kit assets of one Kition SDK GitHub Release (`sdk-v<version>`, made by
// .github/workflows/release.yml), from the executables each platform built and checked:
//
//   kition-<version>-<platform>.tar.gz          `kition` (`kition.exe` on Windows) and LICENSE,
//                                               at the top: what install.sh, install.ps1 and the
//                                               npm package @kition/kits-mcp-<platform> install
//   kition-<kit>-<kitVersion>-<platform>.tar.gz kit.json and `kition-<kit>` (.exe) at the top: one
//                                               kit version for one platform, as `kition kit
//                                               install` unpacks it into ~/.kition/kits/
//   kits-index.json                             the kit index (schemas/kits-index.schema.json)
//                                               that `kition` reads from the latest release
//
//   node tools/release-archives.mjs --bin <folder> --out <folder>
//        [--previous <kits-index.json>] [--base-url <url>] [--version <sdk version>]
//
// --bin       a folder of `bin-<platform>/` folders, one per platform, as the release workflow
//             downloads them: each holds `kition`, `kition-<kit>` for each kit, the handshakes.json
//             `kit-handshake.mjs --record` wrote beside them, and `kits/<kit>/kit.json`
// --out       where the archives and kits-index.json go
// --previous  the kits-index.json of the latest release before this one; without it the index
//             holds this release's archives only (the first release with an index)
// --base-url  the address this release's assets will have (default
//             https://github.com/KitionAI/kition-sdk/releases/download/sdk-v<version>)
// --version   the SDK version the kition archives are named for (default sdk.json `version`;
//             another one only to rehearse a release locally)
//
// The index carries forward. A release builds only the kit versions Kition's lock pins now, but
// `releases/latest/download/kits-index.json` must list every version still downloadable, and a
// published release never changes. So the new index is the previous one, with this release's
// archives added at absolute addresses of this release:
//
// - Every entry of the previous index stays as it is, with its absolute address in the release that
//   holds the archive. A relative address there is refused (it would name a file of this release).
// - A kit version and platform the previous index already lists is not archived again: the archive
//   published first stays the one for that version (versions never change once published). Its
//   Kit Process Protocol must be the same as this build's, or nothing is written.
// - A kit that is no longer in published-kits.json leaves the index (its archives stay where they
//   were published); only published kits enter it.
// - A kit's id, name and extensions come from the kit.json of its newest version this release
//   builds, when no newer version is in the index.
//
// The index written is checked against schemas/kits-index.schema.json. It publishes nothing.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHandshakes } from './kit-handshake.mjs'
import { PUBLISHED_KITS } from './published-kits.mjs'
import { assetUrl } from './sdk-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INDEX = 'kits-index.json'
export const PLATFORMS = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kits-mcp/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'kits-index.schema.json'), 'utf8'))

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const exeOf = (platform) => (platform.startsWith('win32') ? '.exe' : '')
export const cliArchive = (version, platform) => `kition-${version}-${platform}.tar.gz`
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
 * rule that is silently not checked here.
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
        throw new Error(`schema: the keyword ${keyword} is not checked by tools/release-archives.mjs; teach schemaProblems it`)
    }
  }
  return problems
}

/** What one platform's folder gives for each kit: its kit.json and its checked executable. */
export function platformKits(dir, platform) {
  const exe = exeOf(platform)
  const recorded = readHandshakes(dir)
  const kitsDir = path.join(dir, 'kits')
  const kits = fs.existsSync(kitsDir) ? fs.readdirSync(kitsDir).sort() : []
  const executables = fs.readdirSync(dir).filter((file) => /^kition-[a-z0-9]+(\.exe)?$/.test(file) && !/^kition-kits(-mcp)?(\.exe)?$/.test(file))
  const unpaired = executables.filter((file) => !kits.includes(file.replace(/^kition-/, '').replace(/\.exe$/, '')))
  if (unpaired.length) throw new Error(`${dir}: ${unpaired.join(', ')} without kits/<kit>/kit.json`)
  return kits.map((kit) => {
    const kitJsonFile = path.join(kitsDir, kit, 'kit.json')
    const kitJson = JSON.parse(fs.readFileSync(kitJsonFile, 'utf8'))
    if (!PUBLISHED_KITS.includes(kit)) throw new Error(`${kitJsonFile}: ${kit} is not in published-kits.json (${PUBLISHED_KITS.join(', ')})`)
    if (kitJson.id !== `kit.${kit}`) throw new Error(`${kitJsonFile}: its id is ${kitJson.id}, not kit.${kit}`)
    const name = `kition-${kit}`
    if (kitJson.headless?.executable !== name) throw new Error(`${kitJsonFile}: headless.executable is ${kitJson.headless?.executable}, not ${name}`)
    const executable = path.join(dir, `${name}${exe}`)
    if (!fs.existsSync(executable)) throw new Error(`${dir} has no ${name}${exe}`)
    const seen = recorded[`${name}${exe}`]
    if (!seen) throw new Error(`${dir}/handshakes.json has no ${name}${exe}`)
    if (seen.sha256 !== sha256(executable)) throw new Error(`${dir}/${name}${exe} is not the file its handshake was recorded for`)
    if (seen.kit?.id !== kitJson.id || seen.kit?.version !== kitJson.version) {
      throw new Error(`${dir}/${name}${exe} answers kit.initialize as ${seen.kit?.id} ${seen.kit?.version}; its kit.json is ${kitJson.id} ${kitJson.version}`)
    }
    const protocol = `kition-kit/${seen.protocolVersion}`
    if (kitJson.headless?.protocol !== protocol) throw new Error(`${dir}/${name}${exe} speaks ${protocol}; its kit.json says ${kitJson.headless?.protocol}`)
    return { kit, platform, kitJson, kitJsonFile, executable, protocol }
  })
}

/** The extensions a kit edits (its `edit` formats), lowercase, without the dot. */
const editExtensions = (kitJson) => [...new Set((kitJson.formats ?? []).filter((format) => format.role === 'edit').flatMap((format) => format.extensions ?? []).map((ext) => ext.replace(/^\./, '').toLowerCase()))]

/** `{ schemaVersion, kits }` with kits, versions and platforms in a stable order. */
function ordered(index) {
  const kits = {}
  for (const name of Object.keys(index.kits).sort()) {
    const kit = index.kits[name]
    const versions = {}
    for (const version of Object.keys(kit.versions).sort(compareVersions)) {
      const entry = kit.versions[version]
      versions[version] = { protocol: entry.protocol, platforms: Object.fromEntries(Object.keys(entry.platforms).sort().map((p) => [p, entry.platforms[p]])) }
    }
    kits[name] = { id: kit.id, name: kit.name, extensions: kit.extensions, versions }
  }
  return { schemaVersion: 1, kits }
}

/**
 * The plan of one release: the previous index carried forward, which built kit versions need an
 * archive, and the index once they are added (`url` of each addition is `${baseUrl}/<file>`).
 * Pure: `built` is `platformKits` of every platform; `carried` are the built versions the
 * previous index lists already, which get no new archive.
 */
export function planIndex(previous, built, baseUrl) {
  const index = previous ? structuredClone(previous) : { schemaVersion: 1, kits: {} }
  if (previous) {
    if (previous.schemaVersion !== 1) throw new Error(`the previous index is format ${previous.schemaVersion}; this tool writes format 1`)
    const problems = schemaProblems(previous)
    if (problems.length) throw new Error(`the previous index is not a kit index:\n  ${problems.join('\n  ')}`)
  }
  const dropped = Object.keys(index.kits).filter((kit) => !PUBLISHED_KITS.includes(kit))
  for (const kit of dropped) delete index.kits[kit]
  for (const [kit, entry] of Object.entries(index.kits)) {
    for (const [version, { platforms }] of Object.entries(entry.versions)) {
      for (const [platform, archive] of Object.entries(platforms)) {
        if (!/^https?:\/\//i.test(archive.url)) throw new Error(`the previous index gives ${kit} ${version} ${platform} the relative address ${archive.url}; an index that carries forward names every archive by its absolute address`)
      }
    }
  }

  const add = []
  const carried = []
  const newest = new Map()
  for (const entry of built) {
    const { kit, platform, kitJson, protocol } = entry
    const version = kitJson.version
    const listed = index.kits[kit]?.versions[version]
    if (listed && listed.protocol !== protocol) {
      throw new Error(`${kit} ${version} is in the previous index speaking ${listed.protocol}, but this build speaks ${protocol}: a changed kit is a new version`)
    }
    if (listed?.platforms[platform]) {
      carried.push({ kit, version, platform, url: listed.platforms[platform].url })
    } else {
      const file = kitArchive(kit, version, platform)
      add.push({ ...entry, version, file, url: `${baseUrl}/${file}` })
    }
    const best = newest.get(kit)
    if (!best || compareVersions(version, best.version) > 0) newest.set(kit, kitJson)
  }

  for (const [kit, kitJson] of newest) {
    const known = Object.keys(index.kits[kit]?.versions ?? {})
    if (index.kits[kit] && known.some((version) => compareVersions(version, kitJson.version) > 0)) continue
    const extensions = editExtensions(kitJson)
    index.kits[kit] = { id: kitJson.id, name: kitJson.name, extensions, versions: index.kits[kit]?.versions ?? {} }
  }
  return { index, add, carried, dropped, finish: (archives) => finishIndex(index, archives) }
}

/** The index with the archives written (`{ kit, version, platform, protocol, url, size, sha256 }`) in it. */
function finishIndex(index, archives) {
  const done = structuredClone(index)
  for (const { kit, version, platform, protocol, url, size, sha256: sum } of archives) {
    const versions = done.kits[kit].versions
    versions[version] ??= { protocol, platforms: {} }
    versions[version].platforms[platform] = { url, size, sha256: sum }
  }
  const result = ordered(done)
  const problems = schemaProblems(result)
  if (problems.length) throw new Error(`the index written would not be a kit index:\n  ${problems.join('\n  ')}`)
  return result
}

/**
 * `<archive>` holding `files` (`{ name, from, mode }`) at its top. tar runs in a folder beside the
 * archive and is given relative paths only: Git for Windows' GNU tar reads `D:\...` as a remote host.
 */
function writeArchive(archive, files) {
  const stage = fs.mkdtempSync(path.join(path.dirname(archive), '.stage-'))
  try {
    for (const { name, from, mode } of files) {
      fs.copyFileSync(from, path.join(stage, name))
      fs.chmodSync(path.join(stage, name), mode)
    }
    execFileSync('tar', ['-czf', `../${path.basename(archive)}`, ...files.map(({ name }) => name)], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return { size: fs.statSync(archive).size, sha256: sha256(archive) }
}

/** The `bin-<platform>/` folders of `binDir`, by platform. */
export function platformFolders(binDir) {
  const found = fs
    .readdirSync(binDir)
    .filter((name) => name.startsWith('bin-') && fs.statSync(path.join(binDir, name)).isDirectory())
    .map((name) => ({ platform: name.slice(4), dir: path.join(binDir, name) }))
    .sort((a, b) => a.platform.localeCompare(b.platform))
  for (const { platform } of found) if (!PLATFORMS.includes(platform)) throw new Error(`${binDir}/bin-${platform}: no platform ${platform} (${PLATFORMS.join(', ')})`)
  if (!found.length) throw new Error(`${binDir} holds no bin-<platform>/ folder`)
  return found
}

/**
 * Writes the kition archives, the kit archives this release adds and kits-index.json in `out`;
 * answers what it did.
 */
export function writeReleaseArchives({ binDir, out, version, previous = null, baseUrl = assetUrl(version, '').replace(/\/$/, '') }) {
  fs.mkdirSync(out, { recursive: true })
  const folders = platformFolders(binDir)
  const built = folders.flatMap(({ platform, dir }) => platformKits(dir, platform))
  // Every platform builds the same kit versions from the same kit.json.
  for (const kit of new Set(built.map((entry) => entry.kit))) {
    const of = built.filter((entry) => entry.kit === kit)
    const missing = folders.filter(({ platform }) => !of.some((entry) => entry.platform === platform)).map(({ platform }) => platform)
    if (missing.length) throw new Error(`${kit} is built for ${of.map((entry) => entry.platform).join(', ')} but not ${missing.join(', ')}`)
    const differs = of.find((entry) => JSON.stringify(entry.kitJson) !== JSON.stringify(of[0].kitJson))
    if (differs) throw new Error(`the kit.json of ${kit} on ${differs.platform} differs from ${of[0].platform}'s`)
  }

  const cli = folders.map(({ platform, dir }) => {
    const exe = exeOf(platform)
    const executable = path.join(dir, `kition${exe}`)
    if (!fs.existsSync(executable)) throw new Error(`${dir} has no kition${exe}`)
    const file = cliArchive(version, platform)
    const written = writeArchive(path.join(out, file), [
      { name: `kition${exe}`, from: executable, mode: 0o755 },
      { name: 'LICENSE', from: path.join(root, 'LICENSE'), mode: 0o644 },
    ])
    return { platform, file, ...written }
  })

  const plan = planIndex(previous, built, baseUrl)
  const archives = plan.add.map((entry) => {
    const exe = exeOf(entry.platform)
    const written = writeArchive(path.join(out, entry.file), [
      { name: 'kit.json', from: entry.kitJsonFile, mode: 0o644 },
      { name: `kition-${entry.kit}${exe}`, from: entry.executable, mode: 0o755 },
    ])
    return { kit: entry.kit, version: entry.version, platform: entry.platform, protocol: entry.protocol, file: entry.file, url: entry.url, ...written }
  })
  const index = plan.finish(archives)
  fs.writeFileSync(path.join(out, INDEX), `${JSON.stringify(index, null, 2)}\n`)
  return { cli, archives, carried: plan.carried, dropped: plan.dropped, index }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const binDir = flag('--bin')
  const out = flag('--out')
  if (!binDir || !out) {
    process.stderr.write('usage: release-archives.mjs --bin <folder of bin-<platform>/> --out <folder> [--previous <kits-index.json>] [--base-url <url>] [--version <sdk version>]\n')
    process.exit(2)
  }
  try {
    const version = flag('--version') ?? JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8')).version
    const previousFile = flag('--previous')
    const previous = previousFile ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : null
    const done = writeReleaseArchives({ binDir: path.resolve(binDir), out: path.resolve(out), version, previous, ...(flag('--base-url') ? { baseUrl: flag('--base-url').replace(/\/$/, '') } : {}) })
    const line = (entries) => entries.map((entry) => `${entry.kit} ${entry.version} ${entry.platform}`).join(', ') || 'none'
    process.stdout.write(
      [
        `kition ${version}: ${done.cli.map((entry) => entry.platform).join(', ')}`,
        `kit archives added: ${line(done.archives)}`,
        `built, but listed already (the archive published first stays): ${line(done.carried)}`,
        ...(done.dropped.length ? [`left out (not in published-kits.json): ${done.dropped.join(', ')}`] : []),
        `${INDEX}: ${Object.entries(done.index.kits).map(([kit, entry]) => `${kit} ${Object.keys(entry.versions).join(' ')}`).join('; ') || 'no kits'}`,
      ].join('\n') + '\n',
    )
  } catch (error) {
    process.stderr.write(`release-archives: ${error.message}\n`)
    process.exit(1)
  }
}
