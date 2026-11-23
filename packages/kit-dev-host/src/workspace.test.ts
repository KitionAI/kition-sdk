// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MountOptions } from '@kition/kit-host'
import { STRINGS, WORKSPACE_PATH, devHostStrings, formatSize, freePath } from './workspace'

/** Each mountKit call's options. */
const mounted = vi.hoisted(() => ({ calls: [] as MountOptions[] }))
vi.mock('@kition/kit-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kition/kit-host')>()),
  mountKit: async (_frame: HTMLIFrameElement, options: MountOptions) => {
    mounted.calls.push(options)
    return { kit: { id: 'kit.test', version: '1' }, capabilities: [], close: vi.fn(), configure: vi.fn(), setTheme: vi.fn(), peersChanged: vi.fn() }
  },
}))

const { startDevHost } = await import('./index')

/** The page a kit's `dev.html` gives the host; `automated` plays Playwright's browser (`navigator.webdriver`). */
function page(search = '', automated = false) {
  Object.defineProperty(navigator, 'webdriver', { value: automated, configurable: true })
  document.body.innerHTML = '<header><span id="status"></span></header><iframe id="kit"></iframe><input id="file" type="file">'
  history.replaceState(null, '', `/dev.html${search}`)
}

/** Every synchronous request the page sent, answered by `status`. */
function fakeServer(status = 204) {
  const sent: Array<{ method: string; url: string; version: string | null; size: number | null }> = []
  class FakeRequest {
    method = ''
    url = ''
    version: string | null = null
    status = 0
    open(method: string, url: string, async: boolean) {
      expect(async, 'synchronous, so the file is there before the engine reads it').toBe(false)
      this.method = method
      this.url = url
    }
    setRequestHeader(name: string, value: string) {
      if (name === 'X-Kition-Version') this.version = value
    }
    send(body: ArrayBuffer | null) {
      this.status = status
      sent.push({ method: this.method, url: this.url, version: this.version, size: body ? body.byteLength : null })
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  return sent
}

const bytes = (size: number) => new ArrayBuffer(size)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const chooser = () => document.querySelector<HTMLElement>('[data-dev-host-chooser]')

/** Plays the person choosing `chosen` in the computer's file chooser of `input`. */
function chooseOnComputer(input: HTMLInputElement, chosen: File[]) {
  Object.defineProperty(input, 'files', { value: chosen, configurable: true })
  input.dispatchEvent(new Event('change'))
}

afterEach(() => {
  mounted.calls = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the development host lends its workspace (lend: true)', () => {
  it('lends a root of this page load, the document’s folder, and mirrors every file put or deleted', async () => {
    const sent = fakeServer()
    page()
    startDevHost({ lend: true })
    const root = window.devHost.lendRoot!
    expect(root).toMatch(new RegExp(`^${location.origin}${WORKSPACE_PATH}/[^/]+/$`))
    window.devHost.files.set('clips/My clip.mp4', { bytes: bytes(5), version: 2 })
    await window.devHost.open('films/Cut.kfilm', bytes(1))
    expect(mounted.calls[0]!.document.lend).toEqual({ root, folder: 'films' })
    // A file the kit writes (an export) is mirrored too.
    await mounted.calls[0]!.handlers.write!({ path: 'films/Cut.mp4', bytes: bytes(7), mode: 'create' } as never)
    window.devHost.files.delete('clips/My clip.mp4')
    expect(sent).toEqual([
      { method: 'PUT', url: `${root}clips/My%20clip.mp4`, version: '2', size: 5 },
      { method: 'PUT', url: `${root}films/Cut.kfilm`, version: '1', size: 1 },
      { method: 'PUT', url: `${root}films/Cut.mp4`, version: '1', size: 7 },
      { method: 'DELETE', url: `${root}clips/My%20clip.mp4`, version: null, size: null },
    ])
    expect(WORKSPACE_PATH, 'the page and the plugin (workspaceServer.test.mjs) name the same path').toBe('/__kition-dev-workspace')
  })

  it('opens the sample in `folder` and lends nothing without lend', async () => {
    const sent = fakeServer()
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2])))
    page()
    startDevHost({ sample: './sample/Sample.kfilm', folder: 'films' })
    await vi.waitFor(() => expect(mounted.calls).toHaveLength(1))
    expect(mounted.calls[0]!.document.path).toBe('films/Sample.kfilm')
    expect(mounted.calls[0]!.document.lend).toBeUndefined()
    expect(window.devHost.lendRoot).toBeNull()
    expect(sent).toEqual([])
  })

  it('says how to fix it, once, when the server keeps no file', async () => {
    fakeServer(404)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    page()
    startDevHost({ lend: true })
    window.devHost.files.set('a.png', { bytes: bytes(1), version: 1 })
    window.devHost.files.set('b.png', { bytes: bytes(1), version: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('devHostWorkspace()')
    expect(document.getElementById('status')!.textContent).toContain('devHostWorkspace()')
    warn.mockRestore()
  })
})

