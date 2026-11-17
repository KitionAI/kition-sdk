// @vitest-environment jsdom
/**
 * Receipts on the live document (C3b): the engine worker answers the replica's version and the
 * change set since a version (`@kition/kdm`'s `changesSince`), as a headless kit answers Kit Process
 * Protocol's `model.version` and `model.changes`, so the agent's write in the open editor says
 * what it changed. The edit and its change set are shared with the Rust server's tests
 * (`crates/kition-kits/tests/fixtures/live-receipts.json`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSchema, person, Replica, Version } from '@kition/kdm'
import { describe, expect, it, vi } from 'vitest'
import testSchema from '../../../../crates/kition-kdm/tests/fixtures/test-schema.json'
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

/** A contract 2 engine over a real replica: the page `page` titled `One`; `page.rename` retitles it. */
function engine(withReplica = true) {
  const replica = Replica.create(parseSchema(JSON.stringify(testSchema)), '01920000-0000-7000-8000-0000000000ee', 7n)
  replica.transact(person('user:a'), (tx) => {
    tx.create('Page', { title: 'One' }, { id: 'page' })
  })
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
    execute: (command: string, params: string) => {
      if (command !== 'page.rename') throw new Error(`unknown command \`${command}\``)
      replica.transact(person('user:a'), (tx) => tx.set('page', 'title', (JSON.parse(params) as { title: string }).title))
      revision += 1n
      return '{}'
    },
    inspect: () => '{"canUndo":false,"canRedo":false}',
    commands: () => '[]',
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    ...(withReplica
      ? {
          version: () => replica.version().encode(),
          exportChanges: (since: Uint8Array) => replica.exportChanges(since.byteLength ? Version.decode(since) : Version.empty()),
          importChanges: () => '{"kind":"full"}',
        }
      : {}),
  }
  fake.doc = doc as unknown as KitModuleDocument
  return replica
}

const manifest = { kitId: 'kit.test', module: 'kit_test', documentClass: 'TestDocument' } as KitModuleManifest
const open = async () => (await handle({ method: 'open', manifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null })).value as KitEngineInfo
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

describe('the replica version and change set of the live document (C3b)', () => {
  it('tells the page the engine can say what changed only when it keeps a replica', async () => {
    engine()
    expect((await open()).changes).toBe(true)
    engine(false)
    expect((await open()).changes).toBeUndefined()
  })

  it('answers the version, and the change set since it of an edit (live-receipts.json)', async () => {
    const replica = engine()
    await open()
    const before = (await handle({ method: 'modelVersion' })).value as string
    expect(before).toBe(base64(replica.version().encode()))
    await handle({ method: 'execute', command: shared.edit.command, params: shared.edit.params })
    const answer = (await handle({ method: 'modelChanges', since: before, schema: testSchema })).value as { changes: unknown; version: string }
    expect(answer).toEqual({ changes: shared.changes, version: base64(replica.version().encode()) })
    // Nothing changed since now: an empty change set, which says so.
    const now = (await handle({ method: 'modelChanges', since: answer.version, schema: testSchema })).value as { changes: unknown }
    expect(now.changes).toEqual({ created: [], changed: [], moved: [], deleted: [] })
  })

  it('answers no change set, and why, for a version its history does not hold, never an empty one', async () => {
    engine()
    await open()
    const other = Replica.create(parseSchema(JSON.stringify(testSchema)), '01920000-0000-7000-8000-0000000000ff', 9n)
    other.transact(person('user:b'), (tx) => {
      tx.create('Page', { title: 'Else' }, { id: 'else' })
    })
    const answer = (await handle({ method: 'modelChanges', since: base64(other.version().encode()), schema: testSchema })).value as { changes: unknown; unavailable: string; version: string }
    expect(answer.changes).toBeNull()
    expect(answer.unavailable).toContain('not in this replica')
    expect(typeof answer.version).toBe('string')
  })
})
