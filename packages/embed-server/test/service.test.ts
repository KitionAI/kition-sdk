/**
 * The embed server against a fake integrator (an HTTP server keeping files in memory and
 * checking every callback's signature): open tokens, sessions, permissions, and signed callbacks.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signOpenToken, type OpenPerms } from '@kition/sync/openToken'
import { startEmbedServer, verifyCallback } from '../src/index'
import { makeSession, readSession } from '../src/session'
import { signCallback } from '../src/callbacks'

// Test-only value shared by the fake integrator and service.
const SECRET = 'integrator-secret'
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

type Stored = { bytes: Uint8Array; version: number; name: string }

/** A fake integrator: files in memory; every callback must verify, or it answers 401. */
async function integrator() {
  const files = new Map<string, Stored>([['res-1', { bytes: new TextEncoder().encode('hello'), version: 1, name: 'Plan.md' }]])
  const replicas = new Map<string, { body: Uint8Array; stamp: string }>()
  const seen: Array<{ method: string; path: string; subject: string; docKey: string; ifMatch?: string }> = []
  const read = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return new Uint8Array(Buffer.concat(chunks))
  }
  const server: Server = createServer(async (request, response) => {
    const body = await read(request)
    const path = request.url ?? '/'
    if (!verifyCallback(SECRET, { method: request.method ?? 'GET', path, headers: request.headers, body })) {
      response.writeHead(401).end()
      return
    }
    seen.push({ method: request.method!, path, subject: String(request.headers['x-kition-subject']), docKey: String(request.headers['x-kition-doc-key']), ...(request.headers['if-match'] ? { ifMatch: String(request.headers['if-match']) } : {}) })
    const match = /^\/cb\/files\/([^/]+)(\/replica)?$/.exec(path)
    const file = match ? files.get(decodeURIComponent(match[1]!)) : undefined
    if (!match || !file) {
      response.writeHead(404).end()
      return
    }
    const id = decodeURIComponent(match[1]!)
    if (match[2]) {
      if (request.method === 'PUT') {
        replicas.set(id, { body, stamp: String(request.headers['x-kition-file-stamp']) })
        response.writeHead(200).end()
      } else {
        const kept = replicas.get(id)
        if (!kept) response.writeHead(404).end()
        else response.writeHead(200, { 'x-kition-file-stamp': kept.stamp }).end(Buffer.from(kept.body))
      }
      return
    }
    const headers = { 'x-kition-version': `v${file.version}`, 'x-kition-name': file.name }
    if (request.method === 'HEAD') return void response.writeHead(200, headers).end()
    if (request.method === 'GET') return void response.writeHead(200, headers).end(Buffer.from(file.bytes))
    if (request.method === 'PUT') {
      if (request.headers['if-match'] !== `v${file.version}`) return void response.writeHead(409, headers).end()
      files.set(id, { ...file, bytes: body, version: file.version + 1 })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: `v${file.version + 1}` }))
      return
    }
    response.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(resolve)))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/cb`, files, replicas, seen }
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  return { privateKey: pair.privateKey, publicKey: raw }
}

const EDIT: OpenPerms = { edit: true, comment: true, download: true, share: false, export: true }
const VIEW: OpenPerms = { edit: false, comment: false, download: false, share: false, export: false }

async function setUp() {
  const fake = await integrator()
  const key = await keyPair()
  const embedDir = await mkdtemp(join(tmpdir(), 'kition-embed-'))
  await writeFile(join(embedDir, 'index.js'), 'export const KitionEmbed = {}')
  const service = await startEmbedServer({
    id: 'docs-test',
    secret: 'a'.repeat(32),
    integrators: [{ iss: 'acme.app', keys: [{ kid: 'k1', publicKey: key.publicKey, tenant: 'acme', iss: 'acme.app' }], callbackUrl: fake.url, secret: SECRET, origins: ['https://app.acme.test'] }],
    kits: [{ id: 'kit.note', path: 'note-ui/', extensions: ['.md'] }],
    kitsUrl: 'http://127.0.0.1:1/',
    embedDir,
  })
  closers.push(service.close)
  const token = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return signOpenToken({ iss: 'acme.app', aud: 'docs-test', tenant: 'acme', sub: 'u-ann', name: 'Ann', file: 'res-1', version: 'v1', doc_key: 'g1', perms: EDIT, watermark: { text: 'Ann · Acme' }, iat: now, exp: now + 300, ...overrides } as never, 'k1', key.privateKey)
  }
  /** Opens the editor page; answers the page and the session it carries. */
  const open = async (tokenText: string) => {
    const response = await fetch(`${service.url}/v1/open?token=${encodeURIComponent(tokenText)}`)
    const html = await response.text()
    const config = /<script type="application\/json" id="kition-config">(.*?)<\/script>/s.exec(html)?.[1]
    return { response, html, config: config ? (JSON.parse(config) as { session: string; kit: { id: string; url: string }; mode: string; display: unknown; user: unknown; file: unknown }) : null }
  }
  return { service, fake, token, open, key }
}

describe('the embed server (URL embedding, L8)', () => {
  it('opens the editor page for a valid open token, with a session and the token`s permissions', async () => {
    const { open, token, fake } = await setUp()
    const page = await open(await token())
    expect(page.response.status).toBe(200)
    const csp = page.response.headers.get('content-security-policy')!
    expect(csp).toContain("frame-ancestors https://app.acme.test")
    expect(csp).toContain('frame-src http://127.0.0.1:1')
    expect(page.response.headers.get('cache-control')).toBe('no-store')
    expect(page.config).toMatchObject({ kit: { id: 'kit.note', url: 'http://127.0.0.1:1/note-ui/' }, mode: 'edit', file: { id: 'res-1', name: 'Plan.md' }, user: { id: 'u-ann', name: 'Ann' }, display: { permissions: { download: true, export: true, share: false }, watermark: { text: 'Ann · Acme' } } })
    expect(page.html).not.toContain('ko1.')
    expect(fake.seen[0]).toMatchObject({ method: 'HEAD', subject: 'u-ann', docKey: 'g1' })
  })

  it('refuses forged, expired, misaddressed and unknown tokens', async () => {
    const { open, token } = await setUp()
    const good = await token()
    const forged = `${good.slice(0, good.lastIndexOf('.'))}.${Buffer.alloc(64).toString('base64url')}`
    expect((await open(forged)).response.status).toBe(401)
    const now = Math.floor(Date.now() / 1000)
    expect((await open(await token({ iat: now - 400, exp: now - 100 }))).response.status).toBe(401)
    expect((await open(await token({ aud: 'another-service' }))).response.status).toBe(401)
    expect((await open(await token({ iss: 'other.app' }))).response.status).toBe(401)
    expect((await open('not-a-token')).response.status).toBe(401)
    expect((await fetch(`${(await setUp()).service.url}/v1/open`)).status).toBe(400)
  })

  it('reads and writes the file through signed callbacks, conditionally', async () => {
    const { open, token, fake, service } = await setUp()
    const { config } = await open(await token())
    const auth = { authorization: `Bearer ${config!.session}` }
    const read = await fetch(`${service.url}/v1/file`, { headers: auth })
    expect(read.headers.get('x-kition-version')).toBe('v1')
    expect(await read.text()).toBe('hello')
    expect(await (await fetch(`${service.url}/v1/file/stamp`, { headers: auth })).json()).toEqual({ version: 'v1' })
    const written = await fetch(`${service.url}/v1/file`, { method: 'PUT', headers: { ...auth, 'if-match': 'v1' }, body: 'hello there' })
    expect(await written.json()).toEqual({ version: 'v2' })
    expect(new TextDecoder().decode(fake.files.get('res-1')!.bytes)).toBe('hello there')
    expect(fake.seen.at(-1)).toMatchObject({ method: 'PUT', ifMatch: 'v1', subject: 'u-ann', docKey: 'g1' })
    const stale = await fetch(`${service.url}/v1/file`, { method: 'PUT', headers: { ...auth, 'if-match': 'v1' }, body: 'lost?' })
    expect(stale.status).toBe(409)
    expect(stale.headers.get('x-kition-version')).toBe('v2')
    expect(new TextDecoder().decode(fake.files.get('res-1')!.bytes)).toBe('hello there')
    // The replica, kept next to the file by the integrator.
    expect((await fetch(`${service.url}/v1/replica`, { headers: auth })).status).toBe(404)
    await fetch(`${service.url}/v1/replica`, { method: 'PUT', headers: { ...auth, 'x-kition-file-stamp': 'v2' }, body: new Uint8Array([0, 0, 0, 1, 9, 8]) })
    const replica = await fetch(`${service.url}/v1/replica`, { headers: auth })
    expect(replica.headers.get('x-kition-file-stamp')).toBe('v2')
    expect([...new Uint8Array(await replica.arrayBuffer())]).toEqual([0, 0, 0, 1, 9, 8])
  })

  it('keeps a viewer`s session read-only, and refuses calls without a valid session', async () => {
    const { open, token, service, fake } = await setUp()
    const { config } = await open(await token({ perms: VIEW, watermark: null }))
    expect(config!.mode).toBe('view')
    const auth = { authorization: `Bearer ${config!.session}` }
    expect((await fetch(`${service.url}/v1/file`, { headers: auth })).status).toBe(200)
    expect((await fetch(`${service.url}/v1/file`, { method: 'PUT', headers: { ...auth, 'if-match': 'v1' }, body: 'x' })).status).toBe(403)
    expect(fake.files.get('res-1')!.version).toBe(1)
    expect((await fetch(`${service.url}/v1/file`)).status).toBe(401)
    const tampered = config!.session.replace(/\.[^.]+$/, `.${Buffer.alloc(32).toString('base64url')}`)
    expect((await fetch(`${service.url}/v1/file`, { headers: { authorization: `Bearer ${tampered}` } })).status).toBe(401)
  })

  it('serves the embed module, and nothing outside its directory', async () => {
    const { service } = await setUp()
    const module = await fetch(`${service.url}/assets/embed/index.js`)
    expect(module.headers.get('content-type')).toContain('javascript')
    expect(await module.text()).toContain('KitionEmbed')
    expect((await fetch(`${service.url}/assets/embed/%2e%2e/%2e%2e/package.json`)).status).toBe(404)
  })
})