describe('the development host’s picker', () => {
  it('in an automated browser answers at once: the queued answer, else the first fitting file', async () => {
    page('', true)
    startDevHost({ pickable: /\.(png|mp4)$/ })
    window.devHost.files.set('a.png', { bytes: bytes(1), version: 1 })
    window.devHost.files.set('b.mp4', { bytes: bytes(1), version: 1 })
    await window.devHost.open('Cut.kfilm', bytes(1))
    const { pick } = mounted.calls[0]!.handlers
    window.devHost.scriptHostPick('b.mp4', null, (params) => (params.accept.includes('png') ? 'a.png' : null))
    expect(await pick!({ purpose: 'footage', accept: ['mp4'] })).toEqual({ path: 'b.mp4' })
    expect(await pick!({ purpose: 'footage', accept: ['mp4'] }), 'the person cancelled').toEqual({ path: null })
    expect(await pick!({ purpose: 'picture', accept: ['png'] })).toEqual({ path: 'a.png' })
    expect(await pick!({ purpose: 'footage', accept: ['mp4'] })).toEqual({ path: 'b.mp4' })
    expect(await pick!({ purpose: 'sound', accept: ['wav'] })).toEqual({ path: null })
    expect(chooser()).toBeNull()
    expect(window.devHost.hostPicks).toHaveLength(5)
  })

  it('with ?pick=first answers at once in any browser', async () => {
    page('?pick=first')
    startDevHost()
    window.devHost.files.set('a.png', { bytes: bytes(1), version: 1 })
    await window.devHost.open('Cut.kfilm', bytes(1))
    expect(await mounted.calls[0]!.handlers.pick!({ purpose: 'picture', accept: ['png'] })).toEqual({ path: 'a.png' })
  })

  it('for a person shows the fitting workspace files; clicking one answers it', async () => {
    page()
    startDevHost({ pickable: /\.(png|mp4)$/ })
    window.devHost.files.set('a.png', { bytes: bytes(2048), version: 1 })
    window.devHost.files.set('b.mp4', { bytes: bytes(1), version: 1 })
    await window.devHost.open('Cut.kfilm', bytes(1))
    const answer = mounted.calls[0]!.handlers.pick!({ purpose: 'picture', accept: ['png'] })
    await tick()
    const rows = [...chooser()!.querySelectorAll<HTMLButtonElement>('[data-path]')]
    expect(rows.map((row) => row.dataset.path)).toEqual(['a.png'])
    expect(rows[0]!.textContent).toContain('2.0 KB')
    rows[0]!.click()
    expect(await answer).toEqual({ path: 'a.png' })
    expect(chooser()).toBeNull()
  })

  it('“Choose from computer…” opens the computer’s chooser for the asked kinds and copies the files beside the document', async () => {
    page('?pick=chooser', true)
    startDevHost()
    window.devHost.files.set('films/Shot.mp4', { bytes: bytes(1), version: 1 })
    await window.devHost.open('films/Cut.kfilm', bytes(1))
    const answer = mounted.calls[0]!.handlers.pickLinks!({ purpose: 'footage', accept: ['mp4', 'mov'], multiple: true })
    await tick()
    const input = chooser()!.querySelector<HTMLInputElement>('input[type=file]')!
    expect(input.accept).toBe('.mp4,.mov')
    expect(input.multiple).toBe(true)
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    chooser()!.querySelector<HTMLButtonElement>('[data-action=computer]')!.click()
    expect(click).toHaveBeenCalled()
    chooseOnComputer(input, [new File([new Uint8Array(3)], 'Shot.mp4'), new File([new Uint8Array(4)], 'Take 2.mov')])
    expect(await answer).toEqual([
      { path: 'films/Shot 2.mp4', version: '1' },
      { path: 'films/Take 2.mov', version: '1' },
    ])
    expect(window.devHost.files.get('films/Take 2.mov')!.bytes.byteLength).toBe(4)
  })

  it('cancels with Cancel or Escape, and serves files/pick to open the same way', async () => {
    page()
    startDevHost({ kitFiles: { read: ['png'] } })
    window.devHost.files.set('pictures/a.png', { bytes: bytes(1), version: 1 })
    window.devHost.files.set('pictures/b.png', { bytes: bytes(1), version: 1 })
    await window.devHost.open('talks/Launch.slide', bytes(1))
    const { files } = mounted.calls[0]!
    let answer = files!.pick!({ purpose: 'Picture', mode: 'open', accept: ['png'] })
    await tick()
    chooser()!.querySelector<HTMLButtonElement>('[data-action=cancel]')!.click()
    expect(await answer).toEqual([])
    answer = files!.pick!({ purpose: 'Picture', mode: 'open', accept: ['png'], multiple: true })
    await tick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await answer).toEqual([])
    answer = files!.pick!({ purpose: 'Pictures', mode: 'open', accept: ['png'], multiple: true })
    await tick()
    for (const row of chooser()!.querySelectorAll<HTMLButtonElement>('[data-path]')) row.click()
    chooser()!.querySelector<HTMLButtonElement>('[data-action=ok]')!.click()
    expect(await answer).toEqual(['pictures/a.png', 'pictures/b.png'])
    expect(await files!.pick!({ purpose: 'Folder', mode: 'folder', accept: [] }), 'only opening shows the chooser').toEqual([])
  })
})

