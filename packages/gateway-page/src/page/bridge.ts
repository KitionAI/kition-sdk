/**
 * The page's end of the Kit AI bridge (KitAgent A7 to A10; Kition's `kitBridge.ts`): the gateway
 * asks over one event stream (`GET /api/v1/kits/bridge`) which documents are open here and runs the
 * agent's kit tools in the open editor's engine, so the person sees each edit at once and it joins
 * the editor's undo history. The page answers with `POST /api/v1/kits/bridge?session=<id>`.
 *
 * It answers `kit/documents` with each editor's `capabilities` (the kit's own list: `context`,
 * `changes`, `model`, `draft`, ...), so the gateway plans a run's call context, follows the
 * editor's replica (`version`, `changes`) and guards its premises (`premise`) as on the headless
 * path. The stream is read with `fetch` (so the page session goes in its header) and opened again
 * after a break, with a growing pause; every new stream starts with `bridge.ready` and its session.
 */
import type { KitConnection } from '@kition/kit-host'
import type { Gateway } from './gateway'

/** An editor open here, as the bridge sees it. */
export type BridgeEditor = {
  path: string
  kit: string
  connection: KitConnection
  revision: () => number
  dirty: () => boolean
  readOnly: boolean
  /** What the agent reads of an `ai/inspect` answer (the kit's editor state left out, K23). */
  inspected: (answer: Record<string, unknown>) => Record<string, unknown>
}

/** A refusal whose `data` the gateway turns into a structured error code. */
export class BridgeRefusal extends Error {
  constructor(
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message)
  }
}

type Args = Record<string, unknown>

const normalize = (path: string) => path.trim().replace(/^\.\//, '').replace(/^\/+/, '')

/** The answer to one bridge request for `editors` (by path); a thrown error is the answer's error. */
export async function answer(editors: Map<string, BridgeEditor>, method: string, params: Args): Promise<unknown> {
  const editorFor = () => {
    const path = normalize(String(params.path ?? ''))
    const editor = editors.get(path)
    if (!editor) throw new Error(`${path} is not open in a kit editor here`)
    if (params.kit && params.kit !== editor.kit) throw new Error(`${path} is open in ${editor.kit}, not ${String(params.kit)}`)
    return editor
  }
  switch (method) {
    case 'kit/documents':
      return {
        documents: [...editors.values()].map((editor) => ({ path: editor.path, kit: editor.kit, dirty: editor.dirty(), revision: editor.revision(), capabilities: editor.connection.capabilities })),
      }
    case 'kit/preview': {
      const editor = editorFor()
      const preview = await editor.connection.ai.preview(Math.max(1, Number(params.maxSize) || 1024), params.draft === true ? { draft: true } : {})
      return { png: preview.png }
    }
    case 'kit/call':
      return call(editorFor(), String(params.tool ?? ''), (params.arguments ?? {}) as Args)
    default:
      throw new Error(`unknown bridge method ${method}`)
  }
}

async function call(editor: BridgeEditor, tool: string, args: Args): Promise<unknown> {
  const { connection } = editor
  const can = (capability: string) => connection.capabilities.includes(capability)
  const draft = args.draft === true
  const onDraft = draft ? { draft: true } : {}
  const inspect = async () => {
    const options: Parameters<KitConnection['ai']['inspect']>[0] = { ...onDraft }
    if (args.context && typeof args.context === 'object') options.context = args.context as never
    if (typeof args.part === 'number') options.part = args.part
    return editor.inspected(await connection.ai.inspect(options))
  }
  switch (tool) {
    case 'inspect':
      return { document: await inspect() }
    case 'commands': {
      const commands = await connection.ai.commands(String(args.query ?? ''))
      return { commands, total: commands.length }
    }
    case 'run': {
      const steps = Array.isArray(args.steps) ? (args.steps as Parameters<KitConnection['ai']['run']>[0]) : []
      if (!steps.length) throw new Error('`steps` must be a non-empty array')
      if (draft && !can('draft')) throw new Error(`${editor.path} is open in an editor that keeps no drafts; edit it live`)
      if (!draft && args.save !== false && editor.readOnly) throw new BridgeRefusal(`${editor.path} is open read-only`, { code: 'read-only' })
      const result = await connection.ai.run(steps, !draft && args.save !== false, onDraft)
      // A run that closed the document leaves nothing to inspect.
      const closed = result.closed === true || (result.completed.at(-1)?.result as { closed?: unknown } | null)?.closed === true
      return closed ? { ...result } : { ...result, document: await inspect() }
    }
    case 'describe':
    case 'batch': {
      if (!can('model')) throw new BridgeRefusal(`${editor.path} is open in an editor whose kit serves no object model`, { code: 'unsupported' })
      if (draft && !(can('draft') && can('draft-model'))) {
        throw new BridgeRefusal(`${editor.path} is open in an editor that cannot run object-model batches on a draft; edit the draft with its run tool`, { code: 'unsupported' })
      }
      const schema = args.schema && typeof args.schema === 'object' ? (args.schema as object) : undefined
      if (tool === 'describe') return connection.model.describe(schema)
      const ops = Array.isArray(args.ops) ? (args.ops as Array<Record<string, unknown>>) : []
      const load = Array.isArray(args.load) ? (args.load as Array<Record<string, unknown>>) : []
      const params = { origin: args.origin, ops, load, ...(schema ? { schema } : {}), ...onDraft } as Parameters<KitConnection['model']['batch']>[0]
      const result: Record<string, unknown> = { ...(await connection.model.batch(params)) }
      // The replica's version is the host's to read (`version`), not the batch's answer.
      delete result.version
      const saved = ops.length > 0 && !draft && args.save === true && !editor.readOnly ? (await connection.save()).saved : false
      return { ...result, saved }
    }
    case 'check':
      if (!can('check')) throw new BridgeRefusal(`${editor.path} is open in an editor whose kit cannot check documents yet`, { code: 'unsupported' })
      return { diagnostics: await connection.check(onDraft) }
    case 'version':
      if (!can('changes')) throw new BridgeRefusal(`${editor.path} is open in an editor that keeps no replica versions`, { code: 'unsupported' })
      return { version: await connection.ai.version() }
    case 'changes':
      if (!can('changes')) throw new BridgeRefusal(`${editor.path} is open in an editor that keeps no replica versions`, { code: 'unsupported' })
      return connection.ai.changes(String(args.since ?? ''), args.schema && typeof args.schema === 'object' ? (args.schema as object) : undefined)
    case 'premise':
      return (await connection.ai.premise(String(args.method ?? ''), (args.params ?? {}) as Record<string, unknown>)) ?? null
    case 'draft_ready':
    case 'draft_reopen':
      if (!can('draft')) throw new Error(`${editor.path} is open in an editor that keeps no drafts`)
      return tool === 'draft_ready' ? connection.draft.ready() : connection.draft.reopen()
    default:
      throw new Error(`unknown kit tool ${tool}`)
  }
}

/** The JSON-RPC error a thrown error answers, its `data` kept (an object-model refusal's `{ code, index, message }`). */
export function failure(error: unknown) {
  const data = (error as { data?: unknown } | null)?.data
  return { code: -32000, message: error instanceof Error ? error.message : String(error), ...(data && typeof data === 'object' ? { data } : {}) }
}

/** Splits server-sent events out of `buffer`: the `data` of each complete event, and what is left. */
export function events(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = []
  let rest = buffer.replace(/\r\n/g, '\n')
  for (let end = rest.indexOf('\n\n'); end >= 0; end = rest.indexOf('\n\n')) {
    const frame = rest.slice(0, end)
    rest = rest.slice(end + 2)
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) messages.push(data)
  }
  return { messages, rest }
}

