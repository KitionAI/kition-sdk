/// <reference types="node" />
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { BatchError, parseSchema, type BatchRequest, type Origin } from '@kition/kdm'
import { afterEach, describe, expect, it } from 'vitest'
import { KitProtocolConnection, KitProtocolError, KitsService, openHeadless } from '../src/node'
import type { ModelList, ModelObject, ModelText } from '../src/index'
import { FakeKitModel } from './fakeKitModel'

const schema = parseSchema(readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/test-schema.json', import.meta.url)), 'utf8'))
const fakeKits = fileURLToPath(new URL('./fixtures/fake-kits.mjs', import.meta.url))

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
  readonly shapes: ModelList<Shape, { kind: 'rect' | 'ellipse'; x: number; y: number }>
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kition-sdk-headless-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * `kition-kits serve` in this process: one document in one kit, its object model answered by a
 * test kit's document, errors in the service's shape, over a pair of streams.
 */
async function fakeService() {
  const dir = scratchDir()
  const ran: Array<{ id: string; origin: Origin }> = []
  const replica = new FakeKitModel(schema, 'page', { title: 'One' }, {
    commands: [{ id: 'page.clear', title: 'Clear', mutates: true, enabled: true }],
    command: (id, _params, origin, kit) => {
      ran.push({ id, origin })
      kit.set('page', 'title', '')
      return { cleared: true }
    },
  })
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let dirty = false
  let conflict = false
  let path = ''
  const state = () => ({ kitId: 'kit.test', documentId: '7', path, title: 'Page', format: 'test', readOnly: false, dirty, canUndo: false, canRedo: false, conflict, version: 0, summary: '', details: {} })
  const handle = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params })
    if (method === 'kits.initialize') return { serviceVersion: 1, protocolVersion: 1, workspace: true, kits: [{ id: 'kit.test', name: 'Test', extensions: ['test'], creates: [], installed: true }] }
    if (method === 'documents.open' || method === 'documents.create') {
      path = params.path as string
      return state()
    }
    if (params.kit !== 'kit.test') throw { code: -32602, message: 'unknown kit', data: { reason: 'unknown_kit' } }
    if (params.documentId !== '7') throw { code: -32010, message: 'document not found', data: { reason: 'document_not_found' } }
    switch (method) {
      case 'documents.get':
        return state()
      case 'commands.list':
        return { commands: [{ id: 'page.clear', title: 'Clear', group: 'page', params: {}, mutates: true, enabled: true }] }
      case 'commands.execute':
        dirty = true
        return { changed: true, result: { origin: params.origin }, document: state() }
      case 'model.describe':
        return replica.describe()
      case 'model.batch': {
        const { kit: _, documentId: __, ...request } = params
        try {
          const answer = await replica.batch(request as BatchRequest)
          if (((request.ops as unknown[] | undefined)?.length ?? 0) > 0) dirty = true
          return answer
        } catch (error) {
          if (!(error instanceof BatchError)) throw error
          throw { code: -32022, message: 'invalid command parameters', data: { reason: 'invalid_params', detail: error.message, model: { code: error.code, index: error.index, message: error.message } } }
        }
      }
      case 'documents.reload':
        conflict = false
        dirty = false
        return state()
      case 'documents.save':
        if (conflict) throw { code: -32015, message: 'the file changed since it was read', data: { reason: 'file_conflict' } }
        dirty = false
        return state()
      case 'documents.saveAs':
        path = params.path as string
        dirty = false
        return state()
      default:
        throw { code: -32601, message: `method not found: ${method}` }
    }
  }
  const toService = new PassThrough()
  const fromService = new PassThrough()
  let buffer = ''
  toService.setEncoding('utf8')
  toService.on('data', async (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const { id, method, params } = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown> }
      buffer = buffer.slice(end + 1)
      try {
        fromService.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: await handle(method, params) })}\n`)
      } catch (error) {
        fromService.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`)
      }
    }
  })
  const open = async () => {
    const connection = new KitProtocolConnection(fromService, toService)
    cleanups.push(() => connection.close())
    return KitsService.connect(connection, dir)
  }
  return { dir, replica, ran, calls, open, conflictNext: () => (conflict = true) }
}

