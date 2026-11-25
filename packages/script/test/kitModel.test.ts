/// <reference types="node" />
/**
 * A kit that answers the object model itself (the Kit UI capability `model`): `openDocument`
 * sends each batch to it, tells its own change from the kit's, and passes the kit's refusals on as
 * `BatchError`s. A kit without `model` is refused.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BatchError, parseSchema, type BatchRequest } from '@kition/kdm'
import { describe, expect, it } from 'vitest'
import { openDocument, type ModelObject } from '../src/index'
import { FakeKitModel } from './fakeKitModel'

const schemaText = readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/test-schema.json', import.meta.url)), 'utf8')
const schema = JSON.parse(schemaText) as object

interface Page extends ModelObject {
  title: string
}

/** A kit frame whose editor runs batches on its document (one undo step each) and tells of every change. */
function kitFrame(capabilities = ['ai', 'replica', 'model']) {
  const replica = new FakeKitModel(parseSchema(schemaText), 'page', { title: 'One' })
  const listeners = new Set<(version: ArrayBuffer) => void>()
  // The editor tells the host of the change, here before it answers the batch.
  replica.onChanged((version) => {
    for (const listener of listeners) listener(version.slice().buffer)
  })
  const batches: Array<Record<string, unknown>> = []
  const connection = {
    kit: { id: 'kit.test' },
    capabilities,
    ai: { commands: async () => [] },
    replica: { onChanged: (listener: (version: ArrayBuffer) => void) => (listeners.add(listener), () => listeners.delete(listener)) },
    model: {
      describe: async (sent?: object) => ({ ...replica.describe(), sent: sent !== undefined }),
      batch: async (params: Record<string, unknown>) => {
        batches.push(params)
        const { schema: sent, ...request } = params
        expect(sent).toEqual(schema)
        try {
          const result = await replica.batch(request as BatchRequest)
          return { ...result, version: replica.version().slice().buffer }
        } catch (error) {
          if (error instanceof BatchError) throw Object.assign(new Error(error.message), { code: -32000, data: { code: error.code, index: error.index, message: error.message } })
          throw error
        }
      },
    },
  }
  /** An edit a person makes in the editor. */
  const personEdit = (title: string) => replica.edit((kit) => kit.set('page', 'title', title))
  return { connection, replica, batches, personEdit }
}

describe('a kit that answers the object model', () => {
  it('runs each sync as one batch in the kit, one undo step there', async () => {
    const kit = kitFrame()
    const doc = await openDocument<Page>(kit.connection, { schema })
    const events: string[] = []
    doc.on('changed', (event) => events.push(event.origin))
    await doc.run(async (context) => {
      context.root.title = 'Two'
      context.root.title = 'Three'
    })
    expect(kit.replica.get('page', 'title')).toBe('Three')
    expect(kit.batches).toHaveLength(1)
    // The kit's own announcement of this handle's batch is not news; a person's edit is.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['local'])
    kit.personEdit('Edited')
    expect(events).toEqual(['local', 'kit'])
    // The batch is one step of the kit's history, after the person's edit.
    kit.replica.undo()
    expect(kit.replica.get('page', 'title')).toBe('Three')
    kit.replica.undo()
    expect(kit.replica.get('page', 'title')).toBe('One')
    expect(await doc.describe()).toMatchObject({ root: 'Page', rootId: 'page', sent: true })
  })

  it("passes the kit's refusals on as BatchErrors", async () => {
    const doc = await openDocument<Page>(kitFrame().connection, { schema })
    const failed = await doc.batch({ ops: [{ op: 'set', target: 'nowhere', field: 'title', value: 'x' }] }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(BatchError)
    expect(failed).toMatchObject({ code: 'not-found', index: 0 })
  })

  it('needs no replica capability when the kit answers it, and refuses a kit that does not', async () => {
    const own = kitFrame(['ai', 'model'])
    const doc = await openDocument<Page>(own.connection, { schema })
    await doc.batch({ ops: [{ op: 'set', target: 'root', field: 'title', value: 'Mine' }] })
    expect(own.replica.get('page', 'title')).toBe('Mine')
    const plain = kitFrame(['ai', 'replica'])
    await expect(openDocument<Page>(plain.connection, { schema })).rejects.toThrow(/model capability/)
    expect(plain.batches).toHaveLength(0)
  })
})
