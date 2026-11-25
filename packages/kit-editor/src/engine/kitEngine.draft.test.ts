// @vitest-environment jsdom
/**
 * Drafts, restores and opening with a stored replica go through the kit's engine (Kit UI protocol
 * sections 7, 7d; `replica/restore`): the worker hands a draft's changes to the engine's
 * `mergeChanges` and `compareChanges`, a stored state to its `restoreState`, and opens a file
 * plainly when the engine cannot read the stored snapshot (UI-R1). An engine without these members
 * still opens and edits; the features are refused as unsupported.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleDocument, KitModuleManifest, KitModuleReplica } from './kitModule'
import { KitModelError } from './kitModel'

const fake = vi.hoisted(() => ({ doc: null as unknown, opened: [] as Array<KitModuleReplica | null>, unreadable: false }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: (_module: unknown, _manifest: unknown, _name: string, _bytes: Uint8Array, stored: KitModuleReplica | null = null) => {
    fake.opened.push(stored)
    if (stored && fake.unreadable) throw new Error('not KDM content')
    return fake.doc
  },
}))

const { handle } = await import('./kitEngine.worker')

const SUMMARY = { created: [], changed: [{ id: 'root', type: 'Board', fields: ['title'] }], moved: [], deleted: [], texts: [] }

/** An engine with a revision and the calls its members got; `members` adds or replaces them. */
function engine(members: Partial<KitModuleDocument> = {}) {
  const calls: unknown[][] = []
  const state = { revision: 0 }
  const doc: KitModuleDocument = {
    width: 1,
    height: 1,
    get revision() {
      return BigInt(state.revision)
    },
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command) => {
      calls.push(['execute', command])
      state.revision += 1
      return '{}'
    },
    inspect: () => '{}',
    commands: () => JSON.stringify([{ id: 'edit.thing', title: 'Thing', menu: [], shortcut: null, enabled: true, mutates: true }]),
    save: () => new Uint8Array([state.revision]),
    markSaved: () => undefined,
    free: () => undefined,
    addBlobs: (blobs) => void calls.push(['addBlobs', [...blobs]]),
    mergeChanges: (changes, origin) => {
      calls.push(['mergeChanges', [...changes], origin])
      state.revision += 1
      return JSON.stringify({ damage: { kind: 'full' }, summary: SUMMARY })
    },
    compareChanges: (changes) => {
      calls.push(['compareChanges', [...changes]])
      return JSON.stringify(SUMMARY)
    },
    restoreState: (snapshot, origin) => {
      calls.push(['restoreState', new TextDecoder().decode(snapshot), origin])
      state.revision += 1
      return JSON.stringify({ kind: 'full' })
    },
    ...members,
  }
  fake.doc = doc
  return { doc, calls, state }
}

const manifest = { kitId: 'kit.test' } as KitModuleManifest
const open = (readOnly = false, stored: KitModuleReplica | null = null) =>
  handle({ method: 'open', manifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null, readOnly, replica: stored ? { stored, follow: true } : null })
const changes = () => new Uint8Array([7, 8]).buffer
/** A stored state, as a checkpoint keeps it: content JSON. */
const snapshot = () => new TextEncoder().encode('{"kdm":1,"kit":"kit.test","objects":{}}').buffer as ArrayBuffer
const agent = { kind: 'agent', principal: 'agent:writer', label: 'Draft' } as const
const person = { kind: 'person', principal: 'user:ann', label: 'Restore' } as const

/** The reason a request was refused with, or its message. */
async function refusal(request: Promise<unknown>) {
  try {
    await request
  } catch (error) {
    return (error as { reason?: string }).reason ?? (error as Error).message
  }
  return 'answered'
}

