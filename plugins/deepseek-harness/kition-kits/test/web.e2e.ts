/**
 * The plugin in a real DeepSeek Harness 0.2.2-rc.5 web UI (sdk.agent.dsh-plugin/web-e2e): the packed
 * plugin installed with `dsh plugin add` into a profile from the `web` template, the real Table and
 * Note kits (headless and editor packages from the kit index's release assets, as the gateway's
 * e2e installs them), the real `kition gateway` the host module starts, and a scripted model.
 *
 * - DeepSeek Harness's login guards /kition/: without its cookie, or with a foreign Host, refused;
 * - a `.ktable` clicked in the file tree opens the real Table editor in the right sidebar, in a
 *   frame DeepSeek Harness routes its shortcuts to; a cell edited shows the tab's unsaved mark,
 *   closing the tab then asks first, and saved changes the file on disk;
 * - a `.md` keeps DeepSeek Harness's Markdown preview by default and offers "Kition Note" under
 *   "Open with", which opens the real Note editor; the page follows DeepSeek Harness's theme;
 * - the agent's `mcp__kition__kit_run` on that file (the plugin's tool, through the session's
 *   gateway) arrives in the open editor live, without a reload; its draft shows the tab's draft mark
 *   and the page's banner;
 * - when DeepSeek Harness stops, so does the gateway.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { index, installKits, kition } from '../../../../examples/gateway-page/e2e/helpers'
import { noteSample, shots, tableSample } from '../../../../examples/gateway-page/e2e/page'
import { dshRuntime, here, installProfile, isolated, pack, scratch, scriptedModel, startWeb, type Dsh } from './dsh'

const PROFILE = 'kition-e2e'
let base: string
let workspace: string
let dsh: Dsh
let model: Awaited<ReturnType<typeof scriptedModel>>

const APPENDED = 'Appended by the agent in DeepSeek Harness.'
const DRAFTED = 'Drafted by the agent in DeepSeek Harness.'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true })
  const runtime = dshRuntime()
  base = scratch('web')
  // The web profile's default workspace, under the test's own HOME.
  workspace = path.join(base, 'home/Documents/deepseek-harness/default-workspace')
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true })
  fs.copyFileSync(tableSample(), path.join(workspace, 'tasks.ktable'))
  fs.writeFileSync(path.join(workspace, 'notes/plan.md'), noteSample())
  installKits(path.join(base, 'kition'), ['table', 'note'])
  model = await scriptedModel({
    'Append to the plan': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: APPENDED } }] } }, { say: 'Appended.' }],
    'Draft the table': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'tasks.ktable', draft: true, steps: [{ command: 'table.records.create', params: { tableId: 1, values: { title: DRAFTED } } }] } }, { say: 'Drafted.' }],
    'Draft the plan': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFTED } }] } }, { say: 'Drafted.' }],
  })
  const env = isolated(base, { KITION_INDEX: index, KITION_BIN: kition, SCRIPTED_PORT: String(model.port), SCRIPTED_API_KEY: 'scripted' })
  const dump = installProfile(runtime, env, PROFILE, pack(base))
  expect(dump).toContain('# == @kition/dsh-kits')
  dsh = await startWeb(runtime, env, PROFILE, [path.join(here, 'scripted-route.cordis.patch.yml')])
})

test.afterAll(async () => {
  await dsh?.stop()
  model?.stop()
  // For a failure's reader: what DeepSeek Harness printed, and what the model was asked.
  if (base) {
    fs.writeFileSync(path.join(base, 'dsh-output.log'), (dsh?.output ?? []).join('\n'))
    fs.writeFileSync(path.join(base, 'model-requests.jsonl'), (model?.requests ?? []).map((request) => JSON.stringify(request)).join('\n'))
    console.log(`DeepSeek Harness's output and the model's requests: ${base}`)
  }
})

/** DeepSeek Harness signed in through its address, its first-run notices closed, a session of the default workspace on screen. */
async function signIn(page: Page) {
  await page.goto(dsh.url)
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15_000 }).catch(() => {})
  await page.locator('[aria-label="New session in Default workspace"]').first().dispatchEvent('click')
  await page.getByRole('button', { name: 'Close' }).first().click({ timeout: 5_000 }).catch(() => {})
}

