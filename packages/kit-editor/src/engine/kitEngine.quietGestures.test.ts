// @vitest-environment jsdom
/**
 * The engine worker's `info` during a gesture asked to be quiet (`KitEngine.tool`'s `quiet`,
 * `useKitDocument`'s `quietGestures`): a drag's busy, unsettled answers do not read `inspect()`
 * again, while the revision, size and saved state still follow; the release reads it once. Without
 * `quiet` each step that moved the revision reads it as before. `pointerLeft` is optional.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const manifest = { kitId: 'kit.test', module: 'test', documentClass: 'TestDocument' } as KitModuleManifest

/** A document whose `pointer` drags a box: down and drag answer busy and move it, up settles. */
function fakeDocument(withLeave = false) {
  const state = { revision: 0, inspects: 0, x: 0, dirty: false, left: 0 }
  const doc = {
    width: 10,
    height: 10,
    get revision() {
      return BigInt(state.revision)
    },
    get dirty() {
      return state.dirty
    },
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: () => '{}',
    inspect: () => {
      state.inspects += 1
      return JSON.stringify({ x: state.x, canUndo: state.revision > 0, canRedo: false })
    },
    commands: () => '[]',
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    pointer: (event: string) => {
      const { action, x } = JSON.parse(event) as { action: string; x: number }
      state.x = x
      state.revision += 1
      state.dirty = true
      return JSON.stringify({ requests: [], overlays: [], cursor: 'move', busy: action !== 'up', wantsText: false })
    },
    ...(withLeave ? { pointerLeft: () => { state.left += 1; return JSON.stringify({ requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }) } } : {}),
  }
  return { doc, state }
}

async function open(withLeave = false) {
  const made = fakeDocument(withLeave)
  fake.doc = made.doc
  await handle({ method: 'open', manifest, name: 'a.box', bytes: new ArrayBuffer(1), lent: null, replica: null })
  return made.state
}

type Answer = { value: unknown; info: { revision: number; dirty: boolean; inspected: { x?: number } } | null }
const pointer = async (action: string, x: number, settled: boolean, quiet?: boolean) =>
  (await handle({ method: 'tool', name: 'pointer', args: [JSON.stringify({ action, x, y: 0, zoom: 1 })], settled, ...(quiet === undefined ? {} : { quiet }) })).value as Answer

describe('a quiet gesture', () => {
  it('reads inspect() once at its release, while its steps follow the revision', async () => {
    const state = await open()
    const before = state.inspects
    const down = await pointer('down', 1, false, true)
    const drag = await pointer('drag', 2, false, true)
    expect(state.inspects).toBe(before)
    expect(down.info?.revision).toBe(1)
    expect(drag.info).toMatchObject({ revision: 2, dirty: true })
    // The last inspection (made when the document opened) stays until the release.
    expect(drag.info?.inspected.x).toBe(0)
    const up = await pointer('up', 3, true, true)
    expect(state.inspects).toBe(before + 1)
    expect(up.info).toMatchObject({ revision: 3, inspected: { x: 3 } })
  })

  it('reads inspect() at every step that moved the revision when not quiet', async () => {
    const state = await open()
    const before = state.inspects
    const drag = await pointer('drag', 2, false)
    expect(state.inspects).toBe(before + 1)
    expect(drag.info?.inspected.x).toBe(2)
  })
})

describe('pointerLeft', () => {
  it('reaches a kit that has it, and answers nothing for one that does not', async () => {
    const state = await open(true)
    const left = (await handle({ method: 'tool', name: 'pointerLeft', args: [1], settled: false })).value as Answer
    expect(state.left).toBe(1)
    expect(left).toMatchObject({ value: { cursor: 'default' }, info: null })
    await open(false)
    expect((await handle({ method: 'tool', name: 'pointerLeft', args: [1], settled: false })).value).toEqual({ value: null, info: null })
  })
})
