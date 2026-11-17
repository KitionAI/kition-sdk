// The agents an ai case can be run with. Every adapter gets the same kits' MCP server command and
// the case's turns, and answers usage: `{ tool_calls, tool_errors, input_tokens, cache_read_tokens,
// cache_write_tokens, output_tokens, cost_usd?, stop, invalid?, transcript }`. `fake` replays the
// case's `solution` through the server and calls no model.
import { spawn } from 'node:child_process'
import { connect } from '../../examples/agent-mcp/mcp-client.mjs'

export const ADAPTERS = ['fake', 'claude-code', 'anthropic-api', 'codex']
export const MODELS = ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5']
export const DEFAULT_MODEL = 'claude-sonnet-5'

const empty = () => ({ tool_calls: 0, tool_errors: 0, input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, stop: 'end_turn', transcript: [] })

/** Replays `solution` (`[{ tool, args }]`) through the server: the correct end state, no model. */
export async function fake({ server, solution }) {
  const usage = empty()
  const mcp = await connect(server.command, server.args, { stderr: 'ignore', timeoutMs: 300_000 })
  try {
    for (const call of solution ?? []) {
      usage.tool_calls += 1
      const result = await mcp.call(call.tool, call.args ?? {})
      if (result.isError) usage.tool_errors += 1
      usage.transcript.push({ tool: call.tool, args: call.args, isError: Boolean(result.isError) })
    }
  } finally {
    await mcp.close()
  }
  return usage
}

/** Runs `command args` with `input` lines on stdin; answers its stdout lines. */
function run(command, args, { cwd, input = [], env = process.env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop()
      lines.push(...parts)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('exit', () => {
      clearTimeout(timer)
      if (buffer) lines.push(buffer)
      resolve(lines)
    })
    for (const line of input) child.stdin.write(`${line}\n`)
    child.stdin.end()
  })
}

/**
 * Claude Code (`claude -p`), isolated with project settings only (no user plugins or
 * hooks), no built-in tools (`--tools ""`), only the kits' server (`--strict-mcp-config`), an empty
 * working folder holding the case's files. A conversation goes in as stream-json user messages.
 */
export async function claudeCode({ server, workspace, turns, model, maxTurns, timeoutMs }) {
  const config = { mcpServers: { kits: { command: server.command, args: server.args } } }
  const args = [
    '-p', ...(turns.length > 1 ? [] : [turns[0]]),
    ...(turns.length > 1 ? ['--input-format', 'stream-json'] : []),
    '--model', model, '--setting-sources', 'project', '--tools', '', '--strict-mcp-config',
    '--mcp-config', JSON.stringify(config), '--max-turns', String(maxTurns),
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--dangerously-skip-permissions',
  ]
  const input = turns.length > 1 ? turns.map((text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })) : []
  const lines = await run(process.env.CLAUDE_BIN ?? 'claude', args, { cwd: workspace, input, env: { ...process.env, MCP_TIMEOUT: '120000' }, timeoutMs })
  const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
  const usage = empty()
  const results = events.filter((e) => e.type === 'result')
  for (const r of results) {
    const u = r.usage ?? {}
    usage.input_tokens += u.input_tokens ?? 0
    usage.cache_write_tokens += u.cache_creation_input_tokens ?? 0
    usage.cache_read_tokens += u.cache_read_input_tokens ?? 0
    usage.output_tokens += u.output_tokens ?? 0
    usage.cost_usd = (usage.cost_usd ?? 0) + (r.total_cost_usd ?? 0)
  }
  for (const e of events) {
    if (e.type === 'assistant') usage.tool_calls += (e.message?.content ?? []).filter((b) => b.type === 'tool_use').length
    if (e.type === 'user') usage.tool_errors += (e.message?.content ?? []).filter((b) => b?.is_error).length
  }
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  const mcp = init?.mcp_servers?.find((s) => s.name === 'kits')?.status
  if (!results.length) usage.invalid = 'no result event'
  else if (mcp && mcp !== 'connected') usage.invalid = `kits server ${mcp}`
  else if (results.length < turns.length) usage.invalid = `conversation ended after ${results.length} of ${turns.length} messages`
  usage.stop = results.at(-1)?.subtype ?? 'none'
  usage.transcript = events
  return usage
}