describe('a draft through the engine', () => {
  it('merges through mergeChanges as the agent\'s origin, blobs first, and answers the summary and info', async () => {
    const { calls } = engine()
    await open()
    const answer = (await handle({ method: 'replicaMerge', changes: changes(), blobs: new Uint8Array([3]).buffer, origin: agent })).value as { summary: unknown; info: { revision: number } }
    expect(calls).toEqual([['addBlobs', [3]], ['mergeChanges', [7, 8], '["agent","agent:writer","Draft"]']])
    expect(answer.summary).toEqual(SUMMARY)
    expect(answer.info.revision).toBe(1)
  })

  it('compares through compareChanges, changing nothing', async () => {
    const { calls, state } = engine()
    await open()
    expect((await handle({ method: 'replicaCompare', changes: changes() })).value).toEqual(SUMMARY)
    expect(calls).toEqual([['compareChanges', [7, 8]]])
    expect(state.revision).toBe(0)
  })

  it('answers the engine\'s refusal as a model error, and refuses a read-only document\'s merge', async () => {
    engine({
      mergeChanges: () => {
        throw new Error('stale: the draft and the document both changed root.title')
      },
      compareChanges: () => {
        throw new Error('stale: the draft and the document both changed root.title')
      },
    })
    await open()
    for (const request of [{ method: 'replicaMerge', changes: changes(), blobs: new ArrayBuffer(0), origin: agent }, { method: 'replicaCompare', changes: changes() }] as const) {
      const error = await handle(request).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(KitModelError)
      expect((error as KitModelError).data).toEqual({ code: 'invalid-value', index: null, message: 'the draft does not merge: stale: the draft and the document both changed root.title' })
    }
    const { calls } = engine()
    await open(true)
    expect(await refusal(handle({ method: 'replicaMerge', changes: changes(), blobs: new ArrayBuffer(0), origin: agent }))).toBe('read-only')
    expect(calls).toEqual([])
  })
})

describe('a restore through the engine (replica/restore)', () => {
  it('writes the stored state with restoreState as the person, blobs first, and answers the damage and info', async () => {
    const { calls } = engine()
    await open()
    const answer = (await handle({ method: 'replicaRestore', snapshot: snapshot(), blobs: new Uint8Array([4]).buffer, origin: person })).value as { damage: unknown; info: { revision: number } }
    expect(calls).toEqual([['addBlobs', [4]], ['restoreState', '{"kdm":1,"kit":"kit.test","objects":{}}', '["person","user:ann","Restore"]']])
    expect(answer.damage).toEqual({ kind: 'full' })
    expect(answer.info.revision).toBe(1)
  })

  it('refuses a read-only document\'s restore', async () => {
    const { calls } = engine()
    await open(true)
    expect(await refusal(handle({ method: 'replicaRestore', snapshot: snapshot(), blobs: new ArrayBuffer(0), origin: person }))).toBe('read-only')
    expect(calls).toEqual([])
  })
})

describe('an engine without the members', () => {
  it('opens and edits, and refuses drafts and restores as unsupported', async () => {
    const { calls } = engine({ mergeChanges: undefined, compareChanges: undefined, restoreState: undefined })
    const opened = (await open()).value as { model: unknown }
    expect(opened.model).toBeNull()
    await handle({ method: 'execute', command: 'edit.thing', params: {} })
    expect(calls).toEqual([['execute', 'edit.thing']])
    expect(await refusal(handle({ method: 'replicaMerge', changes: changes(), blobs: new ArrayBuffer(0), origin: agent }))).toBe('unsupported')
    expect(await refusal(handle({ method: 'replicaCompare', changes: changes() }))).toBe('unsupported')
    expect(await refusal(handle({ method: 'replicaRestore', snapshot: snapshot(), blobs: new ArrayBuffer(0), origin: person }))).toBe('unsupported')
  })
})

describe('opening with the stored replica (UI-R1)', () => {
  it('opens with the stored snapshot, and plainly when the engine cannot read it', async () => {
    const stored = { snapshot: snapshot(), blobs: new ArrayBuffer(0) }
    engine()
    fake.opened = []
    fake.unreadable = false
    await open(false, stored)
    expect(fake.opened).toEqual([stored])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fake.opened = []
    fake.unreadable = true
    const answer = (await open(false, stored)).value as { revision: number }
    expect(fake.opened).toEqual([stored, null])
    expect(answer.revision).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    fake.unreadable = false
  })
})
