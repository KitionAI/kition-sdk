/**
 * The editor view (`/page/?path=<file>`): one workspace file in its kit's own editor, mounted with
 * `mountKit` in a frame of the kit's editor package (`/kits-ui/<kit>@<version>/`), as Kition's
 * `KitFrame.tsx` mounts it: the host's files (`host.ts`), KitFiles for a kit that asks for files
 * (`files.ts`), theme and language, the host's shortcuts; the Kit AI bridge's window for the file
 * (`bridge.ts`); and a banner while the agent has a headless draft of it, which opens its review.
 *
 * Before the editor it shows what keeps it from opening: no kit for the type, the kit's editor
 * package downloading (its progress) or not to be had, the file missing, the gateway unreachable.
 */
import { mountKit, type KitConnection, type KitFilesManifest } from '@kition/kit-host'
import type { GatewayPageDraft, GatewayPageStatus } from '../index'
import { Bridge } from './bridge'
import { filesOption } from './files'
import { GatewayError, type Gateway } from './gateway'
import { hostHandlers, readFile, stampFile } from './host'
import { bytes, kitLocale, t } from './i18n'
import { agentInspect, declaredEditorState } from './inspect'
import { chooseKit, extensionOf, shortName, type EditorEntry, type KitStatus } from './kits'
import { post } from './parent'
import { mountReview, type DraftListing } from './review'
import { kitTheme } from './theme'
import { dialog, h, panel, toast } from './ui'

/** The host's shortcuts the kit leaves to the page (it saves itself with Cmd+S). */
export const HOST_SHORTCUTS = ['Cmd+N', 'Cmd+O', 'Cmd+W', 'Cmd+T', 'Cmd+,', 'Cmd+Q', 'Cmd+P', 'Cmd+.']

/** Below this width (CSS pixels) the editor opens in its Focus display mode: toolbars clip otherwise. */
export const NARROW = 480

/** How often the page asks for the file's drafts besides the bridge's notices. */
const DRAFTS_EVERY_MS = 5000

const nameOf = (path: string) => path.split('/').pop() || path

/** The kit's package's `kit.json`, as far as the page reads it. */
type PackageManifest = { files?: KitFilesManifest; engine?: { editorState?: string[] } }

export class EditorView {
  private connection: KitConnection | null = null
  private frame: HTMLIFrameElement | null = null
  private kit: KitStatus | null = null
  private dirty = false
  private revision = 0
  private status: GatewayPageStatus = 'opening'
  private readonly cleanups: Array<() => void> = []
  private draft: GatewayPageDraft = null
  private readonly held = { version: null as string | null }
  private reviewing: { close: () => void } | null = null

  constructor(
    private readonly gateway: Gateway,
    private readonly bridge: Bridge,
    readonly path: string,
    private readonly root: HTMLElement,
    private readonly direct: boolean,
  ) {}

  /** What a test or a host may read. */
  get state() {
    return { path: this.path, kit: this.kit?.id ?? null, status: this.status, dirty: this.dirty, revision: this.revision, draft: this.draft, connection: this.connection }
  }

  private report(status: GatewayPageStatus, extra: { progress?: { done: number; total: number }; detail?: string } = {}) {
    this.status = status
    this.root.dataset.status = status
    document.title = `${nameOf(this.path)}${this.dirty ? ' •' : ''} — Kition`
    post({ type: 'state', path: this.path, title: nameOf(this.path), kit: this.kit?.id ?? null, status, dirty: this.dirty, ...extra })
  }

  private show(node: HTMLElement | null) {
    this.root.querySelector('.overlay')?.remove()
    if (node) this.root.append(node)
  }

  private unreachable(error: unknown) {
    this.show(panel('unreachable', t('unreachableTitle'), t('unreachable'), { detail: (error as Error)?.message, actions: [{ label: t('retry'), primary: true, run: () => void this.open(), testId: 'retry' }] }))
    this.report('unreachable', { detail: (error as Error)?.message })
  }

  async open() {
    this.close()
    this.show(panel('opening', t('opening', { name: nameOf(this.path) }), '', { busy: true }))
    this.report('opening')
    try {
      const [{ kits }, { editors }] = await Promise.all([this.gateway.json<{ kits: KitStatus[] }>('api/v1/kits'), this.gateway.json<{ editors: Record<string, EditorEntry> }>('api/v1/kits/editors')])
      const chosen = chooseKit(
        kits.map((kit) => ({ id: kit.id, edit: kit.extensions })),
        this.path,
      )
      this.kit = chosen ? (kits.find((kit) => kit.id === chosen.id) ?? null) : null
      if (!this.kit) {
        this.show(panel('no-kit', t('noKitTitle', { name: nameOf(this.path) }), t('noKit', { extension: extensionOf(this.path) || '?' })))
        this.report('no-kit')
        return
      }
      const editor = await this.editorPackage(editors[this.kit.id])
      if (!editor) return
      const file = await readFile(this.gateway, this.path)
      if (!file) {
        this.show(panel('missing', t('missingTitle', { name: nameOf(this.path) }), t('missing'), { actions: [{ label: t('retry'), run: () => void this.open(), testId: 'retry' }] }))
        this.report('missing')
        return
      }
      await this.mount(editor, file)
    } catch (error) {
      if (error instanceof GatewayError && (error.status === 0 || error.status === 401 || error.status >= 502)) this.unreachable(error)
      else this.failed(error)
    }
  }

