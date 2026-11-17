/**
 * The lazily loaded runner must share no code with the engine worker's entry: a bundler would put
 * that code in the entry chunk and the runner's chunk would import it, and WebKit evaluates a
 * module worker's entry script again when it is imported, replacing the worker's message handler
 * with one that has no document open (every later request fails). So the runner imports values
 * only from packages the worker does not load statically, and only types from the worker's own
 * modules.
 */
import { describe, expect, it } from 'vitest'
import runner from './kitModelRunner.ts?raw'
import worker from './kitEngine.worker.ts?raw'

/** The static imports of a module's source: specifier, and whether the import is type-only. */
function imports(source: string) {
  return [...source.matchAll(/^import\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gms)].map((match) => ({ from: match[2], typeOnly: Boolean(match[1]) }))
}

describe('the object-model runner chunk', () => {
  it('imports only types from the worker’s own modules', () => {
    const values = imports(runner).filter((item) => !item.typeOnly)
    expect(values.filter((item) => item.from.startsWith('.'))).toEqual([])
  })

  it('imports no value module the worker entry loads statically', () => {
    const entry = new Set(imports(worker).filter((item) => !item.typeOnly).map((item) => item.from))
    expect(imports(runner).filter((item) => !item.typeOnly && entry.has(item.from))).toEqual([])
    // The worker loads the runner only lazily.
    expect(imports(worker).some((item) => item.from === './kitModelRunner' && !item.typeOnly)).toBe(false)
  })
})
