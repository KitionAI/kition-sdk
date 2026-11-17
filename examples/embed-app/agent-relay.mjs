/**
 * The example server's relay between the integrator's agent and the editors open in the page
 * (`KitEmbed 1.3` `editor.agentPort`), one relay per open document (`@kition/script/node`'s
 * `createAgentRelay`):
 *
 *   POST /api/agent/<name>/mcp     the agent's MCP message (JSON-RPC); the editor's reply, or 202 for a notification
 *   GET  /api/agent/<name>/next    the page takes the next message for its editor (204 after a wait)
 *   POST /api/agent/<name>/reply   the page sends its editor's reply
 *   GET  /api/agent                [{ name, connected }]
 *
 * A real integrator authenticates both sides (the agent's service and the person's session) and
 * relays only to the page of the person who asked for the agent; this example trusts loopback.
 */
const { createAgentRelay } = await import('../../packages/script/dist/node.js')

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
}

function json(response, status, value) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

/** Connect-style middleware mounted at `/api/agent`. */
export function agentRelays() {
  const relays = new Map()
  const relayFor = (name) => {
    if (!relays.has(name)) relays.set(name, createAgentRelay())
    return relays.get(name)
  }
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const [name, action] = url.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent)
      if (!name) return json(response, 200, [...relays].map(([file, relay]) => ({ name: file, connected: relay.connected() })))
      const relay = relayFor(name)
      if (action === 'mcp' && request.method === 'POST') {
        const reply = await relay.request(await body(request))
        if (!reply) {
          response.statusCode = 202
          return response.end()
        }
        return json(response, 200, reply)
      }
      if (action === 'next' && request.method === 'GET') {
        // A page that goes away (closed, reloaded) must not take the agent's next message.
        const gone = new AbortController()
        response.on('close', () => response.writableFinished || gone.abort())
        const message = await relay.next({ waitMs: 20_000, signal: gone.signal })
        if (gone.signal.aborted) return
        if (!message) {
          response.statusCode = 204
          return response.end()
        }
        return json(response, 200, message)
      }
      if (action === 'reply' && request.method === 'POST') {
        relay.reply(await body(request))
        response.statusCode = 204
        return response.end()
      }
      json(response, 404, { error: 'not found' })
    } catch (error) {
      json(response, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
