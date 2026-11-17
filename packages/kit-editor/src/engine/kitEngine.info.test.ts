// @vitest-environment jsdom
/**
 * The engine worker's `info` after `execute`, driven through its `handle` with a fake kit module
 * document: unchanged answers send `info: null`, while selection, drafting modes and prompts
 * refresh even when the document revision stays unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const manifest = { kitId: 'kit.test', module: 'test', documentClass: 'TestDocument' } as KitModuleManifest

function fakeDocument() {
  const state = { revision: 0, height: 100, inspects: 0, selection: 0, polar: false, prompt: 'Command:' }
  const doc = {
    width: 10,
    get height() {
      return state.height
    },
    get revision() {
      return BigInt(state.revision)
    },
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string) => {
      if (command === 'text.insert') state.revision += 1
      if (command === 'selectall') state.selection = 7
      if (command === 'polar') state.polar = !state.polar
      if (command === 'commandLine') state.prompt = 'LINE Specify first point:'
      return '{}'
    },
    inspect: () => {
      state.inspects += 1
      return JSON.stringify({ outline: state.revision, selection: state.selection, polar: state.polar, prompt: state.prompt })
    },
    commands: () => JSON.stringify([{ id: 'text.insert', mutates: true }, { id: 'code.blocks', mutates: false }].map((item) => ({ ...item, title: item.id, menu: [], shortcut: null, enabled: true }))),
    save: () => new Uint8Array([1]),
    markSaved: () => undefined,
    free: () => undefined,
    pointer: () => { state.selection = 1; return '{}' },
    toolKey: () => { state.selection = 0; return '{}' },
  }
  return { doc, state }
}

async function open() {
  const made = fakeDocument()
  fake.doc = made.doc
  await handle({ method: 'open', manifest, name: 'a.md', bytes: new ArrayBuffer(1), lent: null, replica: null })
  return made.state
}

const execute = async (command: string) => (await handle({ method: 'execute', command, params: {} })).value as { info: { inspected: unknown; height: number } | null }

describe('the engine worker\'s info after execute', () => {
  it('commands with unchanged inspection still answer no duplicate info', async () => {
    const state = await open()
    const opened = state.inspects
    expect((await execute('code.blocks')).info).toBeNull()
    expect((await execute('code.blocks')).info).toBeNull()
    expect(state.inspects).toBe(opened + 2)
  })

  it('an edit makes it again, once', async () => {
    const state = await open()
    const edited = await execute('text.insert')
    expect(edited.info?.inspected).toMatchObject({ outline: 1 })
    const after = state.inspects
    expect((await execute('code.blocks')).info).toBeNull()
    expect(state.inspects).toBe(after + 1)
  })

  it('a new height (a layout guessed then laid out) makes it again', async () => {
    const state = await open()
    await execute('code.blocks')
    state.height = 140
    expect((await execute('code.blocks')).info?.height).toBe(140)
  })

  it('another document starts afresh', async () => {
    await open()
    await execute('code.blocks')
    const second = await open()
    const opened = second.inspects
    expect(opened).toBeGreaterThan(0)
    expect((await execute('code.blocks')).info).toBeNull()
  })

  it('selection and drafting commands refresh without a document edit', async () => {
    const state = await open()
    expect((await execute('selectall')).info?.inspected).toMatchObject({ selection: 7 })
    expect((await execute('polar')).info?.inspected).toMatchObject({ polar: true })
    expect(state.revision).toBe(0)
  })

  it('starting a command refreshes its prompt before geometry exists', async () => {
    const state = await open()
    expect((await execute('commandLine')).info?.inspected).toMatchObject({ prompt: 'LINE Specify first point:' })
    expect(state.revision).toBe(0)
  })

  it('an explicit refresh sees transient state changed outside execute', async () => {
    const state = await open()
    state.selection = 3
    const refreshed = await handle({ method: 'info' })
    expect((refreshed.value as { inspected: unknown }).inspected).toMatchObject({ selection: 3 })
    expect(state.revision).toBe(0)
  })

  it('settled tool events refresh selection while movement skips inspection', async () => {
    const state = await open()
    const before = state.inspects
    const move = await handle({ method: 'tool', name: 'pointer', args: [], settled: false })
    expect((move.value as { info: unknown }).info).toBeNull()
    expect(state.inspects).toBe(before)
    const up = await handle({ method: 'tool', name: 'pointer', args: [], settled: true })
    expect((up.value as { info: { inspected: unknown } }).info.inspected).toMatchObject({ selection: 1 })
    const escape = await handle({ method: 'tool', name: 'toolKey', args: [], settled: true })
    expect((escape.value as { info: { inspected: unknown } }).info.inspected).toMatchObject({ selection: 0 })
    expect(state.revision).toBe(0)
  })
})
