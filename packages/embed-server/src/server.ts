/**
 * The embed server (docs/platform/url-embedding.md): `createEmbedServer(config)` answers a
 * Node `http` request handler.
 *
 * - `GET /v1/open?token=ko1…` verifies the integrator's open token (D-U1) and answers the editor
 *   page with a session (D-U2).
 * - `GET /v1/file`, `GET /v1/file/stamp`, `PUT /v1/file`, `GET|PUT /v1/replica` (bearer: the
 *   session) read and write through the integrator's signed callbacks (D-U3), under the token's
 *   permissions (D-U4).
 * - `GET /assets/embed/…` serves `@kition/embed`'s built module.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeOpenToken, OpenTokenError, verifyOpenToken, type OpenTokenKey } from '@kition/sync/openToken'
import { callbackHeaders, NAME_HEADER, VERSION_HEADER } from './callbacks'
import { editorPage } from './page'
import { makeSession, readSession, type Session } from './session'

export type Integrator = {
  /** The issuer its open tokens name (`iss`). */
  iss: string
  /** Its keys: each bound to its tenant and to `iss`. */
  keys: OpenTokenKey[]
  /** Where its callbacks are (`{callbackUrl}/files/{file}`). */
  callbackUrl: string
  /** The secret callbacks are signed with (shared with the integrator). */
  secret: string
  /** Origins allowed to frame the editor (`frame-ancestors`). */
  origins: string[]
}

export type KitRoute = { id: string; path: string; extensions: string[] }

export type EmbedServerConfig = {
  /** The service's id: the `aud` its open tokens name. */
  id: string
  /** Signs sessions; at least 32 characters, never shared. */
  secret: string
  integrators: Integrator[]
  /** Which kit opens which files, by name extension; `path` is the kit package under `kitsUrl`. */
  kits: KitRoute[]
  /** Where kit packages are served: another origin than the service's (EM4). */
  kitsUrl: string
  /** `@kition/embed`'s built module directory (its `dist`); default: the installed `@kition/embed`'s. */
  embedDir?: string
  /** A session's life, seconds (default 8 hours). */
  sessionTtl?: number
  /** The largest document or replica a page may write, bytes (default 256 MiB). */
  maxBytes?: number
  fetch?: typeof fetch
  now?: () => number
}

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' }

