import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { anthropicApi, thinkingFor } from './eval/adapters.mjs'
import { findCases, problems, readFeatures, taskOf } from './eval/cases.mjs'
import { decide, insideAgent } from './eval/guard.mjs'
import { at, judge, judgeOne, without } from './eval/judge.mjs'
import { cost, markdown, summarize, wilson } from './eval/report.mjs'
import { parseArgs, select } from './eval-cases.mjs'

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cases-test-'))
  writeFileSync(join(dir, 'features.yaml'), 'format: 1\nkit: sheet\nfeatures:\n  - id: sheet.agent.act\n    dimension: [ai]\n  - id: sheet.cells\n    dimension: [function]\n')
  const caseDir = join(dir, 'cases', 'sheet.agent.act', 'total')
  mkdirSync(join(caseDir, 'input'), { recursive: true })
  writeFileSync(join(caseDir, 'input', 'sales.xlsx'), 'x')
  writeFileSync(
    join(caseDir, 'case.yaml'),
    [
      'format: 1',
      'id: sheet.agent.act/total',
      'feature: sheet.agent.act',
      'intent: Adds a total.',
      'layer: eval',
      'source: { kind: synthetic, from: test, license: owned }',
      'input: [input/sales.xlsx]',
      'steps:',
      '  - inspect: { path: sales.xlsx, as: before }',
      '  - task: { turns: ["Add a total.", "Check it."], max_turns: 5 }',
      '  - inspect: { path: sales.xlsx, as: after }',
      'expected:',
      '  - { actual: out:after, compare: values, value: { total: 3 } }',
      '  - { actual: out:after, compare: kdm-json, against: out:before, ignore: [total], collateral: true }',
      'solution:',
      '  - { tool: sheet_run, args: { path: sales.xlsx } }',
      'since: "2026-10-30"',
    ].join('\n'),
  )
  const gate = join(dir, 'cases', 'sheet.cells', 'basic')
  mkdirSync(gate, { recursive: true })
  writeFileSync(join(gate, 'case.yaml'), 'format: 1\nid: sheet.cells/basic\nlayer: gate\n')
  return dir
}

describe('eval cases', () => {
  it('finds only layer: eval cases and reads their task', () => {
    const dir = repo()
    const cases = findCases(dir)
    expect(cases.map((c) => c.id)).toEqual(['sheet.agent.act/total'])
    expect(taskOf(cases[0])).toMatchObject({ turns: ['Add a total.', 'Check it.'], maxTurns: 5 })
    expect(problems(cases[0], { features: readFeatures(dir), repo: dir })).toEqual([])
  })

  it('says what is wrong with a case', () => {
    const dir = repo()
    const [testCase] = findCases(dir)
    const broken = { ...testCase, feature: 'sheet.cells', expected: [{ actual: 'out:nowhere', compare: 'pixels' }], solution: [] }
    const found = problems(broken, { features: readFeatures(dir), repo: dir }).join('\n')
    expect(found).toContain('no ai dimension')
    expect(found).toContain('unknown compare pixels')
    expect(found).toContain('out:nowhere, which no step names')
    expect(found).toContain('solution')
  })

  it('lets a run step that does not save name its answer', () => {
    const [testCase] = findCases(repo())
    const read = (args) => ({ ...testCase, steps: [...testCase.steps, { run: { path: 'sales.xlsx', steps: [], args, as: 'state' } }], expected: [{ actual: 'out:state', compare: 'values', value: {} }] })
    expect(problems(read({ save: false })).join('\n')).not.toContain('out:state')
    const saving = problems(read(undefined)).join('\n')
    expect(saving).toContain('needs args: { save: false }')
    expect(saving).toContain('out:state, which no step names')
  })

  // regressions/issue-ai-dry-run-entry: kits' `cargo xtask eval --dry-run` starts this script as
  // `<repo>/../kition-sdk/tools/eval-cases.mjs`; through a symbolic link (macOS /tmp, a linked
  // checkout) that path is not the module's real one, and the dry run exited 0 having run nothing.
  it('checks the cases when started through a path that is not its real one', () => {
    const dir = repo()
    const caseFile = join(dir, 'cases', 'sheet.agent.act', 'total', 'case.yaml')
    writeFileSync(caseFile, readFileSync(caseFile, 'utf8').replace('feature: sheet.agent.act', 'feature: sheet.cells'))
    const link = join(mkdtempSync(join(tmpdir(), 'eval-cases-link-')), 'tools')
    symlinkSync(dirname(fileURLToPath(import.meta.url)), link)
    const script = `${link}/../tools/eval-cases.mjs`
    // `--dry-run` only: it calls no model. `--mcp` names no server, and none is needed: the case's
    // problem is found before a workspace is made.
    const run = spawnSync(process.execPath, [script, '--repo', dir, '--dry-run', '--mcp', join(dir, 'no-server')], { encoding: 'utf8', timeout: 60_000 })
    expect(run.stdout).toContain('FAIL sheet.agent.act/total')
    expect(run.stdout).toContain('no ai dimension')
    expect(run.status).toBe(1)
  })

  it('selects by kit, feature and case', () => {
    const cases = [{ id: 'a/1', feature: 'sheet.agent.act' }, { id: 'b/1', feature: 'note.agent.act' }]
    expect(select(cases, { kit: 'note' }).map((c) => c.id)).toEqual(['b/1'])
    expect(select(cases, { case: 'a/1' }).map((c) => c.id)).toEqual(['a/1'])
  })
})