describe('the Workspace panel', () => {
  it('is collapsed, lists every file with its size and a download link, and adds files from the computer', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:file'), revokeObjectURL: vi.fn() }))
    page('?locale=zh-CN')
    startDevHost()
    await window.devHost.open('films/Cut.kfilm', bytes(10))
    const panel = document.querySelector<HTMLDetailsElement>('header details[data-dev-host-workspace]')!
    expect(panel.open).toBe(false)
    expect(panel.querySelector('summary')!.textContent).toBe('工作区 (1)')
    window.devHost.files.set('films/Cut.mp4', { bytes: bytes(3 * 1024 * 1024), version: 1 })
    panel.open = true
    panel.dispatchEvent(new Event('toggle'))
    const rows = [...panel.querySelectorAll<HTMLElement>('li[data-path]')]
    expect(rows.map((row) => [row.dataset.path, row.children[1]!.textContent])).toEqual([
      ['films/Cut.kfilm', '10 B'],
      ['films/Cut.mp4', '3.0 MB'],
    ])
    const link = rows[1]!.querySelector('a')!
    expect(link.download).toBe('Cut.mp4')
    expect(link.getAttribute('href')).toBe('blob:file')
    expect(link.textContent).toBe('下载')
    expect(panel.querySelector('[data-action=add]')!.textContent).toBe('添加文件…')
    chooseOnComputer(panel.querySelector<HTMLInputElement>('input[type=file]')!, [new File([new Uint8Array(2)], 'Logo.png')])
    await vi.waitFor(() => expect(window.devHost.files.has('films/Logo.png')).toBe(true))
    expect(panel.querySelector('summary')!.textContent).toBe('工作区 (3)')
    expect(panel.querySelectorAll('li[data-path]')).toHaveLength(3)
  })

  it('has every string in en-US and zh-CN', () => {
    expect(Object.keys(STRINGS['zh-CN']).sort()).toEqual(Object.keys(STRINGS['en-US']).sort())
    expect(devHostStrings('zh-TW').fromComputer).toBe('从电脑选择…')
    expect(devHostStrings('en-GB').fromComputer).toBe('Choose from computer…')
    expect(formatSize(512)).toBe('512 B')
    expect(freePath(new Map([['a/x.png', 1], ['a/x 2.png', 1]]), 'a', 'x.png')).toBe('a/x 3.png')
  })
})
