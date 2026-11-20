/**
 * What the plugin's DeepSeek Harness end-to-end tests share: the published dsh runtime, a profile
 * from its `web` template with the packed plugin installed, started under a HOME, a DSH_HOME and a
 * Kition home of their own (nothing of the person's is read or written), and a scripted model that
 * makes the tool calls a test asks for, so no model account is needed.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const plugin = path.resolve(here, '..')
export const repo = path.resolve(plugin, '../../..')
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')) as { version: string; dsh: { target: string } }

/** The dsh launcher of the published runtime in test/e2e.sh's cache, installed there when missing. */
export function dshRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) throw new Error(`DeepSeek Harness needs Node.js 24.9 or later; run the tests with it, not ${process.versions.node}`)
  const cache = process.env.DSH_KITS_CACHE || path.join(process.env.TMPDIR || '/tmp', 'dsh-kits-e2e')
  const bin = path.join(cache, 'node_modules/.bin/dsh')
  const installed = path.join(cache, 'node_modules/@deepseek-ai/dsh/package.json')
  if (!fs.existsSync(bin) || JSON.parse(fs.readFileSync(installed, 'utf8')).version !== manifest.dsh.target) {
    fs.mkdirSync(cache, { recursive: true })
    if (!fs.existsSync(path.join(cache, 'package.json'))) fs.writeFileSync(path.join(cache, 'package.json'), '{"private":true}\n')
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', `@deepseek-ai/dsh@${manifest.dsh.target}`], { cwd: cache, stdio: 'inherit' })
  }
  return bin
}

/** The plugin packed as it is published (npm pack), in `folder`. */
export function pack(folder: string) {
  execFileSync('npm', ['pack', plugin, '--pack-destination', folder], { stdio: 'pipe' })
  return path.join(folder, `kition-dsh-kits-${manifest.version}.tgz`)
}

export type Step = { tool: string; arguments: Record<string, unknown> } | { say: string }

/**
 * An OpenAI Chat Completions model on 127.0.0.1 that answers the person's message naming
 * `<message>` with `script[<message>]`'s steps in turn: each tool call once its previous result came back, then the text. A request
 * without tools (a session title) gets a plain answer. Every request it got is in `requests`.
 */
export async function scriptedModel(script: Record<string, Step[]>) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = []
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'scripted', choices: [{ index: 0, delta, finish_reason: finish }] })
  const text = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : JSON.stringify(content))
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', () => {
      if (request.method === 'GET') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'scripted', object: 'model' }] }))
      const asked = JSON.parse(body)
      requests.push(asked)
      // The person's last message that names a script (DeepSeek Harness adds reminders as user messages after it).
      const messages: Array<{ role: string; content: unknown }> = asked.messages ?? []
      let at = messages.length - 1
      while (at >= 0 && !(messages[at].role === 'user' && Object.keys(script).some((name) => text(messages[at].content).includes(name)))) at--
      const key = at >= 0 ? Object.keys(script).find((name) => text(messages[at].content).includes(name)) : undefined
      const done = messages.slice(at + 1).filter((message) => message.role === 'tool').length
      let chunks
      const steps = key ? script[key] : []
      const step = steps.filter((item) => 'tool' in item)[done] as { tool: string; arguments: Record<string, unknown> } | undefined
      if (!asked.tools?.length) chunks = [chunk({ role: 'assistant', content: 'Kition' }), chunk({}, 'stop')]
      else if (step) chunks = [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${done}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.arguments) } }] }), chunk({}, 'tool_calls')]
      else chunks = [chunk({ role: 'assistant', content: (steps.find((item) => 'say' in item) as { say: string } | undefined)?.say ?? 'Done.' }), chunk({}, 'stop')]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const item of chunks) response.write(`data: ${JSON.stringify(item)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, requests, stop: () => server.close() }
}

export type Dsh = { url: string; origin: string; process: ChildProcess; output: string[]; stop: () => Promise<void> }

/** The environment of a process of the test: its own homes, no proxy (loopback must not go through one). */
export function isolated(base: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(base, 'home'), CFFIXED_USER_HOME: path.join(base, 'home'), DSH_HOME: path.join(base, 'dsh'), KITION_HOME: path.join(base, 'kition'), PNPM_HOME: path.join(base, 'pnpm'), npm_config_cache: path.join(base, 'npm-cache'), ...extra }
  for (const key of Object.keys(env)) if (/_proxy$/i.test(key) || key.startsWith('KITION_KIT_') || key === 'KITION_KITS_MCP') delete env[key]
  return env
}

/** A profile `profile` from the `web` template with the plugin archive `archive` installed. */
export function installProfile(dsh: string, env: NodeJS.ProcessEnv, profile: string, archive: string) {
  const cwd = env.HOME!
  execFileSync(dsh, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env, cwd, stdio: 'pipe' })
  execFileSync(dsh, ['plugin', '--profile', profile, 'add', archive], { env, cwd, stdio: 'pipe' })
  return execFileSync(dsh, ['--profile', profile, '--dump-config'], { env, cwd, encoding: 'utf8' })
}

/** `dsh --profile <profile>` serving its web UI on a free port, once it prints its address. */
export async function startWeb(dsh: string, env: NodeJS.ProcessEnv, profile: string, patches: string[] = []): Promise<Dsh> {
  const child = spawn(dsh, ['--profile', profile, ...patches.flatMap((file) => ['--patch', file]), '--no-open', '--port', '0'], { env, cwd: env.HOME, stdio: ['ignore', 'pipe', 'pipe'] })
  const output: string[] = []
  readline.createInterface({ input: child.stderr! }).on('line', (line) => output.push(line))
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh printed no address: ${output.join('\n')}`)), 120_000)
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      output.push(line)
      const found = /dsh web: (http\S+)/.exec(line)
      if (found) {
        clearTimeout(timer)
        resolve(found[1])
      }
    })
    child.once('exit', (code) => reject(new Error(`dsh exited ${code}: ${output.join('\n')}`)))
  })
  return {
    url,
    origin: new URL(url).origin,
    process: child,
    output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill('SIGTERM')
      }),
  }
}

/** A fresh base folder under the system's temporary folder. */
export const scratch = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kition-dsh-${name}-`)))
