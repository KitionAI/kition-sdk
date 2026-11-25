/**
 * A kit for tests, in place of `mountKit` and a kit page: it opens its document the way a kit's
 * editor does over the Kit UI protocol (the stored replica when its `fileStamp` matches the file,
 * otherwise a new document made on first use, UI-R1), keeps one note and its comment threads,
 * saves through `host/write` and `host/replicaWrite`, and serves `replica/*` and `ai/*`. Its
 * replica answers KDM snapshots in the content encoding, so `@kition/kdm` reads them. With the
 * `model` capability it answers the object model for the note's text; with `draft` it keeps an
 * agent's draft of the note's text (section 7d); `merges` records each merge's origin.
 */
import { COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF, newDocId, newObjectId, parseSchema, uuidToBytes } from '@kition/kdm'
import type { KitConnection, MountOptions } from '@kition/kit-host'

export const NOTE_SCHEMA = parseSchema({
  kdm: 1,
  kit: 'kit.note',
  schemaVersion: 1,
  root: 'Note',
  types: { Note: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
})

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

type FakeComment = { id: string; author: string; name?: string; body: string; created: string }
type FakeThread = { id: string; anchor: { object: string }; resolved: boolean; comments: FakeComment[] }

/** The note as the kit holds it: its document, its line of changes and how far along it, its text and threads. */
type NoteState = { docId: string; lineage: string; seq: number; note: string; body: string; threads: FakeThread[] }

/** A JSON value with object keys in ascending order, as the content encoding writes it. */
function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${sorted(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The note's KDM snapshot (the content encoding with its version). */
function snapshotOf(state: NoteState): Uint8Array {
  const objects: Record<string, Record<string, unknown>> = { [state.note]: { $type: 'Note', body: state.body || undefined } }
  for (const thread of state.threads) {
    objects[thread.id] = { $type: 'CommentThread', anchor: thread.anchor, resolved: thread.resolved, comments: thread.comments.length ? thread.comments.map((comment) => comment.id) : undefined }
    for (const comment of thread.comments) objects[comment.id] = { $type: 'Comment', author: comment.author, name: comment.name, body: comment.body || undefined, created: comment.created }
  }
  const ids = Object.keys(objects).sort()
  const header = `{"kdm":1,"kit":"kit.note","docId":${JSON.stringify(state.docId)},"version":{"lineage":${JSON.stringify(state.lineage)},"seq":${state.seq}},"schemaVersion":1,"objects":{`
  const lines = ids.map((id, index) => `${JSON.stringify(id)}:${sorted(objects[id])}${index < ids.length - 1 ? ',' : ''}`)
  return new TextEncoder().encode(`${[header, ...lines, '}}'].join('\n')}\n`)
}

/** A snapshot this fake wrote, read back. */
function stateOf(snapshot: ArrayBuffer): NoteState {
  const content = JSON.parse(new TextDecoder().decode(snapshot)) as { docId: string; version: { lineage: string; seq: number }; objects: Record<string, Record<string, unknown>> }
  const objects = content.objects
  const note = Object.keys(objects).find((id) => objects[id].$type === 'Note')!
  const threads = Object.entries(objects)
    .filter(([, object]) => object.$type === 'CommentThread')
    .map(([id, object]) => ({
      id,
      anchor: object.anchor as { object: string },
      resolved: Boolean(object.resolved),
      comments: ((object.comments as string[] | undefined) ?? []).map((comment) => {
        const fields = objects[comment]
        return { id: comment, author: fields.author as string, ...(fields.name !== undefined ? { name: fields.name as string } : {}), body: (fields.body as string | undefined) ?? '', created: fields.created as string }
      }),
    }))
  return { docId: content.docId, lineage: content.version.lineage, seq: content.version.seq, note, body: (objects[note].body as string | undefined) ?? '', threads }
}

/** The version's bytes: the 16 lineage bytes and `seq` as 8 bytes big-endian. */
function versionOf(state: NoteState): Uint8Array {
  const out = new Uint8Array(24)
  out.set(uuidToBytes(state.lineage), 0)
  new DataView(out.buffer).setBigUint64(16, BigInt(state.seq))
  return out
}

/** An object-model refusal as the Kit UI protocol answers it. */
const refusal = (code: string, index: number | null, message: string) => Object.assign(new Error(message), { code: -32000, data: { code, index, message } })

export class FakeEditor {
  private state: NoteState | null
  private readonly listeners = new Set<(version: ArrayBuffer) => void>()
  /** Every version the host said this document already holds (`document/held`). */
  readonly held: string[] = []
  /** Changed since it was opened or last saved; a save with nothing to write answers `saved: false`. */
  dirty = false
  closed = false
  /** The agent's draft of the note's text, and its state, when the kit keeps drafts. */
  draftText: string | null = null
  draftState: 'none' | 'open' | 'ready' = 'none'
  /** Every list of the page's threads shown to this kit (`comments/show`). */
  readonly shown: unknown[][] = []
  /** Every merge's origin. */
  readonly merges: unknown[] = []
  /** Every object-model batch the kit ran. */
  readonly batches: Array<Record<string, unknown>> = []
  readonly connection: KitConnection

  constructor(readonly options: MountOptions, stored: NoteState | null, kitId: string, capabilities: string[]) {
    this.state = stored
    const editor = this
    const replicaApi: KitConnection['replica'] = {
      version: async () => buffer(versionOf(editor.ensure())),
      // Always a snapshot, as a kit answers for a version it does not follow.
      exportChanges: async () => ({ changes: buffer(snapshotOf(editor.ensure())), blobs: new ArrayBuffer(0) }),
      importChanges: async () => {
        throw new Error('the fake kit takes no changes')
      },
      restore: async (snapshot) => {
        const { body, threads } = stateOf(snapshot)
        editor.write(() => {
          editor.ensure().body = body
          editor.ensure().threads = threads
        })
        return { damage: null }
      },
      info: async () => editor.state?.docId ?? null,
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
    const noModel = async (): Promise<never> => {
      throw new Error('the fake kit does not answer the object model')
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
      leasesChanged: () => undefined,
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
        // The fake kit keeps no change sets (it lists no `changes`).
        version: async () => {
          throw new Error('the fake kit keeps no change sets')
        },
        changes: async () => {
          throw new Error('the fake kit keeps no change sets')
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
      model: capabilities.includes('model')
        ? {
            describe: async () => ({ kit: kitId, schemaVersion: 1, root: 'Note', rootId: editor.ensure().note, types: NOTE_SCHEMA.types, commands: [] }),
            batch: async (params) => editor.batch(params),
          }
        : { describe: noModel, batch: noModel },
      files: null,
      close: () => {
        editor.closed = true
      },
    }
  }

  /** The note, made with a new document id on first use when the file opened plainly. */
  ensure(): NoteState {
    this.state ??= { docId: newDocId(), lineage: newDocId(), seq: 1, note: newObjectId(), body: '', threads: [] }
    return this.state
  }

  text() {
    return this.ensure().body
  }

  /** One change of the replica: `change` runs, the version moves, and the host hears of it. */
  private write(change: () => void) {
    change()
    this.ensure().seq += 1
    const version = buffer(versionOf(this.ensure()))
    for (const listener of this.listeners) listener(version)
  }

  /** A person typing at the end of the note. */
  edit(text: string) {
    if (this.options.document.readOnly) throw new Error('read-only')
    this.write(() => {
      this.ensure().body += text
    })
    this.dirty = true
    this.options.handlers.changed({ dirty: true, revision: 1, title: this.options.document.name, by: 'person' })
  }

  /** A person commenting on the note, as the kit's comment command does: allowed unless the document is view-only. */
  comment(body: string) {
    const { readOnly, comments } = this.options.document
    if (readOnly && !comments?.canComment) throw new Error('read-only')
    const author = comments?.me ?? 'anonymous'
    const state = this.ensure()
    this.write(() => {
      state.threads.push({ id: newObjectId(), anchor: { object: state.note }, resolved: false, comments: [{ id: newObjectId(), author, ...(comments?.name ? { name: comments.name } : {}), body, created: new Date(0).toISOString() }] })
    })
  }

  /** `model/batch` on the note's text: `text.insert` into `body`, the `note.append` command, and `load` of the root. */
  private batch(params: Record<string, unknown>) {
    this.batches.push(params)
    const state = this.ensure()
    const ops = (params.ops as Array<Record<string, unknown>> | undefined) ?? []
    const before = state.body
    const results: unknown[] = []
    ops.forEach((op, index) => {
      if (op.op !== 'command' && this.options.document.readOnly) throw refusal('read-only', index, 'the document is read-only')
      if (op.op === 'text.insert') {
        if (op.target !== 'root' && op.target !== state.note) throw refusal('not-found', index, `no object ${String(op.target)}`)
        if (op.field !== 'body') throw refusal('invalid-op', index, `Note has no text ${String(op.field)}`)
        state.body = state.body.slice(0, op.index as number) + String(op.text) + state.body.slice(op.index as number)
        results.push(null)
      } else if (op.op === 'command' && op.id === 'note.append') {
        state.body += String((op.params as { text?: unknown } | undefined)?.text ?? '')
        results.push({ text: state.body })
      } else {
        throw refusal('invalid-op', index, `the fake kit runs no ${String(op.op)}`)
      }
    })
    if (state.body !== before) {
      this.write(() => undefined)
      this.dirty = true
    }
    const loaded = ((params.load as Array<{ target: string }> | undefined) ?? []).map(({ target }) => {
      if (target !== 'root' && target !== state.note) throw refusal('not-found', null, `no object ${target}`)
      return { id: state.note, type: 'Note', fields: { body: state.body } }
    })
    return { refs: {}, results, loaded, version: buffer(versionOf(state)) }
  }

  async save() {
    const { handlers, document } = this.options
    if (!this.dirty) return { saved: false, version: null }
    this.dirty = false
    const state = this.ensure()
    // The replica and its version are taken with the bytes, before the writes (UI-R6).
    const bytes = buffer(new TextEncoder().encode(this.text()))
    const snapshot = buffer(snapshotOf(state))
    const version = buffer(versionOf(state))
    const written = await handlers.write({ path: document.path, bytes, mode: 'save' })
    if (handlers.replicaWrite) await handlers.replicaWrite({ path: document.path, snapshot, blobs: new ArrayBuffer(0), fileStamp: written.version, version })
    return { saved: true, version: written.version }
  }
}

/** `mountKit` for the embed: every editor it opened, in order. */
export function fakeKit(kitId = 'kit.note', capabilities = ['ai', 'replica']) {
  const editors: FakeEditor[] = []
  const mountKit = async (frame: HTMLIFrameElement, options: MountOptions): Promise<KitConnection> => {
    let stored: NoteState | null = null
    if (options.handlers.replicaRead) {
      const kept = await options.handlers.replicaRead({ path: options.document.path })
      if (kept && kept.fileStamp === options.document.version) stored = stateOf(kept.snapshot)
    }
    const editor = new FakeEditor(options, stored, kitId, capabilities)
    editors.push(editor)
    return editor.connection
  }
  return { editors, mountKit, last: () => editors.at(-1)! }
}
