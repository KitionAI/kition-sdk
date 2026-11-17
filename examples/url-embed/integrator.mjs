/**
 * An integrator's side of URL embedding (docs/sdk/url.md), as a Node request handler: it decides
 * who may open which file, signs the open token for the iframe URL, and answers the Kits document
 * service's signed callbacks from its own file store (here, memory).
 *
 * The functions it needs from the SDK are passed in (`signOpenToken` from `@kition/sync/openToken`,
 * `verifyCallback` from `@kition/embed-server/callbacks`), so serve.mjs can load them and the test can
 * import them as they are.
 *
 * A real integrator takes the person from its own session and their permissions from its own ACL;
 * this example lets everyone edit `welcome.md`, and opens `?view=1` read-only with a watermark.
 */

/** The example's files: `bytes`, a version that changes on every write, a name, and a generation. */
export function memoryFiles(initial = { welcome: { name: 'welcome.md', text: '# Welcome\n\nEdit me in the frame.\n' } }) {
  const files = new Map(Object.entries(initial).map(([id, file]) => [id, { name: file.name, bytes: new TextEncoder().encode(file.text), version: 1, generation: 1 }]))
  const replicas = new Map()
  return { files, replicas }
}

/**
 * `{ handle, iframeUrl }`: `handle(request, response)` answers the integrator's page (`/`) and the
 * callbacks (`/cb/files/...`); `iframeUrl(file, person, perms)` mints the editor URL.
 */
export function createIntegrator({ signOpenToken, verifyCallback, privateKey, kid, iss, tenant, secret, embedServerUrl, embedServerId, store = memoryFiles(), now = () => Math.floor(Date.now() / 1000) }) {
  const docKey = (file) => `${file}.g${store.files.get(file)?.generation ?? 0}`

  async function iframeUrl(file, person, perms, watermark = null) {
    const stored = store.files.get(file)
    if (!stored) throw new Error(`no file ${file}`)
    const iat = now()
    const token = await signOpenToken({ iss, aud: embedServerId, tenant, sub: person.id, name: person.name, file, version: `v${stored.version}`, doc_key: docKey(file), perms, watermark, iat, exp: iat + 300 }, kid, privateKey)
    return `${embedServerUrl}/v1/open?token=${encodeURIComponent(token)}`
  }

  const readBody = async (request) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return new Uint8Array(Buffer.concat(chunks))
  }

  async function callback(request, response, path, body) {
    if (!verifyCallback(secret, { method: request.method, path, headers: request.headers, body }, now())) return void response.writeHead(401).end()
    const match = /^\/cb\/files\/([^/]+)(\/replica)?$/.exec(path)
    const id = match && decodeURIComponent(match[1])
    const file = id && store.files.get(id)
    if (!file) return void response.writeHead(404).end()
    // The generation the embed server names: a write from an earlier one is stale (D-U3).
    if (request.method === 'PUT' && request.headers['x-kition-doc-key'] !== docKey(id)) return void response.writeHead(409, { 'x-kition-version': `v${file.version}` }).end()
    if (match[2]) {
      if (request.method === 'PUT') {
        store.replicas.set(id, { body, stamp: String(request.headers['x-kition-file-stamp'] ?? '') })
        return void response.writeHead(200).end()
      }
      const kept = store.replicas.get(id)
      return void (kept ? response.writeHead(200, { 'x-kition-file-stamp': kept.stamp }).end(Buffer.from(kept.body)) : response.writeHead(404).end())
    }
    const headers = { 'x-kition-version': `v${file.version}`, 'x-kition-name': file.name }
    if (request.method === 'HEAD') return void response.writeHead(200, headers).end()
    if (request.method === 'GET') return void response.writeHead(200, headers).end(Buffer.from(file.bytes))
    if (request.method === 'PUT') {
      if (request.headers['if-match'] !== `v${file.version}`) return void response.writeHead(409, headers).end()
      file.bytes = body
      file.version += 1
      return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: `v${file.version}` }))
    }
    response.writeHead(405).end()
  }

  async function page(response, url) {
    const view = url.searchParams.get('view') === '1'
    const person = { id: 'user-1', name: 'Example User' }
    const perms = view ? { edit: false, comment: false, download: false, share: false, export: false } : { edit: true, comment: true, download: true, share: false, export: true }
    const src = await iframeUrl('welcome', person, perms, view ? { text: `${person.name} · view only` } : null)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><meta charset="utf-8"><title>URL embedding example</title>
<style>body{margin:0;font:14px system-ui}header{padding:8px 12px}iframe{border:0;width:100%;height:calc(100vh - 40px)}</style>
<header>An integrator's page. <a href="/">Edit</a> · <a href="/?view=1">View only</a></header>
<iframe src="${src.replace(/"/g, '&quot;')}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`)
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://integrator')
    try {
      if (url.pathname.startsWith('/cb/')) return await callback(request, response, url.pathname + url.search, await readBody(request))
      if (request.method === 'GET' && url.pathname === '/') return await page(response, url)
      response.writeHead(404).end()
    } catch (error) {
      console.error('[url-embed example]', error)
      if (!response.headersSent) response.writeHead(500).end()
    }
  }

  return { handle, iframeUrl, store }
}
