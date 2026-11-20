// The live window's handshake: before the host module forwards an agent's edit of a file, it tells
// the browsers watching that session (an event stream each opens on /kition/api/live), and waits a
// little for one of them to open the file in an editor attached to the gateway's bridge, so the
// edit runs in that editor and the person watches it happen. Two bounds: a browser answers within
// the first (`KITION_LIVE_WAIT_MS`, 3 s); one that answers it is opening the editor gets until the
// second (8 s from the announcement, or the first if longer) for the editor to attach: a kit's
// editor loaded for the first time (the Note editor's engine is 11 MB) takes about 3 s. The call
// never waits at all when no browser watches the session or the person turned the live window off;
// whatever a browser answers, or fails to, the call goes on.
import crypto from 'node:crypto'

/** How long a call waits for a browser's answer at most, in milliseconds (`KITION_LIVE_WAIT_MS`). */
export function liveWaitMs(env = process.env) {
  const raw = env.KITION_LIVE_WAIT_MS
  const value = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 10_000) : 3000
}

/** How long, from the announcement, a browser opening the file's editor has for it to attach. */
export const OPENING_MS = 8000

export class LiveAnnouncer {
  /**
   * @param {{ waitMs?: number, openingMs?: number, enabled?: () => boolean }} [options] `enabled`
   *   reads the person's live window setting (the host row's `liveFloat`)
   */
  constructor({ waitMs = liveWaitMs(), openingMs = OPENING_MS, enabled = () => true } = {}) {
    this.waitMs = waitMs
    this.openingMs = openingMs
    this.enabled = enabled
    /** @type {Map<string, Set<import('node:http').ServerResponse>>} session → its watching browsers */
    this.watchers = new Map()
    /** @type {Map<string, (state: string) => void>} announcement → its waiting call */
    this.waiting = new Map()
  }

  /** Whether a browser watches `sessionId`. */
  watched(sessionId) {
    return (this.watchers.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Tells the browsers watching `sessionId` that an agent is about to edit `path`, and waits until
   * one says the file's editor is attached (or open already, or that it opens none): at most the
   * first bound for an answer, at most the second once a browser said it is `opening` the editor.
   * Answers what happened: `skipped`, `attached`, `open`, `none`, `timeout`.
   */
  async announce(sessionId, path) {
    if (!this.enabled() || !this.watched(sessionId) || this.waitMs === 0) return 'skipped'
    const id = crypto.randomBytes(8).toString('hex')
    const started = Date.now()
    const openingMs = Math.max(this.waitMs, this.openingMs)
    const event = `event: editing\ndata: ${JSON.stringify({ id, path, openingMs })}\n\n`
    let timer
    const answered = new Promise((resolve) => {
      const until = (ms) => {
        clearTimeout(timer)
        timer = setTimeout(() => resolve('timeout'), Math.max(0, ms))
        timer.unref?.()
      }
      let opening = false
      this.waiting.set(id, (state) => {
        if (state === 'opening') {
          if (!opening) until(started + openingMs - Date.now())
          opening = true
        } else if (state !== 'none' || !opening) resolve(state)
        // Another browser opening no editor does not end the wait of one opening it.
      })
      until(this.waitMs)
    })
    for (const response of this.watchers.get(sessionId) ?? []) {
      try {
        response.write(event)
      } catch {
        // A browser gone: it answers nothing, the bound still holds.
      }
    }
    try {
      return await answered
    } finally {
      clearTimeout(timer)
      this.waiting.delete(id)
    }
  }

  /** A browser's answer to the announcement `id`: `opening` (then a second one), `attached`, `open` or `none`. */
  answer(id, state) {
    const resolve = this.waiting.get(id)
    if (!resolve) return false
    resolve(['opening', 'attached', 'open', 'none'].includes(state) ? state : 'none')
    return true
  }

  /** A browser's event stream for `sessionId` (GET /kition/api/live). */
  watch(sessionId, req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    res.flushHeaders()
    res.write(': watching\n\n')
    let set = this.watchers.get(sessionId)
    if (!set) this.watchers.set(sessionId, (set = new Set()))
    set.add(res)
    // A comment now and then keeps proxies and the Desktop forwarding from closing an idle stream.
    const beat = setInterval(() => {
      try {
        res.write(': beat\n\n')
      } catch {
        // Closed.
      }
    }, 15_000)
    beat.unref?.()
    const done = () => {
      clearInterval(beat)
      set.delete(res)
      if (set.size === 0) this.watchers.delete(sessionId)
    }
    req.on('close', done)
    res.on('close', done)
  }

  /** Ends every stream (the host stops). */
  close() {
    for (const set of this.watchers.values()) for (const response of set) response.end()
    this.watchers.clear()
    for (const resolve of this.waiting.values()) resolve('skipped')
    this.waiting.clear()
  }
}
