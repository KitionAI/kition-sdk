import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMatrix, evalCasesCell, renderMarkdown } from './kit-matrix.mjs'

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'kit-matrix.mjs')
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A folder of fake kit repositories (no git), a requirements table, and a plan's waivers folder. */
function workspace(repos, { waivers = {}, requirements } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-matrix-'))
  dirs.push(root)
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  for (const [repo, files] of Object.entries(repos)) for (const [file, text] of Object.entries(files)) write(`${repo}/${file}`, typeof text === 'string' ? text : JSON.stringify(text))
  for (const [kit, text] of Object.entries(waivers)) write(`plan/waivers/${kit}.yaml`, text)
  write(
    'plan/kit-requirements.yaml',
    requirements ??
      `version: 0.4
kits: [note, table, slide]
requirements:
  - id: N2
    title: kit id is kit.<name>
    appliesTo: all
    tier: Preview
    check_id: manifest.kit-id
    automation: static
  - id: K2
    title: khp is 2.0
    appliesTo: all
    tier: Beta
    check_id: manifest.khp-version
    automation: static
  - id: N6
    title: native extension
    appliesTo: native-format
    tier: Preview
    check_id: manifest.native-extension
    automation: static
  - id: AX2
    title: headless bundled
    appliesTo: all
    tier: Preview
    check_id: release.headless-bundled
    automation: static
  - id: T1
    title: a dynamic row
    appliesTo: all
    tier: Beta
    check_id: tests.pass
    automation: dynamic
`,
  )
  return root
}

const note = { 'kit.json': { id: 'kit.note', khp: '1.0', name: 'Note', formats: [{ id: 'md', extensions: ['md'], mime: 'text/markdown' }] } }
const slide = { 'kit.json': { id: 'kit.slide', khp: '1.0' } }
const waiver = (requirement, { expires = '2026-12-01', approved = true, kind = 'interim', checkId } = {}) => `  - requirement: "${requirement}"
    kind: ${kind}
    reason: deferred on purpose for the test
    expires: ${expires}
    approved_by: ${approved ? 'owner' : 'null'}
    approved_on: ${approved ? '2026-10-20' : 'null'}
    tracking: issue-21${checkId ? `\n    check_id: ${checkId}` : ''}
`
const waiverFile = (kit, ...entries) => `kit: ${kit}\nformat: 1\nwaivers:\n${entries.join('')}`

const matrixOf = (root, date = '2026-10-27') =>
  buildMatrix({ requirementsFile: path.join(root, 'plan/kit-requirements.yaml'), reposDir: root, waiversDir: path.join(root, 'plan/waivers'), date })
const cell = (matrix, id, kit) => matrix.rows.find((row) => row.id === id).cells[kit]

