#!/usr/bin/env node
// Checks a Kition kit manifest (kit.json): the shape in schemas/kit.schema.json, then the rules a
// schema cannot express. Two texts set them, and every message names its rule as one of them:
//
// - KHP rules (KHP 1.0, KHP spec/manifest.md): the fields khp, id, name, version,
//   formats, creates, exports, agent, and level; K1, K2, K4, K5, K16, K17, K19, K21 (agent.links).
// - Platform rules (the Kition kit platform, docs/platform/kits/manifest.md): engine, model, ui,
//   headless, collaboration, files, and the rest; K3, K6 to K15, K18, K21 (agent.describe, render,
//   parts, export), K22, M21, M23, U5b. They key off the platform fields themselves
//   (engine.contract, model, ui), never off the KHP version. KHP K21 and platform K21 are two
//   rules; the label says which.
//
// It prints WARN for what a manifest alone cannot settle (the package's agent/ files, proposed
// rules), then the platform conformance levels the manifest supports (docs/platform/kits/levels.md).
//
//   node tools/check-manifest.mjs path/to/kit.json [--module <engine dir>] [--convergence <report.json>]
//
// With --module (a wasm-pack output folder, or a ts-worker engine's folder), it also loads the
// built engine and checks that the manifest matches it: the class exists, contractVersion()
// matches engine.contract, a contract 2 engine has the session members, and every declared extra
// exists. With --convergence, it reads the report the kit's
// convergence test wrote (kition-convergence, through KITION_CONVERGENCE_REPORT) for L6.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkKitNaming } from './kit-naming.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'kit.schema.json'), 'utf8'))
const file = process.argv[2]
if (!file) {
  console.error('usage: check-manifest.mjs <kit.json> [--module <dir>]')
  process.exit(2)
}
const moduleIndex = process.argv.indexOf('--module')
const moduleDir = moduleIndex > 0 ? path.resolve(process.argv[moduleIndex + 1]) : null
const convergenceIndex = process.argv.indexOf('--convergence')
const convergenceFile = convergenceIndex > 0 ? path.resolve(process.argv[convergenceIndex + 1]) : null

const failures = []
const fail = (where, message) => failures.push(`${where || '(root)'}: ${message}`)
const warnings = []
const warn = (where, message) => warnings.push(`${where || '(root)'}: ${message}`)
/** Rule labels: a KHP rule (KHP spec/), or a Kition platform rule (docs/platform/). */
const KHP = (rule) => `(KHP ${rule})`
const PLATFORM = (rule) => `(platform ${rule})`

