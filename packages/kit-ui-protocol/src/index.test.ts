// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { serviceAllowed, parseCommentAnchor, parseServiceParams, parseDocumentPermissions, parseWatermark, GENERATE_PURPOSES, KitPeer, KitRpcError, hostRequestErrorReason, isGeneratePurpose, linkPathFrom, parseKitView, parseLinksPickParams, parsePeers, parsePresence, parseSchemaReport, PRESENCE_SELECTION_LIMIT, type HostPeer, type KitSidePeer } from './index'

/** A connected host/kit pair of peers, over a real `MessageChannel`. */
function peers() {
  const channel = new MessageChannel()
  const host: HostPeer = new KitPeer(channel.port1, 'h')
  const kit: KitSidePeer = new KitPeer(channel.port2, 'k')
  return { host, kit }
}

describe('replica/info and replica/changed', () => {
  it('answers replica/info with the replica\'s own id, or null when it has none', async () => {
    const { host, kit } = peers()
    kit.handle('replica/info', () => ({ docId: 'room-1' }))
    expect(await host.request('replica/info', {})).toEqual({ docId: 'room-1' })
    kit.handle('replica/info', () => ({ docId: null }))
    expect(await host.request('replica/info', {})).toEqual({ docId: null })
    host.close()
    kit.close()
  })

  it('carries replica/changed as a notification, not a request', async () => {
    const { host, kit } = peers()
    const heard: ArrayBuffer[] = []
    host.on('replica/changed', (params) => heard.push(params.version))
    kit.notify('replica/changed', { version: new Uint8Array([4, 2]).buffer })
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    expect(new Uint8Array(heard[0])).toEqual(new Uint8Array([4, 2]))
    host.close()
    kit.close()
  })
})

describe('presence', () => {
  it('checks a presence and a peer list from the other side', () => {
    expect(parsePresence(null)).toBeNull()
    expect(parsePresence({})).toEqual({ selection: [] })
    const many = Array.from({ length: PRESENCE_SELECTION_LIMIT + 5 }, (_, index) => `id-${index}`)
    expect(parsePresence({ selection: many })?.selection).toHaveLength(PRESENCE_SELECTION_LIMIT)
    expect(parsePresence({ selection: ['a'], caret: { object: 'b', field: 'text', offset: 1.5 } })).toEqual({ selection: ['a'] })
    expect(
      parsePeers([
        { principal: 'p1', name: 'Alice', color: '#e5484d', selection: ['a'], caret: { object: 'b', field: 'text', offset: 2 } },
        { name: 'Nobody' },
        'Bob',
        { principal: 'p2', name: 'Bob', selection: [] },
      ]),
    ).toEqual([
      { principal: 'p1', name: 'Alice', color: '#e5484d', selection: ['a'], caret: { object: 'b', field: 'text', offset: 2 } },
      { principal: 'p2', name: 'Bob', color: '', selection: [] },
    ])
    expect(parsePeers('nobody')).toEqual([])
  })
})

describe('document/schema', () => {
  it('takes a report of a newer schema with whole numbers, and nothing else', () => {
    expect(parseSchemaReport({ reads: 1, newestAuthor: 2 })).toEqual({ reads: 1, newestAuthor: 2 })
    expect(parseSchemaReport({ reads: 2, newestAuthor: 2 })).toBeNull()
    expect(parseSchemaReport({ reads: 3, newestAuthor: 2 })).toBeNull()
    expect(parseSchemaReport({ reads: 1, newestAuthor: 2.5 })).toBeNull()
    expect(parseSchemaReport({ reads: '1', newestAuthor: 2 })).toBeNull()
    expect(parseSchemaReport(null)).toBeNull()
  })
})

describe('generation purposes', () => {
  it('are the defined ones, or the kit’s own as <kit>.<name>', () => {
    expect(GENERATE_PURPOSES).toEqual(['ai-field', 'rewrite'])
    for (const purpose of GENERATE_PURPOSES) expect(isGeneratePurpose(purpose)).toBe(true)
    expect(isGeneratePurpose('note.outline', 'kit.note')).toBe(true)
    expect(isGeneratePurpose('note.ask-2', 'kit.note')).toBe(true)
    expect(isGeneratePurpose('note.outline')).toBe(false)
    expect(isGeneratePurpose('note.outline', 'kit.table')).toBe(false)
    for (const purpose of ['note-rewrite', 'note.', 'note.Outline', 'note.a.b', 'note. x', '']) expect(isGeneratePurpose(purpose, 'kit.note'), purpose).toBe(false)
    expect(isGeneratePurpose(7, 'kit.note')).toBe(false)
  })
})