/** Codex (`codex exec`), its shell and other built-ins off, with the kits' server as `kits`. One message only. */
export async function codex({ server, workspace, turns, timeoutMs }) {
  if (turns.length > 1) return { ...empty(), invalid: 'the codex adapter runs one message; this case is a conversation', stop: 'none' }
  const off = ['image_generation', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'multi_agent', 'apps', 'plugins', 'goals', 'tool_suggest', 'skill_search', 'shell_tool', 'unified_exec']
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', workspace, '-c', 'web_search=disabled',
    ...off.flatMap((f) => ['--disable', f]),
    '-c', `mcp_servers.kits.command=${JSON.stringify(server.command)}`, '-c', `mcp_servers.kits.args=${JSON.stringify(server.args)}`,
    '-c', 'mcp_servers.kits.tool_timeout_sec=600', turns[0],
  ]
  const lines = await run(process.env.CODEX_BIN ?? 'codex', args, { cwd: workspace, timeoutMs })
  const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
  const usage = empty()
  const done = events.filter((e) => e.type === 'item.completed').map((e) => e.item)
  const calls = done.filter((i) => i.type === 'mcp_tool_call')
  usage.tool_calls = calls.length
  usage.tool_errors = calls.filter((i) => i.status === 'failed' || i.result?.isError).length
  for (const e of events.filter((e) => e.type === 'turn.completed')) {
    usage.input_tokens += e.usage?.input_tokens ?? 0
    usage.cache_read_tokens += e.usage?.cached_input_tokens ?? 0
    usage.output_tokens += e.usage?.output_tokens ?? 0
  }
  usage.cost_usd = null
  const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error')
  if (failed) usage.invalid = JSON.stringify(failed).slice(0, 300)
  usage.transcript = events
  return usage
}

/** A tool result's MCP content as Messages API tool_result content: text and images. */
function resultContent(result) {
  const blocks = []
  for (const item of result.content ?? []) {
    if (item.type === 'text') blocks.push({ type: 'text', text: item.text })
    else if (item.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } })
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(no content)' }]
}

/** What the request says about thinking for `model`: adaptive with effort on current models, a budget on Haiku 4.5. */
export function thinkingFor(model, effort = 'high') {
  if (model === 'claude-haiku-4-5') return { thinking: { type: 'enabled', budget_tokens: 4096 } }
  return { thinking: { type: 'adaptive' }, output_config: { effort } }
}

/**
 * The Messages API driving the kits' MCP tools in a manual loop: the server's tools as client
 * tools (cached with the system prompt, which is the server's own instructions), adaptive thinking
 * with effort, no forced tool choice, every assistant turn appended whole (thinking blocks kept), a
 * refusal ends the run.
 */
export async function anthropicApi({ server, turns, model, maxTurns, effort, client }) {
  const usage = empty()
  const mcp = await connect(server.command, server.args, { stderr: 'ignore', timeoutMs: 300_000 })
  try {
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      client = new Anthropic()
    }
    const listed = await mcp.tools()
    const tools = listed.map((tool, index) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema,
      ...(index === listed.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }))
    const system = [{ type: 'text', text: mcp.server.instructions || 'Edit the files in the workspace with the kit tools.', cache_control: { type: 'ephemeral' } }]
    const messages = []
    let rounds = 0
    for (const turn of turns) {
      messages.push({ role: 'user', content: turn })
      while (true) {
        const response = await client.messages.create({ model, max_tokens: 16000, system, tools, messages, ...thinkingFor(model, effort) })
        const u = response.usage ?? {}
        usage.input_tokens += u.input_tokens ?? 0
        usage.cache_read_tokens += u.cache_read_input_tokens ?? 0
        usage.cache_write_tokens += u.cache_creation_input_tokens ?? 0
        usage.output_tokens += u.output_tokens ?? 0
        usage.transcript.push({ stop: response.stop_reason, content: response.content })
        messages.push({ role: 'assistant', content: response.content })
        usage.stop = response.stop_reason
        if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return usage
        if (response.stop_reason === 'pause_turn') continue
        const calls = response.content.filter((block) => block.type === 'tool_use')
        if (!calls.length) break
        rounds += 1
        if (rounds > maxTurns) {
          usage.stop = 'max_turns'
          return usage
        }
        const results = []
        for (const call of calls) {
          usage.tool_calls += 1
          const result = await mcp.call(call.name, call.input)
          if (result.isError) usage.tool_errors += 1
          results.push({ type: 'tool_result', tool_use_id: call.id, content: resultContent(result), ...(result.isError ? { is_error: true } : {}) })
        }
        messages.push({ role: 'user', content: results })
      }
    }
  } finally {
    await mcp.close()
  }
  return usage
}

export async function runAdapter(name, options) {
  switch (name) {
    case 'fake':
      return fake(options)
    case 'claude-code':
      return claudeCode(options)
    case 'anthropic-api':
      return anthropicApi(options)
    case 'codex':
      return codex(options)
    default:
      throw new Error(`unknown adapter ${name} (${ADAPTERS.join(', ')})`)
  }
}
