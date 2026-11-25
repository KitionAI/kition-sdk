/**
 * The agent's draft of an open document (protocol section 7d): opened on demand, ready and open
 * again, compared, merged once, discarded, and gone with the document.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DraftInfo } from '@kition/kit-ui-protocol'
import { KitDraft, type KitDraftHost } from './kitDraft'
import type { KitEngine } from './kitEngine'

const summary = { created: [{ id: 's', type: 'Slide', fields: ['shapes'] }], changed: [], deleted: [], texts: [] }

function fakeEngine() {
  const engine = {
    info: { revision: 1 },
    width: 0,
    height: 0,
    disposed: false,
    exported: [] as ArrayBuffer[],
    replicaExport: vi.fn(async (since: ArrayBuffer) => {
      engine.exported.push(since)
      return { changes: new Uint8Array([7]).buffer, blobs: new ArrayBuffer(0) }
    }),
    render: vi.fn(async () => {
      throw new Error('no canvas here')
    }),
    dispose: vi.fn(() => {
      engine.disposed = true
    }),
  }
  return engine
}

function draftOf() {
  const engines: Array<ReturnType<typeof fakeEngine>> = []
  const heard: DraftInfo[] = []
  const merged: unknown[] = []
  const host: KitDraftHost = {
    open: vi.fn(async () => {
      const engine = fakeEngine()
      engines.push(engine)
      return { engine: engine as unknown as KitEngine, base: new Uint8Array([1, 2]).buffer }
    }),
    merge: vi.fn(async (changes, _blobs, origin) => {
      merged.push({ changes: [...new Uint8Array(changes)], origin })
      return summary
    }),
    compare: vi.fn(async () => summary),
    preview: vi.fn(async () => 'before'),
    changed: (info) => heard.push(info),
  }
  return { draft: new KitDraft(host), host, engines, heard, merged }
}

describe('KitDraft', () => {
  it('opens on the first run, once, and refuses other calls without one', async () => {
    const { draft, host, heard } = draftOf()
    expect(draft.info()).toEqual({ state: 'none', revision: null })
    await expect(draft.engine(false)).rejects.toThrow(/no draft/)
    await expect(draft.ready()).rejects.toThrow(/no draft/)
    await expect(draft.merge({ kind: 'agent', principal: 'u' })).rejects.toThrow(/no draft/)
    const [first, second] = await Promise.all([draft.engine(true), draft.engine(true)])
    expect(first).toBe(second)
    expect(host.open).toHaveBeenCalledTimes(1)
    expect(heard).toEqual([{ state: 'open', revision: 1 }])
  })

  it('goes ready, back to the agent, and back to open when the agent edits a ready draft', async () => {
    const { draft, heard } = draftOf()
    await draft.engine(true)
    expect(await draft.ready()).toEqual({ state: 'ready', revision: 1 })
    expect(await draft.reopen()).toEqual({ state: 'open', revision: 1 })
    await draft.ready()
    draft.edited()
    expect(heard.map((info) => info.state)).toEqual(['open', 'ready', 'open', 'ready', 'open'])
  })

  it('compares with the document, with both sides rendered when they can be', async () => {
    const { draft, host } = draftOf()
    await draft.engine(true)
    expect(await draft.compare(256)).toEqual({ summary, before: 'before', after: null })
    expect(host.compare).toHaveBeenCalledWith(expect.any(ArrayBuffer))
    expect(host.preview).toHaveBeenCalledWith(256)
  })

  it('merges its changes since the fork once, then is gone', async () => {
    const { draft, engines, merged, heard } = draftOf()
    await draft.engine(true)
    await draft.ready()
    const origin = { kind: 'agent', principal: 'user:a', label: 'Merged' } as const
    expect(await draft.merge(origin)).toEqual({ merged: true, summary })
    expect([...new Uint8Array(engines[0].exported[0])]).toEqual([1, 2])
    expect(merged).toEqual([{ changes: [7], origin }])
    expect(engines[0].disposed).toBe(true)
    expect(heard.at(-1)).toEqual({ state: 'none', revision: null })
    await expect(draft.merge(origin)).rejects.toThrow(/no draft/)
  })

  it('discards without touching the document, and closes with it', async () => {
    const { draft, engines, merged, host } = draftOf()
    await draft.engine(true)
    expect(await draft.discard()).toEqual({ state: 'none', revision: null })
    expect(engines[0].disposed).toBe(true)
    expect(merged).toEqual([])
    await draft.engine(true)
    draft.dispose()
    expect(engines[1].disposed).toBe(true)
    await expect(draft.engine(true)).rejects.toThrow(/closed/)
    expect(host.open).toHaveBeenCalledTimes(2)
    draft.attach()
    await draft.engine(true)
    expect(host.open).toHaveBeenCalledTimes(3)
  })
})