type Message = { jsonrpc?: string; id?: number; method?: string; params?: Args }

/** The pause before the `attempt`th reconnection: 0.5 s, doubling, at most 10 s. */
export const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt))

/** The bridge for this page: open while an editor is registered. */
export class Bridge {
  private readonly editors = new Map<string, BridgeEditor>()
  private session: number | null = null
  private stop: AbortController | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** Hears the gateway's notifications (`kit/draftsChanged`, ...). */
  readonly listeners = new Set<(method: string, params: Args) => void>()
  /** Hears whether the stream is up. */
  onConnection: ((connected: boolean) => void) | null = null

  constructor(private readonly gateway: Gateway) {}

  /** Makes `editor` reachable by the agent; answers its withdrawal. */
  register(editor: BridgeEditor) {
    const path = normalize(editor.path)
    this.editors.set(path, editor)
    this.open()
    return () => {
      if (this.editors.get(path) === editor) this.editors.delete(path)
    }
  }

  /** Listens to the stream (also with no editor registered, for the draft notifications). */
  open() {
    if (this.stop) return
    this.stop = new AbortController()
    void this.run(this.stop.signal)
  }

  close() {
    this.stop?.abort()
    this.stop = null
    this.session = null
  }

  /** Tells the agent a live document changed (A8 `kit.changed`), and who changed it. */
  changed(path: string, revision: number, by: 'agent' | 'person') {
    void this.post({ method: 'kit.changed', params: { path: normalize(path), revision, by } })
  }

  private async post(message: Record<string, unknown>, session = this.session) {
    if (session == null) return
    await this.gateway.fetch(`api/v1/kits/bridge?session=${session}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...message }) }).catch(() => undefined)
  }

  private receive(data: string) {
    let message: Message
    try {
      message = JSON.parse(data) as Message
    } catch {
      return
    }
    const method = String(message.method ?? '')
    const params = message.params ?? {}
    if (method === 'bridge.ready') {
      this.session = Number(params.session)
      this.onConnection?.(true)
      return
    }
    if (message.id == null) {
      for (const listener of this.listeners) listener(method, params)
      return
    }
    // Requests are answered one after another, in the order sent (a run, then its preview); an
    // answer goes to the session its request came on.
    const session = this.session
    this.queue = this.queue
      .then(() => answer(this.editors, method, params))
      .then(
        (result) => this.post({ id: message.id, result: result ?? {} }, session),
        (error: unknown) => this.post({ id: message.id, error: failure(error) }, session),
      )
  }

  private async run(signal: AbortSignal) {
    for (let attempt = 0; !signal.aborted; ) {
      let opened = false
      try {
        const response = await this.gateway.fetch('api/v1/kits/bridge', { headers: { Accept: 'text/event-stream' }, signal })
        if (!response.ok || !response.body) throw new Error(`the bridge answered ${response.status}`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const split = events(buffer + value)
          buffer = split.rest
          for (const data of split.messages) {
            opened = true
            this.receive(data)
          }
        }
      } catch {
        if (signal.aborted) return
      }
      this.session = null
      this.onConnection?.(false)
      attempt = opened ? 0 : attempt + 1
      await new Promise((resolve) => setTimeout(resolve, backoff(attempt)))
    }
  }
}
