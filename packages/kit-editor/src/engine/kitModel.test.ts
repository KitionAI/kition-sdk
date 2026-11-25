// @vitest-environment jsdom
/**
 * The object model answered by the kit (capability `model`), drafts merged into the document, and
 * restores, driven through the engine worker's `handle` with a fake contract 2 engine that answers
 * the engine members itself (`modelDescribe`, `modelBatch`, `mergeChanges`, `compareChanges`,
 * `restoreState`) with canned JSON, as `export_kit_session!` does. An engine without one of them
 * still opens and edits; the feature is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitEngineInfo, KitEngineRequest } from './kitEngine'
import { KitModelError } from './kitModel'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'
import { KitEngineRefusal, UNSUPPORTED_REASON } from './refusal'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const CATALOG = [
  { id: 'page.rename', title: 'Rename', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'edit.undo', title: 'Undo', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'edit.redo', title: 'Redo', menu: [], shortcut: null, mutates: true, enabled: true },
]

type Members = Partial<Pick<KitModuleDocument, 'modelBatch' | 'modelDescribe' | 'mergeChanges' | 'compareChanges' | 'restoreState'>>

/**
 * A contract 2 engine: its title is the document, `page.rename` the person's edit, and its version
 * one byte that every write moves. `members` are the engine members it answers; without them it
 * has none.
 */
function makeEngine(members: Members = {}) {
  const state = { title: 'One', seq: 0, undo: [] as string[], blobs: [] as number[][] }
  let revision = 0n
  const moved = () => {
    revision += 1n
    state.seq += 1
  }
  const doc: KitModuleDocument = {
    width: 1,
    height: 1,
    get revision() {
      return revision
    },
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command, params) => {
      if (command === 'page.rename') {
        state.undo.push(state.title)
        state.title = (JSON.parse(params) as { title: string }).title
        moved()
        return '{}'
      }
      if (command === 'edit.undo') {
        const was = state.undo.pop()
        if (was !== undefined) {
          state.title = was
          moved()
        }
        return JSON.stringify({ done: was !== undefined })
      }
      throw new Error(`unknown command \`${command}\``)
    },
    inspect: () => JSON.stringify({ canUndo: state.undo.length > 0, canRedo: false, title: state.title }),
    commands: () => JSON.stringify(CATALOG),
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    version: () => new Uint8Array([state.seq]),
    exportChanges: () => new Uint8Array(),
    importChanges: () => '{"kind":"full"}',
    addBlobs: (blobs) => void state.blobs.push([...blobs]),
    ...members,
  }
  return { doc, state, moved }
}

const manifest = { kitId: 'kit.test', module: 'kit_test', documentClass: 'TestDocument' } as KitModuleManifest

async function open(doc: KitModuleDocument, readOnly = false) {
  fake.doc = doc
  const opened = await handle({ method: 'open', manifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null, readOnly })
  return opened.value as KitEngineInfo
}

async function call(request: KitEngineRequest) {
  return (await handle(request)).value
}

const batch = async (request: Record<string, unknown>) => (await call({ method: 'modelBatch', request })) as { answer: { refs: Record<string, string>; results: unknown[]; loaded: Array<{ fields: Record<string, unknown> }>; version: ArrayBuffer | null }; info: KitEngineInfo }
const execute = async (command: string, params: Record<string, unknown> = {}) => (await call({ method: 'execute', command, params })) as { result: string; info: KitEngineInfo }

/** What a refused call rejected with. */
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

