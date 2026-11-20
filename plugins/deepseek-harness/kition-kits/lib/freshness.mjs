// Keeps the kit tools current without a restart of DeepSeek Harness: they are listed again when
// kition appears (installed after DeepSeek Harness started), when its executable changes (an
// upgrade; the gateways this host started are stopped then, so the next request starts the new
// one), and whenever the host module asks (a person opened a kit file). While there is no kition
// (the plugin's own was not installed for this platform) the agent has the one tool that says why.
import fs from 'node:fs'

import { findKition, missingMessage } from './kition.mjs'

/** What identifies the kition in use (`found`, as `findKition` answers): its path, size and modification time; `missing` when there is none. */
export function kitionSignature(found) {
  if (!found.file) return 'missing'
  try {
    const stat = fs.statSync(found.file)
    return `${found.file}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

export class Freshness {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv,
   *   tools: import('./tools.mjs').KitTools,
   *   gateways: import('./gateways.mjs').Gateways,
   *   catalog: (env: NodeJS.ProcessEnv) => Promise<{ tools: object[], instructions: string }>,
   *   intervalMs?: number,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor({ env = process.env, tools, gateways, catalog, intervalMs = 15_000, log = () => {} }) {
    Object.assign(this, { env, tools, gateways, catalog, intervalMs, log })
    this.signature = null
    this.running = null
    this.timer = null
  }

  /** Lists the tools now: the kits' tools when kition is there, else the setup tool. */
  refresh() {
    this.running ??= (async () => {
      const found = findKition(this.env)
      const signature = kitionSignature(found)
      const changed = this.signature !== null && this.signature !== 'missing' && signature !== this.signature
      this.signature = signature
      if (signature === 'missing') {
        this.tools.setMissing(`The Kition kits cannot be used: ${found.error ?? missingMessage(found)}`)
        return
      }
      // A new kition: the gateways of the old one go, the next request starts the new one.
      if (changed) await this.gateways.stopOwned()
      try {
        this.tools.update(await this.catalog(this.env))
        this.tools.clearMissing()
      } catch (error) {
        this.log(`could not list the kit tools: ${error.message}`)
      }
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Lists them again when kition changed since the last time. */
  async check() {
    if (kitionSignature(findKition(this.env)) !== this.signature) await this.refresh()
  }

  start() {
    this.timer = setInterval(() => void this.check(), this.intervalMs)
    this.timer.unref?.()
    return this.refresh()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }
}
