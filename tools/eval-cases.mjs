#!/usr/bin/env node
// The runner of `layer: eval` cases (docs/quality.md; decision F-QA-16): real models editing kit
// files through the kits' MCP server, judged from the files they leave. Only a maintainer starts it:
// never a hook, the gate, the pre-finish check, a schedule, CI, or an agent on its own
// (tools/eval/guard.mjs).
//
//   node tools/eval-cases.mjs --repo <repo> [--kit k] [--feature f] [--case id] [--model m]...
//        [--repeat 3] [--adapter claude-code|anthropic-api|codex|fake] [--effort high]
//        [--dry-run] [--list] [--yes] [--keep] [--out <dir>]
//
// Kit repositories run it as `cargo xtask eval …`, Kition as `pnpm eval …`. `--dry-run` calls no
// model: each case must parse, open its inputs, fail on the input state and pass after its
// `solution`. Reports go to `<repo>/target/eval/<date>/<adapter>-<time>/` (report.json, report.md,
// and transcripts/, which stays out of Git).
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '../examples/agent-mcp/mcp-client.mjs'
import { ADAPTERS, DEFAULT_MODEL, MODELS, runAdapter } from './eval/adapters.mjs'
import { findCases, kitOf, problems, readFeatures, taskOf, workspaceName } from './eval/cases.mjs'
import { confirm, decide } from './eval/guard.mjs'
import { judge } from './eval/judge.mjs'
import { cost, markdown, PRICES, summarize } from './eval/report.mjs'
import { cleanup, locate, makeWorkspace, runSteps, serverCommand, split } from './eval/session.mjs'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseArgs(argv) {
  const options = { models: [], repeat: 3, adapter: 'claude-code', effort: 'high' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${flag} needs a value`)
      return argv[i]
    }
    switch (flag) {
      case '--repo': options.repo = value(); break
      case '--kit': options.kit = value(); break
      case '--feature': options.feature = value(); break
      case '--case': options.case = value(); break
      case '--model': options.models.push(value()); break
      case '--repeat': options.repeat = Number(value()); break
      case '--adapter': options.adapter = value(); break
      case '--effort': options.effort = value(); break
      case '--out': options.out = value(); break
      case '--mcp': options.mcp = value(); break
      case '--siblings': options.siblings = value(); break
      case '--dry-run': options.dryRun = true; break
      case '--list': options.list = true; break
      case '--yes': options.yes = true; break
      case '--keep': options.keep = true; break
      default: throw new Error(`unknown option ${flag}`)
    }
  }
  if (!options.models.length) options.models.push(DEFAULT_MODEL)
  if (!ADAPTERS.includes(options.adapter)) throw new Error(`--adapter is one of ${ADAPTERS.join(', ')}`)
  if (!(options.repeat >= 1)) throw new Error('--repeat is a positive number')
  for (const model of options.models) if (!MODELS.includes(model)) throw new Error(`--model is one of ${MODELS.join(', ')}`)
  return options
}

/** The cases a run selects. */
export function select(cases, { kit, feature, case: id }) {
  return cases.filter((c) => (!kit || kitOf(c) === kit) && (!feature || c.feature === feature) && (!id || c.id === id))
}

/** A rough estimate, printed before any model call: per run, the tool list and instructions once per round. */
async function estimate(cases, options, where) {
  const kits = [...new Set(cases.map(kitOf))]
  const probe = makeWorkspace({ input: [] }, options.repo)
  const server = await connect(...Object.values(serverCommand(where, probe, kits)), { stderr: 'ignore' })
  const fixed = JSON.stringify(await server.tools()).length + (server.server.instructions ?? '').length
  await server.close()
  cleanup(probe)
  const perRound = Math.ceil(fixed / 4) + 2000
  let tokens = 0
  for (const c of cases) tokens += perRound * Math.ceil(taskOf(c).maxTurns / 2) * options.repeat * options.models.length
  const dollars = options.models.map((m) => [m, (tokens * (PRICES[m]?.[0] ?? 0) * 0.3) / 1e6]) // mostly cache reads
  return { runs: cases.length * options.repeat * options.models.length, tokens, dollars }
}

/** One run of one case: workspace, steps before, the agent, steps after, the judgement. */
async function runOnce(testCase, { adapter, model, options, where, solution = testCase.solution, skipTask = false }) {
  const kit = kitOf(testCase)
  const workspace = makeWorkspace(testCase, options.repo)
  const server = serverCommand(where, workspace, [kit])
  const outputs = {}
  const { before, after } = split(testCase)
  const task = taskOf(testCase)
  const started = Date.now()
  let usage
  try {
    await runSteps(before, { prefix: kit, workspace, command: server, outputs })
    usage = skipTask
      ? { tool_calls: 0, tool_errors: 0, stop: 'skipped', transcript: [] }
      : await runAdapter(adapter, { server, workspace, turns: task.turns, model, maxTurns: task.maxTurns, effort: options.effort, solution, timeoutMs: (testCase.timeout_s ?? 900) * 1000 })
    await runSteps(after, { prefix: kit, workspace, command: server, outputs })
  } finally {
    cleanup(workspace, options.keep)
  }
  const verdict = judge(testCase.expected, outputs)
  return { case: testCase.id, kit, model, adapter, ...usage, ...verdict, cost_usd: cost(model, usage ?? {}), wall_s: (Date.now() - started) / 1000, workspace: options.keep ? workspace : undefined }
}

/** The dry run: no model; every case parses, opens, fails on its input and passes after its solution. */
async function dryRun(cases, options, where, features) {
  const report = []
  for (const testCase of cases) {
    const found = problems(testCase, { features, repo: options.repo })
    const entry = { case: testCase.id, problems: found }
    if (!found.length) {
      try {
        const kit = kitOf(testCase)
        const workspace = makeWorkspace(testCase, options.repo)
        const opens = (testCase.input ?? []).map((input) => ({ inspect: { path: workspaceName(input), as: `open:${workspaceName(input)}` } }))
        await runSteps(opens, { prefix: kit, workspace, command: serverCommand(where, workspace, [kit]), outputs: {} })
        cleanup(workspace)
        entry.opens = true
        const untouched = await runOnce(testCase, { adapter: 'fake', model: DEFAULT_MODEL, options, where, skipTask: true })
        entry.input_state = { done: untouched.done, failed: untouched.results.filter((r) => !r.ok).map((r) => `${r.compare} ${r.actual}`) }
        const solved = await runOnce(testCase, { adapter: 'fake', model: DEFAULT_MODEL, options, where })
        entry.solution = { done: solved.done, collateral: solved.collateral, tool_errors: solved.tool_errors, failed: solved.results.filter((r) => !r.ok).map((r) => `${r.compare} ${r.actual}: ${r.why}`) }
        if (untouched.done) entry.problems.push('expected already holds on the input state: the case tests nothing')
        if (!solved.done) entry.problems.push(`expected does not hold after the solution: ${entry.solution.failed.join('; ')}`)
        if (solved.tool_errors) entry.problems.push(`the solution had ${solved.tool_errors} failed tool calls`)
      } catch (error) {
        entry.problems.push(String(error.message ?? error))
      }
    }
    report.push(entry)
    console.log(`${entry.problems.length ? 'FAIL' : 'ok  '} ${testCase.id}${entry.problems.length ? `\n     ${entry.problems.join('\n     ')}` : ''}`)
  }
  return report
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  options.repo = resolve(options.repo ?? process.cwd())
  const where = locate({ sdk, siblings: resolve(options.siblings ?? join(options.repo, '..')), mcp: options.mcp })
  const features = readFeatures(options.repo)
  const cases = select(findCases(options.repo), options)
  if (options.list) {
    for (const c of cases) console.log(`${c.id}  (${kitOf(c)}, ${taskOf(c)?.turns.length ?? 0} turn(s))`)
    return 0
  }
  if (!cases.length) {
    console.error('no layer: eval cases match')
    return 1
  }
  if (options.dryRun) {
    const report = await dryRun(cases, options, where, features)
    return report.some((e) => e.problems.length) ? 1 : 0
  }
  for (const c of cases) {
    const found = problems(c, { features, repo: options.repo })
    if (found.length) {
      console.error(found.join('\n'))
      return 1
    }
  }
  const gate = decide({ adapter: options.adapter, dryRun: false, yes: options.yes })
  if (!gate.allowed) {
    console.error(`refused: ${gate.why}`)
    return 2
  }
  if (options.adapter !== 'fake') {
    const e = await estimate(cases, options, where)
    const summary = `${cases.length} case(s) x ${options.models.join(', ')} x ${options.repeat} = ${e.runs} runs with ${options.adapter}; about ${(e.tokens / 1e6).toFixed(1)}M input tokens, roughly ${e.dollars.map(([m, d]) => `$${d.toFixed(2)} on ${m}`).join(', ')}.`
    console.log(summary)
    if (gate.ask && !(await confirm(summary))) {
      console.error('not started')
      return 2
    }
  }
  const date = new Date().toISOString().slice(0, 10)
  const out = resolve(options.out ?? join(options.repo, 'target', 'eval', date, `${options.adapter}-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}`))
  mkdirSync(join(out, 'transcripts'), { recursive: true })
  const runs = []
  for (const testCase of cases) {
    for (const model of options.models) {
      for (let rep = 1; rep <= options.repeat; rep += 1) {
        const result = await runOnce(testCase, { adapter: options.adapter, model, options, where })
        const { transcript, ...record } = result
        writeFileSync(join(out, 'transcripts', `${testCase.id.replaceAll('/', '__')}.${model}.${rep}.json`), JSON.stringify(transcript ?? [], null, 1))
        runs.push({ ...record, rep })
        console.log(`${record.done ? 'done' : 'FAIL'} ${testCase.id} ${model} #${rep}${record.collateral ? ' (collateral)' : ''}${record.invalid ? ` invalid: ${record.invalid}` : ''}`)
      }
    }
  }
  const report = { date, adapter: options.adapter, models: options.models, repeat: options.repeat, repo: options.repo, runs, summary: summarize(runs) }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1))
  writeFileSync(join(out, 'report.md'), markdown(report))
  console.log(`report: ${join(out, 'report.md')}`)
  return 0
}

/**
 * Whether the module at `moduleUrl` is the script node was started with (`script`, its
 * `process.argv[1]`), compared as real paths: kits' `cargo xtask eval` starts it as
 * `<repo>/../kition-sdk/tools/eval-cases.mjs`, which may pass through symbolic links (or hold
 * characters a URL escapes) while the module's URL is its real path. Only a maintainer's run of
 * the script reaches `main`, and `main`'s guard still decides whether any model is called.
 */
export function startedAsScript(moduleUrl, script) {
  if (!script) return false
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(script))
  } catch {
    return false
  }
}

if (startedAsScript(import.meta.url, process.argv[1])) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
