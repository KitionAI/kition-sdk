// A scripted OpenAI Chat Completions model for test/e2e.sh. Offered Kition's kit_inspect, it asks
// for it on notes/Plan.md; given that result, it runs the command in DRAFTS_COMMAND with the bash
// tool, as the plugin's draft skills do; given both, it answers with what they said. A request
// without tools (the session title) gets a plain answer. Every request is logged as one JSON line.
//
//   node test/scripted-model.mjs <port> <requests.jsonl>
import fs from 'node:fs'
import http from 'node:http'

const [port, log] = process.argv.slice(2)
const chunk = (delta, finish = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] })
const call = (name, args) => [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls')]
const say = (text) => [chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]
const text = (content) => (typeof content === 'string' ? content : JSON.stringify(content))

http
  .createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', () => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'scripted', object: 'model' }] }))
        return
      }
      const asked = JSON.parse(body)
      fs.appendFileSync(log, JSON.stringify(asked) + '\n')
      const names = (asked.tools ?? []).map((tool) => tool.function.name)
      const inspect = names.find((name) => name === 'mcp__kition__kit_inspect')
      const results = (asked.messages ?? []).filter((message) => message.role === 'tool')
      let chunks
      if (names.length === 0) chunks = say('Kition kits in DeepSeek Harness')
      else if (!inspect) chunks = say('No Kition tools were offered.')
      else if (results.length === 0) chunks = call(inspect, { path: 'notes/Plan.md', preview: false })
      else if (results.length === 1) chunks = call('bash', { command: process.env.DRAFTS_COMMAND, description: 'List the kit drafts' })
      else chunks = say(`Kition says: ${text(results[0].content).slice(0, 200)}\nDrafts: ${text(results[1].content).slice(0, 200)}`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  .listen(Number(port), '127.0.0.1')
