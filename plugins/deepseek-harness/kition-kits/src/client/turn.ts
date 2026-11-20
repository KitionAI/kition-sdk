/**
 * The turn projection: which kit files an agent's turn touched with the plugin's kit tools, and
 * how (live in an open editor, saved headless, as a draft, created), read from the session's own
 * events (`tool/call`, `tool/result`), so a conversation loaded again shows the same. The host
 * module keeps each call's outcome with the result (`presentationMeta`); a result without it is
 * read from its text.
 */

/** The prefix of the plugin's kit tools. */
export const TOOL_PREFIX = 'mcp__kition__'

/** The kit tool actions that change a file (or its draft). */
const WRITES = new Set(['run', 'batch', 'create', 'draft_ready', 'draft_reopen'])

export type KitOperation = {
  readonly callId: string
  /** The tool's action: `run`, `inspect`, `draft_ready`, ... */
  readonly action: string
  readonly phase: 'pending' | 'done' | 'failed'
  readonly writes: boolean
  /** Ran in an editor that has the file open. */
  readonly live: boolean
  /** On the agent's draft of the file, which only the person merges. */
  readonly draft: boolean
  readonly created: boolean
  /** When its result came (the session event's time, ms), once done. */
  readonly time?: number
}

export type KitTurnFile = { readonly path: string; readonly kit: string | null; readonly operations: readonly KitOperation[] }

/** The turn's data, published at its Turn location under `kitionTurn`. */
export type KitTurnData = { readonly files: readonly KitTurnFile[] }

export type KitTurnState = KitTurnData & { readonly turn: number }

type Event = { type: string; data?: Record<string, unknown>; time?: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The action of a kit tool name (`mcp__kition__kit_draft_ready` → `draft_ready`); null for any other tool. */
export function actionOf(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(TOOL_PREFIX)) return null
  const raw = name.slice(TOOL_PREFIX.length)
  const at = raw.indexOf('_')
  return at > 0 ? raw.slice(at + 1) : null
}

