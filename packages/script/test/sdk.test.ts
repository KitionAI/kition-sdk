/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSchema, type BatchRequest, type Origin } from '@kition/kdm'
import { describe, expect, it } from 'vitest'
import { FakeKitModel } from './fakeKitModel'
import { NotSyncedError, openDocument, PropertyNotLoadedError, portFromConnection, registerKit, type ModelList, type ModelObject, type ModelPort, type ModelText, type ModelTree } from '../src/index'

const schemaText = readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/test-schema.json', import.meta.url)), 'utf8')
const schema = parseSchema(schemaText)

interface Shape extends ModelObject {
  kind: 'rect' | 'ellipse'
  x: number
  y: number
  fill: string | null
  get label(): ModelText
  set label(value: string)
}
interface Page extends ModelObject {
  title: string
  readonly shapes: ModelList<Shape, { kind: 'rect' | 'ellipse'; x: number; y: number; fill?: string | null }>
  readonly outline: ModelTree<Shape, { kind: 'rect' | 'ellipse'; x: number; y: number; fill?: string | null }>
}
type Commands = { 'page.clear': Record<string, never>; 'shape.paint': { shape: string | Shape; fill: string } }

/** A kit engine stand-in that answers the object model itself, with two commands. */
function fakeEngine(readOnly = false) {
  const ran: Array<{ id: string; params: unknown; origin: Origin }> = []
  const commands = [{ id: 'shape.paint', title: 'Paint', mutates: true, enabled: true }]
  const replica = new FakeKitModel(schema, 'page', { title: 'One' }, {
    readOnly,
    commands,
    command: (id, params, origin, kit) => {
      ran.push({ id, params, origin })
      if (id === 'shape.paint') {
        const { shape, fill } = params as { shape: string; fill: string }
        kit.set(shape, 'fill', fill)
        return { painted: shape }
      }
      throw new Error(`unknown command \`${id}\``)
    },
  })
  const port: ModelPort = {
    kitId: 'kit.test',
    commands: async () => commands,
    onChanged: (listener) => replica.onChanged(listener),
    model: {
      describe: async () => replica.describe(),
      batch: async (request) => ({ ...(await replica.batch(request)), version: replica.version() }),
    },
  }
  /** An edit a person makes in the editor. */
  const personEdit = (title: string) => replica.edit((kit) => kit.set('page', 'title', title))
  return { replica, port, ran, personEdit }
}

/** A kit frame (Kit UI protocol) whose kit answers the object model (capability `model`). */
function kitConnection(engine: ReturnType<typeof fakeEngine>, capabilities = ['ai', 'replica', 'model']) {
  return {
    kit: { id: 'kit.test' },
    capabilities,
    ai: { commands: async () => [{ id: 'shape.paint', title: 'Paint', enabled: true }] },
    replica: { onChanged: () => () => undefined },
    model: {
      describe: async () => engine.replica.describe(),
      batch: async (params: Record<string, unknown>) => {
        const { schema: _, ...request } = params
        const result = await engine.replica.batch(request as BatchRequest)
        return { ...result, version: engine.replica.version().slice().buffer as ArrayBuffer }
      },
    },
  }
}

