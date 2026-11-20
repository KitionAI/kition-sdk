import { describe, expect, it } from 'vitest'
import { GATEWAY_PAGE_PROTOCOL, gatewayPageAddress, isGatewayPageMessage } from '../src/index'
import { answer, backoff, events, failure, type BridgeEditor } from '../src/page/bridge'
import { cleanPath, encodePath, gatewayRoot } from '../src/page/gateway'
import { packReplica, readable, unpackReplica } from '../src/page/host'
import { agentInspect } from '../src/page/inspect'
import { chooseKit, extensionOf, shortcutsFrom } from '../src/page/kits'

describe('the gateway page: addresses and the kit a file opens in', () => {
  it('finds the gateway root before page/, under any prefix and through a signed page address', () => {
    expect(gatewayRoot('/page/')).toBe('/')
    expect(gatewayRoot('/page/review')).toBe('/')
    expect(gatewayRoot('/kition/page/')).toBe('/kition/')
    expect(gatewayRoot('/a/b/page/review')).toBe('/a/b/')
    expect(gatewayRoot('/_signed/4102444800.6.abcdef/page/')).toBe('/')
    expect(gatewayRoot('/proxy/_signed/1.6.ab/page/review')).toBe('/proxy/')
  })

  it('names workspace files relatively, refusing ways out', () => {
    expect(cleanPath('notes/a b.md')).toBe('notes/a b.md')
    for (const refused of ['', '/etc/passwd', '../x.md', 'a/../../x', 'a//b', './a', 'C:/x', 'a\\..\\b']) expect(cleanPath(refused), refused).toBeNull()
    expect(encodePath('notes/a b#1.md')).toBe('notes/a%20b%231.md')
    expect(() => readable('.kition/drafts/x', 'a.md')).toThrow(/not readable/)
    expect(() => readable('art/.hidden.png', 'a.md')).toThrow(/not readable/)
    expect(readable('art/photo.png', 'a.md')).toBe('art/photo.png')
  })

  it('gives a file to the kit that edits it over one that views it', () => {
    const kits = [
      { id: 'kit.doc', edit: ['docx'], view: ['html', 'htm'] },
      { id: 'kit.html', edit: ['html', 'htm'] },
      { id: 'kit.vector', edit: ['kvector'], view: ['svg'] },
    ]
    expect(chooseKit(kits, 'site/index.HTML')).toEqual({ id: 'kit.html', edits: true })
    expect(chooseKit(kits, 'a.htm')).toEqual({ id: 'kit.html', edits: true })
    expect(chooseKit(kits, 'logo.svg')).toEqual({ id: 'kit.vector', edits: false })
    expect(chooseKit(kits, 'report.docx')).toEqual({ id: 'kit.doc', edits: true })
    expect(chooseKit(kits, 'README')).toBeNull()
    expect(chooseKit(kits, 'x.ktable')).toBeNull()
    expect(extensionOf('a/b.c/.hidden')).toBe('')
  })

  it('takes the host shortcuts a framing host adds from the address, and nothing else', () => {
    expect(gatewayPageAddress('/kition/', 'a.md', { keys: ['Cmd+Alt+,', 'Cmd+Alt+W'] })).toBe('/kition/page/?path=a.md&keys=Cmd%2BAlt%2B%2C+Cmd%2BAlt%2BW')
    expect(shortcutsFrom('Cmd+Alt+, Cmd+Alt+W Cmd+Alt+W')).toEqual(['Cmd+Alt+,', 'Cmd+Alt+W'])
    expect(shortcutsFrom('a Cmd+ <script> Alt+F12 Shift+Enter')).toEqual(['Alt+F12', 'Shift+Enter'])
    expect(shortcutsFrom(null)).toEqual([])
  })

  it('builds the addresses a host frames and reads only its own messages', () => {
    expect(gatewayPageAddress('/kition', 'notes/plan.md', { theme: 'dark', locale: 'zh' })).toBe('/kition/page/?path=notes%2Fplan.md&theme=dark&locale=zh')
    expect(gatewayPageAddress('/', 'a.ktable', { view: 'review' })).toBe('/page/review?path=a.ktable')
    expect(isGatewayPageMessage({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: 'theme', theme: 'dark' })).toBe(true)
    for (const other of [null, 'x', { type: 'theme' }, { kitionGatewayPage: 2, type: 'save' }, { kitionKitUi: 1, ready: 'x' }]) expect(isGatewayPageMessage(other)).toBe(false)
  })

  it('keeps a replica as its snapshot length, snapshot and blobs', () => {
    const snapshot = new Uint8Array([1, 2, 3]).buffer
    const blobs = new Uint8Array([9, 8]).buffer
    const packed = packReplica({ snapshot, blobs })
    expect(new Uint8Array(packed)).toEqual(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 9, 8]))
    const back = unpackReplica(packed, '"stamp"')!
    expect([new Uint8Array(back.snapshot), new Uint8Array(back.blobs), back.fileStamp]).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([9, 8]), '"stamp"'])
    expect(unpackReplica(new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0]).buffer, '')).toBeNull()
  })
})

