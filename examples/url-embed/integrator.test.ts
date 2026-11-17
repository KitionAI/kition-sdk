/**
 * The example integration against the embed server in-process: the iframe URL it mints opens
 * the editor page, and the page's file calls reach its store through verified callbacks.
 */
import http from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { signOpenToken } from '../../packages/sync/src/openToken'
import { startEmbedServer, verifyCallback } from '../../packages/embed-server/src/index'
import { createIntegrator } from './integrator.mjs'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

it('mints an iframe URL the embed server opens, and saves through the integrator`s callbacks', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  const integratorServer = http.createServer((request, response) => void integrator.handle(request, response))
  await new Promise<void>((resolve) => integratorServer.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => integratorServer.close(resolve)))
  const integratorUrl = `http://127.0.0.1:${(integratorServer.address() as { port: number }).port}`
  const embedDir = await mkdtemp(join(tmpdir(), 'kition-embed-'))
  await writeFile(join(embedDir, 'index.js'), 'export {}')
  const service = await startEmbedServer({
    id: 'docs-example',
    secret: 's'.repeat(40),
    integrators: [{ iss: 'example.app', keys: [{ kid: 'example-1', publicKey, tenant: 'example', iss: 'example.app' }], callbackUrl: `${integratorUrl}/cb`, secret: 'shared', origins: [integratorUrl] }],
    kits: [{ id: 'kit.note', path: 'note-ui/', extensions: ['.md'] }],
    kitsUrl: 'http://127.0.0.1:9/',
    embedDir,
  })
  closers.push(service.close)
  const integrator = createIntegrator({ signOpenToken, verifyCallback, privateKey: pair.privateKey, kid: 'example-1', iss: 'example.app', tenant: 'example', secret: 'shared', embedServerUrl: service.url, embedServerId: 'docs-example' })

  const pageHtml = await (await fetch(`${integratorUrl}/`)).text()
  const src = /<iframe src="([^"]+)"/.exec(pageHtml)![1]!.replace(/&quot;/g, '"')
  const editor = await fetch(src)
  expect(editor.status).toBe(200)
  const session = JSON.parse(/id="kition-config">(.*?)<\/script>/s.exec(await editor.text())![1]!).session as string
  const auth = { authorization: `Bearer ${session}` }
  expect(await (await fetch(`${service.url}/v1/file`, { headers: auth })).text()).toContain('# Welcome')
  const saved = await fetch(`${service.url}/v1/file`, { method: 'PUT', headers: { ...auth, 'if-match': 'v1' }, body: '# Edited' })
  expect(await saved.json()).toEqual({ version: 'v2' })
  expect(new TextDecoder().decode(integrator.store.files.get('welcome')!.bytes)).toBe('# Edited')
  // A new generation of the file (an upload elsewhere) refuses the old session's writes.
  integrator.store.files.get('welcome')!.generation += 1
  expect((await fetch(`${service.url}/v1/file`, { method: 'PUT', headers: { ...auth, 'if-match': 'v2' }, body: 'stale' })).status).toBe(409)
  // The view-only link opens read-only.
  const viewHtml = await (await fetch(`${integratorUrl}/?view=1`)).text()
  const viewSrc = /<iframe src="([^"]+)"/.exec(viewHtml)![1]!.replace(/&quot;/g, '"')
  const viewConfig = JSON.parse(/id="kition-config">(.*?)<\/script>/s.exec(await (await fetch(viewSrc)).text())![1]!)
  expect(viewConfig.mode).toBe('view')
  expect(viewConfig.display.watermark).toEqual({ text: 'Example User · view only' })
})
