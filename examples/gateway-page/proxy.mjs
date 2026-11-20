// A same-origin reverse proxy in front of kition gateway, as a host puts one (docs/sdk/gateway-page.md):
// /kition/<rest> goes to <gateway>/<rest> with the gateway's token added and the browser's Origin,
// Referer and Cookie dropped; answers stream back unbuffered (the bridge's event stream). /host is an
// empty page of the host's own, for a test to frame the editor page in.
//   node proxy.mjs <gateway url> <token>   prints its own address, http://127.0.0.1:<port>/kition/
import http from 'node:http'
const [target, token] = process.argv.slice(2)
const PREFIX = '/kition/'
const server = http.createServer((request, response) => {
  if (request.url === '/host') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>host</title>')
  if (!request.url.startsWith(PREFIX)) return response.writeHead(404).end()
  const headers = { ...request.headers, host: new URL(target).host, 'kition-token': token }
  for (const name of ['origin', 'referer', 'cookie']) delete headers[name]
  const upstream = http.request(new URL(request.url.slice(PREFIX.length - 1), target), { method: request.method, headers }, (answer) => {
    response.writeHead(answer.statusCode, answer.headers)
    response.flushHeaders()
    answer.pipe(response)
  })
  upstream.on('error', () => response.headersSent ? response.destroy() : response.writeHead(502).end())
  request.pipe(upstream)
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}${PREFIX}`))
