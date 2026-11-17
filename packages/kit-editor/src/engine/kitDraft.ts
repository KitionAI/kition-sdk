/**
 * An agent's draft of the open document (Kit UI protocol section 7d; standard 2.0 A12 to A15): a
 * second engine, in its own worker, on a fork of the document's replica. The agent's `ai/*` calls
 * with `draft: true` run there; the live document stays as it is until the person merges the
 * draft (its changes since the fork, taken into the document as one undo step labelled as the
 * agent's) or discards it. The draft lives in this page only: in a co-edited document it is the
 * person's own, and the room sees nothing of it until it is merged.
 */
import type { DraftComparison, DraftInfo, DraftOrigin, DraftSummary } from '@kition/kit-ui-protocol'
import type { KitEngine } from './kitEngine'

/** What a draft needs from the live document (`useKitDocument`'s `draft`). */
export type KitDraftHost = {
  /** Starts the draft's engine on a fork of the document; `base` is the version it forked at. */
  open: () => Promise<{ engine: KitEngine; base: ArrayBuffer }>
  merge: (changes: ArrayBuffer, blobs: ArrayBuffer, origin: DraftOrigin, schema: object | null) => Promise<DraftSummary>
  compare: (changes: ArrayBuffer, schema: object | null) => Promise<DraftSummary>
  /** A PNG of the live document (base64), or null when its engine cannot render. */
  preview: (maxSize: number) => Promise<string | null>
  /** Hears every change of the draft's state (`draft/changed`). */
  changed: (info: DraftInfo) => void
}

/** The whole document as a PNG, at most `maxSize` pixels on its longer side, as base64. */
export async function previewPng(engine: KitEngine, maxSize: number) {
  const scale = Math.min(1, maxSize / Math.max(1, engine.width, engine.height))
  const width = Math.max(1, Math.round(engine.width * scale))
  const height = Math.max(1, Math.round(engine.height * scale))
  const rgba = await engine.render(0, 0, scale, width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0)
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** A preview, or null when the engine cannot render one. */
async function previewOrNull(engine: KitEngine, maxSize: number) {
  try {
    return await previewPng(engine, maxSize)
  } catch {
    return null
  }
}

type Open = { engine: KitEngine; base: ArrayBuffer; state: 'open' | 'ready' }

const NO_DRAFT = 'there is no draft of this document: run the agent with `draft: true` first'

/** The draft of one open document. Calls are answered in the order they are made. */
export class KitDraft {
  private current: Open | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly host: KitDraftHost) {}

  /** The draft's state now. */
  info(): DraftInfo {
    const open = this.current
    return open ? { state: open.state, revision: open.engine.info.revision } : { state: 'none', revision: null }
  }

  /** Runs `work` after the calls made before it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private tell() {
    this.host.changed(this.info())
  }

  private need(): Open {
    if (!this.current) throw new Error(NO_DRAFT)
    return this.current
  }

  /**
   * The draft's engine, opened now when `create` and there is none. Work on it moves a ready draft
   * back to the agent (`open`).
   */
  engine(create: boolean): Promise<KitEngine> {
    return this.serial(async () => {
      if (this.closed) throw new Error('the document was closed')
      if (!this.current) {
        if (!create) throw new Error(NO_DRAFT)
        const { engine, base } = await this.host.open()
        if (this.closed) {
          engine.dispose()
          throw new Error('the document was closed')
        }
        this.current = { engine, base, state: 'open' }
        this.tell()
      }
      return this.current.engine
    })
  }

  /** The agent changed the draft: it is the agent's again, and the host hears the new revision. */
  edited() {
    if (!this.current) return
    this.current.state = 'open'
    this.tell()
  }

  /** The agent asks for review. */
  ready(): Promise<DraftInfo> {
    return this.serial(async () => {
      this.need().state = 'ready'
      this.tell()
      return this.info()
    })
  }

  /** Sends the draft back to the agent. */
  reopen(): Promise<DraftInfo> {
    return this.serial(async () => {
      this.need().state = 'open'
      this.tell()
      return this.info()
    })
  }

  /** The draft's changes since it was forked, with their blobs. */
  private changes(open: Open) {
    return open.engine.replicaExport(open.base.slice(0))
  }

  /** The comparison of the draft with the document now: what merging it changes, and both rendered. */
  compare(maxSize: number, schema: object | null): Promise<DraftComparison> {
    return this.serial(async () => {
      const open = this.need()
      const { changes } = await this.changes(open)
      const summary = await this.host.compare(changes, schema)
      const [before, after] = [await this.host.preview(maxSize), await previewOrNull(open.engine, maxSize)]
      return { summary, before, after }
    })
  }

  /**
   * Takes the draft into the document as one undo step recorded as `origin`, and closes it. Only
   * on the person's explicit approval (the host's to ensure); never a model's call.
   */
  merge(origin: DraftOrigin, schema: object | null): Promise<{ merged: boolean; summary: DraftSummary }> {
    return this.serial(async () => {
      const open = this.need()
      const { changes, blobs } = await this.changes(open)
      const summary = await this.host.merge(changes, blobs, origin, schema)
      this.close()
      return { merged: true, summary }
    })
  }

  /** Drops the draft; the document is untouched. */
  discard(): Promise<DraftInfo> {
    return this.serial(async () => {
      this.close()
      return this.info()
    })
  }

  private close() {
    const open = this.current
    if (!open) return
    this.current = null
    open.engine.dispose()
    this.tell()
  }

  /** The document's editor is (again) in use: drafts may open. */
  attach() {
    this.closed = false
  }

  /** The document closed: the draft goes with it (drafts are local, section 7d). */
  dispose() {
    this.closed = true
    const open = this.current
    this.current = null
    open?.engine.dispose()
  }
}
