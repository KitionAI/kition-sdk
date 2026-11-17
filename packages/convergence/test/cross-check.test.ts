/**
 * The TypeScript runner against the Rust one: the same toy kit (`toy.ts`, the twin of the Rust
 * suite's `tests/toy.rs`) must reach the same states in every scenario, read in the same order, and
 * the same report. The Rust test `the_typescript_runner_reaches_the_same_states` writes and checks
 * the fixture; this test checks the TypeScript runner against it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, run, runOne, SCENARIOS } from '../src/index'
import { NotesKit } from './toy'

const fixture = JSON.parse(readFileSync(path.join(__dirname, '../../../crates/kition-convergence/tests/fixtures/toy-cross-check.json'), 'utf8'))

describe('the TypeScript runner and the Rust runner', () => {
  it('write the same report for the same kit', () => {
    expect(run(new NotesKit(), DEFAULT_OPTIONS).toJson()).toEqual(fixture.report)
  })

  it.each(SCENARIOS.map(([id]) => id))('reach the same states in %s', (id) => {
    const kit = new NotesKit()
    const outcome = runOne(kit, id, DEFAULT_OPTIONS)?.toJson().checks[0].outcome
    const recorded = kit.recorded
    expect({
      outcome,
      states: recorded.length,
      last: recorded.at(-1) ?? null,
      trace: createHash('sha256').update(recorded.join(',')).digest('hex'),
    }).toEqual(fixture.scenarios[id])
  })
})
