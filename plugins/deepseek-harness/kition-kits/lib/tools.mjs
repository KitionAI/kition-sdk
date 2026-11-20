// The kits' tools in DeepSeek Harness, `mcp__kition__<tool>`, registered by the host module with
// DeepSeek Harness's tool registry, each call sent to the kits' MCP server of the gateway of the
// calling session's own workspace folder.
//
// Why not DeepSeek Harness's MCP client: it runs one server per host (one stdio process, or one
// HTTP endpoint with fixed headers), and a tool call carries nothing that names the session it
// comes from (dsh-mcp-client: `client.callTool({ name, arguments })`, no `_meta`, no per-call
// headers, `expandTemplates` only for credentials; the same in 0.2.2-rc.2 and rc.5). One server
// can therefore only serve one folder, while every session has a folder of its own, and in
// DeepSeek Harness Desktop the host's own folder is the profile's. A registered tool's `execute`
// is given the calling agent (`exec.agent.session`), so these tools find the session's folder,
// and the gateway that serves it: a file open in the session's Kition editor is edited there, live.
//
// What the MCP client did for its tools is done here the same way: the tool list and the server's
// instructions (a system prompt section), the result's text for the model, `isError` as a failed
// call, and preview images saved as attachments when the model takes images.
import { canonicalFolder } from './workspaces.mjs'
import { GatewayError } from './gateways.mjs'
import { connectionId, McpError } from './mcp.mjs'

export const SERVER = 'kition'
/** The one tool there is while no kition can run. */
export const SETUP_TOOL = 'kition_setup'
export const TOOL_PREFIX = `mcp__${SERVER}__`

/** The kits' unified tools (kition-kits' Action::ALL, `kit_<action>`): the names known before the kits list them. */
export const UNIFIED_TOOLS = ['inspect', 'commands', 'run', 'draft_ready', 'draft_reopen', 'query', 'batch', 'check', 'export', 'create'].map((action) => `kit_${action}`)

/** How long an agent's first step waits at most for the kits' first tool list (`reserve`). */
export const FIRST_LISTING_MS = 30_000
/** A run of edits on a large document can take a while. */
export const TOOL_TIMEOUT_MS = 180_000

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'array', items: {} }, structuredContent: {} },
  required: ['content'],
  additionalProperties: false,
}
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The tool actions that edit a file in place, live when an editor has it open. */
const LIVE_EDITS = new Set(['run', 'batch'])
/** A kit tool's action: `kit_run` → `run`, `note_draft_ready` → `draft_ready`. */
const actionOf = (name) => {
  const at = name.indexOf('_')
  return at > 0 ? name.slice(at + 1) : name
}

/**
 * What a kit tool call did to which file, as the session log keeps it (`presentationMeta`) for the
 * browser module's review cards: `{ kition: 1, tool, path, kit, live, draft, saved, created }`.
 */
export function presentation(tool, args, value) {
  const output = isRecord(value?.structuredContent) ? value.structuredContent : {}
  const document = isRecord(output.document) ? output.document : {}
  const path = typeof document.path === 'string' ? document.path : typeof args?.path === 'string' ? args.path : null
  return {
    kition: 1,
    tool,
    path,
    kit: typeof document.kit === 'string' ? document.kit : null,
    live: output.live === true,
    draft: output.draft === true || args?.draft === true,
    saved: output.saved === true,
    created: tool === 'kit_create',
  }
}

/** One MCP content block as text for the model. */
function blockText(block, imageText) {
  if (!isRecord(block)) return ''
  if (block.type === 'text') return String(block.text ?? '')
  if (block.type === 'image') return imageText(block)
  if (block.type === 'resource') return String(block.resource?.text ?? `[resource ${block.resource?.uri ?? ''}]`)
  if (block.type === 'resource_link') return `[resource ${block.uri ?? ''}]`
  return ''
}

const unavailable = (reason) => (block) => `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}]`

/** MCP content as model content: text runs joined by line, images (when given) where they were. */
export function projectContent(content, image = null, reason = 'this result was not admitted to the model') {
  const out = []
  const text = []
  const flush = () => {
    if (text.length) out.push({ type: 'text', text: text.splice(0).join('\n') })
  }
  for (const [index, block] of content.entries()) {
    if (image && isRecord(block) && block.type === 'image') {
      flush()
      out.push(image(block, index))
    } else text.push(blockText(block, unavailable(reason)))
  }
  flush()
  return out
}

export const contentText = (content, reason) => projectContent(content, null, reason).map((block) => block.text).join('\n')

/**
 * The kit tools of the host module.
 * @param {{
 *   ctx: { get(name: string): any },
 *   register: (definition: object, options?: { when?: () => Promise<boolean> }) => () => void,
 *   gateways: import('./gateways.mjs').Gateways,
 *   mcp: import('./mcp.mjs').GatewayMcp,
 *   log?: (message: string) => void,
 *   beforeEdit?: ((sessionId: string, path: string) => Promise<unknown>) | null,
 * }} options
 */
