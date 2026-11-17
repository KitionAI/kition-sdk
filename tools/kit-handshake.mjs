#!/usr/bin/env node
// Starts a kit's headless executable as a host does (Kit Process Protocol, sections 3 and 4) and
// answers what it said: the protocol version of its ready line and the kit id and version of its
// `kit.initialize` reply. The release checks every executable it ships with it, on the platform it
// was built for (a Unix domain socket on macOS and Linux, a named pipe on Windows), so the version
// a release states is the version the executable was seen to answer.
//
//   node tools/kit-handshake.mjs <kition-kit> [--protocol <n>]   prints {"protocolVersion","kit"}
//   node tools/kit-handshake.mjs --record <folder>
//
// --record checks every kit executable in <folder> (`kition-<kit>`, not `kition-kits` or
// `kition-kits-mcp`) and writes <folder>/handshakes.json: by file name, its SHA-256 and what it
// answered. tools/sdk-bundle.mjs --bin reads it where the executables cannot run.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TIMEOUT_MS = 20_000

/** A fresh endpoint the kit listens on: a socket in a private folder, or a random pipe name. */
function endpoint() {
  if (process.platform === 'win32') return { name: `\\\\.\\pipe\\kition-kit-handshake-${crypto.randomBytes(8).toString('hex')}`, cleanup() {} }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'))
  fs.chmodSync(dir, 0o700)
  return { name: path.join(dir, 'kit.sock'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Resolves with `{ protocolVersion, kit: { id, version } }`, or rejects with what went wrong. */
export function handshake(executable, protocol) {
  const where = endpoint()
  const token = crypto.randomBytes(32).toString('hex')
  const name = path.basename(executable)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--kition-kit'], {
      env: { ...process.env, KITION_KIT_PROTOCOL: String(protocol), KITION_KIT_ENDPOINT: where.name, KITION_KIT_TOKEN: token, KITION_KIT_SURFACE: 'headless' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let socket = null
    let settled = false
    let errors = ''
    const done = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      child.kill()
      where.cleanup()
      outcome instanceof Error ? reject(outcome) : resolve(outcome)
    }
    const timer = setTimeout(() => done(new Error(`${name} did not answer kit.initialize within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)
    child.stderr.on('data', (chunk) => (errors += chunk))
    child.on('error', (error) => done(error))
    child.on('exit', (code) => done(new Error(`${name} exited (${code}) before answering kit.initialize: ${errors.trim()}`)))

    let output = ''
    let ready = null
    child.stdout.on('data', (chunk) => {
      if (ready !== null) return
      output += chunk
      if (!output.includes('\n')) return
      const line = output.split('\n')[0]
      try {
        const parsed = JSON.parse(line)
        if (parsed.type !== 'ready') throw new Error('not ready')
        ready = parsed.protocolVersion
      } catch {
        done(new Error(`${name}: not a ready line: ${line}`))
        return
      }
      socket = net.connect(where.name)
      socket.on('error', (error) => done(new Error(`${name}: connecting to ${where.name}: ${error.message}`)))
      let input = ''
      socket.on('data', (data) => {
        input += data
        let at
        while ((at = input.indexOf('\n')) >= 0) {
          const message = input.slice(0, at)
          input = input.slice(at + 1)
          let parsed
          try {
            parsed = JSON.parse(message)
          } catch {
            done(new Error(`${name}: not JSON-RPC: ${message}`))
            return
          }
          if (parsed.id !== 1) continue
          if (parsed.error) done(new Error(`${name}: kit.initialize failed: ${JSON.stringify(parsed.error)}`))
          else done({ protocolVersion: ready, initialized: parsed.result.protocolVersion, kit: parsed.result.kit })
        }
      })
      const params = { protocolVersion: protocol, token, role: 'host', client: { name: 'kition-sdk-release', version: '1' }, hostServices: ['files'] }
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'kit.initialize', params })}\n`)
    })
  })
}

export const HANDSHAKES = 'handshakes.json'
const SERVERS = new Set(['kition-kits', 'kition-kits-mcp'])
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** The kit executables in a folder: `kition-<kit>` (`.exe` on Windows), without the two servers. */
export function kitExecutables(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => /^kition-[a-z0-9-]+(\.exe)?$/.test(file) && !SERVERS.has(file.replace(/\.exe$/, '')))
    .sort()
}

/** Checks every kit executable in `dir` and writes `dir/handshakes.json`; answers what it wrote. */
export async function record(dir, protocol) {
  const found = {}
  for (const file of kitExecutables(dir)) {
    const said = await handshake(path.join(dir, file), protocol)
    found[file] = { sha256: sha256(path.join(dir, file)), ...said }
  }
  if (!Object.keys(found).length) throw new Error(`no kit executable (kition-<kit>) in ${dir}`)
  fs.writeFileSync(path.join(dir, HANDSHAKES), `${JSON.stringify(found, null, 2)}\n`)
  return found
}

/** What `record` wrote in `dir`. */
export function readHandshakes(dir) {
  const file = path.join(dir, HANDSHAKES)
  if (!fs.existsSync(file)) throw new Error(`no ${HANDSHAKES} in ${dir}: run kit-handshake.mjs --record there, on the executables' platform`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** The Kit Process Protocol version this SDK's hosts speak (kition-kit-process-protocol's PROTOCOL_VERSION). */
export function sdkProtocol(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const source = fs.readFileSync(path.join(root, 'crates', 'kition-kit-process-protocol', 'src', 'lib.rs'), 'utf8')
  const version = source.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)
  if (!version) throw new Error('kition-kit-process-protocol states no PROTOCOL_VERSION')
  return Number(version[1])
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [executable, flag, value] = process.argv.slice(2)
  if (!executable || (executable !== '--record' && flag && flag !== '--protocol') || (executable === '--record' && !flag)) {
    process.stderr.write('usage: kit-handshake.mjs <kition-kit> [--protocol <n>] | --record <folder>\n')
    process.exit(2)
  }
  try {
    const said = executable === '--record' ? await record(path.resolve(flag), sdkProtocol()) : await handshake(path.resolve(executable), flag ? Number(value) : sdkProtocol())
    process.stdout.write(`${JSON.stringify(said, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`kit-handshake: ${error.message}\n`)
    process.exit(1)
  }
}
