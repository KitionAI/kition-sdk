/**
 * The integrator's sync token route (`POST /api/sync-token`), as a Vite plugin for serve.mjs:
 * the page's `identity.token` asks it for one person's sync token on every connection
 * (docs/sdk/collab.md). The browser never holds the sync secret.
 *
 * - With KITION_SYNC_EXCHANGE (Console's `https://console.kition.ai/api/sdk/sync-tokens`),
 *   KITION_SYNC_SECRET (the tenant's sync secret) and KITION_SYNC_TENANT, it exchanges them for the
 *   token (hosted Kition Cloud).
 * - Without them it signs the token itself, as an integrator running Kition Server does with its own
 *   key: KITION_SYNC_SEED (32 bytes, base64url; a fresh key per run when unset), tenant
 *   KITION_SYNC_TENANT ("example"), server KITION_SYNC_SERVER (`ws://127.0.0.1:18300/v1/t/<tenant>`).
 *   It prints the `[[tenants.key]]` Kition Server needs to trust it.
 *
 * The person comes from the request body here (an example page with no sign-in); a real
 * integrator takes it from its own session and decides the role and documents itself.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto'

const ROLES = ['owner', 'editor', 'commenter', 'viewer']
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** A token signer for the self-signed mode: `{ kid, publicKey, sign(claims) }`. */
export function localSigner(seed = randomBytes(32), kid = 'example-sync-1') {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(key).export({ format: 'jwk' }).x
  return {
    kid,
    publicKey,
    /** `ks1.` base64url(claims, keys sorted) `.` base64url(Ed25519 signature over the segment). */
    sign(claims) {
      const sorted = Object.fromEntries(Object.entries({ ...claims, v: 1, typ: 'kition-sync', kid, iss: 'self' }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      const segment = Buffer.from(JSON.stringify(sorted)).toString('base64url')
      return `ks1.${segment}.${sign(null, Buffer.from(segment), key).toString('base64url')}`
    },
  }
}

/** Reads `{ user: {id, name}, documents, role, ttl }` and checks what the example lets through. */
export function tokenRequest(body) {
  const user = body?.user
  if (!user || typeof user.id !== 'string' || !user.id || user.id.length > 128) throw new Error('user.id is required')
  const role = body.role ?? 'editor'
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`)
  const documents = body.documents ?? '*'
  if (documents !== '*' && !(Array.isArray(documents) && documents.length > 0 && documents.every((doc) => typeof doc === 'string'))) {
    throw new Error('documents must be "*" or a list of document ids')
  }
  const ttl = Number(body.ttl ?? 900)
  return { user: { id: user.id, name: typeof user.name === 'string' ? user.name : user.id }, documents, role, ttl }
}

/** The route's answer for one request: `{ token, expires, tenant, url }`. */
export async function issueToken(request, env = process.env, signer = undefined, now = () => Math.floor(Date.now() / 1000)) {
  const wanted = tokenRequest(request)
  if (env.KITION_SYNC_EXCHANGE) {
    const answer = await fetch(env.KITION_SYNC_EXCHANGE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.KITION_SYNC_SECRET ?? ''}` },
      body: JSON.stringify({ tenant: env.KITION_SYNC_TENANT ?? '', ...wanted }),
    })
    const body = await answer.json().catch(() => ({}))
    if (!answer.ok) throw new Error(`the exchange answered ${answer.status}: ${body?.error ?? body?.message ?? ''}`)
    return body.data ?? body
  }
  const tenant = env.KITION_SYNC_TENANT || 'example'
  const iat = now()
  const exp = iat + Math.min(Math.max(wanted.ttl, 60), 3600)
  const token = signer.sign({ tenant, sub: wanted.user.id, name: wanted.user.name, role: wanted.role, docs: wanted.documents, iat, exp })
  return { token, expires: exp, tenant, url: env.KITION_SYNC_SERVER || `ws://127.0.0.1:18300/v1/t/${tenant}` }
}

/** The Vite plugin serve.mjs adds: `POST /api/sync-token`. */
export function syncTokens(env = process.env) {
  const signer = env.KITION_SYNC_EXCHANGE ? undefined : localSigner(env.KITION_SYNC_SEED ? Buffer.from(env.KITION_SYNC_SEED, 'base64url') : undefined)
  if (signer) {
    console.log(`sync tokens: signed here for tenant ${env.KITION_SYNC_TENANT || 'example'}; Kition Server trusts them with`)
    console.log(`  [[tenants.key]]\n  kid = "${signer.kid}"\n  public_key = "${signer.publicKey}"\n  tenant = "${env.KITION_SYNC_TENANT || 'example'}"`)
  }
  return {
    name: 'sync-tokens',
    configureServer(server) {
      server.middlewares.use('/api/sync-token', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          return response.end()
        }
        let text = ''
        request.on('data', (chunk) => {
          text += chunk
        })
        request.on('end', async () => {
          response.setHeader('content-type', 'application/json')
          response.setHeader('cache-control', 'no-store')
          try {
            response.end(JSON.stringify(await issueToken(JSON.parse(text || '{}'), env, signer)))
          } catch (error) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        })
      })
    },
  }
}
