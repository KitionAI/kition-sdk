// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KitRpcError, type MountOptions } from '@kition/kit-host'
import { createHandlers, type DocumentFiles } from '../src/handlers'
import { mountEmbed } from '../src/mount'
import type { EmbedOptions, StorageProvider } from '../src/types'
import { fakeKit } from './fakeKit'
import { memoryStorage } from './memoryStorage'

const linked = { fileId: 'f2', name: 'Plan.md', kitId: 'kit.note', version: 'v1', path: 'notes/Plan.md' }

function opening(overrides: Partial<StorageProvider> = {}) {
  const resolveLink = vi.fn(async (_from: string, link: { path?: string; name?: string; docId?: string }) => (link.path === 'notes/Plan.md' ? linked : null))
  const open = vi.fn(async (_fileId: string, _view?: unknown) => ({ opened: true }))
  const openUrl = vi.fn(async (_url: string) => ({ opened: true }))
  return { resolveLink, open, openUrl, storage: { ...memoryStorage({ f1: 'hello' }).storage, resolveLink, open, openUrl, ...overrides } }
}

function handlersFor(storage: StorageProvider, overrides: Partial<DocumentFiles> = {}) {
  return createHandlers({ file: { id: 'f1', name: 'Notes.md' }, storage, replicas: null, readOnly: false, version: { current: 'v1' }, onSaved: () => undefined, onChanged: () => undefined, ...overrides })
}

async function refusal(promise: unknown) {
  const error = await Promise.resolve(promise).then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(KitRpcError)
  return (error as KitRpcError).data as { reason: string }
}

describe('opening linked files (EM25, open-file)', () => {
  it('is served only when the storage resolves and opens links', () => {
    const { resolveLink, open } = opening()
    const plain = memoryStorage({ f1: 'hello' }).storage
    expect(handlersFor(plain).open).toBeUndefined()
    expect(handlersFor({ ...plain, resolveLink }).open).toBeUndefined()
    expect(handlersFor({ ...plain, open }).open).toBeUndefined()
    expect(handlersFor({ ...plain, resolveLink, open }).open).toBeDefined()
  })

  it('resolves the link from the document and opens the file at the view', async () => {
    const { storage, resolveLink, open } = opening()
    const view = { kind: 'heading', id: 'h2' } as never
    expect(await handlersFor(storage).open!({ link: { path: 'notes/Plan.md' }, view })).toEqual({ opened: true })
    expect(resolveLink).toHaveBeenCalledWith('f1', { path: 'notes/Plan.md' })
    expect(open).toHaveBeenCalledWith('f2', view)
  })

  it('answers a cancelled open as not opened', async () => {
    const { storage } = opening({ open: async () => ({ opened: false }) })
    expect(await handlersFor(storage).open!({ link: { path: 'notes/Plan.md' } })).toEqual({ opened: false })
  })

  it('refuses a link the page does not resolve as not-found, opening nothing', async () => {
    const { storage, open } = opening()
    expect((await refusal(handlersFor(storage).open!({ link: { name: 'Missing' } }))).reason).toBe('not-found')
    expect(open).not.toHaveBeenCalled()
  })

  it('opens only from a person’s gesture (OP1)', async () => {
    const { storage, resolveLink, open } = opening()
    expect((await refusal(handlersFor(storage, { gesture: () => false }).open!({ link: { path: 'notes/Plan.md' } }))).reason).toBe('no-gesture')
    expect(resolveLink).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens from a read-only document (OP5)', async () => {
    const { storage } = opening()
    expect(await handlersFor(storage, { readOnly: true }).open!({ link: { path: 'notes/Plan.md' } })).toEqual({ opened: true })
  })
})

describe('opening web addresses (EM25, open-url)', () => {
  it('is served only when the storage opens addresses', () => {
    const plain = memoryStorage({ f1: 'hello' }).storage
    expect(handlersFor(plain).openUrl).toBeUndefined()
    expect(handlersFor(opening().storage).openUrl).toBeDefined()
  })

  it('hands https, http, and mailto addresses to the page, which confirms them (OP8)', async () => {
    const { storage, openUrl } = opening()
    const handlers = handlersFor(storage)
    for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:lin@example.com']) expect(await handlers.openUrl!({ url })).toEqual({ opened: true })
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(['https://example.com/a', 'http://example.com/', 'mailto:lin@example.com'])
  })

  it('refuses every other scheme as not-allowed without asking the page (OP7)', async () => {
    const { storage, openUrl } = opening()
    const handlers = handlersFor(storage)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'kition://open']) expect((await refusal(handlers.openUrl!({ url }))).reason).toBe('not-allowed')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens only from a person’s gesture (OP6)', async () => {
    const { storage, openUrl } = opening()
    expect((await refusal(handlersFor(storage, { gesture: () => false }).openUrl!({ url: 'https://example.com' }))).reason).toBe('no-gesture')
    expect(openUrl).not.toHaveBeenCalled()
  })
})

