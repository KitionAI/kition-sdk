/**
 * A development host for an embedded kit UI (a kit's `dev.html`): mounts the editor in an iframe
 * over the Kit UI protocol, with an in-memory workspace, so the kit can be run and tested without
 * Kition. It opens a sample file from the kit's package, or one chosen in the page.
 *
 * The page needs `<iframe id="kit">`, `<span id="status">`, and `<input id="file" type="file">`.
 * Tests drive it through `window.devHost`. `?role=viewer` or `?role=commenter` opens the document
 * read-only as that person would (Kit UI protocol `document.readOnly` and `document.comments`).
 * `?presence=1` (or `presence: true`) serves presence (capability `presence`, protocol section
 * 7e): the host keeps what the kit shares and tests play other people with `setPeers`. Schema
 * reports (`document/schema`, section 7f) are always kept.
 *
 * With `kitFiles` (the kit manifest's `files` lists, K15) it serves KitFiles 1.0 (protocol section
 * 7g) from the same in-memory folder: a scripted picker (`scriptPick`), a printer that records
 * what it printed, the grant log, and every `files/*` request the kit sent, for `checkNoPaths`.
 *
 * With `generate` (or `?generate=1`) it serves host generation (capability `generate`, protocol
 * section 7j): every `host/generate` is kept in `generated` and answered from `scriptGenerate`'s
 * queue (with nothing queued, it is refused as `unavailable`, no model configured). A purpose
 * that is neither defined nor the kit's own is refused as `not-allowed`, as every host does.
 *
 * With `open` (or `?open=1`) it serves opening (capabilities `open-file` and `open-url`, protocol
 * section 7i): every `host/open` and `host/openUrl` is kept in `opens` and answered with
 * `openAnswer`, without leaving the open document. A link resolves against the document's folder
 * (a leading `/` from the workspace root), a bare name to a file of that name; a missing one is
 * refused as `not-found` unless the request asks to create it, which adds an empty file.
 *
 * It always serves picking a file to link (`links/pick`, capability `links-pick`, protocol section
 * 7i, except for `?role=viewer` and `?role=commenter`): the next answer `scriptLinkPick` queued (workspace paths), or else the
 * workspace files `pickable` names that the request accepts, never the open document. Nothing is
 * copied: the kit gets each by its path from the document's folder and reads it with `host/read`.
 * `linkPicks` keeps every request.
 *
 * Picks (`host/pick`, `links/pick`, and KitFiles' `files/pick` to open) are answered the same way
 * for every request: a queued answer first (`scriptHostPick`, `scriptLinkPick`, `scriptPick`);
 * else, in an automated browser (`navigator.webdriver`, as Playwright's are) or with `?pick=first`,
 * at once: `host/pick` the first fitting workspace file, `links/pick` all of them, `files/pick`
 * nothing (cancelled); else (a person at the page, or `?pick=chooser`) a chooser lists the
 * fitting workspace files and "Choose from computer…", which copies the chosen files into the
 * workspace beside the document.
 *
 * With `lend: true` the workspace is lent to the engine (`document.lend`): every file is mirrored
 * to `devHostWorkspace()`, the Vite plugin from `./vite` (workspaceServer.mjs), under a path of
 * this page load, which answers the engine's ranged reads. The Workspace panel in the top bar
 * lists the files with their sizes and saves each to disk (exports included), and adds files.
 *
 * With `replica` (or `?replica=1`) it keeps each document's replica (capability `replica`, protocol
 * section 7); with `checkpoints` (or `?checkpoints=1`) also its checkpoints (capability
 * `checkpoints`, section 7m, with the replica); with `viewState` (or `?view-state=1`) the
 * person's view state of each document (capability `view-state`, section 7n). All three live in
 * `history` (history.ts), in memory for the page load and per workspace path, apart from the
 * files: `reload` reopens the document as the workspace holds it, keeping them, while `open`
 * opens a file alone (its replica is dropped and its checkpoints become unavailable).
 * `recordCheckpoint` plays the host recording its own (origin `save`, `agent`, ...).
 */
