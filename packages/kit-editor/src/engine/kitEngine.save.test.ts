// @vitest-environment jsdom
/**
 * The engine worker's save answers the revision it serialized, and `markSaved` with a revision
 * marks the document saved only while it is still at that revision.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

function fakeDocument() {
  const state = { revision: 0, saved: 0 }
  fake.doc = {
    width: 1,
    height: 1,
    get revision() {
      return BigInt(state.revision)
    },
    get dirty() {
      return state.revision !== state.saved
    },
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: () => {
      state.revision += 1
      return '{}'
    },
    inspect: () => '{}',
    commands: () => JSON.stringify([{ id: 'edit.thing', title: 'Thing', menu: [], shortcut: null, enabled: true, mutates: true }]),
    save: () => new Uint8Array([state.revision]),
    markSaved: () => {
      state.saved = state.revision
    },
    free: () => undefined,
  }
  return state
}

async function open() {
  await handle({ method: 'open', manifest: { kitId: 'kit.test' } as KitModuleManifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null })
}

const edit = () => handle({ method: 'execute', command: 'edit.thing', params: {} })

describe('the engine worker saving', () => {
  it('answers the revision it serialized, with or without the replica', async () => {
    fakeDocument()
    await open()
    await edit()
    expect((await handle({ method: 'save' })).value).toMatchObject({ revision: 1 })
    expect((await handle({ method: 'saveWithReplica' })).value).toMatchObject({ revision: 1, replica: null })
  })

  it('marks the document saved only at the revision it was saved at', async () => {
    const state = fakeDocument()
    await open()
    await edit()
    const { revision } = (await handle({ method: 'save' })).value as { revision: number }
    await edit()
    expect((await handle({ method: 'markSaved', revision })).value).toMatchObject({ dirty: true })
    expect(state.saved).toBe(0)
    expect((await handle({ method: 'markSaved', revision: 2 })).value).toMatchObject({ dirty: false })
    await edit()
    expect((await handle({ method: 'markSaved' })).value).toMatchObject({ dirty: false })
  })

  it('takes the store snapshot, its blobs and its version after the file bytes', async () => {
    fakeDocument()
    const calls: string[] = []
    const doc = fake.doc as Record<string, unknown>
    const save = doc.save as () => Uint8Array
    Object.assign(doc, {
      save: () => (calls.push('save'), save()),
      snapshot: () => (calls.push('snapshot'), new Uint8Array([7])),
      blobs: () => (calls.push('blobs'), new Uint8Array(0)),
      version: () => (calls.push('version'), new Uint8Array(0)),
    })
    await open()
    calls.length = 0
    await handle({ method: 'save' })
    expect(calls).toEqual(['save'])
    calls.length = 0
    const saved = (await handle({ method: 'saveWithReplica' })).value as { replica: { snapshot: ArrayBuffer } | null }
    expect(calls).toEqual(['save', 'snapshot', 'blobs', 'version'])
    expect(new Uint8Array(saved.replica!.snapshot)).toEqual(new Uint8Array([7]))
  })

  it('takes the version the snapshot holds in the same step as the bytes (UI-R6)', async () => {
    const state = fakeDocument()
    Object.assign(fake.doc as Record<string, unknown>, {
      snapshot: () => new Uint8Array([state.revision]),
      blobs: () => new Uint8Array(0),
      version: () => new Uint8Array([100 + state.revision]),
    })
    await open()
    await edit()
    const saved = (await handle({ method: 'saveWithReplica' })).value as { bytes: ArrayBuffer; replica: { snapshot: ArrayBuffer; version: ArrayBuffer } }
    // An edit after the save moves the document on; the save's version stays the saved one.
    await edit()
    expect(new Uint8Array(saved.bytes)).toEqual(new Uint8Array([1]))
    expect(new Uint8Array(saved.replica.snapshot)).toEqual(new Uint8Array([1]))
    expect(new Uint8Array(saved.replica.version)).toEqual(new Uint8Array([101]))
  })
})