describe('the mounted editor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mount(overrides: Partial<EmbedOptions> = {}) {
    const element = document.createElement('div')
    document.body.append(element)
    const kit = fakeKit()
    const mountKit = vi.fn(kit.mountKit)
    const options: EmbedOptions = { kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui' }, file: { id: 'f1', name: 'Notes.md' }, storage: memoryStorage({ f1: 'hello' }).storage, ...overrides }
    const editor = mountEmbed(element, options, { mountKit })
    return { editor, mounted: () => mountKit.mock.calls.at(-1)![1] as MountOptions }
  }

  it('serves the page’s services to the kit, keeping a refusal’s reason (EM29)', async () => {
    const mention = vi.fn(async ({ query }: { query: string }) => ({ people: [{ id: 'u2', name: `Lin ${query}` }] }))
    const notify = vi.fn(async () => {
      throw Object.assign(new Error('no such person'), { reason: 'not-found' })
    })
    const create = vi.fn(async () => {
      throw new Error('database down')
    })
    const { editor, mounted } = mount({ services: { 'people.mention': mention, 'people.notify': notify, 'comment.create': create } })
    await (await editor).ready()
    const services = mounted().handlers.services!
    expect(Object.keys(services).sort()).toEqual(['comment.create', 'people.mention', 'people.notify'])
    expect(await services['people.mention']!({ query: 'a' })).toEqual({ people: [{ id: 'u2', name: 'Lin a' }] })
    expect((await refusal(services['people.notify']!({ people: ['u9'], message: 'hi' }))).reason).toBe('not-found')
    expect((await refusal(services['comment.create']!({ anchor: { ids: ['p1'] } }))).reason).toBe('failed')
    const plain = mount()
    await (await plain.editor).ready()
    expect(plain.mounted().handlers.services).toBeUndefined()
    expect(plain.mounted().handlers.comments).toBeUndefined()
  })

  it('marks the threads the page keeps, again in a kit opened again, and hears a marker clicked (EM30)', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const kit = fakeKit('kit.note', ['ai', 'replica', 'comment-anchors'])
    const activated = vi.fn()
    const editor = await mountEmbed(element, { kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui' }, file: { id: 'f1', name: 'Notes.md' }, storage: memoryStorage({ f1: 'hello' }).storage, comments: { activated } }, { mountKit: kit.mountKit })
    const thread = { id: 't1', anchor: { ids: ['p1'], quote: 'hello' }, resolved: false, count: 2 }
    // Shown while the kit opens: sent once it has. Every kit the editor opens (again, after a
    // reconnect or a role change) opens through the same path, so it marks the latest list too.
    editor.comments.show([thread])
    await editor.ready()
    expect(kit.last().shown.at(-1)).toEqual([thread])
    expect(await editor.comments.locate([thread.anchor])).toEqual([true])
    kit.last().options.handlers.comments!.activated('t1')
    expect(activated).toHaveBeenCalledWith('t1')
    // A later list replaces it at once.
    editor.comments.show([{ ...thread, resolved: true }])
    expect(kit.last().shown.at(-1)).toEqual([{ ...thread, resolved: true }])
    editor.destroy()
  })

  it('offers opening to the kit through the storage’s callbacks', async () => {
    const { storage, open } = opening()
    const { editor, mounted } = mount({ storage })
    await (await editor).ready()
    expect(await mounted().handlers.open!({ link: { path: 'notes/Plan.md' } })).toEqual({ opened: true })
    expect(open).toHaveBeenCalledWith('f2', undefined)
    expect(mounted().handlers.openUrl).toBeDefined()
    const plain = mount()
    await (await plain.editor).ready()
    expect(plain.mounted().handlers.open).toBeUndefined()
    expect(plain.mounted().handlers.openUrl).toBeUndefined()
  })

  it('has the kit forward the page’s shortcuts, heard as the shortcut event (EM28)', async () => {
    const { editor: pending, mounted } = mount({ shortcuts: ['Cmd+S', 'Cmd+J'] })
    const editor = await pending
    await editor.ready()
    expect(mounted().shortcuts).toEqual(['Cmd+S', 'Cmd+J'])
    const shortcut = vi.fn()
    editor.on('shortcut', shortcut)
    const key = { key: 'j', code: 'KeyJ', meta: true, ctrl: false, shift: false, alt: false }
    mounted().handlers.shortcut?.(key)
    expect(shortcut).toHaveBeenCalledWith(key)
  })

  it('forwards no shortcuts by default', async () => {
    const { editor, mounted } = mount()
    await (await editor).ready()
    expect(mounted().shortcuts).toEqual([])
  })
})
