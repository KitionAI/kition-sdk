// @vitest-environment jsdom
/**
 * Lazy fonts (engine contract E9): the manifest's `fonts` are given to the engine before a
 * document opens, its `lazyFonts` only once the engine wants a face it has not got (or right after
 * the document opens when it cannot say), in order, one at a time, a file that does not load
 * skipped; the worker gives them all at once when the page asks (`fonts`), and the page hears each.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LazyFonts } from './lazyFonts'
import { kitModuleLazyFonts, loadKitModule, type KitModuleManifest } from './kitModule'
import { KitEngine, type KitEngineEvent, type KitEngineRequest, type KitEngineResponse } from './kitEngine'

const fixtures = pathToFileURL(path.join(__dirname, 'fixtures') + path.sep).href
const font = (name: string) => `data:application/octet-stream;base64,${btoa(name)}`
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Reads `data:` fonts at once and `slow:` ones when `release` is called; `bad:` ones never. */
function reader() {
  const reads: string[] = []
  const waiting: Array<() => void> = []
  const read = async (url: string) => {
    reads.push(url)
    if (url.startsWith('bad:')) return null
    if (url.startsWith('slow:')) await new Promise<void>((resolve) => waiting.push(resolve))
    return new TextEncoder().encode(url.replace(/^\w+:/, ''))
  }
  return { reads, read, release: () => waiting.splice(0).forEach((resolve) => resolve()) }
}

describe('LazyFonts', () => {
  it('loads nothing until the engine wants a face, then every font in order', async () => {
    const added: string[] = []
    let wanted = false
    const asked: number[] = []
    const { reads, read } = reader()
    const fonts = new LazyFonts(['a:droid', 'a:nanum', 'a:emoji'], (bytes) => added.push(text(bytes)), () => {
      asked.push(1)
      return wanted
    }, read)
    fonts.onSettled((pending) => asked.push(-pending))
    fonts.check()
    fonts.check()
    expect(reads).toEqual([])
    expect(fonts.pending).toBe(3)
    wanted = true
    fonts.check()
    await fonts.loadAll()
    expect(added).toEqual(['droid', 'nanum', 'emoji'])
    expect(fonts.pending).toBe(0)
    // Asked once per check until loading started; told after each font.
    expect(asked).toEqual([1, 1, 1, -2, -1, -0])
    fonts.check()
    expect(asked.length).toBe(6)
  })

  it('loads right after the first check when the engine cannot say what it wants', async () => {
    const added: string[] = []
    const { read } = reader()
    const fonts = new LazyFonts(['a:droid'], (bytes) => added.push(text(bytes)), null, read)
    expect(added).toEqual([])
    fonts.check()
    await fonts.loadAll()
    expect(added).toEqual(['droid'])
  })

  it('treats an engine whose wantsFonts throws as one that cannot say', async () => {
    const added: string[] = []
    const fonts = new LazyFonts(['a:droid'], (bytes) => added.push(text(bytes)), () => {
      throw new Error('no answer')
    }, reader().read)
    fonts.check()
    await fonts.loadAll()
    expect(added).toEqual(['droid'])
  })

  it('skips a font that does not load or that the engine refuses, and goes on', async () => {
    const added: string[] = []
    const settled: number[] = []
    const fonts = new LazyFonts(['bad:droid', 'a:refused', 'a:emoji'], (bytes) => {
      if (text(bytes) === 'refused') throw new Error('not a font')
      added.push(text(bytes))
    }, null, reader().read)
    fonts.onSettled((pending) => settled.push(pending))
    await fonts.loadAll()
    expect(added).toEqual(['emoji'])
    expect(settled).toEqual([2, 1, 0])
  })

  it('reads one font at a time, the first listed first, and shares one load', async () => {
    const added: string[] = []
    const { reads, read, release } = reader()
    const fonts = new LazyFonts(['slow:droid', 'slow:nanum'], (bytes) => added.push(text(bytes)), () => true, read)
    fonts.check()
    const all = fonts.loadAll()
    fonts.check()
    await Promise.resolve()
    expect(reads).toEqual(['slow:droid'])
    release()
    await vi.waitFor(() => expect(reads).toEqual(['slow:droid', 'slow:nanum']))
    expect(added).toEqual(['droid'])
    expect(fonts.pending).toBe(1)
    release()
    await all
    expect(added).toEqual(['droid', 'nanum'])
  })

  it('has nothing to load for an engine that takes no fonts', async () => {
    const { reads, read } = reader()
    const fonts = new LazyFonts(['a:droid'], null, () => true, read)
    expect(fonts.pending).toBe(0)
    fonts.check()
    await fonts.loadAll()
    expect(reads).toEqual([])
  })
})

