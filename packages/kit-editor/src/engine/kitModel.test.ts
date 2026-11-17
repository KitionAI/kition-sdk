// @vitest-environment jsdom
/**
 * The object model answered by the kit (capability `model`), driven through the engine worker's
 * `handle` with a fake contract 2 engine that keeps a real KDM replica: a script's batch runs on
 * the worker's scratch replica, reaches the engine as changes, and is one step of the person's
 * undo history, in order with the engine's own steps.
 */
import { parseSchema, person, Replica, Version } from '@kition/kdm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import testSchema from '../../../../crates/kition-kdm/tests/fixtures/test-schema.json'
import type { KitEngineInfo, KitEngineRequest } from './kitEngine'
import { KitModelError } from './kitModel'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const schema = testSchema as object
const schemaText = JSON.stringify(testSchema)

const CATALOG = [
  { id: 'page.rename', title: 'Rename', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'shape.paint', title: 'Paint', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'shape.add', title: 'Add shape', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'edit.undo', title: 'Undo', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'edit.redo', title: 'Redo', menu: [], shortcut: null, mutates: true, enabled: true },
]

/**
 * A contract 2 engine: its replica (another actor than the worker's scratch one) is the document,
 * `page.rename` is the person's edit, and Undo and Redo are its replica's own (they never reach
 * changes it imported, as a real kit's history does not).
 */
function makeEngine(options: { modelBatch?: (request: string) => string }) {
  const replica = Replica.create(parseSchema(schemaText), '01920000-0000-7000-8000-0000000000dd', 7n)
  replica.transact(person('user:a'), (tx) => {
    tx.create('Page', { title: 'One' }, { id: 'page' })
  })
  let revision = 0n
  const moved = <T,>(value: T) => {
    revision += 1n
    return value
  }
  const ran: Array<{ id: string; params: string; origin: string | null }> = []
  const doc: KitModuleDocument & { replica: Replica } = {
    replica,
    width: 1,
    height: 1,
    get revision() {
      return revision
    },
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command, params) => {
      ran.push({ id: command, params, origin: null })
      if (command === 'page.rename') {
        replica.transact(person('user:a'), (tx) => tx.set('page', 'title', (JSON.parse(params) as { title: string }).title))
        return moved('{}')
      }
      if (command === 'edit.undo') return JSON.stringify({ done: moved(replica.undo()) })
      if (command === 'edit.redo') return JSON.stringify({ done: moved(replica.redo()) })
      throw new Error(`unknown command \`${command}\``)
    },
    executeAs: (command, params, origin) => {
      ran.push({ id: command, params, origin })
      if (command === 'shape.add') {
        // One undo step of the engine: a shape in the page's list and at the root of its outline.
        const { id } = JSON.parse(params) as { id: string }
        replica.transact(person('user:a'), (tx) => {
          tx.create('Shape', { kind: 'rect', x: 0, y: 0 }, { id })
          tx.listInsert('page', 'shapes', tx.listItems('page', 'shapes').length, id)
          tx.treeCreate('page', 'outline', null, id)
        })
        return moved(JSON.stringify({ added: id }))
      }
      if (command !== 'shape.paint') throw new Error(`unknown command \`${command}\``)
      const { shape, fill } = JSON.parse(params) as { shape: string; fill: string }
      replica.transact(person('user:a'), (tx) => tx.set(shape, 'fill', fill))
      return moved(JSON.stringify({ painted: shape }))
    },
    inspect: () => JSON.stringify({ canUndo: replica.canUndo(), canRedo: replica.canRedo() }),
    commands: () => JSON.stringify(CATALOG),
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    canUndo: () => replica.canUndo(),
    canRedo: () => replica.canRedo(),
    version: () => replica.version().encode(),
    exportChanges: (since) => replica.exportChanges(since.byteLength ? Version.decode(since) : Version.empty()),
    importChanges: (changes) => {
      replica.importChanges(changes)
      return moved('{"kind":"full"}')
    },
    ...(options.modelBatch ? { modelBatch: options.modelBatch, modelDescribe: () => '{"capability":"KitObjectModel 1.0"}' } : {}),
  }
  return { doc, replica, ran }
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

