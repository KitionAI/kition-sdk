// The guard in front of every real model run (F-QA-16): the owner starts AI cases, nothing else.
// A run that calls a model refuses under CI and without a terminal unless `--yes` is given; inside
// an agent's harness (Claude Code, Codex) `--yes` is not accepted, so only a person at a terminal
// can start one. The fake adapter and `--dry-run` call no model and pass.
import { createInterface } from 'node:readline/promises'

export const REAL_ADAPTERS = ['claude-code', 'anthropic-api', 'codex']

/** Whether this process runs inside an agent's harness. */
export function insideAgent(env = process.env) {
  return Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID)
}

/**
 * Decides whether a run may start: `{ allowed, ask, why }`. `ask` means a person must confirm at
 * the terminal first.
 */
export function decide({ adapter, dryRun, yes, env = process.env, tty = Boolean(process.stdin.isTTY) }) {
  if (dryRun || !REAL_ADAPTERS.includes(adapter)) return { allowed: true, ask: false, why: 'no model is called' }
  if (insideAgent(env)) {
    if (!tty) return { allowed: false, ask: false, why: 'AI cases call real models and only the owner starts them (F-QA-16); an agent may not start them, with or without --yes' }
    return { allowed: true, ask: true, why: 'inside an agent harness: a person must confirm at the terminal' }
  }
  if (env.CI && !yes) return { allowed: false, ask: false, why: 'CI is set: AI cases never run in CI (F-QA-16); pass --yes only if the owner really starts this run' }
  if (!tty && !yes) return { allowed: false, ask: false, why: 'stdin is not a terminal: run it yourself, or pass --yes' }
  return { allowed: true, ask: !yes, why: yes ? 'confirmed with --yes' : 'confirm at the terminal' }
}

/** Asks the person at the terminal; answers whether they typed `run`. */
export async function confirm(summary) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${summary}\nThis calls real models and spends money. Type "run" to start: `)
    return answer.trim() === 'run'
  } finally {
    rl.close()
  }
}
