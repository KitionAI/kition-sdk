/**
 * An integrator's page embedding Kition's Note editor with `@kition/embed`: its own
 * file storage (memory + IndexedDB), its own users (Kition Server's development tokens, and a directory
 * that names them, `identity.users`), what each may do (`identity.permissions`), a button of its own
 * in the editors (`ui`), and, when co-editing is on, rooms on a `kition-sync/1` server it names. The
 * kit package comes from another origin (serve.mjs); nothing here reaches into its frame. Another
 * kit's package goes into `KITS` the same way.
 */
import { KitionEmbed, relayAgentPort, type CollabState, type EmbedEditor, type EmbedKit, type EmbedUser, type IdentityProvider, type PermissionMode } from '@kition/embed'
import { noteKit, type Note, type NoteCommands } from '@kition/script/kits/note'
import { quarterlyReview } from '../../sdk-scripts/review.mjs'
import { FileStore, type ExampleFile } from './storage'
import { WorkspaceFileStore } from './workspace-storage'
import './style.css'

declare const __KITS_ORIGIN__: string
/** Whether the server keeps the files (serve.mjs with EMBED_WORKSPACE). */
declare const __WORKSPACE__: boolean

const KITS: Record<string, EmbedKit & { extensions: string[] }> = {
  note: { id: 'kit.note', url: `${__KITS_ORIGIN__}/note-ui/`, extensions: ['.md', '.markdown'] },
}

const USERS = {
  alice: { token: 'dev-alice', id: 'dev:alice', name: 'Alice' },
  bob: { token: 'dev-bob', id: 'dev:bob', name: 'Bob' },
} as const
type UserKey = keyof typeof USERS