describe('@kition/script/node headless kits (kition-kits serve)', () => {
  it('scripts a document through the kit’s own model.describe and model.batch', async () => {
    const fake = await fakeService()
    const service = await fake.open()
    expect(service.kits.map((kit) => kit.id)).toEqual(['kit.test'])
    const file = await service.open(join(fake.dir, 'pages', 'page.test'))
    expect(fake.calls.at(-1)).toEqual({ method: 'documents.open', params: { path: 'pages/page.test' } })
    expect(file.state).toMatchObject({ documentId: '7', dirty: false, path: 'pages/page.test' })
    // No registered schema: the handle takes the kit's (`model.describe`).
    const doc = await file.model<Page>({ origin: { kind: 'extension', principal: 'test:headless' } })
    const events: string[] = []
    doc.on('changed', (event) => events.push(event.origin))
    const answer = await doc.run(async (context) => {
      const shape = context.root.shapes.add({ kind: 'ellipse', x: 3, y: 4 })
      shape.label = 'Hi'
      context.root.title = 'Two'
      context.commands.run('page.clear', {})
      context.root.load(['title', 'shapes'])
      shape.load(['label', 'x'])
      await context.sync()
      return { id: shape.id, label: shape.label.toString(), x: shape.x, title: context.root.title, count: context.root.shapes.length }
    })
    expect(answer).toMatchObject({ label: 'Hi', x: 3, title: '', count: 1 })
    expect(fake.replica.text(answer.id, 'label')).toBe('Hi')
    expect(fake.ran).toEqual([{ id: 'page.clear', origin: { kind: 'extension', principal: 'test:headless' } }])
    expect(events).toEqual(['local'])
    expect(file.state.dirty).toBe(true)
    expect(await doc.commands.enabled('page.clear')).toBe(true)
    expect(await doc.describe()).toMatchObject({ kit: 'kit.test', rootId: 'page', commands: [{ id: 'page.clear' }] })
    const saved: unknown[] = []
    doc.on('saved', (event) => saved.push(event))
    await file.save()
    expect(file.state.dirty).toBe(false)
    expect(saved).toEqual([{ version: null, uri: 'pages/page.test' }])
    // The host acting for the person: a command as `system`.
    expect(await file.execute('page.clear', {}, 'system')).toEqual({ origin: 'system' })
    await file.execute('page.clear', {}, 'system', 'emailsync')
    expect(fake.calls.at(-1)).toMatchObject({ method: 'commands.execute', params: { origin: 'system', originLabel: 'emailsync' } })
    await file.saveAs(join(fake.dir, 'copy.test'))
    expect(fake.calls.at(-1)).toMatchObject({ method: 'documents.saveAs', params: { path: 'copy.test' } })
  })

  it('answers object-model errors as BatchError, others as KitProtocolError, and a conflict as an event', async () => {
    const fake = await fakeService()
    const service = await fake.open()
    const file = await service.open('page.test')
    const doc = await file.model()
    const missing = await doc.batch({ ops: [], load: [{ target: 'nope' }] }).catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(BatchError)
    expect(missing).toMatchObject({ code: 'not-found' })
    expect((await doc.batch({ load: [{ target: 'root', fields: ['title'] }] })).loaded[0].fields.title).toBe('One')
    const error = await service.connection.request('documents.save', { kit: 'kit.test', documentId: '8' }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(KitProtocolError)
    expect((error as KitProtocolError).reason).toBe('document_not_found')
    const conflicts: unknown[] = []
    doc.on('conflict', (event) => conflicts.push(event))
    fake.conflictNext()
    await expect(file.save()).rejects.toMatchObject({ name: 'KitProtocolError', reason: 'file_conflict' })
    expect(conflicts).toHaveLength(1)
    expect((await file.refresh()).conflict).toBe(true)
    await file.reload()
    expect(file.state).toMatchObject({ conflict: false, dirty: false })
  })

  it('starts kition-kits serve on a workspace, opens a new file, and shuts it down', async () => {
    const root = scratchDir()
    const service = await KitsService.launch({ workspace: root, kits: ['/kits/kition-fake'], executable: fakeKits })
    expect(service.kits).toEqual([{ id: 'kit.fake', name: 'Fake', extensions: ['fake'], creates: ['fake'], installed: true, from: ['/kits/kition-fake'] }])
    const file = await service.create(join(root, 'a.fake'))
    expect(file.state.path).toBe('a.fake')
    const described = await (await file.model()).describe()
    expect(described).toMatchObject({ root: 'Presentation', rootId: 'slide' })
    await service.shutdown()
    await expect(service.connection.request('kits.ping')).rejects.toThrow()

    const opened = await openHeadless('/kits/kition-fake', join(root, 'b.fake'), { executable: fakeKits })
    expect(opened.state.path).toBe('b.fake')
    await opened.shutdown()
    expect(existsSync(join(root, 'b.fake'))).toBe(false)
  })

  it('reports a service that exits before it answers', async () => {
    const root = scratchDir()
    await expect(KitsService.launch({ workspace: root, executable: fakeKits, env: { FAKE_KITS_EXIT: '3' } })).rejects.toThrow(/exited \(3\) before it answered/)
  })
})