describe('the object model in the kit', () => {
  /** An engine answering the object model: a batch renames the page as the batch asks, one write. */
  function modelEngine() {
    const requests: string[] = []
    const engine = makeEngine({
      modelDescribe: () => JSON.stringify({ capability: 'KitObjectModel 1.0', root: 'Page', rootId: 'page', commands: CATALOG }),
      modelBatch: (request) => {
        requests.push(request)
        if (request.includes('"bad"')) throw new Error(JSON.stringify({ code: 'invalid-op', index: 0, message: 'unknown op `bad`' }))
        if (request.includes('nowhere')) throw new Error(JSON.stringify({ code: 'not-found', index: 1, message: '`nowhere` is not in the document' }))
        const parsed = JSON.parse(request) as { ops?: Array<{ value?: string }> }
        const title = parsed.ops?.find((op) => typeof op.value === 'string')?.value
        if (title) {
          engine.state.undo.push(engine.state.title)
          engine.state.title = title
          engine.moved()
        }
        return JSON.stringify({ refs: { $s: 'shape-1' }, results: [null], loaded: [{ fields: { title: engine.state.title } }] })
      },
    })
    return { ...engine, requests }
  }

  let current: ReturnType<typeof modelEngine>
  beforeEach(async () => {
    current = modelEngine()
    await open(current.doc)
  })

  it('says how the engine answers it: itself, or not at all', async () => {
    expect((await open(current.doc)).model).toBe('engine')
    expect((await open(makeEngine().doc)).model).toBeNull()
    expect((await open(makeEngine({ modelBatch: () => '{}' }).doc)).model).toBeNull()
  })

  it("runs a batch through the engine's own object model and answers its version after it", async () => {
    const { answer, info } = await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }], load: [{ target: 'root', fields: ['title'] }] })
    expect(JSON.parse(current.requests[0]!)).toEqual({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }], load: [{ target: 'root', fields: ['title'] }] })
    expect(answer.refs).toEqual({ $s: 'shape-1' })
    expect(answer.loaded[0]!.fields).toEqual({ title: 'Two' })
    expect(new Uint8Array(answer.version!)).toEqual(new Uint8Array([1]))
    expect(info.canUndo).toBe(true)
    expect(info.inspected.title).toBe('Two')
    const described = (await call({ method: 'modelDescribe' })) as { rootId: string; root: string; commands: unknown[] }
    expect(described).toMatchObject({ root: 'Page', rootId: 'page' })
    expect(described.commands).toHaveLength(CATALOG.length)
  })

  it("passes the engine's refusals on with their index, and changes nothing", async () => {
    const failed = await failure(batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }, { op: 'set', target: 'nowhere', field: 'title', value: 'x' }] }))
    expect(failed).toBeInstanceOf(KitModelError)
    expect((failed as KitModelError).data).toMatchObject({ code: 'not-found', index: 1 })
    expect(current.state.title).toBe('One')
    const bad = await failure(batch({ ops: [{ op: 'bad' }] }))
    expect((bad as KitModelError).data).toEqual({ code: 'invalid-op', index: 0, message: 'unknown op `bad`' })
  })

  it('refuses writes to a read-only document before the engine, and answers reads', async () => {
    await open(current.doc, true)
    const refused = await failure(batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }] }))
    expect((refused as KitModelError).data).toMatchObject({ code: 'read-only' })
    expect(current.requests).toHaveLength(0)
    const { answer } = await batch({ load: [{ target: 'root', fields: ['title'] }] })
    expect(answer.loaded[0]!.fields).toEqual({ title: 'One' })
    expect(current.state.title).toBe('One')
    expect(current.requests).toHaveLength(1)
  })

  it('an engine without modelBatch opens and edits, and refuses the object model', async () => {
    const plain = makeEngine()
    const info = await open(plain.doc)
    expect(info.model).toBeNull()
    const renamed = await execute('page.rename', { title: 'Edited' })
    expect(renamed.info.inspected.title).toBe('Edited')
    expect(renamed.info.canUndo).toBe(true)
    await expect(call({ method: 'modelBatch', request: { ops: [] } })).rejects.toThrow(/no object model/)
    await expect(call({ method: 'modelDescribe' })).rejects.toThrow(/no object model/)
    expect(plain.state.title).toBe('Edited')
  })
})

