// The built `kition` command (dist/cli.js, built here into a temporary folder, laid out as a global
// npm install lays it out) with stand-in programs: what it passes through, what it tells kition,
// and how it exits. The last test drives the real `kition mcp` over MCP where kition-sdk's
// target/ holds kition.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const sdkRoot = path.resolve(packageDir, '../..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kition-launcher-')))
// The launcher as `npm install -g` lays it out: <prefix>/lib/node_modules/kition/dist/cli.js, its
// platform package beside it, and npm's command <prefix>/bin/kition, a link to it.
const modules = path.join(scratch, 'lib', 'node_modules')
const cli = path.join(modules, 'kition', 'dist', 'cli.js')
const shim = path.join(scratch, 'bin', 'kition')
const platform = `${process.platform}-${process.arch}`
const platformDir = path.join(modules, '@kition', `cli-${platform}`)

const script = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}
// A stand-in kition: its arguments on stdout, one per line, then KITION_LAUNCHER; stdin echoed after them.
const echo = script(path.join(scratch, 'echo-kition'), 'for a in "$@"; do printf "%s\\n" "$a"; done\nprintf "launcher=%s\\n" "$KITION_LAUNCHER"\ncat\nexit 7')

const run = (args: string[], env: Record<string, string>, input = '', command = cli) =>
  spawnSync(process.execPath, [command, ...args], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } })

beforeAll(async () => {
  await build({ configFile: path.join(packageDir, 'vite.config.ts'), root: packageDir, logLevel: 'silent', build: { outDir: path.dirname(cli), emptyOutDir: true } })
}, 60_000)
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('the kition command', () => {
  it('passes arguments, stdin and stdout straight through and exits as kition does', () => {
    const result = run(['mcp', '--workspace', 'my folder', '--unified'], { KITION_BINARY: echo }, '{"jsonrpc":"2.0"}\n')
    expect(result.status).toBe(7)
    expect(result.stdout).toBe('mcp\n--workspace\nmy folder\n--unified\nlauncher=\n{"jsonrpc":"2.0"}\n')
    expect(result.stderr).toBe('')
  })

  it('starts the platform package’s kition with the arguments as they are', () => {
    script(path.join(platformDir, 'bin', 'kition'), `exec ${echo} "$@"`)
    fs.writeFileSync(path.join(platformDir, 'package.json'), `{"name":"@kition/cli-${platform}"}\n`)
    try {
      expect(run(['mcp', '--workspace', '.'], {}).stdout.split('\n').slice(0, 3)).toEqual(['mcp', '--workspace', '.'])
      expect(run(['kit', 'install', 'note'], {}).stdout.split('\n').slice(0, 3)).toEqual(['kit', 'install', 'note'])
      expect(run(['--version'], {}).stdout.split('\n')[0]).toBe('--version')
    } finally {
      fs.rmSync(platformDir, { recursive: true, force: true })
    }
  })

  it('tells kition, in KITION_LAUNCHER, npm’s kition command it was started through', () => {
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(shim), cli), shim)
    try {
      const launcher = (result: { stdout: string }) => JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('launcher='))!.slice('launcher='.length))
      const expected = { via: 'npm', command: [shim], executable: echo }
      expect(launcher(run(['agent', 'add', 'cursor'], { KITION_BINARY: echo }, '', shim))).toEqual(expected)
      // However it is started: the agent is to start npm's command, not the path inside node_modules.
      expect(launcher(run(['agent', 'add', 'cursor'], { KITION_BINARY: echo }))).toEqual(expected)
      // A KITION_LAUNCHER kition inherited from elsewhere is replaced, never passed on.
      expect(launcher(run([], { KITION_BINARY: echo, KITION_LAUNCHER: '{"via":"npx"}' }))).toEqual(expected)
    } finally {
      fs.rmSync(shim)
    }
    expect(run([], { KITION_BINARY: echo, KITION_LAUNCHER: '{"via":"npx"}' }).stdout).toContain('launcher=\n')
  })

  it('writes nothing to stdout and names the platforms and install.sh on stderr when it finds no kition', () => {
    const result = run(['mcp', '--workspace', '.'], {})
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^kition \(npm\): no kition for this platform/)
    expect(result.stderr).toContain('darwin-arm64, darwin-x64, linux-arm64 (glibc), linux-x64 (glibc) and win32-x64')
    expect(result.stderr).toContain('install.sh')
  })

  it('ends with the signal that ended the server', () => {
    const result = run([], { KITION_BINARY: script(path.join(scratch, 'killed-server'), 'kill -TERM $$') })
    expect(result.signal).toBe('SIGTERM')
  })

  it('hands a client’s SIGTERM to the server', async () => {
    const sleeper = script(path.join(scratch, 'sleeping-server'), 'trap "echo stopped >&2; exit 0" TERM\necho ready\nwhile :; do sleep 0.05; done')
    const child = spawn(process.execPath, [cli], { env: { PATH: '/usr/bin:/bin', KITION_BINARY: sleeper } })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.kill('SIGTERM')
    const code = await new Promise((resolve) => child.on('close', (exit) => resolve(exit)))
    expect(code).toBe(0)
    expect(stderr).toBe('stopped\n')
  })

  it('handles a client’s SIGTERM while spawning and preserves the handler’s exit code', async () => {
    const release = path.join(scratch, 'release-spawn')
    const pidFile = path.join(scratch, 'spawning-server.pid')
    const preload = path.join(scratch, 'pause-spawn.cjs')
    // Force the server to become ready before spawn() returns, as it can when the launcher
    // is descheduled. Release it only after the client has sent its signal; no timing guess.
    fs.writeFileSync(preload, `
      const cp = require('node:child_process')
      const fs = require('node:fs')
      const spawn = cp.spawn
      cp.spawn = (...args) => {
        const child = spawn(...args)
        const pause = new Int32Array(new SharedArrayBuffer(4))
        while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(pause, 0, 0, 10)
        return child
      }
      require('node:module').syncBuiltinESMExports()
    `)
    const sleeper = script(path.join(scratch, 'spawning-server'), `trap "echo stopped >&2; exit 23" TERM\necho $$ > "${pidFile}"\necho ready\nwhile :; do sleep 0.05; done`)
    const child = spawn(process.execPath, ['--require', preload, cli], { env: { PATH: '/usr/bin:/bin', KITION_BINARY: sleeper } })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      await new Promise((resolve) => child.stdout.once('data', resolve))
      expect(child.kill('SIGTERM')).toBe(true)
      fs.writeFileSync(release, '')
      const { code, signal } = await exited
      expect(code).toBe(23)
      expect(signal).toBeNull()
      await closed
      expect(stderr).toBe('stopped\n')
    } finally {
      fs.writeFileSync(release, '')
      // A broken launcher dies before forwarding and leaves the stand-in holding its pipes.
      if (child.exitCode !== 23 && fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      child.kill('SIGKILL')
      await closed
    }
  })
})