describe('judge', () => {
  const after = { content: { rows: [[1, 'Region', 'Sales'], [2, 'North', 120]] }, shapes: [{ id: 1, text: 'Hire\nLaunch' }], total: 3 }

  it('reads dotted paths and compares values', () => {
    expect(at(after, 'content.rows.1.2')).toBe(120)
    expect(judgeOne({ actual: 'out:a', compare: 'values', value: { 'content.rows.1.1': 'North', total: { approx: 3.0000001 } } }, { a: after }).ok).toBe(true)
    expect(judgeOne({ actual: 'out:a', compare: 'values', value: { shapes: { any: { text: { matches: 'Hire\\s*\\nLaunch' } } } } }, { a: after }).ok).toBe(true)
    expect(judgeOne({ actual: 'out:a', compare: 'values', value: { shapes: { count: 2 } } }, { a: after }).why).toContain('shapes')
    expect(judgeOne({ actual: 'out:a', compare: 'values', value: { total: 3 } }, {}).ok).toBe(false)
  })

  it('finds collateral outside the ignored paths', () => {
    const before = { ...after, total: 1 }
    expect(judgeOne({ actual: 'out:a', compare: 'kdm-json', against: 'out:b', ignore: ['total'] }, { a: after, b: before }).ok).toBe(true)
    expect(judgeOne({ actual: 'out:a', compare: 'kdm-json', against: 'out:b', ignore: ['shapes.*.text'] }, { a: after, b: before }).ok).toBe(false)
    expect(without({ s: [{ a: 1, b: 2 }] }, ['s.*.b'])).toEqual({ s: [{ a: 1 }] })
    const verdict = judge([{ actual: 'out:a', compare: 'values', value: { total: 3 } }, { actual: 'out:a', compare: 'kdm-json', against: 'out:b', collateral: true }], { a: after, b: before })
    expect(verdict).toMatchObject({ done: false, collateral: true })
  })

  it('judges diagnostics and text', () => {
    const diagnostics = { diagnostics: [{ code: 'sheet.formula-error', severity: 'error' }] }
    expect(judgeOne({ actual: 'out:d', compare: 'diagnostics', value: { absent: ['sheet.formula-error'] } }, { d: diagnostics }).ok).toBe(false)
    expect(judgeOne({ actual: 'out:d', compare: 'diagnostics', value: { max_errors: 0 } }, { d: { diagnostics: [] } }).ok).toBe(true)
    expect(judgeOne({ actual: 'out:t', compare: 'text', value: { matches: ['^Open tasks: 1\\s*(?![\\s\\S])'], absent: ['TODO'] } }, { t: '# Plan\nOpen tasks: 1\n' }).ok).toBe(true)
  })
})

