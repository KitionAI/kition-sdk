/**
 * The open editor as an MCP server for the integrator's agent (`KitEmbed 1.3`, `editor.agentPort`):
 * the same kit tools `kition-kits-mcp` offers on files (`<prefix>_inspect`, `_commands`, `_run`,
 * `_query`, `_batch`, `_check`, `_draft_ready`, `_draft_reopen`; Kit Harness Protocol (KHP) spec/agent.md), with the
 * same arguments, results, and error codes, but on the document the person has open in this page.
 * The agent edits a draft by default (Kit UI protocol section 7d): the person reviews it and merges
 * or discards it in the page (`editor.draft`); the agent can never merge (A14, UI-D1).
 *
 * The port is transport-neutral: `handle` answers one JSON-RPC 2.0 message. The page relays the
 * messages between its server and the port (`relayAgentPort` pumps them; `@kition/script/node`'s
 * `createAgentRelay` is the server's end), so the agent never reaches into the page by itself.
 */
import { KitRpcError, type KitConnection } from '@kition/kit-host'
import type { AiStep, DraftInfo, KitDiagnostic } from '@kition/kit-ui-protocol'

/** One JSON-RPC 2.0 message (MCP). */
export type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A tool as `tools/list` lists it. */
export type AgentTool = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint: false; openWorldHint: false }
}

/** How `editor.agentPort` serves the agent. */
export type AgentPortOptions = {
  /** Edit the agent's draft unless a call says `draft: false` (the default); `false` edits the live document. */
  draft?: boolean
  /**
   * Who the agent acts for: recorded on its edits and on a merged draft (`origin.principal`). The
   * embed defaults it to the person's id (`identity.user`, KHP A11/A14); `agent` without one.
   */
  principal?: string
  /** A label for the agent's edits (`origin.label`); `Agent` by default. */
  label?: string
}

/** The open editor's MCP server; `close` stops answering. */
export type AgentPort = {
  /** Answers one MCP message (`initialize`, `ping`, `tools/list`, `tools/call`); `null` for a notification. */
  handle: (message: JsonRpcMessage) => Promise<JsonRpcMessage | null>
  /** The tools the editor offers now (they follow the kit's capabilities). */
  tools: () => Promise<AgentTool[]>
  close: () => void
}

/** Where the port reaches the open editor. */
export type AgentPortHost = {
  kitId: string
  /** The document's name as the agent passes it (`path`). */
  path: () => string
  opened: () => Promise<KitConnection>
  /** Whether the person may edit (the agent edits no more than the person). */
  editable: () => boolean
  /** The SDK's version, for `serverInfo`. */
  version: string
  /** The kit's KDM schema for object-model requests, when the kit's engine does not describe its own. */
  schema?: () => Promise<object | undefined>
}

/** The error codes of kit tool results (KHP A18, as `kition-kits-mcp` answers them). */
export type AgentErrorCode =
  | 'invalid-op'
  | 'not-found'
  | 'invalid-value'
  | 'read-only'
  | 'command-failed'
  | 'invalid-params'
  | 'not-open'
  | 'draft-required'
  | 'unknown-command'
  | 'not-allowed'
  | 'unsupported'
  | 'unavailable'
  | 'conflict'
  | 'failed'

const CODES: ReadonlySet<string> = new Set<AgentErrorCode>(['invalid-op', 'not-found', 'invalid-value', 'read-only', 'command-failed', 'invalid-params', 'not-open', 'draft-required', 'unknown-command', 'not-allowed', 'unsupported', 'unavailable', 'conflict', 'failed'])

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const PREVIEW_SIZE = 1024
const MAX_COMMANDS = 40
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_STEPS = 50
const OPS = ['create', 'set', 'delete', 'text.insert', 'text.delete', 'text.set', 'text.mark', 'text.unmark', 'list.insert', 'list.move', 'list.remove', 'map.set', 'map.delete', 'tree.insert', 'tree.move', 'command']

/** A tool failure: `{ code, message, index? }`, with what was done before it. */
class ToolError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly index: number | null = null,
    readonly output: Record<string, unknown> | null = null,
  ) {
    super(message)
  }
}

type Output = { summary: string; output: Record<string, unknown>; previews?: Array<{ caption: string; png: string }> }
type Args = Record<string, unknown>

