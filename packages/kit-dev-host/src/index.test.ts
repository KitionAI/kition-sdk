// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitPeerPresence, MountOptions } from '@kition/kit-host'

/** Each mountKit call's options, and the connection it answered. */
const mounted = vi.hoisted(() => ({ calls: [] as Array<{ options: MountOptions; connection: { peersChanged: ReturnType<typeof vi.fn>; configure: ReturnType<typeof vi.fn> } }> }))
vi.mock('@kition/kit-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kition/kit-host')>()),
  mountKit: async (_frame: HTMLIFrameElement, options: MountOptions) => {
    const connection = { kit: { id: 'kit.test', version: '1' }, capabilities: [], close: vi.fn(), configure: vi.fn(), setTheme: vi.fn(), peersChanged: vi.fn() }
    mounted.calls.push({ options, connection })
    return connection
  },
}))

const { modesInit, resolveLink, startDevHost } = await import('./index')

/** The page a kit's `dev.html` gives the host, in an automated browser as Playwright's are (`navigator.webdriver`). */
function page(search = '') {
  Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true })
  document.body.innerHTML = '<header><span id="status"></span></header><iframe id="kit"></iframe><input id="file" type="file">'
  history.replaceState(null, '', `/dev.html${search}`)
}

afterEach(() => {
  mounted.calls = []
  document.body.innerHTML = ''
})

const alice: KitPeerPresence = { principal: 'p1', name: 'Alice', color: '#d4456b', selection: ['shape-1'] }

