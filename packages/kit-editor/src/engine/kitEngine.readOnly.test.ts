// @vitest-environment jsdom
/**
 * The engine worker's read-only guard (`document.readOnly`), driven through its `handle` with a
 * fake kit module document: which calls it refuses by rule, and the backstop that undoes and refuses
 * an allowed call that still committed to the replica.
 *
 * The comment backstop reads what a change touched with `@kition/kdm`'s `ChangeAudit`; here the
 * fake engine's change exports are tokens (`{"after": seq}` or `{"snapshot": seq}`) and a stand-in
 * audit reads the object types each change of the fake engine's log touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KitModuleDocument, KitModuleManifest } from './kitModule'
import { commentCommands, editsDocument, isReadOnlyError, refusedReadOnly } from './readOnly'

const fake = vi.hoisted(() => ({ doc: null as unknown, log: [] as string[][] }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

vi.mock('@kition/kdm', () => {
  type Token = { snapshot?: number; after?: number }
  const read = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Token
  /** Follows the fake engine's log (`fake.log`, the object types each change touched, in order). */
  class ChangeAudit {
    private constructor(private seq: number) {}
    static load(bytes: Uint8Array) {
      const token = read(bytes)
      if (token.snapshot === undefined) throw new Error('not a snapshot')
      return new ChangeAudit(token.snapshot)
    }
    version() {
      return { encode: () => new Uint8Array([this.seq]) }
    }
    follow(bytes: Uint8Array) {
      this.touched(bytes)
    }
    touched(bytes: Uint8Array) {
      const token = read(bytes)
      if (token.snapshot !== undefined) {
        this.seq = token.snapshot
        return { objects: new Map<string, string | null>(), outside: true }
      }
      if (token.after !== this.seq) throw new Error('stale')
      const objects = new Map<string, string | null>()
      fake.log.slice(this.seq).forEach((types, index) => types.forEach((type) => objects.set(`${this.seq + index}:${type}`, type)))
      this.seq = fake.log.length
      return { objects, outside: false }
    }
  }
  const touchesOnlyComments = (touched: { objects: Map<string, string | null>; outside: boolean }) =>
    !touched.outside && [...touched.objects.values()].every((type) => type === 'CommentThread' || type === 'Comment')
  return { ChangeAudit, touchesOnlyComments }
})

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

/**
 * The commands that only read and that the command naming standard (2026-11-25) moved into `file`
 * (kition-plan tools/command-renames/maps/<kit>.json): each ran for a viewer under its old id, and
 * runs under its new one. Old id, new id, kit.
 */
const RENAMED_READS: Array<[string, string, string]> = [
  ['document.bytes', 'file.bytes', 'cad'],
  ['time', 'file.time', 'cad'],
  ['status', 'file.status', 'cad'],
  ['drawing.inspect', 'file.inspect', 'cad'],
  ['review.wordCount', 'file.wordCount', 'doc'],
  ['document.inspect', 'file.inspect', 'doc, layout, photo, sheet, slide, vector'],
  ['document.text', 'file.text', 'doc'],
  ['document.paragraph', 'file.paragraph', 'doc'],
  ['document.selection', 'file.selection', 'doc'],
  ['document.layout', 'file.layout', 'doc'],
  ['project.inspect', 'file.inspect', 'film'],
  ['document.list', 'file.list', 'layout'],
  ['document.history', 'file.history', 'layout'],
  ['doc_info', 'file.getInfo', 'pdf'],
  ['doc_hidden_info', 'file.getHiddenInfo', 'pdf'],
  ['doc_compare', 'file.compare', 'pdf'],
  ['doc_audit_space', 'file.auditSpace', 'pdf'],
  ['doc_inspect', 'file.inspect', 'pdf'],
  ['render_preview', 'file.render', 'pdf'],
  ['document.activate', 'file.activate', 'photo, vector'],
  ['document.move', 'file.move', 'photo'],
  ['document.pixel', 'file.pixel', 'photo'],
  ['document.sampleColor', 'file.sampleColor', 'photo'],
  ['document.presets.list', 'file.presets.list', 'photo'],
  ['document.presets.get', 'file.presets.get', 'photo'],
  ['table.documents.get', 'file.get', 'table'],
  ['table.import.preview', 'file.previewImport', 'table'],
  ['table.read', 'file.read', 'table'],
  ['table.file.render', 'file.render', 'table'],
  ['table.file.outline', 'file.outline', 'table'],
  ['document.node', 'file.node', 'vector'],
  ['document.find', 'file.find', 'vector'],
  ['document.json', 'file.json', 'vector'],
  ['document.serialize', 'file.serialize', 'vector'],
  ['document.formats', 'file.formats', 'vector'],
  ['document.pdfInfo', 'file.pdfInfo', 'vector'],
  ['document.info', 'file.getInfo', 'vector'],
  ['document.pdfSettings', 'file.pdfSettings', 'vector'],
  ['document.dxfInfo', 'file.dxfInfo', 'vector'],
]