/** A kit's refusal as a tool error: the code its error data names (`code`, or `reason`). */
function fromKit(error: unknown, context: string, fallback: AgentErrorCode = 'failed'): ToolError {
  if (error instanceof ToolError) return error
  const message = error instanceof Error ? error.message : String(error)
  const data = error instanceof KitRpcError && error.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
  const named = [data.code, data.reason].find((value): value is string => typeof value === 'string' && CODES.has(value))
  const code = (named as AgentErrorCode | undefined) ?? (error instanceof KitRpcError && error.code === -32601 ? 'unsupported' : /no draft/i.test(message) ? 'draft-required' : fallback)
  return new ToolError(code, `${context}${message}`, typeof data.index === 'number' ? data.index : null)
}

function diagnosticsSummary(what: string, diagnostics: KitDiagnostic[]) {
  if (!diagnostics.length) return `Checked ${what}: the kit found nothing wrong.`
  const count = (severity: string) => diagnostics.filter((item) => item.severity === severity).length
  const plural = (n: number, one: string, many: string) => (n === 0 ? `no ${many}` : n === 1 ? `1 ${one}` : `${n} ${many}`)
  return `Checked ${what}: ${plural(count('error'), 'error', 'errors')}, ${plural(count('warning'), 'warning', 'warnings')}, ${plural(count('info'), 'note', 'notes')}.`
}

/** The ids a loaded field names: a list's items, a ref, a tree's objects. */
function idsOf(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return null
  const ids = value.map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { object?: unknown }).object === 'string' ? (item as { object: string }).object : null))
  return ids.every((id): id is string => id !== null) ? ids : null
}

