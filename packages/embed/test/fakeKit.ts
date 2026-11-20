/**
 * A kit for tests, in place of `mountKit` and a kit page: it opens its document the way a kit's
 * editor does over the Kit UI protocol (the stored replica when its `fileStamp` matches the file,
 * otherwise a new replica made on first use, UI-R1), keeps a real KDM replica of one note, saves
 * through `host/write` and `host/replicaWrite`, and serves `replica/*` and `ai/*`. With the `draft`
 * capability it keeps an agent's draft of the note's text (section 7d); `merges` records each merge's origin.
 */
import { addThread, COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF, newDocId, parseSchema, person, Replica, Version } from '@kition/kdm'
import type { KitConnection, MountOptions } from '@kition/kit-host'

export const NOTE_SCHEMA = parseSchema({
  kdm: 1,
  kit: 'kit.note',
  schemaVersion: 1,
  root: 'Note',
  types: { Note: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
})

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

let actors = 1n

export class FakeEditor {
  private replica: Replica | null
  private readonly listeners = new Set<(version: ArrayBuffer) => void>()
  readonly imports: ArrayBuffer[] = []
  /** Every version the host said this document already holds (`document/held`). */
  readonly held: string[] = []
  /** Every lease list the host told this kit (`lease/changed`). */
  readonly leaseLists: unknown[][] = []
  /** Changed since it was opened or last saved; a save with nothing to write answers `saved: false`. */
  dirty = false
  closed = false
  /** Opened with `rebuildsOnOpen` and recorded the file on top of its stored replica. */
  rebuilt = false
  /** The agent's draft of the note's text, and its state, when the kit keeps drafts. */
  draftText: string | null = null
  draftState: 'none' | 'open' | 'ready' = 'none'
  /** Every list of the page's threads shown to this kit (`comments/show`). */
  readonly shown: unknown[][] = []
  /** Every merge's origin. */
  readonly merges: unknown[] = []
  readonly connection: KitConnection

  constructor(readonly options: MountOptions, stored: Replica | null, kitId: string, capabilities: string[]) {
    this.replica = stored
    const editor = this
    const replicaApi: KitConnection['replica'] = {
      version: async () => buffer(editor.ensure().version().encode()),
      exportChanges: async (since) => ({ changes: buffer(editor.ensure().exportChanges(since.byteLength ? Version.decode(new Uint8Array(since)) : Version.empty())), blobs: new ArrayBuffer(0) }),
      importChanges: async (changes) => {
        editor.imports.push(changes)
        editor.ensure().importChanges(new Uint8Array(changes))
        editor.dirty = true
        editor.changed()
        return { damage: null }
      },
      info: async () => editor.replica?.docId ?? null,
      onChanged: (listener) => {
        editor.listeners.add(listener)
        return () => editor.listeners.delete(listener)
      },
    }
    const keepsDrafts = capabilities.includes('draft')
    const noDraft = async (): Promise<never> => {
      throw new Error('the fake kit keeps no drafts')
    }
    const draftInfo = () => ({ state: editor.draftState, revision: editor.draftState === 'none' ? null : 1 })
    const draftMoved = () => options.handlers.draftChanged?.(draftInfo())
    const needDraft = () => {
      if (editor.draftState === 'none') throw new Error('there is no draft')
    }
    const closeDraft = () => {
      editor.draftText = null
      editor.draftState = 'none'
      draftMoved()
      return draftInfo()
    }
    this.connection = {
      kit: { id: kitId, version: '1.0.0' },
      capabilities,
      state: async () => ({ dirty: false, revision: 0, title: options.document.name }),
      save: () => editor.save(),
      fileChanged: () => undefined,
      setTheme: () => undefined,
      setLocale: () => undefined,
      focus: () => undefined,
      configure: () => undefined,
      leasesChanged: (leases) => editor.leaseLists.push(leases),
      peersChanged: () => undefined,
      reveal: () => undefined,
      fileHeld: (version) => editor.held.push(version),
      showComments: (threads) => editor.shown.push(threads),
      locateComments: async (anchors) => anchors.map(() => capabilities.includes('comment-anchors')),
      onPresence: () => () => undefined,
      elements: async () => [],
      check: async (check) => (check?.draft ? editor.draftText : editor.text())?.includes('#REF!') ? [{ code: 'note.broken', severity: 'error', target: {}, message: 'broken text' }] : [],
      ai: {
        inspect: async (inspect) => ({ path: options.document.path, kit: kitId, dirty: editor.dirty, revision: 0, summary: inspect?.draft ? (editor.draftText ?? '') : editor.text(), details: {} }),
        commands: async (query) => [{ id: 'note.append', title: 'Append text', enabled: true, query }],
        run: async (steps, save, run) => {
          if (run?.draft) {
            if (!keepsDrafts) throw new Error('the fake kit keeps no drafts')
            editor.draftText ??= editor.text()
            const completed = steps.map((step) => {
              if (step.command !== 'note.append') throw new Error(`unknown command ${step.command}`)
              editor.draftText += String(step.params?.text ?? '')
              return { command: step.command, changed: true, result: { text: editor.draftText } }
            })
            editor.draftState = 'open'
            draftMoved()
            return { completed, saved: false }
          }
          const completed = steps.map((step) => {
            editor.edit(String(step.params?.text ?? ''))
            return { command: step.command, changed: true, result: { text: editor.text() } }
          })
          return { completed, saved: save ? (await editor.save()).saved : false }
        },
        preview: async () => ({ png: '' }),
        premise: async () => {
          throw new Error('the fake kit does not answer premise reads')
        },
        // The fake kit keeps no replica (it lists no `changes`).
        version: async () => {
          throw new Error('the fake kit keeps no replica')
        },
        changes: async () => {
          throw new Error('the fake kit keeps no replica')
        },
      },
      replica: replicaApi,
      draft: keepsDrafts
        ? {
            state: async () => draftInfo(),
            ready: async () => {
              needDraft()
              editor.draftState = 'ready'
              draftMoved()
              return draftInfo()
            },
            reopen: async () => {
              needDraft()
              editor.draftState = 'open'
              draftMoved()
              return draftInfo()
            },
            compare: async () => {
              needDraft()
              return { summary: { created: [], changed: [{ id: 'note', type: 'Note', fields: ['body'] }], deleted: [], texts: [{ id: 'note', field: 'body', before: editor.text(), after: editor.draftText ?? '' }] }, before: null, after: null }
            },
            merge: async (origin) => {
              needDraft()
              editor.merges.push(origin)
              const added = (editor.draftText ?? '').slice(editor.text().length)
              const summary = { created: [], changed: [{ id: 'note', type: 'Note', fields: ['body'] }], deleted: [], texts: [] }
              editor.edit(added)
              closeDraft()
              return { merged: true, summary }
            },
            discard: async () => {
              needDraft()
              return closeDraft()
            },
          }
        : { state: async () => ({ state: 'none', revision: null }), ready: noDraft, reopen: noDraft, compare: noDraft, merge: noDraft, discard: noDraft },
      model: {
        describe: async () => {
          throw new Error('the fake kit does not answer the object model')
        },
        batch: async () => {
          throw new Error('the fake kit does not answer the object model')
        },
      },
      files: null,
      close: () => {
        editor.closed = true
      },
    }
  }

  /** The replica, made with a new document id on first use when the file opened plainly. */
  ensure() {
    this.replica ??= Replica.createWith(NOTE_SCHEMA, newDocId(), (actors += 1n), person('user:kit'), (tx) => tx.create('Note', {})).replica
    return this.replica
  }

  private note() {
    return this.ensure().objectsOfType('Note')[0]
  }

  text() {
    return this.ensure().text(this.note(), 'body')
  }

  /** A person typing at the end of the note. */
  edit(text: string) {
    if (this.options.document.readOnly) throw new Error('read-only')
    const replica = this.ensure()
    const note = this.note()
    replica.transact(person('user:kit'), (tx) => tx.textInsert(note, 'body', replica.textLength(note, 'body'), text))
    this.dirty = true
    this.changed()
    this.options.handlers.changed({ dirty: true, revision: 1, title: this.options.document.name, by: 'person' })
  }

  /** A person commenting on the note, as the kit's comment command does: allowed unless the document is view-only. */
  comment(body: string) {
    const { readOnly, comments } = this.options.document
    if (readOnly && !comments?.canComment) throw new Error('read-only')
    const replica = this.ensure()
    const author = comments?.me ?? 'anonymous'
    replica.transact(person(`user:${author}`), (tx) => addThread(tx, { object: this.note() }, { author, ...(comments?.name ? { name: comments.name } : {}), body, created: new Date(0).toISOString() }))
    this.changed()
  }

  private changed() {
    const version = buffer(this.ensure().version().encode())
    for (const listener of this.listeners) listener(version)
  }

  async save() {
    const { handlers, document } = this.options
    if (!this.dirty) return { saved: false, version: null }
    this.dirty = false
    const replica = this.ensure()
    const written = await handlers.write({ path: document.path, bytes: buffer(new TextEncoder().encode(this.text())), mode: 'save' })
    if (handlers.replicaWrite) await handlers.replicaWrite({ path: document.path, snapshot: buffer(replica.exportChanges()), blobs: new ArrayBuffer(0), fileStamp: written.version })
    return { saved: true, version: written.version }
  }
}

/**
 * `mountKit` for the embed: every editor it opened, in order. `rebuildsOnOpen`: the kit opens the
 * file with its stored replica as Slide, Doc and Sheet do, recording what the file holds that the
 * replica does not on top of it (here: the file's text, appended when the replica's differs), and
 * notes it (`rebuilt`).
 */
export function fakeKit(kitId = 'kit.note', capabilities = ['ai', 'replica'], { rebuildsOnOpen = false } = {}) {
  const editors: FakeEditor[] = []
  const mountKit = async (frame: HTMLIFrameElement, options: MountOptions): Promise<KitConnection> => {
    let stored: Replica | null = null
    let rebuilt = false
    if (options.handlers.replicaRead) {
      const kept = await options.handlers.replicaRead({ path: options.document.path })
      if (kept && kept.fileStamp === options.document.version) stored = Replica.load(NOTE_SCHEMA, new Uint8Array(kept.snapshot), (actors += 1n))
    }
    if (rebuildsOnOpen && stored) {
      const file = new TextDecoder().decode(options.document.bytes ?? new ArrayBuffer(0))
      const note = stored.objectsOfType('Note')[0]
      if (file && stored.text(note, 'body') !== file) {
        stored.transact(person('user:kit'), (tx) => tx.textInsert(note, 'body', stored!.textLength(note, 'body'), file))
        rebuilt = true
      }
    }
    const editor = new FakeEditor(options, stored, kitId, capabilities)
    editor.rebuilt = rebuilt
    editors.push(editor)
    return editor.connection
  }
  return { editors, mountKit, last: () => editors.at(-1)! }
}
