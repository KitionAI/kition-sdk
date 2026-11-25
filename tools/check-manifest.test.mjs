import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/grid-kit/kit.json'), 'utf8'))

function check(ui) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-manifest-'))
  const file = path.join(dir, 'kit.json')
  fs.writeFileSync(file, JSON.stringify({ ...example, ui: { ...example.ui, mode: 'embedded', entry: 'ui/index.html', ...ui } }))
  const result = spawnSync(process.execPath, [path.join(root, 'tools/check-manifest.mjs'), file], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: result.status, out: result.stdout }
}

describe('check-manifest ui.brand', () => {
  it('accepts a brand with enough contrast', () => {
    expect(check({ brand: { light: '#2b5fd9', dark: '#6b9bff' } }).code).toBe(0)
  })

  it('refuses a malformed color', () => {
    const result = check({ brand: { light: 'blue', dark: '#6b9bff' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('ui.brand.light')
  })

  it('refuses a light brand that white text cannot read on', () => {
    const result = check({ brand: { light: '#e08a00', dark: '#ffb340' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('white text')
  })

  it('refuses a dark brand too dim on dark surfaces', () => {
    const result = check({ brand: { light: '#2b5fd9', dark: '#2b2bff' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('ui.brand.dark')
  })
})

describe('check-manifest ui.display', () => {
  it('accepts a default display mode', () => {
    for (const display of ['menus', 'line', 'classic']) expect(check({ display }).code).toBe(0)
  })

  it('refuses Focus or an unknown mode as the default (platform U5c)', () => {
    for (const display of ['focus', 'ribbon']) {
      const result = check({ display })
      expect(result.code).toBe(1)
      expect(result.out).toContain('ui.display')
    }
  })
})

function checkManifest(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-manifest-'))
  const file = path.join(dir, 'kit.json')
  fs.writeFileSync(file, JSON.stringify(manifest))
  const result = spawnSync(process.execPath, [path.join(root, 'tools/check-manifest.mjs'), file], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: result.status, out: result.stdout }
}

describe('check-manifest headless.features', () => {
  const headless = (features) => checkManifest({ ...example, headless: { executable: 'kit-grid', protocol: 'kition-kit/1', features } })

  it('accepts the object model features', () => {
    expect(headless(['model.describe', 'model.batch', 'view.describe']).code).toBe(0)
  })

  it('refuses a malformed or repeated feature', () => {
    const malformed = headless(['Model Describe'])
    expect(malformed.code).toBe(1)
    expect(malformed.out).toContain('headless.features[0]')
    expect(headless(['model.batch', 'model.batch']).code).toBe(1)
  })
})

describe('check-manifest headless.capabilities (platform K22)', () => {
  const headless = (fields) => checkManifest({ ...example, headless: { executable: 'kit-grid', protocol: 'kition-kit/1', ...fields } })

  it('accepts document-text', () => {
    expect(headless({ capabilities: ['document-text'] }).code).toBe(0)
  })

  it('refuses an unknown or repeated capability', () => {
    const unknown = headless({ capabilities: ['document.text'] })
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('headless.capabilities[0]')
    expect(headless({ capabilities: ['document-text', 'document-text'] }).code).toBe(1)
  })

  it('refuses document.text listed as a feature, naming the capability', () => {
    const result = headless({ features: ['document.text'] })
    expect(result.code).toBe(1)
    expect(result.out).toContain('document-text in headless.capabilities')
  })
})

/** Writes `manifest` and the given side files to a new folder and checks it; `args` follow the path. */
function checkFolder(manifest, files = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-manifest-'))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  fs.writeFileSync(path.join(dir, 'kit.json'), JSON.stringify(manifest))
  const result = spawnSync(process.execPath, [path.join(root, 'tools/check-manifest.mjs'), path.join(dir, 'kit.json'), ...args.map((arg) => arg.replace('$DIR', dir))], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: result.status, out: result.stdout }
}

describe('check-manifest engine contract 2 (platform K10 to K14)', () => {
  const schema = { kdm: 1, kit: example.id, schemaVersion: 3, root: 'Grid', types: { Grid: { fields: { cells: { kind: 'map' } } } } }
  const v2 = {
    ...example,
    distribution: 'plugin',
    engine: { ...example.engine, runtime: 'rust-wasm', contract: 2 },
    capabilities: [...(example.capabilities ?? []), 'kdm'],
    model: { schema: 'model/schema.json', schemaVersion: 3 },
    collaboration: { merge: ['grid'], leases: ['cell:{objectId}', '*'], serverValidation: false },
    // A namespace with generated typings in packages/script/kits/ (L5).
    objectModel: { namespace: 'Note' },
  }

  it('accepts a contract 2 manifest under KHP 1.0 and reports platform level L5', () => {
    const result = checkFolder(v2, { 'model/schema.json': schema })
    expect(result.out).toContain('PASS example.grid 0.1.0: KHP 1.0 manifest, tier basic claimed')
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/PLATFORM LEVELS L1 .*L5\b/)
    expect(result.out.match(/LEVELS ([L0-9 ]+)/)?.[1].trim().split(' ')).toEqual(['L1', 'L2', 'L3', 'L5'])
  })

  it('refuses a host-drawn editor (K8)', () => {
    const result = checkFolder({ ...v2, ui: { ...example.ui, mode: 'host' } }, { 'model/schema.json': schema })
    expect(result.code).toBe(1)
    expect(result.out).toContain('ui.mode')
  })

  it('accepts an embedded UI, whatever the KHP version', () => {
    const result = checkFolder({ ...v2, ui: { ...example.ui, mode: 'embedded', entry: 'ui/index.html' } }, { 'model/schema.json': schema })
    expect(result.code).toBe(0)
  })

  it('refuses the old field name standard, with no alias (K2)', () => {
    const { khp, ...rest } = v2
    const result = checkFolder({ ...rest, standard: khp }, { 'model/schema.json': schema })
    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL (root): missing "khp"')
    expect(result.out).toContain('FAIL standard: is not a manifest field')
  })

  it('refuses a khp that is not a KHP 1.x version (K2)', () => {
    for (const khp of ['2.0', '1', 'KHP 1.0']) {
      const result = checkFolder({ ...v2, khp }, { 'model/schema.json': schema })
      expect(result.code).toBe(1)
      expect(result.out).toContain('FAIL khp:')
    }
  })

  it('ties the kdm capability to engine contract 2, not to khp (platform K10)', () => {
    const noKdm = checkFolder({ ...v2, capabilities: [] }, { 'model/schema.json': schema })
    expect(noKdm.out).toContain('FAIL capabilities: an engine contract 2 kit lists the kdm capability (platform K10)')
    const contract1 = checkFolder({ ...v2, engine: { ...v2.engine, contract: 1 } }, { 'model/schema.json': schema })
    expect(contract1.out).toContain('FAIL engine.contract: the kdm capability needs engine contract 2 (platform K10)')
  })

  it('accepts a KDM schema on an engine contract 1 kit, without L5', () => {
    const { collaboration, objectModel, ...rest } = v2
    void collaboration, objectModel
    const result = checkFolder({ ...rest, engine: { ...v2.engine, contract: 1 }, capabilities: [] }, { 'model/schema.json': schema })
    expect(result.code).toBe(0)
    expect(result.out).toContain('L5 needs engine contract 2, a KDM schema, and an object model namespace (platform K10 to K14)')
  })

  it('refuses a contract 2 manifest without its model, collaboration, or namespace', () => {
    const { model, collaboration, objectModel, distribution, ...bare } = v2
    void model, collaboration, objectModel, distribution
    const result = checkFolder(bare)
    expect(result.code).toBe(1)
    for (const field of ['model', 'collaboration', 'objectModel', 'distribution']) expect(result.out).toContain(`FAIL ${field}:`)
    expect(result.out).toContain('an engine contract 2 kit names its KDM schema (platform K12)')
  })

  it('checks the schema file against the manifest', () => {
    expect(checkFolder(v2).out).toContain('does not exist')
    expect(checkFolder(v2, { 'model/schema.json': { ...schema, schemaVersion: 2 } }).out).toContain('the schema file says 2')
    expect(checkFolder(v2, { 'model/schema.json': { ...schema, kit: 'kit.other' } }).out).toContain('belongs to "kit.other"')
  })

  it('needs generated typings for L5', () => {
    const result = checkFolder({ ...v2, objectModel: { namespace: 'Grid' } }, { 'model/schema.json': schema })
    expect(result.code).toBe(0)
    expect(result.out).toContain('L5 needs object model typings generated into packages/script/kits/grid.ts')
  })

  it('accepts comment commands over a schema with the comment types, and refuses the history, file commands, or no comment types', () => {
    const commented = { ...schema, types: { ...schema.types, CommentThread: { fields: {} }, Comment: { fields: {} } } }
    const comments = (commands) => ({ ...v2, collaboration: { ...v2.collaboration, comments: { commands } } })
    expect(checkFolder(comments(['comment.add', 'comment.reply']), { 'model/schema.json': commented }).code).toBe(0)
    const history = checkFolder(comments(['comment.add', 'edit.undo', 'file.save']), { 'model/schema.json': commented })
    expect(history.code).toBe(1)
    expect(history.out).toContain('"edit.undo" is not a comment command')
    expect(history.out).toContain('"file.save" is not a comment command')
    expect(checkFolder(comments(['comment.add']), { 'model/schema.json': schema }).out).toContain('no CommentThread and Comment types')
    expect(checkFolder(comments(['comment']), { 'model/schema.json': commented }).out).toContain('collaboration.comments.commands[0]')
    const { model, ...unmodelled } = comments(['comment.add'])
    void model
    expect(checkFolder({ ...unmodelled, engine: { ...v2.engine, contract: 1 }, capabilities: [] }).out).toContain('comment commands need a KDM schema (model) (platform M23)')
  })

  it('loads a ts-worker engine with --module: prepared from its folder, then checked like a wasm one', () => {
    const tsWorker = { ...v2, distribution: 'default', capabilities: ['kdm'], engine: { ...v2.engine, runtime: 'ts-worker' } }
    const members = ['version', 'exportChanges', 'importChanges', 'snapshot', 'executeAs'].map((name) => `${name}() {}`).join(' ')
    const engine = (extra) => `
      import fs from 'node:fs'
      let ready = false
      export default async function prepare({ base, read }) { ready = (await read('data.bin')).length === 3 && base.startsWith('file:') }
      export class ${v2.engine.class} { static contractVersion() { if (!ready) throw new Error('not prepared'); return 1 } static openWithReplica() {} ${members} ${extra} }
    `
    const files = (extra = '') => ({ 'model/schema.json': schema, [`engine/${v2.engine.module}.js`]: engine(extra), 'engine/data.bin': 'abc' })
    const extras = Object.keys(v2.extras ?? {}).map((name) => `${name}() {}`).join(' ')
    const passed = checkFolder(tsWorker, files(extras), ['--module', '$DIR/engine'])
    expect(passed.out).toContain('matches its module')
    expect(passed.code).toBe(0)
    const missing = checkFolder({ ...tsWorker, engine: { ...tsWorker.engine, class: 'OtherDocument' } }, files(extras), ['--module', '$DIR/engine'])
    expect(missing.out).toContain('exports no OtherDocument')
  })

  it('refuses an unknown merge class and a malformed lease scope', () => {
    const result = checkFolder({ ...v2, collaboration: { merge: ['magic'], leases: ['layer {id}'] } }, { 'model/schema.json': schema })
    expect(result.out).toContain('collaboration.merge[0]')
    expect(result.out).toContain('is not a scope pattern')
  })
})

describe('check-manifest KHP 1.0 fields', () => {
  const agentReady = {
    ...example,
    level: 'agent-ready',
    agent: { ...example.agent, drafts: true, objectModel: true, layout: false },
    headless: { executable: 'kit-grid', protocol: 'kition-kit/1', features: ['document.check', 'model.describe', 'model.batch'] },
  }

  it('names KHP rules and platform rules apart', () => {
    const result = checkManifest({ ...example, creates: [{ ...example.creates[0], extension: 'png' }], ui: { ...example.ui, brand: { light: '#e08a00', dark: '#ffb340' } } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('is not a format the kit edits (KHP K4)')
    expect(result.out).toContain('(platform U5b)')
  })

  it('accepts the format roles edit and view, and refuses read', () => {
    const formats = (role) => [...example.formats, { id: 'grid-import', extensions: ['csv'], role }]
    expect(checkManifest({ ...example, formats: formats('view') }).code).toBe(0)
    const read = checkManifest({ ...example, formats: formats('read') })
    expect(read.code).toBe(1)
    expect(read.out).toContain('formats[1].role')
  })

  it('accepts the three tiers and refuses another (K19)', () => {
    for (const level of ['basic', 'agent-ready', 'agent-ready-complete']) {
      const result = checkFolder({ ...agentReady, level }, { 'agent/checks.json': [], 'agent/guide.md': '# Grid' })
      expect(result.out).toContain(`tier ${level} claimed`)
      expect(result.code).toBe(0)
    }
    const unknown = checkManifest({ ...example, level: 'gold' })
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain('FAIL level:')
  })

  it('reads a missing level as basic', () => {
    expect(checkManifest(example).out).toContain('tier basic claimed')
  })

  it('needs agent, objectModel, and layout from an agent-ready kit (K16)', () => {
    const { agent, ...noAgent } = agentReady
    void agent
    expect(checkFolder(noAgent).out).toContain('FAIL agent: a kit that claims agent-ready names its tool prefix in agent.prefix (KHP K16)')
    const unsaid = checkFolder({ ...agentReady, agent: { prefix: 'grid', tools: 'document' } })
    expect(unsaid.code).toBe(1)
    expect(unsaid.out).toContain('FAIL agent.objectModel:')
    expect(unsaid.out).toContain('FAIL agent.layout:')
  })

  it('checks agent.objectModel against the headless object model features', () => {
    const claimed = checkManifest({ ...example, agent: { ...example.agent, objectModel: true }, headless: { ...agentReady.headless, features: ['document.check'] } })
    expect(claimed.out).toContain('FAIL agent.objectModel: is true, but headless.features lacks model.describe and model.batch (KHP K16), (platform K9)')
    const hidden = checkFolder({ ...agentReady, agent: { ...agentReady.agent, objectModel: false } }, { 'agent/checks.json': [] })
    expect(hidden.out).toContain('so the object model tools are offered: say true (KHP K16)')
  })

  it('warns about what the package and the proposed platform rules still need', () => {
    const result = checkFolder({ ...agentReady, agent: { ...agentReady.agent, layout: true }, headless: { ...agentReady.headless, features: ['model.describe', 'model.batch'] } })
    expect(result.code).toBe(0)
    expect(result.out).toContain('WARN agent/checks.json: not beside kit.json')
    expect(result.out).toContain('(KHP K17)')
    expect(result.out).toContain('WARN headless.features: an agent-ready Kition kit serves document.check (platform K16, proposed)')
    expect(result.out).toContain('serves view.layout (platform K16, proposed)')
    const complete = checkFolder({ ...agentReady, level: 'agent-ready-complete' }, { 'agent/checks.json': [] })
    expect(complete.out).toContain('WARN agent/guide.md')
    expect(checkFolder(agentReady, { 'agent/checks.json': [] }).out).not.toContain('WARN')
  })

  it('accepts the files, preview, and opening capabilities, and ties files to its lists (platform K15)', () => {
    const exported = example.exports?.map((item) => item.extension) ?? []
    const files = { read: ['png'], create: [...exported, 'txt'], folders: false, print: true }
    expect(checkManifest({ ...example, capabilities: [...(example.capabilities ?? []), 'files', 'preview-files', 'open-file', 'open-url'], files }).code).toBe(0)
    const unlisted = checkManifest({ ...example, files })
    expect(unlisted.code).toBe(1)
    expect(unlisted.out).toContain('FAIL capabilities: a kit that declares files lists the files capability (platform K15)')
    const undeclared = checkManifest({ ...example, capabilities: [...(example.capabilities ?? []), 'files'] })
    expect(undeclared.out).toContain('FAIL files: a kit that lists the files capability declares what it may ask for (platform K15)')
    const malformed = checkManifest({ ...example, capabilities: [...(example.capabilities ?? []), 'files'], files: { read: ['.png'], write: ['pdf'] } })
    expect(malformed.out).toContain('FAIL files.read[0]')
    expect(malformed.out).toContain('FAIL files.write: is not a manifest field')
  })

  it('needs files.create to cover every export (platform K15)', () => {
    const result = checkManifest({ ...example, exports: [{ extension: 'pdf' }], capabilities: [...(example.capabilities ?? []), 'files'], files: { create: ['png'] } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL files.create: does not cover the export .pdf (platform K15)')
  })

  it('refuses an unknown agent field', () => {
    const result = checkManifest({ ...example, agent: { ...example.agent, preview: true } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL agent.preview: is not a manifest field')
  })
})

describe('check-manifest agent.links (KHP K21)', () => {
  const linking = (links) => ({ ...example, agent: { ...example.agent, links } })

  it('accepts agent.links omitted or false, without the links-outside fixture', () => {
    expect(checkFolder(example).code).toBe(0)
    const unlinked = checkFolder(linking(false))
    expect(unlinked.out).not.toContain('FAIL')
    expect(unlinked.code).toBe(0)
  })

  it('refuses an agent.links that is not a boolean', () => {
    for (const links of ['true', 1, null, {}]) {
      const result = checkManifest(linking(links))
      expect(result.code).toBe(1)
      expect(result.out).toContain('FAIL agent.links: must be a boolean')
    }
  })

  it('needs conformance/links-outside.<ext> beside kit.json when agent.links is true, at every tier', () => {
    const missing = checkFolder(linking(true))
    expect(missing.code).toBe(1)
    expect(missing.out).toContain(
      'FAIL conformance/links-outside.grid: not beside kit.json; a kit that declares agent.links: true ships it, and khp check fails phase 11 without it (KHP K21)',
    )
    const shipped = checkFolder(linking(true), { 'conformance/links-outside.grid': '[[../outside-canary.bin]]' })
    expect(shipped.out).not.toContain('FAIL')
    expect(shipped.code).toBe(0)
  })

  it('names the fixture after the first extension of the format the kit edits, as khp check does', () => {
    const formats = [{ id: 'grid-import', extensions: ['csv'], role: 'view' }, ...example.formats]
    const viewOnly = checkFolder({ ...linking(true), formats }, { 'conformance/links-outside.csv': 'a,b' })
    expect(viewOnly.code).toBe(1)
    expect(viewOnly.out).toContain('FAIL conformance/links-outside.grid:')
    expect(checkFolder({ ...linking(true), formats }, { 'conformance/links-outside.grid': 'a' }).code).toBe(0)
  })
})

// Regression: regressions/issue-export-command-sources. The kit's self-test used to run each
// exports[].command while <prefix>_export runs agent.export.command; Photo and Motion named
// different commands in the two places, and Photo's was not one the agent may run.
describe('check-manifest export commands (platform K21)', () => {
  const exporting = (exports, agent = {}) => ({ ...example, exports, agent: { ...example.agent, ...agent } })
  const png = (command) => ({ extension: 'png', mime: 'image/png', command })

  // regressions/issue-export-command-optional: an export entry is { extension, mime? } (KHP K5);
  // agent.export.command is the one export command (K21), and nothing reads exports[].command.
  it('accepts exports without a command, the form K5 gives them', () => {
    const result = checkManifest(exporting([{ extension: 'png', mime: 'image/png' }, { extension: 'jpg' }], { export: { command: 'file.exportBytes', data: 'data' } }))
    expect(result.out).not.toContain('FAIL')
    expect(result.out).not.toContain('WARN')
    expect(result.code).toBe(0)
  })

  it('accepts one export command named in both places', () => {
    const result = checkManifest(exporting([png('file.exportBytes')], { export: { command: 'file.exportBytes', data: 'data' } }))
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('WARN')
  })

  it('warns when exports[].command and agent.export.command disagree for a format', () => {
    const result = checkManifest(exporting([png('file.export.quickExport'), { extension: 'jpg', command: 'file.exportImage' }], { export: { command: 'file.exportImage', data: 'data' } }))
    expect(result.code).toBe(0)
    expect(result.out).toContain(
      'WARN exports.png.command: "file.export.quickExport", but agent.export.command is "file.exportImage": grid_export and the kit\'s self-test run file.exportImage for .png, and nothing reads exports[].command: omit it (platform K21)',
    )
    expect(result.out).not.toContain('WARN exports.jpg')
    expect(result.out).toContain('WARN exports: name 2 commands (file.export.quickExport, file.exportImage), but agent.export runs one command for every format')
  })

  it('warns when the formats name several export commands, which agent.export cannot follow', () => {
    const result = checkManifest(exporting([{ extension: 'html', command: 'file.exportHtml' }, { extension: 'pdf', command: 'file.exportPdf' }]))
    expect(result.code).toBe(0)
    expect(result.out).toContain('WARN exports: name 2 commands (file.exportHtml, file.exportPdf), but agent.export runs one command for every format: give them one command that switches on format (platform K21)')
  })

  it('warns when an export command is not one the agent may run', () => {
    const excluded = checkManifest(exporting([png('file.exportBytes')], { export: { command: 'file.exportBytes', data: 'data' }, exclude: ['file.export*'] }))
    expect(excluded.out).toContain('WARN agent.export.command: "file.exportBytes" is not an agent-facing command: agent.exclude names it (platform K21)')
    const unselected = checkManifest(exporting([png('file.exportBytes')], { export: { command: 'file.exportBytes', data: 'data' }, include: ['edit.*'] }))
    expect(unselected.out).toContain('WARN agent.export.command: "file.exportBytes" is not an agent-facing command: agent.include does not select it (platform K21)')
    const selected = checkManifest(exporting([png('file.exportBytes')], { export: { command: 'file.exportBytes', data: 'data' }, include: ['edit.*', 'file.export*'] }))
    expect(selected.out).not.toContain('WARN')
    const unlisted = checkFolder(exporting([png('file.render')]), { 'agent/commands.json': { khp: '1.0', kit: example.id, commands: [{ command: 'file.export' }] } })
    expect(unlisted.out).toContain('WARN exports.png.command: "file.render" is not an agent-facing command: agent/commands.json does not list it (platform K21)')
    expect(unlisted.code).toBe(0)
  })
})

// The editor state a kit's inspect() reports, published to hosts (platform K23).
describe('check-manifest engine.editorState (platform K23)', () => {
  const declaring = (editorState) => ({ ...example, engine: { ...example.engine, editorState } })

  it('accepts JSON Pointers, names, and an empty list', () => {
    for (const editorState of [[], ['/selection', '/view/zoom', '/a~1b', 'selected'], ['keyedNow']]) {
      const result = checkManifest(declaring(editorState))
      expect(result.out).not.toContain('engine.editorState')
      expect(result.code).toBe(0)
    }
  })

  it('refuses a list that is not of pointers and names', () => {
    for (const [editorState, where] of [
      ['/view', 'engine.editorState: must be an array'],
      [['/view', '/view'], 'engine.editorState: has duplicates'],
      [[''], 'engine.editorState[0]'],
      [['/bad~2escape'], 'engine.editorState[0]'],
      [['view/zoom'], 'engine.editorState[0]'],
      [[3], 'engine.editorState[0]: must be a string'],
    ]) {
      const result = checkManifest(declaring(editorState))
      expect(result.code, JSON.stringify(editorState)).toBe(1)
      expect(result.out).toContain(`FAIL ${where}`)
    }
  })

  it('warns when an engine declares none, since a host then reads all of inspect() as the document', () => {
    const { editorState: _declared, ...engine } = example.engine
    const result = checkManifest({ ...example, engine })
    expect(result.code).toBe(0)
    expect(result.out).toContain('WARN engine.editorState: not declared, so a host reads every key of inspect() as the document')
    expect(result.out).toContain('(platform K23)')
  })
})
