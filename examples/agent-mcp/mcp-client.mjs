// A minimal MCP client over stdio (JSON-RPC 2.0, one message per line), enough for an agent
// script to drive `kition-kits-mcp`. A real agent uses its harness's MCP client instead.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class McpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message} (${error.code})`)
    this.code = error.code
  }
}

/** Starts `command args` and speaks MCP to it on its standard input and output. */
export async function connect(command, args, { env = process.env, stderr = 'inherit', timeoutMs = 60_000 } = {}) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', stderr] })
  const pending = new Map()
  let next = 0
  let exited = null
  child.on('exit', (code, signal) => {
    exited = new Error(`${command} exited (${signal ?? code})`)
    for (const { reject } of pending.values()) reject(exited)
    pending.clear()
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    const message = JSON.parse(line)
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new McpError(waiting.method, message.error))
    else waiting.resolve(message.result)
  })

  const request = (method, params = {}) => {
    if (exited) return Promise.reject(exited)
    next += 1
    const id = next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, {
        method,
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`)

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'kition-agent-mcp-example', version: '1' },
  })
  notify('notifications/initialized')

  return {
    server: initialized,
    request,
    /** `tools/list`: the names and input schemas the server offers now. */
    tools: async () => (await request('tools/list')).tools,
    /** `tools/call`: the tool's result (`isError`, `content`, `structuredContent`). */
    call: (name, args) => request('tools/call', { name, arguments: args }),
    close: async () => {
      child.stdin.end()
      if (!exited) await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

/**
 * Speaks MCP to `url` with one HTTP POST per message (JSON in, JSON out): the example page's relay
 * to the editor a person has open (`/api/agent/<name>/mcp`, examples/embed-app/agent-relay.mjs).
 */
export async function connectHttp(url, { timeoutMs = 60_000 } = {}) {
  let next = 0
  const post = async (message) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) })
    if (response.status === 202) return null
    const answer = await response.json()
    if (!response.ok && !answer?.error) throw new Error(`${url}: HTTP ${response.status}`)
    return answer
  }
  const request = async (method, params = {}) => {
    next += 1
    const answer = await post({ jsonrpc: '2.0', id: next, method, params })
    if (answer.error) throw new McpError(method, answer.error)
    return answer.result
  }
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kition-agent-mcp-example', version: '1' } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    server: initialized,
    request,
    tools: async () => (await request('tools/list')).tools,
    call: (name, args) => request('tools/call', { name, arguments: args }),
    close: async () => undefined,
  }
}
