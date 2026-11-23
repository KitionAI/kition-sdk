/**
 * The development host's workspace for a person at the page: the in-memory files lent to the
 * engine over HTTP (`WorkspaceFiles`, served by `devHostWorkspace()` from `./vite`), the chooser a
 * kit's pick opens (`chooseFiles`), and the Workspace panel in the top bar, which lists the files
 * with their sizes, saves each to disk, and adds files from the computer.
 */
import type { MemoryFile } from './memoryFiles'

/** Where `devHostWorkspace()` (workspaceServer.mjs) serves the workspace, from the site's root. */
export const WORKSPACE_PATH = '/__kition-dev-workspace'

const KEYS = ['workspace', 'empty', 'download', 'add', 'choose', 'chooseMany', 'fromComputer', 'noMatch', 'cancel', 'ok', 'lendFailed'] as const

export type DevHostStrings = Record<(typeof KEYS)[number], string>

/** The page's own strings, in en-US and zh-CN. */
export const STRINGS: Record<'en-US' | 'zh-CN', DevHostStrings> = {
  'en-US': {
    workspace: 'Workspace',
    empty: 'No files',
    download: 'Download',
    add: 'Add files…',
    choose: 'Choose a file',
    chooseMany: 'Choose files',
    fromComputer: 'Choose from computer…',
    noMatch: 'No workspace file fits.',
    cancel: 'Cancel',
    ok: 'Choose',
    lendFailed: 'kit-dev-host: the engine cannot read the workspace: add devHostWorkspace() from @kition/sdk/dev-host/vite to the plugins of the kit’s vite.config',
  },
  'zh-CN': {
    workspace: '工作区',
    empty: '没有文件',
    download: '下载',
    add: '添加文件…',
    choose: '选择文件',
    chooseMany: '选择文件（可多选）',
    fromComputer: '从电脑选择…',
    noMatch: '工作区里没有合适的文件。',
    cancel: '取消',
    ok: '选择',
    lendFailed: 'kit-dev-host：引擎读不到工作区：请在套件的 vite.config 的 plugins 里加上 @kition/sdk/dev-host/vite 的 devHostWorkspace()',
  },
}

/** The page's strings for `locale` (`zh…` is Chinese, anything else English). */
export function devHostStrings(locale: string): DevHostStrings {
  return locale.toLowerCase().startsWith('zh') ? STRINGS['zh-CN'] : STRINGS['en-US']
}

/** `bytes` as a person reads a size: `512 B`, `1.5 KB`, `12.0 MB`. */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** A file's URL in the served workspace: `root` and its path, each segment encoded. */
export const workspaceUrl = (root: string, path: string) => new URL(path.split('/').map(encodeURIComponent).join('/'), root).href

/**
 * The in-memory workspace (path → bytes and version). With `lendRoot`, every file set or deleted
 * is also put to (or dropped from) the served workspace at once, synchronously, so the file is
 * there before the editor can name it to the engine. `changed` hears every change.
 */
export class WorkspaceFiles extends Map<string, MemoryFile> {
  lendRoot: string | null = null
  changed: () => void = () => undefined
  private warned = false
  /** Called once when the server does not keep a file (no `devHostWorkspace()` in the Vite config). */
  onLendFailed: () => void = () => undefined

  override set(path: string, file: MemoryFile) {
    super.set(path, file)
    if (this.lendRoot) this.send('PUT', path, file)
    this.changed?.()
    return this
  }

  override delete(path: string) {
    const had = super.delete(path)
    if (had && this.lendRoot) this.send('DELETE', path)
    if (had) this.changed?.()
    return had
  }

  override clear() {
    for (const path of [...this.keys()]) this.delete(path)
  }

  private send(method: 'PUT' | 'DELETE', path: string, file?: MemoryFile) {
    const request = new XMLHttpRequest()
    try {
      request.open(method, workspaceUrl(this.lendRoot!, path), false)
      if (file) request.setRequestHeader('X-Kition-Version', String(file.version))
      request.send(file ? file.bytes : null)
      if (request.status !== 204) throw new Error(String(request.status))
    } catch {
      // The editor still works; the engine just cannot read this file.
      if (!this.warned) {
        this.warned = true
        this.onLendFailed()
      }
    }
  }
}

/** `path`'s folder ('' at the workspace root). */
export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** A free workspace path for `name` in `folder`: the name itself, or `name 2.ext`, `name 3.ext` … */
export function freePath(files: ReadonlyMap<string, unknown>, folder: string, name: string) {
  const wanted = folder ? `${folder}/${name}` : name
  let target = wanted
  for (let number = 2; files.has(target); number += 1) target = wanted.replace(/(\.[^./]+)?$/, ` ${number}$1`)
  return target
}

