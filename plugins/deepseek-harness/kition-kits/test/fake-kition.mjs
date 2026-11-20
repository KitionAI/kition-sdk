// A stand-in for `kition gateway` in the host module's tests (tools/dsh-plugin-host.test.mjs): it
// takes the workspace as the real one does, writes the lockfile KITION_HOME/run/<key>.json with a
// new token, prints the ready line, and serves on 127.0.0.1 only with that token and a loopback
// Host, until its stdin closes. A second one for a folder whose gateway answers prints the
// running line and exits 3, as the real one does.
//
//   GET  /echo...   the request as the gateway saw it: method, url, headers
//   POST /echo...   the same, with the body's length and SHA-256
//   GET  /events    an event stream: three events 300 ms apart
//   GET  /bytes     1000 bytes (0..249 four times), with single ranges
//   POST /api/v1/mcp/kits   a JSON-RPC answer naming the workspace and the tool called
//
// `kition gateway --help` answers as the real one's usage does (the plugin checks a kition has it);
// `--version`, the lockfile and the lines say FAKE_KITION_VERSION (0.0.0 unset).
// FAKE_KITION_LOG, when set, gets one line per start: the arguments.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const args = process.argv.slice(2)
const version = process.env.FAKE_KITION_VERSION ?? '0.0.0'
if (args[0] === '--version') {
  console.log(`kition ${version} (the stand-in)`)
  process.exit(0)
}
// What the plugin asks a kition before it uses it, has it the gateway command, is no start.
if (args[0] === 'gateway' && args.includes('--help')) {
  console.log('usage: kition gateway --workspace <folder> (the stand-in)')
  process.exit(0)
}
if (process.env.FAKE_KITION_LOG) fs.appendFileSync(process.env.FAKE_KITION_LOG, `${JSON.stringify(args)}\n`)
// `kition mcp` for the tool catalog: initialize and tools/list over stdio, the tools FAKE_KITION_TOOLS names.
const toolList = () => (process.env.FAKE_KITION_TOOLS ?? 'kit_inspect').split(',').map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object' } }))
if (args[0] === 'mcp') {
  const { createInterface } = await import('node:readline')
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    const result = message.method === 'initialize' ? { instructions: 'Stand-in kits.' } : { tools: toolList() }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  })
  process.stdin.on('end', () => process.exit(0))
} else if (args[0] !== 'gateway') process.exit(2)
else {
const workspace = fs.realpathSync(args[args.indexOf('--workspace') + 1])
const home = process.env.KITION_HOME
const key = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 32)
const lockfile = path.join(home, 'run', `${key}.json`)
fs.mkdirSync(path.dirname(lockfile), { recursive: true, mode: 0o700 })

const announce = (kind, lock) => console.log(JSON.stringify({ kition: kind, protocol: 'kition-gateway/1', version: lock.version, pid: lock.pid, port: lock.port, url: lock.url, workspace: lock.workspace, lockfile, apiPrefix: '/api/v1' }))

if (fs.existsSync(lockfile)) {
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8'))
  const alive = await fetch(`${lock.url}/api/v1/gateway`, { headers: { 'kition-token': lock.token } }).then((r) => r.ok, () => false)
  if (alive) {
    announce('gateway-running', lock)
    process.exit(3)
  }
  fs.rmSync(lockfile)
}

const token = crypto.randomBytes(32).toString('hex')
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 250))
const server = http.createServer(async (req, res) => {
  const host = req.headers.host ?? ''
  if (!/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin) return res.writeHead(403).end()
  if (req.headers['kition-token'] !== token) return res.writeHead(401).end()
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/v1/gateway') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ workspace, pid: process.pid }))
  if (url.pathname.startsWith('/echo')) {
    const hash = crypto.createHash('sha256')
    let length = 0
    for await (const chunk of req) {
      hash.update(chunk)
      length += chunk.length
    }
    return res.writeHead(200, { 'content-type': 'application/json', etag: '"echo"' }).end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, length, sha256: hash.digest('hex'), pid: process.pid }))
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    for (let i = 1; i <= 3; i++) {
      res.write(`data: ${i}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return res.end()
  }
  if (url.pathname === '/bytes') {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])]
      return res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'accept-ranges': 'bytes' }).end(bytes.subarray(start, end + 1))
    }
    return res.writeHead(200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }).end(bytes)
  }
  if (url.pathname === '/api/v1/mcp/kits' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (message.id === undefined) return res.writeHead(202).end()
    const result =
      message.method === 'tools/call'
        ? { content: [{ type: 'text', text: JSON.stringify({ workspace, tool: message.params.name, arguments: message.params.arguments }) }] }
        : message.method === 'resources/read'
          ? { contents: [{ uri: message.params.uri, mimeType: 'application/json', text: JSON.stringify({ workspace }) }] }
          : message.method === 'resources/list'
            ? { resources: [{ uri: 'khp://kits/kit.note/kit.json', name: 'Note kit manifest' }] }
            : { tools: toolList() }
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const lock = { format: 1, protocol: 'kition-gateway/1', version, pid: process.pid, port, url: `http://127.0.0.1:${port}`, apiPrefix: '/api/v1', token, workspace, unified: args.includes('--unified'), started: Math.floor(Date.now() / 1000) }
  fs.writeFileSync(lockfile, JSON.stringify(lock), { mode: 0o600 })
  announce('gateway-ready', lock)
})
const stop = () => {
  try {
    if (JSON.parse(fs.readFileSync(lockfile, 'utf8')).token === token) fs.rmSync(lockfile)
  } catch {}
  process.exit(0)
}
if (args.includes('--stdin-lifetime')) {
  process.stdin.on('end', stop)
  process.stdin.resume()
}
process.on('SIGTERM', stop)
}
