/**
 * The embed server's calls to the integrator (docs/platform/url-embedding.md D-U3): every
 * request is signed with the integrator's shared secret, so the integrator knows it is the
 * service asking, for which person and file generation, and that nothing changed on the way.
 *
 * `X-Kition-Signature: v1=<hex>` = HMAC-SHA256(secret, METHOD "\n" path "\n" timestamp "\n"
 * hex(SHA-256(body))), with `X-Kition-Timestamp` the Unix seconds it was signed at. `path` is the
 * request's path and query as sent. Integrators verify with `verifyCallback` (this module has no
 * dependency but `node:crypto`, so an integrator's server can import it alone).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-kition-signature'
export const TIMESTAMP_HEADER = 'x-kition-timestamp'
export const SUBJECT_HEADER = 'x-kition-subject'
export const DOC_KEY_HEADER = 'x-kition-doc-key'
export const VERSION_HEADER = 'x-kition-version'
export const NAME_HEADER = 'x-kition-name'
/** How far a callback's timestamp may be from the verifier's clock, seconds. */
export const CALLBACK_SKEW_SECS = 300

const bodyHash = (body: Uint8Array | null | undefined) => createHash('sha256').update(body ?? new Uint8Array()).digest('hex')

/** The signature of one callback. */
export function signCallback(secret: string, method: string, path: string, timestamp: number, body?: Uint8Array | null) {
  const mac = createHmac('sha256', secret).update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash(body)}`).digest('hex')
  return `v1=${mac}`
}

/** The headers a callback carries: its signature, timestamp, the person, and the file generation. */
export function callbackHeaders(secret: string, method: string, path: string, body: Uint8Array | null, who: { subject: string; docKey: string }, now = Math.floor(Date.now() / 1000)) {
  return {
    [TIMESTAMP_HEADER]: String(now),
    [SIGNATURE_HEADER]: signCallback(secret, method, path, now, body),
    [SUBJECT_HEADER]: who.subject,
    [DOC_KEY_HEADER]: who.docKey,
  }
}

/**
 * Whether a request the integrator received is the embed server's: its signature matches and
 * its timestamp is within `CALLBACK_SKEW_SECS` of `now`. `headers` are lower-cased names.
 */
export function verifyCallback(secret: string, request: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: Uint8Array | null }, now = Math.floor(Date.now() / 1000)) {
  const header = (name: string) => {
    const value = request.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const timestamp = Number(header(TIMESTAMP_HEADER))
  const signature = header(SIGNATURE_HEADER)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > CALLBACK_SKEW_SECS || !signature) return false
  const expected = Buffer.from(signCallback(secret, request.method, request.path, timestamp, request.body))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
