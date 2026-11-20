// The kits' MCP server as the host module reaches it: a gateway's `POST /api/v1/mcp/kits`
// (Streamable HTTP, one JSON answer per message, no MCP session), one connection per DeepSeek
// Harness agent (`Kition-Mcp-Connection`, so its request ids, cancellations, drafts and history are
// its own), initialized once for each start of the gateway; and, before any gateway runs, the
// tool list a short-lived `kition mcp` for an empty folder answers.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { findKition, kitOptions, missingMessage } from './kition.mjs'

export const PROTOCOL_VERSION = '2025-06-18'
export const CLIENT_INFO = { name: 'deepseek-harness', version: '1' }

/** A connection id the gateway accepts: 16 to 128 letters, digits, `-` or `_`, mostly random. */
export const connectionId = () => `dsh-${crypto.randomBytes(16).toString('hex')}`

/** A JSON-RPC error answered by the server, or a transport failure, with `retry` when nothing ran. */
export class McpError extends Error {
  constructor(message, { retry = false } = {}) {
    super(message)
    this.retry = retry
  }
}

export class GatewayMcp {
  /** @param {{ fetch?: typeof fetch }} [options] */
  constructor({ fetch: fetcher = fetch } = {}) {
    this.fetch = fetcher
    /** @type {Map<string, Promise<unknown>>} `<token>:<connection>` → its initialize */
    this.initialized = new Map()
    this.next = 1
  }

  /** Posts one JSON-RPC message; the answer's `result`, or `undefined` for a notification. */
  async post(gateway, connection, message, signal) {
    let response
    try {
      response = await this.fetch(new URL('/api/v1/mcp/kits', gateway.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'kition-token': gateway.token, 'kition-mcp-connection': connection },
        body: JSON.stringify(message),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      // Nothing reached the gateway (it stopped): the call did not run.
      throw new McpError(`the kition gateway does not answer: ${error.cause?.code ?? error.message}`, { retry: true })
    }
    if (response.status === 401 || response.status === 403) throw new McpError(`the kition gateway refused the request (${response.status})`, { retry: true })
    if (response.status === 202) return undefined
    const text = await response.text()
    if (!response.ok) throw new McpError(`the kition gateway answered ${response.status}: ${text.slice(0, 500)}`)
    const answer = JSON.parse(text)
    if (answer.error) throw new McpError(`${answer.error.message ?? 'error'} (${answer.error.code})`)
    return answer.result
  }

  async request(gateway, connection, method, params, signal) {
    return this.post(gateway, connection, { jsonrpc: '2.0', id: this.next++, method, params }, signal)
  }

  /** Initializes `connection` on `gateway` once per start of the gateway (its token). */
  initialize(gateway, connection) {
    const key = `${gateway.token}:${connection}`
    let done = this.initialized.get(key)
    if (!done) {
      done = (async () => {
        const result = await this.request(gateway, connection, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
        await this.post(gateway, connection, { jsonrpc: '2.0', method: 'notifications/initialized' })
        return result
      })()
      done.catch(() => this.initialized.delete(key))
      this.initialized.set(key, done)
    }
    return done
  }

  /** `method` with `params` on `gateway` for `connection`, initialized first: the result. */
  async send(gateway, connection, method, params, signal) {
    await this.initialize(gateway, connection)
    return this.request(gateway, connection, method, params, signal)
  }

  /** `tools/call` of `name` on `gateway` for `connection`: the MCP result. */
  call(gateway, connection, name, args, signal) {
    return this.send(gateway, connection, 'tools/call', { name, arguments: args }, signal)
  }

  /** `tools/list` on `gateway`. */
  async list(gateway, connection) {
    const initialize = await this.initialize(gateway, connection)
    const listed = await this.request(gateway, connection, 'tools/list', {})
    return { tools: listed.tools ?? [], instructions: initialize?.instructions ?? '' }
  }
}

/**
 * The tools and instructions of `kition mcp` for an empty folder of its own, which it serves
 * alone (`--no-relay`) and stops: what the kits offer before any workspace has a gateway.
 */
export async function catalog(env = process.env, timeoutMs = 60_000) {
  const found = findKition(env)
  if (!found.file) throw new Error(found.error ?? missingMessage(found))
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-dsh-catalog-'))
  const child = spawn(found.file, ['mcp', '--workspace', folder, '--no-relay', ...kitOptions(env)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = []
  readline.createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line))
  child.stdin.on('error', () => {})
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`kition mcp did not list its tools within ${timeoutMs / 1000} s: ${stderr.join('\n')}`)), timeoutMs)
      let instructions = ''
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.id === 1) instructions = message.result?.instructions ?? ''
        if (message.id === 2) {
          clearTimeout(timer)
          if (message.error) reject(new Error(message.error.message))
          else resolve({ tools: message.result?.tools ?? [], instructions })
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        reject(new Error(`kition mcp exited with status ${code}: ${stderr.join('\n')}`))
      })
      for (const message of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ])
        child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
    fs.rmSync(folder, { recursive: true, force: true })
  }
}