/** The installed `@kition/embed`'s `dist` (its module is `dist/index.js`). */
function installedEmbedDir() {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@kition/embed')))
  } catch {
    throw new Error('@kition/embed is not installed next to @kition/embed-server: install it, or set embedDir')
  }
}

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function body(request: IncomingMessage, max: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > max) throw new Refusal(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export function createEmbedServer(config: EmbedServerConfig) {
  if (config.secret.length < 32) throw new Error('the session secret needs at least 32 characters')
  const kitsOrigin = new URL(config.kitsUrl).origin
  const call = config.fetch ?? fetch
  const now = config.now ?? (() => Math.floor(Date.now() / 1000))
  const maxBytes = config.maxBytes ?? 256 * 1024 * 1024
  const embedDir = config.embedDir ?? installedEmbedDir()
  const integrator = (iss: string) => config.integrators.find((candidate) => candidate.iss === iss)

  /** One signed callback for `session`'s file (`suffix`: '' or '/replica'). */
  async function callback(session: Session, method: string, suffix: string, payload: Uint8Array | null, headers: Record<string, string> = {}) {
    const target = integrator(session.iss)
    if (!target) throw new Refusal(401, 'unknown integrator')
    const url = new URL(`${target.callbackUrl.replace(/\/$/, '')}/files/${encodeURIComponent(session.file)}${suffix}`)
    const signed = callbackHeaders(target.secret, method, url.pathname + url.search, payload, { subject: session.sub, docKey: session.docKey }, now())
    return call(url, { method, headers: { ...headers, ...signed }, ...(payload ? { body: payload as BodyInit } : {}) })
  }

  async function open(token: string | null, response: ServerResponse) {
    if (!token) throw new Refusal(400, 'no token')
    let claims
    try {
      const target = integrator(decodeOpenToken(token).iss)
      if (!target) throw new OpenTokenError('unknown-key')
      claims = await verifyOpenToken(token, target.keys, config.id, now())
    } catch (error) {
      throw new Refusal(401, error instanceof OpenTokenError ? `open token refused: ${error.code}` : 'open token refused')
    }
    const target = integrator(claims.iss)!
    const probe: Session = { iss: claims.iss, tenant: claims.tenant, sub: claims.sub, name: claims.name, file: claims.file, version: claims.version, docKey: claims.doc_key, perms: claims.perms, watermark: claims.watermark, kit: '', exp: 0 }
    const head = await callback(probe, 'HEAD', '', null)
    if (head.status === 404) throw new Refusal(404, 'no such file')
    if (!head.ok) throw new Refusal(502, `the integrator answered ${head.status}`)
    const name = head.headers.get(NAME_HEADER) || claims.file
    const ext = extname(name).toLowerCase()
    const kit = config.kits.find((route) => route.extensions.includes(ext))
    if (!kit) throw new Refusal(415, `no kit opens ${ext || 'this file'}`)
    const session: Session = { ...probe, version: head.headers.get(VERSION_HEADER) ?? claims.version, kit: kit.id, exp: now() + (config.sessionTtl ?? 8 * 3600) }
    const nonce = randomBytes(16).toString('base64')
    const html = editorPage({ session: makeSession(config.secret, session), claims: session, kitUrl: new URL(kit.path, config.kitsUrl).href, embedModule: '/assets/embed/index.js', nonce, title: name })
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        `frame-src ${kitsOrigin}`,
        "img-src 'self' data: blob:",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${target.origins.length ? target.origins.join(' ') : "'none'"}`,
      ].join('; '),
    })
    response.end(html)
  }

  async function file(request: IncomingMessage, response: ServerResponse, path: string) {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    const session = readSession(config.secret, bearer, now())
    if (!session) throw new Refusal(401, 'no session')
    const writes = session.perms.edit || session.perms.comment
    if (request.method === 'GET' && path === '/v1/file') {
      const read = await callback(session, 'GET', '', null)
      if (!read.ok) throw new Refusal(read.status === 404 ? 404 : 502, `the integrator answered ${read.status}`)
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', [VERSION_HEADER]: read.headers.get(VERSION_HEADER) ?? '' })
      response.end(Buffer.from(await read.arrayBuffer()))
      return
    }
    if (request.method === 'GET' && path === '/v1/file/stamp') {
      const head = await callback(session, 'HEAD', '', null)
      if (head.status === 404) return json(response, 200, { version: null })
      if (!head.ok) throw new Refusal(502, `the integrator answered ${head.status}`)
      return json(response, 200, { version: head.headers.get(VERSION_HEADER) })
    }
    if (request.method === 'PUT' && (path === '/v1/file' || path === '/v1/replica')) {
      if (!writes) throw new Refusal(403, 'this session is read-only')
      const payload = await body(request, maxBytes)
      const replica = path === '/v1/replica'
      const headers: Record<string, string> = {}
      const match = request.headers['if-match']
      if (!replica && typeof match === 'string') headers['if-match'] = match
      const stamp = request.headers['x-kition-file-stamp']
      if (replica && typeof stamp === 'string') headers['x-kition-file-stamp'] = stamp
      const written = await callback(session, 'PUT', replica ? '/replica' : '', payload, headers)
      if (written.status === 409) {
        response.writeHead(409, { [VERSION_HEADER]: written.headers.get(VERSION_HEADER) ?? '' })
        response.end()
        return
      }
      if (replica && written.status === 501) throw new Refusal(501, 'the integrator keeps no replicas')
      if (!written.ok) throw new Refusal(502, `the integrator answered ${written.status}`)
      const answer = replica ? {} : ((await written.json().catch(() => ({}))) as { version?: unknown })
      if (!replica && typeof (answer as { version?: unknown }).version !== 'string') throw new Refusal(502, 'the integrator answered no version')
      return json(response, 200, replica ? {} : { version: (answer as { version: string }).version })
    }
    if (request.method === 'GET' && path === '/v1/replica') {
      const read = await callback(session, 'GET', '/replica', null)
      if (read.status === 404 || read.status === 501) throw new Refusal(read.status, 'no replica')
      if (!read.ok) throw new Refusal(502, `the integrator answered ${read.status}`)
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-kition-file-stamp': read.headers.get('x-kition-file-stamp') ?? '' })
      response.end(Buffer.from(await read.arrayBuffer()))
      return
    }
    throw new Refusal(404, 'not found')
  }

  async function asset(path: string, response: ServerResponse) {
    const relative = normalize(decodeURIComponent(path.slice('/assets/embed/'.length)))
    if (relative.startsWith('..') || relative.includes(`${sep}..`) || relative.startsWith(sep)) throw new Refusal(404, 'not found')
    const bytes = await readFile(join(embedDir, relative)).catch(() => null)
    if (!bytes) throw new Refusal(404, 'not found')
    response.writeHead(200, { 'content-type': TYPES[extname(relative)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=300' })
    response.end(bytes)
  }

  return async function handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? '/', 'http://service')
      if (request.method === 'GET' && url.pathname === '/v1/open') return await open(url.searchParams.get('token'), response)
      if (url.pathname.startsWith('/v1/')) return await file(request, response, url.pathname)
      if (request.method === 'GET' && url.pathname.startsWith('/assets/embed/')) return await asset(url.pathname, response)
      throw new Refusal(404, 'not found')
    } catch (error) {
      const status = error instanceof Refusal ? error.status : 500
      if (!(error instanceof Refusal)) console.error('[kition-embed-server]', error)
      if (!response.headersSent) json(response, status, { error: error instanceof Refusal ? error.message : 'failed' })
      else response.end()
    }
  }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