describe('a kit module with lazy fonts', () => {
  it('gets its fonts before it answers and its lazy fonts when it wants them', async () => {
    const manifest: KitModuleManifest = {
      kitId: 'kit.fonts',
      base: fixtures,
      module: 'fonts_engine',
      documentClass: 'NotesDocument',
      runtime: 'ts-worker',
      fonts: [font('inter')],
      lazyFonts: [font('droid'), font('emoji')],
    }
    const module = (await loadKitModule(manifest)) as unknown as { added: string[]; want: () => void }
    expect(module.added).toEqual(['inter'])
    const lazy = kitModuleLazyFonts(manifest)!
    expect(lazy.pending).toBe(2)
    lazy.check()
    expect(lazy.pending).toBe(2)
    module.want()
    lazy.check()
    await lazy.loadAll()
    expect(module.added).toEqual(['inter', 'droid', 'emoji'])
  })

  it('gives the engine every lazy font when the page asks the worker', async () => {
    const manifest: KitModuleManifest = {
      kitId: 'kit.fonts.worker',
      base: fixtures,
      module: 'fonts_engine',
      documentClass: 'NotesDocument',
      runtime: 'ts-worker',
      fonts: [font('inter')],
      lazyFonts: [font('nanum')],
    }
    const { handle } = await import('./kitEngine.worker')
    await handle({ method: 'open', manifest, name: 'List.notes', bytes: new TextEncoder().encode('Groceries').buffer as ArrayBuffer, lent: null })
    const module = (await loadKitModule(manifest)) as unknown as { added: string[] }
    expect(module.added.slice(-1)).toEqual(['inter'])
    await handle({ method: 'fonts' })
    expect(module.added.slice(-2)).toEqual(['inter', 'nanum'])
    expect(kitModuleLazyFonts(manifest)!.pending).toBe(0)
  })
})

describe('KitEngine and lazy fonts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows how many lazy fonts are left and tells its listeners when one is in', async () => {
    const requests: KitEngineRequest[] = []
    class FakeWorker {
      onmessage: ((event: MessageEvent<KitEngineResponse | KitEngineEvent>) => void) | null = null
      onerror: unknown = null
      postMessage({ id, request }: { id: number; request: KitEngineRequest }) {
        requests.push(request)
        const answer = (data: KitEngineResponse | KitEngineEvent) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent))
        if (request.method === 'open') {
          answer({ fonts: 2 })
          answer({ id, ok: true, value: { width: 1, height: 1, pinned: { left: 0, top: 0 }, revision: 0, dirty: false, canUndo: false, canRedo: false, inspected: {} } })
        } else if (request.method === 'fonts') {
          answer({ fonts: 1 })
          answer({ fonts: 0 })
          answer({ id, ok: true, value: null })
        }
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    const manifest: KitModuleManifest = { kitId: 'kit.fonts', module: 'fonts_engine', documentClass: 'NotesDocument' }
    const engine = await KitEngine.open(manifest, 'List.notes', new ArrayBuffer(1))
    expect(engine.fontsPending).toBe(2)
    const heard: number[] = []
    const stop = engine.onFonts(() => heard.push(engine.fontsPending))
    await engine.loadFonts()
    expect(requests.map((request) => request.method)).toEqual(['open', 'fonts'])
    expect(heard).toEqual([1, 0])
    stop()
    engine.dispose()
  })
})
