// Checks one test/e2e.sh run: the session log under DSH_HOME, the requests the scripted model
// received, and what dsh printed. Exits 1 with the reason on the first failed check.
//
//   node test/check.mjs <DSH_HOME> <requests.jsonl> <stdout> <published-kits.json>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [home, requestsFile, stdoutFile, publishedFile] = process.argv.slice(2)
const fail = (message, detail) => {
  console.error(`FAIL: ${message}`)
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 4000))
  process.exit(1)
}
const pass = (message) => console.log(`ok: ${message}`)

// The session log: the one session.v4.jsonl.zstd whose events hold a tool call.
const logs = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter((file) => String(file).endsWith('session.v4.jsonl.zstd'))
const sessions = logs.map((file) =>
  zlib.zstdDecompressSync(fs.readFileSync(path.join(home, 'sessions', String(file)))).toString('utf8').trim().split('\n').map((line) => JSON.parse(line)),
)
const events = sessions.find((session) => session.some((event) => event.type === 'tool/call'))
if (!events) fail(`no session with a tool call among ${logs.length} session logs`)
const calls = events.filter((event) => event.type === 'tool/call')
const results = events.filter((event) => event.type === 'tool/result')
const names = calls.map((event) => event.data.name)
if (JSON.stringify(names) !== JSON.stringify(['mcp__kition__kit_inspect', 'bash'])) fail('the tool calls are not kit_inspect, then bash', names)
pass(`tool/call ${names.join(', ')}`)
if (results.length !== 2) fail('not one tool/result per call', results)
const resultText = (event) => JSON.stringify(event.data)
for (const [index, event] of results.entries()) if (event.data.error || event.data.isError) fail(`tool/result ${index + 1} is an error`, event.data)
if (!resultText(results[0]).includes('notes/Plan.md')) fail('kit_inspect did not answer about notes/Plan.md', results[0].data)
if (!resultText(results[1]).includes('\\"drafts\\"')) fail('the drafts command did not list drafts', results[1].data)
pass('tool/result for both, without errors')

const stdout = fs.readFileSync(stdoutFile, 'utf8')
if (!stdout.startsWith('Kition says: ') || !stdout.includes('notes/Plan.md') || !stdout.includes('Drafts: ')) fail('the final answer is not the scripted one', stdout)
pass('final answer')

// The skill catalog and the tools the model was given.
const requests = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const first = requests.find((request) => (request.tools ?? []).length > 0)
const tools = first.tools.map((tool) => tool.function.name)
if (!tools.includes('mcp__kition__kit_inspect')) fail('the model was not given mcp__kition__kit_inspect', tools)
const content = (message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join(''))
const catalog = first.messages.map(content).find((text) => text.includes('<available_skills>'))
if (!catalog) fail('the model was given no skill catalog')
const listed = [...catalog.matchAll(/^- `([a-z0-9-]+)`:/gm)].map((match) => match[1])
const wanted = [...JSON.parse(fs.readFileSync(publishedFile, 'utf8')).map((kit) => `${kit}-editing`), 'drafts-list', 'drafts-compare']
const missing = wanted.filter((name) => !listed.includes(name))
if (missing.length) fail(`the catalog lacks ${missing.join(', ')}`, listed)
const exposed = ['drafts-merge', 'drafts-discard'].filter((name) => listed.includes(name))
if (exposed.length) fail(`the catalog offers the person's ${exposed.join(', ')} to the model`, listed)
pass(`skill catalog: ${wanted.length} of the plugin's skills, without drafts-merge and drafts-discard`)
console.log('PASS: DeepSeek Harness used the kition-kits plugin')
