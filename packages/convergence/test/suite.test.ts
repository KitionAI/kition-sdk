import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, optionsFromEnv, run, runOne, SCENARIOS, SUITE } from '../src/index'
import { broken, NotesKit } from './toy'

const crate = path.join(__dirname, '../../../crates/kition-convergence')

describe('the TypeScript convergence suite', () => {
  it('has the Rust suite’s scenarios, in its order, and its name', () => {
    const source = readFileSync(path.join(crate, 'src/scenarios.rs'), 'utf8')
    const table = source.slice(source.indexOf('pub(crate) const SCENARIOS'), source.indexOf('];'))
    const rust = [...table.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((match) => [match[1], match[2]])
    expect(rust).toHaveLength(17)
    expect(SCENARIOS).toEqual(rust)
    expect(readFileSync(path.join(crate, 'src/lib.rs'), 'utf8')).toContain(`pub const SUITE: &str = "${SUITE}";`)
  })

  it('passes a correct kit, skipping only what it has no step for', () => {
    const report = run(new NotesKit(), DEFAULT_OPTIONS)
    expect(report.level6(), report.render()).toBe(true)
    // The toy has no paragraphs: split and merge are skipped, which L6 allows.
    expect(report.outcome('text-split')).toEqual({ kind: 'skipped', reason: 'the adapter has no SplitParagraph' })
    const json = report.toJson()
    expect(json).toMatchObject({ kit: 'kit.notes', suite: SUITE, level6: true })
    expect(json.checks.some((check) => check.outcome === 'skipped' && typeof check.reason === 'string')).toBe(true)
    expect(report.toJsonText()).toMatch(/^\{\n {2}"checks": \[/)
    expect(report.render()).toContain('kit.notes: 15/17 scenarios passed; L6 convergence passed')
  })

  it('catches a missing repair', () => {
    broken.repair = true
    try {
      const outcome = runOne(new NotesKit(), 'delete-edit', DEFAULT_OPTIONS)?.outcome('delete-edit')
      expect(outcome?.kind).toBe('failed')
      expect(outcome?.kind === 'failed' && outcome.reason).toMatch(/does not exist/)
    } finally {
      broken.repair = false
    }
  })

  it('catches an undo that reverts other actors’ changes', () => {
    const outcome = runOne(new NotesKit(true), 'undo', DEFAULT_OPTIONS)?.outcome('undo')
    expect(outcome?.kind).toBe('failed')
    expect(outcome?.kind === 'failed' && outcome.reason).toMatch(/later change/)
  })

  it('reports an unknown scenario as such', () => {
    expect(runOne(new NotesKit(), 'teleport', DEFAULT_OPTIONS)).toBeNull()
  })

  it('reads heavier runs from the environment', () => {
    expect(optionsFromEnv({})).toEqual(DEFAULT_OPTIONS)
    expect(optionsFromEnv({ KITION_CONVERGENCE_SEEDS: '5', KITION_CONVERGENCE_STEPS: '300' })).toEqual({ seeds: [1, 2, 3, 4, 5], replicas: [2, 3, 5], steps: 300 })
    expect(optionsFromEnv({ KITION_CONVERGENCE_SEEDS: '3', KITION_CONVERGENCE_SEED_BASE: '1000' }).seeds).toEqual([1001, 1002, 1003])
    expect(optionsFromEnv({ KITION_CONVERGENCE_SEED_BASE: '50' }).seeds).toEqual([51, 52, 53])
  })
})