import { KitRpcError, mountKit, type KitCheckpoint, type KitConnection, type KitLinkRef, type KitLinksPickParams, type KitOpenParams, type KitGenerateErrorReason, type KitGenerateParams, type KitGenerateResult, type KitFileGrant, type KitFilesManifest, type KitFilesPickParams, type KitPeerPresence, type KitPresence, type KitSchemaReport, type KitUiConfig, type KitView } from '@kition/kit-host'
import { checkNoPaths, type PathLeak } from './checkNoPaths'
import { base64, DevHistory, type DevCheckpointRecord } from './history'
import { memoryFilesStorage, type MemoryFile } from './memoryFiles'
import { chooseFiles, devHostStrings, folderOf, WORKSPACE_PATH, WorkspaceFiles, workspacePanel } from './workspace'

export { checkNoPaths, isMimeType, isPathShaped, type PathLeak } from './checkNoPaths'
export { memoryFilesStorage, type MemoryFile } from './memoryFiles'
export { WORKSPACE_PATH, WorkspaceFiles, formatSize } from './workspace'
export { DEV_LABELLED_CHECKPOINTS, DEV_UNLABELLED_CHECKPOINTS, DevHistory, type DevCheckpointRecord } from './history'

type File = MemoryFile

/** What the scripted picker answers next: workspace paths (none: the person cancelled), or a function of the request. */
export type ScriptedPick = string[] | ((params: KitFilesPickParams) => string[])

/** What `host/pick` answers next: a workspace path (`null`: the person cancelled), or a function of the request. */
export type ScriptedHostPick = string | null | ((params: { purpose: string; accept: string[] }) => string | null)

/** What the link chooser answers next (`links/pick`): workspace paths (none: the person cancelled), or a function of the request. */
export type ScriptedLinkPick = string[] | ((params: KitLinksPickParams) => string[])

/** What a scripted `host/generate` answers: a result, a refusal with its reason, or a function of the request. */
export type ScriptedGenerate = KitGenerateResult | { refuse: KitGenerateErrorReason } | ((params: KitGenerateParams) => KitGenerateResult | { refuse: KitGenerateErrorReason } | Promise<KitGenerateResult | { refuse: KitGenerateErrorReason }>)

/** A display mode (Kit UI protocol section 9), as the UI configuration's `modes` names it. */
type KitDisplayMode = NonNullable<NonNullable<KitUiConfig['modes']>['default']>

export type DevHostOptions = {
  /** The sample opened at start, relative to the page (`./sample/Sample.kslide`). */
  sample?: string
  /** The editor's page, relative to this one. */
  entry?: string
  /** Workspace files `host/pick` and `links/pick` may answer with. */
  pickable?: RegExp
  /** Extra files put in the workspace before the sample opens (workspace path → URL). */
  files?: Record<string, string>
  /** The workspace folder the sample opens in (none: the workspace root), so its links resolve against it. */
  folder?: string
  /**
   * Lends the workspace to the engine (`document.lend`), as Kition lends a project's folder: the
   * kit's Vite config adds `devHostWorkspace()` from `@kition/sdk/dev-host/vite`, which serves the
   * engine's ranged reads of every workspace file.
   */
  lend?: boolean
  /**
   * How picks are answered when no answer is queued: `chooser` opens the chooser, `first` answers
   * at once as tests expect. Default: `first` in an automated browser (`navigator.webdriver`),
   * else `chooser`; `?pick=` overrides it.
   */
  pick?: 'chooser' | 'first'
  /** Serves presence (capability `presence`, protocol section 7e), as `?presence=1` does. */
  presence?: boolean
  /** The kit manifest's `files` lists (K15): serves KitFiles 1.0 (`files/*`) under them. */
  kitFiles?: KitFilesManifest
  /** Serves host generation (capability `generate`, protocol section 7j), as `?generate=1` does. */
  generate?: boolean
  /** Serves opening (capabilities `open-file` and `open-url`, protocol section 7i), as `?open=1` does. */
  open?: boolean
  /** Keeps each document's replica (capability `replica`, protocol section 7), as `?replica=1` does. */
  replica?: boolean
  /** Keeps each document's replica and its checkpoints (capabilities `replica` and `checkpoints`, section 7m), as `?checkpoints=1` does. */
  checkpoints?: boolean
  /** Keeps the person's view state of each document (capability `view-state`, section 7n), as `?view-state=1` does. */
  viewState?: boolean
}