/** A blob's bytes (through FileReader, which every browser and jsdom have). */
function readBlob(blob: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

/** Copies files the person chose on their computer into `folder` of the workspace; answers their paths. */
export async function addFromComputer(files: Map<string, MemoryFile>, folder: string, chosen: ArrayLike<Blob & { name: string }>) {
  const paths: string[] = []
  for (const file of Array.from(chosen)) {
    const path = freePath(files, folder, file.name)
    files.set(path, { bytes: await readBlob(file), version: 1 })
    paths.push(path)
  }
  return paths
}

/** An `<input type="file">` that opens the computer's file chooser, for `accept` extensions. */
function computerInput(accept: readonly string[], multiple: boolean) {
  const input = document.createElement('input')
  input.type = 'file'
  input.hidden = true
  input.multiple = multiple
  if (accept.length) input.accept = accept.map((extension) => `.${extension.replace(/^\./, '')}`).join(',')
  return input
}

export type ChooseRequest = {
  /** Workspace files that fit the request, in order. */
  candidates: string[]
  /** Extensions the computer's chooser offers (none: any). */
  accept: readonly string[]
  multiple: boolean
  /** Where files from the computer go. */
  folder: string
  /** What the kit wants the file for (the request's `purpose`). */
  purpose?: string
}

/**
 * The chooser a kit's pick opens: the workspace files that fit, and "Choose from computer…",
 * which copies the chosen files into the workspace. Answers the chosen workspace paths (none:
 * the person cancelled). It is a `[data-dev-host-chooser]` overlay on the page; a test can click
 * in it, though tests usually pre-answer picks instead.
 */
export function chooseFiles(files: Map<string, MemoryFile>, request: ChooseRequest, strings: DevHostStrings): Promise<string[]> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.dataset.devHostChooser = ''
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:13px system-ui,sans-serif'
    const box = document.createElement('div')
    box.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:8px;padding:16px;min-width:320px;max-width:560px;max-height:70vh;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 32px rgba(0,0,0,.3)'
    const title = document.createElement('strong')
    title.textContent = `${request.multiple ? strings.chooseMany : strings.choose}${request.purpose ? ` · ${request.purpose}` : ''}`
    const list = document.createElement('div')
    list.style.cssText = 'overflow:auto;display:flex;flex-direction:column;gap:2px'
    const chosen = new Set<string>()
    const finish = (paths: string[]) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(paths)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish([])
    }
    if (!request.candidates.length) {
      const none = document.createElement('em')
      none.textContent = strings.noMatch
      list.append(none)
    }
    for (const path of request.candidates) {
      const row = document.createElement('button')
      row.type = 'button'
      row.dataset.path = path
      row.style.cssText = 'text-align:left;padding:4px 8px;border:1px solid transparent;border-radius:4px;background:none;cursor:pointer'
      row.textContent = `${path}  (${formatSize(files.get(path)?.bytes.byteLength ?? 0)})`
      row.addEventListener('click', () => {
        if (!request.multiple) return finish([path])
        if (chosen.has(path)) chosen.delete(path)
        else chosen.add(path)
        row.setAttribute('aria-pressed', String(chosen.has(path)))
        row.style.borderColor = chosen.has(path) ? '#5645d4' : 'transparent'
      })
      list.append(row)
    }
    const input = computerInput(request.accept, request.multiple)
    input.addEventListener('change', () => {
      if (!input.files?.length) return
      void addFromComputer(files, request.folder, input.files).then(finish)
    })
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
    const button = (label: string, action: string, onClick: () => void) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.textContent = label
      element.dataset.action = action
      element.addEventListener('click', onClick)
      return element
    }
    const computer = button(strings.fromComputer, 'computer', () => input.click())
    computer.style.marginRight = 'auto'
    actions.append(computer, button(strings.cancel, 'cancel', () => finish([])))
    if (request.multiple) actions.append(button(strings.ok, 'ok', () => finish(request.candidates.filter((path) => chosen.has(path)))))
    box.append(title, list, actions, input)
    overlay.append(box)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish([])
    })
    document.addEventListener('keydown', onKey, true)
    document.body.append(overlay)
  })
}

/**
 * The Workspace panel (collapsed): every workspace file with its size and a download link, and
 * "Add files…", which copies files from the computer into `folder()`. Redraws when `render()` is
 * called (on every change of the workspace).
 */
export function workspacePanel(files: Map<string, MemoryFile>, folder: () => string, strings: DevHostStrings) {
  const panel = document.createElement('details')
  panel.dataset.devHostWorkspace = ''
  const summary = document.createElement('summary')
  const body = document.createElement('div')
  body.style.cssText = 'position:absolute;z-index:1000;background:#fff;color:#1a1a1a;border:1px solid #e5e3df;border-radius:6px;padding:8px;max-height:60vh;overflow:auto;font:12px system-ui,sans-serif;min-width:280px'
  const list = document.createElement('ul')
  list.style.cssText = 'list-style:none;margin:0 0 8px;padding:0'
  const input = computerInput([], true)
  input.addEventListener('change', () => {
    if (input.files?.length) void addFromComputer(files, folder(), input.files).then(() => (input.value = ''))
  })
  const add = document.createElement('button')
  add.type = 'button'
  add.dataset.action = 'add'
  add.textContent = strings.add
  add.addEventListener('click', () => input.click())
  body.append(list, add, input)
  panel.append(summary, body)
  const urls: string[] = []

  function render() {
    summary.textContent = `${strings.workspace} (${files.size})`
    if (!panel.open) return
    for (const url of urls.splice(0)) URL.revokeObjectURL(url)
    list.replaceChildren()
    if (!files.size) {
      const none = document.createElement('li')
      none.textContent = strings.empty
      list.append(none)
    }
    for (const [path, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const row = document.createElement('li')
      row.dataset.path = path
      row.style.cssText = 'display:flex;gap:12px;justify-content:space-between;padding:2px 0'
      const name = document.createElement('span')
      name.textContent = path
      const size = document.createElement('span')
      size.textContent = formatSize(file.bytes.byteLength)
      size.style.color = '#5d5b54'
      const link = document.createElement('a')
      const url = URL.createObjectURL(new Blob([file.bytes]))
      urls.push(url)
      link.href = url
      link.download = path.split('/').pop() ?? path
      link.textContent = strings.download
      row.append(name, size, link)
      list.append(row)
    }
  }
  panel.addEventListener('toggle', render)
  render()
  return { panel, render }
}
