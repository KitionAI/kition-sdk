// @vitest-environment jsdom
/**
 * An agent's reply (`ai/inspect`, `document/check`, `ai/run`) names objects as the tool interface
 * does (KitObjectModel OM9): the worker hands it to the engine's `modelReply`, which translates
 * object ids to tool ids. Only the reply changes; the editor and the engine keep native ids. An
 * engine without `modelReply`, or one that fails on it, answers the reply as it is: a reply never
 * fails for want of tool ids.
 */
import { expect, it, vi } from 'vitest'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

/** An engine whose one object is `raw-item` natively and `item:7` at the tool interface. */
function engine(members: Partial<KitModuleDocument> = {}) {
  const asked: string[] = []
  const doc: KitModuleDocument = {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: () => '{}',
    inspect: () => JSON.stringify({ selection: ['raw-item'] }),
    commands: () => '[]',
    save: () => new Uint8Array(),
    markSaved: () => undefined,
    free: () => undefined,
    modelReply: (value) => {
      asked.push(value)
      return value.replace(/"raw-item"/g, '"item:7"')
    },
    ...members,
  }
  fake.doc = doc
  return { doc, asked }
}

const manifest = { kitId: 'kit.mock' } as KitModuleManifest
const open = () => handle({ method: 'open', manifest, name: 'a.mock', bytes: new ArrayBuffer(1), lent: null })
const reply = (value: unknown) => handle({ method: 'modelReply', value })

it('translates only agent replies and keeps the editor in native ids', async () => {
  const { asked } = engine()
  const opened = (await open()).value as { inspected: unknown }
  const value = { details: { 'raw-item': ['raw-item'] }, diagnostics: [{ target: { object: 'raw-item' } }], literal: 'text raw-item' }
  expect((await reply(value)).value).toEqual({ details: { 'item:7': ['item:7'] }, diagnostics: [{ target: { object: 'item:7' } }], literal: 'text raw-item' })
  expect(asked).toEqual([JSON.stringify(value)])
  // The editor's own view of the document keeps the native ids.
  expect(opened.inspected).toEqual({ selection: ['raw-item'] })
  expect(((await handle({ method: 'info' })).value as { inspected: unknown }).inspected).toEqual({ selection: ['raw-item'] })
})

it('answers the reply as it is when the engine has no modelReply or fails on it', async () => {
  engine({ modelReply: undefined })
  await open()
  expect((await reply({ target: 'raw-item' })).value).toEqual({ target: 'raw-item' })
  engine({
    modelReply: () => {
      throw new Error('the reply is not JSON')
    },
  })
  await open()
  expect((await reply({ target: 'raw-item' })).value).toEqual({ target: 'raw-item' })
})
