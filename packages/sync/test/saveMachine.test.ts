import { describe, expect, it } from 'vitest'
import table from '../../../crates/kition-sync-protocol/tests/save-transitions.json'
import { initialSaveState, mustSave, saveTransition, type SaveEvent, type SaveState } from '../src/saveMachine'

describe('the save state machine (D3), against the shared transitions', () => {
  for (const scenario of table.scenarios) {
    it(scenario.name, () => {
      let state: SaveState = initialSaveState('v1')
      scenario.events.forEach((step, index) => {
        const result = saveTransition(state, step.event as SaveEvent)
        expect(result.refused, `${scenario.name}, event ${index}`).toBe((step as { refused?: string }).refused)
        if ('state' in step) expect(result.state, `${scenario.name}, event ${index}`).toMatchObject(step.state as Partial<SaveState>)
        state = result.state
      })
    })
  }

  it('reports whether a transition changed the state', () => {
    const start = initialSaveState()
    expect(saveTransition(start, { type: 'joined', by: 'ann' }).changed).toBe(false)
    expect(saveTransition(start, { type: 'change', seq: 1, by: 'ann' }).changed).toBe(true)
    expect(mustSave(saveTransition(saveTransition(start, { type: 'change', seq: 1, by: 'ann' }).state, { type: 'left', by: 'ann', last: true }).state)).toBe(true)
  })
})
