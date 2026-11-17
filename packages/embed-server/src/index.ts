/**
 * `@kition/embed-server`: the embed server for URL embedding (docs/platform/url-embedding.md,
 * docs/sdk/url.md). `createEmbedServer` answers a Node `http` handler; `startEmbedServer` listens,
 * and serves kit packages from a directory on a second port when asked.
 */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { createEmbedServer, type EmbedServerConfig } from './server'

export { createEmbedServer, type EmbedServerConfig, type Integrator, type KitRoute } from './server'
export { callbackHeaders, signCallback, verifyCallback, CALLBACK_SKEW_SECS } from './callbacks'
export { makeSession, readSession, type Session } from './session'

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve((server.address() as { port: number }).port))
  })

/**
 * Listens on `port` (0: any free one). With `kitsDir`, also serves the kit packages there on
 * `kitsPort`, another origin, and `kitsUrl` defaults to it.
 */
export async function startEmbedServer(config: Omit<EmbedServerConfig, 'kitsUrl'> & { kitsUrl?: string; port?: number; host?: string; kitsDir?: string; kitsPort?: number }) {
  const host = config.host ?? '127.0.0.1'
  let kits: Server | null = null
  let kitsUrl = config.kitsUrl
  if (config.kitsDir) {
    const dir = config.kitsDir
    kits = createServer(async (request, response) => {
      const relative = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://kits').pathname)).replace(/^[/\\]+/, '')
      const bytes = relative.startsWith('..') || relative.includes(`${sep}..`) ? null : await readFile(join(dir, relative.endsWith(sep) || !relative ? join(relative, 'index.html') : relative)).catch(() => null)
      if (!bytes) {
        response.writeHead(404).end()
        return
      }
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(relative) || '.html']
      response.writeHead(200, { 'content-type': type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' })
      response.end(bytes)
    })
    const port = await listen(kits, config.kitsPort ?? 0, host)
    kitsUrl ??= `http://${host}:${port}/`
  }
  if (!kitsUrl) throw new Error('kitsUrl or kitsDir is needed')
  const server = createServer(createEmbedServer({ ...config, kitsUrl }))
  const port = await listen(server, config.port ?? 0, host)
  return {
    url: `http://${host}:${port}`,
    kitsUrl,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      if (kits) await new Promise((resolve) => kits!.close(resolve))
    },
  }
}
