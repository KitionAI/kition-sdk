/**
 * The editor page's session (docs/platform/url-embedding.md D-U2): what the service verified from
 * the open token, signed with the service's own secret, so the page's file calls outlive the
 * short open token without carrying it. `kds1.` base64url(JSON) `.` base64url(HMAC-SHA256).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { OpenPerms } from '@kition/sync/openToken'

export type Session = {
  /** The integrator (`iss`) and its tenant. */
  iss: string
  tenant: string
  sub: string
  name: string
  file: string
  version: string
  docKey: string
  perms: OpenPerms
  watermark: { text: string } | null
  /** The kit the page opens. */
  kit: string
  /** Unix seconds. */
  exp: number
}

const PREFIX = 'kds1.'
const b64 = (bytes: Buffer) => bytes.toString('base64url')
const mac = (secret: string, segment: string) => createHmac('sha256', secret).update(`kition-doc-session\n${segment}`).digest()

export function makeSession(secret: string, session: Session) {
  const segment = b64(Buffer.from(JSON.stringify(session)))
  return `${PREFIX}${segment}.${b64(mac(secret, segment))}`
}

/** The session `token` names, or `null` when it is not one of ours, was changed, or expired. */
export function readSession(secret: string, token: string | null | undefined, now = Math.floor(Date.now() / 1000)): Session | null {
  if (!token?.startsWith(PREFIX)) return null
  const [segment, signature, extra] = token.slice(PREFIX.length).split('.')
  if (!segment || !signature || extra !== undefined) return null
  const expected = mac(secret, segment)
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const session = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Session
    return typeof session.exp === 'number' && now < session.exp ? session : null
  } catch {
    return null
  }
}
