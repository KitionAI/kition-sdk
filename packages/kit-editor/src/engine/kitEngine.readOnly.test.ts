// @vitest-environment jsdom
/**
 * The engine worker's read-only guard (`document.readOnly`), driven through its `handle` with a
 * fake kit module document: which calls it refuses by rule, and the backstop that undoes and refuses
 * an allowed call that still committed to the replica.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'
import { COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF, Replica, Version, type Tx, addThread, commentThreads, newDocId, parseSchema, person } from '@kition/kdm'
import { commentCommands, editsDocument, isReadOnlyError, refusedReadOnly } from './readOnly'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

type Catalog = Array<{ id: string; mutates: boolean }>

const CATALOG: Catalog = [
  { id: 'slide.new', mutates: true },
  { id: 'slide.go', mutates: false },
  { id: 'edit.undo', mutates: false },
  { id: 'edit.redo', mutates: false },
  { id: 'file.save', mutates: false },
  { id: 'file.exportPdf', mutates: false },
  { id: 'view.zoomIn', mutates: true },
  { id: 'playhead.set', mutates: true },
  { id: 'sequence.open', mutates: true },
  { id: 'sequence.lift', mutates: true },
  { id: 'view.rulers', mutates: true },
]

/** A document whose replica version moves on `commits` commands and on `undo`. */
function fakeDocument(options: { replica?: boolean; commits?: string[]; dirties?: string[] } = {}) {
  const replica = options.replica ?? true
  const state = { version: 1, dirty: false, ran: [] as string[], undone: 0, called: [] as string[] }
  const doc = {
    width: 10,
    height: 10,
    get revision() {
      return BigInt(state.ran.length)
    },
    get dirty() {
      return state.dirty
    },
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string) => {
      state.ran.push(command)
      if (options.commits?.includes(command)) {
        state.version += 1
        state.dirty = true
      }
      if (options.dirties?.includes(command)) state.dirty = true
      return '{}'
    },
    inspect: () => '{}',
    commands: () => JSON.stringify(CATALOG.map((item) => ({ ...item, title: item.id, menu: [], shortcut: null, enabled: true }))),
    save: () => new Uint8Array([1]),
    markSaved: () => {
      state.dirty = false
    },
    free: () => undefined,
    ...(replica
      ? {
          version: () => new Uint8Array([state.version]),
          undo: () => {
            state.undone += 1
            state.version += 1
            state.dirty = false
            return '{"done":true}'
          },
          exportChanges: () => new Uint8Array(),
          importChanges: () => {
            state.version += 1
            return '{"kind":"full"}'
          },
          addBlobs: () => undefined,
          blobs: () => new Uint8Array(),
          redo: () => '{"done":false}',
          executeAs: () => '{}',
        }
      : {}),
    tools: () => '[]',
    tool: () => 'select',
    selectTool: () => '{}',
    toolState: () => '{}',
    pointer: (json: string) => {
      state.called.push(`pointer ${json}`)
      return '{}'
    },
    toolKey: () => '{}',
    toolText: () => '{}',
    thumbnail: () => 'ok',
  }
  fake.doc = doc as unknown as KitModuleDocument
  return state
}

const manifest = { kitId: 'kit.test', module: 'test', documentClass: 'TestDocument' } as KitModuleManifest

async function open(readOnly: boolean) {
  await handle({ method: 'open', manifest, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null, readOnly })
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('the call was not refused')
}

const execute = (command: string) => handle({ method: 'execute', command, params: {} })

