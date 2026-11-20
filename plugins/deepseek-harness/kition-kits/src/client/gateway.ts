/**
 * What the browser module asks a workspace's gateway through the host module's same-origin proxy
 * (`/kition/w/<key>/…`, behind DeepSeek Harness's login): the drafts there, a draft's comparison,
 * and the person's Merge and Discard. Every call is made from the person's own action in this
 * page (a click); none is offered to an agent (KHP A14).
 */
import type { Review } from './turn'

export type Opened = { phase: 'opening' } | { phase: 'open'; page: string; key: string; path: string } | { phase: 'failed'; error: string; message: string }

/** The host module's route `path`, relative to where DeepSeek Harness is served. */
export const route = (path: string) => new URL(path, document.baseURI).href

/** Asks the host module to open a session's file: its gateway started, the page's address. */
export async function openFile(sessionId: string, path: string): Promise<Opened> {
  try {
    const response = await fetch(route(`kition/api/open?${new URLSearchParams({ session: sessionId, path })}`), { credentials: 'same-origin', cache: 'no-store' })
    const answer = await response.json().catch(() => ({}))
    if (response.ok && typeof answer.page === 'string') return { phase: 'open', page: answer.page, key: answer.key, path: answer.path }
    return { phase: 'failed', error: String(answer.error ?? `http-${response.status}`), message: String(answer.message ?? response.statusText) }
  } catch (error) {
    return { phase: 'failed', error: 'unreachable', message: (error as Error).message }
  }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(message)
  }
}

/** A JSON call to the gateway of workspace `key`: its envelope's `data`, or its refusal thrown. */
export async function gatewayJson<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(route(`kition/w/${key}/${path}`), { credentials: 'same-origin', cache: 'no-store', ...init })
  } catch (error) {
    throw new GatewayError((error as Error).message, 0, 'unreachable')
  }
  const envelope = (await response.json().catch(() => null)) as { message?: string; data?: { reason?: string } & Record<string, unknown>; error?: string } | null
  if (!response.ok) throw new GatewayError(envelope?.message ?? `the gateway answered ${response.status}`, response.status, envelope?.data?.reason ?? envelope?.error ?? null)
  return (envelope?.data ?? null) as T
}

/** Where a review comes from: the card of a session's turn (the host records it so). */
export type Origin = { session: string; turn: number }

const post = (key: string, path: string, body: unknown, origin?: Origin) =>
  gatewayJson(key, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { 'Kition-Dsh-Session': origin.session, 'Kition-Dsh-Turn': String(origin.turn) } : {}) },
    body: JSON.stringify(body),
  })

export type DraftListing = { path: string; state: 'open' | 'ready'; stale: boolean; updated?: number }
export type Comparison = {
  stale: boolean
  diff: { created?: unknown[]; changed?: unknown[]; moved?: unknown[]; deleted?: unknown[]; texts?: unknown[] } | null
  diffUnavailable?: string
  summary?: { base?: string; draft?: string }
  previews?: { base?: string; draft?: string }
}

export const compare = (key: string, path: string) => gatewayJson<Comparison>(key, `api/v1/kits/drafts/compare?${new URLSearchParams({ path, previews: 'true' })}`)
/** The person's Merge (with `overwrite`, over a file that changed since the draft began). */
export const merge = (key: string, path: string, overwrite = false, origin?: Origin) => post(key, 'api/v1/kits/drafts/merge', { path, overwrite }, origin)
/** The person's Discard. */
export const discard = (key: string, path: string, origin?: Origin) => post(key, 'api/v1/kits/drafts/discard', { path }, origin)

/** Whether the workspace file is still there. */
export async function exists(key: string, path: string) {
  const response = await fetch(route(`kition/w/${key}/kit-files/${path.split('/').map(encodeURIComponent).join('/')}`), { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }).catch(() => null)
  return response ? response.status !== 404 : true
}

/* -------------------------------------------------------------------------------------------- */

/**
 * The drafts of one workspace, followed: listed again when the gateway's bridge says they changed
 * (`kit/draftsChanged`), when a page or a card says so, and every 10 s while anyone listens.
 */
class DraftsWatch {
  drafts: Map<string, DraftListing> | null = null
  failed: string | null = null
  private readonly listeners = new Set<() => void>()
  private stream: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(readonly key: string) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  async refresh() {
    try {
      const listed = await gatewayJson<{ drafts: DraftListing[] }>(this.key, 'api/v1/kits/drafts')
      this.drafts = new Map(listed.drafts.map((draft) => [draft.path, draft]))
      this.failed = null
    } catch (error) {
      this.failed = (error as Error).message
    }
    for (const listener of [...this.listeners]) listener()
  }