describe('host request refusals', () => {
  it('reads the reason of a refused host/generate or host/action, and nothing else', () => {
    expect(hostRequestErrorReason(new KitRpcError(-32000, 'no credits', { reason: 'quota' }))).toBe('quota')
    expect(hostRequestErrorReason(new KitRpcError(-32000, 'gone', { reason: 'not-found' }))).toBe('not-found')
    expect(hostRequestErrorReason(new KitRpcError(-32000, 'odd', { reason: 'held' }))).toBeNull()
    expect(hostRequestErrorReason(new KitRpcError(-32601, 'unsupported'))).toBeNull()
    expect(hostRequestErrorReason(new Error('plain'))).toBeNull()
  })

  it('checks a view: known members of their types, nothing else', () => {
    expect(parseKitView({ path: 'tables/3', page: 2, heading: ['Plan', 'Risks'], time: 1.5 })).toEqual({ path: 'tables/3', page: 2, heading: ['Plan', 'Risks'], time: 1.5 })
    expect(parseKitView({ objectId: 'o1', extra: 'x', slide: 0, sheet: 7, cell: '', heading: [1] })).toEqual({ objectId: 'o1' })
    expect(parseKitView({ extra: 1 })).toBeNull()
    expect(parseKitView(['path'])).toBeNull()
    expect(parseKitView('tables/3')).toBeNull()
    expect(parseKitView(undefined)).toBeNull()
  })
})

describe('picking a file to link', () => {
  it('checks links/pick params', () => {
    expect(parseLinksPickParams({ purpose: 'library', accept: ['KDESIGN', 'kdesign', 'fig'] })).toEqual({ purpose: 'library', accept: ['kdesign', 'fig'], multiple: false })
    expect(parseLinksPickParams({ purpose: 'pictures', accept: ['png'], multiple: true })).toEqual({ purpose: 'pictures', accept: ['png'], multiple: true })
    for (const value of [null, {}, { purpose: 'x' }, { purpose: 'x', accept: [] }, { purpose: 'x', accept: ['.png'] }, { purpose: 'x', accept: ['a/b'] }, { purpose: 1, accept: ['png'] }, { purpose: 'x', accept: [3] }]) {
      expect(parseLinksPickParams(value), JSON.stringify(value)).toBeNull()
    }
  })

  it("names a workspace file from the document's folder (HC-P2)", () => {
    expect(linkPathFrom('Home.kdesign', 'libraries/Icons.kdesign')).toBe('libraries/Icons.kdesign')
    expect(linkPathFrom('designs/Home.kdesign', 'designs/Icons.kdesign')).toBe('Icons.kdesign')
    expect(linkPathFrom('designs/app/Home.kdesign', 'libraries/Icons.kdesign')).toBe('../../libraries/Icons.kdesign')
    expect(linkPathFrom('designs/app/Home.kdesign', 'designs/lib/Icons.kdesign')).toBe('../lib/Icons.kdesign')
    expect(linkPathFrom('a/b.kdesign', 'a')).toBe('../a')
  })
})

describe('document permissions and watermark (managed co-editing D2)', () => {
  it('allows everything when the host sends no permissions, and only true flags otherwise', () => {
    expect(parseDocumentPermissions(undefined)).toEqual({ download: true, export: true, share: true })
    expect(parseDocumentPermissions({ download: true, export: 1, share: false })).toEqual({ download: true, export: false, share: false })
    expect(parseDocumentPermissions('all')).toEqual({ download: false, export: false, share: false })
  })

  it('draws a checked watermark or none', () => {
    expect(parseWatermark({ text: ' Ann ' })).toEqual({ text: 'Ann' })
    expect(parseWatermark(null)).toBeNull()
    expect(parseWatermark({ text: '' })).toBeNull()
    expect(parseWatermark({ text: 'x'.repeat(257) })).toBeNull()
    expect(parseWatermark({ text: 'a\u0007b' })).toBeNull()
  })
})