/** The right sidebar's file tree, open. */
async function files(page: Page) {
  if (await page.getByRole('button', { name: 'Open right sidebar' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Open right sidebar' }).click()
  const tree = page.getByText('Workspace files').first()
  if (await tree.isVisible().catch(() => false)) await tree.click()
  else await page.getByText('Files', { exact: true }).first().click()
}

const pageFrame = (page: Page, file: string) => page.frames().find((frame) => frame.url().includes('/kition/w/') && frame.url().includes('/page/') && frame.url().includes(encodeURIComponent(file)))
const kitFrame = (page: Page, kit: string) => page.frames().find((frame) => frame.url().includes(`/kits-ui/${kit}@`))

async function opened(frame: Frame) {
  await frame.waitForFunction(() => (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status === 'open', null, { timeout: 120_000 })
}

/** The open Note editor's document as its engine holds it now (its own export, which changes nothing). */
async function inspected(frame: Frame) {
  return frame.evaluate(async () => {
    type Run = (steps: unknown[], save: boolean) => Promise<{ completed: Array<{ result: { data?: string } }> }>
    const state = (window as unknown as { kitionGatewayPage: { state: { connection: { ai: { run: Run } } } } }).kitionGatewayPage.state
    const ran = await state.connection.ai.run([{ command: 'file.export', params: { format: 'html' } }], false)
    const data = ran.completed[0]?.result?.data ?? ''
    return new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)))
  })
}

/** A raw request to DeepSeek Harness's own server, as a client without its login sends it. */
function raw(pathname: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    http.get(new URL(pathname, dsh.origin), { headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    }).on('error', reject)
  })
}

test('DeepSeek Harness’s login guards /kition/: no cookie, a foreign Host or a cross-site request is refused', async () => {
  const key = '0'.repeat(32)
  for (const address of ['/kition/api/open?session=x&path=tasks.ktable', `/kition/w/${key}/page/?path=tasks.ktable`, `/kition/w/${key}/api/v1/kits`]) {
    expect(await raw(address), address).toBe(401)
    expect(await raw(address, { host: 'evil.example' }), address).toBe(403)
    expect(await raw(address, { origin: 'http://evil.example' }), address).toBe(403)
  }
  // DeepSeek Harness's own API answers the same way: the plugin's routes are no wider.
  expect(await raw('/api')).toBe(401)
})

test('a .ktable clicked in the file tree opens the real Table editor in the right sidebar; an edit marks the tab, closing it then asks first, and saved it changes the file on disk', async ({ page }) => {
  await signIn(page)
  await files(page)
  const started = Date.now()
  await page.getByText('tasks.ktable', { exact: true }).first().click()
  await expect.poll(() => !!pageFrame(page, 'tasks.ktable'), { timeout: 60_000 }).toBe(true)
  const frame = pageFrame(page, 'tasks.ktable')!
  await opened(frame)
  console.log(`table: the editor opened ${Date.now() - started} ms after the click`)
  // The frame DeepSeek Harness routes its shortcuts to: named for its tab, marked as an HTML preview.
  const attributes = await page.locator('iframe[data-kition-page]').first().evaluate((element) => ({ name: (element as HTMLIFrameElement).name, preview: element.hasAttribute('data-html-preview') }))
  expect(attributes.name).toMatch(/^dsh-sidebar-html-.+/)
  expect(attributes.preview).toBe(true)
  const kit = kitFrame(page, 'table')!
  expect(kit.url()).toContain('/kition/w/')
  // The grid is drawn by the kit; its footer counts the sample's records.
  await expect(kit.getByText('3 records')).toBeVisible()
  await page.screenshot({ path: path.join(shots, 'dsh-table-open.png') })

  const file = path.join(workspace, 'tasks.ktable')
  const before = fs.readFileSync(file)
  // The first record's title cell, where the gateway's own e2e edits it.
  const box = (await (await kit.frameElement()).boundingBox())!
  await page.mouse.dblclick(box.x + 178, box.y + 225)
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Edited in DeepSeek Harness')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-kition-dirty]').first()).toBeVisible()
  // Closing the tab now asks first; kept, it keeps the edit.
  const asked: string[] = []
  page.once('dialog', (dialog) => {
    asked.push(dialog.message())
    void dialog.dismiss()
  })
  await page.locator('[role="tab"]', { hasText: 'tasks.ktable' }).first().getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => asked).toEqual([expect.stringContaining('tasks.ktable has unsaved changes')])
  expect(pageFrame(page, 'tasks.ktable')).toBeDefined()
  await kit.locator('body').click({ position: { x: 178, y: 400 } })
  await page.keyboard.press('Meta+S')
  await expect.poll(() => fs.readFileSync(file).includes('Edited in DeepSeek Harness'), { timeout: 30_000 }).toBe(true)
  expect(Buffer.compare(before, fs.readFileSync(file))).not.toBe(0)
  await expect(page.locator('[data-kition-dirty]')).toHaveCount(0)
  await page.screenshot({ path: path.join(shots, 'dsh-table-saved.png') })
})

