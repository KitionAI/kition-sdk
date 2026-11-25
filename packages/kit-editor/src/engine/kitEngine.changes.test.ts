// @vitest-environment jsdom
/**
 * Receipts on the live document (C3b): the engine worker answers the replica's version and the
 * change set since a version (the engine's `changesSince`), as a headless kit answers Kit Process
 * Protocol's `model.version` and `model.changes`, so the agent's write in the open editor says
 * what it changed. The edit and its change set are shared with the Rust server's tests
 * (`crates/kition-kits/tests/fixtures/live-receipts.json`); the fake engine answers them as the
 * Rust engine's `changesSince` does.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { KitEngineInfo } from './kitEngine'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const shared = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'crates', 'kition-kits', 'tests', 'fixtures', 'live-receipts.json'), 'utf8')) as {
  edit: { command: string; params: Record<string, unknown> }
  changes: unknown
}

const NOTHING = { created: [], changed: [], moved: [], deleted: [] }

/**
 * A contract 2 engine whose version is one byte (its edit count): `page.rename` is the shared edit,
 * and `changesSince` answers the shared change set since version 0, none since the version now,
 * and no change set for a version its log does not hold. `changesSince: false` leaves the member out.
 */
function engine(options: { replica?: boolean; changesSince?: boolean } = {}) {
  const { replica = true, changesSince = true } = options
  const state = { seq: 0, asked: [] as number[][] }
  let revision = 0n
  const doc = {
    width: 1,
    height: 1,
    get revision() {
      return revision
    },
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string) => {
      if (command !== 'page.rename') throw new Error(`unknown command \`${command}\``)
      state.seq += 1
      revision += 1n
      return '{}'
    },
    inspect: () => '{"canUndo":false,"canRedo":false}',
    commands: () => '[]',
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    ...(replica
      ? {
          version: () => new Uint8Array([state.seq]),
          exportChanges: () => new Uint8Array(),
          importChanges: () => '{"kind":"full"}',
        }
      : {}),
    ...(replica && changesSince
      ? {
          changesSince: (since: Uint8Array) => {
            state.asked.push([...since])
            if (since.byteLength !== 1 || since[0]! > state.seq) return JSON.stringify({ changes: null, unavailable: 'the version is not in this replica' })
            return JSON.stringify({ changes: since[0] === state.seq ? NOTHING : shared.changes })
          },
        }
      : {}),
  }
  fake.doc = doc as unknown as KitModuleDocument
  return state
}

const manifest = { kitId: 'kit.test', module: 'kit_test', documentClass: 'TestDocument' } as KitModuleManifest
const open = async () => (await handle({ method: 'open', manifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null })).value as KitEngineInfo
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

describe('the replica version and change set of the live document (C3b)', () => {
  it('tells the page the engine can say what changed only when it answers changesSince', async () => {
    engine()
    expect((await open()).changes).toBe(true)
    engine({ replica: false })
    expect((await open()).changes).toBeUndefined()
    engine({ changesSince: false })
    expect((await open()).changes).toBeUndefined()
  })

  it('answers the version, and the change set since it of an edit (live-receipts.json)', async () => {
    const state = engine()
    await open()
    const before = (await handle({ method: 'modelVersion' })).value as string
    expect(before).toBe(base64(new Uint8Array([0])))
    await handle({ method: 'execute', command: shared.edit.command, params: shared.edit.params })
    const answer = (await handle({ method: 'modelChanges', since: before })).value as { changes: unknown; version: string }
    expect(answer).toEqual({ changes: shared.changes, version: base64(new Uint8Array([1])) })
    // The engine was asked with the version's bytes.
    expect(state.asked).toEqual([[0]])
    // Nothing changed since now: an empty change set, which says so.
    const now = (await handle({ method: 'modelChanges', since: answer.version })).value as { changes: unknown }
    expect(now.changes).toEqual(NOTHING)
  })

  it('answers no change set, and why, for a version its history does not hold, never an empty one', async () => {
    engine()
    await open()
    const answer = (await handle({ method: 'modelChanges', since: base64(new Uint8Array([9, 9, 9])) })).value as { changes: unknown; unavailable: string; version: string }
    expect(answer.changes).toBeNull()
    expect(answer.unavailable).toContain('not in this replica')
    expect(typeof answer.version).toBe('string')
  })

  it('refuses modelChanges for an engine without changesSince, which still opens and edits', async () => {
    engine({ changesSince: false })
    expect((await open()).changes).toBeUndefined()
    await handle({ method: 'execute', command: shared.edit.command, params: shared.edit.params })
    await expect(handle({ method: 'modelChanges', since: base64(new Uint8Array([0])) })).rejects.toThrow(/changesSince/)
  })
})
