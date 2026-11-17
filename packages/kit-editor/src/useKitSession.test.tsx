// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { KIT_UI_PROTOCOL, KitPeer, KitRpcError, LEASE_HELD_REASON, type HostPeer, type KitLease, type KitUiConfig } from '@kition/kit-ui-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectHost, type HostConnection } from './host'
import type { KitCommand, KitModuleManifest } from './engine/kitModule'
import { useKitSession, type KitSessionOptions } from './useKitSession'
import { KitParamsError } from './engine/refusal'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const command = (id: string, menu: string[]): KitCommand => ({ id, title: id, description: null, group: id.split('.')[0], menu, shortcut: null, mutates: true, enabled: true })
const COMMANDS = [command('image.crop', ['Image']), command('filter.blur', ['Filter']), command('layer.new', ['Layer']), { ...command('view.zoomIn', ['View']), mutates: true }, { ...command('edit.undo', ['Edit']), mutates: false }]

/** A deferred `commands()` answer the test resolves when it chooses. */
type Pending = { resolve: (list: KitCommand[]) => void }

/**
 * The fake `useKitDocument` session: a document whose `commands()` answers at once, or waits for
 * the test when `hold`; a recording `run`; and a `save` spy.
 */
const fake = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('./engine/useKitDocument', () => ({ useKitDocument: () => fake.session }))

function fakeSession(hold: boolean) {
  const pending: Pending[] = []
  const ran: string[] = []
  const doc = {
    agentReply: async <T,>(value: T) => value,
    info: { revision: 0, dirty: false, width: 1, height: 1, canUndo: false, canRedo: false, inspected: null },
    commands: vi.fn(() => (hold ? new Promise<KitCommand[]>((resolve) => pending.push({ resolve })) : Promise.resolve(COMMANDS))),
    check: vi.fn(async () => [{ code: 'test.live', severity: 'warning', target: {}, message: 'On the document.' }]),
  }
  const session = {
    doc,
    failure: null,
    change: { revision: 0, damage: null },
    dirty: false,
    run: vi.fn(async (id: string, ..._rest: unknown[]) => {
      ran.push(id)
      doc.info.revision += 1
      doc.info.dirty = true
      return null
    }),
    save: vi.fn(async () => undefined),
    checkFile: vi.fn(async () => undefined),
    draft: {
      open: vi.fn(async () => ({ engine: draftEngine, base: new Uint8Array([9]).buffer })),
      merge: vi.fn(async () => ({ created: [], changed: [{ id: 'p', type: 'Page', fields: ['title'] }], deleted: [], texts: [] })),
      compare: vi.fn(async () => ({ created: [], changed: [], deleted: [], texts: [] })),
    },
  }
  /** The agent's draft: a second engine its runs go to (protocol section 7d). */
  const draftRan: string[] = []
  const draftEngine = {
    agentReply: async <T,>(value: T) => value,
    info: { revision: 0, dirty: false, width: 1, height: 1, canUndo: false, canRedo: false, inspected: { slides: 1 } },
    width: 1,
    height: 1,
    execute: vi.fn(async (id: string) => {
      draftRan.push(id)
      draftEngine.info.revision += 1
      return '{"ok":true}'
    }),
    replicaExport: vi.fn(async () => ({ changes: new Uint8Array([5]).buffer, blobs: new ArrayBuffer(0) })),
    modelBatch: vi.fn(async (request: { ops?: unknown[] }) => ({ refs: {}, results: (request.ops ?? []).map(() => null), loaded: [], version: null })),
    check: vi.fn(async () => [{ code: 'test.draft', severity: 'info', target: {}, message: 'On the draft.' }]),
    dispose: vi.fn(),
  }
  fake.session = session
  return { doc, session, pending, ran, draftEngine, draftRan }
}

/** Opens the handshake and sends `ui/initialize`, as a host embedding a kit would (as in host.test.ts). */
async function connect(ui?: KitUiConfig, readOnly = false, canComment = false, capabilities: string[] = []) {
  const channel = new MessageChannel()
  const hostPeer = new KitPeer(channel.port1, 'h') as HostPeer
  const connection = connectHost({ id: 'kit.test', version: '1', ui: { panels: [] } })
  window.dispatchEvent(new MessageEvent('message', { source: window, data: { kitionKitUi: 1, protocol: KIT_UI_PROTOCOL }, ports: [channel.port2] }))
  const initialized = hostPeer.request('ui/initialize', {
    protocol: KIT_UI_PROTOCOL,
    host: { name: 'host', version: '1' },
    document: { path: 'a.psd', name: 'a.psd', bytes: new ArrayBuffer(1), version: 'v1', ...(readOnly ? { readOnly } : {}), ...(canComment ? { comments: { me: 'carol', canComment: true, othersReadOnly: false } } : {}) },
    theme: { colorScheme: 'light', tokens: {} },
    locale: 'en-US',
    shortcuts: [],
    capabilities,
    ...(ui ? { ui } : {}),
  })
  return { hostPeer, initialized, host: await connection }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** Mounts `useKitSession` over the fake document and returns the session it answers. */
async function mount(ui?: KitUiConfig, hold = false, readOnly = false, options: KitSessionOptions = {}, commenter: { canComment: boolean; commentCommands: string[] } | null = null, capabilities: string[] = []) {
  const fakes = fakeSession(hold)
  const { hostPeer, initialized, host } = await connect(ui, readOnly, commenter?.canComment ?? false, capabilities)
  const manifest = { kitId: 'kit.test', ...(commenter ? { commentCommands: commenter.commentCommands } : {}) } as KitModuleManifest
  const current: { session: ReturnType<typeof useKitSession<null>> | null } = { session: null }
  function Probe({ connection }: { connection: HostConnection }) {
    current.session = useKitSession(connection, manifest, () => null, options)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe connection={host} />))
  // The session answers `ui/initialize` once the document is open.
  await initialized
  /** Renders again over the fake session as it is now (`fake.session`). */
  const rerender = () => act(async () => root.render(<Probe connection={host} />))
  cleanups.push(() => {
    act(() => root.unmount())
    host.close()
    hostPeer.close()
  })
  return { ...fakes, hostPeer, rerender, kit: () => current.session! }
}

