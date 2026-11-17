import { describe, expect, it } from 'vitest'
import { fileErrorReason, openFileSession, type KitFileSession } from '@kition/kit-host'
import { checkNoPaths, isMimeType, isPathShaped } from './checkNoPaths'
import { memoryFilesStorage, type MemoryFile } from './memoryFiles'

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

/** A fake kit's side: its requests go straight to the session, as the port would carry them. */
function fakeKit(session: KitFileSession) {
  return { request: session.serve }
}

/** The development host's folder served to a fake kit, recording every `files/*` request. */
function hosted(paths: Record<string, string>, picks: string[][] = []) {
  const files = new Map<string, MemoryFile>(Object.entries(paths).map(([path, text]) => [path, { bytes: encode(text), version: 1 }]))
  const requests: Array<{ method: string; params: unknown }> = []
  const session = openFileSession({
    storage: memoryFilesStorage(files, () => 'talks'),
    kit: 'kit.fake',
    principal: 'dev-person',
    manifest: { read: ['pdf', 'png'], create: ['pdf', 'png'], folders: true },
    pick: async () => picks.shift() ?? [],
    gesture: () => true,
    trace: (method, params) => void requests.push({ method, params }),
  })
  return { files, requests, kit: fakeKit(session), close: () => void session.end() }
}

describe('checkNoPaths', () => {
  it('passes a kit that keeps to handles and bare names', async () => {
    const { kit, requests, files, close } = hosted({ 'in/a.pdf': 'A', 'in/b.png': 'B' }, [['in/a.pdf'], ['in']])
    const [picked] = (await kit.request('files/pick', { purpose: 'Choose PDF/A files to insert', mode: 'open', accept: ['pdf'] })).files
    await kit.request('files/read', { handle: picked!.handle })
    const [folder] = (await kit.request('files/pick', { purpose: 'Choose a folder', mode: 'folder', accept: ['png'] })).files
    const listed = (await kit.request('files/list', { handle: folder!.handle })).files
    expect(listed.map((file) => file.name)).toEqual(['b.png'])
    const out = await kit.request('files/create', { suggestedName: 'Q3 report v1.0.pdf' })
    await kit.request('files/write', { handle: out.handle, bytes: encode('%PDF'), offset: 0, final: true })
    await kit.request('files/release', { handles: [picked!.handle] })
    expect(files.has('talks/Q3 report v1.0.pdf')).toBe(true)
    expect(requests.map((request) => request.method)).toEqual(['files/pick', 'files/read', 'files/pick', 'files/list', 'files/create', 'files/write', 'files/release'])
    expect(checkNoPaths(requests)).toEqual([])
    close()
  })

  it('catches a kit that leaks paths, even when the host refuses or sanitizes them', async () => {
    const { kit, requests, files, close } = hosted({ 'in/a.pdf': 'A' })
    // A leaky kit: an absolute path as a name, a workspace path as a handle, a home path in a purpose.
    const out = await kit.request('files/create', { suggestedName: '/Users/alice/Desktop/Report.pdf' })
    expect(out.name, 'the host takes the last segment').toBe('Report.pdf')
    const refused = await kit.request('files/read', { handle: 'in/a.pdf' }).catch((error: unknown) => error)
    expect(fileErrorReason(refused)).toBe('file-not-granted')
    await kit.request('files/pick', { purpose: 'Open ~/Documents/a.pdf', mode: 'open', accept: ['pdf'] })
    await kit.request('files/release', { handles: ['C:\\Users\\alice\\a.pdf'] })
    expect(checkNoPaths(requests)).toEqual([
      { method: 'files/create', at: 'suggestedName', value: '/Users/alice/Desktop/Report.pdf' },
      { method: 'files/read', at: 'handle', value: 'in/a.pdf' },
      { method: 'files/pick', at: 'purpose', value: 'Open ~/Documents/a.pdf' },
      { method: 'files/release', at: 'handles[0]', value: 'C:\\Users\\alice\\a.pdf' },
    ])
    expect(files.has('talks/Report.pdf')).toBe(false)
    close()
  })

  it('reads a `mime` param as a MIME type, not a path, and still catches a path there', async () => {
    const { kit, requests, files, close } = hosted({})
    const out = await kit.request('files/create', { suggestedName: 'Notes.pdf', mime: 'application/pdf' })
    await kit.request('files/write', { handle: out.handle, bytes: encode('%PDF'), offset: 0, final: true })
    expect(files.has('talks/Notes.pdf')).toBe(true)
    expect(checkNoPaths(requests)).toEqual([])
    const sent = [
      { method: 'files/print', params: { bytes: new Uint8Array(4), mime: 'application/pdf', title: 'Notes' } },
      { method: 'files/create', params: { suggestedName: 'Sheet.ods', mime: 'application/vnd.oasis.opendocument.spreadsheet' } },
      { method: 'files/create', params: { suggestedName: 'Page.html', mime: 'text/html; charset=utf-8' } },
      { method: 'files/create', params: { suggestedName: 'Icon.svg', mime: 'image/svg+xml' } },
      { method: 'files/create', params: { suggestedName: 'Out.pdf', mime: 'exports/Out.pdf' } },
      { method: 'files/create', params: { suggestedName: 'Out.pdf', mime: '/Users/alice/Out.pdf' } },
      { method: 'files/create', params: { suggestedName: 'Out.pdf', mime: 'text/../../secrets' } },
    ]
    expect(checkNoPaths(sent)).toEqual([
      { method: 'files/create', at: 'mime', value: 'exports/Out.pdf' },
      { method: 'files/create', at: 'mime', value: '/Users/alice/Out.pdf' },
      { method: 'files/create', at: 'mime', value: 'text/../../secrets' },
    ])
    expect(isMimeType('application/pdf')).toBe(true)
    expect(isMimeType('exports/Out.pdf')).toBe(false)
    close()
  })

  it('tells path-shaped strings from names and sentences', () => {
    expect(isPathShaped('Report.pdf')).toBe(false)
    expect(isPathShaped('fh_0123abcd')).toBe(false)
    expect(isPathShaped('exports/Report.pdf')).toBe(true)
    expect(isPathShaped('..')).toBe(true)
    expect(isPathShaped('file:///tmp/x.pdf')).toBe(true)
    expect(isPathShaped('\\\\server\\share\\x.pdf')).toBe(true)
    expect(isPathShaped('Choose PDF/A files', true)).toBe(false)
    expect(isPathShaped('Save to /home/test-user/out.pdf', true)).toBe(true)
    expect(checkNoPaths([{ method: 'host/read', params: { path: 'talks/a.pdf' } }]), 'only files/* requests').toEqual([])
  })
})