describe("an agent's draft merged in the kit", () => {
  const origin = { kind: 'agent', principal: 'user:a', label: "Merged the agent's draft" } as const
  const DRAFT = new TextEncoder().encode('{"changes":"the draft\'s"}')
  const SUMMARY = { created: [{ id: 'drafted', type: 'Shape', fields: ['fill'] }], changed: [{ id: 'page', type: 'Page', fields: ['shapes', 'title'] }], moved: [], deleted: [], texts: [] }

  /** An engine that merges and compares drafts: the draft retitles the page `Drafted`. */
  function draftEngine() {
    const calls: Array<{ member: string; changes: number[]; origin?: string }> = []
    const engine = makeEngine({
      compareChanges: (changes) => {
        calls.push({ member: 'compareChanges', changes: [...changes] })
        if (new TextDecoder().decode(changes).includes('stranger')) throw new Error('the changes belong to document 0192…ee, not 0192…dd')
        return JSON.stringify(SUMMARY)
      },
      mergeChanges: (changes, recorded) => {
        calls.push({ member: 'mergeChanges', changes: [...changes], origin: recorded })
        if (new TextDecoder().decode(changes).includes('stranger')) throw new Error('the changes belong to document 0192…ee, not 0192…dd')
        engine.state.undo.push(engine.state.title)
        engine.state.title = 'Drafted'
        engine.moved()
        return JSON.stringify({ damage: { kind: 'full' }, summary: SUMMARY })
      },
    })
    return { ...engine, calls }
  }
  const merge = async (changes: Uint8Array, blobs = new ArrayBuffer(0)) =>
    (await call({ method: 'replicaMerge', changes: changes.slice().buffer as ArrayBuffer, blobs, origin })) as { summary: typeof SUMMARY; info: KitEngineInfo }

  let current: ReturnType<typeof draftEngine>
  beforeEach(async () => {
    current = draftEngine()
    await open(current.doc)
  })

  it("compares without changing the document, and merges as one undo step through the engine's members", async () => {
    await execute('page.rename', { title: 'Person' })
    const compared = (await call({ method: 'replicaCompare', changes: DRAFT.slice().buffer as ArrayBuffer })) as typeof SUMMARY
    expect(compared.created.map((object) => object.id)).toEqual(['drafted'])
    expect(current.state.title).toBe('Person')

    const { summary, info } = await merge(DRAFT, new Uint8Array([7, 7]).buffer as ArrayBuffer)
    expect(summary.changed.find((object) => object.id === 'page')?.fields).toEqual(['shapes', 'title'])
    expect(current.calls.at(-1)).toEqual({ member: 'mergeChanges', changes: [...DRAFT], origin: JSON.stringify(['agent', 'user:a', "Merged the agent's draft"]) })
    // The draft's blobs reach the engine before the merge.
    expect(current.state.blobs).toEqual([[7, 7]])
    expect(current.state.title).toBe('Drafted')
    expect(info.canUndo).toBe(true)
    expect(info.inspected.title).toBe('Drafted')

    // The engine's Undo takes the whole merge back, then the person's own rename.
    await execute('edit.undo')
    expect(current.state.title).toBe('Person')
    await execute('edit.undo')
    expect(current.state.title).toBe('One')
  })

  it("refuses another document's draft as the engine does, and a merge on a read-only document", async () => {
    const stranger = new TextEncoder().encode('{"changes":"stranger"}')
    const refused = await failure(merge(stranger))
    expect((refused as KitModelError).data).toMatchObject({ code: 'invalid-value' })
    expect((refused as KitModelError).data.message).toMatch(/^the draft does not merge: the changes belong to document/)
    await expect(call({ method: 'replicaCompare', changes: stranger.slice().buffer as ArrayBuffer })).rejects.toMatchObject({ data: { code: 'invalid-value' } })
    expect(current.state.title).toBe('One')
    await open(current.doc, true)
    await expect(merge(DRAFT)).rejects.toThrow(/read-only/)
    expect(current.calls.filter((one) => one.member === 'mergeChanges')).toHaveLength(1)
  })

  it('an engine without mergeChanges and compareChanges still opens and edits; drafts are refused as unsupported', async () => {
    const plain = makeEngine()
    await open(plain.doc)
    await execute('page.rename', { title: 'Edited' })
    const merged = await failure(merge(DRAFT))
    expect(merged).toBeInstanceOf(KitEngineRefusal)
    expect((merged as KitEngineRefusal).reason).toBe(UNSUPPORTED_REASON)
    expect((merged as Error).message).toMatch(/mergeChanges/)
    const compared = await failure(call({ method: 'replicaCompare', changes: DRAFT.slice().buffer as ArrayBuffer }))
    expect((compared as KitEngineRefusal).reason).toBe(UNSUPPORTED_REASON)
    expect(plain.state.title).toBe('Edited')
  })
})

describe('a stored state restored in the kit (replica/restore)', () => {
  const SNAPSHOT = new TextEncoder().encode('{"kdm":1,"objects":{}}')
  const person = { kind: 'person', principal: 'user:a', label: 'Restore' } as const

  it("writes the snapshot through the engine's restoreState as the person's step, after its blobs", async () => {
    const restored: Array<{ snapshot: number[]; origin: string }> = []
    const engine = makeEngine({
      restoreState: (snapshot, origin) => {
        restored.push({ snapshot: [...snapshot], origin })
        engine.state.undo.push(engine.state.title)
        engine.state.title = 'Restored'
        engine.moved()
        return '{"kind":"full"}'
      },
    })
    await open(engine.doc)
    const { damage, info } = (await call({ method: 'replicaRestore', snapshot: SNAPSHOT.slice().buffer as ArrayBuffer, blobs: new Uint8Array([3]).buffer as ArrayBuffer, origin: person })) as { damage: unknown; info: KitEngineInfo }
    expect(damage).toEqual({ kind: 'full' })
    expect(restored).toEqual([{ snapshot: [...SNAPSHOT], origin: JSON.stringify(['person', 'user:a', 'Restore']) }])
    expect(engine.state.blobs).toEqual([[3]])
    expect(info.inspected.title).toBe('Restored')
    expect(info.canUndo).toBe(true)
    await execute('edit.undo')
    expect(engine.state.title).toBe('One')
    // A read-only document restores nothing.
    await open(engine.doc, true)
    await expect(call({ method: 'replicaRestore', snapshot: SNAPSHOT.slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0), origin: person })).rejects.toThrow(/read-only/)
    expect(restored).toHaveLength(1)
  })

  it('an engine without restoreState refuses it as unsupported', async () => {
    await open(makeEngine().doc)
    const refused = await failure(call({ method: 'replicaRestore', snapshot: SNAPSHOT.slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0), origin: person }))
    expect((refused as KitEngineRefusal).reason).toBe(UNSUPPORTED_REASON)
  })
})