/** A small validator for the JSON Schema subset kit.schema.json uses. */
function validate(node, value, where) {
  if (node.$ref) node = node.$ref.split('/').slice(1).reduce((at, key) => at[key], schema)
  if (node.const !== undefined && value !== node.const) return fail(where, `must be ${JSON.stringify(node.const)}`)
  if (node.enum && !node.enum.includes(value)) return fail(where, `must be one of ${node.enum.join(', ')}`)
  if (node.type) {
    const ok = {
      object: value !== null && typeof value === 'object' && !Array.isArray(value),
      array: Array.isArray(value),
      string: typeof value === 'string',
      integer: Number.isInteger(value),
      number: typeof value === 'number',
      boolean: typeof value === 'boolean',
    }[node.type]
    if (!ok) return fail(where, `must be ${node.type === 'integer' ? 'an integer' : `a${/^[aeiou]/.test(node.type) ? 'n' : ''} ${node.type}`}`)
  }
  if (typeof value === 'string') {
    if (node.pattern && !new RegExp(node.pattern).test(value)) fail(where, `"${value}" does not match ${node.pattern}`)
    if (node.minLength && value.length < node.minLength) fail(where, 'must not be empty')
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) fail(where, `must be at least ${node.minimum}`)
  if (typeof value === 'number' && node.maximum !== undefined && value > node.maximum) fail(where, `must be at most ${node.maximum}`)
  if (Array.isArray(value)) {
    if (node.minItems && value.length < node.minItems) fail(where, `needs at least ${node.minItems} item(s)`)
    if (node.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail(where, 'has duplicates')
    if (node.items) value.forEach((item, index) => validate(node.items, item, `${where}[${index}]`))
  }
  if (node.type === 'object' && value && typeof value === 'object') {
    for (const key of node.required ?? []) if (!(key in value)) fail(where, `missing "${key}"`)
    for (const [key, item] of Object.entries(value)) {
      const at = where ? `${where}.${key}` : key
      if (node.propertyNames?.pattern && !new RegExp(node.propertyNames.pattern).test(key)) fail(at, `name does not match ${node.propertyNames.pattern}`)
      if (node.properties?.[key]) validate(node.properties[key], item, at)
      else if (node.additionalProperties === false) fail(at, 'is not a manifest field')
      else if (typeof node.additionalProperties === 'object') validate(node.additionalProperties, item, at)
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
validate(schema, manifest, '')
for (const message of checkKitNaming(manifest)) failures.push(message)

// KHP rules beyond the schema (KHP spec/manifest.md).
const owned = new Set((manifest.formats ?? []).filter((format) => format.role === 'edit').flatMap((format) => format.extensions))
for (const created of manifest.creates ?? []) {
  if (!owned.has(created.extension)) fail(`creates.${created.id}`, `.${created.extension} is not a format the kit edits ${KHP('K4')}`)
}
for (const exported of manifest.exports ?? []) {
  if (owned.has(exported.extension)) fail(`exports.${exported.extension}`, `an export cannot also be a format the kit edits in place ${KHP('K5')}`)
}

// The tier the kit claims (K19) and what it asks of the manifest (K16) and the package (K17).
const level = manifest.level ?? 'basic'
const agentReady = level === 'agent-ready' || level === 'agent-ready-complete'
const features = Array.isArray(manifest.headless?.features) ? manifest.headless.features : null
const serves = (...names) => features !== null && names.every((name) => features.includes(name))
const beside = (name) => fs.existsSync(path.join(path.dirname(path.resolve(file)), name))
if (agentReady) {
  if (!manifest.agent) fail('agent', `a kit that claims ${level} names its tool prefix in agent.prefix ${KHP('K16')}`)
  for (const field of ['objectModel', 'layout']) {
    if (manifest.agent && typeof manifest.agent[field] !== 'boolean') {
      fail(`agent.${field}`, `a kit that claims ${level} says true or false: it decides which tools and answers khp check requires ${KHP('K16')}`)
    }
  }
  if (!beside('agent/checks.json')) warn('agent/checks.json', `not beside kit.json; the package of an ${level} kit must contain its check catalogue ${KHP('K17')}`)
  if (level === 'agent-ready-complete' && !beside('agent/guide.md')) {
    warn('agent/guide.md', `not beside kit.json; the package of an agent-ready-complete kit must contain its guide ${KHP('K17')}`)
  }
}
// agent.links (K21, every tier; the schema refuses a value that is not a boolean): a kit whose
// documents link or embed other files says true and ships conformance/links-outside.<ext> beside
// kit.json, named as khp check names it (the first extension of the format the kit edits), which
// phase 11 opens and fails without.
if (manifest.agent?.links === true) {
  const formats = Array.isArray(manifest.formats) ? manifest.formats : []
  const extension = (formats.find((format) => format?.role === 'edit') ?? formats[0])?.extensions?.[0]
  const fixture = `conformance/links-outside.${extension}`
  if (typeof extension === 'string' && !beside(fixture)) {
    fail(fixture, `not beside kit.json; a kit that declares agent.links: true ships it, and khp check fails phase 11 without it ${KHP('K21')}`)
  }
}
// agent.objectModel says whether the kit offers <prefix>_query and <prefix>_batch; on the platform
// they are its headless executable's model.describe and model.batch (platform K9).
if (manifest.agent?.objectModel === true && features !== null && !serves('model.describe', 'model.batch')) {
  fail('agent.objectModel', `is true, but headless.features lacks model.describe and model.batch ${KHP('K16')}, ${PLATFORM('K9')}`)
}
if (agentReady && manifest.agent && manifest.agent.objectModel !== true && serves('model.describe', 'model.batch')) {
  fail('agent.objectModel', `the headless executable serves model.describe and model.batch, so the object model tools are offered: say true ${KHP('K16')}`)
}

// Platform rules (docs/platform/kits/manifest.md). They key off the platform fields, never khp.
if (manifest.agent && !manifest.agent.tools) fail('agent.tools', `say "document" or "commands" ${PLATFORM('kits/manifest.md')}`)
if (agentReady) {
  if (!manifest.headless?.executable) warn('headless.executable', `an ${level} Kition kit serves its tools from a headless executable ${PLATFORM('K16, proposed')}`)
  else if (!serves('document.check')) warn('headless.features', `an ${level} Kition kit serves document.check ${PLATFORM('K16, proposed')}`)
  if (manifest.agent?.layout === true && manifest.headless?.executable && !serves('view.layout')) {
    warn('headless.features', `an ${level} layout kit serves view.layout ${PLATFORM('K16, proposed')}`)
  }
}
// document.text is a platform capability, not a protocol feature (K22, KitText 1.0).
if (serves('document.text')) fail('headless.features', `document.text is declared as the capability document-text in headless.capabilities ${PLATFORM('K22')}`)
// The editor state inspect() reports (K23): hosts leave it out of what an agent reads as the
// document. The schema checks its shape; the kit's own test checks that it is the engine's list.
if (manifest.engine && !Array.isArray(manifest.engine.editorState)) {
  warn('engine.editorState', `not declared, so a host reads every key of inspect() as the document: list the engine's editor state, [] when it reports none ${PLATFORM('K23')}`)
}
// An embedded UI names its entry (K8).
if (manifest.ui?.mode === 'embedded' && !manifest.ui.entry) fail('ui.entry', `an embedded UI names its HTML entry ${PLATFORM('K8')}`)

// Engine contract 2: a kit on the Kit Data Model (K10 to K14).
const contract = manifest.engine?.contract
const kdm = (manifest.capabilities ?? []).includes('kdm')
if (contract === 2 && !kdm) fail('capabilities', `an engine contract 2 kit lists the kdm capability ${PLATFORM('K10')}`)
if (kdm && contract !== 2) fail('engine.contract', `the kdm capability needs engine contract 2 ${PLATFORM('K10')}`)
let modelSchema = null
if (contract === 2) {
  if (!manifest.distribution) fail('distribution', `an engine contract 2 kit says "default" or "plugin" ${PLATFORM('K11')}`)
  if (manifest.engine && !manifest.engine.runtime) fail('engine.runtime', `an engine contract 2 kit says "rust-wasm" or "ts-worker" ${PLATFORM('K11')}`)
  if (!manifest.model) fail('model', `an engine contract 2 kit names its KDM schema ${PLATFORM('K12')}`)
  if (!manifest.collaboration) fail('collaboration', `an engine contract 2 kit declares how its documents merge ${PLATFORM('K13')}`)
  if (!manifest.objectModel) fail('objectModel', `an engine contract 2 kit names its object model namespace ${PLATFORM('K14')}`)
}
if (typeof manifest.model?.schema === 'string') {
  const schemaFile = path.resolve(path.dirname(path.resolve(file)), manifest.model.schema)
  if (!fs.existsSync(schemaFile)) fail('model.schema', `${manifest.model.schema} does not exist next to kit.json ${PLATFORM('K12')}`)
  else {
    try {
      modelSchema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
    } catch (error) {
      fail('model.schema', `${manifest.model.schema} is not JSON: ${error.message} ${PLATFORM('K12')}`)
    }
  }
  if (modelSchema) {
    if (modelSchema.kdm !== 1) fail('model.schema', `the schema has kdm ${JSON.stringify(modelSchema.kdm)}; this checker reads kdm 1 ${PLATFORM('K12')}`)
    if (modelSchema.kit !== manifest.id) fail('model.schema', `the schema belongs to ${JSON.stringify(modelSchema.kit)}, not ${manifest.id} ${PLATFORM('K12')}`)
    if (modelSchema.schemaVersion !== manifest.model.schemaVersion) {
      fail('model.schemaVersion', `is ${manifest.model.schemaVersion}, but the schema file says ${modelSchema.schemaVersion} ${PLATFORM('K12')}`)
    }
    if (!modelSchema.types || typeof modelSchema.types !== 'object' || !modelSchema.types[modelSchema.root]) {
      fail('model.schema', `the schema has no types or no root type ${PLATFORM('K12')}`)
    }
  }
}
for (const lease of manifest.collaboration?.leases ?? []) {
  if (lease !== '*' && !/^[A-Za-z0-9._:-]*(\{objectId\}[A-Za-z0-9._:-]*)?$/.test(lease)) {
    fail('collaboration.leases', `"${lease}" is not a scope pattern: a name, a name with {objectId}, or * ${PLATFORM('M21')}`)
  }
}

// Files beyond the document (K15): the files capability and its lists go together, and the
// lists cover the exports, which go through files/create.
const filesCapability = (manifest.capabilities ?? []).includes('files')
if (manifest.files && !filesCapability) fail('capabilities', `a kit that declares files lists the files capability ${PLATFORM('K15')}`)
if (filesCapability && !manifest.files) fail('files', `a kit that lists the files capability declares what it may ask for ${PLATFORM('K15')}`)
if (manifest.files) {
  const creates = new Set(manifest.files.create ?? [])
  for (const exported of manifest.exports ?? []) {
    if (!creates.has(exported.extension)) fail('files.create', `does not cover the export .${exported.extension} ${PLATFORM('K15')}`)
  }
}

// Export commands (K21): <prefix>_export and the kit's self-test run agent.export.command for every
// format, and nothing reads exports[].command (optional in the schema, to be omitted); where a kit
// still names one that disagrees, the check says so. The export command is one the agent may run. The manifest cannot say which of two disagreeing commands is right (the
// engine decides), so these are warnings, as is a command that agent.include, agent.exclude, or
// agent/commands.json shows the agent cannot run.
const agentExport = typeof manifest.agent?.export?.command === 'string' ? manifest.agent.export.command : null
const exportNames = [...new Set((manifest.exports ?? []).map((exported) => exported.command).filter((command) => typeof command === 'string'))]
if (exportNames.length > 1) {
  warn('exports', `name ${exportNames.length} commands (${exportNames.join(', ')}), but agent.export runs one command for every format: give them one command that switches on format ${PLATFORM('K21')}`)
}
if (agentExport) {
  for (const exported of manifest.exports ?? []) {
    if (typeof exported.command === 'string' && exported.command !== agentExport) {
      warn(
        `exports.${exported.extension}.command`,
        `"${exported.command}", but agent.export.command is "${agentExport}": ${manifest.agent.prefix}_export and the kit's self-test run ${agentExport} for .${exported.extension}, and nothing reads exports[].command: omit it ${PLATFORM('K21')}`,
      )
    }
  }
}
const glob = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
const matches = (patterns, command) => Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === 'string' && glob(pattern).test(command))
const catalogueFile = path.join(path.dirname(path.resolve(file)), 'agent', 'commands.json')
let catalogue = null
if (fs.existsSync(catalogueFile)) {
  try {
    const listed = JSON.parse(fs.readFileSync(catalogueFile, 'utf8')).commands
    if (Array.isArray(listed)) catalogue = new Set(listed.map((entry) => entry?.command))
  } catch {
    warn('agent/commands.json', `is not JSON, so the export commands cannot be checked against it ${PLATFORM('K17')}`)
  }
}
/** Why the agent cannot run `command`, when the manifest and its package show it; null otherwise. */
const notAgentFacing = (command) => {
  if (matches(manifest.agent?.exclude, command)) return 'agent.exclude names it'
  if (Array.isArray(manifest.agent?.include) && !matches(manifest.agent.include, command)) return 'agent.include does not select it'
  if (catalogue && !catalogue.has(command)) return 'agent/commands.json does not list it'
  return null
}
const exportCommands = new Map()
if (agentExport) exportCommands.set(agentExport, 'agent.export.command')
for (const exported of manifest.exports ?? []) {
  if (typeof exported.command === 'string' && !exportCommands.has(exported.command)) exportCommands.set(exported.command, `exports.${exported.extension}.command`)
}
for (const [command, where] of exportCommands) {
  const why = notAgentFacing(command)
  if (why) warn(where, `"${command}" is not an agent-facing command: ${why} ${PLATFORM('K21')}`)
}

// Comment commands (M23): they write comment threads, which the KDM schema declares; never the
// history or a file command, which a commenter's read-only session refuses whatever the list says.
const commentCommands = manifest.collaboration?.comments?.commands
if (Array.isArray(commentCommands)) {
  if (!manifest.model) fail('collaboration.comments', `comment commands need a KDM schema (model) ${PLATFORM('M23')}`)
  if (modelSchema && !(modelSchema.types?.CommentThread && modelSchema.types?.Comment)) {
    fail('collaboration.comments', `the schema declares no CommentThread and Comment types for its comment commands ${PLATFORM('M23')}`)
  }
  for (const id of commentCommands) {
    if (typeof id === 'string' && (/^(edit\.)?(undo|redo)$/.test(id) || id.startsWith('file.'))) {
      fail('collaboration.comments.commands', `"${id}" is not a comment command: the history and file commands stay refused for a commenter ${PLATFORM('M23')}`)
    }
  }
}

// A brand color must read well (U5b). The same math as packages/kit-editor/src/brand.ts.
const luminance = (hex) => {
  const value = parseInt(hex.slice(1), 16)
  const channel = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255)
}
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
const HEX = /^#[0-9a-fA-F]{6}$/
const brand = manifest.ui?.brand
if (brand && HEX.test(brand.light ?? '') && HEX.test(brand.dark ?? '')) {
  if (contrast(brand.light, '#ffffff') < 4.5) fail('ui.brand.light', `needs at least 4.5:1 with white text (has ${contrast(brand.light, '#ffffff').toFixed(2)}) ${PLATFORM('U5b')}`)
  if (contrast(brand.dark, '#000000') < 4.5) fail('ui.brand.dark', `needs at least 4.5:1 with black text (has ${contrast(brand.dark, '#000000').toFixed(2)}) ${PLATFORM('U5b')}`)
  for (const surface of ['#1b1e23', '#323232']) {
    if (contrast(brand.dark, surface) < 3) fail('ui.brand.dark', `needs at least 3:1 on the dark surface ${surface} (has ${contrast(brand.dark, surface).toFixed(2)}) ${PLATFORM('U5b')}`)
  }
}

if (moduleDir && manifest.engine) {
  const sdk = await import(pathToFileURL(path.join(moduleDir, `${manifest.engine.module}.js`)).href)
  if (manifest.engine.runtime === 'ts-worker') {
    // A TypeScript engine prepares itself from its folder; in Node it reads its files through `read`.
    const base = pathToFileURL(moduleDir + path.sep).href
    if (typeof sdk.default === 'function') await sdk.default({ base, read: async (name) => new Uint8Array(fs.readFileSync(path.join(moduleDir, name))) })
  } else {
    await sdk.default({ module_or_path: fs.readFileSync(path.join(moduleDir, `${manifest.engine.module}_bg.wasm`)) })
  }
  const Document = sdk[manifest.engine.class]
  if (!Document) fail('engine.class', `${manifest.engine.module} exports no ${manifest.engine.class}`)
  else {
    const version = typeof Document.contractVersion === 'function' ? Document.contractVersion() : 1
    // A contract 2 engine keeps contract 1's members, so engines built for contract 1 hosts still
    // answer 1; its session members are what make it contract 2.
    const accepted = manifest.engine.contract === 2 ? [1, 2] : [manifest.engine.contract]
    if (!accepted.includes(version)) fail('engine.contract', `the module implements contract ${version} ${PLATFORM('K3')}`)
    if (manifest.engine.contract === 2) {
      if (typeof Document.openWithReplica !== 'function') fail('engine.contract', `a contract 2 module has a static openWithReplica ${PLATFORM('K3')}`)
      for (const member of ['version', 'exportChanges', 'importChanges', 'snapshot', 'executeAs']) {
        if (typeof Document.prototype[member] !== 'function') fail('engine.contract', `a contract 2 module has ${member} ${PLATFORM('K3')}`)
      }
    }
    // The engine-tools capability is a fixed set of members (docs/platform/kits/ui.md, U8a).
    if ((manifest.capabilities ?? []).includes('engine-tools')) {
      for (const member of ['tools', 'tool', 'selectTool', 'pointer', 'toolKey', 'toolText', 'toolState']) {
        if (typeof Document.prototype[member] !== 'function') fail('capabilities.engine-tools', `the module has no ${member} ${PLATFORM('U8a')}`)
      }
    }
    for (const extra of Object.keys(manifest.extras ?? {})) {
      if (typeof Document.prototype[extra] !== 'function') fail(`extras.${extra}`, `the module has no such method ${PLATFORM('K6')}`)
    }
  }
}

for (const message of warnings) console.log(`WARN ${message}`)
if (failures.length) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`${path.basename(file)}: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log(
  `PASS ${manifest.id} ${manifest.version}: KHP ${manifest.khp} manifest, tier ${level} claimed (khp check tests it), and Kition platform fields${moduleDir ? '; matches its module' : ''}`,
)

// Kition platform conformance levels (docs/platform/kits/levels.md), not KHP tiers, as far as a
// manifest shows them. L1 needs check_contract and tools/check-sdk.mjs too, L4 the kit in
// @kition/dsh-kits (plugins/deepseek-harness/kition-kits, which serves every published kit:
// published-kits.json), and L5 the kit's import/export round trip tests.
let convergence = null
if (convergenceFile) {
  try {
    convergence = JSON.parse(fs.readFileSync(convergenceFile, 'utf8'))
  } catch (error) {
    console.log(`FAIL --convergence: ${error.message}`)
    process.exit(1)
  }
  if (convergence.kit !== manifest.id) {
    console.log(`FAIL --convergence: the report is for ${convergence.kit}, not ${manifest.id}`)
    process.exit(1)
  }
}
const levels = ['L1']
const notes = []
if (manifest.ui && (manifest.creates ?? []).length) levels.push('L2')
else notes.push('L2 needs ui and creates')
if (levels.includes('L2') && manifest.agent) levels.push('L3')
else if (levels.includes('L2')) notes.push('L3 needs agent')
if (levels.includes('L3')) notes.push('L4 needs the kit published in @kition/dsh-kits (published-kits.json; not checked here)')
// The object model's typings are generated from the schema into @kition/script's kits/ (L5).
const typings = manifest.objectModel ? path.join(root, 'packages', 'script', 'kits', `${manifest.objectModel.namespace.toLowerCase()}.ts`) : null
if (contract === 2 && modelSchema && typings && !fs.existsSync(typings)) {
  notes.push(`L5 needs object model typings generated into packages/script/kits/${path.basename(typings)}`)
} else if (contract === 2 && modelSchema && manifest.objectModel) {
  levels.push('L5')
  if (convergence?.level6 === true) levels.push('L6')
  else if (convergence) notes.push(`L6: the convergence report did not pass (${(convergence.checks ?? []).filter((check) => check.outcome !== 'passed').map((check) => check.id).join(', ')})`)
  else notes.push('L6 needs a passing convergence report (--convergence)')
} else notes.push('L5 needs engine contract 2, a KDM schema, and an object model namespace (platform K10 to K14)')
console.log(`PLATFORM LEVELS ${levels.join(' ')}${notes.length ? ` (${notes.join('; ')})` : ''}`)