/** A `host/open` or `host/openUrl` the editor sent, as `mountKit` checked it. */
export type DevOpen = { method: 'host/open'; params: KitOpenParams } | { method: 'host/openUrl'; params: { url: string } }

export type DevHost = {
  /** The workspace (path → bytes and version); with `lend`, every change is mirrored to the served workspace. */
  files: WorkspaceFiles
  /** Where the workspace is lent to the engine (`document.lend.root`), or `null` without `lend`. */
  lendRoot: string | null
  connection: () => KitConnection | null
  /**
   * Opens a file in the editor, alone: its stored replica is dropped and its checkpoints become
   * unavailable (its view state stays); `view` is where in it to show first (`document.view`).
   */
  open: (path: string, bytes: ArrayBuffer, options?: { view?: KitView }) => Promise<void>
  /**
   * Reloads the editor on the open document as the workspace holds it (its last save), keeping
   * its replica, checkpoints and view state, as reopening a file in Kition does.
   */
  reload: (options?: { view?: KitView }) => Promise<void>
  /** The replicas, checkpoints and view states kept (with `replica`, `checkpoints`, `viewState`): `replica(path)`, `checkpoints(path)` (newest first), `viewState(path)`. */
  history: DevHistory
  /**
   * Records a checkpoint as the host does (origin `save`, `agent`, ...) at the open document's
   * replica version (asked of the kit) and stored replica; `null` without them or without `checkpoints`.
   */
  recordCheckpoint: (record: DevCheckpointRecord) => Promise<KitCheckpoint | null>
  /** Every `document/changed` the editor sent. */
  changes: unknown[]
  /** Sends a UI configuration (`ui/configure`) and keeps it for the next open. */
  configure: (ui: KitUiConfig) => void
  /** Every `ui/action` the editor sent. */
  actions: unknown[]
  /** Switches the color scheme (`ui/theme`). */
  setScheme: (scheme: 'light' | 'dark') => void
  /** Every `presence/set` the editor sent, checked (with presence served). */
  presences: KitPresence[]
  /**
   * Plays the other people in the document: sends them as `presence/peers` (the whole list) and
   * again to each editor opened after (with presence served).
   */
  setPeers: (peers: KitPeerPresence[]) => void
  /** Every `document/schema` the editor sent: a newer kit edited the document. */
  schemas: KitSchemaReport[]
  /** Empty folders in the workspace (KitFiles), beside the folders the files' paths make. */
  folders: Set<string>
  /** Queues `host/pick`'s next answers, one per pick; with none queued it answers as the `pick` option says. */
  scriptHostPick: (...answers: ScriptedHostPick[]) => void
  /** Every `host/pick` the editor sent. */
  hostPicks: Array<{ purpose: string; accept: string[] }>
  /** Queues the picker's next answers (`files/pick`), one per pick; with none queued it answers as the `pick` option says (`first` cancels). */
  scriptPick: (...answers: ScriptedPick[]) => void
  /** Every grant (KitFiles section 7's grant log). */
  grants: KitFileGrant[]
  /** Every `files/*` request the editor sent, as it sent it. */
  fileRequests: Array<{ method: string; params: unknown }>
  /** Every print: its title and the PDF's size. `printAnswer` is what the print dialog answers. */
  prints: Array<{ title: string; size: number }>
  printAnswer: boolean
  /** The path-shaped strings in the editor's `files/*` requests (KitFiles section 13); none is a pass. */
  checkNoPaths: () => PathLeak[]
  /** Every `host/generate` the editor sent whose purpose a host accepts (with generation served). */
  generated: KitGenerateParams[]
  /** Queues the next `host/generate` answers, one per request; with none queued it is refused as `unavailable`. */
  scriptGenerate: (...answers: ScriptedGenerate[]) => void
  /** Every `host/open` and `host/openUrl` the editor sent (with opening served), in order. */
  opens: DevOpen[]
  /** What an open answers (`opened`); `false` plays a person who cancelled. */
  openAnswer: boolean
  /** Queues the link chooser's next answers (`links/pick`), one per pick; with none queued it answers as the `pick` option says (`first`: the `pickable` files). */
  scriptLinkPick: (...answers: ScriptedLinkPick[]) => void
  /** Every `links/pick` the editor sent, as `mountKit` checked it. */
  linkPicks: KitLinksPickParams[]
}

