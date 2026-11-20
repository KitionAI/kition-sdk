/**
 * What the gateway page's end-to-end tests share: a real `kition gateway` on a workspace and a
 * Kition home of their own, with the kits' headless builds and editor packages installed from
 * the kit index's release assets (kept between runs in `GATEWAY_E2E_CACHE`); a real `kition mcp`
 * stdio process for the same workspace, which relays to the gateway; and the same-origin reverse
 * proxy a host puts in front (`proxy.mjs`).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const repo = path.resolve(here, '../../..')
/** Where the kit store with the release assets and results are kept between runs. */
export const cache = process.env.GATEWAY_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-gateway-e2e')
/** The kit index with editor packages (`tools/kits-index.mjs --out`). */
export const index = process.env.GATEWAY_E2E_INDEX || path.join(cache, 'kits-index.json')
export const kition = process.env.KITION_BINARY || path.join(repo, 'target/debug/kition')

/** The environment of every process: no proxy (loopback must not go through one), the home given. */
export function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, KITION_HOME: home, KITION_INDEX: index }
  for (const key of Object.keys(env)) if (/_proxy$/i.test(key) || key.startsWith('KITION_KIT_')) delete env[key]
  return env
}

/**
 * The kits `kits` installed (headless and editor) in the cached home, from the index; copied
 * into a fresh home `home`. Throws, saying what to do, when the index is missing.
 */
export function installKits(home: string, kits: string[]) {
  if (!fs.existsSync(index)) throw new Error(`no kit index with editor packages at ${index}: run node tools/kits-index.mjs --out ${index} (GH_TOKEN set), or set GATEWAY_E2E_INDEX`)
  const kept = path.join(cache, 'home')
  const missing = kits.filter((kit) => !fs.existsSync(path.join(kept, 'kits', kit, 'ui')))
  if (missing.length) {
    const installed = spawnSync(kition, ['kit', 'install', ...missing, '--index', index], { env: environment(kept), encoding: 'utf8', timeout: 600_000 })
    if (installed.status !== 0) throw new Error(`kition kit install ${missing.join(' ')}: ${installed.stderr}`)
  }
  for (const kit of kits) fs.cpSync(path.join(kept, 'kits', kit), path.join(home, 'kits', kit), { recursive: true })
}

export type Gateway = { url: string; token: string; process: ChildProcessWithoutNullStreams; stderr: string[]; stop: () => Promise<void> }

/** `kition gateway --workspace <workspace>` with `extra`: its address and token, once ready. */
export async function startGateway(home: string, workspace: string, extra: string[] = []): Promise<Gateway> {
  const child = spawn(kition, ['gateway', '--workspace', workspace, '--unified', ...extra], { env: environment(home), stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr: string[] = []
  readline.createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line))
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line: ${stderr.join('\n')}`)), 60_000)
    readline.createInterface({ input: child.stdout }).once('line', (line) => {
      clearTimeout(timer)
      resolve(JSON.parse(line) as Record<string, unknown>)
    })
    child.once('exit', (code) => reject(new Error(`kition gateway exited ${code}: ${stderr.join('\n')}`)))
  })
  const lock = JSON.parse(fs.readFileSync(String(ready.lockfile), 'utf8')) as { token: string }
  return {
    url: String(ready.url),
    token: lock.token,
    process: child,
    stderr,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}

/** The address `kition gateway url` prints for the page of `file` (a fresh bootstrap each time). */
export function openUrl(home: string, workspace: string, file: string, review = false) {
  const printed = spawnSync(kition, ['gateway', 'url', '--workspace', workspace, file, ...(review ? ['--review'] : [])], { env: environment(home), encoding: 'utf8' })
  if (printed.status !== 0) throw new Error(`kition gateway url: ${printed.stderr}`)
  return printed.stdout.trim()
}

/** The same-origin proxy (`proxy.mjs`) serving `target` under `/kition/`, adding the token. */
export async function startProxy(target: string, token: string) {
  const child = spawn(process.execPath, [path.join(here, '../proxy.mjs'), target, token], { stdio: ['ignore', 'pipe', 'inherit'], env: environment(os.tmpdir()) })
  const url = await new Promise<string>((resolve) => readline.createInterface({ input: child.stdout }).once('line', resolve))
  return { url, stop: () => child.kill() }
}

/** A real `kition mcp --workspace <workspace>` stdio process: JSON-RPC requests, one at a time. */
export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>()
  private next = 1
  readonly stderr: string[] = []

  constructor(home: string, workspace: string) {
    this.child = spawn(kition, ['mcp', '--workspace', workspace, '--unified'], { env: environment(home), stdio: ['pipe', 'pipe', 'pipe'] })
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => this.stderr.push(line))
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>
      const id = message.id as number | undefined
      if (id !== undefined) this.waiting.get(id)?.(message)
    })
  }

  request(method: string, params: Record<string, unknown> = {}, timeout = 120_000): Promise<Record<string, unknown>> {
    const id = this.next++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${this.stderr.join('\n')}`)), timeout)
      this.waiting.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async initialize() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-e2e', version: '1' } })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }

  /** `tools/call` of `name`: its structured answer, or a thrown error with its text. */
  async call(name: string, args: Record<string, unknown>) {
    const answer = await this.request('tools/call', { name, arguments: args })
    const result = answer.result as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> } | undefined
    if (!result || result.isError) throw new Error(`${name}: ${JSON.stringify(answer)}`)
    return result.structuredContent ?? JSON.parse(result.content?.find((part) => part.text)?.text ?? '{}')
  }

  stop() {
    this.child.kill()
  }
}

/** A fresh home and workspace under the system's temporary folder. */
export function scratch(name: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kition-gateway-${name}-`)))
  const home = path.join(base, 'home')
  const workspace = path.join(base, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  return { base, home, workspace }
}
