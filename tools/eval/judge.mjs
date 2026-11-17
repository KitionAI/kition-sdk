// Judging an eval case from what the runner read (`out:<name>`), never with a model: values at
// paths, the state before and after with the paths the task may touch ignored (collateral), the
// kit's check, and a file's text.

/** The value at a dotted path (`content.rows.4.2`); `undefined` when any segment is missing. */
export function at(value, path) {
  if (path === '' || path === undefined) return value
  let current = value
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined
    current = Array.isArray(current) ? current[Number(segment)] : current[segment]
  }
  return current
}

/** `value` with every path in `ignore` removed; `*` matches any key or index. */
export function without(value, ignore = []) {
  const copy = structuredClone(value)
  const drop = (node, segments) => {
    if (node === null || typeof node !== 'object' || !segments.length) return
    const [head, ...rest] = segments
    const keys = head === '*' ? Object.keys(node) : [head]
    for (const key of keys) {
      if (!(key in node)) continue
      if (rest.length) drop(node[key], rest)
      else if (Array.isArray(node)) node[key] = '<ignored>'
      else delete node[key]
    }
  }
  for (const path of ignore) drop(copy, String(path).split('.'))
  return copy
}

/** Structural equality with numbers compared within `epsilon`. */
export function same(a, b, epsilon = 1e-9) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= epsilon
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (!same(a[key], b[key], epsilon)) return false
  return true
}

/**
 * One expected value: a literal, or `{ approx, tol }`, `{ contains }`, `{ matches }`, `{ count }`,
 * `{ absent: true }`, or `{ any: { <key>: <expected>, … } }` (some item of a list has those).
 */
function matchValue(actual, expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('any' in expected) return Array.isArray(actual) && actual.some((item) => Object.entries(expected.any).every(([key, want]) => matchValue(at(item, key), want)))
    if ('approx' in expected) return typeof actual === 'number' && Math.abs(actual - expected.approx) <= (expected.tol ?? 1e-6)
    if ('contains' in expected) return typeof actual === 'string' && actual.includes(expected.contains)
    if ('matches' in expected) return typeof actual === 'string' && new RegExp(expected.matches).test(actual)
    if ('count' in expected) return Array.isArray(actual) && actual.length === expected.count
    if ('absent' in expected) return expected.absent ? actual === undefined : actual !== undefined
  }
  return same(actual, expected)
}

/** Judges one expectation against the named reads; answers `{ ok, why }`. */
export function judgeOne(expectation, outputs) {
  const name = String(expectation.actual).replace(/^out:/, '')
  const actual = outputs[name]
  if (actual === undefined) return { ok: false, why: `out:${name} was not read` }
  switch (expectation.compare) {
    case 'values': {
      const misses = Object.entries(expectation.value ?? {})
        .filter(([path, want]) => !matchValue(at(actual, path), want))
        .map(([path, want]) => `${path} is ${JSON.stringify(at(actual, path))}, expected ${JSON.stringify(want)}`)
      return { ok: !misses.length, why: misses.join('; ') }
    }
    case 'kdm-json': {
      const against = outputs[String(expectation.against).replace(/^out:/, '')]
      if (against === undefined) return { ok: false, why: `${expectation.against} was not read` }
      const ok = same(without(actual, expectation.ignore), without(against, expectation.ignore), expectation.tolerance?.epsilon ?? 1e-9)
      return { ok, why: ok ? '' : `out:${name} differs from ${expectation.against} outside the ignored paths` }
    }
    case 'diagnostics': {
      const list = Array.isArray(actual) ? actual : (actual.diagnostics ?? [])
      const codes = list.map((d) => d.code)
      const want = expectation.value ?? {}
      const misses = []
      for (const code of want.absent ?? []) if (codes.includes(code)) misses.push(`${code} is still reported`)
      for (const code of want.present ?? []) if (!codes.includes(code)) misses.push(`${code} is not reported`)
      if (want.max_errors !== undefined) {
        const errors = list.filter((d) => d.severity === 'error').length
        if (errors > want.max_errors) misses.push(`${errors} errors, at most ${want.max_errors}`)
      }
      return { ok: !misses.length, why: misses.join('; ') }
    }
    case 'text': {
      const text = String(actual)
      const want = expectation.value ?? {}
      const misses = []
      if (want.equals !== undefined && text !== want.equals) misses.push('the text differs')
      for (const part of want.contains ?? []) if (!text.includes(part)) misses.push(`no ${JSON.stringify(part)}`)
      for (const part of want.absent ?? []) if (text.includes(part)) misses.push(`still has ${JSON.stringify(part)}`)
      for (const pattern of want.matches ?? []) if (!new RegExp(pattern, 'm').test(text)) misses.push(`does not match /${pattern}/`)
      return { ok: !misses.length, why: misses.join('; ') }
    }
    default:
      return { ok: false, why: `unknown compare ${expectation.compare}` }
  }
}

/** Judges a run: done when every expectation holds; collateral when a `collateral: true` one fails. */
export function judge(expected, outputs) {
  const results = expected.map((expectation) => ({ expectation, ...judgeOne(expectation, outputs) }))
  return {
    done: results.every((r) => r.ok),
    collateral: results.some((r) => r.expectation.collateral && !r.ok),
    results: results.map((r) => ({ actual: r.expectation.actual, compare: r.expectation.compare, collateral: Boolean(r.expectation.collateral), ok: r.ok, why: r.why })),
  }
}