declare global {
  interface Window {
    devHost: DevHost
  }
}

const THEMES = {
  light: { colorScheme: 'light' as const, tokens: { '--kit-primary': '#5645d4', '--kit-surface': '#ffffff', '--kit-surface-muted': '#fafaf9', '--kit-canvas': '#f6f5f4', '--kit-text': '#1a1a1a', '--kit-text-muted': '#5d5b54', '--kit-border': '#e5e3df' } },
  dark: { colorScheme: 'dark' as const, tokens: { '--kit-primary': '#8b7ff0', '--kit-surface': '#1b1e23', '--kit-surface-muted': '#22262c', '--kit-canvas': '#15171b', '--kit-text': '#eceff1', '--kit-text-muted': '#a9b0ba', '--kit-border': '#33373e' } },
}

/** Whether `name` has one of the extensions in `accept` (with or without their dot); an empty list accepts any. */
export function accepts(accept: readonly string[] | undefined, name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return !accept?.length || accept.some((item) => item.replace(/^\./, '').toLowerCase() === extension)
}

/** The document's `readOnly` and `comments` for a `?role=` of `viewer` or `commenter`; nothing for another. */
export function roleInit(role: string | null) {
  if (role !== 'viewer' && role !== 'commenter') return {}
  return { readOnly: true, comments: { me: `dev-${role}`, name: role === 'viewer' ? 'Viewer' : 'Commenter', canComment: role === 'commenter', othersReadOnly: false } }
}

