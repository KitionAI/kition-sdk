// Forwards one browser request to a `kition gateway`, as kition-sdk's docs/sdk/gateway-page.md
// ("The proxy") asks: method, path, query and body as they are, `Host` the gateway's, the
// gateway's token added, the browser's `Origin`, `Cookie`, `Referer` and any `Kition-Token`
// dropped, and the answer streamed back without buffering (the bridge's event stream), ranges and
// large bodies passing through as they are.
import http from 'node:http'

/** Request headers never forwarded: the browser's credentials and origin, and hop-by-hop ones. */
const DROPPED_REQUEST = new Set(['origin', 'cookie', 'referer', 'kition-token', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade'])
/** Answer headers never passed back: hop-by-hop ones, and any cookie (the gateway sets none). */
const DROPPED_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie', 'proxy-authenticate'])

/** The request headers sent to the gateway at `url` with `token`. */
export function gatewayHeaders(headers, url, token) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !DROPPED_REQUEST.has(name.toLowerCase())) out[name] = value
  out.host = new URL(url).host
  out['kition-token'] = token
  return out
}

/** The answer's headers passed to the browser. */
export function browserHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !DROPPED_RESPONSE.has(name.toLowerCase())) out[name] = value
  return out
}

/** Answers `status` with a JSON body `{ error, message, ...extra }`. */
export function answerJson(res, status, body) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

/**
 * Forwards `req` (its path and query `rest`, starting with `/`) to `gateway` and streams the
 * answer into `res`. Calls `unreachable()` when the gateway does not answer, and answers 502 with
 * a JSON reason.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ url: string, token: string }} gateway
 * @param {string} rest
 * @param {() => void} [unreachable]
 */
export function forward(req, res, gateway, rest, unreachable = () => {}) {
  const target = new URL(rest, gateway.url)
  const upstream = http.request(target, { method: req.method, headers: gatewayHeaders(req.headers, gateway.url, gateway.token) }, (answer) => {
    const headers = browserHeaders(answer.headers)
    // An event stream must reach the browser event by event: nothing on the way may compress
    // (DeepSeek Harness's web server gzips plugin routes) or buffer it.
    if (String(answer.headers['content-type'] ?? '').startsWith('text/event-stream')) {
      headers['cache-control'] = 'no-cache, no-transform'
      headers['x-accel-buffering'] = 'no'
    }
    res.writeHead(answer.statusCode ?? 502, headers)
    res.flushHeaders()
    answer.pipe(res)
    answer.on('error', () => res.destroy())
  })
  upstream.on('error', (error) => {
    unreachable()
    if (res.headersSent) res.destroy()
    else answerJson(res, 502, { error: 'gateway-unreachable', message: `the kition gateway does not answer: ${error.message}` })
  })
  // The browser went away (a closed tab, an event stream given up): so does the gateway's request.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  req.pipe(upstream)
  req.on('error', () => upstream.destroy())
}
