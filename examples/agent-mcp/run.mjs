#!/usr/bin/env node
// An agent's side of the SDK exit path: edit a note in one workspace folder over MCP
// (`kition-kits-mcp`, the Note kit's headless executable behind it), then ask the kit to check the
// file (`note_check`, Kit Harness Protocol (KHP) Verify). The same file is the one the embed example
// opens, so a person and an agent work on one copy.
//
//   cargo build -p kition-kits --bin kition-kits-mcp   # here
//   cargo build                                        # in your kition-note checkout
//   node examples/agent-mcp/run.mjs [workspace]
//
// Executables: KITION_KITS_MCP and KITION_KIT_NOTE_BINARY (defaults: this checkout's and the
// sibling kition-note checkout's target/debug). The last line printed is `RESULT <json>`, for tests.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, McpError } from './mcp-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const binary = (env, fallback) => {
  const path = resolve(process.env[env] || fallback)
  if (!existsSync(path)) throw new Error(`no executable at ${path}: build it or set ${env}`)
  return path
}
const mcp = binary('KITION_KITS_MCP', resolve(here, '..', '..', 'target', 'debug', 'kition-kits-mcp'))
const note = binary('KITION_KIT_NOTE_BINARY', resolve(here, '..', '..', '..', 'kition-note', 'target', 'debug', 'kition-note'))

const workspace = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'kition-agent-mcp-'))
mkdirSync(workspace, { recursive: true })
const file = 'Notes.md'

// A note is its Markdown text: a file the integrator does not have yet starts as a heading.
if (!existsSync(join(workspace, file))) {
  writeFileSync(join(workspace, file), '# Notes\n\nGoals for the quarter.\n')
  console.log(`created ${file}`)
}

const server = await connect(mcp, ['--workspace', workspace, '--kit', note], { stderr: 'ignore' })
const result = { workspace, edits: {}, checks: {} }
try {
  const names = (await server.tools()).map((tool) => tool.name)
  assert.ok(names.includes('note_run'), 'the server offers note_run')

  /** One tool call; a failed call (`isError`) throws with the kit's error code. */
  const call = async (name, args) => {
    const answer = await server.call(name, args)
    if (answer.isError) throw new Error(`${name}: ${answer.structuredContent?.error?.code ?? 'error'}: ${answer.content?.[0]?.text ?? ''}`)
    return answer
  }

  /** What `note_inspect` reports: its structured output, else the JSON after its summary line. */
  const inspected = (answer) => answer.structuredContent ?? JSON.parse((answer.content?.[0]?.text ?? '').split('\n').slice(1).join('\n'))

  // The note: one more section, with a task under it.
  const before = inspected(await call('note_inspect', { path: file, preview: false })).details.headings
  await call('note_run', { path: file, steps: [{ command: 'block.append', params: { markdown: `## Agent review ${before + 1}\n\n- [ ] Check the numbers` } }] })
  const after = inspected(await call('note_inspect', { path: file, preview: false })).details
  result.edits.note = { headings: after.headings, tasks: after.tasks.open }

  // Verify: the kit checks its own file. A server that does not offer `note_check` says so
  // instead of failing.
  const tool = 'note_check'
  if (!names.includes(tool)) {
    result.checks.note = { available: false }
    console.log(`${tool}: not offered by this server`)
  } else {
    try {
      const answer = await server.call(tool, { path: file })
      const diagnostics = answer.structuredContent?.diagnostics ?? []
      result.checks.note = { available: true, isError: Boolean(answer.isError), diagnostics }
      const errors = diagnostics.filter((item) => item.severity === 'error')
      console.log(`${tool}: ${diagnostics.length} diagnostics, ${errors.length} errors`)
    } catch (error) {
      if (!(error instanceof McpError && error.code === -32602)) throw error
      result.checks.note = { available: false }
      console.log(`${tool}: not offered by this server`)
    }
  }
} finally {
  await server.close()
}
console.log(`RESULT ${JSON.stringify(result)}`)
