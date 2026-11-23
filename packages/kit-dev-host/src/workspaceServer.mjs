/**
 * The development host's workspace over HTTP, as Kition lends a project's folder (UI protocol
 * `document.lend`): a Vite plugin whose middleware keeps the files the dev page puts (PUT) and
 * answers the engine's ranged reads (GET, HEAD with `Range`) of them. A kit adds
 * `devHostWorkspace()` to its Vite config and passes `lend: true` to `startDevHost`; the page
 * mirrors its in-memory workspace here, one session per page load (a capability path, never a
 * view of another page's workspace).
 *
 * The engine reads lent files with synchronous XMLHttpRequests from its worker, which no service
 * worker reliably answers in every browser, and a service worker's script would have to be served
 * from the site's root anyway; so the dev server serves them, as Kition's own host does.
 *
 * Node only (Vite's dev and preview servers). It imports nothing from Vite.
 */

/** Where the middleware is mounted, from the site's root; `startDevHost` lends `<this>/<session>/`. */
export const WORKSPACE_PATH = '/__kition-dev-workspace'

/** How many page loads' workspaces the server keeps; the oldest goes first. */
export const KEPT_SESSIONS = 8

/** The workspace path a request names below the mount, split into its session and file path; `null` for one above it or hidden (LR2). */
export function workspaceTarget(url) {
  let decoded
  try {
    decoded = (url ?? '/').split('?')[0].split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
  const [session, ...parts] = decoded
  if (!session || !parts.length || parts.some((part) => part === '..' || part === '.' || part.startsWith('.') || part.includes('/'))) return null
  return { session, path: parts.join('/') }
}

/**
 * `bytes=<first>-<last>`, `bytes=<first>-` or `bytes=-<suffix>` of a file of `size` bytes, as
 * `[start, end)`; `null` without a Range header, `'unsatisfiable'` for a range past the end.
 */
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = Math.min(Number(match[2]), size)
    return suffix > 0 ? [size - suffix, size] : 'unsatisfiable'
  }
  const start = Number(match[1])
  if (start >= size) return 'unsatisfiable'
  const end = match[2] ? Math.min(Number(match[2]) + 1, size) : size
  return end > start ? [start, end] : 'unsatisfiable'
}

/**
 * The middleware (Connect's `(request, response, next)`, mounted at WORKSPACE_PATH, so
 * `request.url` is below it): PUT keeps a file (its version from the `X-Kition-Version` header),
 * DELETE drops it, GET and HEAD answer it with ranges, an ETag and no caching.
 */
export function workspaceMiddleware() {
  /** session → path → { bytes, version } */
  const sessions = new Map()
  return (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, ETag, Accept-Ranges')
    response.setHeader('Cache-Control', 'no-store')
    const end = (status) => {
      response.statusCode = status
      response.end()
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Range')
      return end(204)
    }
    const target = workspaceTarget(request.url)
    if (!target) return end(request.method === 'GET' || request.method === 'HEAD' ? 403 : 400)
    if (request.method === 'PUT') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        let files = sessions.get(target.session)
        if (!files) {
          files = new Map()
          sessions.set(target.session, files)
          for (const oldest of sessions.keys()) {
            if (sessions.size <= KEPT_SESSIONS) break
            sessions.delete(oldest)
          }
        }
        files.set(target.path, { bytes: Buffer.concat(chunks), version: String(request.headers['x-kition-version'] ?? '1') })
        end(204)
      })
      return undefined
    }
    if (request.method === 'DELETE') {
      sessions.get(target.session)?.delete(target.path)
      return end(204)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return end(405)
    const file = sessions.get(target.session)?.get(target.path)
    if (!file) return end(404)
    const size = file.bytes.length
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('ETag', `"${file.version}"`)
    const range = byteRange(request.headers.range, size)
    if (range === 'unsatisfiable') {
      response.setHeader('Content-Range', `bytes */${size}`)
      return end(416)
    }
    const [start, stop] = range ?? [0, size]
    response.statusCode = range ? 206 : 200
    response.setHeader('Content-Length', String(stop - start))
    if (range) response.setHeader('Content-Range', `bytes ${start}-${stop - 1}/${size}`)
    response.end(request.method === 'HEAD' ? undefined : file.bytes.subarray(start, stop))
    return undefined
  }
}

/**
 * The Vite plugin: serves the dev host's workspace at WORKSPACE_PATH on the dev server and on
 * `vite preview`.
 *
 * @returns {{ name: string, configureServer: (server: { middlewares: { use: (path: string, handler: unknown) => void } }) => void, configurePreviewServer: (server: { middlewares: { use: (path: string, handler: unknown) => void } }) => void }}
 */
export function devHostWorkspace() {
  const handler = workspaceMiddleware()
  return {
    name: 'kition-dev-host-workspace',
    configureServer(server) {
      server.middlewares.use(WORKSPACE_PATH, handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(WORKSPACE_PATH, handler)
    },
  }
}