  private start() {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 10_000)
    this.stream = new AbortController()
    void this.listen(this.stream.signal)
  }

  private stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stream?.abort()
    this.stream = null
  }

  /** The gateway's bridge stream, as a window with no editor: it hears the drafts change. */
  private async listen(signal: AbortSignal) {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const response = await fetch(route(`kition/w/${this.key}/api/v1/kits/bridge`), { credentials: 'same-origin', headers: { Accept: 'text/event-stream' }, signal })
        if (!response.ok || !response.body) throw new Error(String(response.status))
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        let session: number | null = null
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value.replace(/\r\n/g, '\n')
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n')
            if (!data) continue
            let message: { id?: number; method?: string; params?: { session?: number } }
            try {
              message = JSON.parse(data)
            } catch {
              continue
            }
            attempt = 0
            if (message.method === 'bridge.ready') session = Number(message.params?.session)
            else if (message.id != null && session != null) {
              // This window has no editor open: it answers so, and nothing else.
              const answer = message.method === 'kit/documents' ? { result: { documents: [] } } : { error: { code: -32000, message: 'no editor is open here' } }
              void fetch(route(`kition/w/${this.key}/api/v1/kits/bridge?session=${session}`), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, ...answer }) }).catch(() => undefined)
            } else if (message.method === 'kit/draftsChanged') void this.refresh()
          }
        }
      } catch {
        if (signal.aborted) return
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
    }
  }
}

const watches = new Map<string, DraftsWatch>()
export function draftsOf(key: string) {
  let watch = watches.get(key)
  if (!watch) watches.set(key, (watch = new DraftsWatch(key)))
  return watch
}

/* -------------------------------------------------------------------------------------------- */

/**
 * The person's reviews of the session's workspace's drafts, as the host module records them (every
 * Merge and Discard through it, from a card or the editor's own review), followed: asked again when
 * a draft changes or the person reviews one.
 */
class ReviewsWatch {
  reviews: Review[] = []
  private readonly listeners = new Set<() => void>()
  private asked = false

  constructor(readonly sessionId: string) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    if (!this.asked) void this.refresh()
    return () => this.listeners.delete(listener)
  }

  async refresh() {
    this.asked = true
    try {
      const response = await fetch(route(`kition/api/reviews?${new URLSearchParams({ session: this.sessionId })}`), { credentials: 'same-origin', cache: 'no-store' })
      const answer = await response.json()
      if (response.ok && Array.isArray(answer.reviews)) this.reviews = answer.reviews
    } catch {
      // Asked again with the next change.
    }
    for (const listener of [...this.listeners]) listener()
  }
}

const reviewWatches = new Map<string, ReviewsWatch>()
export function reviewsOf(sessionId: string) {
  let watch = reviewWatches.get(sessionId)
  if (!watch) reviewWatches.set(sessionId, (watch = new ReviewsWatch(sessionId)))
  return watch
}

/** Every turn shown that drafted each session's file, and when: what a review without a turn is matched against. */
const draftingTurns = new Map<string, Map<number, number | null>>()
const draftingListeners = new Set<() => void>()
let draftingVersion = 0
export function noteDraftingTurn(sessionId: string, path: string, turn: number, at: number | null) {
  const key = `${sessionId}:${path}`
  let turns = draftingTurns.get(key)
  if (!turns) draftingTurns.set(key, (turns = new Map()))
  if (turns.get(turn) === at) return
  turns.set(turn, at)
  draftingVersion++
  queueMicrotask(() => {
    for (const listener of [...draftingListeners]) listener()
  })
}
export function subscribeDraftingTurns(listener: () => void) {
  draftingListeners.add(listener)
  return () => draftingListeners.delete(listener)
}
export const draftingVersionNow = () => draftingVersion
export const draftingTurnsOf = (sessionId: string, path: string): Array<[number, number | null]> => [...(draftingTurns.get(`${sessionId}:${path}`) ?? new Map()).entries()]
/** The latest turn shown that drafted the file. */
export const draftingTurnOf = (sessionId: string, path: string) => {
  const turns = draftingTurnsOf(sessionId, path).map(([turn]) => turn)
  return turns.length ? Math.max(...turns) : null
}