describe('the read-only rules', () => {
  it('refuse edits, the history, and file commands that are not exports', () => {
    expect(editsDocument({ id: 'slide.new', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'edit.undo', mutates: false })).toBe(true)
    expect(editsDocument({ id: 'file.save', mutates: false })).toBe(true)
    expect(editsDocument({ id: 'file.exportPdf', mutates: true })).toBe(false)
  })

  it('let viewing commands run whatever their kit flags', () => {
    expect(editsDocument({ id: 'view.zoomIn', mutates: true })).toBe(false)
    expect(editsDocument({ id: 'select.all', mutates: true })).toBe(false)
    expect(editsDocument({ id: 'playhead.set', mutates: true })).toBe(false)
    expect(editsDocument({ id: 'sequence.open', mutates: true })).toBe(false)
    expect(editsDocument({ id: 'sequence.lift', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'slide.go', mutates: false })).toBe(false)
  })

  it('refuse view and selection commands that are document settings', () => {
    expect(editsDocument({ id: 'view.freezePanes', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'view.addGuide', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'select.save', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'view.zoom', mutates: true })).toBe(false)
  })
})

describe('the engine worker, read-only', () => {
  beforeEach(() => {
    fake.doc = null
  })

  it('refuses editing commands with the reason read-only and runs none of them', async () => {
    const state = fakeDocument()
    await open(true)
    for (const command of ['slide.new', 'edit.undo', 'edit.redo', 'file.save', 'sequence.lift']) {
      const error = await refusal(execute(command))
      expect(isReadOnlyError(error), command).toBe(true)
      expect((error as { reason: string }).reason).toBe('read-only')
    }
    expect(state.ran).toEqual([])
    expect(state.version).toBe(1)
  })

  it('runs viewing commands, exports, and commands that do not edit', async () => {
    const state = fakeDocument()
    await open(true)
    for (const command of ['slide.go', 'view.zoomIn', 'playhead.set', 'sequence.open', 'file.exportPdf', 'kit.unlisted']) await execute(command)
    expect(state.ran).toEqual(['slide.go', 'view.zoomIn', 'playhead.set', 'sequence.open', 'file.exportPdf', 'kit.unlisted'])
  })

  it('undoes and refuses an allowed command that committed to the replica anyway', async () => {
    const state = fakeDocument({ commits: ['view.rulers'] })
    await open(true)
    const error = await refusal(execute('view.rulers'))
    expect(isReadOnlyError(error)).toBe(true)
    expect(state.undone).toBe(1)
    expect(state.dirty).toBe(false)
  })

  it('without a replica, undoes and refuses an allowed command that made the document unsaved', async () => {
    const state = fakeDocument({ replica: false, dirties: ['view.rulers', 'edit.undo'] })
    await open(true)
    expect(isReadOnlyError(await refusal(execute('view.rulers')))).toBe(true)
    // An engine without the session's undo is asked for its own Undo command.
    expect(state.ran).toEqual(['view.rulers', 'edit.undo'])
  })

  it('refuses the engine tools that edit and answers the ones that read', async () => {
    const state = fakeDocument()
    await open(true)
    for (const name of ['pointer', 'toolKey', 'toolText'] as const) {
      expect(isReadOnlyError(await refusal(handle({ method: 'tool', name, args: ['{}'], settled: true }))), name).toBe(true)
    }
    expect(state.called).toEqual([])
    for (const name of ['tools', 'tool', 'toolState', 'selectTool'] as const) await handle({ method: 'tool', name, args: [], settled: false })
  })

  it('refuses markSaved and keeps save, room imports, and other extras', async () => {
    const state = fakeDocument()
    await open(true)
    expect(isReadOnlyError(await refusal(handle({ method: 'markSaved' })))).toBe(true)
    await handle({ method: 'save' })
    await handle({ method: 'replicaImport', changes: new ArrayBuffer(1), blobs: new ArrayBuffer(0) })
    expect(state.version).toBe(2)
    expect((await handle({ method: 'invoke', name: 'thumbnail', args: [] })).value).toBe('ok')
  })

  it('never reports unsaved changes, even after room imports', async () => {
    const state = fakeDocument()
    await open(true)
    state.dirty = true
    const imported = await handle({ method: 'replicaImport', changes: new ArrayBuffer(1), blobs: new ArrayBuffer(0) })
    expect((imported.value as { info: { dirty: boolean } }).info.dirty).toBe(false)
  })

  it('refuses an extra that committed to the replica', async () => {
    const state = fakeDocument()
    ;(fake.doc as Record<string, unknown>).nudge = () => {
      state.version += 1
    }
    await open(true)
    expect(isReadOnlyError(await refusal(handle({ method: 'invoke', name: 'nudge', args: [] })))).toBe(true)
    expect(state.undone).toBe(1)
  })
})