describe('report', () => {
  it('computes Wilson intervals', () => {
    const [low, high] = wilson(8, 10)
    expect(low).toBeCloseTo(0.4902, 3)
    expect(high).toBeCloseTo(0.9433, 3)
    expect(wilson(0, 0)).toEqual([null, null])
  })

  it('prices usage and summarizes runs', () => {
    expect(cost('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 1e5, cache_read_tokens: 1e6 })).toBeCloseTo(2 + 1 + 0.2)
    expect(cost('claude-sonnet-5', { cost_usd: 0.5 })).toBe(0.5)
    const runs = [
      { case: 'a', kit: 'sheet', model: 'm', done: true, collateral: false, tool_calls: 4, tool_errors: 1, cost_usd: 0.1 },
      { case: 'a', kit: 'sheet', model: 'm', done: false, collateral: true, tool_calls: 6, tool_errors: 0, cost_usd: 0.2 },
    ]
    const summary = summarize(runs)
    expect(summary.cases[0]).toMatchObject({ runs: 2, done: 1, collateral: 1, tool_calls_per_task: 5, tool_errors: 1 })
    expect(markdown({ date: 'd', adapter: 'fake', summary })).toContain('| a | m | 1/2 50%')
  })
})

describe('guard (F-QA-16)', () => {
  it('lets the fake adapter and the dry run through', () => {
    expect(decide({ adapter: 'fake', env: { CI: '1' }, tty: false }).allowed).toBe(true)
    expect(decide({ adapter: 'claude-code', dryRun: true, env: { CI: '1' }, tty: false }).allowed).toBe(true)
  })

  it('refuses real models in CI and without a terminal unless --yes', () => {
    expect(decide({ adapter: 'claude-code', env: { CI: '1' }, tty: true }).allowed).toBe(false)
    expect(decide({ adapter: 'anthropic-api', env: {}, tty: false }).allowed).toBe(false)
    expect(decide({ adapter: 'anthropic-api', env: {}, tty: false, yes: true })).toMatchObject({ allowed: true, ask: false })
    expect(decide({ adapter: 'codex', env: {}, tty: true })).toMatchObject({ allowed: true, ask: true })
  })

  it('never lets an agent start a run, even with --yes', () => {
    expect(insideAgent({ CLAUDECODE: '1' })).toBe(true)
    expect(decide({ adapter: 'claude-code', env: { CLAUDECODE: '1' }, tty: false, yes: true }).allowed).toBe(false)
    expect(decide({ adapter: 'claude-code', env: { CODEX_SANDBOX: 'seatbelt' }, tty: true, yes: true })).toMatchObject({ allowed: true, ask: true })
  })

  it('parses options and rejects unknown models', () => {
    expect(parseArgs(['--kit', 'sheet'])).toMatchObject({ kit: 'sheet', repeat: 3, adapter: 'claude-code', models: ['claude-sonnet-5'] })
    expect(() => parseArgs(['--model', 'claude-opus-5'])).toThrow('--model')
    expect(() => parseArgs(['--adapter', 'gpt'])).toThrow('--adapter')
  })
})

describe('anthropic-api adapter', () => {
  it('uses adaptive thinking with effort, and a budget only on Haiku 4.5', () => {
    expect(thinkingFor('claude-sonnet-5')).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    expect(thinkingFor('claude-haiku-4-5').thinking.type).toBe('enabled')
  })

  it('ends on a refusal without calling tools', async () => {
    const server = { command: process.execPath, args: ['-e', `
      const rl = require('node:readline').createInterface({ input: process.stdin })
      rl.on('line', (line) => {
        const m = JSON.parse(line); if (m.id === undefined) return
        const result = m.method === 'initialize' ? { instructions: 'Use the kit tools.' } : m.method === 'tools/list' ? { tools: [{ name: 'sheet_run', inputSchema: { type: 'object' } }] } : { content: [] }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
      })`] }
    const requests = []
    const client = { messages: { create: async (request) => (requests.push(request), { stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 1 } }) } }
    const usage = await anthropicApi({ server, turns: ['Do it.'], model: 'claude-sonnet-5', maxTurns: 5, client })
    expect(usage).toMatchObject({ stop: 'refusal', tool_calls: 0, input_tokens: 10 })
    expect(requests[0].tools[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(requests[0].system[0]).toMatchObject({ text: 'Use the kit tools.', cache_control: { type: 'ephemeral' } })
    expect(requests[0].tool_choice).toBeUndefined()
  })
})
