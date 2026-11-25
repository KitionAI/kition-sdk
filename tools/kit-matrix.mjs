#!/usr/bin/env node
// The kit matrix: every kit against the rows of the kit requirements table (kit-requirements.yaml),
// as Markdown and JSON. A static row (`automation: static`) is settled by reading kit.json and the
// kit repository's files. With --dynamic, the dynamic rows this tool can settle (DYNAMIC_CHECKS)
// are too: it builds each kit's headless executable (`cargo build -p kition-<kit>` in the kit's
// repository) and asks it, through kition-sdk's `kit-probe`, for its commands as an agent sees
// them and for `document.check` on each of the kit's conformance fixtures.
//
//   node tools/kit-matrix.mjs --requirements <kit-requirements.yaml> --repos <folder of kition-<kit>>
//     [--waivers <folder of <kit>.yaml>] [--date YYYY-MM-DD] [--out <folder>]
//     [--kits <kit,kit,...>] [--dynamic true]
//
// --kits replaces the table's kit list (the table names the kits it was written for).
//
// Each kit is read from <repos>/kition-<kit>. Waivers come from each kit repository's
// cases/waivers.yaml and from the --waivers folder (approved waivers only). A cell is pass, fail (with the value found), waived (until a date), n/a, or unchecked
// (with why). An approved waiver that has not expired turns a failing or unchecked cell into
// waived; an expired one leaves it failing. The JSON lists every file it read (relative to the
// repositories' folder).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { KIT_NAMES, NATIVE_SUFFIXES } from './kit-naming.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
/** The kit-layer version a manifest declares (KHP K2) when no KHP specification checkout says otherwise (1.0, the kit layer of KHP 1.0 and 1.1). */
const DEFAULT_KIT_LAYER_VERSION = '1.0'

/** The kits that always have a native format, before their manifests are read (appliesTo native-format). */
const NATIVE_FORMAT_KITS = ['table', 'board', 'film', 'slide', 'vector', 'layout', 'motion']

/** Where a kit's documents are expected (the layout standard), when a row names no file itself. */
export const EXPECTED_FILES = {
  writingFormat: 'docs/writing-format.md',
  agentGuide: 'agent/guide.md',
  quality: 'docs/quality.md',
  attribution: 'docs/attribution.md',
  gaps: 'docs/gaps.md',
  parity: 'docs/parity/target-app-parity.md',
  roadmap: 'docs/roadmap.md',
}

/** Where a kit repository keeps its waivers. */
const WAIVERS_FILE = 'cases/waivers.yaml'

const pass = (value) => ({ state: 'pass', ...(value === undefined ? {} : { value }) })
const fail = (value) => ({ state: 'fail', value })
const unchecked = (value) => ({ state: 'unchecked', value })
const notApplicable = (value) => ({ state: 'n/a', ...(value === undefined ? {} : { value }) })

/** The requirements table, and the rows this run settles: the static ones, and with `dynamic` the dynamic rows DYNAMIC_CHECKS knows. */
export function loadRequirements(file, { dynamic = false } = {}) {
  const table = YAML.parse(fs.readFileSync(file, 'utf8'))
  const all = table.requirements ?? []
  const rows = all.filter((row) => row.automation === 'static' || (dynamic && row.automation === 'dynamic' && Object.hasOwn(DYNAMIC_CHECKS, row.check_id)))
  const staticRows = rows.filter((row) => row.automation === 'static').length
  return { version: table.version, kits: table.kits ?? [], rows, total: all.length, staticRows, dynamicRows: rows.length - staticRows }
}