describe('@kition/script', () => {
  it('queues writes and reads on proxies and sends them as one batch per sync', async () => {
    const engine = fakeEngine()
    const doc = await openDocument<Page, Commands>(engine.port, { schema })
    const events: string[] = []
    doc.on('changed', (event) => events.push(event.origin))
    const answer = await doc.run(async (context) => {
      const shape = context.root.shapes.add({ kind: 'rect', x: 1.5, y: 2.5 })
      shape.label.insert(0, 'Hello')
      context.root.title = 'Two'
      const painted = context.commands.run('shape.paint', { shape, fill: '#5645d4' })
      expect(() => shape.id).toThrow(NotSyncedError)
      shape.load(['fill', 'label', 'x'])
      context.root.load(['shapes', 'title'])
      await context.sync()
      return { id: shape.id, fill: shape.fill, label: shape.label.toString(), x: shape.x, painted: painted.value, title: context.root.title, count: context.root.shapes.length }
    })
    expect(answer).toMatchObject({ fill: '#5645d4', label: 'Hello', x: 1.5, title: 'Two', count: 1 })
    expect(answer.painted).toEqual({ painted: answer.id })
    // The engine holds the edits; the command ran with the new shape's id and the script's origin.
    expect(engine.replica.text(answer.id, 'label')).toBe('Hello')
    expect(engine.replica.get('page', 'title')).toBe('Two')
    expect(engine.ran[0]).toMatchObject({ params: { shape: answer.id }, origin: { kind: 'extension', principal: 'script' } })
    expect(events).toContain('local')
    expect(events).not.toContain('kit')
  })

  it('builds, moves, and reads a tree field', async () => {
    const engine = fakeEngine()
    const doc = await openDocument<Page>(engine.port, { schema })
    const ids = await doc.run(async (context) => {
      const outline = context.root.outline
      const group = outline.add({ kind: 'rect', x: 0, y: 0 })
      const child = outline.add({ kind: 'ellipse', x: 1, y: 1 }, { parent: group })
      const loose = context.root.shapes.add({ kind: 'rect', x: 2, y: 2 })
      outline.insert(loose)
      await context.sync()
      outline.move(loose, group)
      outline.move(child, null)
      outline.load()
      await context.sync()
      expect(outline.nodes.map((node) => [node.object.id, node.parent?.id ?? null])).toEqual([
        [group.id, null],
        [loose.id, group.id],
        [child.id, null],
      ])
      expect(outline.children().map((shape) => shape.id)).toEqual([group.id, child.id])
      expect(outline.children(group).map((shape) => shape.id)).toEqual([loose.id])
      return { group: group.id, loose: loose.id }
    })
    // An object with children in the tree is not deleted.
    const refused = await doc.run((context) => context.object(ids.group, 'Shape').delete()).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'invalid-value' })
    expect(engine.replica.tree('page', 'outline').map((entry) => entry.object)).toHaveLength(3)
  })

  it("passes on the events its source reports, and only those", async () => {
    const engine = fakeEngine()
    const hearers = new Map<string, Set<(value: unknown) => void>>()
    const port: ModelPort = {
      ...engine.port,
      events: ['saved', 'selection'],
      on: (event, listener) => {
        const set = hearers.get(event) ?? new Set()
        hearers.set(event, set)
        set.add(listener as (value: unknown) => void)
        return () => set.delete(listener as (value: unknown) => void)
      },
    }
    const doc = await openDocument<Page>(port, { schema })
    expect(doc.supports('changed')).toBe(true)
    expect(doc.supports('saved')).toBe(true)
    expect(doc.supports('conflict')).toBe(false)
    const heard: unknown[] = []
    doc.on('saved', (event) => heard.push(['saved', event.version]))
    const off = doc.on('selection', (event) => heard.push(['selection', event.ids]))
    // An event the source does not report is never heard; an unknown one is an error.
    doc.on('conflict', () => heard.push('never'))
    expect(() => doc.on('nonsense' as 'saved', () => undefined)).toThrow(/unknown event/)
    const fire = (event: string, value: unknown) => hearers.get(event)?.forEach((listener) => listener(value))
    fire('saved', { version: 'v2' })
    fire('selection', { ids: ['page'] })
    off()
    fire('selection', { ids: [] })
    expect(heard).toEqual([['saved', 'v2'], ['selection', ['page']]])
    doc.close()
    expect([...hearers.values()].every((set) => set.size === 0)).toBe(true)
  })

  it('reads only what was loaded, follows edits made in the editor, and reports them', async () => {
    const engine = fakeEngine()
    const doc = await openDocument<Page>(engine.port, { schema })
    const events: string[] = []
    doc.on('changed', (event) => events.push(event.origin))
    const context = doc.context()
    expect(() => context.root.title).toThrow(PropertyNotLoadedError)
    context.root.load(['title'])
    await context.sync()
    expect(context.root.title).toBe('One')
    engine.personEdit('Edited')
    expect(events).toEqual(['kit'])
    context.root.load(['title'])
    await context.sync()
    expect(context.root.title).toBe('Edited')
  })

  it('runs raw batches, describes the kit, and refuses writes to a read-only document', async () => {
    const engine = fakeEngine(true)
    registerKit({ id: 'kit.test', schema: JSON.parse(schemaText) })
    const doc = await openDocument(engine.port)
    const described = await doc.describe()
    expect(described).toMatchObject({ kit: 'kit.test', rootId: 'page', commands: [{ id: 'shape.paint' }] })
    expect(await doc.commands.enabled('shape.paint')).toBe(true)
    await expect(doc.batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'x' }] })).rejects.toMatchObject({ code: 'read-only' })
    const read = await doc.batch({ load: [{ target: 'root', fields: ['title'] }] })
    expect(read.loaded[0].fields.title).toBe('One')
  })

  it('reaches a kit frame through its model capability', async () => {
    const engine = fakeEngine()
    const connection = kitConnection(engine)
    const doc = await openDocument<Page, Commands>(connection, { schema })
    expect(await doc.commands.list()).toEqual([{ id: 'shape.paint', title: 'Paint', enabled: true }])
    const result = await doc.commands.run('shape.paint', { shape: 'page', fill: '#000' })
    expect(result).toEqual({ painted: 'page' })
    expect(engine.ran).toMatchObject([{ id: 'shape.paint', params: { shape: 'page', fill: '#000' } }])
    await doc.run(async (context) => {
      context.root.title = 'Framed'
    })
    expect(engine.replica.get('page', 'title')).toBe('Framed')
    expect(() => portFromConnection({ ...connection, capabilities: ['ai', 'replica'] })).toThrow(/model capability/)
    expect(doc.supports('selection')).toBe(false)
  })

  it('fires selection from the kit frame\'s presence (Kit UI protocol section 7e)', async () => {
    const engine = fakeEngine()
    const listeners = new Set<(presence: { selection: string[] }) => void>()
    const connection = {
      ...kitConnection(engine),
      onPresence: (listener: (presence: { selection: string[] }) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const doc = await openDocument<Page, Commands>(connection, { schema })
    expect(doc.supports('selection')).toBe(true)
    expect(doc.supports('saved')).toBe(false)
    const heard: string[][] = []
    const off = doc.on('selection', (event) => heard.push(event.ids))
    for (const listener of listeners) listener({ selection: ['page'] })
    off()
    for (const listener of listeners) listener({ selection: [] })
    expect(heard).toEqual([['page']])
    expect(listeners.size).toBe(0)
  })
})
