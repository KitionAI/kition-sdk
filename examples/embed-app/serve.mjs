#!/usr/bin/env node
/**
 * Runs the example integrator page and the kit packages it embeds on two origins, as a real
 * deployment would: the page (Vite) on 127.0.0.1:EMBED_APP_PORT (5310), and the kit packages from
 * KITION_KITS_DIR (default: the sibling Kition checkout's public/kits) on 127.0.0.1:EMBED_KITS_PORT
 * (5311). The page embeds the Note kit, whose package is note-ui/ there.
 *
 * The kit origin serves its packages with the policy the Kit UI protocol asks for (UI-H3): their
 * own scripts and workers, 'wasm-unsafe-eval', nothing from other origins, and only the page's
 * origin may frame them. Build @kition/embed first (`pnpm example:embed` does).
 *
 * With EMBED_WORKSPACE set to a folder, the page keeps its files there (workspace.mjs) instead of
 * in the browser, so an agent can edit the same files over MCP (examples/agent-mcp), headless on the
 * folder or, through agent-relay.mjs, in the editor the person has open (`editor.agentPort`).
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { workspaceFiles } from './workspace.mjs'
import { syncTokens } from './sync-tokens.mjs'

const { agentRelays } = process.env.EMBED_WORKSPACE ? await import('./agent-relay.mjs') : {}

const here = path.dirname(fileURLToPath(import.meta.url))
const sdkRoot = path.resolve(here, '..', '..')
const kitsDir = path.resolve(sdkRoot, process.env.KITION_KITS_DIR || path.join('..', 'kition', 'public', 'kits'))
const host = '127.0.0.1'
const appPort = Number(process.env.EMBED_APP_PORT || 5310)
const kitsPort = Number(process.env.EMBED_KITS_PORT || 5311)
const appOrigin = `http://${host}:${appPort}`
const kitsOrigin = `http://${host}:${kitsPort}`
const workspace = process.env.EMBED_WORKSPACE ? path.resolve(process.env.EMBED_WORKSPACE) : null

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** UI-H3: the kit's own scripts, workers, and WebAssembly; nothing from elsewhere; framed only by the page. */
const KIT_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  `frame-ancestors ${appOrigin}`,
].join('; ')

function serveKits() {
  if (!existsSync(kitsDir)) {
    console.error(`No kit packages at ${kitsDir}: set KITION_KITS_DIR to a folder holding the Note kit's package (note-ui/).`)
    process.exit(1)
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', kitsOrigin)
    let file = path.join(kitsDir, decodeURIComponent(url.pathname))
    if (!file.startsWith(kitsDir + path.sep)) {
      response.writeHead(403).end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'content-security-policy': KIT_POLICY,
      // The packages are public: any page may fetch them (a kit's own requests are same-origin).
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => server.listen(kitsPort, host, () => resolve(server)))
}

/**
 * The page's own policy (E5): kit frames only from the kit origin; sockets to any sync server the
 * person types (and Vite's own); WebAssembly for the relay's version handling (Loro, inlined in
 * @kition/embed); inline styles for Vite's CSS injection in development.
 */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `frame-src ${kitsOrigin}`,
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

await serveKits()
const app = await createServer({
  configFile: path.join(here, 'vite.config.ts'),
  define: {
    __KITS_ORIGIN__: JSON.stringify(kitsOrigin),
    __WORKSPACE__: JSON.stringify(Boolean(workspace)),
  },
  plugins: [
    // Per-user sync tokens for co-editing through Kition Server or Kition Cloud (docs/sdk/collab.md), when configured.
    ...(process.env.KITION_SYNC_EXCHANGE || process.env.KITION_SYNC_TENANT ? [syncTokens()] : []),
    ...(workspace
      ? [
          {
            name: 'workspace-files',
            configureServer: (server) => {
              server.middlewares.use('/api/files', workspaceFiles(workspace))
              server.middlewares.use('/api/agent', agentRelays())
            },
          },
        ]
      : []),
  ],
  server: { host, port: appPort, strictPort: true, headers: { 'content-security-policy': PAGE_POLICY } },
})
await app.listen()
console.log(`kit packages: ${kitsOrigin}/ (from ${path.relative(sdkRoot, kitsDir) || kitsDir})`)
console.log(`embed example: ${appOrigin}/`)
if (workspace) console.log(`files: ${workspace}`)