  private failed(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    this.show(panel('failed', t('failedTitle', { name: nameOf(this.path) }), t('failed'), { detail, actions: [{ label: t('retry'), primary: true, run: () => void this.open(), testId: 'retry' }] }))
    this.report('failed', { detail })
  }

  /** The kit's editor package, installed first when it is not (its download followed); `null` when it cannot be had. */
  private async editorPackage(entry: EditorEntry | undefined): Promise<EditorEntry | null> {
    const kitName = this.kit!.name
    let current = entry
    if (current && !current.installed && current.available && !current.downloading) {
      await this.gateway.send('api/v1/kits/editors/install', { kit: this.kit!.id }).catch((error: unknown) => {
        current = { ...current!, failed: (error as Error).message }
      })
    }
    for (;;) {
      if (current?.installed && current.version && current.base) return current
      if (current?.failed && !current.downloading) {
        this.show(panel('not-installed', t('downloadFailedTitle', { kit: kitName }), current.failed, { actions: [{ label: t('retry'), primary: true, run: () => void this.open(), testId: 'retry' }] }))
        this.report('not-installed', { detail: current.failed })
        return null
      }
      if (!current || (!current.available && !current.downloading)) {
        this.show(panel('not-installed', t('notInstalledTitle', { kit: kitName }), t('notInstalled', { short: shortName(this.kit!.id) })))
        this.report('not-installed')
        return null
      }
      const progress = current.downloading
      const fraction = progress && progress.total > 0 ? progress.done / progress.total : null
      const words = progress && progress.total > 0 ? t('downloading', { done: bytes(progress.done), total: bytes(progress.total) }) : t('downloadingStarted')
      this.show(panel('downloading', t('downloadingTitle', { kit: kitName }), words, { progress: fraction, busy: true }))
      this.report('downloading', progress ? { progress } : {})
      await new Promise((resolve) => setTimeout(resolve, 400))
      const { editors } = await this.gateway.json<{ editors: Record<string, EditorEntry> }>('api/v1/kits/editors')
      current = editors[this.kit!.id]
    }
  }

  /** The address of the package's folder for the kit's frame: signed when the page holds a session (a frame sends no header). */
  private async packageAddress(base: string) {
    if (!this.direct) return this.gateway.url(base)
    const signed = await this.gateway.send<{ path: string }>('api/v1/gateway/sign', { path: `/${base}` })
    return this.gateway.url(signed.path)
  }

  /** The workspace root kit engines read the document's linked files from (lent files). */
  private async lendRoot() {
    if (!this.direct) return this.gateway.url('kit-files/')
    const signed = await this.gateway.send<{ path: string }>('api/v1/gateway/sign', { path: '/kit-files/' })
    return this.gateway.url(signed.path)
  }