describe('useKitSession', () => {
  it("tells the host of the engine's changes only: a refresh without a new revision or dirty state sends no document/changed", async () => {
    const { hostPeer, rerender, session, doc } = await mount()
    const heard: Array<{ revision: number; dirty: boolean }> = []
    hostPeer.on('document/changed', (params) => heard.push({ revision: params.revision, dirty: params.dirty }))
    // The editor refreshed (its change counter moved) while the engine's revision stayed.
    fake.session = { ...session, change: { revision: 7, damage: null } }
    await rerender()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(heard).toEqual([])
    doc.info.revision += 1
    doc.info.dirty = true
    fake.session = { ...session, change: { revision: 8, damage: null } }
    await rerender()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(heard).toEqual([{ revision: 1, dirty: true }])
  })

  it('tells the host once of each newer schema a document was written under (document/schema)', async () => {
    const { hostPeer, rerender, session, doc } = await mount()
    const heard: unknown[] = []
    hostPeer.on('document/schema', (params) => heard.push(params))
    const show = async (schema: { reads: number; newestAuthor: number | null } | null) => {
      ;(doc.info as { schema?: unknown }).schema = schema
      doc.info.revision += 1
      fake.session = { ...session, change: { revision: doc.info.revision, damage: null } }
      await rerender()
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    }
    await show({ reads: 2, newestAuthor: 2 })
    await show({ reads: 2, newestAuthor: null })
    expect(heard).toEqual([])
    await show({ reads: 2, newestAuthor: 3 })
    await show({ reads: 2, newestAuthor: 3 })
    await show({ reads: 2, newestAuthor: 4 })
    expect(heard).toEqual([
      { reads: 2, newestAuthor: 3 },
      { reads: 2, newestAuthor: 4 },
    ])
  })

  it('passes the refresh option through to the document', async () => {
    const { kit, session } = await mount()
    await act(async () => void (await kit().run('image.crop', {}, null, { refresh: 'none' })))
    expect(session.run).toHaveBeenCalledWith('image.crop', {}, null, { refresh: 'none' })
  })

  it('keeps runs in call order while the menu map loads, with one commands() call', async () => {
    const { kit, pending, ran, doc } = await mount(undefined, true)
    const first = kit().run('image.crop')
    const second = kit().run('layer.new')
    await act(async () => {
      // Held `commands()` calls are answered last first, so an implementation that loaded the
      // menus once per run would run these out of order.
      for (const item of [...pending].reverse()) item.resolve(COMMANDS)
    })
    await Promise.all([first, second])
    expect(ran).toEqual(['image.crop', 'layer.new'])
    expect(doc.commands).toHaveBeenCalledTimes(1)
  })

  it('refuses a host-hidden command run through the session', async () => {
    const { kit, session } = await mount({ hide: ['menu:Filter'] })
    const failure = await kit().run('filter.blur').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitRpcError)
    expect((failure as KitRpcError).data).toMatchObject({ reason: 'not-allowed', command: 'filter.blur' })
    expect(session.run).not.toHaveBeenCalled()
  })

  it('refuses an ai/run with a host-hidden step before running any', async () => {
    const { hostPeer, session } = await mount({ hide: ['menu:Filter'] })
    const failure = await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }, { command: 'filter.blur' }], save: false }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitRpcError)
    expect((failure as KitRpcError).code).toBe(-32000)
    expect((failure as KitRpcError).data).toMatchObject({ reason: 'not-allowed', command: 'filter.blur', step: 1 })
    expect(session.run).not.toHaveBeenCalled()
  })

  it('omits host-hidden commands from ai/commands and lists host-disabled ones as not enabled', async () => {
    const { hostPeer } = await mount({ hide: ['command:image.crop'], disable: ['menu:Filter'] })
    const listed = await hostPeer.request('ai/commands', { query: '' })
    expect(listed.map((item) => [item.id, item.enabled])).toEqual([
      ['filter.blur', false],
      ['layer.new', true],
      ['view.zoomIn', true],
      ['edit.undo', true],
    ])
  })

  describe('read-only (document.readOnly)', () => {
    it('refuses editing commands with the reason read-only and runs viewing ones', async () => {
      const { kit, ran } = await mount(undefined, false, true)
      for (const id of ['layer.new', 'edit.undo']) {
        const failure = await kit().run(id).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(KitRpcError)
        expect((failure as KitRpcError).data).toEqual({ reason: 'read-only', command: id })
      }
      await act(async () => void (await kit().run('view.zoomIn')))
      expect(ran).toEqual(['view.zoomIn'])
    })

    it("runs a commenter's comment commands and refuses them for a viewer", async () => {
      const commenter = await mount(undefined, false, true, {}, { canComment: true, commentCommands: ['layer.new', 'edit.undo'] })
      await act(async () => void (await commenter.kit().run('layer.new')))
      expect(commenter.ran).toEqual(['layer.new'])
      // Undo and Redo reach the engine worker, which takes back only the commenter's own comments
      // (kitEngine.readOnly.test.ts); every other edit stays refused here.
      await act(async () => void (await commenter.kit().run('edit.undo')))
      expect(commenter.ran).toEqual(['layer.new', 'edit.undo'])
      const crop = await commenter.kit().run('image.crop').catch((error: unknown) => error)
      expect((crop as KitRpcError).data).toEqual({ reason: 'read-only', command: 'image.crop' })
      expect(commenter.ran).toEqual(['layer.new', 'edit.undo'])
      const listed = await commenter.hostPeer.request('ai/commands', { query: 'layer' })
      expect(listed.map((item) => [item.id, item.enabled])).toEqual([['layer.new', true]])
      const viewer = await mount(undefined, false, true, {}, { canComment: false, commentCommands: ['layer.new'] })
      const failure = await viewer.kit().run('layer.new').catch((error: unknown) => error)
      expect((failure as KitRpcError).data).toEqual({ reason: 'read-only', command: 'layer.new' })
      expect(viewer.ran).toEqual([])
    })

    it('answers a refusal from the engine with the reason read-only', async () => {
      const { kit, session } = await mount(undefined, false, true)
      session.run.mockRejectedValueOnce(Object.assign(new Error('`view.zoomIn` is not allowed: the document is read-only'), { reason: 'read-only' }))
      const failure = await kit().run('view.zoomIn').catch((error: unknown) => error)
      expect((failure as KitRpcError).data).toEqual({ reason: 'read-only', command: 'view.zoomIn' })
    })

    it('lists editing commands as not enabled and refuses an ai/run with one before running any', async () => {
      const { hostPeer, session } = await mount(undefined, false, true)
      const listed = await hostPeer.request('ai/commands', { query: '' })
      expect(listed.map((item) => [item.id, item.enabled])).toEqual([
        ['image.crop', false],
        ['filter.blur', false],
        ['layer.new', false],
        ['view.zoomIn', true],
        ['edit.undo', false],
      ])
      const failure = await hostPeer.request('ai/run', { steps: [{ command: 'view.zoomIn' }, { command: 'layer.new' }], save: false }).catch((error: unknown) => error)
      expect((failure as KitRpcError).data).toEqual({ reason: 'read-only', command: 'layer.new', step: 1 })
      expect(session.run).not.toHaveBeenCalled()
    })

    it('does not save for the agent, and refuses the host\'s document/save', async () => {
      const { hostPeer, session } = await mount(undefined, false, true)
      let answer: { saved: boolean } | null = null
      await act(async () => {
        answer = await hostPeer.request('ai/run', { steps: [{ command: 'view.zoomIn' }], save: true })
      })
      expect(answer!.saved).toBe(false)
      const refused = await hostPeer.request('document/save', {}).catch((error: unknown) => error)
      expect((refused as KitRpcError).data).toEqual({ reason: 'read-only' })
      expect(session.save).not.toHaveBeenCalled()
    })
  })

  it('runs each ai/run step as the agent (its own undo steps, KitModel M12a), with a full repaint by default', async () => {
    const { hostPeer, session } = await mount()
    await act(async () => {
      await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }, { command: 'layer.new' }], save: false })
    })
    const origin = expect.objectContaining({ kind: 'agent', label: 'ai/run' })
    expect(session.run).toHaveBeenNthCalledWith(1, 'image.crop', {}, null, { origin })
    expect(session.run).toHaveBeenNthCalledWith(2, 'layer.new', {}, null, { origin })
  })

  it('returns terminal close without saving, replying through the model, or running later steps', async () => {
    const { hostPeer, session } = await mount()
    const reply = vi.fn(async () => { throw new Error('closed model') })
    Object.assign(session.doc, {agentReply:reply})
    Object.assign(session, {run:vi.fn(async () => JSON.stringify({closed:true}))})
    let answer: unknown
    await act(async () => {
      answer = await hostPeer.request('ai/run', {steps:[{command:'image.crop'},{command:'layer.new'}],save:true})
    })
    expect(answer).toMatchObject({closed:true,saved:false,notRun:1,completed:[{command:'image.crop',result:{closed:true}}]})
    expect(session.run).toHaveBeenCalledTimes(1)
    expect(session.save).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
  })

  it("a kit that opts in (agentSkipsUnchangedPaint) runs each ai/run step so that one which changes neither the revision nor inspect() does not repaint", async () => {
    const { hostPeer, session } = await mount(undefined, false, false, { agentSkipsUnchangedPaint: true })
    await act(async () => {
      await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }, { command: 'layer.new' }], save: false })
    })
    const origin = expect.objectContaining({ kind: 'agent' })
    expect(session.run).toHaveBeenNthCalledWith(1, 'image.crop', {}, null, { skipUnchangedPaint: true, origin })
    expect(session.run).toHaveBeenNthCalledWith(2, 'layer.new', {}, null, { skipUnchangedPaint: true, origin })
  })

  it('does not save for the agent when the host disables action:save', async () => {
    const { hostPeer, session } = await mount({ disable: ['action:save'] })
    let answer: { saved: boolean } | null = null
    await act(async () => {
      answer = await hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }], save: true })
    })
    expect(session.run).toHaveBeenCalledTimes(1)
    expect(answer!.saved).toBe(false)
    expect(session.save).not.toHaveBeenCalled()
  })

  describe("a host's change (ai/run with origin system)", () => {
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    it('runs each step as the system origin with its label, tells the host by system, and says the app edited it, not the agent', async () => {
      const { hostPeer, session, kit, rerender } = await mount()
      const heard: unknown[] = []
      hostPeer.on('document/changed', (params) => heard.push(params))
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }], save: false, origin: 'system', originLabel: 'emailsync' })
      })
      await settle()
      // KDM `system(label)`: no step of the person's undo history or of an agent's (KitModel M12a).
      expect(session.run).toHaveBeenCalledWith('layer.new', {}, null, { origin: { kind: 'system', principal: 'kdm', label: 'emailsync' } })
      expect(kit().editedBy).toEqual({ by: 'system', originLabel: 'emailsync' })
      expect(heard.at(-1)).toEqual({ dirty: true, revision: 1, title: 'a.psd', by: 'system', originLabel: 'emailsync' })
      // The person's next edit is theirs again.
      await act(async () => void (await kit().run('image.crop')))
      await rerender()
      await settle()
      expect(kit().editedBy).toBeNull()
      expect(heard.at(-1)).toEqual({ dirty: true, revision: 2, title: 'a.psd', by: 'person' })
    })

    it('labels the change host when the host names no feature, and an agent step still says agent', async () => {
      const { hostPeer, session, kit } = await mount()
      const heard: unknown[] = []
      hostPeer.on('document/changed', (params) => heard.push(params))
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }], save: false, origin: 'system' })
      })
      await settle()
      expect(session.run).toHaveBeenLastCalledWith('layer.new', {}, null, { origin: { kind: 'system', principal: 'kdm', label: 'host' } })
      expect(kit().editedBy).toEqual({ by: 'system', originLabel: 'host' })
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false })
      })
      await settle()
      expect(kit().editedBy).toEqual({ by: 'agent' })
      expect(heard.at(-1)).toEqual({ dirty: true, revision: 2, title: 'a.psd', by: 'agent' })
    })

    it('refuses an origin other than system, a malformed label, a label without the origin, and a host change on the draft, running nothing', async () => {
      const { hostPeer, session, draftRan } = await mount()
      const step = { steps: [{ command: 'layer.new' }], save: false }
      for (const params of [
        { ...step, origin: 'agent' },
        { ...step, origin: 'person' },
        { ...step, origin: 'system', originLabel: 'mail sync' },
        { ...step, origin: 'system', originLabel: '' },
        { ...step, origin: 'system', originLabel: 'x'.repeat(65) },
        { ...step, originLabel: 'emailsync' },
        { ...step, origin: 'system', draft: true },
      ]) {
        const failure = await hostPeer.request('ai/run', params as never).catch((error: unknown) => error)
        expect(failure, JSON.stringify(params)).toBeInstanceOf(KitRpcError)
        expect((failure as KitRpcError).code, JSON.stringify(params)).toBe(-32602)
      }
      expect(session.run).not.toHaveBeenCalled()
      expect(draftRan).toEqual([])
    })
  })

  it("answers an engine's refusal of a step's parameters with reason invalid-params and its errors, the message without them (kition_kit::schema::refusal)", async () => {
    const { hostPeer, session } = await mount()
    const errors = [{ path: '/values/Nmae', message: '`values` names no field `Nmae`', expected: 'a field of the table: Name, Email' }]
    session.run.mockRejectedValueOnce(new KitParamsError(errors[0].message, errors))
    const failure = await hostPeer.request('ai/run', { steps: [{ command: 'layer.new', params: { values: { Nmae: 'a' } } }], save: false }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitRpcError)
    expect(failure).toMatchObject({ code: -32000, data: { reason: 'invalid-params', command: 'layer.new', step: 0, errors } })
    expect((failure as Error).message).toBe('step 0 (`layer.new`) failed: `values` names no field `Nmae`')
  })

  it('serves replica/info from the engine\'s docId when the host declares the replica capability', async () => {
    const docId = vi.fn(async () => 'doc-77')
    const { session } = fakeSession(false)
    fake.session = { ...session, replica: { docId } }

    const channel = new MessageChannel()
    const hostPeer = new KitPeer(channel.port1, 'h') as HostPeer
    const connection = connectHost({ id: 'kit.test', version: '1', capabilities: ['replica'] })
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { kitionKitUi: 1, protocol: KIT_UI_PROTOCOL }, ports: [channel.port2] }))
    const initialized = hostPeer.request('ui/initialize', {
      protocol: KIT_UI_PROTOCOL,
      host: { name: 'host', version: '1' },
      document: { path: 'a.psd', name: 'a.psd', bytes: new ArrayBuffer(1), version: 'v1' },
      theme: { colorScheme: 'light', tokens: {} },
      locale: 'en-US',
      shortcuts: [],
      capabilities: ['replica'],
    })
    const host = await connection
    const manifest = { kitId: 'kit.test' } as KitModuleManifest
    function Probe({ connection }: { connection: HostConnection }) {
      useKitSession(connection, manifest, () => null)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe connection={host} />))
    await initialized

    expect(await hostPeer.request('replica/info', {})).toEqual({ docId: 'doc-77' })
    expect(docId).toHaveBeenCalled()

    act(() => root.unmount())
    host.close()
    hostPeer.close()
  })

  it('checks the file at once when the host says it changed (document/fileChanged)', async () => {
    const { hostPeer, session } = await mount()
    expect(session.checkFile).not.toHaveBeenCalled()
    hostPeer.notify('document/fileChanged', { version: 'v2' })
    await vi.waitFor(() => expect(session.checkFile).toHaveBeenCalledTimes(1))
  })

  describe("the agent's draft", () => {
    it('runs ai/run with draft: true on the draft, leaving the document alone, and merges it on request', async () => {
      const { hostPeer, session, ran, draftRan, draftEngine } = await mount()
      const heard: unknown[] = []
      hostPeer.on('draft/changed', (info) => heard.push(info))
      const changed: unknown[] = []
      hostPeer.on('document/changed', (state) => changed.push(state))
      expect(await hostPeer.request('draft/state', {})).toEqual({ state: 'none', revision: null })
      const answer = await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }, { command: 'layer.new' }], save: true, draft: true })
      expect(answer).toEqual({ completed: [{ command: 'image.crop', changed: true, result: { ok: true } }, { command: 'layer.new', changed: true, result: { ok: true } }], saved: false })
      expect(draftRan).toEqual(['image.crop', 'layer.new'])
      expect(ran).toEqual([])
      expect(session.save).not.toHaveBeenCalled()
      expect(session.draft.open).toHaveBeenCalledTimes(1)
      expect(await hostPeer.request('ai/inspect', { draft: true })).toMatchObject({ revision: 2, summary: expect.stringContaining('draft'), draft: { state: 'open', revision: 2 } })
      // `document/check` checks the document, or with `draft: true` the agent's draft.
      expect((await hostPeer.request('document/check', {})).diagnostics.map((found) => found.code)).toEqual(['test.live'])
      expect((await hostPeer.request('document/check', { draft: true })).diagnostics.map((found) => found.code)).toEqual(['test.draft'])
      expect(await hostPeer.request('draft/ready', {})).toEqual({ state: 'ready', revision: 2 })

      const merged = await act(async () => hostPeer.request('draft/merge', { origin: { kind: 'agent', principal: 'user:a', label: 'Merged' }, schema: { kdm: 1 } }))
      expect(merged).toEqual({ merged: true, summary: expect.objectContaining({ changed: [expect.objectContaining({ id: 'p' })] }) })
      expect(session.draft.merge).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(ArrayBuffer), { kind: 'agent', principal: 'user:a', label: 'Merged' }, { kdm: 1 })
      expect(draftEngine.dispose).toHaveBeenCalled()
      await vi.waitFor(() => expect(heard.map((info) => (info as { state: string }).state)).toEqual(['open', 'open', 'ready', 'none']))
      expect(await hostPeer.request('draft/state', {})).toEqual({ state: 'none', revision: null })
    })

    it('tells the kit of a merged draft (draftMerged), and of none when the merge is refused', async () => {
      const draftMerged = vi.fn()
      const { hostPeer } = await mount(undefined, false, false, { draftMerged })
      await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false, draft: true })
      await act(async () => hostPeer.request('draft/merge', { origin: { kind: 'agent', principal: 'user:a' } }))
      expect(draftMerged).toHaveBeenCalledTimes(1)
      expect(draftMerged).toHaveBeenCalledWith({ summary: expect.objectContaining({ changed: [expect.objectContaining({ id: 'p' })] }) })
      const viewer = await mount(undefined, false, true, { draftMerged })
      await viewer.hostPeer.request('draft/merge', { origin: { kind: 'agent', principal: 'u' } }).catch(() => undefined)
      expect(draftMerged).toHaveBeenCalledTimes(1)
    })

    it('runs object-model batches with draft: true on the draft, and lists draft-model', async () => {
      const fakes = fakeSession(false)
      const documentBatch = vi.fn(async () => ({ refs: {}, results: [null], loaded: [], version: null }))
      Object.assign(fakes.doc.info, { model: { schema: null } })
      Object.assign(fakes.session, { model: { describe: vi.fn(async () => ({ root: 'Page' })), batch: documentBatch } })
      fake.session = fakes.session
      const { hostPeer, initialized, host } = await connect()
      const current: { session: ReturnType<typeof useKitSession<null>> | null } = { session: null }
      function Probe({ connection }: { connection: HostConnection }) {
        current.session = useKitSession(connection, { kitId: 'kit.test' } as KitModuleManifest, () => null)
        return null
      }
      const root = createRoot(document.createElement('div'))
      await act(async () => root.render(<Probe connection={host} />))
      cleanups.push(() => {
        act(() => root.unmount())
        host.close()
        hostPeer.close()
      })
      expect((await initialized).capabilities).toEqual(expect.arrayContaining(['model', 'draft', 'draft-model', 'check']))
      // Reading the draft before there is one is refused; a write opens it.
      const early = await hostPeer.request('model/batch', { ops: [], load: [{ target: 'root' }], draft: true }).catch((error: unknown) => error)
      expect(String((early as Error).message)).toContain('no draft')
      const set = { op: 'set', target: 'root', field: 'title', value: 'Q3' }
      const answer = await hostPeer.request('model/batch', { origin: { kind: 'agent', principal: 'local' }, ops: [set], draft: true })
      expect(answer.results).toEqual([null])
      expect(fakes.draftEngine.modelBatch).toHaveBeenCalledWith({ origin: { kind: 'agent', principal: 'local' }, ops: [set] }, null)
      expect(documentBatch).not.toHaveBeenCalled()
      expect(await hostPeer.request('draft/state', {})).toMatchObject({ state: 'open' })
      await hostPeer.request('model/batch', { ops: [set] })
      expect(documentBatch).toHaveBeenCalledTimes(1)
    })

    it('refuses a host-hidden step on the draft, and any draft on a read-only document', async () => {
      const hidden = await mount({ hide: ['menu:Filter'] })
      const failure = await hidden.hostPeer.request('ai/run', { steps: [{ command: 'filter.blur' }], save: false, draft: true }).catch((error: unknown) => error)
      expect((failure as KitRpcError).data).toMatchObject({ reason: 'not-allowed' })
      expect(hidden.session.draft.open).not.toHaveBeenCalled()
      const viewer = await mount(undefined, false, true)
      const refused = await viewer.hostPeer.request('ai/run', { steps: [{ command: 'view.zoomIn' }], save: false, draft: true }).catch((error: unknown) => error)
      expect((refused as KitRpcError).data).toMatchObject({ reason: 'read-only' })
      expect(viewer.session.draft.open).not.toHaveBeenCalled()
      expect((await viewer.hostPeer.request('draft/merge', { origin: { kind: 'agent', principal: 'u' } }).catch((error: unknown) => error)) as KitRpcError).toMatchObject({ data: { reason: 'read-only' } })
    })
  })

  describe("an agent step's lease (agentLeaseScope)", () => {
    const alice: KitLease = { scope: '*', holder: { principalId: 'p1', name: 'Alice', self: false } }
    /** A host serving leases: records the calls in order beside the steps the engine ran. */
    async function leased(options: KitSessionOptions, acquire?: (params: { scope: string; ttl?: number }) => unknown, capabilities = ['lease']) {
      const mounted = await mount(undefined, false, false, options, null, capabilities)
      const calls: string[] = []
      const notices: Array<{ level: string; title: string }> = []
      mounted.hostPeer.handle('host/leases', () => ({ leases: [] }))
      mounted.hostPeer.handle('host/leaseAcquire', (params) => {
        calls.push(`acquire ${params.scope} ${params.ttl ?? '-'}`)
        return acquire ? (acquire(params) as { lease: KitLease | null }) : { lease: { scope: params.scope, holder: { principalId: 'me', name: 'Me', self: true } } }
      })
      mounted.hostPeer.handle('host/leaseRelease', (params) => {
        calls.push(`release ${params.scope}`)
        return {}
      })
      mounted.hostPeer.on('host/notify', (notice) => notices.push(notice))
      mounted.session.run.mockImplementation(async (id: string) => {
        calls.push(`run ${id}`)
        mounted.doc.info.revision += 1
        return null
      })
      return { ...mounted, calls, notices }
    }
    const rewrites = (command: string) => (command === 'image.crop' ? '*' : null)

    it('takes the lease the kit names before the step and releases it after, through the host', async () => {
      const scope = vi.fn(rewrites)
      const { hostPeer, calls } = await leased({ agentLeaseScope: scope, agentLeaseTtl: 15_000 })
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }, { command: 'image.crop', params: { x: 1 } }], save: false })
      })
      expect(calls).toEqual(['run layer.new', 'acquire * 15000', 'run image.crop', 'release *'])
      expect(scope).toHaveBeenNthCalledWith(2, 'image.crop', { x: 1 }, expect.objectContaining({ info: expect.any(Object) }))
    })

    it('releases the lease when the step fails', async () => {
      const { hostPeer, calls, session } = await leased({ agentLeaseScope: rewrites })
      session.run.mockImplementation(async (id: string) => {
        calls.push(`run ${id}`)
        throw new Error('broken')
      })
      const failure = await act(async () => hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false }).catch((error: unknown) => error))
      expect((failure as Error).message).toContain('step 0 (`image.crop`) failed')
      expect(calls).toEqual(['acquire * -', 'run image.crop', 'release *'])
    })

    it('refuses a step whose lease another session holds, running nothing, and tells the person', async () => {
      const { hostPeer, calls } = await leased({ agentLeaseScope: rewrites }, () => {
        throw new KitRpcError(-32000, 'held', { reason: LEASE_HELD_REASON, lease: alice })
      })
      const failure = await act(async () => hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }, { command: 'image.crop' }, { command: 'filter.blur' }], save: false }).catch((error: unknown) => error))
      expect(failure).toBeInstanceOf(KitRpcError)
      expect((failure as KitRpcError).message).toContain('Alice holds the lease')
      expect((failure as KitRpcError).data).toEqual({ reason: LEASE_HELD_REASON, command: 'image.crop', step: 1, scope: '*', holder: alice.holder })
      // The steps before ran; the refused one and the rest did not, and nothing is released.
      expect(calls).toEqual(['run layer.new', 'acquire * -'])
    })

    it('shows the person a notice naming who holds the lease', async () => {
      const { hostPeer, notices } = await leased({ agentLeaseScope: rewrites }, () => {
        throw new KitRpcError(-32000, 'held', { reason: LEASE_HELD_REASON, lease: alice })
      })
      await act(async () => hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false }).catch(() => undefined))
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(notices).toEqual([{ level: 'warning', title: expect.stringContaining('Alice') }])
    })

    it("refuses an edit with no lease of its own while another session holds the whole document; what does not edit runs", async () => {
      const { hostPeer, calls, notices } = await leased({ agentLeaseScope: rewrites })
      // The session hears the document's leases from the start, before any step.
      hostPeer.notify('lease/changed', { leases: [alice] })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      const failure = await act(async () => hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }], save: false }).catch((error: unknown) => error))
      expect((failure as KitRpcError).data).toMatchObject({ reason: LEASE_HELD_REASON, command: 'layer.new', step: 0, scope: '*' })
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'edit.undo' }], save: false })
      })
      expect(calls).toEqual(['run edit.undo'])
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(notices).toHaveLength(1)
    })

    it('treats an error asking for the scope as no lease', async () => {
      const { hostPeer, calls } = await leased({
        agentLeaseScope: () => {
          throw new Error('no extra')
        },
      })
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false })
      })
      expect(calls).toEqual(['run image.crop'])
    })

    it('asks nothing when the host serves no leases, or for the draft', async () => {
      const scope = vi.fn(rewrites)
      const { hostPeer, calls, draftRan } = await leased({ agentLeaseScope: scope }, undefined, [])
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false })
      })
      expect(calls).toEqual(['run image.crop'])
      const leasing = await leased({ agentLeaseScope: scope })
      await act(async () => {
        await leasing.hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false, draft: true })
      })
      expect(leasing.draftRan).toEqual(['image.crop'])
      expect(leasing.calls).toEqual([])
      expect(scope).not.toHaveBeenCalled()
      expect(draftRan).toEqual([])
    })
  })

  /**
   * A failed `ai/run` on the live document is atomic (KHP A53, C3b): the editor undoes the
   * agent's earlier steps in the agent's undo scope. The runs are shared with the Rust server's
   * tests (`crates/kition-kits/tests/fixtures/live-runs.json`), which answer `editor` from a fake
   * editor window, so the two sides cannot drift apart.
   */
  describe('a failed ai/run (live-runs.json)', () => {
    type Script = { fails: number; unchanged: string[]; personEditsBefore: number[]; origins: boolean; undoChanges: boolean }
    type LiveRun = { name: string; steps: Array<{ command: string; params?: Record<string, unknown> }>; script: Script; calls: string[]; editor: { message: string; data: unknown } }
    const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'crates', 'kition-kits', 'tests', 'fixtures', 'live-runs.json'), 'utf8')) as { runs: LiveRun[] }

    /**
     * The editor over the script: the engine runs each command (the failing step throws, an
     * unchanged one moves nothing), and the person edits between the agent's steps. The person's
     * edit lands where nothing of the agent's is under way: while the editor asks the kit which
     * lease the next step needs.
     */
    async function scripted(run: LiveRun) {
      const calls: string[] = []
      const person = { edit: () => undefined as void }
      const mounted = await mount(undefined, false, false, {
        agentLeaseScope: () => {
          const next = calls.filter((call) => call !== 'person').length
          if (run.script.personEditsBefore.includes(next) && !calls.includes('person')) person.edit()
          return null
        },
      }, null, ['lease'])
      person.edit = () => {
        calls.push('person')
        mounted.doc.info.revision += 1
      }
      ;(mounted.doc.info as Record<string, unknown>).origins = run.script.origins
      mounted.hostPeer.handle('host/leases', () => ({ leases: [] }))
      mounted.session.run.mockImplementation(async (id: string) => {
        calls.push(id)
        const steps = calls.filter((call) => call !== 'person')
        if (steps.length - 1 === run.script.fails && id === run.steps[run.script.fails].command) throw new Error('broken')
        if (run.script.unchanged.includes(id)) return null
        if (id === 'edit.undo' && steps.length > run.script.fails + 1 && !run.script.undoChanges) return null
        mounted.doc.info.revision += 1
        return null
      })
      return { ...mounted, calls }
    }

    for (const run of fixture.runs) {
      it(`${run.name}: answers the run the server expects`, async () => {
        const { hostPeer, calls, session } = await scripted(run)
        const failure = await act(async () => hostPeer.request('ai/run', { steps: run.steps, save: true }).catch((error: unknown) => error))
        expect(failure).toBeInstanceOf(KitRpcError)
        expect((failure as KitRpcError).message).toBe(run.editor.message)
        expect((failure as KitRpcError).data).toEqual(run.editor.data)
        expect(calls).toEqual(run.calls)
        // Every undo is the agent's, in the agent's undo scope; nothing is saved.
        for (const [index, call] of calls.filter((name) => name !== 'person').entries()) {
          if (index > run.script.fails && call === 'edit.undo') expect(session.run).toHaveBeenNthCalledWith(index + 1, 'edit.undo', { scope: 'agent' }, null, { origin: expect.objectContaining({ kind: 'agent' }) })
        }
        expect(session.save).not.toHaveBeenCalled()
      })
    }

    it('undoes only as many steps as it can, and says which stay', async () => {
      const run: LiveRun = { name: 'partial', steps: [{ command: 'layer.new' }, { command: 'filter.blur' }, { command: 'image.crop' }], script: { fails: 2, unchanged: [], personEditsBefore: [], origins: true, undoChanges: true }, calls: [], editor: { message: '', data: null } }
      const mounted = await scripted(run)
      let undos = 0
      mounted.session.run.mockImplementation(async (id: string) => {
        mounted.calls.push(id)
        if (id === 'image.crop') throw new Error('broken')
        // The second undo finds nothing more of the agent's.
        if (id === 'edit.undo' && ++undos > 1) return null
        mounted.doc.info.revision += 1
        return null
      })
      const failure = (await act(async () => mounted.hostPeer.request('ai/run', { steps: run.steps, save: false }).catch((error: unknown) => error))) as KitRpcError
      expect(failure.message).toBe('step 2 (`image.crop`) failed: broken Only 1 of the 2 step(s) that changed the document could be rolled back (the kit had nothing more to undo): the first 1 step(s) stay in the document.')
      expect(failure.data).toEqual({
        command: 'image.crop',
        step: 2,
        completed: [{ command: 'layer.new', changed: true, result: null }],
        rolledBack: [{ command: 'filter.blur', changed: true, result: null }],
      })
    })

    it("runs one agent run at a time, so one run's rollback never takes back another's steps", async () => {
      const { hostPeer, session, doc } = await mount()
      const order: string[] = []
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      session.run.mockImplementation(async (id: string) => {
        order.push(`start ${id}`)
        if (id === 'layer.new') await held
        doc.info.revision += 1
        order.push(`end ${id}`)
        return null
      })
      const first = hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }], save: false })
      await vi.waitFor(() => expect(order).toEqual(['start layer.new']))
      const second = hostPeer.request('ai/run', { steps: [{ command: 'image.crop' }], save: false })
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
      expect(order).toEqual(['start layer.new'])
      release()
      await act(async () => {
        await Promise.all([first, second])
      })
      expect(order).toEqual(['start layer.new', 'end layer.new', 'start image.crop', 'end image.crop'])
    })
  })
  /**
   * An agent step's call context on the live document (C3b): on an engine that holds an editor
   * state of the agent's own (`info.context`), each agent step runs in it with the step's
   * `context`, so the person's selection, part and time never move; an engine without one
   * refuses a step with a context rather than ignore it.
   */
  describe("an agent step's call context", () => {
    it('lists the capability context when the engine holds an editor state of its own', async () => {
      const fakes = fakeSession(false)
      Object.assign(fakes.doc.info, { context: true })
      fake.session = fakes.session
      const { initialized, host } = await connect()
      function Probe({ connection }: { connection: HostConnection }) {
        useKitSession(connection, { kitId: 'kit.test' } as KitModuleManifest, () => null)
        return null
      }
      const root = createRoot(document.createElement('div'))
      await act(async () => root.render(<Probe connection={host} />))
      cleanups.push(() => {
        act(() => root.unmount())
        host.close()
      })
      expect((await initialized).capabilities).toEqual(expect.arrayContaining(['context']))
    })

    it("runs every agent step in the agent's own editor state, each with its context, one state through the run", async () => {
      const { hostPeer, session, doc } = await mount()
      Object.assign(doc.info, { context: true })
      const states: unknown[] = []
      session.run.mockImplementation(async (_id: string, ...rest: unknown[]) => {
        const { agent } = rest[2] as { agent?: { state: { state: string | null } } }
        states.push(agent?.state.state)
        if (agent) agent.state.state = `after ${states.length}`
        doc.info.revision += 1
        return null
      })
      await act(async () => {
        await hostPeer.request('ai/run', { steps: [{ command: 'layer.new', context: { part: { slide: 2 } } }, { command: 'image.crop', params: { x: 1 } }], save: false })
      })
      const origin = expect.objectContaining({ kind: 'agent' })
      const first = session.run.mock.calls[0][3] as { agent: { state: unknown } }
      expect(session.run).toHaveBeenNthCalledWith(1, 'layer.new', {}, null, { origin, agent: { state: first.agent.state, set: { part: { slide: 2 } } } })
      expect(session.run).toHaveBeenNthCalledWith(2, 'image.crop', { x: 1 }, null, { origin, agent: { state: first.agent.state, set: null } })
      // The first step starts from the person's state; the second from the agent's after the first.
      expect(states).toEqual([null, 'after 1'])
    })

    it('runs the steps the server plans (live-context.json) each with its own context', async () => {
      type Planned = { name: string; editorSteps: Array<{ command: string; params?: Record<string, unknown>; context?: Record<string, unknown> }> }
      const shared = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'crates', 'kition-kits', 'tests', 'fixtures', 'live-context.json'), 'utf8')) as { runs: Planned[] }
      for (const planned of shared.runs) {
        const { hostPeer, session, doc } = await mount()
        Object.assign(doc.info, { context: true })
        await act(async () => {
          await hostPeer.request('ai/run', { steps: planned.editorSteps, save: false })
        })
        const own = (session.run.mock.calls[0][3] as { agent: { state: unknown } }).agent.state
        planned.editorSteps.forEach((step, index) => {
          expect(session.run, planned.name).toHaveBeenNthCalledWith(index + 1, step.command, step.params ?? {}, null, { origin: expect.objectContaining({ kind: 'agent' }), agent: { state: own, set: step.context ?? null } })
        })
      }
    })

    it("refuses a step with a context on an engine that cannot hold the agent's own state, before any step runs", async () => {
      const { hostPeer, session } = await mount()
      const failure = await hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }, { command: 'image.crop', context: { on: ['s1'] } }], save: false }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(KitRpcError)
      expect((failure as KitRpcError).data).toEqual({ reason: 'unsupported', command: 'image.crop', step: 1 })
      expect((failure as KitRpcError).message).toBe("step 1 (`image.crop`) cannot run in a call context: this kit's engine keeps no editor state of the agent's own, so its `on`, `part` and `time` cannot be set without moving the person's")
      expect(session.run).not.toHaveBeenCalled()
    })

    it("rolls a failed run back in the agent's own editor state too", async () => {
      const { hostPeer, session, doc } = await mount()
      Object.assign(doc.info, { context: true, origins: true })
      session.run.mockImplementation(async (id: string) => {
        if (id === 'image.crop') throw new Error('broken')
        doc.info.revision += 1
        return null
      })
      await act(async () => hostPeer.request('ai/run', { steps: [{ command: 'layer.new' }, { command: 'image.crop' }], save: false }).catch(() => undefined))
      const first = session.run.mock.calls[0][3] as { agent: { state: unknown } }
      expect(session.run).toHaveBeenLastCalledWith('edit.undo', { scope: 'agent' }, null, { origin: expect.objectContaining({ kind: 'agent' }), agent: { state: first.agent.state, set: null } })
    })
  })
  /**
   * Receipts on the live document (C3b): an engine that keeps a replica (`info.changes`) answers
   * the replica's version and the change set since one, so the agent's write in the open editor
   * says what it changed, as on the headless path.
   */
  describe('what an agent write changed', () => {
    it('lists the capability changes and answers ai/version and ai/changes from the document', async () => {
      const fakes = fakeSession(false)
      Object.assign(fakes.doc.info, { changes: true })
      const version = vi.fn(async () => 'djE=')
      const changes = vi.fn(async () => ({ changes: { created: [], changed: [], moved: [], deleted: [] }, version: 'djI=' }))
      Object.assign(fakes.session, { model: { version, changes } })
      fake.session = fakes.session
      const { hostPeer, initialized, host } = await connect()
      function Probe({ connection }: { connection: HostConnection }) {
        useKitSession(connection, { kitId: 'kit.test' } as KitModuleManifest, () => null)
        return null
      }
      const root = createRoot(document.createElement('div'))
      await act(async () => root.render(<Probe connection={host} />))
      cleanups.push(() => {
        act(() => root.unmount())
        host.close()
        hostPeer.close()
      })
      expect((await initialized).capabilities).toEqual(expect.arrayContaining(['changes']))
      expect(await hostPeer.request('ai/version', {})).toEqual({ version: 'djE=' })
      const schema = { types: {} }
      expect(await hostPeer.request('ai/changes', { since: 'djE=', schema })).toEqual({ changes: { created: [], changed: [], moved: [], deleted: [] }, version: 'djI=' })
      expect(changes).toHaveBeenCalledWith('djE=', schema)
    })

    it('does not list changes for an engine without a replica, and refuses ai/changes', async () => {
      const { hostPeer } = await mount()
      const failure = await hostPeer.request('ai/changes', { since: 'djE=' }).catch((error: unknown) => error)
      expect((failure as Error).message).toContain('keeps no replica')
    })
  })
})
