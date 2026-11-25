// @vitest-environment jsdom
/**
 * `KitEmbed 1.3` (the fake kit's note starts empty): the person's review of an agent's draft (`editor.draft`), and the open editor as
 * an MCP server for the integrator's agent (`editor.agentPort`): the kit tools of
 * `kition-kits-mcp`, edits into a draft by default, never a merge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { relayAgentPort, type JsonRpcMessage } from '../src/agent'
import { EmbedError } from '../src/errors'
import { EMBED_CAPABILITY_SETS, mountEmbed } from '../src/mount'
import type { EmbedOptions } from '../src/types'
import { fakeKit } from './fakeKit'
import { memoryStorage } from './memoryStorage'

const KIT = { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }

function setUp(overrides: Partial<EmbedOptions> = {}, capabilities = ['ai', 'replica', 'draft', 'check']) {
  const element = document.createElement('div')
  document.body.append(element)
  const files = memoryStorage({ f1: 'hello' })
  const kit = fakeKit('kit.note', capabilities)
  const options: EmbedOptions = { kit: KIT, file: { id: 'f1', name: 'Notes.note' }, storage: files.storage, ...overrides }
  const editor = mountEmbed(element, options, { mountKit: vi.fn(kit.mountKit) })
  return { files, kit, editor }
}

let ids = 0
const call = async (port: { handle: (message: JsonRpcMessage) => Promise<JsonRpcMessage | null> }, name: string, args: Record<string, unknown>) => {
  const reply = await port.handle({ jsonrpc: '2.0', id: (ids += 1), method: 'tools/call', params: { name, arguments: args } })
  return reply!.result as { isError: boolean; structuredContent: Record<string, any>; content: Array<{ type: string; text?: string }> }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('KitEmbed 1.3', () => {
  it('advertises KitEmbed 1.3', () => {
    expect(EMBED_CAPABILITY_SETS).toContain('KitEmbed 1.3')
  })

  it('answers MCP initialize and lists the kit tools the editor offers, named by the kit', async () => {
    const { editor } = setUp()
    const port = (await editor).agentPort()
    await (await editor).ready()
    const init = await port.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(init?.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'kition-embed' } })
    expect(await port.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const listed = (await port.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))?.result as { tools: Array<{ name: string; inputSchema: any }> }
    expect(listed.tools.map((tool) => tool.name)).toEqual(['note_inspect', 'note_commands', 'note_run', 'note_draft_ready', 'note_draft_reopen', 'note_check'])
    expect(listed.tools[0]!.inputSchema.properties.path.enum).toEqual(['Notes.note'])
    const unknown = await port.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'note_query', arguments: {} } })
    expect(unknown?.error?.code).toBe(-32602)
  })

  it('runs the agent’s steps on a draft; the person reviews and merges it as the agent’s edit', async () => {
    const { editor, kit } = setUp()
    const opened = await editor
    await opened.ready()
    const heard: string[] = []
    opened.on('draft', (info) => heard.push(info.state))
    const port = opened.agentPort({ principal: 'agent:reviewer', label: 'Reviewer' })

    const ran = await call(port, 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: ' world' } }] })
    expect(ran.isError).toBe(false)
    expect(ran.structuredContent).toMatchObject({ live: true, draft: true, saved: false })
    expect(kit.last().text()).toBe('')
    expect((await call(port, 'note_inspect', { path: 'Notes.note', preview: false })).structuredContent.document.summary).toBe(' world')
    expect((await call(port, 'note_draft_ready', { path: 'Notes.note' })).structuredContent).toEqual({ state: 'ready', revision: 1 })
    expect(await opened.draft.state()).toEqual({ state: 'ready', revision: 1 })

    const compared = await opened.draft.compare()
    expect(compared.summary.texts[0]).toMatchObject({ before: '', after: ' world' })
    const merged = await opened.draft.merge()
    expect(merged.merged).toBe(true)
    expect(kit.last().text()).toBe(' world')
    expect(kit.last().merges).toEqual([{ kind: 'agent', principal: 'agent:reviewer', label: 'Reviewer' }])
    expect(await opened.draft.state()).toEqual({ state: 'none', revision: null })
    expect(heard).toEqual(['open', 'ready', 'none'])
  })

  it('acts for the person who started the agent unless the page names another principal', async () => {
    const { editor, kit } = setUp({ identity: { user: async () => ({ id: 'alice', name: 'Alice' }) } })
    const opened = await editor
    await opened.ready()
    const port = opened.agentPort()
    expect((await call(port, 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: '!' } }] })).isError).toBe(false)
    await opened.draft.merge()
    expect(kit.last().merges).toEqual([{ kind: 'agent', principal: 'alice' }])
  })

  it('merges a draft made before any agent port opened as the person, when the page gives an identity', async () => {
    const { editor, kit } = setUp({ identity: { user: async () => ({ id: 'alice', name: 'Alice' }) } })
    const opened = await editor
    await opened.ready()
    // A draft the kit kept from an earlier session (or its own assistant made): no port yet.
    kit.last().draftText = 'hello!'
    kit.last().draftState = 'ready'
    await opened.draft.merge()
    // Never `agent`, which a sync server refuses as the principal of a person's token.
    expect(kit.last().merges).toEqual([{ kind: 'agent', principal: 'alice' }])
  })

  it("never runs an agent's steps as the page's own change, whatever the call passes", async () => {
    const { editor, kit } = setUp()
    const opened = await editor
    await opened.ready()
    const run = vi.spyOn(kit.last().connection.ai, 'run')
    const steps = [{ command: 'note.append', params: { text: '!' } }]
    expect((await call(opened.agentPort({ draft: false }), 'note_run', { path: 'Notes.note', steps, origin: 'system', originLabel: 'emailsync' })).isError).toBe(false)
    expect(run.mock.calls).toEqual([[steps, true]])
  })

  it('has no tool that merges or discards, and refuses a merge with no draft', async () => {
    const { editor } = setUp()
    const opened = await editor
    await opened.ready()
    const port = opened.agentPort()
    const names = ((await port.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    expect(names.some((name) => /merge|discard/.test(name))).toBe(false)
    await expect(opened.draft.merge()).rejects.toMatchObject({ code: 'no-draft' })
    expect((await call(port, 'note_draft_ready', { path: 'Notes.note' })).structuredContent.error.code).toBe('draft-required')
  })

  it('discards a draft and leaves the document as it was', async () => {
    const { editor, kit } = setUp()
    const opened = await editor
    await opened.ready()
    const port = opened.agentPort()
    await call(port, 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: '!' } }] })
    expect(await opened.draft.discard()).toEqual({ state: 'none', revision: null })
    expect(kit.last().text()).toBe('')
  })

  it('checks the draft and the document, and answers structured errors like kition-kits-mcp', async () => {
    const { editor } = setUp()
    const opened = await editor
    await opened.ready()
    const port = opened.agentPort()
    await call(port, 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: ' #REF!' } }] })
    const checked = await call(port, 'note_check', { path: 'Notes.note' })
    expect(checked.structuredContent.diagnostics).toEqual([expect.objectContaining({ code: 'note.broken', severity: 'error' })])
    expect(checked.content[0]!.text).toMatch(/^Checked your draft of `Notes.note`: 1 error/)
    expect((await call(port, 'note_check', { path: 'Notes.note', draft: false })).structuredContent.diagnostics).toEqual([])
    expect(await opened.check({ draft: true })).toHaveLength(1)

    const elsewhere = await call(port, 'note_inspect', { path: 'Other.note' })
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.structuredContent.error.code).toBe('not-open')
    const failing = await call(port, 'note_run', { path: 'Notes.note', steps: [{ command: 'note.nothing' }] })
    expect(failing.structuredContent.error.code).toBe('command-failed')
    expect((await call(port, 'note_run', { path: 'Notes.note', steps: [] })).structuredContent.error.code).toBe('invalid-params')
  })

  it('edits live only when the page allows it, and never past what the person may do', async () => {
    const live = setUp()
    const opened = await live.editor
    await opened.ready()
    const ran = await call(opened.agentPort({ draft: false }), 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: '!' } }] })
    expect(ran.structuredContent).toMatchObject({ live: true, saved: true })
    expect(live.kit.last().text()).toBe('!')

    document.body.innerHTML = ''
    const viewing = setUp({ permissions: { mode: 'view' } })
    const viewer = await viewing.editor
    await viewer.ready()
    const refused = await call(viewer.agentPort(), 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: '!' } }] })
    expect(refused.structuredContent.error.code).toBe('read-only')
    await expect(viewer.draft.discard()).rejects.toBeInstanceOf(EmbedError)
  })

  it('refuses drafts in a kit that keeps none', async () => {
    const { editor } = setUp({}, ['ai', 'replica'])
    const opened = await editor
    await opened.ready()
    expect(await opened.draft.state()).toEqual({ state: 'none', revision: null })
    await expect(opened.draft.compare()).rejects.toMatchObject({ code: 'unsupported' })
    const ran = await call(opened.agentPort(), 'note_run', { path: 'Notes.note', steps: [{ command: 'note.append', params: { text: '!' } }] })
    expect(ran.structuredContent.error.code).toBe('unsupported')
  })

  it('refuses a batch that runs a command among other operations before anything runs (KHP A16, A18)', async () => {
    const { editor, kit } = setUp({}, ['ai', 'replica', 'draft', 'check', 'model'])
    const opened = await editor
    await opened.ready()
    const port = opened.agentPort({ draft: false })
    const refused = await call(port, 'note_batch', {
      path: 'Notes.note',
      ops: [
        { op: 'command', id: 'note.append', params: { text: '!' } },
        { op: 'set', target: 'no-such-object', field: 'name', value: 'y' },
      ],
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent.error.code).toBe('unsupported')
    expect(refused.structuredContent.error.message).toContain('note_run')
    expect(kit.last().text()).toBe('')
  })

  it('relays messages from a transport into the port and its replies back', async () => {
    const { editor } = setUp()
    const opened = await editor
    await opened.ready()
    const inbox: Array<JsonRpcMessage | null> = [null, { jsonrpc: '2.0', id: 7, method: 'ping' }]
    const replies: JsonRpcMessage[] = []
    const stop = new AbortController()
    const relayed = relayAgentPort(
      opened.agentPort(),
      {
        next: async () => {
          if (!inbox.length) {
            stop.abort()
            return null
          }
          return inbox.shift()!
        },
        reply: async (message) => {
          replies.push(message)
        },
      },
      stop.signal,
    )
    await relayed
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }])
  })
})
