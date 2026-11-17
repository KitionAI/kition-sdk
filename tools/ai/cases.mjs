// The `layer: ai` cases of a repository (docs/quality.md, case format 1): finding, reading and checking
// them. A case says what the agent is asked (`task`), what the runner reads before and after
// (`inspect`, `query`, `check`, `file`), and what must then hold (`expected`); `solution` is the
// tool calls that do the task correctly, which the `fake` adapter and `--dry-run` replay.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { parse } from 'yaml'

export const COMPARES = ['values', 'kdm-json', 'diagnostics', 'text']
export const STEPS = ['inspect', 'query', 'check', 'file', 'run', 'task']
const READS = ['inspect', 'query', 'check', 'file']

/** Every `case.yaml` under `<repo>/cases`, parsed, with the `layer: ai` ones kept. */
export function findCases(repo) {
  const root = join(repo, 'cases')
  if (!existsSync(root)) return []
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'case.yaml') {
        const doc = parse(readFileSync(path, 'utf8'))
        if (doc?.layer === 'ai') found.push({ ...doc, dir: join(path, '..'), file: relative(repo, path) })
      }
    }
  }
  walk(root)
  return found
}

/** The feature ids `features.yaml` lists, and the direction of each. */
export function readFeatures(repo) {
  const path = join(repo, 'features.yaml')
  if (!existsSync(path)) return new Map()
  const doc = parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(doc) ? doc : (doc?.features ?? [])
  return new Map(list.map((feature) => [feature.id, feature]))
}

/** The kit a case is for: its feature's first segment (`sheet.agent.act` is `sheet`). */
export const kitOf = (testCase) => String(testCase.feature ?? '').split('.')[0]

/** The task step of a case: its prompt (one message) or turns (a conversation), as a list. */
export function taskOf(testCase) {
  const step = (testCase.steps ?? []).find((s) => s && 'task' in s)
  if (!step) return null
  const task = step.task
  const turns = Array.isArray(task.turns) ? task.turns : task.prompt ? [task.prompt] : []
  return { ...task, turns, maxTurns: task.max_turns ?? 30 }
}

/** What is wrong with a case, as sentences (empty when it can run). */
export function problems(testCase, { features = new Map(), repo } = {}) {
  const out = []
  const say = (text) => out.push(`${testCase.file ?? testCase.id}: ${text}`)
  if (testCase.format !== 1) say('format must be 1')
  if (!testCase.id || !testCase.feature || !testCase.intent) say('id, feature and intent are required')
  if (repo && testCase.dir && testCase.id && relative(join(repo, 'cases'), testCase.dir) !== testCase.id) say(`id must equal its folder (${relative(join(repo, 'cases'), testCase.dir)})`)
  if (features.size && !features.has(testCase.feature)) say(`feature ${testCase.feature} is not in features.yaml`)
  if (features.has(testCase.feature) && !(features.get(testCase.feature).direction ?? []).includes('ai')) say(`feature ${testCase.feature} has no ai direction`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(testCase.since ?? ''))) say('since must be a quoted YYYY-MM-DD date')
  if (!testCase.source?.kind) say('source.kind is required')
  for (const input of testCase.input ?? []) {
    if (testCase.dir && !input.startsWith('repo:') && !existsSync(join(testCase.dir, input))) say(`input ${input} is missing`)
  }
  const named = new Set()
  let tasks = 0
  for (const step of testCase.steps ?? []) {
    const kinds = Object.keys(step ?? {})
    if (kinds.length !== 1 || !STEPS.includes(kinds[0])) { say(`unknown step ${JSON.stringify(step)}`); continue }
    const [kind] = kinds
    const value = step[kind]
    if (kind === 'task') {
      tasks += 1
      const turns = Array.isArray(value.turns) ? value.turns : value.prompt ? [value.prompt] : []
      if (!turns.length || turns.some((turn) => typeof turn !== 'string' || !turn.trim())) say('task needs a prompt or non-empty turns')
      continue
    }
    if (!value?.path) say(`${kind} needs a path`)
    if (READS.includes(kind)) {
      if (!value?.as) say(`${kind} needs as`)
      else named.add(value.as)
    } else if (kind === 'run' && value?.as) {
      // A read through commands (select, then answer what is selected): it must not save, or the
      // step after the task would change the file it judges.
      if (value.args?.save !== false) say('a run that names its answer (as) needs args: { save: false }')
      else named.add(value.as)
    }
  }
  if (tasks !== 1) say('an ai case has exactly one task step')
  if (!Array.isArray(testCase.expected) || !testCase.expected.length) say('expected needs at least one entry')
  for (const expectation of testCase.expected ?? []) {
    if (!COMPARES.includes(expectation.compare)) say(`unknown compare ${expectation.compare}`)
    const name = String(expectation.actual ?? '').replace(/^out:/, '')
    if (!named.has(name)) say(`expected reads out:${name}, which no step names`)
    if (expectation.compare === 'kdm-json' && !named.has(String(expectation.against ?? '').replace(/^out:/, ''))) say('kdm-json needs against: out:<name> of a step')
  }
  if (!Array.isArray(testCase.solution) || !testCase.solution.length) say('solution (the tool calls that do the task) is required for the dry run')
  return out
}

/** The workspace name of an input: `input/budget.xlsx` is `budget.xlsx`. */
export const workspaceName = (input) => basename(input.replace(/^repo:/, ''))