// kition from this checkout (cargo build -p kition-cli), and the Note kit's debug build when
// kition-note is checked out beside it. Without them there is nothing to drive.
const server = ['dist', 'release', 'debug'].map((profile) => path.join(sdkRoot, 'target', profile, 'kition')).find((file) => fs.existsSync(file))
const note = path.join(sdkRoot, '..', 'kition-note', 'target', 'debug', 'kition-note')

describe('the real server through the launcher', () => {
  it('answers initialize and tools/list over stdio (where target/ holds kition)', async () => {
    if (!server) return
    const workspace = fs.mkdtempSync(path.join(scratch, 'workspace-'))
    const args = ['--workspace', workspace, '--unified', ...(fs.existsSync(note) ? ['--kit', note] : [])]
    // A Kition home and an index of its own: the test never reads ~/.kition or the network.
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const env = { ...process.env, KITION_BINARY: server, KITION_HOME: home, KITION_INDEX: path.join(home, 'no-index.json') }
    const child = spawn(process.execPath, [cli, 'mcp', ...args], { env })
    const replies: Record<number, { result?: { serverInfo?: { name: string }; tools?: { name: string }[] } }> = {}
    let buffer = ''
    let stderr = ''
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const done = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data) => {
        buffer += data
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const message = JSON.parse(buffer.slice(0, at))
          buffer = buffer.slice(at + 1)
          if (typeof message.id === 'number') replies[message.id] = message
          if (replies[1] && replies[2]) resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`the server exited (${code}); replies: ${JSON.stringify(replies)}; stderr: ${stderr}`)))
    })
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'launcher-test', version: '1' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    try {
      await done
    } finally {
      child.kill('SIGTERM')
    }
    expect(replies[1].result?.serverInfo?.name, JSON.stringify(replies[1])).toBeTruthy()
    const tools = (replies[2].result?.tools ?? []).map((tool) => tool.name)
    if (fs.existsSync(note)) expect(tools).toEqual(expect.arrayContaining(['kit_inspect', 'kit_run', 'kit_check']))
  }, 60_000)

  it('exits by itself, writing only JSON-RPC on stdout, when the client closes stdin (where target/ holds kition)', async () => {
    if (!server) return
    const workspace = fs.mkdtempSync(path.join(scratch, 'workspace-'))
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const env = { ...process.env, KITION_BINARY: server, KITION_HOME: home, KITION_INDEX: path.join(home, 'no-index.json') }
    const child = spawn(process.execPath, [cli, 'mcp', '--workspace', workspace], { env })
    let stdout = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.resume()
    const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'launcher-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]
    child.stdin.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    const code = await closed
    clearTimeout(timer)
    expect(code).toBe(0)
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(messages.every((message) => message.jsonrpc === '2.0')).toBe(true)
    expect(messages.map((message) => message.id)).toEqual(expect.arrayContaining([1, 2]))
  }, 60_000)
})