describe('the comment commands of a read-only session', () => {
  it('are the listed ones for a commenter, never the history or file commands, and none for a viewer', () => {
    const listed = ['comment.add', 'comment.reply', 'edit.undo', 'file.save']
    expect([...commentCommands(listed, true)]).toEqual(['comment.add', 'comment.reply'])
    expect([...commentCommands(listed, false)]).toEqual([])
    expect([...commentCommands(undefined, true)]).toEqual([])
  })

  it('let a commenter through the read-only rules and nothing else', () => {
    const comments = commentCommands(['comment.add'], true)
    expect(refusedReadOnly({ id: 'comment.add', mutates: true }, comments)).toBe(false)
    expect(refusedReadOnly({ id: 'comment.add', mutates: true }, new Set())).toBe(true)
    expect(refusedReadOnly({ id: 'slide.new', mutates: true }, comments)).toBe(true)
    expect(refusedReadOnly({ id: 'view.zoomIn', mutates: true }, comments)).toBe(false)
  })
})

const KDM_SCHEMA = parseSchema({
  kdm: 1,
  kit: 'kit.test',
  schemaVersion: 1,
  root: 'Doc',
  types: { Doc: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
})

const KDM_CATALOG: Catalog = [
  { id: 'comment.add', mutates: true },
  { id: 'comment.sneak', mutates: true },
  { id: 'text.insert', mutates: true },
  { id: 'edit.undo', mutates: false },
  { id: 'file.save', mutates: false },
]

/**
 * A document on a real KDM replica: `comment.add` opens a thread, `comment.sneak` opens one and
 * edits the text as well, `text.insert` edits the text; the session's undo takes the last back.
 * `lazy`: the replica is made when its version is first asked for, as an engine's is.
 */
function kdmDocument(lazy = false) {
  const replica = Replica.create(KDM_SCHEMA, newDocId(), 1n)
  const root = replica.transact(person('owner'), (tx) => {
    const id = tx.create('Doc', {})
    tx.textInsert(id, 'body', 0, 'Hello')
    return id
  })
  const state = { ran: [] as string[], undone: 0, dirty: false, made: !lazy }
  const comment = (tx: Tx) => void addThread(tx, { object: root, field: 'body' }, { author: 'carol', body: 'Why?', created: '2026-10-19T10:00:00Z' })
  const doc = {
    width: 10,
    height: 10,
    get revision() {
      return BigInt(state.ran.length + state.undone)
    },
    get dirty() {
      return state.dirty
    },
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string) => {
      state.ran.push(command)
      const writes: Record<string, (tx: Tx) => void> = {
        'comment.add': comment,
        'comment.sneak': (tx) => {
          comment(tx)
          tx.textInsert(root, 'body', 5, '!')
        },
        'text.insert': (tx) => tx.textInsert(root, 'body', 5, '?'),
      }
      const write = writes[command]
      if (write) {
        replica.transact(person('carol'), write)
        state.dirty = true
      }
      // The engine's own history: the replica's, which holds this replica's edits.
      if (command === 'edit.undo') replica.undo()
      if (command === 'edit.redo') replica.redo()
      return '{}'
    },
    inspect: () => '{}',
    commands: () => JSON.stringify(KDM_CATALOG.map((item) => ({ ...item, title: item.id, menu: [], shortcut: null, enabled: true }))),
    save: () => new Uint8Array([1]),
    markSaved: () => {
      state.dirty = false
    },
    free: () => undefined,
    get hasReplica() {
      return state.made
    },
    version: () => {
      state.made = true
      return replica.version().encode()
    },
    exportChanges: (since: Uint8Array) => replica.exportChanges(since.byteLength ? Version.decode(since) : Version.empty()),
    importChanges: (changes: Uint8Array) => {
      replica.importChanges(changes)
      return '{"kind":"full"}'
    },
    addBlobs: () => undefined,
    blobs: () => new Uint8Array(),
    undo: () => {
      state.undone += 1
      replica.undo()
      return '{"done":true}'
    },
    redo: () => {
      replica.redo()
      return '{"done":true}'
    },
    canUndo: () => replica.canUndo(),
    canRedo: () => replica.canRedo(),
  }
  fake.doc = doc as unknown as KitModuleDocument
  return { replica, root, state }
}

