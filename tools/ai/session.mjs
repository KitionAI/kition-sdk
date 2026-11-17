// One run of an ai case: a fresh workspace with the case's inputs, the kits' MCP server
// (`kition-kits-mcp`) on it, the steps before the task, the adapter doing the task through the
// same server command, then the steps after it on a new server, so they read what the agent left on
// disk.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from '../../examples/agent-mcp/mcp-client.mjs'
import { workspaceName } from './cases.mjs'

/** Where the server and the kits' headless executables are: flags, environment, sibling checkouts. */
export function locate({ sdk, siblings, mcp, kitBinaries = {} }) {
  const server = resolve(mcp ?? process.env.KITION_KITS_MCP ?? join(sdk, 'target', 'debug', 'kition-kits-mcp'))
  const kit = (name) => {
    const env = process.env[`KITION_KIT_${name.toUpperCase()}_BINARY`]
    return resolve(kitBinaries[name] ?? env ?? join(siblings, `kition-${name}`, 'target', 'debug', `kition-${name}`))
  }
  return { server, kit }
}

/** The command that serves `kits` on `workspace`, for the runner and for every adapter. */
export function serverCommand(where, workspace, kits) {
  const args = ['--workspace', workspace]
  for (const name of kits) args.push('--kit', where.kit(name))
  return { command: where.server, args }
}

/** A workspace holding a copy of each input (by its file name); `replace` swaps files in by name. */
export function makeWorkspace(testCase, repo, replace = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kition-ai-'))
  for (const input of testCase.input ?? []) {
    const source = input.startsWith('repo:') ? join(repo, input.slice(5)) : join(testCase.dir, input)
    copyFileSync(source, join(dir, workspaceName(input)))
  }
  for (const [name, source] of Object.entries(replace)) copyFileSync(source, join(dir, name))
  return dir
}

/** What a tool answered: its structured content, else the JSON after its summary line, else its text. */
export function answerOf(result) {
  if (result.structuredContent) return result.structuredContent
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const json = text.split('\n').slice(1).join('\n')
  try {
    return JSON.parse(json)
  } catch {
    return text
  }
}

/** Runs the read and setup steps (`inspect`, `query`, `check`, `file`, `run`) on one server. */
export async function runSteps(steps, { prefix, workspace, command, outputs, stderr = 'ignore' }) {
  if (!steps.length) return
  const server = await connect(command.command, command.args, { stderr, timeoutMs: 300_000 })
  try {
    for (const step of steps) {
      const [kind] = Object.keys(step)
      const value = step[kind]
      if (kind === 'file') {
        const path = join(workspace, value.path)
        outputs[value.as] = existsSync(path) ? readFileSync(path, 'utf8') : undefined
        continue
      }
      const args = { path: value.path, ...(value.args ?? {}) }
      if (kind === 'inspect') args.preview ??= false
      if (kind === 'run') args.steps = value.steps
      const result = await server.call(`${prefix}_${kind}`, args)
      if (result.isError && value.missing_ok) {
        if (value.as) outputs[value.as] = undefined
        continue
      }
      if (result.isError) throw new Error(`${prefix}_${kind} ${value.path}: ${JSON.stringify(result.structuredContent?.error ?? result.content)}`)
      if (value.as) outputs[value.as] = answerOf(result)
    }
  } finally {
    await server.close()
  }
}

/** The steps before and after the task. */
export function split(testCase) {
  const steps = testCase.steps ?? []
  const index = steps.findIndex((s) => 'task' in s)
  return { before: steps.slice(0, index), after: steps.slice(index + 1) }
}

/** Removes a run's workspace unless it should be kept for a look. */
export function cleanup(dir, keep) {
  if (!keep) rmSync(dir, { recursive: true, force: true })
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}
