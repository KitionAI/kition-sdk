#!/usr/bin/env node
/**
 * URL embedding, end to end on one machine (docs/sdk/url.md): an integrator on
 * 127.0.0.1:URL_EMBED_PORT (5320) whose page frames the embed server on :5321, which serves
 * the editor page and loads the kit packages from KITION_KITS_DIR (default: the sibling Kition
 * checkout's public/kits) on :5322, another origin. Build @kition/embed first
 * (`pnpm --filter @kition/embed build`); its dist is the editor page's module.
 *
 * Run: node examples/url-embed/serve.mjs, then open http://127.0.0.1:5320/.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import { createIntegrator } from './integrator.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdkRoot = path.resolve(here, '..', '..')
const host = '127.0.0.1'
const port = Number(process.env.URL_EMBED_PORT || 5320)

// The SDK's TypeScript sources, loaded through Vite (as the other examples do).
const vite = await createVite({ root: sdkRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, entries: [] } })
const { signOpenToken } = await vite.ssrLoadModule('/packages/sync/src/openToken.ts')
const { startEmbedServer, verifyCallback } = await vite.ssrLoadModule('/packages/embed-server/src/index.ts')

// The integrator's signing key, made fresh for this run; the embed server trusts its public half.
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
const secret = crypto.randomUUID() + crypto.randomUUID()
const integratorUrl = `http://${host}:${port}`

const service = await startEmbedServer({
  id: 'docs-example',
  secret: crypto.randomUUID() + crypto.randomUUID(),
  integrators: [{ iss: 'example.app', keys: [{ kid: 'example-1', publicKey, tenant: 'example', iss: 'example.app' }], callbackUrl: `${integratorUrl}/cb`, secret, origins: [integratorUrl] }],
  kits: [{ id: 'kit.note', path: 'note-ui/', extensions: ['.md'] }],
  kitsDir: path.resolve(sdkRoot, process.env.KITION_KITS_DIR || path.join('..', 'kition', 'public', 'kits')),
  embedDir: path.join(sdkRoot, 'packages', 'embed', 'dist'),
  port: port + 1,
  kitsPort: port + 2,
  host,
})

const integrator = createIntegrator({ signOpenToken, verifyCallback, privateKey: pair.privateKey, kid: 'example-1', iss: 'example.app', tenant: 'example', secret, embedServerUrl: service.url, embedServerId: 'docs-example' })
http.createServer(integrator.handle).listen(port, host, () => {
  console.log(`integrator page:   ${integratorUrl}/`)
  console.log(`embed server:      ${service.url}`)
  console.log(`kit packages:      ${service.kitsUrl}`)
})