/** The MCP server of an open editor (see the module comment). */
export function createAgentPort(host: AgentPortHost, options: AgentPortOptions = {}): AgentPort {
  const prefix = host.kitId.replace(/^kit\./, '')
  const origin = { kind: 'agent' as const, principal: options.principal ?? 'agent', label: options.label ?? 'Agent' }
  const draftByDefault = options.draft !== false
  let closed = false

  const name = (suffix: string) => `${prefix}_${suffix}`
  const pathProperty = () => ({ type: 'string', enum: [host.path()], description: `The document open in the page: \`${host.path()}\`.` })
  const draftProperty = { type: 'boolean', description: 'Work on your draft of the file instead of the live document: the person reviews it and merges or discards it. Defaults to the run\'s mode.' }

  async function tools(): Promise<AgentTool[]> {
    const connection = await host.opened()
    const has = (capability: string) => connection.capabilities.includes(capability)
    const tool = (suffix: string, title: string, description: string, properties: Args, required: string[], writes: boolean): AgentTool => ({
      name: name(suffix),
      title,
      description,
      inputSchema: { type: 'object', properties: { path: pathProperty(), ...properties }, required: ['path', ...required] },
      annotations: { readOnlyHint: !writes, destructiveHint: false, openWorldHint: false },
    })
    const list = [
      tool('inspect', 'Inspect', `Open the document in the page's ${prefix} editor and report what it holds; attaches a rendered preview. Use it before and after editing.`, { preview: { type: 'boolean', description: 'Attach a rendered preview image. Defaults to true.' }, draft: draftProperty }, [], false),
      tool('commands', 'Find commands', `Search the ${prefix} editor's commands by keywords; pass an id to ${name('run')}.`, { query: { type: 'string', description: 'Keywords to match in the command id, title, or description.' } }, ['query'], false),
      tool(
        'run',
        'Run commands',
        `Edit the document by running commands in order; each step is one undoable command. With \`draft\`, the steps edit your draft (never saved); call ${name('draft_ready')} when it is done.`,
        {
          steps: { type: 'array', minItems: 1, maxItems: MAX_STEPS, items: { type: 'object', properties: { command: { type: 'string', description: `A command id from ${name('commands')}.` }, params: { type: 'object', description: 'Command parameters.' } }, required: ['command'] } },
          save: { type: 'boolean', description: 'Save the file after the steps. Defaults to true; a draft is never saved.' },
          draft: draftProperty,
        },
        ['steps'],
        true,
      ),
    ]
    if (has('draft')) {
      list.push(
        tool('draft_ready', 'Ask for review', 'Ask the person to review your draft: they see a comparison and merge it or discard it. Do not merge or discard it yourself.', {}, [], false),
        tool('draft_reopen', 'Reopen draft', `Take your draft back from review to keep editing it (after ${name('draft_ready')}).`, {}, [], false),
      )
    }
    if (has('model')) {
      list.push(
        tool(
          'query',
          'Query objects',
          `Read the document's objects from its object model: by id (\`objects\`, \`root\` for the document), or by following fields from the root (\`follow\`). Use the ids with ${name('batch')}.`,
          {
            objects: { type: 'array', items: { type: 'string' }, description: 'Object ids to read; `root` is the document\'s root object. Defaults to the root.' },
            follow: { type: 'string', description: 'A field path from the first object (the root by default), joined with dots.' },
            fields: { type: 'array', items: { type: 'string' }, description: 'Only these fields of each object. Defaults to all.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `At most this many objects. Defaults to ${DEFAULT_LIMIT}.` },
            describe: { type: 'boolean', description: 'Also answer the kit\'s object types (model.describe).' },
            draft: draftProperty,
          },
          [],
          false,
        ),
        tool(
          'batch',
          'Edit objects',
          `Edit the document through its object model: one model/batch of \`ops\` as one undoable step, then \`load\` reads objects back. Failures answer \`error.code\` and the op's \`index\`.`,
          {
            ops: { type: 'array', maxItems: 200, items: { type: 'object', properties: { op: { type: 'string', enum: OPS } }, required: ['op'] } },
            load: { type: 'array', items: { type: 'object', properties: { target: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } }, required: ['target'] } },
            save: { type: 'boolean', description: 'Save the file after the batch. Defaults to true; a draft is never saved.' },
            draft: draftProperty,
          },
          ['ops'],
          true,
        ),
      )
    }
    if (has('check')) {
      list.push(tool('check', 'Check', `List what the kit finds wrong with the document, each with a stable \`code\`, a \`severity\`, its \`target\`, a message, and sometimes a \`fix\` command for ${name('run')}. Changes nothing.`, { draft: draftProperty }, [], false))
    }
    return list
  }

  /** The document's path, checked: the port serves only the page's open document. */
  function checkPath(args: Args) {
    const path = String(args.path ?? '').trim()
    if (!path) throw new ToolError('invalid-params', 'a `path` is required')
    if (path !== host.path()) throw new ToolError('not-open', `\`${path}\` is not open in this page; the open document is \`${host.path()}\``)
    return path
  }

  /** Whether this call works on the draft: its own `draft` wins over the port's default. */
  function wantsDraft(args: Args) {
    return typeof args.draft === 'boolean' ? args.draft : draftByDefault
  }

  async function draftEditor(connection: KitConnection) {
    if (!connection.capabilities.includes('draft')) throw new ToolError('unsupported', `the ${prefix} editor keeps no drafts; edit live with \`draft: false\` if the page allows it`)
    if (!host.editable()) throw new ToolError('read-only', 'the document is open read-only here, so it has no draft')
    return connection
  }

  async function draftState(connection: KitConnection): Promise<DraftInfo> {
    return connection.capabilities.includes('draft') ? connection.draft.state() : { state: 'none', revision: null }
  }

  /** Writes the agent may make live, when the page lets it edit live at all. */
  function liveWrite() {
    if (!host.editable()) throw new ToolError('read-only', 'the document is open read-only here: it cannot be edited')
  }

  async function preview(connection: KitConnection, draft: boolean, path: string) {
    try {
      const { png } = await connection.ai.preview(PREVIEW_SIZE, draft ? { draft: true } : undefined)
      return png ? [{ caption: draft ? `Preview of your draft of \`${path}\`.` : `Preview of \`${path}\`.`, png }] : []
    } catch {
      return []
    }
  }

  async function modelTarget(connection: KitConnection, draft: boolean) {
    if (!connection.capabilities.includes('model')) throw new ToolError('unsupported', `the ${prefix} editor has no object model; use ${name('run')}`)
    if (draft && !connection.capabilities.includes('draft-model')) throw new ToolError('unsupported', `the ${prefix} editor cannot run object-model batches on a draft; edit the draft with ${name('run')}`)
    return connection
  }

  async function load(connection: KitConnection, draft: boolean, entries: Args[]) {
    try {
      const schema = await host.schema?.()
      const answer = await connection.model.batch({ origin, ops: [], load: entries, ...(draft ? { draft: true } : {}), ...(schema ? { schema } : {}) })
      return answer.loaded
    } catch (error) {
      throw fromKit(error, '')
    }
  }

  const calls: Record<string, (args: Args) => Promise<Output>> = {
    async inspect(args) {
      const path = checkPath(args)
      const connection = await host.opened()
      const explicit = args.draft === true
      let draft = wantsDraft(args) && connection.capabilities.includes('draft')
      if (draft && (await draftState(connection)).state === 'none') {
        if (explicit) throw new ToolError('draft-required', `\`${path}\` has no draft yet: edit it with \`draft: true\` first.`)
        draft = false
      }
      const document = await connection.ai.inspect({ ...(draft ? { draft: true } : {}),
        ...(args.context ? { context: args.context as AiStep['context'] } : {}),
        ...(typeof args.part === 'number' ? { part: args.part } : {}),
      }).catch((error) => Promise.reject(fromKit(error, '')))
      const previews = args.preview === false ? [] : await preview(connection, draft, path)
      const summary = typeof document.summary === 'string' ? document.summary : ''
      return { summary: draft ? `Opened your draft of \`${path}\`: ${summary}` : `Opened \`${path}\` in the page's editor: ${summary}`, output: { document, live: true, ...(draft ? { draft: true } : {}) }, previews }
    },
    async commands(args) {
      checkPath(args)
      const query = String(args.query ?? '')
      const found = await (await host.opened()).ai.commands(query).catch((error) => Promise.reject(fromKit(error, '')))
      const listed = found.slice(0, MAX_COMMANDS)
      const summary = found.length > listed.length ? `${found.length} commands match \`${query}\`; showing ${listed.length}. Use more specific keywords.` : `${found.length} commands match \`${query}\``
      return { summary, output: { commands: listed, total: found.length } }
    },
    async run(args) {
      const path = checkPath(args)
      const steps = Array.isArray(args.steps) ? (args.steps as Array<{ command?: unknown; params?: unknown }>) : []
      if (!steps.length) throw new ToolError('invalid-params', '`steps` must be a non-empty array')
      if (steps.length > MAX_STEPS) throw new ToolError('invalid-params', `at most ${MAX_STEPS} steps`)
      const index = steps.findIndex((step) => typeof step?.command !== 'string' || !step.command)
      if (index >= 0) throw new ToolError('invalid-params', `step ${index} has no \`command\``, index)
      const plain = steps.map((step) => ({ command: String(step.command), ...(step.params && typeof step.params === 'object' ? { params: step.params as Args } : {}) }))
      const connection = await host.opened()
      if (wantsDraft(args)) {
        await draftEditor(connection)
        const answer = await connection.ai.run(plain, false, { draft: true }).catch((error) => Promise.reject(fromKit(error, 'on the draft: ', 'command-failed')))
        return {
          summary: `Ran ${answer.completed.length} commands on your draft of \`${path}\`; the document is unchanged until the person merges the draft. Call ${name('draft_ready')} when it is done.`,
          output: { ...answer, live: true, draft: true },
          previews: await preview(connection, true, path),
        }
      }
      liveWrite()
      const save = args.save !== false
      const answer = await connection.ai.run(plain, save).catch((error) => Promise.reject(fromKit(error, 'in the page\'s editor: ', 'command-failed')))
      return { summary: `Ran ${answer.completed.length} commands on \`${path}\` in the page's editor (${answer.saved ? 'saved' : 'not saved'}).`, output: { ...answer, live: true }, previews: await preview(connection, false, path) }
    },
    async draft_ready(args) {
      const path = checkPath(args)
      const connection = await draftEditor(await host.opened())
      const info = await connection.draft.ready().catch((error) => Promise.reject(fromKit(error, '')))
      return { summary: `Your draft of \`${path}\` is ready for review; the person will merge or discard it.`, output: info }
    },
    async draft_reopen(args) {
      const path = checkPath(args)
      const connection = await draftEditor(await host.opened())
      const info = await connection.draft.reopen().catch((error) => Promise.reject(fromKit(error, '')))
      return { summary: `Your draft of \`${path}\` is back with you to keep editing.`, output: info }
    },
    async query(args) {
      const path = checkPath(args)
      const connection = await host.opened()
      // An explicit `draft: true` needs a draft; by default a kit that queries drafts reads the open one.
      const explicit = args.draft === true
      const open = (await draftState(connection)).state !== 'none'
      if (explicit && !open) throw new ToolError('draft-required', `\`${path}\` has no draft yet: edit it with \`draft: true\` first.`)
      const draft = explicit || (wantsDraft(args) && open && connection.capabilities.includes('draft-model'))
      await modelTarget(connection, draft)
      let objects = Array.isArray(args.objects) ? (args.objects as unknown[]) : ['root']
      if (!objects.every((id): id is string => typeof id === 'string')) throw new ToolError('invalid-params', '`objects` lists object ids')
      if (!objects.length) objects = ['root']
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT))
      const fields = args.fields == null ? null : Array.isArray(args.fields) && args.fields.every((field) => typeof field === 'string') ? args.fields : null
      if (args.fields != null && !fields) throw new ToolError('invalid-params', '`fields` lists field names')
      let ids = objects as string[]
      const follow = typeof args.follow === 'string' ? args.follow.trim() : ''
      if (follow) {
        let current = [ids[0]!]
        for (const segment of follow.split('.').map((part) => part.trim()).filter(Boolean)) {
          if (/^\d+$/.test(segment)) {
            const picked = current[Number(segment)]
            if (picked === undefined) throw new ToolError('not-found', `\`${follow}\`: there is no item ${segment} (there are ${current.length})`)
            current = [picked]
            continue
          }
          if (current.length !== 1) throw new ToolError('invalid-params', `\`${follow}\`: \`${segment}\` follows ${current.length} objects; pick one by position first`)
          const loaded = await load(connection, draft, [{ target: current[0], fields: [segment] }])
          const next = idsOf(loaded[0]?.fields?.[segment])
          if (!next) throw new ToolError('invalid-params', `\`${follow}\`: \`${segment}\` is not a list, a tree, or a ref, so it names no objects`)
          current = next
        }
        ids = current
      }
      const loaded = await load(connection, draft, ids.slice(0, limit).map((id) => ({ target: id, fields })))
      const output: Args = { objects: loaded, total: ids.length, live: true, ...(draft ? { draft: true } : {}) }
      if (ids.length > limit) output.truncated = true
      if (args.describe === true) output.describe = await connection.model.describe(await host.schema?.()).catch((error) => Promise.reject(fromKit(error, '')))
      const shown = loaded.length
      return { summary: ids.length > shown ? `Read ${shown} of ${ids.length} objects of \`${path}\`; raise \`limit\` or narrow \`follow\` for the rest.` : `Read ${shown} objects of \`${path}\`.`, output }
    },
    async batch(args) {
      const path = checkPath(args)
      const ops = args.ops == null ? [] : Array.isArray(args.ops) ? (args.ops as Args[]) : null
      const loads = args.load == null ? [] : Array.isArray(args.load) ? (args.load as Args[]) : null
      if (!ops) throw new ToolError('invalid-params', '`ops` is an array of operations')
      if (!loads) throw new ToolError('invalid-params', '`load` is an array of `{ target, fields? }`')
      if (!ops.length && !loads.length) throw new ToolError('invalid-params', `\`ops\` is empty: give at least one operation (to only read, use ${name('query')})`)
      // A batch's runs of operations and its commands are separate changes of the document
      // (KitObjectModel OM4), and in the page's editor only undo could take a command back: a
      // command among other operations is refused before anything runs, as kition-kits-mcp
      // refuses it for an open editor, so a failed call never leaves part of it (KHP A16, A18).
      if (ops.length > 1 && ops.some((op) => op?.op === 'command')) {
        throw new ToolError(
          'unsupported',
          `this batch runs a command among other operations, and \`${path}\` is open in its editor, where only undo could take the command back; a batch is one change, so nothing was run. Run the command with ${name('run')} (its steps are all or nothing) and the other operations in their own ${name('batch')}.`,
        )
      }
      const connection = await host.opened()
      const draft = wantsDraft(args)
      if (draft) await draftEditor(connection)
      else if (ops.length) liveWrite()
      await modelTarget(connection, draft)
      let answer
      try {
        const schema = await host.schema?.()
        answer = await connection.model.batch({ origin, ops, load: loads, ...(draft ? { draft: true } : {}), ...(schema ? { schema } : {}) })
      } catch (error) {
        const failure = fromKit(error, '')
        throw failure.index !== null ? new ToolError(failure.code, `op ${failure.index}: ${failure.message}`, failure.index) : failure
      }
      const result: Args = { refs: answer.refs, results: answer.results, loaded: answer.loaded }
      const save = !draft && ops.length > 0 && args.save !== false
      const saved = save ? (await connection.save().catch((error) => Promise.reject(fromKit(error, 'the batch was applied but saving failed: ')))).saved : false
      return {
        summary: draft ? `Ran ${ops.length} operations on your draft of \`${path}\`; call ${name('draft_ready')} when it is done.` : `Ran ${ops.length} operations on \`${path}\` in the page's editor (${saved ? 'saved' : 'not saved'}).`,
        output: { ...result, live: true, ...(draft ? { draft: true } : { saved }) },
      }
    },
    async check(args) {
      const path = checkPath(args)
      const connection = await host.opened()
      if (!connection.capabilities.includes('check')) throw new ToolError('unsupported', `this version of the ${prefix} editor cannot check documents yet; inspect the preview instead`)
      const explicit = args.draft === true
      let draft = wantsDraft(args) && connection.capabilities.includes('draft') && (await draftState(connection)).state !== 'none'
      if (explicit && !draft) throw new ToolError('draft-required', `\`${path}\` has no draft yet: edit it with \`draft: true\` first.`)
      if (args.draft === false) draft = false
      const diagnostics = await connection.check(draft ? { draft: true } : undefined).catch((error) => Promise.reject(fromKit(error, '')))
      return { summary: diagnosticsSummary(draft ? `your draft of \`${path}\`` : `\`${path}\``, diagnostics), output: { diagnostics } }
    },
  }

  function toolResult(outcome: { ok: Output } | { error: ToolError }) {
    if ('ok' in outcome) {
      const { summary, output, previews = [] } = outcome.ok
      const content: Args[] = [{ type: 'text', text: `${summary}\n${JSON.stringify(output)}` }]
      for (const shown of previews) content.push({ type: 'text', text: shown.caption }, { type: 'image', mimeType: 'image/png', data: shown.png })
      return { content, structuredContent: output, isError: false }
    }
    const { error } = outcome
    const json = { code: error.code, message: error.message, ...(error.index !== null ? { index: error.index } : {}) }
    return { content: [{ type: 'text', text: `${error.message}\nerror: ${JSON.stringify(json)}` }], structuredContent: { ...(error.output ?? {}), error: json }, isError: true }
  }

  async function handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (!message || typeof message.method !== 'string' || message.id === undefined) return null
    const id = message.id
    const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, text: string): JsonRpcMessage => ({ jsonrpc: '2.0', id, error: { code, message: text } })
    if (closed) return fail(-32000, 'the editor was closed')
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Args
    switch (message.method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '')
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kition-embed', title: 'Kition editor in the page', version: host.version },
          instructions: `The person has \`${host.path()}\` open in a ${prefix} editor in their page. Call ${name('inspect')} first, find commands with ${name('commands')}, then edit with ${name('run')}${draftByDefault ? ' (your edits go to a draft: call ' + name('draft_ready') + ' when it is done; the person merges it)' : ''}. After editing, call ${name('check')} and fix the errors it reports. Failed calls answer \`error.code\`.`,
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        try {
          return reply({ tools: await tools() })
        } catch (error) {
          return fail(-32000, error instanceof Error ? error.message : String(error))
        }
      case 'tools/call': {
        const tool = String(params.name ?? '')
        const suffix = tool.startsWith(`${prefix}_`) ? tool.slice(prefix.length + 1) : ''
        const call = Object.hasOwn(calls, suffix) ? calls[suffix] : undefined
        if (!call || !(await tools()).some((offered) => offered.name === tool)) return fail(-32602, `unknown tool \`${tool}\``)
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Args
        try {
          return reply(toolResult({ ok: await call(args) }))
        } catch (error) {
          return reply(toolResult({ error: fromKit(error, '') }))
        }
      }
      default:
        return fail(-32601, `unknown method \`${message.method}\``)
    }
  }

  return {
    handle,
    tools,
    close: () => {
      closed = true
    },
  }
}

/** One end of a relay between the page and its server: the agent's messages in, the port's replies out. */
export type AgentRelayTransport = {
  /** The next message for the port, or `null` when none came in time (asked again). Rejects to stop. */
  next: () => Promise<JsonRpcMessage | null>
  /** Sends the port's reply to a message back. */
  reply: (message: JsonRpcMessage) => Promise<void>
}

/**
 * Pumps messages from `transport` into `port` and its replies back, until `signal` aborts or the
 * transport fails; answers when it stops. A page's relay over HTTP long polling, a WebSocket, or a
 * `MessagePort` all fit `AgentRelayTransport`.
 */
export async function relayAgentPort(port: AgentPort, transport: AgentRelayTransport, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    let message: JsonRpcMessage | null
    try {
      message = await transport.next()
    } catch {
      return
    }
    if (signal?.aborted) return
    if (!message) continue
    const reply = await port.handle(message)
    if (reply) await transport.reply(reply).catch(() => undefined)
  }
}
