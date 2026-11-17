/**
 * The example's server-side storage: the files of one folder (EMBED_WORKSPACE) behind a small
 * HTTP API, so the page edits the same files an agent edits over MCP (`examples/agent-mcp`).
 * Versions count the contents a file has had: a change on disk (an agent's save) is a new
 * version, and a write over a version that moved on is refused with 409, as `@kition/embed`'s
 * `StorageProvider` expects.
 *
 *   GET    /api/files                 [{ name, version, size }]
 *   GET    /api/files/<name>          the bytes; `x-file-version`
 *   GET    /api/files/<name>?stamp    { version } (null when there is no such file)
 *   PUT    /api/files/<name>          write; `x-expected-version: <n>` or `none` (create only); { version } or 409 { version }
 *   DELETE /api/files/<name>
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function workspaceFiles(folder) {
  const root = path.resolve(folder)
  mkdirSync(root, { recursive: true })
  /** name → the last contents seen (hash) and their version. */
  const seen = new Map()

  const fileOf = (name) => {
    if (!name || name !== path.basename(name) || name.startsWith('.')) return null
    return path.join(root, name)
  }
  const current = (name) => {
    const file = fileOf(name)
    if (!file || !existsSync(file) || !statSync(file).isFile()) return null
    const bytes = readFileSync(file)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const last = seen.get(name)
    const version = !last ? 1 : last.hash === hash ? last.version : last.version + 1
    seen.set(name, { hash, version })
    return { bytes, version }
  }
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const body = (request) =>
    new Promise((resolve, reject) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })

  /** Connect-style middleware mounted at `/api/files`. */
  return async (request, response, next) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!name) {
        if (request.method !== 'GET') return json(response, 405, { error: 'method' })
        const names = readdirSync(root).filter((entry) => fileOf(entry) && statSync(path.join(root, entry)).isFile())
        return json(response, 200, names.sort().flatMap((entry) => {
          const file = current(entry)
          return file ? [{ name: entry, version: file.version, size: file.bytes.byteLength }] : []
        }))
      }
      const file = fileOf(name)
      if (!file) return json(response, 400, { error: 'name' })
      if (request.method === 'GET') {
        const found = current(name)
        if (url.searchParams.has('stamp')) return json(response, 200, { version: found?.version ?? null })
        if (!found) return json(response, 404, { error: 'not-found' })
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-file-version': String(found.version), 'cache-control': 'no-store' })
        return response.end(found.bytes)
      }
      if (request.method === 'PUT') {
        const expected = request.headers['x-expected-version']
        const found = current(name)
        if (expected === 'none' ? found : expected !== undefined && String(found?.version ?? '') !== expected) {
          return json(response, 409, { version: found?.version ?? null })
        }
        const bytes = await body(request)
        const scratch = path.join(root, `.${name}.${process.pid}.writing`)
        writeFileSync(scratch, bytes)
        renameSync(scratch, file)
        const hash = createHash('sha256').update(bytes).digest('hex')
        const last = seen.get(name)
        const version = !last ? 1 : last.hash === hash ? last.version : last.version + 1
        seen.set(name, { hash, version })
        return json(response, 200, { version })
      }
      if (request.method === 'DELETE') {
        rmSync(file, { force: true })
        seen.delete(name)
        return json(response, 200, {})
      }
      return json(response, 405, { error: 'method' })
    } catch (error) {
      next(error)
    }
  }
}
