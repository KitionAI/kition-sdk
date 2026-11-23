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

  it('gets the kit ready before it saves, and takes the store snapshot after the file bytes', async () => {
    fakeDocument()
    const calls: string[] = []
    const doc = fake.doc as Record<string, unknown>
    const save = doc.save as () => Uint8Array
    Object.assign(doc, {
      prepareSave: () => calls.push('prepareSave'),
      save: () => (calls.push('save'), save()),
      snapshot: () => (calls.push('snapshot'), new Uint8Array([7])),
      blobs: () => new Uint8Array(0),
      version: () => new Uint8Array(0),
    })
    await open()
    await handle({ method: 'save' })
    expect(calls).toEqual(['prepareSave', 'save'])
    calls.length = 0
    const saved = (await handle({ method: 'saveWithReplica' })).value as { replica: { snapshot: ArrayBuffer } | null }
    expect(calls).toEqual(['prepareSave', 'save', 'snapshot'])
    expect(new Uint8Array(saved.replica!.snapshot)).toEqual(new Uint8Array([7]))
  })

  it('saves an engine that has no prepareSave as before', async () => {
    fakeDocument()
    await open()
    await edit()
    expect((await handle({ method: 'save' })).value).toMatchObject({ revision: 1 })
  })
})
