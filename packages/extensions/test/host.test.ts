/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseSchema, type Origin } from '@kition/kdm'
import type { ModelPort } from '@kition/script'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionHost, RpcPeer, type ExtensionNotice, type SandboxFactory } from '../src/index'
import { startRuntime } from '../src/runtime/index'
import { FakeKitModel } from '../../script/test/fakeKitModel'

const schema = parseSchema(readFileSync(fileURLToPath(new URL('../../../crates/kition-kdm/tests/fixtures/test-schema.json', import.meta.url)), 'utf8'))

/** A kit engine stand-in (the test schema: a page with a title and shapes) that answers the object model, with two commands. */
function fakeKit(options: { readOnly?: boolean } = {}) {
  const ran: Array<{ id: string; origin: Origin }> = []
  const commands = [
    { id: 'page.shout', title: 'Shout', mutates: true, enabled: true },
    { id: 'page.count', title: 'Count', mutates: false, enabled: true },
  ]
  const replica = new FakeKitModel(schema, 'page', { title: 'quarterly review' }, {
    readOnly: options.readOnly,
    commands,
    command: (id, _params, origin, kit) => {
      ran.push({ id, origin })
      if (id === 'page.shout') {
        kit.set('page', 'title', String(kit.get('page', 'title')).toUpperCase())
        return { shouted: true }
      }
      if (id === 'page.count') return { shapes: kit.list('page', 'shapes').length }
      throw new Error(`unknown command \`${id}\``)
    },
  })
  // Every batch that wrote to the document.
  const writes: number[] = []
  const port: ModelPort = {
    kitId: 'kit.test',
    commands: async () => commands,
    onChanged: (listener) => replica.onChanged(listener),
    model: {
      describe: async () => replica.describe(),
      batch: async (request) => {
        const before = replica.version()[3]
        const result = await replica.batch(request)
        if (replica.version()[3] !== before) writes.push(request.ops?.length ?? 0)
        return { ...result, version: replica.version() }
      },
    },
  }
  /** A person's edit in the editor. */
  const personEdit = (title: string) => replica.edit((kit) => kit.set('page', 'title', title))
  return { replica, port, ran, writes, personEdit, title: () => replica.get('page', 'title') }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Sandboxes in this process: a MessageChannel, with the runtime on its other end. */
function inProcessSandboxes() {
  const started: Array<{ id: string; connect: string; disposed: boolean }> = []
  const factory: SandboxFactory = async ({ id, connect }) => {
    const channel = new MessageChannel()
    const record = { id, connect, disposed: false }
    started.push(record)
    const peer = startRuntime(channel.port2, async (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
    const dispose = () => {
      record.disposed = true
      peer.close()
      channel.port1.close()
    }
    cleanups.push(dispose)
    return { port: channel.port1, dispose }
  }
  return { factory, started }
}

function makeHost() {
  const sandboxes = inProcessSandboxes()
  const notices: ExtensionNotice[] = []
  const host = new ExtensionHost({ sandbox: sandboxes.factory, schema: (kit) => (kit === 'kit.test' ? schema : undefined), notify: (notice) => notices.push(notice) })
  cleanups.push(() => host.dispose())
  return { host, notices, started: sandboxes.started }
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  kitExtensions: '1.0',
  id: 'com.example.titles',
  name: 'Titles',
  version: '1.0.0',
  entry: 'extension.mjs',
  activation: { kits: ['kit.test'] },
  contributes: {
    commands: [
      { id: 'titles.capitalize', title: 'Capitalize the title' },
      { id: 'titles.shout', title: 'Shout' },
      { id: 'titles.count', title: 'Count' },
      { id: 'titles.forge', title: 'Forge' },
    ],
  },
  permissions: ['model.read', 'model.write'],
  ...overrides,
})

/** The extension under test: four commands over the object model. */
const SOURCE = `
export function activate(ctx) {
  ctx.commands.register('titles.capitalize', async () => {
    return ctx.document.run(async (context) => {
      context.root.load(['title'])
      await context.sync()
      const title = context.root.title
      context.root.title = title.replace(/\\b\\w/g, (letter) => letter.toUpperCase())
      context.root.load(['title'])
      await context.sync()
      return context.root.title
    })
  })
  ctx.commands.register('titles.shout', () => ctx.document.commands.run('page.shout'))
  ctx.commands.register('titles.count', () => ctx.document.commands.run('page.count'))
  ctx.commands.register('titles.forge', () =>
    ctx.document.batch({ origin: { kind: 'person', principal: 'user:a' }, ops: [{ op: 'command', id: 'page.shout' }] }))
  ctx.notify('Titles is ready', { level: 'info' })
  globalThis.__deactivated = false
  ctx.subscriptions.push(() => { globalThis.__deactivated = true })
}
`

describe('ExtensionHost', () => {
  it('runs a contributed command that edits the document through the object model', async () => {
    const { host, notices, started } = makeHost()
    const kit = fakeKit()
    host.load({ manifest: manifest(), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', path: 'slides/Slide.test', port: kit.port })
    expect(started).toHaveLength(0) // activation on the first command

    expect(host.commandsFor('Slide.test').map((command) => command.id)).toEqual(['titles.capitalize', 'titles.shout', 'titles.count', 'titles.forge'])
    expect(host.commandsFor('Slide.test')[0]).toMatchObject({ extension: 'com.example.titles', extensionName: 'Titles', title: 'Capitalize the title' })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')).resolves.toBe('Quarterly Review')
    expect(kit.title()).toBe('Quarterly Review')
    expect(kit.writes.length).toBeGreaterThan(0)
    expect(started).toEqual([{ id: 'com.example.titles', connect: "'none'", disposed: false }])
    expect(notices).toEqual([{ extension: 'com.example.titles', level: 'info', title: 'Titles is ready' }])
  })

  it('refuses writes to an extension without model.write, and leaves the document as it was', async () => {
    const { host } = makeHost()
    const kit = fakeKit()
    host.load({ manifest: manifest({ permissions: ['model.read'] }), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    const refused = host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')
    await expect(refused).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(refused).rejects.toThrow(/model\.write/)
    expect(kit.title()).toBe('quarterly review')
    expect(kit.writes).toEqual([])
  })

  it('needs commands.run for commands, and model.write too for a command that mutates', async () => {
    const { host } = makeHost()
    const kit = fakeKit()
    host.load({ manifest: manifest({ permissions: ['model.read'] }), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.count')).rejects.toMatchObject({ code: 'permission-denied', message: expect.stringMatching(/commands\.run/) })

    host.load({ manifest: manifest({ permissions: ['model.read', 'commands.run'] }), source: SOURCE })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.count')).resolves.toEqual({ shapes: 0 })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.shout')).rejects.toMatchObject({ code: 'permission-denied', message: expect.stringMatching(/model\.write/) })
    expect(kit.ran.map((run) => run.id)).toEqual(['page.count'])
    expect(kit.title()).toBe('quarterly review')
  })

  it('stamps every batch with the extension as its origin, whatever the extension claims', async () => {
    const { host } = makeHost()
    const kit = fakeKit()
    host.load({ manifest: manifest({ permissions: ['model.read', 'model.write', 'commands.run'] }), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    await host.runCommand('Slide.test', 'com.example.titles', 'titles.forge')
    expect(kit.ran).toEqual([{ id: 'page.shout', origin: { kind: 'extension', principal: 'ext:com.example.titles' } }])
    expect(kit.title()).toBe('QUARTERLY REVIEW')
  })

  it('answers read-only when the document refuses edits', async () => {
    const { host } = makeHost()
    const kit = fakeKit({ readOnly: true })
    host.load({ manifest: manifest(), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')).rejects.toMatchObject({ code: 'read-only' })
    expect(kit.title()).toBe('quarterly review')
  })

  it('refuses commands the manifest does not contribute', async () => {
    const { host, notices } = makeHost()
    const kit = fakeKit()
    const narrow = manifest({ contributes: { commands: [{ id: 'titles.capitalize', title: 'Capitalize the title' }] } })
    host.load({ manifest: narrow, source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')).rejects.toThrow(/does not contribute titles\.shout/)
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.shout')).rejects.toThrow(/contributes no command/)
    expect(notices).toEqual([])
  })

  it('activates on open, hears the document change, and deactivates when it closes', async () => {
    const { host, started } = makeHost()
    const kit = fakeKit()
    const source = `
      export function activate(ctx) {
        globalThis.__changes = []
        ctx.document.on('changed', (event) => globalThis.__changes.push(event.origin))
        ctx.commands.register('titles.capitalize', () => globalThis.__changes.slice())
        ctx.subscriptions.push(() => { globalThis.__closed = ctx.document.id })
      }
      export function deactivate(ctx) { globalThis.__deactivated = ctx.document.id }
    `
    host.load({ manifest: manifest({ activation: { kits: ['kit.test'], on: 'open' } }), source })
    const close = host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    await expect.poll(() => started.length).toBe(1)
    await host.activate('com.example.titles', 'Slide.test')
    kit.personEdit('Edited by a person')
    await expect.poll(() => host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')).toEqual(['kit'])
    close()
    await expect.poll(() => (globalThis as { __closed?: string }).__closed).toBe('Slide.test')
    expect((globalThis as { __deactivated?: string }).__deactivated).toBe('Slide.test')
  })

  it('only offers its commands to documents of its kits and formats', () => {
    const { host } = makeHost()
    host.load({ manifest: manifest({ activation: { kits: ['kit.test'], formats: ['test'] } }), source: SOURCE })
    host.openDocument({ id: 'a', kitId: 'kit.test', path: 'Slide.test', port: fakeKit().port })
    host.openDocument({ id: 'b', kitId: 'kit.test', path: 'Slide.other', port: fakeKit().port })
    host.openDocument({ id: 'c', kitId: 'kit.doc', path: 'Slide.test', port: fakeKit().port })
    expect(host.commandsFor('a')).toHaveLength(4)
    expect(host.commandsFor('b')).toEqual([])
    expect(host.commandsFor('c')).toEqual([])
  })

  it('stops the sandbox when an extension is unloaded', async () => {
    const { host, started } = makeHost()
    host.load({ manifest: manifest(), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: fakeKit().port })
    await host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')
    host.unload('com.example.titles')
    await expect.poll(() => started[0].disposed).toBe(true)
    expect(host.extensions()).toEqual([])
    expect(host.commandsFor('Slide.test')).toEqual([])
  })

  it('refuses an extension without activate, and reports why', async () => {
    const { host } = makeHost()
    host.load({ manifest: manifest(), source: 'export const nothing = 1' })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: fakeKit().port })
    await expect(host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')).rejects.toThrow(/exports no activate function/)
  })

  it('gives a sandbox only the network origins its manifest declares', async () => {
    const { host, started } = makeHost()
    host.load({ manifest: manifest({ permissions: ['model.read', 'network:api.example.com', 'network:http://localhost:8080'] }), source: SOURCE })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: fakeKit().port })
    await host.activate('com.example.titles', 'Slide.test')
    expect(started[0].connect).toBe('https://api.example.com wss://api.example.com http://localhost:8080')
  })

  it('runs a script once in a sandbox of its own, then stops it', async () => {
    const { host, started } = makeHost()
    const kit = fakeKit()
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    const script = `
      export default async function (ctx) {
        const added = await ctx.document.run(async (context) => {
          const shape = context.root.shapes.add({ kind: 'rect', x: 1, y: 2 })
          shape.label.insert(0, 'From a script')
          await context.sync()
          return shape.id
        })
        return { added, kit: ctx.document.kitId, readOnly: ctx.document.readOnly }
      }
    `
    const result = (await host.runScript({ source: script, name: 'add shape.mjs' }, 'Slide.test')) as { added: string; kit: string; readOnly: boolean }
    expect(result).toMatchObject({ kit: 'kit.test', readOnly: false })
    expect(kit.replica.list('page', 'shapes')).toEqual([result.added])
    expect(kit.replica.text(result.added, 'label')).toBe('From a script')
    expect(started).toHaveLength(1)
    expect(started[0].disposed).toBe(true)
    await expect(host.runScript({ source: script }, 'Slide.test', ['model.read'])).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(host.runScript({ source: 'export const x = 1' }, 'Slide.test')).rejects.toThrow(/default function/)
  })

  it('opens a contributed panel on a document and connects it to the extension, which answers it and posts to it', async () => {
    const { host, started } = makeHost()
    const kit = fakeKit()
    const panels = { panels: [{ id: 'titles.panel', title: 'Title', entry: 'panels/title.html' }, { id: 'titles.other', title: 'Other', entry: 'other.html', kits: ['kit.test'] }] }
    const contributes = { commands: [{ id: 'titles.capitalize', title: 'Capitalize the title' }], ...panels }
    const source = `
export function activate(ctx) {
  ctx.commands.register('titles.capitalize', () => ctx.document.run(async (context) => { context.root.title = 'Capitalized' }))
  ctx.panels.register('titles.panel', (panel) => {
    panel.onRequest(async (message) => {
      if (message.type === 'title') return ctx.document.run(async (context) => { context.root.load(['title']); await context.sync(); return context.root.title })
      throw new Error('unknown request')
    })
    const stop = ctx.document.on('changed', () => panel.post({ type: 'changed', session: panel.session }))
    panel.onClose(() => { globalThis.__panelClosed = (globalThis.__panelClosed ?? 0) + 1 })
    return stop
  })
}
`
    expect(() => host.load({ manifest: manifest({ contributes }), source })).toThrow(/has no panels\/title\.html for its panel titles\.panel/)
    host.load({ manifest: manifest({ contributes }), source, files: { 'panels/title.html': '<p>Title</p>', 'other.html': '<p>Other</p>' } })
    expect(host.panelsFor('Slide.test')).toEqual([])
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: kit.port })
    expect(host.panelsFor('Slide.test').map((panel) => [panel.id, panel.extension, panel.extensionName])).toEqual([
      ['titles.panel', 'com.example.titles', 'Titles'],
      ['titles.other', 'com.example.titles', 'Titles'],
    ])
    expect(host.panelContent('com.example.titles', 'titles.panel')).toEqual({ html: '<p>Title</p>', connect: "'none'", title: 'Title' })
    expect(() => host.panelContent('com.example.titles', 'titles.none')).toThrow(/no panel titles\.none/)

    const channel = new MessageChannel()
    const panel = new RpcPeer(channel.port1)
    cleanups.push(() => panel.close())
    const messages: unknown[] = []
    panel.handle('panel/message', (message: never) => void messages.push(message))
    const session = await host.openPanel('Slide.test', 'com.example.titles', 'titles.panel', channel.port2)
    expect(started).toHaveLength(1) // opening the panel activated the extension
    await expect(panel.request('panel/request', { type: 'title' })).resolves.toBe('quarterly review')
    await expect(panel.request('panel/request', { type: 'other' })).rejects.toThrow(/unknown request/)

    // The panel hears the document change (here, a command of the extension).
    await host.runCommand('Slide.test', 'com.example.titles', 'titles.capitalize')
    await expect.poll(() => messages).toContainEqual({ type: 'changed', session: session.session })
    await expect(panel.request('panel/request', { type: 'title' })).resolves.toBe('Capitalized')

    // A panel the extension does not serve opens, but its requests find no one.
    const other = new MessageChannel()
    const otherPanel = new RpcPeer(other.port1)
    cleanups.push(() => otherPanel.close())
    await host.openPanel('Slide.test', 'com.example.titles', 'titles.other', other.port2)
    await expect(otherPanel.request('panel/request', {})).rejects.toMatchObject({ code: 'not-found' })

    // Closing the session ends it in the worker; requests fail from then on.
    session.close()
    await expect.poll(() => panel.request('panel/request', { type: 'title' }, 200).then(() => 'answered', () => 'closed')).toBe('closed')
  })

  it('refuses panels it does not contribute and documents they do not apply to, and closes them with the document', async () => {
    const { host } = makeHost()
    const contributes = { commands: [], panels: [{ id: 'titles.panel', title: 'Title', entry: 'title.html' }] }
    const source = `export function activate(ctx) { ctx.panels.register('titles.panel', (panel) => panel.onRequest(() => 'ok')) }`
    host.load({ manifest: manifest({ contributes }), source, files: { 'title.html': '<p>Title</p>' } })
    host.openDocument({ id: 'Slide.test', kitId: 'kit.test', port: fakeKit().port })
    host.openDocument({ id: 'Other.doc', kitId: 'kit.other', port: { ...fakeKit().port, kitId: 'kit.other' } })
    const port = () => new MessageChannel().port2
    await expect(host.openPanel('Slide.test', 'com.example.titles', 'titles.none', port())).rejects.toMatchObject({ code: 'not-found' })
    await expect(host.openPanel('Other.doc', 'com.example.titles', 'titles.panel', port())).rejects.toMatchObject({ code: 'invalid' })
    await expect(host.openPanel('Gone.doc', 'com.example.titles', 'titles.panel', port())).rejects.toMatchObject({ code: 'not-found' })
    // An extension cannot serve a panel it does not declare.
    host.load({ manifest: manifest({ id: 'com.example.sneaky', contributes, activation: { kits: ['kit.test'], on: 'open' } }), source: `export function activate(ctx) { ctx.panels.register('sneaky.panel', () => undefined) }`, files: { 'title.html': '<p/>' } })
    await expect(host.activate('com.example.sneaky', 'Slide.test')).rejects.toThrow(/does not contribute the panel sneaky\.panel/)

    const channel = new MessageChannel()
    const panel = new RpcPeer(channel.port1)
    cleanups.push(() => panel.close())
    await host.openPanel('Slide.test', 'com.example.titles', 'titles.panel', channel.port2)
    await expect(panel.request('panel/request', null)).resolves.toBe('ok')
    host.closeDocument('Slide.test')
    await expect.poll(() => panel.request('panel/request', null, 200).then(() => 'answered', () => 'closed')).toBe('closed')
  })
})
