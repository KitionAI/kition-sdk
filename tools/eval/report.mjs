// The run report: success and collateral rates with Wilson intervals,
// tokens, cost, tool errors and calls per task.

/** The 95% Wilson score interval of `k` successes in `n` runs. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null]
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - h) / d, (c + h) / d]
}

/** US$ per million tokens: input, output; cache writes cost 1.25x input, cache reads 0.1x. */
export const PRICES = {
  'claude-sonnet-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-haiku-4-5': [1, 5],
}

/** The cost of one run's usage, unless the adapter reported its own. */
export function cost(model, usage) {
  if (usage.cost_usd !== undefined && usage.cost_usd !== null) return usage.cost_usd
  const price = PRICES[model]
  if (!price) return null
  const [input, output] = price
  return (
    ((usage.input_tokens ?? 0) * input +
      (usage.cache_write_tokens ?? 0) * input * 1.25 +
      (usage.cache_read_tokens ?? 0) * input * 0.1 +
      (usage.output_tokens ?? 0) * output) /
    1e6
  )
}

const sum = (runs, key) => runs.reduce((total, run) => total + (run[key] ?? 0), 0)

/** Aggregates per case and model, and over everything. */
export function summarize(runs) {
  const groups = new Map()
  for (const run of runs) {
    const key = `${run.case}\u0000${run.model}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(run)
  }
  const line = (list) => {
    const n = list.length
    const done = list.filter((r) => r.done).length
    const collateral = list.filter((r) => r.collateral).length
    const costs = list.map((r) => r.cost_usd).filter((c) => c !== null && c !== undefined)
    return {
      runs: n,
      done,
      success_rate: n ? done / n : null,
      success_95: wilson(done, n),
      collateral,
      collateral_rate: n ? collateral / n : null,
      collateral_95: wilson(collateral, n),
      refused: list.filter((r) => r.stop === 'refusal').length,
      invalid: list.filter((r) => r.invalid).length,
      input_tokens: sum(list, 'input_tokens'),
      cache_read_tokens: sum(list, 'cache_read_tokens'),
      cache_write_tokens: sum(list, 'cache_write_tokens'),
      output_tokens: sum(list, 'output_tokens'),
      cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      tool_calls_per_task: n ? sum(list, 'tool_calls') / n : null,
      tool_errors: sum(list, 'tool_errors'),
    }
  }
  return {
    cases: [...groups.entries()].map(([key, list]) => {
      const [testCase, model] = key.split('\u0000')
      return { case: testCase, kit: list[0].kit, model, ...line(list) }
    }),
    total: line(runs),
  }
}

const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(0)}%`)
const interval = ([low, high]) => (low === null ? '' : ` (${pct(low)}–${pct(high)})`)

/** The report as Markdown. */
export function markdown(report) {
  const rows = report.summary.cases.map(
    (c) =>
      `| ${c.case} | ${c.model} | ${c.done}/${c.runs} ${pct(c.success_rate)}${interval(c.success_95)} | ${c.collateral} | ${c.tool_calls_per_task?.toFixed(1) ?? '-'} | ${c.tool_errors} | ${c.input_tokens + c.cache_read_tokens + c.cache_write_tokens} / ${c.output_tokens} | ${c.cost_usd === null ? '-' : `$${c.cost_usd.toFixed(3)}`} |`,
  )
  const t = report.summary.total
  return [
    `# Eval cases ${report.date} (${report.adapter})`,
    '',
    `Started by a maintainer (F-QA-16). ${t.runs} runs; done ${t.done} ${pct(t.success_rate)}${interval(t.success_95)}; collateral ${t.collateral}; refused ${t.refused}; invalid ${t.invalid}; cost ${t.cost_usd === null ? 'unknown' : `$${t.cost_usd.toFixed(2)}`}.`,
    '',
    '| Case | Model | Done (95%) | Collateral | Calls/task | Tool errors | Tokens in / out | Cost |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}