describe('host services and comment anchors (D4)', () => {
  it('keeps well-formed anchors only', () => {
    expect(parseCommentAnchor({ ids: ['a', 'b'], range: { start: 1, end: 4 }, quote: 'abc', page: 2, label: 'Slide 3' })).toEqual({ ids: ['a', 'b'], range: { start: 1, end: 4 }, quote: 'abc', page: 2, label: 'Slide 3' })
    expect(parseCommentAnchor({ ids: [] })).toBeNull()
    expect(parseCommentAnchor({ ids: ['a', 3] })).toBeNull()
    expect(parseCommentAnchor({ ids: Array.from({ length: 257 }, (_, i) => `id${i}`) })).toBeNull()
    expect(parseCommentAnchor({ ids: ['a'], range: { start: 4, end: 1 } })).toBeNull()
    expect(parseCommentAnchor({ ids: ['a'], quote: 'x'.repeat(501) })).toBeNull()
    expect(parseCommentAnchor({ ids: ['a'], page: -1 })).toBeNull()
  })

  it('checks every service`s params (UI-V3)', () => {
    expect(parseServiceParams({ service: 'people.mention', params: { query: 'an', limit: 5 } })).toEqual({ service: 'people.mention', params: { query: 'an', limit: 5 } })
    expect(parseServiceParams({ service: 'people.mention', params: { query: 'an', limit: 500 } })).toBeNull()
    expect(parseServiceParams({ service: 'people.notify', params: { people: ['u1'], message: 'look', anchor: { ids: ['p'] } } })).toMatchObject({ params: { anchor: { ids: ['p'] } } })
    expect(parseServiceParams({ service: 'people.notify', params: { people: [], message: 'look' } })).toBeNull()
    expect(parseServiceParams({ service: 'people.notify', params: { people: ['u1'], message: 'x'.repeat(2001) } })).toBeNull()
    expect(parseServiceParams({ service: 'file.saveAs', params: { bytes: new ArrayBuffer(2), name: 'Copy.docx' } })).not.toBeNull()
    expect(parseServiceParams({ service: 'file.saveAs', params: { name: 'Copy.docx' } })).toBeNull()
    expect(parseServiceParams({ service: 'access.request', params: { perm: 'owner' } })).toBeNull()
    expect(parseServiceParams({ service: 'share.open', params: { anything: 1 } })).toEqual({ service: 'share.open', params: {} })
    expect(parseServiceParams({ service: 'window.open', params: {} })).toBeNull()
    expect(parseServiceParams({ service: 'comment.create', params: { anchor: { ids: ['p'] }, text: 'hi' } })).not.toBeNull()
  })
})

describe('host services and the document`s permissions (UI-V3, UI-V4)', () => {
  it('allows each service only with the right it needs', () => {
    const viewer = { readOnly: true, permissions: { download: false, export: false, share: false } }
    const commenter = { readOnly: true, comments: { canComment: true }, permissions: { download: true, export: false, share: true } }
    const editor = { readOnly: false }
    expect(['comment.create', 'people.mention', 'people.notify', 'file.rename', 'image.insert', 'file.saveAs', 'share.open'].filter((id) => serviceAllowed(id as never, viewer))).toEqual([])
    expect(serviceAllowed('access.request', viewer)).toBe(true)
    expect(serviceAllowed('editor.close', viewer)).toBe(true)
    expect(serviceAllowed('comment.create', commenter)).toBe(true)
    expect(serviceAllowed('file.rename', commenter)).toBe(false)
    expect(serviceAllowed('file.saveAs', commenter)).toBe(true)
    expect(serviceAllowed('share.open', commenter)).toBe(true)
    expect(serviceAllowed('file.rename', editor)).toBe(true)
    expect(serviceAllowed('share.open', editor)).toBe(true)
  })

  it('refuses control and bidirectional formatting characters in what hosts show', () => {
    expect(parseCommentAnchor({ ids: ['p1'], quote: 'line one\nline two' })).not.toBeNull()
    expect(parseCommentAnchor({ ids: ['p1'], label: 'a\u202eb' })).toBeNull()
    expect(parseCommentAnchor({ ids: ['p\u0000'] })).toBeNull()
    expect(parseCommentAnchor({ ids: ['p1'], label: 'two\nlines' })).toBeNull()
    expect(parseServiceParams({ service: 'comment.create', params: { anchor: { ids: ['p'] }, text: 'ok\nfine' } })).not.toBeNull()
    expect(parseServiceParams({ service: 'comment.create', params: { anchor: { ids: ['p'] }, text: 'evil\u2066' } })).toBeNull()
    expect(parseServiceParams({ service: 'people.notify', params: { people: ['u1'], message: 'bell\u0007' } })).toBeNull()
    expect(parseServiceParams({ service: 'file.rename', params: { name: 'a\u202egpj.exe' } })).toBeNull()
  })
})
