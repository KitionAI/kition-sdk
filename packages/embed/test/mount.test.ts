// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MountOptions } from '@kition/kit-host'
import { FRAME_ALLOW, FRAME_SANDBOX, kitLocation, mountEmbed } from '../src/mount'
import { memoryReplicaStore } from '../src/replicaStore'
import type { EmbedOptions } from '../src/types'
import { openDocument } from '../../script/src/index'
import { fakeKit, NOTE_SCHEMA } from './fakeKit'
import { memoryStorage } from './memoryStorage'

const KIT = { id: 'kit.note', url: 'https://kits.example.com/note-ui' }

function setUp(overrides: Partial<EmbedOptions> = {}, kit = fakeKit()) {
  const element = document.createElement('div')
  document.body.append(element)
  const files = memoryStorage({ f1: 'hello' })
  const options: EmbedOptions = { kit: KIT, file: { id: 'f1', name: 'Notes.note' }, storage: files.storage, ...overrides }
  const mountKit = vi.fn(kit.mountKit)
  const editor = mountEmbed(element, options, { mountKit, replicaStore: memoryReplicaStore })
  return { element, files, kit, mountKit, editor, mounted: () => mountKit.mock.calls.at(-1)![1] as MountOptions }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('mount', () => {
  it('shows the kit from its own origin in a sandboxed frame, bound to that origin', async () => {
    const { element, editor, mounted } = setUp({ locale: 'de', theme: { colorScheme: 'dark', tokens: { '--kit-primary': '#ff0000' } } })
    await (await editor).ready()
    const frame = element.querySelector('iframe')!
    expect(frame.src).toBe('https://kits.example.com/note-ui/index.html')
    expect(frame.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
    expect(frame.getAttribute('allow')).toBe(FRAME_ALLOW)
    const options = mounted()
    expect(options.origin).toBe('https://kits.example.com')
    expect(options.document).toMatchObject({ path: 'Notes.note', name: 'Notes.note', version: 'v1' })
    expect(options.document.readOnly).toBeUndefined()
    expect(new TextDecoder().decode(options.document.bytes)).toBe('hello')
    expect(options.locale).toBe('de')
    expect(options.theme.colorScheme).toBe('dark')
    expect(options.theme.tokens['--kit-primary']).toBe('#ff0000')
    expect(options.theme.tokens['--kit-surface']).toBe('#1b1e23')
  })

  it('resolves kit URLs to a package base and refuses other schemes', () => {
    expect(kitLocation({ id: 'k', url: 'https://kits.example.com/a/?x=1#y' })).toEqual({ origin: 'https://kits.example.com', base: 'https://kits.example.com/a/', entry: 'https://kits.example.com/a/index.html' })
    expect(kitLocation({ id: 'k', url: '/kits/a/', entry: 'editor.html' }, 'http://localhost:5173/app')).toEqual({ origin: 'http://localhost:5173', base: 'http://localhost:5173/kits/a/', entry: 'http://localhost:5173/kits/a/editor.html' })
    expect(() => kitLocation({ id: 'k', url: 'javascript:alert(1)' })).toThrow()
  })

  it('serves no replica single-user without a replica store, and one with it', async () => {
    const single = setUp()
    await (await single.editor).ready()
    expect(single.mounted().handlers.replicaRead).toBeUndefined()
    expect(await (await single.editor).replicaVersion()).toBeNull()
    const kept = setUp({ storage: { ...memoryStorage({ f1: 'x' }).storage, replica: memoryReplicaStore() } })
    await (await kept.editor).ready()
    expect(kept.mounted().handlers.replicaRead).toBeDefined()
    expect((await (await kept.editor).replicaVersion())?.byteLength).toBeGreaterThan(0)
  })

  it('keeps a replica in memory for the object model, and edits the document through it', async () => {
    const { editor: pending, mounted, kit } = setUp({ model: true })
    const editor = await pending
    await editor.ready()
    expect(mounted().handlers.replicaRead).toBeDefined()
    const slideFile = await openDocument(editor, { schema: NOTE_SCHEMA })
    const heard: string[] = []
    slideFile.on('changed', (event) => heard.push(event.origin))
    const body = await slideFile.run(async (context) => {
      context.root.load(['body'])
      await context.sync()
      const text = context.root as unknown as { body: { insert: (index: number, text: string) => void; toString: () => string } }
      text.body.insert(0, '>> ')
      context.root.load(['body'])
      await context.sync()
      return text.body.toString()
    })
    expect(body.startsWith('>> ')).toBe(true)
    expect(kit.last().imports.length).toBeGreaterThan(0)
    expect(heard).toContain('local')
    expect(await slideFile.commands.run('note.append', { text: '!' })).toBeDefined()
  })

  it('tells the object model of saves and of saves refused over a file changed elsewhere', async () => {
    const { editor: pending, files, kit } = setUp({ model: true })
    const editor = await pending
    await editor.ready()
    const slideFile = await openDocument(editor, { schema: NOTE_SCHEMA })
    expect(['saved', 'conflict', 'presence', 'selection'].map((event) => slideFile.supports(event as 'saved'))).toEqual([true, true, false, false])
    const saved: unknown[] = []
    const conflicts: unknown[] = []
    slideFile.on('saved', (event) => saved.push(event))
    slideFile.on('conflict', (event) => conflicts.push(event))
    kit.last().edit(' world')
    await editor.save()
    expect(saved).toEqual([{ version: 'v2' }])
    files.writeElsewhere('f1', 'theirs')
    kit.last().edit('!')
    await editor.save().catch(() => undefined)
    expect(conflicts).toEqual([{ message: expect.stringContaining('changed elsewhere') }])
    expect(files.text('f1')).toBe('theirs')
    slideFile.close()
  })

  it('refuses the object model without a replica', async () => {
    const { editor: pending } = setUp()
    const editor = await pending
    await editor.ready()
    await expect(editor.modelPort().exportChanges(new Uint8Array(0))).rejects.toThrow(/model: true/)
  })

  it('saves through the storage and tells the page', async () => {
    const { editor: pending, files, kit } = setUp()
    const editor = await pending
    const saved = vi.fn()
    const changed = vi.fn()
    editor.on('saved', saved)
    const off = editor.on('changed', changed)
    await editor.ready()
    kit.last().edit(' world')
    off()
    kit.last().edit('!')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await editor.save()).toEqual({ saved: true, version: 'v2' })
    expect(files.text('f1')).toBe(' world!')
    expect(saved).toHaveBeenCalledWith({ version: 'v2' })
  })

  it('passes the kit’s notices to the page', async () => {
    const { editor: pending, mounted } = setUp()
    const editor = await pending
    await editor.ready()
    const notify = vi.fn()
    editor.on('notify', notify)
    mounted().handlers.notify?.({ level: 'warning', title: 'Font missing', description: 'Using a fallback' })
    mounted().handlers.notify?.({ level: 'success', title: 'Exported' })
    expect(notify.mock.calls).toEqual([[{ level: 'warning', message: 'Font missing', description: 'Using a fallback' }], [{ level: 'success', message: 'Exported' }]])
  })

  it('opens read-only in view mode, refusing saves', async () => {
    const { editor: pending, mounted } = setUp({ permissions: { mode: 'view' } })
    const editor = await pending
    await editor.ready()
    expect(mounted().document.readOnly).toBe(true)
    await expect(mounted().handlers.write({ path: 'Notes.note', bytes: new ArrayBuffer(1), mode: 'save' })).rejects.toThrow(/read-only/)
  })

  it('lists and runs the kit’s commands', async () => {
    const { editor: pending, kit } = setUp()
    const editor = await pending
    expect(await editor.commands.list('append')).toEqual([{ id: 'note.append', title: 'Append text', enabled: true, query: 'append' }])
    expect(await editor.commands.run('note.append', { text: 'abc' })).toEqual({ command: 'note.append', changed: true, result: { text: 'abc' } })
    expect(kit.last().text()).toBe('abc')
  })

  it("runs a command as the page's own change (origin system and its label), and hears it as by system", async () => {
    const { editor: pending, kit } = setUp()
    const editor = await pending
    await editor.ready()
    const run = vi.spyOn(kit.last().connection.ai, 'run')
    await editor.commands.run('note.append', { text: 'mail' }, { save: true, origin: 'system', originLabel: 'emailsync' })
    await editor.commands.run('note.append', { text: '!' }, { origin: 'system' })
    await editor.commands.run('note.append', { text: '?' })
    expect(run.mock.calls).toEqual([
      [[{ command: 'note.append', params: { text: 'mail' } }], true, { origin: 'system', originLabel: 'emailsync' }],
      [[{ command: 'note.append', params: { text: '!' } }], false, { origin: 'system' }],
      [[{ command: 'note.append', params: { text: '?' } }], false],
    ])
    const changed = vi.fn()
    editor.on('changed', changed)
    kit.last().options.handlers.changed({ dirty: true, revision: 4, title: 'Notes.note', by: 'system', originLabel: 'emailsync' })
    expect(changed).toHaveBeenCalledWith({ dirty: true, revision: 4, title: 'Notes.note', by: 'system', originLabel: 'emailsync' })
  })

  it('refuses another kit than the one named, and fails ready()', async () => {
    const { editor } = setUp({}, fakeKit('kit.other'))
    await expect((await editor).ready()).rejects.toThrow(/kit\.other, not kit\.note/)
  })

  it("hands the kit the page's display permissions and watermark (EmbedOptions.display)", async () => {
    const { editor: pending, kit } = setUp({ display: { permissions: { download: false, export: true, share: false }, watermark: { text: 'Ann' } } })
    await (await pending).ready()
    expect(kit.last().options.document.permissions).toEqual({ download: false, export: true, share: false })
    expect(kit.last().options.document.watermark).toEqual({ text: 'Ann' })
  })

  it('needs an identity to collaborate', async () => {
    await expect(setUp({ collaboration: { server: 'wss://sync.test' } }).editor).rejects.toThrow(/identity/)
  })

  it('forwards theme and locale changes, and destroy removes the frame', async () => {
    const { element, editor: pending, kit } = setUp()
    const editor = await pending
    await editor.ready()
    const setTheme = vi.spyOn(kit.last().connection, 'setTheme')
    editor.setTheme({ colorScheme: 'light' })
    expect(setTheme.mock.calls[0][0].tokens['--kit-primary']).toBe('#5645d4')
    expect(editor.collab.state).toEqual({ status: 'off', docId: null, role: null })
    editor.destroy()
    expect(element.querySelector('iframe')).toBeNull()
    expect(kit.last().closed).toBe(true)
    await expect(editor.save()).rejects.toThrow()
  })
})