  private async mount(editor: EditorEntry, file: { bytes: ArrayBuffer; stamp: string | null }) {
    const kit = this.kit!
    this.show(panel('opening', t('loadingEditor', { kit: kit.name }), '', { busy: true }))
    const folder = await this.packageAddress(editor.base!)
    const manifest = (await this.gateway
      .fetch(new URL('kit.json', folder).pathname.slice(this.gateway.root.length))
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)) as PackageManifest | null
    const editorState = declaredEditorState(manifest)
    const readOnly = false
    const files = manifest?.files ? filesOption(this.gateway, kit.id, this.path, manifest.files, readOnly, (path) => path === this.path && this.dirty) : null
    if (files) this.cleanups.push(() => void files.end())
    const lend = { root: await this.lendRoot(), folder: this.path.split('/').slice(0, -1).join('/') }
    this.held.version = file.stamp
    const frame = h('iframe', {
      class: 'kit-frame',
      title: nameOf(this.path),
      src: new URL('index.html', folder).href,
      allow: 'fullscreen; clipboard-read; clipboard-write',
      'data-testid': 'kit-frame',
    })
    this.frame = frame
    this.root.querySelector('.stage')?.replaceChildren(frame)
    const narrow = (this.root.clientWidth || window.innerWidth) < NARROW
    const abandon = new AbortController()
    this.cleanups.push(() => abandon.abort())
    const host = hostHandlers(this.gateway, kit.id, this.path, readOnly, this.held)
    let connection: KitConnection
    try {
      connection = await mountKit(frame, {
        signal: abandon.signal,
        origin: location.origin,
        host: { name: 'Kition gateway', version: '0.5.2' },
        document: { path: this.path, name: nameOf(this.path), bytes: file.bytes, version: file.stamp, lend },
        theme: kitTheme(),
        locale: kitLocale(),
        shortcuts: HOST_SHORTCUTS,
        ...(narrow ? { ui: { modes: { default: 'focus' } } } : {}),
        ...(files ? { files: files.option } : {}),
        handlers: {
          ...host,
          changed: (state) => {
            const by = (state as { by?: string }).by === 'agent' ? 'agent' : 'person'
            this.dirty = state.dirty
            this.revision = state.revision
            this.bridge.changed(this.path, state.revision, by)
            this.report('open')
          },
          notify: (notice) => {
            const level = notice.level === 'error' || notice.level === 'success' || notice.level === 'warning' ? notice.level : 'info'
            toast(notice.title, level, notice.description)
          },
          shortcut: (key) => {
            post({ type: 'shortcut', key })
            if (key.code === 'KeyW' && (key.meta || key.ctrl)) post({ type: 'request-close', path: this.path, dirty: this.dirty })
          },
        },
      })
    } catch (error) {
      this.failed(error)
      return
    }
    this.connection = connection
    this.show(null)
    this.report('open')
    this.cleanups.push(
      this.bridge.register({
        path: this.path,
        kit: kit.id,
        connection,
        readOnly,
        revision: () => this.revision,
        dirty: () => this.dirty,
        inspected: (answer) => agentInspect(answer, editorState),
      }),
    )
    this.cleanups.push(() => connection.close())
    this.watchDrafts()
    connection.focus()
  }

  /** The banner while the agent has a headless draft of the file, following it. */
  private watchDrafts() {
    const banner = this.root.querySelector<HTMLElement>('.banner')!
    let stopped = false
    const refresh = async () => {
      if (stopped) return
      const listed = await this.gateway.json<{ drafts: DraftListing[] }>('api/v1/kits/drafts').catch(() => null)
      if (!listed || stopped) return
      const found = listed.drafts.find((draft) => draft.path === this.path)
      const next: GatewayPageDraft = found ? { state: found.state === 'ready' ? 'ready' : 'open', stale: Boolean(found.stale), updated: found.updated ?? null } : null
      if (JSON.stringify(next) !== JSON.stringify(this.draft)) {
        this.draft = next
        post({ type: 'draft', path: this.path, draft: next })
      }
      if (!next) {
        banner.hidden = true
        banner.replaceChildren()
        return
      }
      const button = h('button', { type: 'button', class: 'button button--primary', 'data-testid': 'draft-review-open' }, t('review'))
      button.addEventListener('click', () => this.review())
      banner.replaceChildren(h('span', { class: 'banner__text' }, next.state === 'ready' ? t('draftBannerReady') : t('draftBanner')), button)
      banner.dataset.state = next.state
      banner.hidden = false
    }
    const listener = (method: string, params: Record<string, unknown>) => {
      if (method === 'kit/draftsChanged' && (!params.path || params.path === this.path)) void refresh()
    }
    this.bridge.listeners.add(listener)
    const timer = setInterval(() => void refresh(), DRAFTS_EVERY_MS)
    void refresh()
    this.cleanups.push(() => {
      stopped = true
      clearInterval(timer)
      this.bridge.listeners.delete(listener)
      banner.hidden = true
    })
  }

  /** Opens the review of the file's draft over the editor; after a merge the editor reads the file again. */
  review() {
    if (this.reviewing) return
    const content = h('div', { class: 'review-host' })
    const opened = dialog(t('reviewTitle', { name: nameOf(this.path) }), content, () => {
      review.close()
      this.reviewing = null
    }, t('close'))
    const review = mountReview(this.gateway, this.path, content, {
      beforeMerge: () => (this.dirty ? t('reviewSaveFirst') : null),
      onDone: (outcome) => {
        post({ type: 'reviewed', path: this.path, outcome })
        opened.close()
        if (outcome === 'merged') void this.followMerge()
        for (const listener of this.bridge.listeners) listener('kit/draftsChanged', { path: this.path })
      },
    })
    this.reviewing = opened
  }

  /** The file was replaced by a merge: the editor takes the new version (it has no unsaved edits). */
  private async followMerge() {
    const version = await stampFile(this.gateway, this.path)
    if (!version || !this.connection) return
    this.held.version = version
    this.connection.fileChanged(version)
  }

  /** Saves the document now (the host asked): whether it saved. */
  async save() {
    if (!this.connection) return { saved: false, error: 'no document is open' }
    try {
      const answer = await this.connection.save()
      return { saved: answer.saved }
    } catch (error) {
      toast(t('saveFailed'), 'error', (error as Error).message)
      return { saved: false, error: (error as Error).message }
    }
  }

  setTheme() {
    this.connection?.setTheme(kitTheme())
  }

  setLocale() {
    this.connection?.setLocale(kitLocale())
  }

  focus() {
    this.connection?.focus()
    this.frame?.focus()
  }

  get unsaved() {
    return this.dirty
  }

  close() {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
    this.connection = null
    this.frame?.remove()
    this.frame = null
  }
}