describe('kit-matrix', () => {
  it('passes and fails static rows with the value it found, and leaves dynamic rows out', () => {
    const root = workspace({
      'kition-note': note,
      'kition-table': { 'kit.json': { id: 'kit.tables', standard: '1.1', formats: [{ id: 't', extensions: ['kitable'], mime: 'application/vnd.kition.table+zip' }] } },
      'kition-slide': slide,
    })
    const matrix = matrixOf(root)
    expect(matrix.rows.map((row) => row.id)).toEqual(['N2', 'K2', 'N6', 'AX2'])
    expect(matrix.totalRows).toBe(5)
    expect(cell(matrix, 'N2', 'note')).toEqual({ state: 'pass' })
    expect(cell(matrix, 'N2', 'table')).toEqual({ state: 'fail', value: 'kit.tables' })
    expect(cell(matrix, 'K2', 'table')).toEqual({ state: 'fail', value: 'standard 1.1' })
    expect(cell(matrix, 'N6', 'table')).toEqual({ state: 'fail', value: 'kitable' })
  })

  it('matches a native MIME suffix with the sample file\'s container: zip, JSON or SQLite (N7)', () => {
    const n7 = `version: 0.4
kits: [table, board, film]
requirements:
  - id: N7
    title: native MIME suffix matches the container
    appliesTo: native-format
    tier: Preview
    check_id: manifest.native-mime
    automation: static
`
    const sqlite = 'SQLite format 3\u0000' + 'x'.repeat(84)
    const kit = (name, suffix, sample) => ({
      'kit.json': { id: `kit.${name}`, khp: '1.0', formats: [{ id: name, extensions: [`k${name}`], mime: `application/vnd.kition.${name}+${suffix}` }] },
      [`conformance/basic.k${name}`]: sample,
    })
    const matrix = matrixOf(workspace({ 'kition-table': kit('table', 'sqlite3', sqlite), 'kition-board': kit('board', 'zip', sqlite), 'kition-film': kit('film', 'sqlite3', '{"a":1}') }, { requirements: n7 }))
    expect(cell(matrix, 'N7', 'table')).toEqual({ state: 'pass' })
    expect(cell(matrix, 'N7', 'board')).toEqual({ state: 'fail', value: 'application/vnd.kition.board+zip, but conformance/basic.kboard is sqlite3' })
    expect(cell(matrix, 'N7', 'film')).toEqual({ state: 'fail', value: 'application/vnd.kition.film+sqlite3, but conformance/basic.kfilm is json' })
  })
  it('marks rows not applicable, and unchecked where a static read cannot settle them', () => {
    const root = workspace({ 'kition-note': note, 'kition-slide': slide })
    const matrix = matrixOf(root)
    // note has no native format, and is not one of the kits that always have one.
    expect(cell(matrix, 'N6', 'note')).toEqual({ state: 'n/a' })
    expect(cell(matrix, 'AX2', 'note').state).toBe('unchecked')
    expect(cell(matrix, 'N2', 'table')).toEqual({ state: 'unchecked', value: 'no checkout at kition-table' })
  })

  it('waives a failing cell under an approved waiver in date, and fails it once the waiver expired', () => {
    const root = workspace(
      { 'kition-note': note, 'kition-table': { 'kit.json': { id: 'kit.tables', khp: '0.9' } }, 'kition-slide': slide },
      { waivers: { table: waiverFile('table', waiver('N2', { checkId: 'manifest.kit-id' }), waiver('K2', { expires: '2026-10-01' }), waiver('N6', { approved: false })) } },
    )
    const matrix = matrixOf(root)
    expect(cell(matrix, 'N2', 'table')).toMatchObject({ state: 'waived', value: 'kit.tables', waiver: { kind: 'interim', expires: '2026-12-01', tracking: 'issue-21' } })
    expect(cell(matrix, 'K2', 'table')).toMatchObject({ state: 'fail', value: '0.9; waiver expired 2026-10-01', waiver: { expired: true } })
    expect(matrix.warnings).toContain('table N6: not approved, not applied')
    // The same waiver a day after it expires.
    expect(cell(matrixOf(root, '2026-12-02'), 'N2', 'table').state).toBe('fail')
  })

  it('warns of a waiver whose row passes now, or whose row changed its check', () => {
    const root = workspace(
      { 'kition-note': { ...note, 'cases/waivers.yaml': waiverFile('note', waiver('N2'), waiver('K2', { checkId: 'manifest.standard' })) }, 'kition-slide': slide },
    )
    const matrix = matrixOf(root)
    expect(cell(matrix, 'N2', 'note').state).toBe('pass')
    expect(matrix.warnings).toContain('note N2: the waiver is no longer needed')
    expect(matrix.warnings).toContain('note K2: check_id manifest.standard is now manifest.khp-version, not applied')
  })

  it('checks khp against the kit-layer version the specification states (K2)', () => {
    const root = workspace({
      'kition-note': note,
      'kition-slide': slide,
      'khp': { 'spec/index.md': '# KHP\n\n| | |\n| --- | --- |\n| Version | KHP 1.3, edition 2027.01, draft |\n| Kit layer | 1.2: the version a kit names in its manifest\'s `khp` (K2) |\n' },
    })
    const matrix = matrixOf(root)
    expect(matrix.khpVersion).toBe('1.2')
    expect(cell(matrix, 'K2', 'note')).toEqual({ state: 'fail', value: '1.0' })
    expect(matrixOf(workspace({ 'kition-note': note, 'kition-slide': slide })).khpVersion).toBe('1.0')
    // KHP 1.1 adds no requirement on kits: its kit layer is 1.0, so a kit that names 1.0 passes.
    const current = matrixOf(workspace({
      'kition-note': note,
      'kition-slide': slide,
      'khp': { 'spec/index.md': '# KHP\n\n| | |\n| --- | --- |\n| Version | KHP 1.1, edition 2026.11, draft |\n| Kit layer | 1.0: the version a kit names in its manifest\'s `khp` (K2) |\n' },
    }))
    expect(current.khpVersion).toBe('1.0')
    expect(cell(current, 'K2', 'note')).toEqual({ state: 'pass' })
  })

  it('reads kition-slide like every kit, with its own waivers', () => {
    const root = workspace({ 'kition-note': note, 'kition-slide': { ...slide, 'cases/waivers.yaml': waiverFile('slide', waiver('N2')) } })
    const matrix = matrixOf(root)
    expect(matrix.reads).toContain('kition-slide/kit.json')
    expect(matrix.reads).toContain('kition-slide/cases/waivers.yaml')
    for (const row of matrix.rows) expect(row.cells.slide.value ?? '').not.toContain('the owner is changing slide')
  })

  it('does not read a kit-waivers.yaml left at the old location, and says where it goes', () => {
    const wrongId = { 'kit.json': { id: 'kit.slides', khp: '1.0' } }
    const old = matrixOf(workspace({ 'kition-note': note, 'kition-slide': { ...wrongId, 'kit-waivers.yaml': waiverFile('slide', waiver('N2')) } }))
    expect(old.warnings).toContain('kition-slide/kit-waivers.yaml: not read; move it to cases/waivers.yaml')
    expect(old.reads).not.toContain('kition-slide/kit-waivers.yaml')
    expect(cell(old, 'N2', 'slide')).toEqual({ state: 'fail', value: 'kit.slides' })
    const moved = matrixOf(workspace({ 'kition-note': note, 'kition-slide': { ...wrongId, 'cases/waivers.yaml': waiverFile('slide', waiver('N2')) } }))
    expect(cell(moved, 'N2', 'slide').state).toBe('waived')
  })

  it('reads the attribution and the gap documents where the layout standard puts them, and nowhere else (K4, Q4)', () => {
    const rows = `version: 0.4
kits: [note, table]
requirements:
  - id: K4
    title: Apache-2.0 and the attribution
    appliesTo: all
    tier: Preview
    check_id: legal.license-attribution
    automation: static
  - id: Q4
    title: gaps, target-app parity, roadmap
    appliesTo: all
    tier: Beta
    check_id: files.gap-docs
    automation: static
`
    const legal = { LICENSE: 'Apache License\nVersion 2.0, January 2004\n', NOTICE: 'Kition Note\n' }
    const root = workspace(
      {
        'kition-note': { ...note, ...legal, 'docs/attribution.md': '# Attribution\n', 'docs/gaps.md': '# Gaps\n', 'docs/parity/target-app-parity.md': '# Parity\n', 'docs/roadmap.md': '# Roadmap\n' },
        // The old locations: a root ATTRIBUTION.md or ATTRIBUTION.toml, docs/target-app-parity.md, a root GAPS.md or ROADMAP.md.
        'kition-table': {
          'kit.json': { id: 'kit.table', khp: '1.0' },
          ...legal,
          'ATTRIBUTION.md': '# Attribution\n',
          'ATTRIBUTION.toml': '[[upstream]]\n',
          'GAPS.md': '# Gaps\n',
          'docs/target-app-parity.md': '# Parity\n',
          'ROADMAP.md': '# Roadmap\n',
        },
      },
      { requirements: rows },
    )
    const matrix = matrixOf(root)
    expect(cell(matrix, 'K4', 'note')).toEqual({ state: 'pass' })
    expect(cell(matrix, 'Q4', 'note')).toEqual({ state: 'pass' })
    expect(cell(matrix, 'K4', 'table')).toEqual({ state: 'fail', value: 'missing docs/attribution.md' })
    expect(cell(matrix, 'Q4', 'table')).toEqual({ state: 'fail', value: 'missing docs/gaps.md, docs/parity/target-app-parity.md, docs/roadmap.md' })
    expect(matrix.expectedFiles).toMatchObject({ attribution: 'docs/attribution.md', gaps: 'docs/gaps.md', parity: 'docs/parity/target-app-parity.md', roadmap: 'docs/roadmap.md' })
  })

  it('writes the matrix as Markdown and JSON from the command line', () => {
    const root = workspace({ 'kition-note': note, 'kition-slide': slide })
    const out = path.join(root, 'out')
    const run = spawnSync(process.execPath, [tool, '--requirements', path.join(root, 'plan/kit-requirements.yaml'), '--repos', root, '--waivers', path.join(root, 'plan/waivers'), '--date', '2026-10-27', '--out', out], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const json = JSON.parse(fs.readFileSync(path.join(out, 'kit-matrix-2026-10-27.json'), 'utf8'))
    expect(json.rows).toHaveLength(4)
    const markdown = fs.readFileSync(path.join(out, 'kit-matrix-2026-10-27.md'), 'utf8')
    expect(markdown).toContain('| N2 kit id is kit.<name> | Preview | ✅ |')
    expect(markdown).toBe(renderMarkdown(json))
    expect(spawnSync(process.execPath, [tool, '--repos'], { encoding: 'utf8' }).status).toBe(2)
  })

  it('settles the agent-readiness rows from what the headless kit answers, with --dynamic', () => {
    const requirements = `version: 0.4
kits: [note, table, slide]
requirements:
  - id: KH1
    title: level backed by a test
    appliesTo: all
    tier: Preview
    check_id: manifest.level
    automation: dynamic
  - id: AX5
    title: schema coverage
    appliesTo: all
    tier: Beta
    check_id: agent-ready.schema-coverage
    automation: dynamic
  - id: AX6
    title: real check
    appliesTo: all
    tier: Beta
    check_id: agent-ready.check-catalogue
    automation: dynamic
  - id: T1
    title: a dynamic row this tool does not know
    appliesTo: all
    tier: Beta
    check_id: tests.pass
    automation: dynamic
`
    const checks = [
      { code: 'note.a', fixture: 'check-a.md' },
      { code: 'note.b', fixture: 'check-b.md' },
    ]
    const root = workspace(
      {
        'kition-note': {
          'kit.json': { ...note['kit.json'], level: 'agent-ready' },
          'agent/checks.json': checks,
          'conformance/check-a.md': 'a',
          'conformance/check-b.md': 'b',
          'bindings/wasm/src/files.rs': 'fn every_file_parameter_is_declared() {}',
          'bindings/headless/tests/agent_ready.rs': 'kition_headless::agent_ready::check(MANIFEST, repo(), kit)',
        },
        'kition-table': {
          'kit.json': { id: 'kit.table', khp: '1.0', level: 'agent-ready' },
          'agent/checks.json': [{ code: 'table.x', fixture: 'check-x.ktable' }],
        },
        'kition-slide': slide,
      },
      { requirements },
    )
    const asked = []
    const answers = {
      note: {
        commands: [
          { id: 'text.append', params: { type: 'object', properties: { text: { type: 'string' }, at: {} } } },
          { id: 'file.import', params: { type: 'object', properties: { from: { type: 'string', 'x-khp-file': { access: 'read' } } } } },
        ],
        checks: { 'check-a.md': { codes: ['note.a'] }, 'check-b.md': { codes: [] } },
      },
      table: { commands: [{ id: 'tables.update', params: { type: 'object' } }, { id: 'tables.get', params: { type: 'object', properties: {} } }], checks: {} },
    }
    const matrix = buildMatrix({
      requirementsFile: path.join(root, 'plan/kit-requirements.yaml'),
      reposDir: root,
      date: '2026-10-29',
      dynamic: true,
      probe: (source) => {
        asked.push(source.kit)
        return answers[source.kit]
      },
    })
    expect(matrix.rows.map((row) => row.id)).toEqual(['KH1', 'AX5', 'AX6'])
    expect(matrix.dynamicRows).toBe(3)
    expect(asked).toEqual(['note', 'table', 'slide'])
    expect(cell(matrix, 'KH1', 'note')).toEqual({ state: 'pass', value: 'agent-ready' })
    expect(cell(matrix, 'KH1', 'table')).toEqual({ state: 'fail', value: 'agent-ready, but no test runs kition_headless::agent_ready::check' })
    expect(cell(matrix, 'AX5', 'note')).toEqual({ state: 'pass', value: '2 commands; 1/3 parameters untyped; 1 typed file parameters offered' })
    expect(cell(matrix, 'AX5', 'table').state).toBe('fail')
    expect(cell(matrix, 'AX5', 'table').value).toMatch(/^1\/2 commands without a parameter schema \(tables\.update\); no file-parameter lint/)
    expect(cell(matrix, 'AX6', 'note')).toEqual({ state: 'fail', value: '1/2 fixtures do not yield their code (check-b.md: [])' })
    expect(cell(matrix, 'AX6', 'table')).toEqual({ state: 'fail', value: '1/1 codes without a fixture in conformance/ (table.x)' })
    expect(cell(matrix, 'AX5', 'slide').state).toBe('unchecked')
    expect(renderMarkdown(matrix)).toContain('the 0 static rows and 3 dynamic rows')
  })

  it('reports how many offered commands say what they do and what they answer (AX14)', () => {
    const requirements = `version: 0.4
kits: [note, table]
requirements:
  - id: AX14
    title: commands say what they do
    appliesTo: all
    tier: Beta
    check_id: agent-ready.command-descriptions
    automation: dynamic
`
    const root = workspace(
      {
        'kition-note': { ...note, 'bindings/wasm/src/lib.rs': 'kition_kit::testing::check_commands(&doc.commands(), NO_OUTPUT)' },
        'kition-table': { 'kit.json': { id: 'kit.table', khp: '1.0', level: 'basic' } },
      },
      { requirements },
    )
    const typed = { type: 'object', properties: { text: { type: 'string' } } }
    const answers = {
      note: {
        commands: [
          { id: 'text.append', title: 'Append Text', description: 'Adds text at the end of the note.', mutates: true, params: typed },
          { id: 'text.read', title: 'Read Text', description: 'Answers the whole note as Markdown without changing it.', mutates: false, output: { type: 'string' }, params: typed },
        ],
      },
      table: {
        commands: [
          { id: 'tables.update', title: 'Update', description: 'Params: {id, fields}', mutates: true, params: { type: 'object', properties: { id: {}, fields: {} } } },
          { id: 'tables.get', title: 'Get Table', description: 'get table', mutates: false, params: typed },
        ],
      },
    }
    const matrix = buildMatrix({ requirementsFile: path.join(root, 'plan/kit-requirements.yaml'), reposDir: root, dynamic: true, probe: (source) => answers[source.kit] })
    expect(cell(matrix, 'AX14', 'note')).toEqual({ state: 'pass', value: '2/2 commands described; 1/1 read commands declare an output; 2/2 parameter keys typed (100%)' })
    const table = cell(matrix, 'AX14', 'table')
    expect(table.state).toBe('fail')
    expect(table.value).toMatch(/^2 commands without a real description \(tables\.update, tables\.get\); no description lint/)
    expect(table.value).toContain('1 read commands without an output schema')
    expect(table.value).toContain('only 33% of parameter keys typed')
  })

  it('reports a kit that cannot be asked as unchecked, and a kit without a level as failing', () => {
    const requirements = `version: 0.4
kits: [note]
requirements:
  - id: KH1
    title: level
    appliesTo: all
    tier: Preview
    check_id: manifest.level
    automation: dynamic
  - id: AX5
    title: schema coverage
    appliesTo: all
    tier: Beta
    check_id: agent-ready.schema-coverage
    automation: dynamic
`
    const root = workspace({ 'kition-note': note }, { requirements })
    const matrix = buildMatrix({ requirementsFile: path.join(root, 'plan/kit-requirements.yaml'), reposDir: root, dynamic: true, probe: () => ({ error: 'cargo build -p kition-note failed' }) })
    expect(cell(matrix, 'KH1', 'note')).toEqual({ state: 'fail', value: 'kit.json says no level' })
    expect(cell(matrix, 'AX5', 'note')).toEqual({ state: 'unchecked', value: 'the headless kit did not answer: cargo build -p kition-note failed' })
  })

  it('checks the kits --kits names instead of the table\'s', () => {
    const root = workspace({ 'kition-note': note, 'kition-design': { 'kit.json': { id: 'kit.design', khp: '1.0' } } })
    const matrix = buildMatrix({ requirementsFile: path.join(root, 'plan/kit-requirements.yaml'), reposDir: root, kits: ['note', 'design'] })
    expect(matrix.kits).toEqual(['note', 'design'])
    expect(cell(matrix, 'N2', 'design')).toEqual({ state: 'pass' })
  })

  it('reads the latest maintainer run of the eval cases for AX13, and never starts one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-matrix-eval-'))
    dirs.push(dir)
    const files = new Map([['cases/sheet.agent.act/total/case.yaml', 'format: 1\nlayer: eval\n']])
    const source = { dir, find: (re) => [...files.keys()].filter((f) => re.test(f)), text: (f) => files.get(f) ?? null }
    expect(evalCasesCell(source)).toMatchObject({ state: 'unchecked' })
    const report = (name, adapter, done, collateral) => {
      fs.mkdirSync(path.join(dir, 'target', 'eval', '2026-10-30', name), { recursive: true })
      const summary = { cases: [{ case: 'sheet.agent.act/total', model: 'claude-sonnet-5', runs: 3, done, collateral }] }
      fs.writeFileSync(path.join(dir, 'target', 'eval', '2026-10-30', name, 'report.json'), JSON.stringify({ date: '2026-10-30', adapter, summary }))
    }
    report('fake-1', 'fake', 3, 0)
    expect(evalCasesCell(source)).toMatchObject({ state: 'unchecked' })
    report('claude-code-2', 'claude-code', 2, 0)
    expect(evalCasesCell(source)).toMatchObject({ state: 'fail', value: '2/3 done, 0 collateral (2026-10-30)' })
    expect(evalCasesCell({ ...source, find: () => [] })).toMatchObject({ state: 'fail' })
  })
})

describe('the command line', () => {
  it('prints its usage and exits 2 when --requirements or --repos is missing', () => {
    for (const args of [[], ['--requirements', 'kit-requirements.yaml'], ['--repos', '..']]) {
      const run = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 10_000 })
      expect(run.status).toBe(2)
      expect(run.stderr).toContain('usage: kit-matrix.mjs --requirements')
    }
  })
})
