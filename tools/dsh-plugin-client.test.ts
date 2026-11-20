// The kition-kits DeepSeek Harness plugin's browser module, its pure parts: the turn projection
// (which kit files an agent's turn touched, and how, from the session's tool events) and the review
// card's state and actions. The rest runs in a real DeepSeek Harness (the plugin's test/web.e2e.ts).
import { describe, expect, it } from 'vitest'

import { actionOf, cardActions, cardState, kitTurnDefinition, type KitTurnFile, type KitTurnState } from '../plugins/deepseek-harness/kition-kits/src/client/turn'

type Event = { type: string; data: Record<string, unknown> }

/** The projection of `events` as DeepSeek Harness's conversation engine runs it: start, then updates. */
function project(events: Event[]) {
  let state: KitTurnState | undefined
  for (const event of events) {
    const match = kitTurnDefinition.match(event)
    if (!match) continue
    state = match.role === 'start' ? kitTurnDefinition.start(undefined, { event }) : kitTurnDefinition.update({ state: state! }, { event })
  }
  return state!
}

const call = (callId: string, name: string, args: Record<string, unknown>): Event => ({ type: 'tool/call', data: { turn: 3, step: 1, callId, name, arguments: JSON.stringify(args) } })
const result = (callId: string, meta?: Record<string, unknown>, text = 'ok', isError = false): Event => ({
  type: 'tool/result',
  data: { turn: 3, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError }, ...(meta ? { meta } : {}) },
})

describe('the turn projection', () => {
  it('names a kit tool’s action, whatever its kit prefix', () => {
    expect(actionOf('mcp__kition__kit_run')).toBe('run')
    expect(actionOf('mcp__kition__kit_draft_ready')).toBe('draft_ready')
    expect(actionOf('mcp__kition__note_inspect')).toBe('inspect')
    expect(actionOf('bash')).toBeNull()
    expect(actionOf('mcp__other__kit_run')).toBeNull()
  })

  it('keeps each touched file with what each call did, from the result’s kept presentation', () => {
    const state = project([
      { type: 'turn/start', data: { turn: 3 } },
      call('a', 'mcp__kition__kit_inspect', { path: './notes/a.md' }),
      result('a', { kition: 1, path: 'notes/a.md', kit: 'kit.note', live: false, draft: false }),
      call('b', 'mcp__kition__kit_run', { path: 'notes/a.md', steps: [] }),
      result('b', { kition: 1, path: 'notes/a.md', kit: 'kit.note', live: true, draft: false }),
      call('c', 'mcp__kition__kit_run', { path: 't.ktable', draft: true, steps: [] }),
      result('c', { kition: 1, path: 't.ktable', kit: null, live: false, draft: true }),
      call('d', 'bash', { command: 'ls' }),
      call('e', 'mcp__kition__kit_run', { path: 'x.md', steps: [] }),
    ])
    expect(state.turn).toBe(3)
    expect(state.files.map((file) => [file.path, file.kit, file.operations.map((operation) => `${operation.action}:${operation.phase}:${operation.live ? 'live' : ''}${operation.draft ? 'draft' : ''}`)])).toEqual([
      ['notes/a.md', 'kit.note', ['inspect:done:', 'run:done:live']],
      ['t.ktable', null, ['run:done:draft']],
      ['x.md', null, ['run:pending:']],
    ])
  })

  it('reads a result without a kept presentation from its text, and a failed call as failed', () => {
    const state = project([
      { type: 'turn/start', data: { turn: 3 } },
      call('a', 'mcp__kition__kit_run', { path: 'a.md', steps: [] }),
      result('a', undefined, 'Ran 1 commands on `a.md` in its open Note editor\n{"live":true,"document":{"kit":"kit.note"}}'),
      call('b', 'mcp__kition__kit_run', { path: 'b.md', steps: [] }),
      result('b', undefined, 'refused', true),
    ])
    expect(state.files[0]).toMatchObject({ path: 'a.md', kit: 'kit.note', operations: [{ phase: 'done', live: true }] })
    expect(state.files[1].operations[0].phase).toBe('failed')
  })

  it('publishes the turn’s files at its Turn location, and nothing for a turn without kit files', () => {
    const empty = project([{ type: 'turn/start', data: { turn: 3 } }, call('d', 'bash', {})])
    expect(kitTurnDefinition.buildLocationData({ state: empty }, 'turn', null)).toBeNull()
    const state = project([{ type: 'turn/start', data: { turn: 3 } }, call('b', 'mcp__kition__kit_run', { path: 'a.md' })])
    const published = kitTurnDefinition.buildLocationData({ state }, 'turn', null)!
    expect(published).toEqual({ kind: 'turn', turn: 3, key: 'kitionTurn', value: { files: state.files } })
    expect(kitTurnDefinition.buildLocationData({ state }, 'turn', published)).toBe(published)
    expect(kitTurnDefinition.buildLocationData({ state }, 'step', null)).toBeNull()
  })
})

describe('a review card', () => {
  const file = (...operations: Array<Partial<KitTurnFile['operations'][number]>>): KitTurnFile => ({
    path: 'a.md',
    kit: 'kit.note',
    operations: operations.map((operation, at) => ({ callId: String(at), action: 'run', phase: 'done', writes: true, live: false, draft: false, created: false, ...operation })),
  })

  it('is there only for files the turn changed', () => {
    expect(cardState(file({ action: 'inspect', writes: false }), {})).toBeNull()
  })

  it('says how an edit was applied', () => {
    expect(cardState(file({ phase: 'pending' }), {})).toBe('pending')
    expect(cardState(file({ phase: 'failed' }), {})).toBe('failed')
    expect(cardState(file({ live: true }), {})).toBe('live')
    expect(cardState(file({}), {})).toBe('saved')
    expect(cardState(file({ created: true, action: 'create' }), {})).toBe('created')
    expect(cardState(file({}), { exists: false })).toBe('missing')
  })

  it('follows the draft the gateway lists, and what the person did to it', () => {
    const drafted = file({ draft: true })
    expect(cardState(drafted, {})).toBe('draft-open')
    expect(cardState(drafted, { draft: { state: 'open', stale: false } })).toBe('draft-open')
    expect(cardState(drafted, { draft: { state: 'ready', stale: false } })).toBe('draft-ready')
    expect(cardState(drafted, { draft: { state: 'ready', stale: true } })).toBe('stale')
    expect(cardState(drafted, { draft: null, outcome: 'merged' })).toBe('merged')
    expect(cardState(drafted, { draft: null, outcome: 'discarded' })).toBe('discarded')
    expect(cardState(drafted, { draft: null })).toBe('draft-gone')
    expect(cardState(drafted, { draft: null, exists: false })).toBe('missing')
  })

  it('offers the person’s actions only where they apply: Merge and overwrite only for a stale draft', () => {
    expect(cardActions('draft-open')).toEqual(['open', 'review', 'merge', 'discard'])
    expect(cardActions('stale')).toEqual(['open', 'review', 'overwrite', 'discard'])
    expect(cardActions('live')).toEqual(['open'])
    expect(cardActions('merged')).toEqual(['open'])
    expect(cardActions('missing')).toEqual([])
  })
})