describe('memoryFilesStorage', () => {
  it('keeps folders, hides dotted paths, never creates over a file, and replaces only the expected version', async () => {
    const files = new Map<string, MemoryFile>([['in/a.pdf', { bytes: encode('A'), version: 1 }], ['in/.cache/x.pdf', { bytes: encode('X'), version: 1 }]])
    const storage = memoryFilesStorage(files, () => '', new Set(['empty']))
    expect(await storage.stat('in')).toEqual({ kind: 'folder', version: null })
    expect(await storage.stat('empty')).toEqual({ kind: 'folder', version: null })
    expect(await storage.stat('in/a.pdf')).toEqual({ kind: 'file', size: 1, version: '1', mime: 'application/pdf' })
    expect(await storage.stat('in/.cache/x.pdf')).toBeNull()
    expect(await storage.list('in')).toEqual(['in/a.pdf'])
    expect(storage.child(null, 'b.pdf')).toBe('b.pdf')
    expect(storage.child('in', 'b.pdf')).toBe('in/b.pdf')
    const conflict = await storage.commit('in/a.pdf', new Uint8Array([1]), { mode: 'create' }).catch((error: unknown) => error)
    expect(fileErrorReason(conflict)).toBe('conflict')
    const stale = await storage.commit('in/a.pdf', new Uint8Array([1]), { mode: 'replace', expected: '0' }).catch((error: unknown) => error)
    expect(fileErrorReason(stale)).toBe('conflict')
    expect(await storage.commit('in/a.pdf', new Uint8Array([1]), { mode: 'replace', expected: '1' })).toEqual({ version: '2' })
    expect(await storage.commit('out/new.pdf', new Uint8Array([2]), { mode: 'create' })).toEqual({ version: '1' })
    expect(new Uint8Array((await storage.read('out/new.pdf', 0, undefined)).bytes)).toEqual(new Uint8Array([2]))
  })
})