describe('sessions and callback signatures', () => {
  const session = { iss: 'a', tenant: 'acme', sub: 's', name: 'S', file: 'f', version: 'v1', docKey: 'g', perms: EDIT, watermark: null, kit: 'kit.note', exp: 2_000 }

  it('reads back its own sessions until they expire, and nothing else', () => {
    const token = makeSession('x'.repeat(32), session)
    expect(readSession('x'.repeat(32), token, 1_000)).toEqual(session)
    expect(readSession('x'.repeat(32), token, 2_000)).toBeNull()
    expect(readSession('y'.repeat(32), token, 1_000)).toBeNull()
    const [, segment, mac] = token.split('.')
    const edited = Buffer.from(JSON.stringify({ ...session, perms: { ...EDIT, share: true } })).toString('base64url')
    expect(readSession('x'.repeat(32), `kds1.${edited}.${mac}`, 1_000)).toBeNull()
    expect(segment).toBeTruthy()
  })

  it('verifies a callback only with its secret, body, path and a fresh timestamp', () => {
    const body = new TextEncoder().encode('bytes')
    const headers = { 'x-kition-timestamp': '1000', 'x-kition-signature': signCallback(SECRET, 'PUT', '/cb/files/f', 1000, body) }
    expect(verifyCallback(SECRET, { method: 'PUT', path: '/cb/files/f', headers, body }, 1100)).toBe(true)
    expect(verifyCallback('other', { method: 'PUT', path: '/cb/files/f', headers, body }, 1100)).toBe(false)
    expect(verifyCallback(SECRET, { method: 'PUT', path: '/cb/files/g', headers, body }, 1100)).toBe(false)
    expect(verifyCallback(SECRET, { method: 'PUT', path: '/cb/files/f', headers, body: new Uint8Array([1]) }, 1100)).toBe(false)
    expect(verifyCallback(SECRET, { method: 'PUT', path: '/cb/files/f', headers, body }, 1400)).toBe(false)
  })
})
