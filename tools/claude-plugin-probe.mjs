#!/usr/bin/env node
// Starts an MCP server over stdio the way an MCP client does (newline-delimited JSON-RPC), sends
// `initialize`, `notifications/initialized` and `tools/list`, and prints what the server offers:
// the server info, the tool count, and the size of the tool definitions a model is sent (JSON
// characters, and an estimate of tokens at four characters each). Used to check the kition-kits
// Claude Code plugin (plugins/claude-code/kition-kits) and to compare its tool modes.
//
//   node tools/claude-plugin-probe.mjs [--env KEY=VALUE ...] -- <command> [args...]
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const split = args.indexOf('--')
if (split < 0 || split === args.length - 1) {
  console.error('usage: claude-plugin-probe.mjs [--env KEY=VALUE ...] -- <command> [args...]')
  process.exit(2)
}
const env = { ...process.env }
for (let i = 0; i < split; i++) {
  if (args[i] === '--env' && args[i + 1]?.includes('=')) {
    const [key, ...value] = args[++i].split('=')
    env[key] = value.join('=')
  }
}
const [command, ...commandArgs] = args.slice(split + 1)
const server = spawn(command, commandArgs, { env, stdio: ['pipe', 'pipe', 'inherit'] })

const pending = new Map()
let buffer = ''
server.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
})
let next = 1
function request(method, params = {}) {
  const id = next++
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)))
    setTimeout(() => reject(new Error(`${method}: no answer in 60 s`)), 60_000).unref()
  })
}

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-plugin-probe', version: '1' } })
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const { tools } = await request('tools/list')
  const definitions = JSON.stringify(tools)
  console.log(
    JSON.stringify(
      {
        server: init.serverInfo,
        protocolVersion: init.protocolVersion,
        instructions: (init.instructions ?? '').length,
        tools: tools.length,
        names: tools.map((tool) => tool.name),
        definitionChars: definitions.length,
        approxTokens: Math.round(definitions.length / 4),
      },
      null,
      2,
    ),
  )
  server.kill()
} catch (error) {
  console.error(String(error))
  server.kill()
  process.exit(1)
}
