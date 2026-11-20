/**
 * How the page reaches the gateway: every address relative to the gateway's root as the page sees
 * it (the path before `page/`, so a same-origin proxy may put the gateway under any prefix), with
 * the page session in `Kition-Token` when the page was opened directly (a proxy adds the token
 * itself and the page holds nothing), and the gateway's `{code, message, data}` envelope read.
 */

/** A refusal or a failure to reach the gateway: `status` 0 when nothing answered. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

/**
 * The gateway's root path as the page at `pathname` sees it: what comes before its `page/`
 * segment, without a signed URL's `_signed/<stamp>/` (a signed URL reaches the page only; the
 * API is addressed from the root).
 */
export function gatewayRoot(pathname: string) {
  const at = pathname.lastIndexOf('/page/')
  const root = at >= 0 ? pathname.slice(0, at + 1) : '/'
  return root.replace(/_signed\/[^/]+\/$/, '')
}

/** A workspace path as a URL path: each segment percent-encoded. */
export function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** A workspace path the page may name: relative, `/`-separated, no empty, `.` or `..` segment, no `\`. */
export function cleanPath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

/** Where the page keeps its session in its tab (never a cookie). */
export const SESSION_KEY = 'kition-gateway-session'

export class Gateway {
  /** Called when the gateway refuses the page's credential (its session ended, or the proxy's token is stale). */
  onUnauthorized: (() => void) | null = null

  constructor(
    /** The gateway's root path, with a trailing `/`. */
    readonly root: string,
    /** The page session, when the page was opened directly; `null` behind a proxy. */
    public session: string | null,
    private readonly origin = location.origin,
  ) {}

  /** The absolute address of `path` (relative to the gateway's root). */
  url(path: string) {
    return new URL(this.root + path.replace(/^\//, ''), this.origin).href
  }

  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (this.session) headers.set('Kition-Token', this.session)
    let response: Response
    try {
      response = await fetch(this.url(path), { cache: 'no-store', credentials: 'same-origin', ...init, headers })
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error
      throw new GatewayError(`the gateway does not answer (${error instanceof Error ? error.message : String(error)})`, 0, 'unreachable')
    }
    if (response.status === 401) this.onUnauthorized?.()
    return response
  }

  /** The `data` of a JSON answer; a refusal throws its message and `data.reason`. */
  async json<T>(path: string, init: RequestInit & { body?: BodyInit | null } = {}): Promise<T> {
    const response = await this.fetch(path, init)
    return read<T>(response)
  }

  /** `json` of a `POST` (or `method`) with a JSON body. */
  async send<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    return this.json<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
}

/** The envelope's `data`, or its refusal as a `GatewayError`. */
export async function read<T>(response: Response): Promise<T> {
  const text = await response.text()
  type Envelope = { code?: number; message?: string; data?: unknown }
  let envelope: Envelope | null
  try {
    envelope = text ? (JSON.parse(text) as Envelope) : null
  } catch {
    envelope = null
  }
  if (!response.ok) {
    const data = envelope?.data as { reason?: unknown } | undefined
    const reason = typeof data?.reason === 'string' ? data.reason : null
    throw new GatewayError(envelope?.message || `the gateway answered ${response.status}`, response.status, reason, envelope?.data)
  }
  return (envelope?.data ?? null) as T
}
