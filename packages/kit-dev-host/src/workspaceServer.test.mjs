import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEPT_SESSIONS, WORKSPACE_PATH, byteRange, devHostWorkspace, workspaceTarget } from './workspaceServer.mjs'

/** A server with the plugin's middleware, mounted as Vite's Connect mounts it (the prefix cut from the URL). */
let server
let base
beforeAll(async () => {
  const mounts = []
  const fake = { middlewares: { use: (path, handler) => mounts.push({ path, handler }) } }
  const plugin = devHostWorkspace()
  plugin.configureServer(fake)
  plugin.configurePreviewServer(fake)
  expect(WORKSPACE_PATH, 'the page and the plugin (workspace.test.ts) name the same path').toBe('/__kition-dev-workspace')
  expect(mounts.map((mount) => mount.path)).toEqual([WORKSPACE_PATH, WORKSPACE_PATH])
  expect(mounts[0].handler, 'the dev and preview servers share one workspace').toBe(mounts[1].handler)
  server = http.createServer((request, response) => {
    if (!request.url.startsWith(`${WORKSPACE_PATH}/`)) {
      response.statusCode = 418
      return response.end()
    }
    request.url = request.url.slice(WORKSPACE_PATH.length)
    mounts[0].handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}${WORKSPACE_PATH}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

const put = (path, body, version = '1') => fetch(`${base}/${path}`, { method: 'PUT', body, headers: { 'X-Kition-Version': version } })

describe('devHostWorkspace', () => {
  it('keeps what the page puts and answers ranged reads of it, as a lent folder does', async () => {
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, index) => index))
    expect((await put('s1/clips/My%20clip.mp4', bytes, '3')).status).toBe(204)
    const whole = await fetch(`${base}/s1/clips/My%20clip.mp4`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('etag')).toBe('"3"')
    expect(whole.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes)
    const head = await fetch(`${base}/s1/clips/My%20clip.mp4`, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('100')
    expect(head.headers.get('accept-ranges')).toBe('bytes')
    const part = await fetch(`${base}/s1/clips/My%20clip.mp4`, { headers: { Range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    const past = await fetch(`${base}/s1/clips/My%20clip.mp4`, { headers: { Range: 'bytes=100-' } })
    expect(past.status).toBe(416)
    expect((await fetch(`${base}/s1/clips/missing.mp4`)).status).toBe(404)
    expect((await fetch(`${base}/s2/clips/My%20clip.mp4`)).status, 'another page load sees none of it').toBe(404)
    expect((await fetch(`${base}/s1/clips/My%20clip.mp4`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${base}/s1/clips/My%20clip.mp4`)).status).toBe(404)
  })

  it('refuses hidden paths and paths above the workspace (LR2, H3)', async () => {
    expect((await put('s1/.secret', 'x')).status).toBe(400)
    expect((await fetch(`${base}/s1/.git/config`)).status).toBe(403)
    // fetch resolves `..` before it sends; a client that does not is refused.
    expect(workspaceTarget('/s1/a/%2E%2E/b')).toBeNull()
    expect((await fetch(`${base}/s1/a%2Fb`)).status).toBe(403)
    expect(workspaceTarget('/s1')).toBeNull()
    expect(workspaceTarget('/s1/a/b.png?x=1')).toEqual({ session: 's1', path: 'a/b.png' })
  })

  it('keeps the last page loads only', async () => {
    for (let index = 0; index <= KEPT_SESSIONS; index += 1) await put(`load-${index}/a.txt`, 'a')
    expect((await fetch(`${base}/load-0/a.txt`)).status).toBe(404)
    expect((await fetch(`${base}/load-${KEPT_SESSIONS}/a.txt`)).status).toBe(200)
  })

  it('reads byte ranges as HTTP writes them', () => {
    expect(byteRange(undefined, 10)).toBeNull()
    expect(byteRange('bytes=2-4', 10)).toEqual([2, 5])
    expect(byteRange('bytes=2-', 10)).toEqual([2, 10])
    expect(byteRange('bytes=-3', 10)).toEqual([7, 10])
    expect(byteRange('bytes=5-100', 10)).toEqual([5, 10])
    expect(byteRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(byteRange('bytes=4-2', 10)).toBe('unsatisfiable')
  })
})
