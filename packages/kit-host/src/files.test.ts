import { describe, expect, it, vi } from 'vitest'
import { fileErrorReason, type KitFileStat } from '@kition/kit-ui-protocol'
import { fileError, openFileSession, sanitizeFileName, unusedName, type KitFileEntry, type KitFilesOptions, type KitFilesStorage } from './files'

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const decode = (bytes: ArrayBuffer | Uint8Array) => new TextDecoder().decode(bytes)

/** A small workspace: paths to text and versions; folders are the paths' prefixes. The document is `talks/Launch.slide`. */
function workspace(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, { bytes: encode(text), version: 1 }]))
  const unsaved = new Set<string>()
  const commits: string[] = []
  const isFolder = (path: string) => [...files.keys()].some((name) => name.startsWith(`${path}/`))
  const storage: KitFilesStorage = {
    stat: (path): KitFileEntry | null => {
      if (path.split('/').some((segment) => segment.startsWith('.'))) return null
      const file = files.get(path)
      if (file) return { kind: 'file', size: file.bytes.byteLength, version: `v${file.version}` }
      return isFolder(path) ? { kind: 'folder', version: null } : null
    },
    read: async (path, offset, length) => {
      const file = files.get(path)!
      return { bytes: file.bytes.slice(offset, length === undefined ? undefined : offset + length), version: `v${file.version}`, size: file.bytes.byteLength }
    },
    list: (folder) => [...files.keys()].filter((name) => name.startsWith(`${folder}/`) && !name.slice(folder.length + 1).includes('/')),
    child: (folder, name) => `${folder ?? 'talks'}/${name}`,
    commit: async (path, bytes, mode) => {
      const existing = files.get(path)
      if (mode.mode === 'create' && existing) throw fileError('conflict', 'exists')
      if (mode.mode === 'replace' && `v${existing?.version}` !== mode.expected) throw fileError('conflict', 'changed')
      const version = (existing?.version ?? 0) + 1
      files.set(path, { bytes: bytes.slice().buffer as ArrayBuffer, version })
      commits.push(path)
      return { version: `v${version}` }
    },
    unsaved: (path) => unsaved.has(path),
  }
  return { files, storage, unsaved, commits }
}

const manifest = { read: ['pdf', 'png'], create: ['pdf', 'png'], folders: true, print: true }

function session(storage: KitFilesStorage, options: Partial<KitFilesOptions> & { readOnly?: boolean; revoked?: (handles: string[]) => void } = {}) {
  return openFileSession({ storage, kit: 'kit.pdf', principal: 'alice', manifest, gesture: () => true, ...options })
}

/** The refusal's reason (KitFiles section 10), or its JSON-RPC code when it has none. */
async function refused(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return fileErrorReason(error) ?? (error as { code: number }).code
  }
  throw new Error('the request was not refused')
}

describe('KitFiles names', () => {
  it('sanitizes names and picks unused ones (FA7, FA15)', async () => {
    expect(sanitizeFileName('../../etc/Report.pdf')).toBe('Report.pdf')
    expect(sanitizeFileName('C:\\Users\\alice\\Q3\u0007.pdf')).toBe('Q3.pdf')
    expect(sanitizeFileName('.hidden.pdf')).toBe('hidden.pdf')
    expect(sanitizeFileName('CON.pdf')).toBe('CON_.pdf')
    expect(sanitizeFileName('   ')).toBe('Untitled')
    const taken = new Set(['Report.pdf', 'Report 2.pdf'])
    expect(await unusedName('Report.pdf', (name) => taken.has(name))).toBe('Report 3.pdf')
  })
})