/** A kit's repository as the checks read it, recording every read. */
function kitSource(reposDir, kit, reads) {
  const dir = path.join(reposDir, `kition-${kit}`)
  const guard = (file) => {
    const resolved = path.resolve(file)
    reads.push(resolved)
    return resolved
  }
  if (!fs.existsSync(guard(dir))) return null
  const files = new Set(trackedFiles(dir))
  const text = (rel) => {
    const file = guard(path.join(dir, rel))
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
  const bytes = (rel, count) => {
    const file = guard(path.join(dir, rel))
    if (!fs.existsSync(file)) return null
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(count)
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, count, 0))
    } finally {
      fs.closeSync(fd)
    }
  }
  let manifest = null
  const raw = text('kit.json')
  try {
    manifest = raw === null ? null : JSON.parse(raw)
  } catch {
    manifest = null
  }
  /** Tracked files whose text matches a fixed string (git grep), for checks that look for a test. */
  const grep = (needle, extension = '.rs') => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const found = spawnSync('git', ['-C', dir, 'grep', '-l', '-F', needle, '--', `*${extension}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
      return found.status === 0 ? found.stdout.split('\n').filter(Boolean) : []
    }
    return [...files].filter((file) => file.endsWith(extension) && (text(file) ?? '').includes(needle))
  }
  return { kit, dir, files, manifest, has: (rel) => files.has(rel), find: (re) => [...files].filter((file) => re.test(file)), text, bytes, grep }
}

/** The repository's files: git's tracked files, or every file outside build output when it is no git checkout. */
function trackedFiles(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20 })
    if (listed.status === 0) return listed.stdout.split('\0').filter(Boolean)
  }
  const out = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (['.git', 'node_modules', 'target', 'dist'].includes(entry.name)) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child)
      else out.push(child)
    }
  }
  walk('')
  return out
}

const nativeFormats = (manifest) => (manifest?.formats ?? []).filter((format) => format.mime?.startsWith('application/vnd.kition.'))
const defaultName = (kit) => (['pdf', 'cad', 'html'].includes(kit) ? KIT_NAMES[kit] : kit)

/** Whether a row applies to a kit (`appliesTo`); `null` when the table names a group this tool cannot settle. */
function applies(row, source) {
  const scope = row.appliesTo ?? 'all'
  if (Array.isArray(scope)) return scope.includes(source.kit)
  if (scope === 'all') return true
  if (scope === 'native-format') return NATIVE_FORMAT_KITS.includes(source.kit) || nativeFormats(source.manifest).length > 0
  return null
}

/** Flattened keys of a JSON catalog. */
function catalogKeys(text) {
  const keys = []
  const walk = (value, prefix) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, inner] of Object.entries(value)) walk(inner, prefix ? `${prefix}.${key}` : key)
    else keys.push(prefix)
  }
  try {
    walk(JSON.parse(text), '')
  } catch {
    return null
  }
  return keys
}

/** Each static row's check, by `check_id`: a kit's source in, a cell out. */
export const CHECKS = {
  'manifest.canonical-name': ({ manifest, kit }) => {
    const name = manifest.id?.replace(/^kit\./, '')
    return Object.hasOwn(KIT_NAMES, kit) && name === kit && /^[a-z]+$/.test(name) ? pass() : fail(manifest.id ?? 'no id')
  },
  'manifest.kit-id': ({ manifest, kit }) => (manifest.id === `kit.${kit}` ? pass() : fail(manifest.id ?? 'no id')),
  'manifest.display-name': (source) => {
    const { manifest, kit } = source
    if (manifest.name !== KIT_NAMES[kit]) return fail(manifest.name ?? 'no name')
    for (const other of source.find(/(^|\/)kit\.json$/).filter((file) => file !== 'kit.json')) {
      let parsed = null
      try {
        parsed = JSON.parse(source.text(other) ?? '')
      } catch {
        continue
      }
      if (parsed?.id === manifest.id && parsed.name !== manifest.name) return fail(`${other} names it ${parsed.name}`)
    }
    return pass()
  },
  'manifest.creates-type': ({ manifest, kit }) => {
    const creates = manifest.creates ?? []
    if (!creates.length) return fail('no creates')
    const wrong = creates.map((create) => create.id).filter((id) => id !== kit)
    return wrong.length ? fail(wrong.join(', ')) : pass()
  },
  'manifest.creates-basename': ({ manifest, kit }) => {
    const creates = manifest.creates ?? []
    if (!creates.length) return fail('no creates')
    const wrong = creates.map((create) => create.baseName).filter((name) => name !== `Untitled ${defaultName(kit)}`)
    return wrong.length ? fail(wrong.join(', ')) : pass()
  },
  'manifest.native-extension': ({ manifest, kit }) => {
    const native = nativeFormats(manifest)
    if (!native.length) return fail('no application/vnd.kition.* format')
    const wrong = native.flatMap((format) => format.extensions ?? []).filter((extension) => extension !== `k${kit}`)
    return wrong.length ? fail(wrong.join(', ')) : pass()
  },
  'manifest.native-mime': (source) => {
    const { manifest, kit } = source
    const native = nativeFormats(manifest)
    if (!native.length) return fail('no application/vnd.kition.* format')
    for (const format of native) {
      const suffix = format.mime.startsWith(`application/vnd.kition.${kit}+`) ? format.mime.slice(`application/vnd.kition.${kit}+`.length) : null
      const container = NATIVE_SUFFIXES.includes(suffix) ? suffix : null
      if (!container) return fail(format.mime)
      // The sample's first bytes say which container it really is: zip starts with PK, a SQLite 3
      // database with "SQLite format 3\0", JSON with {.
      for (const extension of format.extensions ?? []) {
        const head = source.bytes(`conformance/basic.${extension}`, 64)
        if (!head) continue
        const actual = head[0] === 0x50 && head[1] === 0x4b
          ? 'zip'
          : head.subarray(0, 16).toString('latin1') === 'SQLite format 3\0'
            ? 'sqlite3'
            : head.toString('utf8').trimStart().startsWith('{')
              ? 'json'
              : 'other'
        if (actual !== container) return fail(`${format.mime}, but conformance/basic.${extension} is ${actual}`)
      }
    }
    return pass()
  },
  'repo.layout-names': (source, { kitionDir }) => {
    const { manifest, kit } = source
    const problems = []
    if (manifest.engine?.runtime === 'rust-wasm' && manifest.engine.crate !== `kition-${kit}-kit`) problems.push(`crate ${manifest.engine.crate}`)
    const packages = kitionDir && fs.existsSync(path.join(kitionDir, 'packages')) ? fs.readdirSync(path.join(kitionDir, 'packages')) : []
    for (const dir of packages) if (/(-kit$|^kit-)/.test(dir) && dir.includes(kit)) problems.push(`kition/packages/${dir}`)
    return problems.length ? fail(problems.join(', ')) : pass()
  },
  'manifest.check': (source) => {
    const checked = spawnSync(process.execPath, [path.join(here, 'check-manifest.mjs'), path.join(source.dir, 'kit.json')], { encoding: 'utf8' })
    if (checked.status === 0) return pass()
    const first = `${checked.stdout}\n${checked.stderr}`.split('\n').find((line) => line.startsWith('FAIL')) ?? `exit ${checked.status}`
    return fail(first.replace(/^FAIL\s*/, ''))
  },
  // K2: khp names the kit-layer version the spec states now, which can be lower than the KHP version
  // (the table's row can name a higher version).
  'manifest.khp-version': ({ manifest }, { khpVersion }) => {
    if ('standard' in manifest) return fail(`standard ${manifest.standard}`)
    return manifest.khp === khpVersion ? pass() : fail(manifest.khp ?? 'no khp')
  },
  'model.schema-valid': (source) => {
    const file = source.manifest.model?.schema
    if (!file) return fail('kit.json names no model.schema')
    const text = source.text(file)
    if (text === null) return fail(`${file} is missing`)
    let schema
    try {
      schema = JSON.parse(text)
    } catch {
      return fail(`${file} is not JSON`)
    }
    // The schema's own rules are kition-kdm's check-schema, a dynamic row.
    return schema.kit === source.manifest.id ? pass(file) : fail(`${file} is for ${schema.kit}`)
  },
  'legal.license-attribution': (source) => {
    const missing = []
    const license = source.text('LICENSE')
    if (!license || !/Apache License/.test(license) || !/Version 2\.0/.test(license)) missing.push('LICENSE (Apache-2.0)')
    if (!source.has('NOTICE')) missing.push('NOTICE')
    if (!source.has(EXPECTED_FILES.attribution)) missing.push(EXPECTED_FILES.attribution)
    return missing.length ? fail(`missing ${missing.join(', ')}`) : pass()
  },
  'engine.contract-v2': ({ manifest }) => (manifest.engine?.contract === 2 ? pass() : fail(`contract ${manifest.engine?.contract ?? 'none'}`)),
  'release.headless-bundled': () => unchecked('needs a release build'),
  'agent-ready.guide': (source) => (source.has(EXPECTED_FILES.agentGuide) ? pass() : fail(`no ${EXPECTED_FILES.agentGuide}`)),
  'editor.kit-only': (source, { kitionDir }) => {
    if (typeof source.manifest.ui?.entry !== 'string' && typeof source.manifest.ui !== 'object') return fail('kit.json has no ui')
    const packages = kitionDir && fs.existsSync(path.join(kitionDir, 'packages')) ? fs.readdirSync(path.join(kitionDir, 'packages')) : []
    const own = packages.filter((dir) => dir === `${source.kit}-editor` || dir === `${source.kit}-kit` || dir === `kit-${source.kit}`)
    return own.length ? fail(own.map((dir) => `kition/packages/${dir}`).join(', ')) : pass()
  },
  'files.feature-catalogue': (source) => {
    const found = source.find(/(^|\/)(features\.ya?ml|FEATURES\.md|catalog\.rs)$/)
    return found.length ? pass(found[0]) : fail('no features.yaml, FEATURES.md, or catalog.rs')
  },
  'files.quality-md': (source) => {
    const missing = []
    if (!source.has(EXPECTED_FILES.quality)) missing.push(EXPECTED_FILES.quality)
    const agents = source.text('AGENTS.md')
    const begin = agents?.indexOf('kition-quality:begin') ?? -1
    // "At the top": nothing but a title line may come before the quality block.
    const before = begin >= 0 ? agents.slice(0, begin).split('\n').filter((line) => line.trim() && !line.startsWith('# ') && !line.trim().startsWith('<!--')) : null
    if (!agents) missing.push('AGENTS.md')
    else if (begin < 0 || before.length) missing.push('the quality block at the top of AGENTS.md')
    const owners = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].map((file) => source.text(file)).find((text) => text !== null)
    if (!owners || !/(^|\s)\/?(\S*\/)?expected\/?(\s|$)/m.test(owners)) missing.push('CODEOWNERS for expected/')
    return missing.length ? fail(`missing ${missing.join(', ')}`) : pass()
  },
  'files.gap-docs': (source) => {
    const missing = [EXPECTED_FILES.gaps, EXPECTED_FILES.parity, EXPECTED_FILES.roadmap].filter((file) => !source.has(file))
    return missing.length ? fail(`missing ${missing.join(', ')}`) : pass()
  },
  'files.writing-format': (source) => (source.has(EXPECTED_FILES.writingFormat) ? pass() : fail(`no ${EXPECTED_FILES.writingFormat}`)),
  'skills.naming': (source) => {
    const names = [...new Set(source.find(/^skills\/[^/]+\//).map((file) => file.split('/')[1]))]
    if (!names.length) return unchecked('no skills/ to compare')
    const wrong = names.filter((name) => !new RegExp(`^${source.kit}-[a-z0-9]+(-[a-z0-9]+)*$`).test(name))
    return wrong.length ? fail(wrong.join(', ')) : pass()
  },
  'files.readme-sections': (source) => {
    const readme = source.text('README.md')
    if (!readme) return fail('no README.md')
    const headings = readme.split('\n').filter((line) => /^#{2,3}\s/.test(line)).join('\n')
    const intro = readme.split(/\n#{2,3}\s/)[0].split('\n').some((line) => line.trim() && !line.startsWith('#') && !line.startsWith('['))
    const sections = {
      what: intro || /(what|about|overview)/i.test(headings),
      format: /format/i.test(headings),
      run: /(run|build|develop|getting started|usage|quick ?start|install)/i.test(headings),
      maturity: /(maturity|status|roadmap)/i.test(headings),
      license: /licen[cs]e/i.test(headings),
    }
    const missing = Object.entries(sections).filter(([, found]) => !found).map(([name]) => name)
    return missing.length ? fail(`missing ${missing.join(', ')}`) : pass()
  },
  'i18n.english': (source) => {
    const english = source.find(/(^|\/)locales\/(en|en-US)(\/[^/]+\.json|\.json)$/)
    return english.length ? pass(english[0].replace(/\/[^/]+$/, '/')) : unchecked('no locale catalogs (strings may be inline)')
  },
  'i18n.launch-locales': (source) => {
    const english = source.find(/(^|\/)locales\/(en|en-US)(\/[^/]+\.json|\.json)$/)
    if (!english.length) return unchecked('no JSON locale catalogs; coverage of other formats is unavailable')
    let missing = 0
    for (const file of english) {
      const zh = file.replace(/locales\/(en|en-US)(\/|\.json)/, 'locales/zh-CN$2')
      const keys = catalogKeys(source.text(file) ?? '') ?? []
      const translated = new Set(catalogKeys(source.text(zh) ?? '') ?? [])
      missing += keys.filter((key) => !translated.has(key)).length
    }
    return missing ? fail(`${missing} strings without zh-CN`) : pass()
  },
  // The latest maintainer-run eval report is checked against the configured requirements.
  // The matrix only reads reports; it never starts a run (F-QA-16).
  'agent.ai-cases': (source) => evalCasesCell(source),
  'release.version-changelog': (source) => {
    const problems = []
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(source.manifest.version ?? '')) problems.push(`version ${source.manifest.version ?? 'none'}`)
    if (!source.has('CHANGELOG.md')) problems.push('no CHANGELOG.md')
    return problems.length ? fail(problems.join(', ')) : pass()
  },
}

/** The AX13 cell: `layer: eval` cases exist, and the newest report under `target/eval/` meets the bar. */
export function evalCasesCell(source, { minimum = 0.85, model = 'claude-sonnet-5' } = {}) {
  const cases = source.find(/(^|\/)cases\/.+\/case\.yaml$/).filter((file) => /^layer:\s*eval\s*$/m.test(source.text(file) ?? ''))
  if (!cases.length) return fail('no layer: eval cases')
  const root = path.join(source.dir, 'target', 'eval')
  const reports = fs.existsSync(root)
    ? fs.readdirSync(root).flatMap((date) => {
        const dir = path.join(root, date)
        return fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).map((run) => path.join(dir, run, 'report.json')).filter((file) => fs.existsSync(file)) : []
      })
    : []
  const real = reports.map((file) => ({ file, report: JSON.parse(fs.readFileSync(file, 'utf8')) })).filter(({ report }) => report.adapter !== 'fake')
  if (!real.length) return unchecked(`${cases.length} eval cases; no maintainer run yet (cargo xtask eval)`)
  real.sort((a, b) => fs.statSync(a.file).mtimeMs - fs.statSync(b.file).mtimeMs)
  const { report } = real.at(-1)
  const lines = report.summary.cases.filter((c) => c.model === model)
  if (!lines.length) return unchecked(`latest run ${report.date} has no ${model} results`)
  const runs = lines.reduce((n, c) => n + c.runs, 0)
  const done = lines.reduce((n, c) => n + c.done, 0)
  const collateral = lines.reduce((n, c) => n + c.collateral, 0)
  const rate = runs ? done / runs : 0
  const value = `${done}/${runs} done, ${collateral} collateral (${report.date})`
  return rate >= minimum && collateral === 0 ? pass(value) : fail(value)
}

/** A cell for each dynamic row DYNAMIC_CHECKS knows: the kit's source and what its headless kit answered (`probe`). */
export const DYNAMIC_CHECKS = {
  // AX5: every command an agent is offered has a parameter schema, and the kit's file parameters
  // are typed (KHP A28): its tests run kition-sdk's file-parameter lint (`kition_kit::files::check`).
  'agent-ready.schema-coverage': (source, probe) => {
    if (probe.error) return unchecked(`the headless kit did not answer: ${probe.error}`)
    if (!Array.isArray(probe.commands)) return fail(`command.list failed: ${probe.commandsError ?? 'no commands'}`)
    const commands = probe.commands
    const withoutSchema = commands.filter((command) => !command.params || typeof command.params.properties !== 'object' || command.params.properties === null)
    const keys = commands.flatMap((command) => Object.values(command.params?.properties ?? {}))
    const typed = (node) => ['type', 'oneOf', 'anyOf', 'allOf', 'enum', 'const', '$ref'].some((key) => key in (node ?? {}))
    const untyped = keys.filter((node) => !typed(node)).length
    const files = keys.filter((node) => node && 'x-khp-file' in node).length
    const lint = source.grep('every_file_parameter_is_declared').length > 0 || source.grep('files::check(').length > 0
    const facts = `${commands.length} commands; ${untyped}/${keys.length} parameters untyped; ${files} typed file parameters offered`
    const problems = []
    if (!commands.length) problems.push('no commands offered')
    if (withoutSchema.length) problems.push(`${withoutSchema.length}/${commands.length} commands without a parameter schema (${withoutSchema.slice(0, 3).map((command) => command.id).join(', ')}${withoutSchema.length > 3 ? ', …' : ''})`)
    if (!lint) problems.push('no file-parameter lint (kition_kit::files::check)')
    return problems.length ? fail(`${problems.join('; ')}; ${facts}`) : pass(facts)
  },
  // AX6: the check is real: agent/checks.json lists every code with a fixture in conformance/, and
  // the kit's document.check on each fixture yields that code.
  'agent-ready.check-catalogue': (source, probe) => {
    const text = source.text('agent/checks.json')
    if (text === null) return fail('no agent/checks.json')
    let catalogue
    try {
      catalogue = JSON.parse(text)
    } catch {
      return fail('agent/checks.json is not JSON')
    }
    if (!Array.isArray(catalogue) || !catalogue.length) return fail('agent/checks.json lists no codes')
    const missing = catalogue.filter((entry) => !entry.fixture || !source.has(`conformance/${entry.fixture}`))
    if (missing.length) return fail(`${missing.length}/${catalogue.length} codes without a fixture in conformance/ (${missing.slice(0, 3).map((entry) => entry.code).join(', ')}${missing.length > 3 ? ', …' : ''})`)
    if (probe.error) return unchecked(`the headless kit did not answer: ${probe.error}`)
    const wrong = catalogue.filter((entry) => !(probe.checks?.[entry.fixture]?.codes ?? []).includes(entry.code))
    if (wrong.length) {
      const first = wrong[0]
      const got = probe.checks?.[first.fixture]
      return fail(`${wrong.length}/${catalogue.length} fixtures do not yield their code (${first.fixture}: ${got?.error ?? JSON.stringify(got?.codes ?? [])})`)
    }
    return pass(`${catalogue.length} codes, each from its fixture`)
  },
  // AX14 (proposed): every command an agent is offered says what it does (KitCommand.description:
  // four words or more, not the title, not parameter notation), every offered read command says
  // what it answers (output schema), unless the kit's own check_commands lint lists it as answering
  // nothing, and at least 95% of parameter keys are typed. The same rules as
  // kition_kit::testing::check_commands, which the kit's tests must run.
  'agent-ready.command-descriptions': (source, probe) => {
    if (probe.error) return unchecked(`the headless kit did not answer: ${probe.error}`)
    if (!Array.isArray(probe.commands)) return fail(`command.list failed: ${probe.commandsError ?? 'no commands'}`)
    const commands = probe.commands
    if (!commands.length) return fail('no commands offered')
    const plain = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const described = (command) => {
      const text = String(command.description ?? '').trim()
      return text.length > 0 && !text.startsWith('Params:') && plain(text) !== plain(command.title) && text.split(/\s+/).length >= 4
    }
    const reads = commands.filter((command) => command.mutates === false)
    const withOutput = reads.filter((command) => command.output && typeof command.output === 'object')
    const keys = commands.flatMap((command) => Object.values(command.params?.properties ?? {}))
    const typed = (node) => ['type', 'oneOf', 'anyOf', 'allOf', 'enum', 'const', '$ref'].some((key) => key in (node ?? {}))
    const typedKeys = keys.filter(typed).length
    const share = (part, whole) => (whole ? Math.floor((part / whole) * 100) : 100)
    const describedCount = commands.filter(described).length
    const lint = source.grep('check_commands(').length > 0
    const facts = `${describedCount}/${commands.length} commands described; ${withOutput.length}/${reads.length} read commands declare an output; ${typedKeys}/${keys.length} parameter keys typed (${share(typedKeys, keys.length)}%)`
    const problems = []
    if (describedCount < commands.length) problems.push(`${commands.length - describedCount} commands without a real description (${commands.filter((command) => !described(command)).slice(0, 3).map((command) => command.id).join(', ')}${commands.length - describedCount > 3 ? ', …' : ''})`)
    if (!lint) problems.push('no description lint (kition_kit::testing::check_commands)')
    if (withOutput.length < reads.length && !lint) problems.push(`${reads.length - withOutput.length} read commands without an output schema`)
    if (keys.length && typedKeys / keys.length < 0.95) problems.push(`only ${share(typedKeys, keys.length)}% of parameter keys typed`)
    return problems.length ? fail(`${problems.join('; ')}; ${facts}`) : pass(facts)
  },
  // KH1: kit.json says its level, and a level above basic is backed by the kit's tests running
  // kition_headless::agent_ready::check (KHP K19; the MCP form is khp check).
  'manifest.level': (source) => {
    const level = source.manifest.level
    if (!level) return fail('kit.json says no level')
    if (level === 'basic') return pass(level)
    return source.grep('agent_ready::check').length ? pass(level) : fail(`${level}, but no test runs kition_headless::agent_ready::check`)
  },
}

/** kition-sdk's kit-probe executable, built once. */
function probeExecutable() {
  const sdk = path.resolve(here, '..')
  const built = spawnSync('cargo', ['build', '-q', '-p', 'kition-kit-host', '--bin', 'kit-probe'], { cwd: sdk, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`cargo build kit-probe failed: ${built.stderr.trim().split('\n').pop()}`)
  return path.join(sdk, 'target', 'debug', 'kit-probe')
}

/** What a kit's headless executable answers: built in its repository, launched on a copy of its conformance/ folder. */
export function probeKit(source, probe) {
  const built = spawnSync('cargo', ['build', '-q', '-p', `kition-${source.kit}`], { cwd: source.dir, encoding: 'utf8' })
  if (built.status !== 0) return { error: `cargo build -p kition-${source.kit} failed: ${(built.stderr || '').trim().split('\n').pop()}` }
  const executable = path.join(source.dir, 'target', 'debug', `kition-${source.kit}`)
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `kit-matrix-${source.kit}-`))
  try {
    for (const file of source.find(/^conformance\/[^/]+$/)) fs.copyFileSync(path.join(source.dir, file), path.join(workspace, path.basename(file)))
    const extension = (source.manifest.formats ?? []).find((format) => format.role === 'edit')?.extensions?.[0]
    const basic = extension && source.has(`conformance/basic.${extension}`) ? `basic.${extension}` : null
    let catalogue = []
    try {
      catalogue = JSON.parse(source.text('agent/checks.json') ?? '[]')
    } catch {
      catalogue = []
    }
    const fixtures = (Array.isArray(catalogue) ? catalogue : []).map((entry) => entry.fixture).filter((fixture) => fixture && source.has(`conformance/${fixture}`))
    const args = [executable, workspace, ...(basic ? ['--open', basic] : []), ...[...new Set(fixtures)].flatMap((fixture) => ['--check', fixture])]
    const run = spawnSync(probe, args, { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 600_000 })
    try {
      return JSON.parse(run.stdout)
    } catch {
      return { error: `kit-probe exit ${run.status}: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}` }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * The waivers that apply, by kit: each kit repository's cases/waivers.yaml and the --waivers folder.
 * A kit-waivers.yaml left at a repository's root (the old location) is not read; it is a warning.
 */
export function loadWaivers({ reposDir, waiversDir, kits, rows, reads }) {
  const byKit = Object.fromEntries(kits.map((kit) => [kit, []]))
  const warnings = []
  const files = []
  for (const kit of kits) {
    files.push(path.join(reposDir, `kition-${kit}`, WAIVERS_FILE))
    if (waiversDir) files.push(path.join(waiversDir, `${kit}.yaml`))
    if (fs.existsSync(path.join(reposDir, `kition-${kit}`, 'kit-waivers.yaml'))) {
      warnings.push(`kition-${kit}/kit-waivers.yaml: not read; move it to ${WAIVERS_FILE}`)
    }
  }
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    reads.push(path.resolve(file))
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || !Object.hasOwn(byKit, parsed.kit)) {
      warnings.push(`${file}: names no known kit`)
      continue
    }
    for (const waiver of parsed.waivers ?? []) {
      const row = rows.find((candidate) => candidate.id === waiver.requirement)
      if (!waiver.approved_on || !waiver.approved_by) {
        warnings.push(`${parsed.kit} ${waiver.requirement}: not approved, not applied`)
        continue
      }
      if (waiver.requirement === '*' && waiver.kind !== 'frozen') {
        warnings.push(`${parsed.kit} *: only a frozen waiver covers every row`)
        continue
      }
      if (row && waiver.check_id && waiver.check_id !== row.check_id) {
        warnings.push(`${parsed.kit} ${waiver.requirement}: check_id ${waiver.check_id} is now ${row.check_id}, not applied`)
        continue
      }
      byKit[parsed.kit].push({ ...waiver, expires: String(waiver.expires), source: path.basename(file) })
    }
  }
  return { byKit, warnings }
}

/** Applies a kit's waivers to a cell: approved and in date, a failing or unchecked cell is waived; expired, it fails. */
function withWaiver(cell, row, waivers, date, warnings, kit) {
  const waiver = waivers.find((candidate) => candidate.requirement === row.id) ?? waivers.find((candidate) => candidate.requirement === '*')
  if (!waiver) return cell
  const expired = waiver.expires < date
  const note = { kind: waiver.kind, expires: waiver.expires, tracking: waiver.tracking }
  if (cell.state === 'pass' || cell.state === 'n/a') {
    if (waiver.requirement !== '*') warnings.push(`${kit} ${row.id}: the waiver is no longer needed`)
    return cell
  }
  if (expired) return { state: 'fail', value: `${cell.value ?? ''}${cell.value ? '; ' : ''}waiver expired ${waiver.expires}`, waiver: { ...note, expired } }
  return { state: 'waived', value: cell.value, waiver: note }
}

/**
 * The kit-layer version the KHP specification states (the Kit layer row of `spec/index.md`), when its
 * checkout is beside the kits: what a kit's `khp` names (K2), not the KHP version above it.
 */
function specKitLayerVersion(reposDir, reads) {
  const index = path.join(reposDir, 'khp', 'spec', 'index.md')
  if (!fs.existsSync(index)) return DEFAULT_KIT_LAYER_VERSION
  reads.push(path.resolve(index))
  return /^\|\s*Kit layer\s*\|\s*(\d+\.\d+)/m.exec(fs.readFileSync(index, 'utf8'))?.[1] ?? DEFAULT_KIT_LAYER_VERSION
}

/** The matrix: one cell per static row and kit. */
export function buildMatrix({
  requirementsFile,
  reposDir,
  waiversDir,
  kitionDir = path.join(reposDir, 'kition'),
  date = new Date().toISOString().slice(0, 10),
  kits: kitList,
  dynamic = false,
  probe = null,
}) {
  const reads = []
  // What every kit's khp must name (K2): the spec's kit-layer version.
  const khpVersion = specKitLayerVersion(reposDir, reads)
  const requirements = loadRequirements(requirementsFile, { dynamic })
  const { version, rows, total, staticRows, dynamicRows } = requirements
  const kits = kitList ?? requirements.kits
  reads.push(path.resolve(requirementsFile))
  const { byKit, warnings } = loadWaivers({ reposDir, waiversDir, kits, rows, reads })
  const sources = Object.fromEntries(kits.map((kit) => [kit, kitSource(reposDir, kit, reads)]))
  // What each kit's headless kit answers, asked once per kit and only when a dynamic row needs it.
  const probes = {}
  let probeBin = null
  const answered = (kit) => {
    if (!Object.hasOwn(probes, kit)) {
      try {
        if (probe) probes[kit] = probe(sources[kit])
        else {
          probeBin ??= probeExecutable()
          probes[kit] = probeKit(sources[kit], probeBin)
        }
      } catch (error) {
        probes[kit] = { error: error.message }
      }
    }
    return probes[kit]
  }
  const matrix = rows.map((row) => {
    const cells = {}
    for (const kit of kits) {
      let cell
      if (!sources[kit]) cell = unchecked(`no checkout at kition-${kit}`)
      else if (!sources[kit].manifest) cell = fail('no readable kit.json')
      else {
        const scope = applies(row, sources[kit])
        const dynamicCheck = row.automation === 'dynamic' ? DYNAMIC_CHECKS[row.check_id] : null
        const check = dynamicCheck ? (kitSourceOf, context) => dynamicCheck(kitSourceOf, dynamicCheck.length > 1 ? answered(kit) : {}, context) : CHECKS[row.check_id]
        if (scope === false) cell = notApplicable()
        else if (scope === null) cell = unchecked(`appliesTo ${row.appliesTo} is not settled statically`)
        else if (!check) cell = unchecked(`no check for ${row.check_id}`)
        else {
          try {
            cell = check(sources[kit], { kitionDir, khpVersion })
          } catch (error) {
            cell = unchecked(`the check failed: ${error.message}`)
          }
        }
      }
      cells[kit] = withWaiver(cell, row, byKit[kit] ?? [], date, warnings, kit)
    }
    return { id: row.id, title: row.title, tier: row.tier, check_id: row.check_id, automation: row.automation, cells }
  })
  // Relative to the repositories' folder, so a matrix kept in a repository names no host path.
  const relative = [...new Set(reads.map((file) => path.relative(path.resolve(reposDir), file).split(path.sep).join('/')))]
  return { date, requirements: version, khpVersion, kits, rows: matrix, staticRows, dynamicRows, totalRows: total, warnings, expectedFiles: EXPECTED_FILES, reads: relative }
}

const SYMBOL = { pass: '✅', fail: '❌', waived: '🟡', 'n/a': '—', unchecked: '⬜' }

/** The matrix as Markdown. */
export function renderMarkdown(matrix) {
  const escape = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const cell = (value) => {
    const parts = [SYMBOL[value.state]]
    if (value.state === 'waived') parts.push(`until ${value.waiver.expires}`)
    if (value.value && value.state !== 'pass') parts.push(escape(value.value))
    if (value.waiver && value.state !== 'waived') parts.push(`(waiver ${value.waiver.kind} ${value.waiver.expired ? 'expired' : 'until'} ${value.waiver.expires})`)
    return parts.join(' ')
  }
  const lines = [
    `# Kit matrix (${matrix.date})`,
    '',
    matrix.dynamicRows
      ? `Generated by kition-sdk \`tools/kit-matrix.mjs --dynamic\` from kit-requirements.yaml ${matrix.requirements}: the ${matrix.staticRows} static rows and ${matrix.dynamicRows} dynamic rows (each kit's headless executable, built from its main, asked through \`kit-probe\`) of ${matrix.totalRows}.`
      : `Generated by kition-sdk \`tools/kit-matrix.mjs\` from kit-requirements.yaml ${matrix.requirements}: the ${matrix.staticRows} static rows of ${matrix.totalRows}; dynamic rows with --dynamic, manual rows require review.`,
    '',
    '✅ pass · ❌ fail (with the value found) · 🟡 waived (until) · — not applicable · ⬜ unchecked (with why)',
    '',
    `| Row | Tier | ${matrix.kits.join(' | ')} |`,
    `|---|---|${matrix.kits.map(() => '---').join('|')}|`,
    ...matrix.rows.map((row) => `| ${row.id} ${escape(row.title)} | ${row.tier} | ${matrix.kits.map((kit) => cell(row.cells[kit])).join(' | ')} |`),
    '',
    `Files the static rows expect where the table names none: ${Object.values(matrix.expectedFiles).map((file) => `\`${file}\``).join(', ')}. K2 checks \`khp\` against the spec's kit-layer version, ${matrix.khpVersion}.`,
  ]
  if (matrix.warnings.length) lines.push('', '## Warnings', '', ...matrix.warnings.map((warning) => `- ${escape(warning)}`))
  return `${lines.join('\n')}\n`
}

