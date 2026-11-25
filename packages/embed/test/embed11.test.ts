// @vitest-environment jsdom
/**
 * `KitEmbed 1.1`: the storage's `info`, `blob`, and `lend`; the identity's `users` and
 * `permissions`; the `ui` option; the `comments`, `draft`, `action`, and `customize` events; and
 * `editor.document()`. Every addition is optional: `mount.test.ts` keeps covering `KitEmbed 1.0`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MountOptions } from '@kition/kit-host'
import { encodeBlobSection, decodeBlobSection } from '@kition/sync'
import { blobBackedReplicas } from '../src/blobs'
import { supports } from '../../script/src/capabilities'
import { EMBED_CAPABILITY_SETS, lendLocation, mountEmbed } from '../src/mount'
import { memoryReplicaStore } from '../src/replicaStore'
import type { BlobStore, EmbedCommentThread, EmbedOptions, IdentityProvider } from '../src/types'
import { kitUiConfig, strictestMode } from '../src/ui'
import { fakeKit, NOTE_SCHEMA } from './fakeKit'
import { memoryStorage } from './memoryStorage'

const KIT = { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }

function setUp(overrides: Partial<EmbedOptions> = {}, kit = fakeKit()) {
  const element = document.createElement('div')
  document.body.append(element)
  const files = memoryStorage({ f1: 'hello' })
  const options: EmbedOptions = { kit: KIT, file: { id: 'f1', name: 'Notes.note' }, storage: files.storage, ...overrides }
  const mountKit = vi.fn(kit.mountKit)
  const editor = mountEmbed(element, options, { mountKit })
  return { element, files, kit, mountKit, editor, mounted: () => mountKit.mock.calls.at(-1)![1] as MountOptions }
}

/** A blob section's entries as text, comparable across realms (jsdom's `Uint8Array` is not Node's). */
const section = (bytes: ArrayBuffer) => decodeBlobSection(new Uint8Array(bytes)).map((entry) => ({ hash: entry.hash, text: new TextDecoder().decode(entry.data) }))

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function memoryBlobs() {
  const blobs = new Map<string, Uint8Array>()
  const store: BlobStore & { writes: string[] } = {
    writes: [],
    read: async (hash) => blobs.get(hash)?.slice() ?? null,
    write: async (hash, bytes) => {
      store.writes.push(hash)
      blobs.set(hash, bytes.slice())
    },
  }
  return { store, blobs }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('KitEmbed 1.1', () => {
  it('advertises KitEmbed 1.3, which still satisfies KitEmbed 1.1 and 1.0', async () => {
    const { editor, mounted } = setUp()
    await (await editor).ready()
    expect(EMBED_CAPABILITY_SETS).toContain('KitEmbed 1.3')
    expect(supports('KitEmbed 1.1', EMBED_CAPABILITY_SETS)).toBe(true)
    expect(mounted().capabilitySets).toEqual(['KitModel 1.1', 'KitObjectModel 1.0', 'KitEmbed 1.3'])
    // No identity and no `ui`: nothing of 1.1 reaches the kit.
    expect(mounted().document.comments).toBeUndefined()
    expect(mounted().document.lend).toBeUndefined()
    expect(mounted().ui).toBeUndefined()
    expect(mounted().handlers.customize).toBeUndefined()
    expect((await editor).mode).toBe('edit')
  })

  it('names the file and answers its stamps from storage.info', async () => {
    const files = memoryStorage({ f1: 'hello' })
    const { stamp: _stamp, ...withoutStamp } = files.storage
    const info = vi.fn(async (fileId: string) => (files.files.has(fileId) ? { name: 'From info.note', version: `v${files.files.get(fileId)!.version}`, size: 5, mime: 'text/plain' } : null))
    const { editor, mounted } = setUp({ file: { id: 'f1' }, storage: { ...withoutStamp, info } })
    await (await editor).ready()
    expect(mounted().document).toMatchObject({ path: 'From info.note', name: 'From info.note', version: 'v1' })
    expect(await mounted().handlers.stamp({ path: 'From info.note' })).toEqual({ version: 'v1' })
    expect(await mounted().handlers.stamp({ path: 'Other.note' })).toEqual({ version: null })
  })

  it('refuses a file it cannot name and a storage it cannot stamp with', async () => {
    const { stamp: _stamp, ...withoutStamp } = memoryStorage().storage
    await expect(setUp({ file: { id: 'f1' } }).editor).rejects.toThrow(/name/)
    await expect(setUp({ storage: withoutStamp }).editor).rejects.toThrow(/stamp or info/)
    const gone = setUp({ file: { id: 'f9' }, storage: { ...memoryStorage().storage, info: async () => null } })
    await expect((await gone.editor).ready()).rejects.toThrow(/no file f9/)
  })

  it('opens for comments only when the identity permits no more, and tells the kit who comments', async () => {
    const permissions = vi.fn(async () => ({ mode: 'comment' as const }))
    const identity: IdentityProvider = { user: () => ({ id: 'u1', name: 'Ann' }), permissions }
    const { editor: pending, mounted, kit, files } = setUp({ identity })
    const editor = await pending
    await editor.ready()
    expect(permissions).toHaveBeenCalledWith('f1')
    expect(editor.mode).toBe('comment')
    expect(mounted().document.readOnly).toBe(true)
    expect(mounted().document.comments).toEqual({ me: 'u1', name: 'Ann', canComment: true, othersReadOnly: true })
    // A commenter's kit takes comments, never content, and nothing is saved.
    expect(() => kit.last().edit('x')).toThrow(/read-only/)
    kit.last().comment('Looks good')
    await expect(Promise.resolve().then(() => mounted().handlers.write({ path: 'Notes.note', bytes: new ArrayBuffer(1), mode: 'save' }))).rejects.toMatchObject({ data: { reason: 'not-allowed' } })
    expect(files.text('f1')).toBe('hello')
  })

  it('applies the stricter of the permissions option and the identity', async () => {
    expect(strictestMode()).toBe('edit')
    expect(strictestMode('edit', 'comment')).toBe('comment')
    expect(strictestMode('comment', 'view', 'edit')).toBe('view')
    expect(strictestMode(null, undefined, 'comment')).toBe('comment')
    const viewing = setUp({ permissions: { mode: 'view' }, identity: { permissions: () => ({ mode: 'edit' }) } })
    await (await viewing.editor).ready()
    expect((await viewing.editor).mode).toBe('view')
    expect(viewing.mounted().document.comments).toMatchObject({ me: null, canComment: false })
  })

  it('maps the ui option to the kit’s UI configuration, keeps only the panels named, and replaces it on configure', async () => {
    const kit = fakeKit()
    const { editor: pending, mounted } = setUp(
      { ui: { hide: ['menu:Help'], disable: ['action:save'], add: [{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' } }], toolbar: 'none', panels: ['comments'] } },
      kit,
    )
    const editor = await pending
    await editor.ready()
    expect(mounted().ui).toEqual({ hide: ['menu:Help', 'tab:*'], disable: ['action:save'], add: [{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' } }] })
    const connection = kit.last().connection
    expect(connection.configure).toBeDefined()
    // `panels` hides the others once the kit lists its elements.
    const configure = vi.spyOn(connection, 'configure')
    vi.spyOn(connection, 'elements').mockResolvedValue([
      { id: 'panel:comments', kind: 'panel', label: 'Comments', parent: null, hidden: false, disabled: false },
      { id: 'panel:layers', kind: 'panel', label: 'Layers', parent: null, hidden: false, disabled: false },
      { id: 'tab:home', kind: 'tab', label: 'Home', parent: null, hidden: false, disabled: false },
    ])
    editor.configure({ panels: ['comments'] })
    await vi.waitFor(() => expect(configure).toHaveBeenLastCalledWith({ hide: ['panel:layers'] }))
    editor.configure({})
    await vi.waitFor(() => expect(configure).toHaveBeenLastCalledWith({}))
    expect(kitUiConfig(undefined, null, null)).toBeUndefined()
    expect(kitUiConfig({ personal: { hide: ['menu:Filter'] } }, null, null)).toEqual({ personal: { hide: ['menu:Filter'] } })
  })

  it('passes the display modes through to the kit', () => {
    expect(kitUiConfig({ modes: { allowed: ['menus', 'focus'], default: 'menus' } }, null, null)).toEqual({ modes: { allowed: ['menus', 'focus'], default: 'menus' } })
  })

  it('passes the person’s own hides to the page, and back to the kit when it opens again', async () => {
    const customize = vi.fn()
    const { editor: pending, mounted } = setUp({ ui: { customize, personal: { hide: ['menu:Old'] } } })
    const editor = await pending
    await editor.ready()
    expect(mounted().ui).toEqual({ personal: { hide: ['menu:Old'] } })
    const heard: unknown[] = []
    editor.on('customize', (value) => heard.push(value))
    await mounted().handlers.customize!({ personal: { hide: ['menu:Filter/Video'] } })
    expect(customize).toHaveBeenCalledWith({ hide: ['menu:Filter/Video'] })
    expect(heard).toEqual([{ hide: ['menu:Filter/Video'] }])
    expect(kitUiConfig({ customize, personal: { hide: ['menu:Old'] } }, null, { hide: ['menu:Filter/Video'] })).toEqual({ personal: { hide: ['menu:Filter/Video'] } })
  })

  it('reports the kit’s drafts and the page’s buttons as events', async () => {
    const { editor: pending, mounted } = setUp()
    const editor = await pending
    await editor.ready()
    const drafts: unknown[] = []
    const actions: unknown[] = []
    editor.on('draft', (info) => drafts.push(info))
    editor.on('action', (action) => actions.push(action))
    mounted().handlers.draftChanged!({ state: 'ready', revision: 3 })
    mounted().handlers.action!({ id: 'submit', document: { path: 'Notes.note', dirty: true, revision: 2 } })
    expect(drafts).toEqual([{ state: 'ready', revision: 3 }])
    expect(actions).toEqual([{ id: 'submit', document: { path: 'Notes.note', dirty: true, revision: 2 } }])
  })

  it('lends the kit the files its document links from the storage’s URL', async () => {
    const lend = vi.fn(async () => 'https://files.example.com/docs/f1?token=x')
    const { editor, mounted } = setUp({ storage: { ...memoryStorage({ f1: 'x' }).storage, lend } })
    await (await editor).ready()
    expect(lend).toHaveBeenCalledWith('f1')
    expect(mounted().document.lend).toEqual({ root: 'https://files.example.com/docs/f1/', folder: '' })
    expect(lendLocation(null)).toBeUndefined()
    expect(lendLocation('/media/', 'https://app.example.com/page')).toEqual({ root: 'https://app.example.com/media/', folder: '' })
    expect(() => lendLocation('file:///etc/')).toThrow(/http/)
  })

  it('keeps the replica’s blobs in the blob store, and the stored replica only names them', async () => {
    const { store, blobs } = memoryBlobs()
    const replicas = memoryReplicaStore()
    const backed = blobBackedReplicas(replicas, store)
    const picture = new TextEncoder().encode('a picture')
    const hash = await sha256(picture)
    const encoded = encodeBlobSection([{ hash, data: picture }])
    const replica = { snapshot: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, blobs: encoded.slice().buffer as ArrayBuffer, fileStamp: 'v2' }
    await backed.write('f1', replica)
    await backed.write('f1', replica)
    expect(store.writes).toEqual([hash])
    const stored = await replicas.read('f1')
    expect(section(stored!.blobs)).toEqual([{ hash, text: '' }])
    const read = await backed.read('f1')
    expect(section(read!.blobs)).toEqual([{ hash, text: 'a picture' }])
    expect(read!.fileStamp).toBe('v2')
    // A blob the store lost, or answers with other bytes, is left out rather than handed over wrong.
    blobs.set(hash, new TextEncoder().encode('tampered'))
    const fresh = blobBackedReplicas(replicas, store)
    expect(section((await fresh.read('f1'))!.blobs)).toEqual([])
    // A replica stored before the blob store (its blobs inside) reads as it was.
    await replicas.write('f2', replica)
    expect(await fresh.read('f2')).toEqual(replica)
  })

  it('serves an editor’s replica through the blob store', async () => {
    const { store } = memoryBlobs()
    const replicas = memoryReplicaStore()
    const { editor, mounted } = setUp({ storage: { ...memoryStorage({ f1: 'x' }).storage, replica: replicas, blob: store } })
    await (await editor).ready()
    const picture = new TextEncoder().encode('media')
    const hash = await sha256(picture)
    await mounted().handlers.replicaWrite!({ path: 'Notes.note', snapshot: new ArrayBuffer(4), blobs: encodeBlobSection([{ hash, data: picture }]).slice().buffer as ArrayBuffer, fileStamp: 'v1', version: new ArrayBuffer(1) })
    expect(store.writes).toEqual([hash])
    expect(section((await replicas.read('f1'))!.blobs)).toEqual([{ hash, text: '' }])
    const read = await mounted().handlers.replicaRead!({ path: 'Notes.note' })
    expect(section(read!.blobs)).toEqual([{ hash, text: 'media' }])
  })

  it('reports the comment threads with their authors as the page names them', async () => {
    const users = vi.fn(async (ids: string[]) => ids.filter((id) => id === 'u1').map((id) => ({ id, name: 'Ann Lee', avatar: 'https://example.com/ann.png' })))
    const { editor: pending, kit } = setUp({ storage: { ...memoryStorage({ f1: 'hello' }).storage, replica: memoryReplicaStore() }, identity: { user: () => ({ id: 'u1', name: 'Ann' }), users } })
    const editor = await pending
    await editor.ready()
    const heard: EmbedCommentThread[][] = []
    editor.on('comments', (threads) => heard.push(threads))
    await vi.waitFor(() => expect(heard).toEqual([[]]))
    kit.last().comment('First')
    kit.last().edit(' more text')
    await vi.waitFor(() => expect(heard).toHaveLength(2))
    const [thread] = heard[1]
    expect(thread).toMatchObject({ resolved: false, anchor: { object: expect.any(String) } })
    expect(thread.comments).toEqual([{ id: expect.any(String), author: 'u1', name: 'Ann', body: 'First', created: new Date(0).toISOString(), user: { id: 'u1', name: 'Ann Lee', avatar: 'https://example.com/ann.png' } }])
    // A content edit leaves the threads as they were: no new event.
    kit.last().edit('!')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(heard).toHaveLength(2)
    // A later listener hears the threads as they are.
    const late: EmbedCommentThread[][] = []
    editor.on('comments', (threads) => late.push(threads))
    await vi.waitFor(() => expect(late).toHaveLength(1))
    expect(late[0]).toEqual(heard[1])
    expect(users).toHaveBeenCalledTimes(1)
  })

  it('opens the document as @kition/script’s object model in one call', async () => {
    const { editor: pending } = setUp({}, fakeKit('kit.note', ['ai', 'model']))
    const editor = await pending
    await editor.ready()
    const doc = await editor.document({ id: 'kit.note', schema: NOTE_SCHEMA })
    const text = await doc.run(async (context) => {
      const root = context.root as unknown as { body: { insert: (index: number, text: string) => void; toString: () => string } }
      context.root.load(['body'])
      await context.sync()
      root.body.insert(0, '>> ')
      context.root.load(['body'])
      await context.sync()
      return root.body.toString()
    })
    expect(text.startsWith('>> ')).toBe(true)
    doc.close()
    await expect(editor.document({ id: 'kit.slide', schema: {} })).rejects.toThrow(/kit\.slide/)
  })
})
