#!/usr/bin/env node
// An agent working in the editor a person has open in the integrator's page (`KitEmbed 1.3`
// `editor.agentPort`), through the page's server: the same MCP tools as `kition-kits-mcp`, but on
// the live editor. Its edits go to a draft; it asks for review and checks the draft; the person
// merges or discards it in the page. The agent never merges.
//
//   EMBED_WORKSPACE=<folder> node examples/embed-app/serve.mjs   # and open the note in the page
//   node examples/agent-mcp/live.mjs <note file name> [page origin]
//
// The last line printed is `RESULT <json>`, for tests.
import assert from 'node:assert/strict'
import { connectHttp } from './mcp-client.mjs'

const [name = 'Notes.md', origin = process.env.EMBED_APP_ORIGIN ?? 'http://127.0.0.1:5310'] = process.argv.slice(2)
const server = await connectHttp(`${origin}/api/agent/${encodeURIComponent(name)}/mcp`)
assert.equal(server.server.serverInfo.name, 'kition-embed')
const names = (await server.tools()).map((tool) => tool.name)
assert.ok(names.includes('note_run') && names.includes('note_draft_ready'), `the editor offers note_run and note_draft_ready (${names.join(', ')})`)

/** One tool call; a failed call (`isError`) throws with the kit's error code. */
const call = async (tool, args) => {
  const answer = await server.call(tool, args)
  if (answer.isError) throw new Error(`${tool}: ${answer.structuredContent?.error?.code ?? 'error'}: ${answer.content?.[0]?.text ?? ''}`)
  return answer.structuredContent
}

const before = await call('note_inspect', { path: name, preview: false })
const ran = await call('note_run', { path: name, steps: [{ command: 'block.append', params: { markdown: '## Drafted by the agent\n\n- [ ] Review this section' } }] })
assert.equal(ran.draft, true, 'the agent edits a draft')
const draft = await call('note_inspect', { path: name, preview: false, draft: true })
const checked = await call('note_check', { path: name, draft: true })
const ready = await call('note_draft_ready', { path: name })
const result = {
  tools: names,
  headings: { before: before.document.details?.headings ?? null, draft: draft.document.details?.headings ?? null },
  draft: ready.state,
  diagnostics: checked.diagnostics,
}
console.log(`drafted one more section in ${name}; ${checked.diagnostics.filter((item) => item.severity === 'error').length} errors; waiting for the person to review it`)
console.log(`RESULT ${JSON.stringify(result)}`)