const batch = async (request: Record<string, unknown>) => (await call({ method: 'modelBatch', request, schema })) as { answer: { refs: Record<string, string>; results: unknown[]; loaded: Array<{ fields: Record<string, unknown> }>; version: ArrayBuffer | null }; info: KitEngineInfo }
const execute = async (command: string, params: Record<string, unknown> = {}) => (await call({ method: 'execute', command, params })) as { result: string; info: KitEngineInfo }

/** The engine's document as the test reads it: the page's title and its shapes' fills. */
function seen(replica: Replica) {
  const shapes = replica.list('page', 'shapes') as string[]
  return { title: replica.get('page', 'title'), shapes: shapes.map((id) => replica.get(id, 'fill') ?? null) }
}

describe('the object model in the kit', () => {
  let current: ReturnType<typeof makeEngine>
  beforeEach(async () => {
    current = makeEngine({})
    await open(current.doc)
  })

  it('says how the engine answers it', async () => {
    expect((await open(current.doc)).model).toBe('replica')
    expect((await open(makeEngine({ modelBatch: () => '{}' }).doc)).model).toBe('engine')
    expect((await open({ ...makeEngine({}).doc, exportChanges: undefined } as unknown as KitModuleDocument)).model).toBeNull()
  })

  it('runs a batch on the document: writes, commands as the origin, references, and reads', async () => {
    const { answer, info } = await batch({
      ops: [
        { op: 'create', type: 'Shape', in: 'root.shapes', fields: { kind: 'rect', x: 1, y: 2 }, ref: '$s' },
        { op: 'set', target: 'root', field: 'title', value: 'Two' },
        { op: 'command', id: 'shape.paint', params: { shape: '$s', fill: '#5645d4' } },
      ],
      load: [{ target: '$s', fields: ['fill', 'x'] }],
    })
    expect(seen(current.replica)).toEqual({ title: 'Two', shapes: ['#5645d4'] })
    expect(answer.results[2]).toEqual({ painted: answer.refs.$s })
    expect(answer.loaded[0].fields).toEqual({ fill: '#5645d4', x: 1 })
    expect(new Uint8Array(answer.version!)).toEqual(current.replica.version().encode())
    expect(current.ran.at(-1)?.origin).toBe('["extension","script",null]')
    expect(info.canUndo).toBe(true)
    const described = (await call({ method: 'modelDescribe', schema })) as { rootId: string; root: string; commands: unknown[] }
    expect(described).toMatchObject({ root: 'Page', rootId: 'page' })
    expect(described.commands).toHaveLength(CATALOG.length)
  })

  it('a script batch is one undo step', async () => {
    await execute('page.rename', { title: 'Person' })
    await batch({
      ops: [
        { op: 'create', type: 'Shape', in: 'root.shapes', fields: { kind: 'rect', x: 1, y: 2 } },
        { op: 'create', type: 'Shape', in: 'root.shapes', fields: { kind: 'ellipse', x: 3, y: 4, fill: 'red' } },
        { op: 'set', target: 'root', field: 'title', value: 'Script' },
      ],
    })
    expect(seen(current.replica)).toEqual({ title: 'Script', shapes: [null, 'red'] })
    // One Undo takes the whole batch back, and only it.
    let undone = await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'Person', shapes: [] })
    expect(undone.info.canUndo).toBe(true)
    expect(undone.info.canRedo).toBe(true)
    // The next Undo is the person's own edit.
    undone = await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })
    // Redo comes back in the same order.
    await execute('edit.redo')
    expect(seen(current.replica)).toEqual({ title: 'Person', shapes: [] })
    const redone = await execute('edit.redo')
    expect(seen(current.replica)).toEqual({ title: 'Script', shapes: [null, 'red'] })
    expect(redone.info.canRedo).toBe(false)
  })

  it("undoes the person's later edit first, then the script's", async () => {
    await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Script' }, { op: 'create', type: 'Shape', in: 'root.shapes', fields: { kind: 'rect', x: 1, y: 2 } }] })
    await execute('page.rename', { title: 'Person' })
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'Script', shapes: [null] })
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })
    expect((await execute('edit.undo')).info.canUndo).toBe(false)
  })

  it('redoes script steps after Undo passed the command that made their objects, and Redo brought it back', async () => {
    // The command makes `made` (an engine step); the script's model operations then change it, add
    // a shape under it in the outline, and move it in the tree (a script step).
    await batch({
      ops: [
        { op: 'command', id: 'shape.add', params: { id: 'made' } },
        { op: 'set', target: 'made', field: 'fill', value: '#5645d4' },
        { op: 'text.insert', target: 'made', field: 'label', index: 0, text: 'Hello' },
        { op: 'set', target: 'root', field: 'title', value: 'Script' },
        { op: 'create', type: 'Shape', in: 'root.outline', parent: 'made', ref: '$child', fields: { kind: 'ellipse', x: 1, y: 1 } },
        { op: 'list.insert', target: 'root', field: 'shapes', item: '$child' },
      ],
    })
    // A second script step after it.
    await batch({ ops: [{ op: 'set', target: 'made', field: 'x', value: 5 }] })
    const done = current.replica.stateText()
    expect(seen(current.replica)).toEqual({ title: 'Script', shapes: ['#5645d4', null] })
    expect(current.replica.tree('page', 'outline').map((entry) => entry.object)).toEqual(['made', expect.any(String)])

    // Undo both script steps, then the command: nothing is left.
    await execute('edit.undo')
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [null] })
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })

    // Redo all: the command, then both script steps, made again on the shape the command brought back.
    let redone = await execute('edit.redo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [null] })
    redone = await execute('edit.redo')
    expect(redone.result).toBe(JSON.stringify({ done: true }))
    expect(seen(current.replica)).toEqual({ title: 'Script', shapes: ['#5645d4', null] })
    redone = await execute('edit.redo')
    expect(redone.result).toBe(JSON.stringify({ done: true }))
    expect(redone.info.canRedo).toBe(false)
    expect(current.replica.stateText()).toBe(done)

    // The steps made again undo and redo as before, also across the command once more.
    await execute('edit.undo')
    await execute('edit.undo')
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })
    await execute('edit.redo')
    await execute('edit.redo')
    await execute('edit.redo')
    expect(current.replica.stateText()).toBe(done)
    expect((await execute('edit.redo')).info.canRedo).toBe(false)
  })

  it("an edit of the person's drops the script steps to redo", async () => {
    await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Script' }] })
    await execute('edit.undo')
    expect((await execute('page.rename', { title: 'Person' })).info.canRedo).toBe(false)
    await execute('edit.redo')
    expect(seen(current.replica).title).toBe('Person')
  })

  it('refuses a bad operation with its index and changes nothing', async () => {
    const failed = await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }, { op: 'set', target: 'nowhere', field: 'title', value: 'x' }] }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(KitModelError)
    expect((failed as KitModelError).data).toMatchObject({ code: 'not-found', index: 1 })
    expect(seen(current.replica).title).toBe('One')
  })

  it('refuses writes to a read-only document and answers reads', async () => {
    await open(current.doc, true)
    const refused = await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }] }).catch((error: unknown) => error)
    expect((refused as KitModelError).data).toMatchObject({ code: 'read-only' })
    const { answer } = await batch({ load: [{ target: 'root', fields: ['title'] }] })
    expect(answer.loaded[0].fields).toEqual({ title: 'One' })
    expect(seen(current.replica).title).toBe('One')
  })

  it("prefers the engine's own object model, and passes its refusals on", async () => {
    const requests: string[] = []
    const own = makeEngine({
      modelBatch: (request) => {
        requests.push(request)
        if (request.includes('"bad"')) throw new Error(JSON.stringify({ code: 'invalid-op', index: 0, message: 'unknown op `bad`' }))
        return JSON.stringify({ refs: {}, results: [null], loaded: [] })
      },
    })
    await open(own.doc)
    const { answer } = await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }] })
    expect(answer.results).toEqual([null])
    expect(JSON.parse(requests[0])).toEqual({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Two' }] })
    const failed = await batch({ ops: [{ op: 'bad' }] }).catch((error: unknown) => error)
    expect((failed as KitModelError).data).toEqual({ code: 'invalid-op', index: 0, message: 'unknown op `bad`' })
    await open(own.doc, true)
    const refused = await batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Three' }] }).catch((error: unknown) => error)
    expect((refused as KitModelError).data.code).toBe('read-only')
    expect(requests).toHaveLength(2)
  })
})