function usage() {
  console.error(
    'usage: kit-matrix.mjs --requirements <kit-requirements.yaml> --repos <folder> [--waivers <folder>] [--kition <kition checkout>] [--date YYYY-MM-DD] [--out <folder>] [--kits <kit,kit,...>] [--dynamic true]',
  )
  return 2
}

function main(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (!['requirements', 'repos', 'waivers', 'date', 'out', 'kition', 'kits', 'dynamic'].includes(key) || argv[index + 1] === undefined) {
      return usage()
    }
    options[key] = argv[index + 1]
  }
  if (!options.requirements || !options.repos) return usage()
  const matrix = buildMatrix({
    requirementsFile: options.requirements,
    reposDir: options.repos,
    waiversDir: options.waivers,
    ...(options.kition ? { kitionDir: options.kition } : {}),
    ...(options.date ? { date: options.date } : {}),
    ...(options.kits ? { kits: options.kits.split(',').map((kit) => kit.trim()).filter(Boolean) } : {}),
    dynamic: options.dynamic === 'true',
  })
  const out = options.out ?? '.'
  fs.mkdirSync(out, { recursive: true })
  const base = path.join(out, `kit-matrix-${matrix.date}`)
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(matrix, null, 2)}\n`)
  fs.writeFileSync(`${base}.md`, renderMarkdown(matrix))
  console.log(`wrote ${base}.md and ${base}.json: ${matrix.rows.length} rows × ${matrix.kits.length} kits, ${matrix.warnings.length} warnings`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