describe('the read-only rules', () => {
  it('let the reads the command naming standard moved into file run where their old ids ran, for a viewer and a commenter', () => {
    const comments = commentCommands(['comment.add'], true)
    for (const [old, id, kit] of RENAMED_READS) {
      expect(editsDocument({ id: old, mutates: false }), `${old} (${kit}) before`).toBe(false)
      expect(editsDocument({ id, mutates: false }), `${id} (${kit}, was ${old})`).toBe(false)
      expect(refusedReadOnly({ id, mutates: false }, comments), `${id} for a commenter`).toBe(false)
      expect(refusedReadOnly({ id, mutates: false }, new Set()), `${id} for a viewer`).toBe(false)
    }
    // One id that reads in one kit edits in another, which flags it: Layout's file.activate, Doc's file.compare.
    expect(editsDocument({ id: 'file.activate', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'file.compare', mutates: true })).toBe(true)
    // CAD's history, renamed from `undo`, `u` and `redo`, stays refused whatever its flag.
    for (const id of ['edit.undoMany', 'edit.undoStep', 'edit.redoStep']) expect(editsDocument({ id, mutates: false }), id).toBe(true)
    // Nothing that writes the file runs.
    for (const id of ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.close', 'file.revert', 'file.import']) expect(editsDocument({ id, mutates: false }), id).toBe(true)
  })

  it('refuse edits, the history, and file commands that are not exports', () => {
    expect(editsDocument({ id: 'slide.new', mutates: true })).toBe(true)
    expect(editsDocument({ id: 'edit.undo', mutates: false })).toBe(true)
    expect(editsDocument({ id: 'file.save', mutates: false })).toBe(true)
    expect(editsDocument({ id: 'file.exportPdf', mutates: true })).toBe(false)
  })

  it('let viewing commands run whatever their kit flags', () => {
    expect(editsDocument({ id: 'view.zoomIn', mutates: true })).toBe(false)
    expect(editsDocument({ id: 'edit.selectAll', mutates: true })).toBe(false)
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

const KDM_CATALOG: Catalog = [
  { id: 'comment.add', mutates: true },
  { id: 'comment.sneak', mutates: true },
  { id: 'text.insert', mutates: true },
  { id: 'edit.undo', mutates: false },
  { id: 'file.save', mutates: false },
]

/** One step of the fake engine's history: what it does, how it is taken back, and the object types it touches. */
type Step = { apply: () => void; revert: () => void; types: string[] }

/**
 * A document whose replica is a text and its comment threads, with a log of the object types each
 * change touched (`fake.log`) and an undo history of its own: `comment.add` opens a thread,
 * `comment.sneak` opens one and edits the text as well, `text.insert` edits the text; the session's
 * undo takes the last back. `ownerEdit` is another person's edit in the same history. `lazy`: the
 * replica is made when its version is first asked for, as an engine's is.
 */
function kdmDocument(lazy = false) {
  fake.log = []
  const doc_ = { body: 'Hello', threads: 0 }
  const undoSteps: Step[] = []
  const redoSteps: Step[] = []
  const state = { ran: [] as string[], undone: 0, dirty: false, made: !lazy }
  const run = (step: Step) => {
    step.apply()
    fake.log.push(step.types)
  }
  const write = (step: Step) => {
    run(step)
    undoSteps.push(step)
    redoSteps.length = 0
  }
  const comment = (): Step => ({ apply: () => void (doc_.threads += 1), revert: () => void (doc_.threads -= 1), types: ['CommentThread', 'Comment'] })
  const insert = (at: number, text: string, types = ['Doc']): Step => {
    let was = ''
    return {
      apply: () => {
        was = doc_.body
        doc_.body = doc_.body.slice(0, at) + text + doc_.body.slice(at)
      },
      revert: () => void (doc_.body = was),
      types,
    }
  }
  const undo = () => {
    const step = undoSteps.pop()
    if (!step) return false
    step.revert()
    fake.log.push(step.types)
    redoSteps.push(step)
    return true
  }
  const redo = () => {
    const step = redoSteps.pop()
    if (!step) return false
    run(step)
    undoSteps.push(step)
    return true
  }
  // The owner's edit before the session: in the history, not the commenter's.
  write(insert(5, ''))
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
      const writes: Record<string, () => Step> = {
        'comment.add': comment,
        'comment.sneak': () => {
          const thread = comment()
          const text = insert(5, '!')
          return { apply: () => (thread.apply(), text.apply()), revert: () => (text.revert(), thread.revert()), types: ['CommentThread', 'Comment', 'Doc'] }
        },
        'text.insert': () => insert(5, '?'),
      }
      const made = writes[command]
      if (made) {
        write(made())
        state.dirty = true
      }
      // The engine's own history, which holds this replica's edits.
      if (command === 'edit.undo') undo()
      if (command === 'edit.redo') redo()
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
      return new Uint8Array([fake.log.length])
    },
    exportChanges: (since: Uint8Array) => new TextEncoder().encode(JSON.stringify(since.byteLength ? { after: since[0] } : { snapshot: fake.log.length })),
    importChanges: () => {
      fake.log.push(['Doc'])
      return '{"kind":"full"}'
    },
    addBlobs: () => undefined,
    blobs: () => new Uint8Array(),
    undo: () => {
      state.undone += 1
      undo()
      return '{"done":true}'
    },
    redo: () => {
      redo()
      return '{"done":true}'
    },
    canUndo: () => undoSteps.length > 0,
    canRedo: () => redoSteps.length > 0,
  }
  fake.doc = doc as unknown as KitModuleDocument
  return {
    state,
    text: () => doc_.body,
    threads: () => doc_.threads,
    canUndo: () => undoSteps.length > 0,
    ownerEdit: (text: string) => write(insert(0, text)),
  }
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
    const { threads, state } = kdmDocument()
    await openAs('commenter')
    const answer = await execute('comment.add')
    expect(threads()).toBe(1)
    expect(state.undone).toBe(0)
    expect((answer.value as { info: { dirty: boolean } }).info.dirty).toBe(false)
    // The file is not a commenter's to save.
    expect(isReadOnlyError(await refusal(handle({ method: 'markSaved' })))).toBe(true)
  })

  it("makes the replica for a commenter's first comment, where comments live", async () => {
    const { threads, state } = kdmDocument(true)
    await openAs('commenter')
    await execute('comment.add')
    expect(state.made).toBe(true)
    expect(threads()).toBe(1)
    expect(state.undone).toBe(0)
  })

  it('refuses a comment command for a viewer and runs none of it', async () => {
    const { threads, state } = kdmDocument()
    await openAs('viewer')
    expect(isReadOnlyError(await refusal(execute('comment.add')))).toBe(true)
    expect(state.ran).toEqual([])
    expect(threads()).toBe(0)
  })

  it('runs the reads the command naming standard moved into file for a commenter, as before the rename', async () => {
    const { state } = kdmDocument()
    await openAs('commenter')
    const ids = [...new Set(RENAMED_READS.map(([, id]) => id))]
    for (const id of ids) await execute(id)
    expect(state.ran).toEqual(ids)
  })

  it('refuses every edit that is not a comment command, the history and file commands even when listed', async () => {
    const { text, state } = kdmDocument()
    await openAs('commenter')
    for (const command of ['text.insert', 'edit.undo', 'file.save']) expect(isReadOnlyError(await refusal(execute(command))), command).toBe(true)
    expect(state.ran).toEqual([])
    expect(text()).toBe('Hello')
  })

  it("undoes and redoes the commenter's own comments, and nothing before them", async () => {
    const { text, threads, canUndo } = kdmDocument()
    await openAs('commenter')
    const history = (answer: { value: unknown }) => {
      const { canUndo, canRedo } = (answer.value as { info: { canUndo: boolean; canRedo: boolean } }).info
      return { canUndo, canRedo }
    }
    // Nothing of theirs yet: the owner's edit before the session is not theirs to undo.
    expect(canUndo()).toBe(true)
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(history(await execute('comment.add'))).toEqual({ canUndo: true, canRedo: false })
    expect(history(await execute('edit.undo'))).toEqual({ canUndo: false, canRedo: true })
    expect(threads()).toBe(0)
    expect(history(await execute('edit.redo'))).toEqual({ canUndo: true, canRedo: false })
    expect(threads()).toBe(1)
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    await execute('edit.undo')
    // The comment is undone; another Undo would reach the text, and is refused before it runs.
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(text()).toBe('Hello')
    expect(threads()).toBe(0)
    // A new comment drops what was undone: nothing is left to redo.
    await execute('comment.add')
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    expect(threads()).toBe(1)
  })

  it("takes back and refuses an Undo whose engine history reaches past the commenter's comments", async () => {
    const { text, threads, ownerEdit } = kdmDocument()
    await openAs('commenter')
    await execute('comment.add')
    // An engine whose own history holds an edit that is not the commenter's above their comment.
    ownerEdit('> ')
    const error = await refusal(execute('edit.undo'))
    expect(isReadOnlyError(error)).toBe(true)
    expect(String((error as Error).message)).toMatch(/changed more than comments/)
    expect(text()).toBe('> Hello')
    expect(threads()).toBe(1)
  })

  it('refuses Undo and Redo for a viewer', async () => {
    const { text } = kdmDocument()
    await openAs('viewer')
    expect(isReadOnlyError(await refusal(execute('edit.undo')))).toBe(true)
    expect(isReadOnlyError(await refusal(execute('edit.redo')))).toBe(true)
    expect(text()).toBe('Hello')
  })

  it('undoes and refuses a comment command that changed the content too', async () => {
    const { text, threads, state, ownerEdit } = kdmDocument()
    await openAs('commenter')
    const error = await refusal(execute('comment.sneak'))
    expect(isReadOnlyError(error)).toBe(true)
    expect(String((error as Error).message)).toMatch(/changed more than comments/)
    expect(state.undone).toBe(1)
    expect(text()).toBe('Hello')
    expect(threads()).toBe(0)
    // What came before (the undo, another replica's edits) is not held against the next comment.
    ownerEdit('> ')
    await execute('comment.add')
    expect(threads()).toBe(1)
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
    kdmDocument()
    let author: number | null = null
    Object.assign(fake.doc as object, { schemaVersion: () => 1, authorSchemaVersion: () => author })
    const opened = await handle({ method: 'open', manifest, name: 'a.pptx', bytes: new ArrayBuffer(1), lent: null, replica: null })
    expect((opened.value as { schema: unknown }).schema).toEqual({ reads: 1, newestAuthor: null })
    // A newer kit's change arrives from the room.
    author = 3
    const imported = await handle({ method: 'replicaImport', changes: new Uint8Array([1]).buffer, blobs: new ArrayBuffer(0) })
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
