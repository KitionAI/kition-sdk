// The host module's gateways: one `kition gateway --workspace <folder> --stdin-lifetime` per
// workspace folder, started the first time something needs it, reused when one already serves the
// folder (its lockfile; `kition gateway` exits 3 and names it), started again after it dies with
// the token read again (each start has a new one), and stopped with the host (its stdin closes).
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'

import { findKition, INSTALL_HINT, kitOptions } from './kition.mjs'

/** The exit status of a `kition gateway` that found another one serving the folder. */
export const ALREADY_RUNNING = 3

/** Why a gateway is not there: `code` is what the browser module shows. */
export class GatewayError extends Error {
  /**
   * @param {'kition-missing' | 'kition-invalid' | 'gateway-failed'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** The key of a canonical workspace folder: the first 32 hex digits of its path's SHA-256, as kition's lockfile names it. */
export const workspaceKey = (canonical) => crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)

/**
 * @typedef {{ url: string, port: number, token: string, pid: number, workspace: string, lockfile: string, owned: boolean }} Gateway
 */

/** The lockfile a ready (or running) line names, read: the gateway's address and token, or null. */
function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof lock.token !== 'string' || typeof lock.port !== 'number' || typeof lock.url !== 'string') return null
    return lock
  } catch {
    return null
  }
}

export class Gateways {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, log?: (message: string) => void, readyTimeoutMs?: number }} [options]
   */
  constructor({ env = process.env, log = () => {}, readyTimeoutMs = 60_000 } = {}) {
    this.env = env
    this.log = log
    this.readyTimeoutMs = readyTimeoutMs
    /** @type {Map<string, { gateway?: Gateway, starting?: Promise<Gateway>, child?: import('node:child_process').ChildProcess }>} */
    this.entries = new Map()
    this.stopped = false
  }

  /**
   * The live gateway of the canonical workspace `workspace`, started when there is none.
   * @param {string} workspace
   * @returns {Promise<Gateway>}
   */
  async get(workspace) {
    if (this.stopped) throw new GatewayError('gateway-failed', 'DeepSeek Harness is stopping')
    const entry = this.entries.get(workspace) ?? {}
    this.entries.set(workspace, entry)
    if (entry.gateway && this.current(entry)) return entry.gateway
    entry.gateway = undefined
    entry.starting ??= this.start(workspace, entry).finally(() => {
      entry.starting = undefined
    })
    return entry.starting
  }

  /**
   * Whether `entry`'s gateway is still the one its lockfile names: a gateway of ours that exited,
   * or one of another process that stopped or was replaced, is not (and its token is old).
   */
  current(entry) {
    const { gateway } = entry
    if (!gateway) return false
    if (gateway.owned && (!entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null)) return false
    const lock = readLock(gateway.lockfile)
    return lock !== null && lock.token === gateway.token && lock.port === gateway.port
  }

  /** Forgets the gateway of `workspace` (it did not answer): the next `get` starts or finds one again. */
  forget(workspace) {
    const entry = this.entries.get(workspace)
    if (entry) entry.gateway = undefined
  }

  /** @returns {Promise<Gateway>} */
  async start(workspace, entry) {
    const found = findKition(this.env)
    if (found.missing) throw new GatewayError('kition-missing', `kition is not installed. ${INSTALL_HINT}`)
    if (found.error) throw new GatewayError('kition-invalid', `${found.error}. ${INSTALL_HINT}`)
    const args = ['gateway', '--workspace', workspace, '--stdin-lifetime', ...kitOptions(this.env)]
    this.log(`starting ${found.file} ${args.join(' ')}`)
    const child = spawn(found.file, args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr = []
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      stderr.push(line)
      if (stderr.length > 40) stderr.shift()
    })
    // A broken pipe on the gateway's stdin (it stopped) is no error of the host.
    child.stdin.on('error', () => {})
    const announced = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new GatewayError('gateway-failed', `kition gateway did not start within ${this.readyTimeoutMs / 1000} s: ${stderr.join('\n')}`))
      }, this.readyTimeoutMs)
      let line = null
      readline.createInterface({ input: child.stdout }).once('line', (text) => {
        try {
          line = JSON.parse(text)
        } catch {
          line = null
        }
        if (line?.kition === 'gateway-ready') {
          clearTimeout(timer)
          resolve(line)
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new GatewayError('kition-invalid', `could not start ${found.file}: ${error.message}. ${INSTALL_HINT}`))
      })
      // `close`, not `exit`: the line a gateway that found another one printed is read by then.
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === ALREADY_RUNNING && line?.kition === 'gateway-running') resolve(line)
        else if (code === ALREADY_RUNNING) reject(new GatewayError('gateway-failed', 'another kition gateway is starting for this folder'))
        else reject(new GatewayError('gateway-failed', `kition gateway exited with status ${code}: ${stderr.join('\n')}`))
      })
    })
    const lock = readLock(announced.lockfile)
    if (!lock) {
      child.kill('SIGTERM')
      throw new GatewayError('gateway-failed', `kition gateway left no readable lockfile at ${announced.lockfile}`)
    }
    const owned = announced.kition === 'gateway-ready'
    /** @type {Gateway} */
    const gateway = { url: lock.url, port: lock.port, token: lock.token, pid: lock.pid, workspace: lock.workspace, lockfile: announced.lockfile, owned }
    if (owned) {
      entry.child = child
      child.once('exit', (code, signal) => {
        if (entry.child === child) entry.child = undefined
        if (entry.gateway === gateway) entry.gateway = undefined
        if (!this.stopped) this.log(`the gateway of ${workspace} stopped (${signal ?? code}); the next request starts another`)
      })
      this.log(`gateway ${gateway.url} serves ${workspace} (pid ${gateway.pid})`)
    } else {
      this.log(`gateway ${gateway.url} (pid ${gateway.pid}, not ours) already serves ${workspace}`)
    }
    if (this.stopped) {
      await stopChild(child)
      throw new GatewayError('gateway-failed', 'DeepSeek Harness is stopping')
    }
    entry.gateway = gateway
    return gateway
  }

  /** Stops the gateways this host started and keeps serving: the next request starts each again. */
  async stopOwned(graceMs = 5000) {
    const children = []
    for (const entry of this.entries.values()) {
      if (entry.child) children.push(entry.child)
      entry.gateway = undefined
    }
    await Promise.all(children.map((child) => stopChild(child, graceMs)))
  }

  /** Stops every gateway this host started (their stdin closes; SIGTERM after `graceMs`). */
  async stop(graceMs = 5000) {
    this.stopped = true
    const children = [...this.entries.values()].map((entry) => entry.child).filter(Boolean)
    this.entries.clear()
    await Promise.all(children.map((child) => stopChild(child, graceMs)))
  }
}

/** Ends a gateway: closes its stdin (`--stdin-lifetime`), then SIGTERM, then SIGKILL. */
function stopChild(child, graceMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const term = setTimeout(() => child.kill('SIGTERM'), graceMs)
    const kill = setTimeout(() => child.kill('SIGKILL'), graceMs * 2)
    child.once('exit', () => {
      clearTimeout(term)
      clearTimeout(kill)
      resolve()
    })
    child.stdin?.end()
  })
}