describe("an agent's draft merged in the kit", () => {
  let current: ReturnType<typeof makeEngine>
  beforeEach(async () => {
    current = makeEngine({})
    await open(current.doc)
  })

  /** A draft of the engine's document: a fork the agent edits, and its changes since the fork. */
  function drafted(edit: (draft: Replica) => void) {
    const base = current.replica.version()
    const draft = current.replica.fork(42n)
    edit(draft)
    return () => draft.exportChanges(base).slice().buffer as ArrayBuffer
  }
  const origin = { kind: 'agent', principal: 'user:a', label: "Merged the agent's draft" } as const
  const merge = async (changes: ArrayBuffer) => (await call({ method: 'replicaMerge', changes, blobs: new ArrayBuffer(0), origin, schema })) as { summary: { created: unknown[]; changed: Array<{ id: string; fields: string[] }> }; info: KitEngineInfo }

  it('compares, merges as one undo step, and keeps the person\'s edits made meanwhile', async () => {
    const changes = drafted((draft) => {
      draft.transact(person('user:a'), (tx) => {
        const id = tx.create('Shape', { kind: 'rect', x: 1, y: 2, fill: 'blue' }, { id: 'drafted' })
        tx.listInsert('page', 'shapes', 0, id)
      })
      draft.transact(person('user:a'), (tx) => tx.set('page', 'title', 'Drafted'))
    })
    // The person edits the live document while the agent works on its draft.
    await execute('page.rename', { title: 'Person' })
    const compared = (await call({ method: 'replicaCompare', changes: changes(), schema })) as { created: Array<{ id: string }> }
    expect(compared.created.map((object) => object.id)).toEqual(['drafted'])
    expect(seen(current.replica)).toEqual({ title: 'Person', shapes: [] })

    const { summary, info } = await merge(changes())
    expect(summary.created).toHaveLength(1)
    expect(summary.changed.find((object) => object.id === 'page')?.fields).toEqual(['shapes', 'title'])
    expect(seen(current.replica)).toEqual({ title: 'Drafted', shapes: ['blue'] })
    expect(info.canUndo).toBe(true)

    // Undo takes the whole merge back, then the person's own rename; Redo brings the merge back.
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'Person', shapes: [] })
    await execute('edit.undo')
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })
    await execute('edit.redo')
    await execute('edit.redo')
    expect(seen(current.replica)).toEqual({ title: 'Drafted', shapes: ['blue'] })
  })

  it('refuses a merge without the schema, of another document, and on a read-only document', async () => {
    const changes = drafted((draft) => draft.transact(person('user:a'), (tx) => tx.set('page', 'title', 'Drafted')))
    await expect(call({ method: 'replicaMerge', changes: changes(), blobs: new ArrayBuffer(0), origin, schema: null })).rejects.toBeInstanceOf(KitModelError)
    const other = Replica.create(parseSchema(schemaText), '01920000-0000-7000-8000-0000000000ee', 3n)
    await expect(merge(other.exportChanges().slice().buffer as ArrayBuffer)).rejects.toMatchObject({ data: { code: 'invalid-value' } })
    expect(seen(current.replica)).toEqual({ title: 'One', shapes: [] })
    await open(current.doc, true)
    await expect(merge(changes())).rejects.toThrow(/read-only/)
  })
})
