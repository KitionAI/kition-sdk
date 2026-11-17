/**
 * The SDK's embed and agent flow: a customer's web app embeds the Note editor over its own
 * storage, and the customer's agent edits the same file over MCP (`kition-kits-mcp`) and has the
 * kit check it (`note_check`). The page's files live in one folder on its server
 * (playwright.exit.config.ts); the agent is examples/agent-mcp/run.mjs.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { NOTES, noteEngine, noteText, typeAfter, waitForNoteText } from './fixtures'
import { errors, openApp, openFile, type Hook } from './helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const agent = path.resolve(here, '..', '..', 'agent-mcp', 'run.mjs')
const liveAgent = path.resolve(here, '..', '..', 'agent-mcp', 'live.mjs')
const sdkRoot = path.resolve(here, '..', '..', '..')
const workspace = process.env.EMBED_EXIT_WORKSPACE!

const executables = {
  KITION_KITS_MCP: process.env.KITION_KITS_MCP || path.join(sdkRoot, 'target', 'debug', 'kition-kits-mcp'),
  KITION_KIT_NOTE_BINARY: process.env.KITION_KIT_NOTE_BINARY || path.resolve(sdkRoot, '..', 'kition-note', 'target', 'debug', 'kition-note'),
}
const missing = Object.entries(executables).filter(([, file]) => !existsSync(file)).map(([name]) => name)

type AgentResult = {
  edits: { note: { headings: number; tasks: number } }
  checks: Record<string, { available: boolean; isError?: boolean; diagnostics?: { severity: string; code: string }[] }>
}

/** Runs the agent example on the workspace; answers its `RESULT` line. */
async function runAgent(): Promise<AgentResult> {
  const { stdout } = await promisify(execFile)(process.execPath, [agent, workspace], { env: { ...process.env, ...executables }, timeout: 180_000 })
  const line = stdout.split('\n').find((text) => text.startsWith('RESULT '))
  if (!line) throw new Error(`the agent printed no result:\n${stdout}`)
  return JSON.parse(line.slice('RESULT '.length)) as AgentResult
}

const version = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate((wanted) => ((window.__EMBED_TEST__ as Hook).files() as { name: string; version: number }[]).find((file) => file.name === wanted)?.version ?? 0, name)

/** How many headings a note's text has. */
const headings = (text: string) => text.split('\n').filter((line) => /^#{1,6} /.test(line)).length

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
})

test.beforeEach(() => {
  test.skip(!noteEngine.built, 'no Note kit package: set KITION_KITS_DIR to a folder holding note-ui/')
  test.skip(missing.length > 0, `missing executables (${missing.join(', ')}): build them or set the variables`)
})

let first: AgentResult

test('an agent edits a file over MCP, and the page opens the same file and saves edits the agent reads', async ({ page }) => {
  first = await runAgent()
  expect(first.edits.note).toEqual({ headings: 2, tasks: 1 })

  await openApp(page)
  await expect(page.locator(`[data-file="${NOTES}"]`)).toBeVisible()

  // The agent's edit, in the embedded editor.
  const note = await openFile(page, NOTES)
  await waitForNoteText(note.kit, 'Agent review 2')
  expect(headings(await noteText(note.kit))).toBe(first.edits.note.headings)

  // The person's edit, saved through the page's storage into the folder the agent works in.
  await typeAfter(page, note.kit, 'Goals for the quarter.', ' Then grow.')
  await note.pane.getByTestId('pane-save').click()
  await expect.poll(() => readFileSync(path.join(workspace, NOTES), 'utf8'), { timeout: 30_000 }).toContain('Goals for the quarter. Then grow.')

  // The agent edits again: the page sees a new version of the file.
  const before = await version(page, NOTES)
  const second = await runAgent()
  expect(second.edits.note.headings).toBe(first.edits.note.headings + 1)
  expect(readFileSync(path.join(workspace, NOTES), 'utf8')).toContain('Goals for the quarter. Then grow.')
  await expect.poll(() => version(page, NOTES), { timeout: 30_000 }).toBeGreaterThan(before)
  expect(await errors(page)).toEqual([])
})

test('the agent checks the file it edited with the kit (`note_check`)', async () => {
  const result = await runAgent()
  expect(result.checks.note?.available, 'note_check').toBe(true)
  expect(result.checks.note?.isError).toBe(false)
  expect((result.checks.note?.diagnostics ?? []).filter((item) => item.severity === 'error')).toEqual([])
})

test('the embedded editor checks the same file (`check()`)', async ({ page }) => {
  await openApp(page)
  await openFile(page, NOTES)
  const diagnostics = await page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).check(wanted), NOTES)
  expect(diagnostics, NOTES).not.toBeNull()
  expect(diagnostics!.filter((item) => item.severity === 'error'), NOTES).toEqual([])
  expect(await errors(page)).toEqual([])
})

// `KitEmbed 1.3`: the integrator's agent works in the editor the person has open, through the
// page's server (agent-relay.mjs, `editor.agentPort`): its edits go to a draft, which the person
// reviews and merges in the page; the agent itself can only ask for review.
test('an agent drafts in the open note through the page, and the person merges its draft', async ({ page, baseURL }) => {
  await openApp(page)
  const note = await openFile(page, NOTES)
  await waitForNoteText(note.kit, 'Goals for the quarter.')
  const before = headings(await noteText(note.kit))

  const { stdout } = await promisify(execFile)(process.execPath, [liveAgent, NOTES, baseURL!], { timeout: 180_000 })
  const line = stdout.split('\n').find((text) => text.startsWith('RESULT '))
  const result = JSON.parse(line!.slice('RESULT '.length)) as { tools: string[]; headings: { before: number | null; draft: number | null }; draft: string; diagnostics: Array<{ severity: string }> }
  expect(result.tools).not.toContain('note_merge')
  expect(result.draft).toBe('ready')
  expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
  if (result.headings.before !== null) expect(result.headings.draft).toBe(result.headings.before + 1)

  // The document is unchanged until the person merges the draft in the page.
  await expect(note.pane).toHaveAttribute('data-draft', 'ready')
  expect(headings(await noteText(note.kit))).toBe(before)
  await expect(note.pane.getByTestId('draft-summary')).toContainText("The agent's draft")
  await note.pane.getByTestId('draft-merge').click()
  await expect(note.pane).toHaveAttribute('data-draft', 'none')
  await waitForNoteText(note.kit, 'Drafted by the agent')
  expect(headings(await noteText(note.kit))).toBe(before + 1)
  const diagnostics = await page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).check(wanted), NOTES)
  expect(diagnostics!.filter((item) => item.severity === 'error')).toEqual([])
  expect(await errors(page)).toEqual([])
})