describe('startDevHost', () => {
  it('with ?modes= allows only those display modes and opens in the first', async () => {
    expect(modesInit('classic')).toEqual({ allowed: ['classic'], default: 'classic' })
    expect(modesInit('menus, focus')).toEqual({ allowed: ['menus', 'focus'], default: 'menus' })
    expect(modesInit(null)).toBeUndefined()
    expect(modesInit('')).toBeUndefined()
    // An unknown name is dropped, with a warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(modesInit('clasic,line')).toEqual({ allowed: ['line'], default: 'line' })
    expect(modesInit('ribbon')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]![0])).toContain('clasic')
    warn.mockRestore()
    page('?modes=classic,focus')
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    expect(mounted.calls[0]!.options.ui?.modes).toEqual({ allowed: ['classic', 'focus'], default: 'classic' })
    // A configuration applied later keeps the page's modes unless it names its own.
    window.devHost.configure({ hide: ['menu:Help'] })
    expect(mounted.calls[0]!.connection.configure).toHaveBeenLastCalledWith(expect.objectContaining({ modes: { allowed: ['classic', 'focus'], default: 'classic' } }))
  })

  it('keeps every document/schema the editor sends, and serves no presence by default', async () => {
    page()
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    const { handlers } = mounted.calls[0]!.options
    expect(handlers.presence).toBeUndefined()
    handlers.schema?.({ reads: 2, newestAuthor: 3 })
    expect(window.devHost.schemas).toEqual([{ reads: 2, newestAuthor: 3 }])
    window.devHost.setPeers([alice])
    expect(mounted.calls[0]!.connection.peersChanged).not.toHaveBeenCalled()
  })

  it('with ?presence=1 serves presence: keeps what the editor shares and plays the other people', async () => {
    page('?presence=1')
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    const first = mounted.calls[0]!
    expect(first.options.handlers.presence).toBeTypeOf('function')
    first.options.handlers.presence!({ selection: ['shape-2'], caret: { object: 'text-1', field: 'text', offset: 3 } })
    expect(window.devHost.presences).toEqual([{ selection: ['shape-2'], caret: { object: 'text-1', field: 'text', offset: 3 } }])
    window.devHost.setPeers([alice])
    expect(first.connection.peersChanged).toHaveBeenCalledWith([alice])
    // An editor opened again hears the people already there.
    await window.devHost.open('b.test', new ArrayBuffer(1))
    expect(mounted.calls[1]!.connection.peersChanged).toHaveBeenCalledWith([alice])
  })

  it('serves presence when the page asks for it in its options', async () => {
    page()
    startDevHost({ presence: true })
    await window.devHost.open('a.test', new ArrayBuffer(1))
    expect(mounted.calls[0]!.options.handlers.presence).toBeTypeOf('function')
  })

  it('serves no generation by default; with ?generate=1 it answers from its script and refuses as unavailable after', async () => {
    page()
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    expect(mounted.calls[0]!.options.handlers.generate).toBeUndefined()

    page('?generate=1')
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    const { generate } = mounted.calls[1]!.options.handlers
    expect(generate).toBeTypeOf('function')
    const asked = { purpose: 'rewrite' as const, output: 'text' as const, messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'Shorten' }] }] }
    window.devHost.scriptGenerate({ text: 'Short.' }, (params) => ({ text: `for ${params.purpose}` }), { refuse: 'quota' })
    expect(await generate!(asked)).toEqual({ text: 'Short.' })
    expect(await generate!({ ...asked, purpose: 'test.outline' })).toEqual({ text: 'for test.outline' })
    const reason = (error: unknown) => (error as { data?: { reason?: string } }).data?.reason
    expect(reason(await Promise.resolve(generate!(asked)).catch((error: unknown) => error))).toBe('quota')
    expect(reason(await Promise.resolve(generate!(asked)).catch((error: unknown) => error))).toBe('unavailable')
    expect(window.devHost.generated.map((params) => params.purpose)).toEqual(['rewrite', 'test.outline', 'rewrite', 'rewrite'])
  })

  it('serves no opening by default; with ?open=1 it keeps each request, resolves links, and creates when asked', async () => {
    page()
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    expect(mounted.calls[0]!.options.handlers.open).toBeUndefined()
    expect(mounted.calls[0]!.options.handlers.openUrl).toBeUndefined()

    page('?open=1')
    startDevHost()
    window.devHost.files.set('notes/Plan.md', { bytes: new ArrayBuffer(1), version: 1 })
    await window.devHost.open('notes/Today.md', new ArrayBuffer(1))
    const { open, openUrl } = mounted.calls[1]!.options.handlers
    const reason = (error: unknown) => (error as { data?: { reason?: string } }).data?.reason
    expect(await open!({ link: { name: 'Plan' }, view: { heading: ['Goals'] }, placement: 'tab' })).toEqual({ opened: true })
    expect(reason(await Promise.resolve(open!({ link: { name: 'Ideas' }, placement: 'tab' })).catch((error: unknown) => error))).toBe('not-found')
    expect(await open!({ link: { name: 'Ideas' }, placement: 'beside', create: { kit: 'kit.note' } })).toEqual({ opened: true })
    expect(window.devHost.files.has('notes/Ideas.md')).toBe(true)
    window.devHost.openAnswer = false
    expect(await openUrl!({ url: 'https://example.com' })).toEqual({ opened: false })
    expect(window.devHost.opens.map((request) => request.method)).toEqual(['host/open', 'host/open', 'host/open', 'host/openUrl'])
  })

  it('serves links/pick from its workspace: the pickable files the request accepts, or the scripted answers, never the document', async () => {
    page()
    startDevHost({ pickable: /^libraries\/[^/]+\.kdesign$/ })
    await window.devHost.open('designs/Home.kdesign', new ArrayBuffer(1))
    window.devHost.files.set('libraries/Design System.kdesign', { bytes: new ArrayBuffer(2), version: 3 })
    window.devHost.files.set('libraries/Icons.kdesign', { bytes: new ArrayBuffer(2), version: 1 })
    window.devHost.files.set('libraries/notes.md', { bytes: new ArrayBuffer(2), version: 1 })
    const { pickLinks } = mounted.calls[0]!.options.handlers
    expect(await pickLinks!({ purpose: 'library', accept: ['kdesign'] })).toEqual([
      { path: 'libraries/Design System.kdesign', version: '3' },
      { path: 'libraries/Icons.kdesign', version: '1' },
    ])
    window.devHost.scriptLinkPick(['libraries/Icons.kdesign'], [])
    expect(await pickLinks!({ purpose: 'library', accept: ['kdesign'] })).toEqual([{ path: 'libraries/Icons.kdesign', version: '1' }])
    expect(await pickLinks!({ purpose: 'library', accept: ['kdesign'] }), 'the person cancelled').toEqual([])
    expect(window.devHost.linkPicks).toHaveLength(3)
  })

  it('resolves links from the document’s folder, by path or by name', () => {
    const files = new Set(['notes/Plan.md', 'notes/plan.png', 'Readme.md', 'pictures/a.png'])
    expect(resolveLink({ path: 'Plan.md' }, 'notes/Today.md', files)).toEqual({ path: 'notes/Plan.md', exists: true })
    expect(resolveLink({ path: '../pictures/a.png' }, 'notes/Today.md', files)).toEqual({ path: 'pictures/a.png', exists: true })
    expect(resolveLink({ path: '/Readme.md' }, 'notes/Today.md', files)).toEqual({ path: 'Readme.md', exists: true })
    expect(resolveLink({ path: '../../outside.md' }, 'notes/Today.md', files)).toBeNull()
    expect(resolveLink({ name: 'plan' }, 'notes/Today.md', files)).toEqual({ path: 'notes/Plan.md', exists: true })
    expect(resolveLink({ name: 'Ideas' }, 'notes/Today.md', files)).toEqual({ path: 'notes/Ideas.md', exists: false })
    expect(resolveLink({ docId: 'd1' }, 'notes/Today.md', files)).toBeNull()
  })

  it('serves KitFiles with kitFiles: a scripted picker, a recording printer, the grant log, and checkNoPaths', async () => {
    page()
    startDevHost({ kitFiles: { read: ['png'], create: ['pdf'], print: true } })
    window.devHost.files.set('pictures/a.png', { bytes: new ArrayBuffer(2), version: 1 })
    await window.devHost.open('talks/Launch.slide', new ArrayBuffer(1))
    const files = mounted.calls[0]!.options.files!
    expect(files.manifest).toEqual({ read: ['png'], create: ['pdf'], print: true })
    window.devHost.scriptPick(['pictures/a.png'], () => [])
    expect(await files.pick!({ purpose: 'Picture', mode: 'open', accept: ['png'] })).toEqual(['pictures/a.png'])
    expect(await files.pick!({ purpose: 'Picture', mode: 'open', accept: ['png'] })).toEqual([])
    expect(await files.pick!({ purpose: 'Picture', mode: 'open', accept: ['png'] }), 'nothing scripted: the person cancels').toEqual([])
    expect(files.storage.child(null, 'Out.pdf'), 'new files go beside the document').toBe('talks/Out.pdf')
    window.devHost.printAnswer = false
    expect(await files.print!({ bytes: new Uint8Array(3), title: 'Launch' })).toBe(false)
    expect(window.devHost.prints).toEqual([{ title: 'Launch', size: 3 }])
    files.log!({ handle: 'fh_1', session: 's', kit: 'dev-kit', principal: 'dev-person', flow: 'pick', rights: ['read'], kind: 'file', name: 'a.png' })
    expect(window.devHost.grants).toHaveLength(1)
    files.trace!('files/create', { suggestedName: 'exports/Out.pdf' })
    expect(window.devHost.checkNoPaths()).toEqual([{ method: 'files/create', at: 'suggestedName', value: 'exports/Out.pdf' }])
  })

  it('serves no KitFiles without kitFiles', async () => {
    page()
    startDevHost()
    await window.devHost.open('a.test', new ArrayBuffer(1))
    expect(mounted.calls[0]!.options.files).toBeUndefined()
  })
})