test('a .md keeps DeepSeek Harness’s preview and offers Kition Note under Open with; the agent’s tool edits the open editor live, and its draft shows', async ({ page }) => {
  await signIn(page)
  await files(page)
  await page.getByText('notes', { exact: true }).first().click()
  await page.getByText('plan.md', { exact: true }).first().click()
  // DeepSeek Harness's own Markdown preview is the default.
  const menu = page.locator('[data-document-viewer-menu]').first()
  await expect(menu).toBeVisible()
  expect(pageFrame(page, 'notes/plan.md')).toBeUndefined()
  await menu.click()
  await page.getByText('Kition Note', { exact: true }).first().click()
  await expect.poll(() => !!pageFrame(page, 'notes/plan.md'), { timeout: 60_000 }).toBe(true)
  const frame = pageFrame(page, 'notes/plan.md')!
  await opened(frame)
  await page.screenshot({ path: path.join(shots, 'dsh-note-open-with.png') })

  // The page follows DeepSeek Harness's theme (its system preference here).
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

  // The agent: the person asks, the scripted model calls the plugin's mcp__kition__kit_run.
  const kit = kitFrame(page, 'note')!
  await kit.evaluate(() => ((window as unknown as { e2eMark: number }).e2eMark = 1))
  const composer = page.locator('[data-composer-input]').first()
  await composer.click()
  await page.keyboard.type('Append to the plan')
  await page.keyboard.press('Enter')
  await expect.poll(() => inspected(frame), { timeout: 120_000 }).toContain(APPENDED)
  expect(await kit.evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark), 'the editor was not reloaded').toBe(1)
  // The tool's answer, as the model got it: the run happened in the open editor.
  const answered = () => model.requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)).join('\n')
  await expect.poll(answered).toContain('in its open Note editor')
  // The kits' instructions are the system prompt's MCP server section, as DeepSeek Harness's MCP client puts a server's.
  expect(JSON.stringify(model.requests.find((request) => request.tools?.length)?.messages)).toContain('### MCP server: kition')
  await expect.poll(() => fs.readFileSync(path.join(workspace, 'notes/plan.md'), 'utf8')).toContain(APPENDED)
  await page.screenshot({ path: path.join(shots, 'dsh-note-agent-live.png') })

  // A draft: the file is left as it is, the tab and the page show it for the person's review.
  await composer.click()
  await page.keyboard.type('Draft the plan')
  await page.keyboard.press('Enter')
  // An "Open with" preview's tab is DeepSeek Harness's own: the page's banner shows the draft.
  await expect(frame.getByTestId('draft-banner')).toBeVisible({ timeout: 120_000 })
  expect(fs.readFileSync(path.join(workspace, 'notes/plan.md'), 'utf8')).not.toContain(DRAFTED)
  await page.screenshot({ path: path.join(shots, 'dsh-note-draft.png') })
})

test('an agent’s draft of a file open in a Kition tab marks the tab and shows the page’s banner', async ({ page }) => {
  await signIn(page)
  await files(page)
  await page.getByText('tasks.ktable', { exact: true }).first().click()
  await expect.poll(() => !!pageFrame(page, 'tasks.ktable'), { timeout: 60_000 }).toBe(true)
  const frame = pageFrame(page, 'tasks.ktable')!
  await opened(frame)
  await expect(page.locator('[data-kition-draft]')).toHaveCount(0)
  const composer = page.locator('[data-composer-input]').first()
  await composer.click()
  await page.keyboard.type('Draft the table')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-kition-draft]').first()).toBeVisible({ timeout: 120_000 })
  await expect(frame.getByTestId('draft-banner')).toBeVisible()
  expect(fs.readFileSync(path.join(workspace, 'tasks.ktable')).includes(DRAFTED)).toBe(false)
  await page.screenshot({ path: path.join(shots, 'dsh-table-draft.png') })
})

test('the gateway the host module started stops with DeepSeek Harness', async () => {
  const run = path.join(base, 'kition/run')
  expect(fs.readdirSync(run).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  await dsh.stop()
  await expect.poll(() => fs.readdirSync(run).filter((name) => name.endsWith('.json')).length, { timeout: 30_000 }).toBe(0)
})