export class KitTools {
  constructor({ ctx, register, gateways, mcp, log = () => {}, beforeEdit = null }) {
    this.ctx = ctx
    /** Told before a call edits a file live (the live window's handshake, lib/live.mjs); never fails the call. */
    this.beforeEdit = beforeEdit
    this.registerTool = register
    this.gateways = gateways
    this.mcp = mcp
    this.log = log
    /**
     * @type {Map<string, { json: string | null, dispose: () => void, definition?: object, listed?: boolean }>}
     * `definition`, `listed`: a reserved name's (`reserve`), whose definition is filled in place
     */
    this.registered = new Map()
    /** The first listing, bounded, which a reserved tool's step waits for. */
    this.first = Promise.resolve()
    this.instructions = ''
    /** @type {WeakMap<object, string>} agent → its connection to the gateways */
    this.connections = new WeakMap()
    this.projections = new WeakMap()
    this.refreshing = null
  }

  /**
   * Holds the agents' steps for the kits' first tool list (`listing`), at most `boundMs`: DeepSeek
   * Harness takes the tools a step may offer from those registered when the step begins, and the
   * list comes from a `kition mcp` started with the host, which can take seconds; a session's first
   * request was sent without them. So the unified tools' names, known before any listing, are
   * registered now, each admitted to a step only once listed (DeepSeek Harness waits for a
   * registration's `when` while it prepares the step), its definition filled in place by then.
   */
  reserve(listing, { boundMs = FIRST_LISTING_MS, names = UNIFIED_TOOLS } = {}) {
    let timer
    this.first = Promise.race([
      Promise.resolve(listing).catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, boundMs)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
    for (const action of names) {
      const name = `${TOOL_PREFIX}${action}`
      if (this.registered.has(name)) continue
      const definition = this.definition(name, { name: action, description: 'A Kition kit tool, listed once the kits are.', inputSchema: { type: 'object' } })
      const entry = { json: null, definition, listed: false, dispose: () => {} }
      entry.dispose = this.registerTool(definition, {
        when: async () => {
          await this.first
          return this.registered.get(name) === entry && entry.listed
        },
      })
      this.registered.set(name, entry)
    }
  }

  /** The tools the kits' MCP server lists now, registered (those gone removed, those changed replaced). */
  update({ tools, instructions }) {
    if (typeof instructions === 'string' && instructions) this.instructions = instructions
    const next = new Map(tools.map((tool) => [`${TOOL_PREFIX}${tool.name}`, tool]))
    for (const [name, entry] of this.registered) {
      const tool = next.get(name)
      if (entry.definition) {
        // A reserved name stays registered: listed, its definition is the kits' now; not, it is not offered.
        entry.listed = Boolean(tool)
        if (tool && JSON.stringify(tool) !== entry.json) {
          Object.assign(entry.definition, this.definition(name, tool))
          entry.json = JSON.stringify(tool)
        }
        continue
      }
      if (!tool || JSON.stringify(tool) !== entry.json) {
        entry.dispose()
        this.registered.delete(name)
      }
    }
    for (const [name, tool] of next) {
      if (this.registered.has(name)) continue
      this.registered.set(name, { json: JSON.stringify(tool), dispose: this.registerTool(this.definition(name, tool)) })
    }
  }

  dispose() {
    for (const entry of this.registered.values()) entry.dispose()
    this.registered.clear()
    this.clearMissing()
  }

  /** The workspace folder of the session `exec` comes from: the folder the session was opened on. */
  workspaceOf(exec) {
    const session = exec?.agent?.session
    const cwd = session?.header?.cwd ?? this.ctx.get('workingDirectory')?.get?.(session)
    const folder = typeof cwd === 'string' && cwd ? canonicalFolder(cwd) : null
    if (!folder) throw new Error('This session has no workspace folder, so the Kition kits have no files to work on. Open a folder for the session.')
    return folder
  }

  connectionOf(agent) {
    const key = isRecord(agent) ? agent : this
    let id = this.connections.get(key)
    if (!id) this.connections.set(key, (id = connectionId()))
    return id
  }

  /** Sends `method` to the gateway of `workspace`; again to a gateway started anew when nothing ran. */
  async request(workspace, connection, method, params, signal) {
    let gateway = await this.gateways.get(workspace)
    try {
      return { gateway, result: await this.mcp.send(gateway, connection, method, params, signal) }
    } catch (error) {
      if (!(error instanceof McpError) || !error.retry || signal?.aborted) throw error
      this.gateways.forget(workspace)
      gateway = await this.gateways.get(workspace)
      return { gateway, result: await this.mcp.send(gateway, connection, method, params, signal) }
    }
  }

  /** Calls the tool `name` on the gateway of `workspace`. */
  call(workspace, connection, name, args, signal) {
    return this.request(workspace, connection, 'tools/call', { name, arguments: args }, signal)
  }

  /**
   * The kits' MCP resources (each kit's manifest, a document's objects and object model), as
   * DeepSeek Harness's resource tools ask for them: from the gateway of the calling session's folder.
   */
  resourceProvider() {
    return {
      request: async (request, exec) => {
        const workspace = this.workspaceOf(exec)
        const { method, ...params } = request
        try {
          return (await this.request(workspace, this.connectionOf(exec?.agent), method, params, exec?.signal)).result
        } catch (error) {
          if (error instanceof GatewayError) throw new Error(`Kition: ${error.message}`)
          throw error
        }
      },
    }
  }

  /**
   * No kition can run (the plugin's own was not installed for this platform, or an option names
   * none): no kit tools, and one tool that says why, so the agent can tell the person instead of
   * finding no Kition tools at all.
   */
  setMissing(message) {
    this.update({ tools: [] })
    this.missing = message
    if (this.setup) return
    this.setup = this.registerTool({
      name: SETUP_TOOL,
      description:
        'The Kition kit tools (mcp__kition__kit_inspect, kit_run, ...) that edit notes, tables, documents, spreadsheets, slides and other kit files are not available: the kition program that comes with the plugin cannot run on this computer (no build for its platform, or the plugin was installed without its optional dependencies). Call this when the person asks for work on such files: it answers why and what the person can do. The kit tools appear by themselves once kition can run.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: contentText(value.content) }] },
      execute: async () => ({ content: [{ type: 'text', text: this.missing ?? 'kition runs now; its kit tools are available.' }] }),
    })
  }

  /** kition is there: the setup tool goes. */
  clearMissing() {
    this.missing = null
    this.setup?.()
    this.setup = null
  }

  /** Lists the tools again from a gateway that just answered (a kit installed on first use adds some). */
  refresh(gateway, connection) {
    if (this.refreshing) return
    this.refreshing = this.mcp
      .list(gateway, connection)
      .then((listed) => this.update(listed))
      .catch((error) => this.log(`could not list the kit tools again: ${error.message}`))
      .finally(() => {
        this.refreshing = null
      })
  }

  definition(name, tool) {
    const raw = tool.name
    return {
      name,
      description: tool.description ?? '',
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
      timeoutMs: TOOL_TIMEOUT_MS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: contentText(Array.isArray(value?.content) ? value.content : []) }],
        // Kept with the session log: what the browser module's turn projection reads back.
        presentationMeta: (args, value) => presentation(raw, args, value),
      },
      execute: async (args, exec) => {
        const workspace = this.workspaceOf(exec)
        const connection = this.connectionOf(exec?.agent)
        const sessionId = exec?.agent?.session?.id
        // A live edit of a file: the person's live window may open it first, so the edit runs there.
        if (this.beforeEdit && LIVE_EDITS.has(actionOf(raw)) && isRecord(args) && args.draft !== true && typeof args.path === 'string' && typeof sessionId === 'string') {
          await this.beforeEdit(sessionId, args.path).catch(() => undefined)
        }
        let answer
        try {
          answer = await this.call(workspace, connection, raw, isRecord(args) ? args : {}, exec?.signal)
        } catch (error) {
          if (error instanceof GatewayError) throw new Error(`Kition: ${error.message}`)
          throw error
        }
        const { gateway, result } = answer
        this.refresh(gateway, connection)
        if (!isRecord(result) || !Array.isArray(result.content)) throw new Error(`Tool "${raw}" returned an invalid MCP result`)
        if (result.isError === true) throw new Error(contentText(result.content))
        const value = { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
        if (result.content.some((block) => isRecord(block) && block.type === 'image')) this.projections.set(exec, await this.images(exec, result.content))
        return value
      },
      projectContent: (exec, result) => {
        const content = this.projections.get(exec)
        this.projections.delete(exec)
        return content && !result.isError ? content : undefined
      },
    }
  }

  /** The result as model content with its images saved as attachments, when the model takes images. */
  async images(exec, content) {
    const decoded = []
    const indexes = []
    for (const [index, block] of content.entries()) {
      if (!isRecord(block) || block.type !== 'image') continue
      if (!IMAGE_TYPES.includes(block.mimeType) || typeof block.data !== 'string' || !BASE64.test(block.data)) return projectContent(content, null, 'the image is not a PNG, JPEG, WebP or GIF in base64')
      decoded.push({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType })
      indexes.push(index)
    }
    try {
      const attachments = this.ctx.get('attachments')
      const llm = this.ctx.get('llm')
      if (!attachments || !llm) throw new Error('no attachment store is mounted')
      const routed = exec?.agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? exec?.agent?.options?.provider
      const model = routed?.model ?? exec?.agent?.options?.model
      if (provider === undefined || model === undefined) throw new Error('the current model route could not be resolved')
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (!info?.inputModalities?.includes('image')) throw new Error(`model "${model}" does not declare image input`)
      const refs = await attachments.saveImages(decoded)
      const byIndex = new Map(indexes.map((index, at) => [index, refs[at]]))
      return projectContent(content, (_block, index) => ({ type: 'image', attachment: byIndex.get(index) }))
    } catch (error) {
      return projectContent(content, null, error.message)
    }
  }
}