function argumentsOf(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.arguments
  if (isRecord(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** A workspace path as files are named here: `/`-separated, without a leading `./`. */
export const normalPath = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')

function withOperation(files: readonly KitTurnFile[], path: string, kit: string | null, operation: KitOperation): KitTurnFile[] {
  const next = files.map((file) => ({ ...file, operations: file.operations.filter((entry) => entry.callId !== operation.callId) }))
  const at = next.findIndex((file) => file.path === path)
  if (at < 0) next.push({ path, kit, operations: [operation] })
  else next[at] = { path, kit: kit ?? next[at].kit, operations: [...next[at].operations, operation] }
  return next.filter((file) => file.operations.length > 0)
}

/** A `tool/call` of a kit tool: the file and a pending operation. */
export function addCall(state: KitTurnState, data: Record<string, unknown>): KitTurnState {
  const action = actionOf(data.name)
  const args = argumentsOf(data)
  if (!action || typeof args.path !== 'string' || !args.path || typeof data.callId !== 'string') return state
  const operation: KitOperation = { callId: data.callId, action, phase: 'pending', writes: WRITES.has(action), live: false, draft: args.draft === true, created: action === 'create' }
  return { ...state, files: withOperation(state.files, normalPath(args.path), null, operation) }
}

/** What a result says of its call: from the kept presentation, else from its text. */
function outcome(data: Record<string, unknown>): { live: boolean; draft: boolean; kit: string | null; path: string | null } | null {
  const meta = [data.meta, isRecord(data.message) ? data.message.meta : undefined, isRecord(data.result) ? data.result.meta : undefined].find((value) => isRecord(value) && value.kition === 1)
  if (isRecord(meta)) return { live: meta.live === true, draft: meta.draft === true, kit: typeof meta.kit === 'string' ? meta.kit : null, path: typeof meta.path === 'string' ? meta.path : null }
  const message = isRecord(data.message) ? data.message : {}
  const text = (Array.isArray(message.content) ? message.content : [])
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  if (!text) return null
  return { live: /"live":true/.test(text), draft: /"draft":true/.test(text), kit: /"kit":"(kit\.[a-z0-9-]+)"/.exec(text)?.[1] ?? null, path: null }
}

/** A `tool/result` (at `time`): its call's operation done or failed, with what it did. */
export function applyResult(state: KitTurnState, data: Record<string, unknown>, time?: number): KitTurnState {
  const message = isRecord(data.message) ? data.message : {}
  const callId = typeof message.toolCallId === 'string' ? message.toolCallId : typeof data.callId === 'string' ? data.callId : null
  if (!callId) return state
  const file = state.files.find((entry) => entry.operations.some((operation) => operation.callId === callId))
  if (!file) return state
  const before = file.operations.find((operation) => operation.callId === callId)!
  const failed = message.isError === true || data.error !== undefined
  const said = failed ? null : outcome(data)
  const operation: KitOperation = { ...before, phase: failed ? 'failed' : 'done', live: said?.live ?? false, draft: said?.draft ?? before.draft, ...(typeof time === 'number' ? { time } : {}) }
  return { ...state, files: withOperation(state.files, file.path, said?.kit ?? file.kit, operation) }
}

/** The projection's definition for DeepSeek Harness's conversation engine (`uiConversation.events.register`). */
export const kitTurnDefinition = {
  kind: 'kitionTurn',
  match(event: Event) {
    const turn = event.data?.turn
    if (typeof turn !== 'number') return null
    if (event.type === 'turn/start') return { id: String(turn), role: 'start' as const }
    if (event.type === 'tool/call' || event.type === 'tool/result') return { id: String(turn), role: 'update' as const }
    return null
  },
  start(_context: unknown, match: { event: Event }): KitTurnState {
    return { turn: Number(match.event.data?.turn), files: [] }
  },
  update(context: { state: KitTurnState }, match: { event: Event }): KitTurnState {
    const data = match.event.data ?? {}
    if (match.event.type === 'tool/call') return addCall(context.state, data)
    if (match.event.type === 'tool/result') return applyResult(context.state, data, match.event.time)
    return context.state
  },
  buildLocationData(context: { state?: KitTurnState }, scope: string, previous: { value?: KitTurnData } | null) {
    const state = context.state
    if (scope !== 'turn' || !state || state.files.length === 0) return null
    if (previous?.value && previous.value.files === state.files) return previous
    return { kind: 'turn' as const, turn: state.turn, key: 'kitionTurn', value: { files: state.files } }
  },
}

/* -------------------------------------------------------------------------------------------- */
/* A touched file's card: what to show, from the turn and the drafts the gateway lists now.     */

export type DraftNow = { state: 'open' | 'ready'; stale: boolean } | null

export type CardState =
  | 'pending' // the agent's call is still running
  | 'failed' // every write failed
  | 'live' // applied in the open editor
  | 'saved' // applied to the file, headless
  | 'created'
  | 'draft-open'
  | 'draft-ready'
  | 'stale' // a draft whose file changed since it began: Merge and overwrite
  | 'merged'
  | 'discarded'
  | 'draft-gone' // the draft is no longer there, nobody here merged or discarded it
  | 'missing' // the file is gone

/** A review the host recorded (lib/reviews.mjs): the person's Merge or Discard of a draft. */
export type Review = { path: string; outcome: 'merged' | 'discarded'; at: number; session: string | null; turn: number | null; by?: string }

/** When the turn last drafted the file (its last draft write's result), or null. */
export function draftedAt(file: KitTurnFile): number | null {
  const times = file.operations.filter((operation) => operation.writes && operation.draft && operation.phase === 'done' && typeof operation.time === 'number').map((operation) => operation.time!)
  return times.length ? Math.max(...times) : null
}

/**
 * What the person did to the draft one turn made of `path`: the review recorded for that session
 * and turn (a card's), else the first review recorded after the turn drafted it and before any
 * later turn drafted it again (the editor's own review, or a card's from before turns were kept).
 * `drafts` are every turn of the session that drafted `path`: `[turn, draftedAt]`.
 */
export function outcomeFor(reviews: readonly Review[], sessionId: string, path: string, turn: number, drafts: ReadonlyArray<readonly [number, number | null]>): Review | null {
  const own = reviews.filter((review) => review.path === path)
  const exact = own.find((review) => review.session === sessionId && review.turn === turn)
  if (exact) return exact
  const at = drafts.find(([candidate]) => candidate === turn)?.[1]
  if (at == null) return null
  const next = drafts.map(([, time]) => time).filter((time): time is number => time != null && time > at).sort((a, b) => a - b)[0] ?? Infinity
  return own.find((review) => review.turn === null && review.at >= at && review.at < next) ?? null
}

/**
 * The card of `file`: `null` when the turn only read it. `draft` is the gateway's current draft of
 * the file (`undefined` while unknown), `outcome` what the person did to it here, `exists` whether
 * the file is still there.
 */
export function cardState(file: KitTurnFile, now: { draft?: DraftNow; outcome?: 'merged' | 'discarded' | null; exists?: boolean }): CardState | null {
  const writes = file.operations.filter((operation) => operation.writes)
  if (writes.length === 0) return null
  if (writes.some((operation) => operation.phase === 'pending')) return 'pending'
  const done = writes.filter((operation) => operation.phase === 'done')
  if (done.length === 0) return 'failed'
  if (done.some((operation) => operation.draft)) {
    if (now.draft) return now.draft.stale ? 'stale' : now.draft.state === 'ready' ? 'draft-ready' : 'draft-open'
    if (now.draft === undefined) return 'draft-open'
    if (now.outcome) return now.outcome
    return now.exists === false ? 'missing' : 'draft-gone'
  }
  if (now.exists === false) return 'missing'
  if (done.some((operation) => operation.created)) return 'created'
  return done.some((operation) => operation.live) ? 'live' : 'saved'
}

/** The actions a card offers in `state`: the person's own, never the agent's. */
export function cardActions(state: CardState): Array<'open' | 'review' | 'merge' | 'discard' | 'overwrite'> {
  switch (state) {
    case 'draft-open':
    case 'draft-ready':
      return ['open', 'review', 'merge', 'discard']
    case 'stale':
      return ['open', 'review', 'overwrite', 'discard']
    case 'missing':
    case 'pending':
      return []
    default:
      return ['open']
  }
}
