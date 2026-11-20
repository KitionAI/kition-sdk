// The workspace folders the host module serves: only those a DeepSeek Harness session works in.
// A browser names a session (its id is in every file address of the right sidebar); the host
// looks its folder up in DeepSeek Harness's own session store, never in what the browser sends,
// and remembers the folder under its key (the first 32 hex digits of the SHA-256 of its canonical
// path, as kition's gateway lockfile names it) for the page's later requests.
import fs from 'node:fs'

import { workspaceKey } from './gateways.mjs'

/** The canonical path of a folder, or null when it is no folder. */
export function canonicalFolder(folder) {
  try {
    const real = fs.realpathSync(folder)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

export class Workspaces {
  /**
   * @param {{
   *   cwdOf: (sessionId: string) => string | undefined | Promise<string | undefined>,
   *   list?: () => Iterable<string> | Promise<Iterable<string>>,
   * }} sessions what DeepSeek Harness says: a session's working folder, and (when it can) the
   *   working folders of the sessions it knows
   */
  constructor(sessions) {
    this.sessions = sessions
    /** @type {Map<string, string>} key → canonical folder */
    this.known = new Map()
  }

  remember(folder) {
    const canonical = canonicalFolder(folder)
    if (canonical) this.known.set(workspaceKey(canonical), canonical)
    return canonical
  }

  /** The canonical workspace folder of the session `id`, or null. */
  async ofSession(id) {
    if (typeof id !== 'string' || id === '') return null
    let cwd
    try {
      cwd = await this.sessions.cwdOf(id)
    } catch {
      return null
    }
    return typeof cwd === 'string' && cwd !== '' ? this.remember(cwd) : null
  }

  /** The canonical workspace folder `key` names, when a session works there; else null. */
  async ofKey(key) {
    const known = this.known.get(key)
    if (known) return known
    // Not seen since the host started (a page reloaded after a restart): any session working there.
    for (const cwd of (await this.sessions.list?.()) ?? []) {
      const canonical = canonicalFolder(cwd)
      if (canonical && workspaceKey(canonical) === key) {
        this.known.set(key, canonical)
        return canonical
      }
    }
    return null
  }
}