/** A kit connection that records what the bridge asks of it. */
function connection(capabilities: string[]) {
  const asked: Array<[string, unknown]> = []
  const fake = {
    capabilities,
    save: async () => ({ saved: true, version: 'v' }),
    check: async (options: unknown) => (asked.push(['check', options]), [{ code: 'x' }]),
    ai: {
      inspect: async (options: unknown) => (asked.push(['inspect', options]), { summary: 'two cells', details: { cells: 2, selection: 'A1', revision: 4 } }),
      commands: async () => [{ id: 'cell.set' }],
      run: async (steps: unknown, save: boolean, options: unknown) => (asked.push(['run', { steps, save, options }]), { completed: [{ command: 'cell.set', changed: true, result: null }], saved: save }),
      preview: async () => ({ png: 'iVBOR' }),
      version: async () => (asked.push(['version', null]), 'AQID'),
      changes: async (since: string, schema?: object) => (asked.push(['changes', { since, schema }]), { changes: { created: [] }, version: 'AQIE' }),
      premise: async (method: string, params: unknown) => (asked.push(['premise', { method, params }]), method === 'none' ? undefined : { unproven: [] }),
    },
    model: {
      describe: async () => ({ root: 'Table', types: {} }),
      batch: async (params: unknown) => (asked.push(['batch', params]), { results: [null], loaded: [], version: 'secret' }),
    },
    draft: { ready: async () => ({ state: 'ready' }), reopen: async () => ({ state: 'open' }) },
  }
  return { fake, asked }
}

function editors(capabilities: string[], readOnly = false) {
  const { fake, asked } = connection(capabilities)
  const editor: BridgeEditor = {
    path: 'tables/tasks.ktable',
    kit: 'kit.table',
    connection: fake as never,
    revision: () => 7,
    dirty: () => true,
    readOnly,
    inspected: (answer) => agentInspect(answer, ['selection']),
  }
  return { map: new Map([[editor.path, editor]]), asked }
}

describe('the gateway page: the Kit AI bridge', () => {
  it('lists the open document with the kit’s capabilities', async () => {
    const { map } = editors(['context', 'changes', 'model'])
    expect(await answer(map, 'kit/documents', {})).toEqual({ documents: [{ path: 'tables/tasks.ktable', kit: 'kit.table', dirty: true, revision: 7, capabilities: ['context', 'changes', 'model'] }] })
  })

  it('answers version, changes and premise from the editor, and runs with the call context the gateway planned', async () => {
    const { map, asked } = editors(['context', 'changes', 'model', 'premises'])
    const call = (tool: string, args: Record<string, unknown>) => answer(map, 'kit/call', { path: './tables/tasks.ktable', kit: 'kit.table', tool, arguments: args })
    expect(await call('version', {})).toEqual({ version: 'AQID' })
    expect(await call('changes', { since: 'AQID' })).toEqual({ changes: { created: [] }, version: 'AQIE' })
    expect(await call('premise', { method: 'identity', params: { ids: ['a'] } })).toEqual({ unproven: [] })
    expect(await call('premise', { method: 'none' })).toBeNull()
    const steps = [{ command: 'cell.set', params: { value: 1 }, context: { on: ['cell:A1'], part: { sheet: 1 } } }]
    const ran = (await call('run', { steps, save: false })) as Record<string, unknown>
    expect(ran.completed).toEqual([{ command: 'cell.set', changed: true, result: null }])
    // The document as the headless path answers it: no selection, no session bookkeeping.
    expect(ran.document).toEqual({ summary: 'two cells', details: { cells: 2 } })
    expect(asked.find(([what]) => what === 'run')?.[1]).toEqual({ steps, save: false, options: {} })
    const inspected = await call('inspect', { context: { part: { sheet: 2 } }, part: 2 })
    expect(inspected).toEqual({ document: { summary: 'two cells', details: { cells: 2 } } })
    expect(asked.filter(([what]) => what === 'inspect').at(-1)?.[1]).toEqual({ context: { part: { sheet: 2 } }, part: 2 })
    const batch = (await call('batch', { ops: [{ op: 'set' }], load: [], save: true })) as Record<string, unknown>
    expect(batch).toEqual({ results: [null], loaded: [], saved: true })
  })

  it('refuses what the kit does not list, with a code the gateway reads', async () => {
    const { map } = editors([])
    const call = (tool: string) => answer(map, 'kit/call', { path: 'tables/tasks.ktable', tool, arguments: {} })
    for (const tool of ['version', 'changes', 'batch', 'describe', 'check']) {
      const refused = await call(tool).catch((error: unknown) => failure(error))
      expect(refused, tool).toMatchObject({ code: -32000, data: { code: 'unsupported' } })
    }
    await expect(answer(map, 'kit/call', { path: 'other.ktable', tool: 'inspect' })).rejects.toThrow(/not open in a kit editor here/)
    await expect(answer(map, 'kit/call', { path: 'tables/tasks.ktable', kit: 'kit.note', tool: 'inspect' })).rejects.toThrow(/open in kit\.table/)
    await expect(answer(map, 'kit/other', {})).rejects.toThrow(/unknown bridge method/)
    const { map: readOnly } = editors([], true)
    const refused = await answer(readOnly, 'kit/call', { path: 'tables/tasks.ktable', tool: 'run', arguments: { steps: [{ command: 'x' }] } }).catch((error: unknown) => failure(error))
    expect(refused).toMatchObject({ data: { code: 'read-only' } })
  })

  it('reads server-sent events across chunks and backs off when the stream breaks', () => {
    const first = events('data: {"a":1}\n\ndata: {"b"')
    expect(first.messages).toEqual(['{"a":1}'])
    expect(events(`${first.rest}:2}\r\n\r\n: keep-alive\n\n`).messages).toEqual(['{"b":2}'])
    expect([0, 1, 2, 3, 10].map(backoff)).toEqual([500, 1000, 2000, 4000, 10000])
  })
})