const commenting = { ...manifest, commentCommands: ['comment.add', 'comment.sneak', 'edit.undo', 'file.save'] } as KitModuleManifest

async function openAs(role: 'commenter' | 'viewer') {
  await handle({ method: 'open', manifest: commenting, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null, readOnly: true, canComment: role === 'commenter' })
}

describe('the engine worker, read-only for a commenter', () => {
  beforeEach(() => {
    fake.doc = null
  })

  it('runs a comment command, which stays and leaves nothing to save', async () => {
    const { replica, state } = kdmDocument()
    await openAs('commenter')
    const answer = await execute('comment.add')
    expect(commentThreads(replica)).toHaveLength(1)
    expect(state.undone).toBe(0)
    expect((answer.value as { info: { dirty: boolean } }).info.dirty).toBe(false)
    // The file is not a commenter's to save.
    expect(isReadOnlyError(await refusal(handle({ method: 'markSaved' })))).toBe(true)
  })

  it("makes the replica for a commenter's first comment, where comments live", async () => {
    const { replica, state } = kdmDocument(true)
    await openAs('commenter')
    await execute('comment.add')
    expect(state.made).toBe(true)
    expect(commentThreads(replica)).toHaveLength(1)
    expect(state.undone).toBe(0)
  })

  it('refuses a comment command for a viewer and runs none of it', async () => {
    const { replica, state } = kdmDocument()
    await openAs('viewer')
    expect(isReadOnlyError(await refusal(execute('comment.add')))).toBe(true)
    expect(state.ran).toEqual([])
    expect(commentThreads(replica)).toHaveLength(0)
  })

  it('refuses every edit that is not a comment command, the history and file commands even when listed', async () => {
    const { replica, root, state } = kdmDocument()
    await openAs('commenter')
    for (const command of ['text.insert', 'edit.undo', 'file.save']) expect(isReadOnlyError(await refusal(execute(command))), command).toBe(true)
    expect(state.ran).toEqual([])
    expect(replica.text(root, 'body')).toBe('Hello')
  })

  it("undoes and redoes the commenter's own comments, and nothing before them", async () => {
    const { replica, root } = kdmDocument()
    await openAs('commenter')
    const history = (answer: { value: unknown }) => {
      const { canUndo, canRedo } = (answer.value as { info: { canUndo: boolean; canRedo: boolean } }).info
      return { canUndo, canRedo }
    }
    // Nothing of theirs yet: the owner's edit before the session is not theirs to undo.
    expect(replica.canUndo()).toBe(true)
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(history(await execute('comment.add'))).toEqual({ canUndo: true, canRedo: false })
    expect(history(await execute('edit.undo'))).toEqual({ canUndo: false, canRedo: true })
    expect(commentThreads(replica)).toHaveLength(0)
    expect(history(await execute('edit.redo'))).toEqual({ canUndo: true, canRedo: false })
    expect(commentThreads(replica)).toHaveLength(1)
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    await execute('edit.undo')
    // The comment is undone; another Undo would reach the text, and is refused before it runs.
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(replica.text(root, 'body')).toBe('Hello')
    expect(commentThreads(replica)).toHaveLength(0)
    // A new comment drops what was undone: nothing is left to redo.
    await execute('comment.add')
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    expect(commentThreads(replica)).toHaveLength(1)
  })

  it("takes back and refuses an Undo whose engine history reaches past the commenter's comments", async () => {
    const { replica, root } = kdmDocument()
    await openAs('commenter')
    await execute('comment.add')
    // An engine whose own history holds an edit that is not the commenter's above their comment.
    replica.transact(person('owner'), (tx) => tx.textInsert(root, 'body', 0, '> '))
    const error = await refusal(execute('edit.undo'))
    expect(isReadOnlyError(error)).toBe(true)
    expect(String((error as Error).message)).toMatch(/changed more than comments/)
    expect(replica.text(root, 'body')).toBe('> Hello')
    expect(commentThreads(replica)).toHaveLength(1)
  })

  it('refuses Undo and Redo for a viewer', async () => {
    const { replica } = kdmDocument()
    await openAs('viewer')
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    expect(replica.text(replica.objectsOfType('Doc')[0], 'body')).toBe('Hello')
  })

  it('undoes and refuses a comment command that changed the content too', async () => {
    const { replica, root, state } = kdmDocument()
    await openAs('commenter')
    const error = await refusal(execute('comment.sneak'))
    expect(isReadOnlyError(error)).toBe(true)
    expect(String((error as Error).message)).toMatch(/changed more than comments/)
    expect(state.undone).toBe(1)
    expect(replica.text(root, 'body')).toBe('Hello')
    expect(commentThreads(replica)).toHaveLength(0)
    // What came before (the undo, another replica's edits) is not held against the next comment.
    replica.transact(person('owner'), (tx) => tx.textInsert(root, 'body', 0, '> '))
    await execute('comment.add')
    expect(commentThreads(replica)).toHaveLength(1)
    expect(state.undone).toBe(1)
  })
})