describe('openFileSession', () => {
  it('lists its capabilities and logs every grant with session, kit, principal, rights, and kind', async () => {
    const { storage } = workspace()
    const log = vi.fn()
    const files = session(storage, { log, pick: async () => [], print: async () => true })
    expect(files.capabilities).toEqual(['files', 'files-pick', 'print'])
    expect(session(storage).capabilities).toEqual(['files'])
    const created = await files.serve('files/create', { suggestedName: 'Out.pdf' })
    expect(log).toHaveBeenCalledWith({ handle: created.handle, session: files.id, kit: 'kit.pdf', principal: 'alice', flow: 'create', rights: ['create'], kind: 'file', name: 'Out.pdf' })
    expect(files.grants()).toHaveLength(1)
  })

  it('files/pick: grants what the person chose, with the rights the mode needs', async () => {
    const { storage } = workspace({ 'in/a.pdf': 'A', 'in/b.png': 'B', 'in/notes.txt': 'N', 'talks/Old.pdf': 'old' })
    const answers = [['in/a.pdf', 'in/notes.txt'], ['in'], ['talks/New.pdf'], ['talks/Old.pdf'], []]
    const files = session(storage, { pick: async () => answers.shift() ?? [] })
    const opened = (await files.serve('files/pick', { purpose: 'Choose PDFs', mode: 'open', accept: ['pdf'], multiple: true })).files
    expect(opened.map(({ name, rights, kind }) => ({ name, rights, kind }))).toEqual([{ name: 'a.pdf', rights: ['read'], kind: 'file' }])
    expect(opened[0]!.handle).toMatch(/^fh_[0-9a-f]{32}$/)
    expect(JSON.stringify(opened)).not.toContain('in/')
    const [folder] = (await files.serve('files/pick', { purpose: 'Choose a folder', mode: 'folder', accept: ['png'] })).files
    expect(folder).toMatchObject({ name: 'in', kind: 'folder', rights: ['read', 'create'] })
    const [fresh] = (await files.serve('files/pick', { purpose: 'Save a copy', mode: 'save', accept: ['pdf'], suggestedName: 'New.pdf' })).files
    expect(fresh).toMatchObject({ name: 'New.pdf', rights: ['create'], version: null })
    const [replace] = (await files.serve('files/pick', { purpose: 'Save a copy', mode: 'save', accept: ['pdf'] })).files
    expect(replace).toMatchObject({ name: 'Old.pdf', rights: ['write'], version: 'v1' })
    expect((await files.serve('files/pick', { purpose: 'Choose PDFs', mode: 'open', accept: ['pdf'] })).files, 'the person cancelled').toEqual([])
  })

  it('files/pick: refuses without a picker, a gesture, or the manifest\'s leave', async () => {
    const { storage } = workspace({ 'talks/Old.pdf': 'old' })
    expect(await refused(session(storage).serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] }))).toBe('unsupported')
    expect(await refused(session(storage, { pick: async () => [], gesture: () => false }).serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] }))).toBe('no-gesture')
    const files = session(storage, { pick: async () => ['talks/Old.pdf'] })
    expect(await refused(files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['exe'] }))).toBe('not-allowed')
    expect(await refused(session(storage, { pick: async () => [], manifest: { read: ['pdf'] } }).serve('files/pick', { purpose: 'p', mode: 'folder', accept: [] }))).toBe('not-allowed')
    expect(await refused(session(storage, { pick: async () => ['talks/Old.pdf'], readOnly: true }).serve('files/pick', { purpose: 'p', mode: 'save', accept: ['pdf'] })), 'a read-only session replaces nothing (FA17)').toBe('not-allowed')
    expect(await refused(files.serve('files/pick', { purpose: 'p', mode: 'bogus' as 'open', accept: [] }))).toBe(-32602)
  })

  it('files/create: never replaces, picks an unused name, takes the last segment, and keeps to K15', async () => {
    const { storage, files: disk } = workspace({ 'talks/Report.pdf': 'old', 'out/x.png': 'x' })
    const files = session(storage, { pick: async () => ['out'] })
    const first = await files.serve('files/create', { suggestedName: '/Users/alice/Report.pdf', mime: 'application/pdf' })
    expect(first).toMatchObject({ name: 'Report 2.pdf', rights: ['create'], version: null, mime: 'application/pdf' })
    const second = await files.serve('files/create', { suggestedName: 'Report.pdf' })
    expect(second.name, 'an uncommitted create holds its name').toBe('Report 3.pdf')
    expect(await refused(files.serve('files/create', { suggestedName: 'run.exe' }))).toBe('not-allowed')
    expect(await refused(files.serve('files/create', { suggestedName: 'Report.pdf', folder: first.handle }))).toBe('file-not-granted')
    const [folder] = (await files.serve('files/pick', { purpose: 'Where', mode: 'folder', accept: ['png'] })).files
    const inFolder = await files.serve('files/create', { suggestedName: 'x.png', folder: folder!.handle })
    expect(inFolder.name).toBe('x 2.png')
    await files.serve('files/write', { handle: inFolder.handle, bytes: encode('png'), offset: 0, final: true })
    expect(decode(disk.get('out/x 2.png')!.bytes)).toBe('png')
    expect(decode(disk.get('talks/Report.pdf')!.bytes), 'the existing file is untouched').toBe('old')
  })

  it('files/write: stages chunks, commits once, and moves on when the name was taken meanwhile', async () => {
    const { storage, files: disk } = workspace()
    const files = session(storage)
    const out = await files.serve('files/create', { suggestedName: 'Out.pdf' })
    expect(await files.serve('files/write', { handle: out.handle, bytes: encode('he'), offset: 0 })).toEqual({})
    expect(await refused(files.serve('files/write', { handle: out.handle, bytes: encode('x'), offset: 5 })), 'a chunk at the wrong offset').toBe(-32602)
    expect(disk.has('talks/Out.pdf'), 'nothing appears before the commit').toBe(false)
    // Someone else takes the name before the commit: the create never replaces it.
    disk.set('talks/Out.pdf', { bytes: encode('theirs'), version: 1 })
    expect(await files.serve('files/write', { handle: out.handle, bytes: encode('llo'), offset: 2, final: true })).toEqual({ version: 'v1' })
    expect(decode(disk.get('talks/Out.pdf')!.bytes)).toBe('theirs')
    expect(decode(disk.get('talks/Out 2.pdf')!.bytes)).toBe('hello')
    expect(await refused(files.serve('files/write', { handle: out.handle, bytes: encode('again'), offset: 0, final: true }))).toBe('already-committed')
    expect((await files.serve('files/stat', { handle: out.handle })).name).toBe('Out 2.pdf')
  })

  it('files/write: replaces only the expected version, never a file with unsaved edits, within quota', async () => {
    const { storage, unsaved, files: disk } = workspace({ 'talks/Old.pdf': 'old' })
    const files = session(storage, { pick: async () => ['talks/Old.pdf'], quota: { perGrant: 10 } })
    const [old] = (await files.serve('files/pick', { purpose: 'Replace', mode: 'save', accept: ['pdf'] })).files
    const handle = old!.handle
    expect(await refused(files.serve('files/write', { handle, bytes: encode('new'), offset: 0, final: true })), 'no expected version').toBe('conflict')
    const fresh = session(storage, { pick: async () => ['talks/Old.pdf'] })
    const [again] = (await fresh.serve('files/pick', { purpose: 'Replace', mode: 'save', accept: ['pdf'] })).files
    expect(await refused(fresh.serve('files/write', { handle: again!.handle, bytes: encode('new'), offset: 0, final: true, expected: 'v0' }))).toBe('conflict')
    unsaved.add('talks/Old.pdf')
    const third = session(storage, { pick: async () => ['talks/Old.pdf'] })
    const [held] = (await third.serve('files/pick', { purpose: 'Replace', mode: 'save', accept: ['pdf'] })).files
    expect(await refused(third.serve('files/write', { handle: held!.handle, bytes: encode('new'), offset: 0, final: true, expected: 'v1' }))).toBe('unsaved-edits')
    unsaved.clear()
    const fourth = session(storage, { pick: async () => ['talks/Old.pdf'], quota: { perGrant: 4 } })
    const [capped] = (await fourth.serve('files/pick', { purpose: 'Replace', mode: 'save', accept: ['pdf'] })).files
    expect(await refused(fourth.serve('files/write', { handle: capped!.handle, bytes: encode('too long'), offset: 0, final: true, expected: 'v1' }))).toBe('quota')
    expect(await fourth.serve('files/write', { handle: capped!.handle, bytes: encode('new'), offset: 0, final: true, expected: 'v1' })).toEqual({ version: 'v2' })
    expect(decode(disk.get('talks/Old.pdf')!.bytes)).toBe('new')
  })

  it('files/read and files/stat: ranged reads of a read handle; nothing for other rights or handles', async () => {
    const { storage, files: disk } = workspace({ 'in/a.pdf': 'abcdef' })
    const files = session(storage, { pick: async () => ['in/a.pdf'] })
    const [picked] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    const read = await files.serve('files/read', { handle: picked!.handle, offset: 2, length: 3 })
    expect({ text: decode(read.bytes), version: read.version, size: read.size }).toEqual({ text: 'cde', version: 'v1', size: 6 })
    expect(await files.serve('files/stat', { handle: picked!.handle })).toMatchObject({ name: 'a.pdf', size: 6, version: 'v1', rights: ['read'] })
    expect(await refused(files.serve('files/read', { handle: picked!.handle, offset: -1 }))).toBe(-32602)
    const out = await files.serve('files/create', { suggestedName: 'Out.pdf' })
    expect(await refused(files.serve('files/read', { handle: out.handle })), 'a create handle reads nothing').toBe('file-not-granted')
    expect(await refused(files.serve('files/read', { handle: 'fh_00000000000000000000000000000000' }))).toBe('file-not-granted')
    expect(await refused(files.serve('files/read', { handle: 'in/a.pdf' })), 'a path is no handle').toBe('file-not-granted')
    disk.delete('in/a.pdf')
    expect(await refused(files.serve('files/stat', { handle: picked!.handle }))).toBe('file-not-granted')
  })

  it('files/list: a folder\'s matching files, each with read only', async () => {
    const { storage } = workspace({ 'in/a.png': 'A', 'in/b.pdf': 'B', 'in/sub/c.png': 'C', 'in/.secret.png': 'S' })
    const files = session(storage, { pick: async () => ['in'] })
    const [folder] = (await files.serve('files/pick', { purpose: 'Batch', mode: 'folder', accept: ['png'] })).files
    const listed = (await files.serve('files/list', { handle: folder!.handle })).files
    expect(listed.map(({ name, rights }) => ({ name, rights }))).toEqual([{ name: 'a.png', rights: ['read'] }])
    expect(await refused(files.serve('files/list', { handle: listed[0]!.handle })), 'a file is no folder').toBe('file-not-granted')
    expect(await refused(files.serve('files/write', { handle: listed[0]!.handle, bytes: encode('x'), offset: 0, final: true }))).toBe('file-not-granted')
  })

  it('files/release, revoke, and the session\'s end expire handles and drop staged writes', async () => {
    const { storage, files: disk } = workspace({ 'in/a.pdf': 'A' })
    const revoked = vi.fn()
    const files = session(storage, { pick: async () => ['in/a.pdf'], revoked })
    const [picked] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    expect(await files.serve('files/release', { handles: [picked!.handle, 'fh_unknown'] })).toEqual({})
    expect(await refused(files.serve('files/read', { handle: picked!.handle }))).toBe('file-not-granted')
    const [again] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    await files.revoke([again!.handle])
    expect(revoked).toHaveBeenCalledWith([again!.handle])
    expect(await refused(files.serve('files/stat', { handle: again!.handle }))).toBe('file-not-granted')
    const out = await files.serve('files/create', { suggestedName: 'Out.pdf' })
    await files.serve('files/write', { handle: out.handle, bytes: encode('half'), offset: 0 })
    await files.end()
    expect(await refused(files.serve('files/write', { handle: out.handle, bytes: encode('rest'), offset: 4, final: true }))).toBe('file-not-granted')
    expect(disk.has('talks/Out.pdf')).toBe(false)
    expect(files.grants()).toEqual([])
  })

  it('refuses another session\'s handle (FA5)', async () => {
    const { storage } = workspace({ 'in/a.pdf': 'A' })
    const mine = session(storage, { pick: async () => ['in/a.pdf'] })
    const theirs = session(storage, { kit: 'kit.other', principal: 'bob' })
    const [picked] = (await mine.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    expect(await refused(theirs.serve('files/read', { handle: picked!.handle }))).toBe('file-not-granted')
  })

  it('files/print: a PDF from bytes or a read handle, from a gesture, answering only whether it printed', async () => {
    const { storage } = workspace({ 'in/a.pdf': '%PDF', 'in/b.png': 'png' })
    const printed: Array<{ title: string; text: string }> = []
    const print = async ({ bytes, title }: { bytes: Uint8Array; title: string }) => {
      printed.push({ title, text: decode(bytes) })
      return true
    }
    const answers = [['in/a.pdf'], ['in/b.png']]
    const files = session(storage, { print, pick: async () => answers.shift() ?? [] })
    expect(await files.serve('files/print', { bytes: encode('%PDF-1.7'), mime: 'application/pdf', title: 'Report' })).toEqual({ printed: true })
    const [pdf] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    expect(await files.serve('files/print', { handle: pdf!.handle, title: 'a' })).toEqual({ printed: true })
    expect(printed).toEqual([{ title: 'Report', text: '%PDF-1.7' }, { title: 'a', text: '%PDF' }])
    const [png] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['png'] })).files
    expect(await refused(files.serve('files/print', { handle: png!.handle, title: 'b' }))).toBe('not-allowed')
    expect(await refused(session(storage).serve('files/print', { bytes: encode('%PDF'), mime: 'application/pdf', title: 'x' }))).toBe('unsupported')
    expect(await refused(session(storage, { print, gesture: () => false }).serve('files/print', { bytes: encode('%PDF'), mime: 'application/pdf', title: 'x' }))).toBe('no-gesture')
    expect(await refused(session(storage, { print, manifest: { read: ['pdf'] } }).serve('files/print', { bytes: encode('%PDF'), mime: 'application/pdf', title: 'x' }))).toBe('not-allowed')
  })

  it('grant: an agent reads and creates on the host\'s policy, and replaces a file only with approval (FA13, FA17)', async () => {
    const { storage } = workspace({ 'in/a.pdf': 'A', 'talks/Other.pdf': 'other', 'in/.hidden/x.pdf': 'h' })
    const log = vi.fn()
    const files = session(storage, { log })
    const read: KitFileStat = await files.grant('in/a.pdf', ['read'], { flow: 'agent' })
    expect(read).toMatchObject({ name: 'a.pdf', rights: ['read'] })
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ flow: 'agent', rights: ['read'], name: 'a.pdf' }))
    expect(await refused(files.grant('in/.hidden/x.pdf', ['read'], { flow: 'agent' })), 'a hidden file as a missing one').toBe('not-allowed')
    expect(await refused(files.grant('in/missing.pdf', ['read'], { flow: 'agent' }))).toBe('not-allowed')
    expect(await refused(files.grant('talks/Other.pdf', ['create'], { flow: 'agent' })), 'create never names an existing file').toBe('not-allowed')
    expect(await files.grant('talks/New.pdf', ['create'], { flow: 'agent' })).toMatchObject({ rights: ['create'], version: null })
    expect(await refused(files.grant('talks/Other.pdf', ['write'], { flow: 'agent' }))).toBe('not-allowed')
    expect(await files.grant('talks/Other.pdf', ['write'], { flow: 'agent', approved: true })).toMatchObject({ rights: ['write'], version: 'v1' })
    expect(await refused(session(storage, { readOnly: true }).grant('talks/Other.pdf', ['write'], { flow: 'agent', approved: true }))).toBe('not-allowed')
    expect(await refused(session(storage, { manifest: { read: ['pdf'], create: ['png'] } }).grant('in/a.pdf', ['read', 'write'], { flow: 'drop' })), 'K15: no write outside the create list').toBe('not-allowed')
  })

  it('answers io-error for a storage failure, naming no path', async () => {
    const { storage } = workspace({ 'in/a.pdf': 'A' })
    const files = session({ ...storage, read: async () => Promise.reject(new Error('EACCES: /Users/alice/in/a.pdf')) }, { pick: async () => ['in/a.pdf'] })
    const [picked] = (await files.serve('files/pick', { purpose: 'p', mode: 'open', accept: ['pdf'] })).files
    const error = await files.serve('files/read', { handle: picked!.handle }).catch((failure: unknown) => failure)
    expect(fileErrorReason(error)).toBe('io-error')
    expect((error as Error).message).not.toContain('/Users/')
  })
})