/** The page's own directory of people, by the ids their sign-in gives them: the names others see. */
const DIRECTORY: Record<string, EmbedUser> = {
  'dev:alice': { id: 'dev:alice', name: 'Alice Adams', avatar: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E' },
  'dev:bob': { id: 'dev:bob', name: 'Bob Brown', avatar: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E' },
}

const SETTINGS = 'embed-app.settings.v1'
const HIDES = 'embed-app.hides.v1'
type Settings = { user: UserKey; collab: boolean; server: string; mode: PermissionMode }
const MODES: PermissionMode[] = ['edit', 'comment', 'view']

function loadSettings(): Settings {
  const stored = JSON.parse(localStorage.getItem(SETTINGS) || '{}') as Partial<Settings>
  const params = new URLSearchParams(location.search)
  const user = (params.get('user') ?? stored.user) as UserKey | undefined
  return {
    user: user && user in USERS ? user : 'alice',
    collab: params.has('collab') ? params.get('collab') === '1' : (stored.collab ?? false),
    server: params.get('server') ?? stored.server ?? 'ws://127.0.0.1:18300/v1/sync',
    mode: MODES.find((mode) => mode === params.get('mode')) ?? (stored.mode && MODES.includes(stored.mode) ? stored.mode : 'edit'),
  }
}

const settings = loadSettings()
const saveSettings = () => localStorage.setItem(SETTINGS, JSON.stringify(settings))
saveSettings()

const $ = <T extends HTMLElement>(testId: string) => document.querySelector<T>(`[data-testid="${testId}"]`)!

function kitFor(name: string) {
  const lower = name.toLowerCase()
  const key = Object.keys(KITS).find((kit) => KITS[kit].extensions.some((extension) => lower.endsWith(extension)))
  return key ? { key, kit: KITS[key] } : null
}

let tokenCalls = 0
const identity: IdentityProvider = {
  // Asked on every connection: a real page would refresh an expiring token here.
  token: () => {
    tokenCalls += 1
    return USERS[settings.user].token
  },
  user: () => ({ id: USERS[settings.user].id, name: USERS[settings.user].name }),
  // Names and avatars for the people in a room and the authors of comments.
  users: (ids) => {
    usersAsked.push(...ids)
    return ids.flatMap((id) => (DIRECTORY[id] ? [DIRECTORY[id]] : []))
  },
  // What the person may do with a file: here, the page's "Open as" choice for every file.
  permissions: () => ({ mode: settings.mode }),
}
const usersAsked: string[] = []

/** The interface hides each person chose in the editors ("Customize interface…"), by kit. */
const hides = (): Record<string, string[]> => JSON.parse(localStorage.getItem(HIDES) || '{}') as Record<string, string[]>

const errors: string[] = []
function report(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  errors.push(message)
  const item = document.createElement('li')
  item.textContent = message
  $('errors').append(item)
}

type Pane = { file: ExampleFile; editor: EmbedEditor; element: HTMLElement; collab: CollabState; comments: string[]; agent: AbortController }
const panes = new Map<string, Pane>()

const store: Pick<FileStore, 'list' | 'get' | 'onChange' | 'add' | 'remove' | 'provider'> = __WORKSPACE__ ? await WorkspaceFileStore.open() : await FileStore.open()
const storage = store.provider()

/** The page's own link to a room: the room's share link with the kit and file name to open it with. */
function appLink(shareLink: string, file: ExampleFile) {
  const url = new URL(location.origin + location.pathname)
  url.searchParams.set('join', shareLink)
  url.searchParams.set('name', file.name)
  return url.href
}

async function openFile(file: ExampleFile, room?: string) {
  const found = kitFor(file.name)
  if (!found) throw new Error(`no kit opens ${file.name}`)
  if (panes.has(file.id)) return panes.get(file.id)!
  const element = document.createElement('section')
  element.className = 'card pane'
  element.dataset.pane = file.name
  element.innerHTML = `<header>
      <span class="title"></span>
      <span class="status" data-testid="pane-status" data-state="off">single-user</span>
      <input data-testid="share-link" readonly placeholder="share link" />
      <button class="button secondary small" data-testid="share-create">Share</button>
      <button class="button secondary small" data-testid="pane-script" hidden>Run script</button>
      <button class="button small" data-testid="pane-save">Save</button>
      <button class="button secondary small" data-testid="pane-close">Close</button>
    </header>
    <div class="review" data-testid="draft-review" hidden>
      <span data-testid="draft-summary"></span>
      <button class="button small" data-testid="draft-merge">Merge</button>
      <button class="button secondary small" data-testid="draft-discard">Discard</button>
    </div><div class="frame" data-testid="pane-frame"></div>`
  element.querySelector('.title')!.textContent = `${file.name} — ${USERS[settings.user].name}`
  $('panes').append(element)
  const editor = await KitionEmbed.mount(element.querySelector<HTMLElement>('.frame')!, {
    kit: { id: found.kit.id, url: found.kit.url },
    file: { id: file.id, name: file.name },
    storage,
    identity,
    ...(settings.collab ? { collaboration: { server: settings.server, ...(room ? { room } : {}) } } : {}),
    locale: 'en-US',
    theme: { colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' } },
    // The page's own button in the editor, and the person's own hides kept with the page.
    ui: {
      add: [{ id: 'example.submit', place: 'action', label: { 'en-US': 'Submit for review' }, icon: 'send' }],
      personal: { hide: hides()[found.kit.id] ?? [] },
      customize: ({ hide }) => localStorage.setItem(HIDES, JSON.stringify({ ...hides(), [found.kit.id]: hide })),
    },
    // The page edits notes through the object model too (the "Run script" button).
    model: found.key === 'note',
  })
  const pane: Pane = { file, editor, element, collab: editor.collab.state, comments: [], agent: new AbortController() }
  panes.set(file.id, pane)
  const status = element.querySelector<HTMLElement>('[data-testid="pane-status"]')!
  editor.on('collab', (state) => {
    pane.collab = state
    status.dataset.state = state.status
    status.textContent = state.status === 'off' ? 'single-user' : `${state.status}${state.role ? ` · ${state.role}` : ''}`
  })
  editor.on('presence', (peers) => {
    status.title = peers.map((peer) => peer.name).join(', ')
    element.dataset.peers = peers.map((peer) => peer.name).sort().join(',')
    element.dataset.avatars = String(peers.filter((peer) => peer.user?.avatar).length)
  })
  editor.on('comments', (threads) => {
    pane.comments = threads.flatMap((thread) => thread.comments.map((comment) => `${comment.user?.name ?? comment.name ?? comment.author}: ${comment.body}`))
    element.dataset.comments = String(pane.comments.length)
  })
  editor.on('action', ({ id }) => {
    $('notice').textContent = `action: ${id} on ${file.name}`
  })
  editor.on('error', report)
  editor.on('notify', (notice) => {
    $('notice').textContent = `${notice.level}: ${notice.message}${notice.description ? ` (${notice.description})` : ''}`
  })
  // The agent's draft, for the person to review: Merge and Discard run only on their click (UI-D1).
  const review = element.querySelector<HTMLElement>('[data-testid="draft-review"]')!
  editor.on('draft', (info) => {
    element.dataset.draft = info.state
    review.hidden = info.state !== 'ready'
    if (info.state !== 'ready') return
    void editor.draft
      .compare({ maxSize: 320 })
      .then(({ summary }) => {
        const counts = [`${summary.created.length} added`, `${summary.changed.length} changed`, `${summary.deleted.length} deleted`]
        review.querySelector('[data-testid="draft-summary"]')!.textContent = `The agent's draft: ${counts.join(', ')}`
      })
      .catch(report)
  })
  review.querySelector('[data-testid="draft-merge"]')!.addEventListener('click', () => void editor.draft.merge().catch(report))
  review.querySelector('[data-testid="draft-discard"]')!.addEventListener('click', () => void editor.draft.discard().catch(report))
  // With the files on the server, the integrator's agent reaches this editor through it
  // (serve.mjs relays /api/agent/<name>/mcp here); its edits go to a draft.
  if (__WORKSPACE__) void relayAgent(file.name, editor, pane.agent.signal)
  element.querySelector('[data-testid="pane-save"]')!.addEventListener('click', () => void editor.save().catch(report))
  const script = element.querySelector<HTMLButtonElement>('[data-testid="pane-script"]')!
  script.hidden = found.key !== 'note'
  script.addEventListener('click', () => void runReview(file.name).catch(report))
  element.querySelector('[data-testid="pane-close"]')!.addEventListener('click', () => closeFile(file.id))
  element.querySelector('[data-testid="share-create"]')!.addEventListener('click', () => {
    void editor.collab
      .shareLink('editor')
      .then((link) => {
        element.querySelector<HTMLInputElement>('[data-testid="share-link"]')!.value = appLink(link, store.get(file.id) ?? file)
      })
      .catch(report)
  })
  editor.ready().then(
    () => (element.dataset.ready = 'true'),
    (error: unknown) => {
      report(error)
      closeFile(file.id)
    },
  )
  return pane
}

/** Runs the example review script (examples/sdk-scripts/review.mjs) on an open note through the object model. */
async function runReview(name: string) {
  const pane = byName(name)
  if (!pane) throw new Error(`${name} is not open`)
  const note = await pane.editor.document(noteKit, { origin: { kind: 'extension', principal: 'example:quarterly-review' } })
  try {
    const result = await quarterlyReview(note)
    $('notice').textContent = `script: ${result.heading} (task ${result.task.checked ? 'done' : 'open'})`
    return result
  } finally {
    note.close()
  }
}

/** An open note as the object model reads it: its Markdown text. */
async function readNote(name: string) {
  const pane = byName(name)
  if (!pane) throw new Error(`${name} is not open`)
  const note = await pane.editor.document<Note, NoteCommands>(noteKit)
  try {
    return await note.run(async (context) => {
      context.root.load(['body'])
      await context.sync()
      return context.root.body.toString()
    })
  } finally {
    note.close()
  }
}

/** Pumps the agent's MCP messages for `name` from the server into the editor's agent port (`KitEmbed 1.3`). */
async function relayAgent(name: string, editor: EmbedEditor, signal: AbortSignal) {
  const base = `/api/agent/${encodeURIComponent(name)}`
  await editor.ready()
  await relayAgentPort(
    editor.agentPort({ principal: 'agent:example', label: 'Example agent' }),
    {
      next: async () => {
        const response = await fetch(`${base}/next`, { signal })
        return response.status === 204 ? null : await response.json()
      },
      reply: async (message) => {
        await fetch(`${base}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal })
      },
    },
    signal,
  )
}

function closeFile(fileId: string) {
  const pane = panes.get(fileId)
  if (!pane) return
  pane.agent.abort()
  pane.editor.destroy()
  pane.element.remove()
  panes.delete(fileId)
}

/** Opens a room from a link: the page's own link (with the file name), or a share link and a name. */
async function join(text: string) {
  let shareLink = text.trim()
  let name = ''
  try {
    const url = new URL(shareLink)
    if (url.origin === location.origin && url.searchParams.get('join')) {
      shareLink = url.searchParams.get('join')!
      name = url.searchParams.get('name') ?? ''
    }
  } catch {
    // A document id, not a URL.
  }
  if (!name || !kitFor(name)) throw new Error('the link does not say which kind of document it is: paste a link this page made')
  if (!settings.collab) {
    settings.collab = true
    saveSettings()
    $<HTMLInputElement>('collab-enabled').checked = true
  }
  // An empty file for the room's document: the editor stores the room's replica with it, and the
  // first save writes the document's bytes.
  const file = await store.add(name, new Uint8Array())
  return openFile(file, shareLink)
}

function renderFiles() {
  const list = $('files')
  list.replaceChildren()
  for (const file of store.list()) {
    const item = document.createElement('li')
    item.dataset.file = file.name
    item.innerHTML = `<span class="name"></span><span class="version"></span>
      <button class="button small" data-testid="file-open">Open</button>
      <button class="button secondary small" data-testid="file-download">⤓</button>
      <button class="button secondary small" data-testid="file-delete">✕</button>`
    item.querySelector('.name')!.textContent = file.name
    item.querySelector('.version')!.textContent = `v${file.version}`
    item.querySelector('[data-testid="file-open"]')!.addEventListener('click', () => void openFile(file).catch(report))
    item.querySelector('[data-testid="file-download"]')!.addEventListener('click', () => {
      const current = store.get(file.id) ?? file
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([current.bytes.slice().buffer as ArrayBuffer]))
      link.download = current.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 1_000)
    })
    item.querySelector('[data-testid="file-delete"]')!.addEventListener('click', () => {
      closeFile(file.id)
      void store.remove(file.id)
    })
    list.append(item)
  }
}

store.onChange(renderFiles)
renderFiles()

const userSelect = $<HTMLSelectElement>('user')
userSelect.value = settings.user
userSelect.addEventListener('change', () => {
  // The page's sync connection keeps the identity it was opened with: start over as the new person.
  settings.user = userSelect.value as UserKey
  saveSettings()
  const url = new URL(location.href)
  url.searchParams.delete('user')
  location.href = url.href
})
const collabBox = $<HTMLInputElement>('collab-enabled')
collabBox.checked = settings.collab
collabBox.addEventListener('change', () => {
  settings.collab = collabBox.checked
  saveSettings()
})
const serverField = $<HTMLInputElement>('server-url')
serverField.value = settings.server
serverField.addEventListener('change', () => {
  settings.server = serverField.value.trim()
  saveSettings()
})
const modeSelect = $<HTMLSelectElement>('mode')
modeSelect.value = settings.mode
modeSelect.addEventListener('change', () => {
  settings.mode = MODES.find((mode) => mode === modeSelect.value) ?? 'edit'
  saveSettings()
})
$<HTMLInputElement>('upload').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement
  for (const picked of [...(input.files ?? [])]) await store.add(picked.name, new Uint8Array(await picked.arrayBuffer()))
  input.value = ''
})
$('join-submit').addEventListener('click', () => void join($<HTMLInputElement>('join-link').value).catch(report))

const fromLink = new URLSearchParams(location.search).get('join')
if (fromLink) void join(location.href).catch(report)

const byName = (name: string) => [...panes.values()].find((pane) => pane.file.name === name) ?? null
const fileByName = (name: string) => store.list().find((file) => file.name === name) ?? null
const hex = (bytes: Uint8Array | null) => (bytes ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') : '')

/** A test hook for the end-to-end tests (examples/embed-app/e2e): read-only views of the page's state. */
declare global {
  interface Window {
    __EMBED_TEST__: unknown
  }
}
window.__EMBED_TEST__ = {
  files: () => store.list().map(({ id, name, version, saves, bytes }) => ({ id, name, version, saves, size: bytes.byteLength })),
  /** A file's bytes, base64. */
  bytes: (name: string) => {
    const file = fileByName(name)
    if (!file) return null
    let text = ''
    for (const byte of file.bytes) text += String.fromCharCode(byte)
    return btoa(text)
  },
  saves: (name: string) => fileByName(name)?.saves ?? 0,
  /** The open editor's replica version, lowercase hex ('' without one). */
  replicaVersion: async (name: string) => hex((await byName(name)?.editor.replicaVersion()) ?? null),
  collab: (name: string) => byName(name)?.collab ?? null,
  save: async (name: string) => byName(name)?.editor.save(),
  /** Runs the review script on an open note; answers what it did. */
  runReview: (name: string) => runReview(name),
  /** Reads an open note's text through the object model (see `readNote`). */
  readNote: (name: string) => readNote(name),
  tokenCalls: () => tokenCalls,
  /** The comments of an open document as the page lists them (`comments` events): `<author>: <body>`. */
  comments: (name: string) => byName(name)?.comments ?? [],
  /** Runs one of the kit's commands in an open editor. */
  run: async (name: string, command: string, params: Record<string, unknown>) => byName(name)?.editor.commands.run(command, params),
  /** What the person may do in an open editor. */
  mode: (name: string) => byName(name)?.editor.mode ?? null,
  /** An open editor's diagnostics on its document (`document/check`). */
  check: async (name: string) => byName(name)?.editor.check() ?? null,
  /** The ids `identity.users` was asked for. */
  usersAsked: () => [...usersAsked],
  errors: () => [...errors],
}