describe('the engine worker, editable', () => {
  it('runs edits and the backstop does not apply', async () => {
    const state = fakeDocument({ commits: ['slide.new'] })
    await open(false)
    await execute('slide.new')
    await execute('edit.undo')
    await handle({ method: 'tool', name: 'pointer', args: ['{}'], settled: true })
    await handle({ method: 'markSaved' })
    expect(state.ran).toEqual(['slide.new', 'edit.undo'])
    expect(state.undone).toBe(0)
  })

  it('never lets invoke reach the session methods that edit around the contract', async () => {
    fakeDocument()
    await open(false)
    for (const name of ['executeAs', 'undo', 'redo', 'importChanges', 'addBlobs']) {
      await expect(handle({ method: 'invoke', name, args: [] }), name).rejects.toThrow(/not open to editors/)
    }
  })
})

describe('the engine worker, schema versions (KitModel rule M5a)', () => {
  it('reads them when a document opens and after imports, for an engine that answers them', async () => {
    const { replica } = kdmDocument()
    let author: number | null = null
    Object.assign(fake.doc as object, { schemaVersion: () => 1, authorSchemaVersion: () => author })
    const opened = await handle({ method: 'open', manifest, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null })
    expect((opened.value as { schema: unknown }).schema).toEqual({ reads: 1, newestAuthor: null })
    // A newer kit's change arrives from the room.
    author = 3
    const changes = replica.exportChanges(Version.empty())
    const imported = await handle({ method: 'replicaImport', changes: changes.slice().buffer, blobs: new ArrayBuffer(0) })
    expect((imported.value as { info: { schema: unknown } }).info.schema).toEqual({ reads: 1, newestAuthor: 3 })
    // The person's own edits do not read them again.
    author = 4
    const edited = await execute('text.insert')
    expect((edited.value as { info: { schema: unknown } }).info.schema).toEqual({ reads: 1, newestAuthor: 3 })
  })

  it('has none for an engine that does not answer them, or has not made its replica', async () => {
    kdmDocument()
    const opened = await handle({ method: 'open', manifest, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null })
    expect((opened.value as { schema: unknown }).schema).toBeNull()
    kdmDocument(true)
    Object.assign(fake.doc as object, { schemaVersion: () => 1, authorSchemaVersion: () => 2 })
    const lazy = await handle({ method: 'open', manifest, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null })
    expect((lazy.value as { schema: unknown }).schema).toBeNull()
  })
})