/** `path` with `.` and `..` segments resolved; `null` when it climbs above the workspace. */
function normalPath(path: string) {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * The workspace path a link names from the document at `from` (KitLinks 1.0 LR4): a path relative
 * to its folder (a leading `/` from the workspace root), or, for a bare name, the file with that
 * name, one of `from`'s extension first. A name with no file answers the path to create, beside
 * the document with its extension. `exists` says whether it is there; `null` is no workspace path.
 */
export function resolveLink(link: KitLinkRef, from: string, files: ReadonlySet<string> | ReadonlyMap<string, unknown>): { path: string; exists: boolean } | null {
  const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  if (link.path) {
    const path = normalPath(link.path.startsWith('/') ? link.path : `${folder}/${link.path}`)
    return path ? { path, exists: files.has(path) } : null
  }
  if (!link.name || link.name.includes('/')) return null
  const extension = from.includes('.') ? from.slice(from.lastIndexOf('.')) : ''
  const stem = (path: string) => (path.split('/').pop() ?? '').replace(/\.[^.]*$/, '').toLowerCase()
  const named = [...files.keys()].filter((path) => stem(path) === link.name!.toLowerCase())
  const found = named.find((path) => path.endsWith(extension)) ?? named[0]
  if (found) return { path: found, exists: true }
  const created = normalPath(`${folder}/${link.name}${extension}`)
  return created ? { path: created, exists: false } : null
}

const DISPLAY_MODES: readonly KitDisplayMode[] = ['menus', 'line', 'classic', 'focus']

/**
 * The `ui.modes` for a `?modes=` list (`classic`, `menus,focus`): only those allowed, the first the
 * default; nothing without one. A name that is not a display mode is dropped, with a warning.
 */
export function modesInit(param: string | null): KitUiConfig['modes'] {
  const modes: KitDisplayMode[] = []
  for (const name of (param ?? '').split(',').map((mode) => mode.trim()).filter(Boolean)) {
    if ((DISPLAY_MODES as readonly string[]).includes(name)) modes.push(name as KitDisplayMode)
    else console.warn(`kit-dev-host: ?modes= names an unknown display mode "${name}" (one of ${DISPLAY_MODES.join(', ')})`)
  }
  return modes.length ? { allowed: modes, default: modes[0] } : undefined
}

export function startDevHost(options: DevHostOptions = {}) {
  const search = new URLSearchParams(location.search)
  const files = new WorkspaceFiles()
  const strings = devHostStrings(search.get('locale') ?? navigator.language)
  const lendRoot = options.lend ? `${location.origin}${WORKSPACE_PATH}/${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)}/` : null
  files.lendRoot = lendRoot
  files.onLendFailed = () => {
    console.warn(strings.lendFailed)
    status.textContent = strings.lendFailed
  }
  const pickParam = search.get('pick')
  const pickMode: 'chooser' | 'first' = pickParam === 'chooser' || pickParam === 'first' ? pickParam : (options.pick ?? (navigator.webdriver ? 'first' : 'chooser'))
  const hostPickAnswers: ScriptedHostPick[] = []
  const hostPicks: Array<{ purpose: string; accept: string[] }> = []
  const frame = document.getElementById('kit') as HTMLIFrameElement
  const status = document.getElementById('status') as HTMLElement
  const picker = document.getElementById('file') as HTMLInputElement | null
  const changes: unknown[] = []
  const entry = options.entry ?? './index.html'
  const pickable = options.pickable ?? /\.(png|jpe?g|gif|svg|webp)$/i
  let connection: KitConnection | null = null
  const servesPresence = options.presence === true || new URLSearchParams(location.search).get('presence') === '1'
  const presences: KitPresence[] = []
  const schemas: KitSchemaReport[] = []
  let peers: KitPeerPresence[] = []
  const folders = new Set<string>()
  const picks: ScriptedPick[] = []
  const grants: KitFileGrant[] = []
  const fileRequests: Array<{ method: string; params: unknown }> = []
  const prints: Array<{ title: string; size: number }> = []
  const servesGenerate = options.generate === true || new URLSearchParams(location.search).get('generate') === '1'
  const generated: KitGenerateParams[] = []
  const generations: ScriptedGenerate[] = []
  const servesOpen = options.open === true || new URLSearchParams(location.search).get('open') === '1'
  const opens: DevOpen[] = []
  const linkPickAnswers: ScriptedLinkPick[] = []
  const linkPicks: KitLinksPickParams[] = []
  const servesCheckpoints = options.checkpoints === true || search.get('checkpoints') === '1'
  const servesReplica = servesCheckpoints || options.replica === true || search.get('replica') === '1'
  const servesViewState = options.viewState === true || search.get('view-state') === '1'
  const history = new DevHistory()
  let documentPath = ''

  const personalKey = `kit-dev-host:personal:${location.pathname}`
  const actions: unknown[] = []
  let scheme: 'light' | 'dark' = new URLSearchParams(location.search).get('scheme') === 'dark' ? 'dark' : 'light'
  // `?modes=classic` pins the editor's display mode (flow tests that click the Classic ribbon).
  const queryModes = modesInit(new URLSearchParams(location.search).get('modes'))
  let hostConfig: KitUiConfig = queryModes ? { modes: queryModes } : {}
  const personal = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(personalKey) ?? '[]') as string[]
    } catch {
      return []
    }
  }
  const current = (): KitUiConfig => ({ ...hostConfig, personal: { hide: personal() } })

  // A small panel in the header: paste a configuration, apply it, switch the scheme.
  const panel = document.createElement('details')
  panel.innerHTML = '<summary>UI configuration</summary><textarea rows="6" cols="60" spellcheck="false">{}</textarea><button type="button">Apply</button><select><option value="light">Light</option><option value="dark">Dark</option></select>'
  const workspace = workspacePanel(files, () => folderOf(documentPath), strings)
  status.parentElement?.append(panel, workspace.panel)
  files.changed = workspace.render
  const field = panel.querySelector('textarea')!
  const select = panel.querySelector('select')!
  select.value = scheme
  panel.querySelector('button')!.addEventListener('click', () => {
    try {
      configure(JSON.parse(field.value) as KitUiConfig)
    } catch (error) {
      status.textContent = `configuration: ${error instanceof Error ? error.message : String(error)}`
    }
  })
  select.addEventListener('change', () => setScheme(select.value === 'dark' ? 'dark' : 'light'))

  function configure(ui: KitUiConfig) {
    hostConfig = { hide: ui.hide, disable: ui.disable, add: ui.add, modes: ui.modes ?? queryModes }
    field.value = JSON.stringify(hostConfig, null, 2)
    connection?.configure(current())
  }

  function setScheme(next: 'light' | 'dark') {
    scheme = next
    select.value = next
    connection?.setTheme(THEMES[next])
  }

  async function open(path: string, bytes: ArrayBuffer, openOptions: { view?: KitView } = {}) {
    files.set(path, { bytes, version: 1 })
    // A file opened alone starts without a replica (UI-R3, UI-C5).
    history.forget(path)
    await mount(path, openOptions)
  }

  async function reload(openOptions: { view?: KitView } = {}) {
    if (!documentPath || !files.has(documentPath)) throw new Error('no document is open')
    await mount(documentPath, openOptions)
  }

  async function recordCheckpoint(record: DevCheckpointRecord) {
    if (!servesCheckpoints || !connection) return null
    const version = await connection.replica.version().catch(() => null)
    return version ? history.record(documentPath, base64(version), record) : null
  }

  async function mount(path: string, openOptions: { view?: KitView }) {
    connection?.close()
    connection = null
    documentPath = path
    status.textContent = `opening ${path}…`
    // The kit announces itself when it loads (protocol section 1); mountKit waits for that.
    frame.src = `${entry}?${Date.now()}`
    const file = files.get(path)!
    let mine: KitConnection | null = null
    const kept = history.handlers(path, String(file.version), async () => (mine ? mine.replica.version() : null))
    try {
      mine = connection = await mountKit(frame, {
        origin: location.origin,
        host: { name: 'Development host', version: '1' },
        document: {
          path,
          name: path.split('/').pop() ?? path,
          bytes: file.bytes.slice(0),
          version: String(file.version),
          lend: lendRoot ? { root: lendRoot, folder: folderOf(path) } : undefined,
          ...roleInit(new URLSearchParams(location.search).get('role')),
          ...(openOptions.view ? { view: openOptions.view } : {}),
        },
        theme: THEMES[scheme],
        locale: new URLSearchParams(location.search).get('locale') ?? navigator.language,
        shortcuts: ['Cmd+W', 'Cmd+N', 'Cmd+O', 'Cmd+,'],
        ui: current(),
        handlers: {
          read: ({ path: wanted, offset, length }) => {
            const found = files.get(wanted)
            if (!found) throw new Error(`${wanted} is not in the workspace`)
            const start = offset ?? 0
            const bytes = offset != null || length != null ? found.bytes.slice(start, length != null ? start + length : undefined) : found.bytes.slice(0)
            return { bytes, version: String(found.version), size: found.bytes.byteLength }
          },
          stamp: ({ path: wanted }) => ({ version: files.has(wanted) ? String(files.get(wanted)!.version) : null }),
          write: ({ path: wanted, bytes, mode }) => {
            let target = wanted
            if (mode !== 'save') for (let number = 2; files.has(target); number += 1) target = wanted.replace(/(\.[^./]+)?$/, ` ${number}$1`)
            const version = (files.get(target)?.version ?? 0) + 1
            files.set(target, { bytes, version })
            return { path: target, version: String(version) }
          },
          // A workspace file the host may answer with and the kit accepts (`accept` lists extensions).
          pick: async (params) => {
            hostPicks.push(params)
            const next = hostPickAnswers.shift()
            if (next !== undefined) return { path: typeof next === 'function' ? next(params) : next }
            const fitting = pickableFiles(params.accept)
            if (pickMode === 'first') return { path: fitting[0] ?? null }
            const [chosen] = await chooseFiles(files, { candidates: fitting, accept: params.accept, multiple: false, folder: folderOf(documentPath), purpose: params.purpose }, strings)
            return { path: chosen ?? null }
          },
          // Files to link, in place (UI-N2): mountKit makes them document-relative links.
          pickLinks: async (params) => {
            linkPicks.push(params)
            const next = linkPickAnswers.shift()
            const fitting = pickableFiles(params.accept)
            const chosen = next
              ? typeof next === 'function'
                ? next(params)
                : next
              : pickMode === 'first'
                ? fitting
                : await chooseFiles(files, { candidates: fitting, accept: params.accept, multiple: params.multiple === true, folder: folderOf(documentPath), purpose: params.purpose }, strings)
            return chosen.filter((name) => files.has(name)).map((name) => ({ path: name, version: String(files.get(name)!.version) }))
          },
          openAgent: () => {
            status.textContent = 'the editor asked for the agent'
          },
          changed: (state) => {
            changes.push(state)
            status.textContent = `${path}: revision ${state.revision}${state.dirty ? ', unsaved' : ''}`
          },
          notify: (notice) => {
            status.textContent = `${notice.level}: ${notice.title}`
          },
          shortcut: (key) => {
            status.textContent = `host shortcut ${key.key}`
          },
          customize: ({ personal: kept }) => {
            localStorage.setItem(personalKey, JSON.stringify(kept.hide))
          },
          action: (params) => {
            actions.push(params)
            status.textContent = `host button ${params.id}`
          },
          schema: (report) => {
            schemas.push(report)
          },
          ...(servesPresence ? { presence: (presence: KitPresence) => void presences.push(presence) } : {}),
          ...(servesGenerate ? { generate: (params: KitGenerateParams) => generate(params) } : {}),
          ...(servesOpen ? { open: (params: KitOpenParams) => openLink(params), openUrl: (params: { url: string }) => openUrl(params) } : {}),
          ...(servesReplica ? { replicaRead: kept.replicaRead, replicaWrite: kept.replicaWrite } : {}),
          ...(servesCheckpoints ? { checkpoints: kept.checkpoints } : {}),
          ...(servesViewState ? { viewState: kept.viewState } : {}),
        },
        ...(options.kitFiles
          ? {
              files: {
                storage: memoryFilesStorage(files, () => (documentPath.includes('/') ? documentPath.slice(0, documentPath.lastIndexOf('/')) : ''), folders),
                kit: 'dev-kit',
                principal: 'dev-person',
                manifest: options.kitFiles,
                pick: async (params: KitFilesPickParams) => {
                  const next = picks.shift()
                  if (next) return typeof next === 'function' ? next(params) : next
                  if (pickMode === 'first' || params.mode !== 'open') return []
                  const fitting = [...files.keys()].filter((name) => name !== documentPath && !name.split('/').some((part) => part.startsWith('.')) && accepts(params.accept, name))
                  return chooseFiles(files, { candidates: fitting, accept: params.accept, multiple: params.multiple === true, folder: folderOf(documentPath), purpose: params.purpose }, strings)
                },
                print: async ({ bytes: pdf, title }: { bytes: Uint8Array; title: string }) => {
                  prints.push({ title, size: pdf.byteLength })
                  return window.devHost.printAnswer
                },
                log: (grant: KitFileGrant) => void grants.push(grant),
                trace: (method: string, params: unknown) => void fileRequests.push({ method, params }),
              },
            }
          : {}),
      })
      if (servesPresence && peers.length) connection.peersChanged(peers)
      status.textContent = `${path} open in ${connection.kit.id} ${connection.kit.version}`
    } catch (error) {
      status.textContent = `could not open ${path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** The workspace files `pickable` names that `accept` takes, never the open document. */
  function pickableFiles(accept: readonly string[]) {
    return [...files.keys()].filter((name) => name !== documentPath && pickable.test(name) && accepts(accept, name))
  }

  async function generate(params: KitGenerateParams): Promise<KitGenerateResult> {
    generated.push(params)
    status.textContent = `the editor asked to generate for ${params.purpose}`
    const next = generations.shift() ?? { refuse: 'unavailable' as const }
    const answer = typeof next === 'function' ? await next(params) : next
    if ('refuse' in answer) throw new KitRpcError(-32000, `the development host refused: ${answer.refuse}`, { reason: answer.refuse })
    return answer
  }

  async function openLink(params: KitOpenParams) {
    opens.push({ method: 'host/open', params })
    status.textContent = `the editor asked to open ${JSON.stringify(params.link)}`
    const target = resolveLink(params.link, documentPath, files)
    if (!target) throw new KitRpcError(-32000, 'the link is not in the workspace', { reason: 'not-found' })
    if (!target.exists) {
      if (!params.create) throw new KitRpcError(-32000, `${target.path} is not in the workspace`, { reason: 'not-found' })
      files.set(target.path, { bytes: new ArrayBuffer(0), version: 1 })
    }
    return { opened: window.devHost.openAnswer }
  }

  async function openUrl(params: { url: string }) {
    opens.push({ method: 'host/openUrl', params })
    status.textContent = `the editor asked to open ${params.url}`
    return { opened: window.devHost.openAnswer }
  }

  function setPeers(next: KitPeerPresence[]) {
    peers = next
    if (servesPresence) connection?.peersChanged(next)
  }

  window.devHost = {
    files,
    lendRoot,
    connection: () => connection,
    open,
    reload,
    history,
    recordCheckpoint,
    changes,
    configure,
    actions,
    setScheme,
    presences,
    setPeers,
    schemas,
    folders,
    scriptHostPick: (...answers) => void hostPickAnswers.push(...answers),
    hostPicks,
    scriptPick: (...answers) => void picks.push(...answers),
    grants,
    fileRequests,
    prints,
    printAnswer: true,
    checkNoPaths: () => checkNoPaths(fileRequests),
    generated,
    scriptGenerate: (...answers) => void generations.push(...answers),
    opens,
    openAnswer: true,
    scriptLinkPick: (...answers) => void linkPickAnswers.push(...answers),
    linkPicks,
  }

  picker?.addEventListener('change', async () => {
    const chosen = picker.files?.[0]
    if (chosen) await open(chosen.name, await chosen.arrayBuffer())
  })

  void (async () => {
    for (const [name, url] of Object.entries(options.files ?? {})) {
      const response = await fetch(url).catch(() => null)
      if (response?.ok) files.set(name, { bytes: await response.arrayBuffer(), version: 1 })
    }
    if (!options.sample) {
      status.textContent = 'choose a file'
      return
    }
    const response = await fetch(options.sample).catch(() => null)
    if (!response?.ok) {
      status.textContent = 'choose a file'
      return
    }
    // A lent document keeps its folder in its path, so its links resolve against it.
    const name = decodeURIComponent(options.sample.split('/').pop() ?? 'Sample')
    await open(options.folder ? `${options.folder}/${name}` : name, await response.arrayBuffer())
  })()
}
