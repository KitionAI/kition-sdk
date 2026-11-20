/**
 * The plugin in a real DeepSeek Harness 0.2.2-rc.5 web UI (sdk.agent.dsh-plugin/web-e2e): the packed
 * plugin installed with `dsh plugin add` into a profile from the `web` template, from a local
 * registry that holds it with @kition/cli and @kition/cli-<platform> made as the release makes
 * them (this checkout's kition inside), so the install brings the plugin's own kition: no
 * KITION_BIN, no kition on the PATH. The real Table and Note kits (headless and editor packages
 * from the kit index's release assets, as the gateway's e2e installs them), the real `kition
 * gateway` the host module starts from the plugin's kition, and a scripted model.
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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { index, installKits, kition } from '../../../../examples/gateway-page/e2e/helpers'
import { noteSample, shots, tableSample } from '../../../../examples/gateway-page/e2e/page'
import { bundledGateways, dshRuntime, here, installProfile, isolated, kitionRegistry, pathWithoutKition, plugin, repo, scratch, scriptedModel, startWeb, type Dsh } from './dsh'

const PROFILE = 'kition-e2e'
let base: string
let workspace: string
let dsh: Dsh
let model: Awaited<ReturnType<typeof scriptedModel>>
let registry: Awaited<ReturnType<typeof kitionRegistry>>

const APPENDED = 'Appended by the agent in DeepSeek Harness.'
const DRAFTED = 'Drafted by the agent in DeepSeek Harness.'
const RESTARTED = 'Appended after the gateway started again.'
const CARD_EDIT = 'Edited by the agent for its card.'
const DRAFT_ONE = 'First draft for a card.'
const DRAFT_TWO = 'Second draft for a card.'
const DRAFT_THREE = 'Third draft for a card.'

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
  fs.writeFileSync(path.join(workspace, 'notes/cards.md'), noteSample())
  fs.writeFileSync(path.join(workspace, 'notes/quiet.md'), '# Quiet\n\nNothing yet.\n')
  fs.writeFileSync(path.join(workspace, 'people.csv'), 'name,role\nAda,engineer\nGrace,admiral\n')
  fs.copyFileSync(path.join(repo, '../kition-vector/examples/dusk-poster.svg'), path.join(workspace, 'poster.svg'))
  // Vector's editor only, as its first use fetches it: its headless kit is not installed.
  installKits(path.join(base, 'kition'), ['table', 'note', 'sheet', 'vector'])
  model = await scriptedModel({
    'Append to the plan': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: APPENDED } }] } }, { say: 'Appended.' }],
    'Draft the table': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'tasks.ktable', draft: true, steps: [{ command: 'table.records.create', params: { tableId: 1, values: { title: DRAFTED } } }] } }, { say: 'Drafted.' }],
    'Append after a restart': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: RESTARTED } }] } }, { say: 'Appended.' }],
    'Card edit': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', steps: [{ command: 'block.append', params: { markdown: CARD_EDIT } }] } }, { say: 'Edited.' }],
    'Card draft one': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_ONE } }] } }, { say: 'Drafted.' }],
    'Card draft two': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_TWO } }] } }, { say: 'Drafted.' }],
    'Card draft three': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_THREE } }] } }, { say: 'Drafted.' }],
    'Read the note manifest': [{ tool: 'read_mcp_resource', arguments: { server: 'kition', uri: 'khp://kits/kit.note/kit.json' } }, { say: 'Read.' }],
    'Card draft four': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: 'Fourth draft for a card.' } }] } }, { say: 'Drafted.' }],
    'No float edit': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/quiet.md', steps: [{ command: 'block.append', params: { markdown: 'Edited without a window.' } }] } }, { say: 'Edited.' }],
    'Draft the plan': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFTED } }] } }, { say: 'Drafted.' }],
  })
  registry = await kitionRegistry(base, kition)
  const env = isolated(base, { KITION_INDEX: index, SCRIPTED_PORT: String(model.port), SCRIPTED_API_KEY: 'scripted', PATH: pathWithoutKition() })
  delete env.KITION_BIN
  const dump = installProfile(runtime, env, PROFILE, registry.archive)
  const own = path.join(base, 'dsh/profiles', PROFILE, 'node_modules', `@kition/cli-${process.platform}-${process.arch}`, 'bin/kition')
  expect(fs.existsSync(own), 'the install brought the plugin’s own kition').toBe(true)
  expect(dump).toContain('# == @kition/dsh-kits')
  dsh = await startWeb(runtime, env, PROFILE, [path.join(here, 'scripted-route.cordis.patch.yml')])
})

test.afterAll(async () => {
  await dsh?.stop()
  model?.stop()
  registry?.stop()
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
  // DeepSeek Harness shows this icon on hover only.
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

/** Clicks `file` in the file tree, its folders opened first, until a tab shows it. */
async function openInTree(page: Page, file: string) {
  const parts = file.split('/')
  const name = parts.pop()!
  for (const folder of parts) {
    const entry = page.getByText(folder, { exact: true }).first()
    if (!(await page.getByText(name, { exact: true }).first().isVisible().catch(() => false))) await entry.click()
  }
  const target = page.getByText(name, { exact: true }).first()
  await expect(target).toBeVisible()
  await expect(async () => {
    await target.click()
    await expect(page.locator('[role="tab"]', { hasText: name }).first()).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
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
  // The gateway is the plugin's own kition, from the profile's node_modules.
  expect(bundledGateways(path.join(base, 'dsh/profiles', PROFILE, 'node_modules'))).toHaveLength(1)
  // The frame DeepSeek Harness routes its shortcuts to: named for its tab, marked as an HTML preview.
  const attributes = await page.locator('iframe[data-kition-page]').first().evaluate((element) => ({ name: (element as HTMLIFrameElement).name, preview: element.hasAttribute('data-html-preview') }))
  expect(attributes.name).toMatch(/^dsh-sidebar-html-.+/)
  expect(attributes.preview).toBe(true)
  const kit = kitFrame(page, 'table')!
  expect(kit.url()).toContain('/kition/w/')
  // The grid is drawn by the kit; its footer counts the sample's records.
  await expect(kit.getByText('3 records')).toBeVisible()
  await page.screenshot({ path: path.join(shots, 'dsh-table-open.png') })

  // A DeepSeek Harness shortcut pressed in the editor reaches DeepSeek Harness: its settings
  // (Ctrl+Alt+, in the web UI, as the emulated Windows browser binds it).
  const tableBox = (await (await kit.frameElement()).boundingBox())!
  await page.mouse.click(tableBox.x + 178, tableBox.y + 400)
  await page.keyboard.press('Control+Alt+Comma')
  const language = page.getByText('Language', { exact: true }).first()
  await expect(language).toBeVisible()
  // DeepSeek Harness's language reaches the open editor's page, and back.
  await page.getByRole('button', { name: 'English' }).or(page.getByRole('combobox', { name: /English/ })).first().click()
  await page.getByRole('option', { name: /中文/ }).or(page.getByRole('menuitemradio', { name: /中文/ })).or(page.getByText(/^简体中文$|^中文$/)).first().click()
  await expect.poll(() => frame.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
  await page.screenshot({ path: path.join(shots, 'dsh-table-chinese.png') })
  await page.getByRole('button', { name: /中文/ }).or(page.getByRole('combobox', { name: /中文/ })).first().click()
  await page.getByRole('option', { name: 'English' }).or(page.getByRole('menuitemradio', { name: 'English' })).or(page.getByText(/^English$/)).first().click()
  await expect.poll(() => frame.evaluate(() => document.documentElement.lang)).toBe('en')
  await page.keyboard.press('Escape')

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
  // Reloading DeepSeek Harness now asks too (the browser's question, once, from the top page); declined, nothing reloads.
  const leaving = page.waitForEvent('dialog')
  void page.evaluate(() => location.reload()).catch(() => undefined)
  const question = await leaving
  expect(question.type()).toBe('beforeunload')
  expect(question.page()).toBe(page)
  await question.dismiss()
  await expect(page.locator('[data-kition-dirty]').first()).toBeVisible()
  // Closing the tab now asks first; kept, it keeps the edit.
  await page.locator('[role="tab"]', { hasText: 'tasks.ktable' }).first().getByRole('button', { name: 'Close' }).click()
  const asked = page.locator('[data-kition-dialog]')
  await expect(asked).toContainText('tasks.ktable has unsaved changes')
  await asked.locator('[data-kition-dialog-choice="keep"]').click()
  await expect(asked).toHaveCount(0)
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
  await openInTree(page, 'notes/plan.md')
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

  // An "Open with" tab is DeepSeek Harness's: it shows the unsaved mark too, and asks before closing.
  const note = kitFrame(page, 'note')!
  const noteBox = (await (await note.frameElement()).boundingBox())!
  await page.mouse.click(noteBox.x + 200, noteBox.y + 520)
  await page.keyboard.press('End')
  await page.keyboard.type(' Typed by the person.')
  await expect(page.locator('[data-kition-dirty]').first()).toBeVisible()
  await page.locator('[role="tab"]', { hasText: 'plan.md' }).first().getByRole('button', { name: 'Close' }).click()
  const asked = page.locator('[data-kition-dialog]')
  await expect(asked).toContainText('plan.md has unsaved changes')
  await asked.locator('[data-kition-dialog-choice="keep"]').click()
  await expect(asked).toHaveCount(0)
  expect(pageFrame(page, 'notes/plan.md')).toBeDefined()
  await page.mouse.click(noteBox.x + 200, noteBox.y + 520)
  await page.keyboard.press('Meta+S')
  await expect(page.locator('[data-kition-dirty]')).toHaveCount(0)

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
  // The run's preview picture reached the model, which takes images, as an image of the request.
  await expect.poll(() => model.requests.some((request) => JSON.stringify(request.messages).includes('"image_url"'))).toBe(true)

  // The kits' resources, through DeepSeek Harness's resource tools: the Note kit's manifest.
  await composer.click()
  await page.keyboard.type('Read the note manifest')
  await page.keyboard.press('Enter')
  await expect.poll(answered, { timeout: 120_000 }).toContain('kit.note')
  expect(model.requests.some((request) => request.tools?.some((tool) => tool.function.name === 'read_mcp_resource'))).toBe(true)

  // The gateway dies: the next agent edit starts it again (the proxy reads its new token), and the
  // open editor's bridge connects to it again, so the edit still arrives live.
  const lockfiles = fs.readdirSync(path.join(base, 'kition/run')).filter((name) => name.endsWith('.json'))
  const killed = JSON.parse(fs.readFileSync(path.join(base, 'kition/run', lockfiles[0]), 'utf8')) as { pid: number; token: string }
  process.kill(killed.pid, 'SIGKILL')
  await composer.click()
  await page.keyboard.type('Append after a restart')
  await page.keyboard.press('Enter')
  await expect.poll(() => inspected(frame), { timeout: 120_000 }).toContain(RESTARTED)
  expect(await kit.evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark), 'the editor was not reloaded').toBe(1)
  const restarted = JSON.parse(fs.readFileSync(path.join(base, 'kition/run', fs.readdirSync(path.join(base, 'kition/run')).find((name) => name.endsWith('.json'))!), 'utf8')) as { pid: number; token: string }
  expect(restarted.pid).not.toBe(killed.pid)
  expect(restarted.token).not.toBe(killed.token)

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

/**
 * The card of `file` in the conversation's latest turn tail that has one. Its buttons are pressed
 * with a dispatched click: DeepSeek Harness's floating panel may lie over the conversation.
 */
/** The cards test's session, by its row in the session list. */
let cardsRow: string | null = null

/** DeepSeek Harness's language, set in its settings (Ctrl+Alt+, in the web UI). */
async function language(page: Page, to: 'zh' | 'en') {
  await page.locator('[data-composer-input]').first().click()
  await page.keyboard.press('Control+Alt+Comma')
  await expect(page.getByText(to === 'zh' ? 'Language' : '语言', { exact: true }).first()).toBeVisible()
  const from = to === 'zh' ? 'English' : /中文/
  await page.getByRole('button', { name: from }).or(page.getByRole('combobox', { name: from })).first().click()
  if (to === 'zh') await page.getByRole('option', { name: /中文/ }).or(page.getByRole('menuitemradio', { name: /中文/ })).or(page.getByText(/^简体中文$|^中文$/)).first().click()
  else await page.getByRole('option', { name: 'English' }).or(page.getByRole('menuitemradio', { name: 'English' })).or(page.getByText(/^English$/)).first().click()
  await page.keyboard.press('Escape')
}

/** Whether `inner` lies wholly inside `outer`. */
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5

const card = (page: Page, file: string) => page.locator(`[data-kition-card="${file}"]`).last()
const say = async (page: Page, text: string) => {
  await page.locator('[data-composer-input]').first().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('review cards: the first edit of a file not open runs live in the live window, which covers nothing and leaves the keyboard; Open, Review in the sidebar, Merge, Discard, Merge and overwrite with real clicks, the open editor following; a draft merged outside shows neutrally; a reload and another browser show the same cards', async ({ page, browser }) => {
  await signIn(page)
  const file = path.join(workspace, 'notes/cards.md')

  // The first edit of a file not open: the host announces it, the live window opens it and its
  // editor attaches before the edit runs, so the edit runs there (live); the composer keeps the keyboard.
  await say(page, 'Card edit')
  await expect(card(page, 'notes/cards.md')).toHaveAttribute('data-state', 'live', { timeout: 120_000 })
  expect(pageFrame(page, 'notes/cards.md')?.url() ?? '').toContain('focus=no')
  const answered = () => model.requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)).join('\n')
  await expect.poll(answered).toContain('`notes/cards.md` in its open Note editor')
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-composer-input') ?? false)).toBe(true)
  expect(fs.readFileSync(file, 'utf8')).toContain(CARD_EDIT)
  // The window does not cover the conversation: in this window there is no room beside it, so it is in the sidebar.
  const composerBox = (await page.locator('[data-composer-input]').first().boundingBox())!
  const windowBox = (await page.locator('iframe[data-kition-page]').last().boundingBox())!
  expect(windowBox.x).toBeGreaterThanOrEqual(composerBox.x + composerBox.width)
  await page.screenshot({ path: path.join(shots, 'dsh-card-live.png') })
  // Its card's Open, a real click: the file in the sidebar.
  await card(page, 'notes/cards.md').locator('[data-kition-card-action="open"]').click()
  const frame = pageFrame(page, 'notes/cards.md')!
  await opened(frame)

  // A draft: its card's Review opens the page's review in the sidebar, then Merge from the card.
  await say(page, 'Card draft one')
  const one = card(page, 'notes/cards.md')
  await expect(one).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  await expect(one.locator('[data-kition-card-changes]')).toBeVisible()
  await one.locator('[data-kition-card-action="review"]').click()
  await expect.poll(async () => (await pageFrame(page, 'notes/cards.md')?.getByTestId('draft-review').isVisible().catch(() => false)) ?? false, { timeout: 30_000 }).toBe(true)
  const reviewing = pageFrame(page, 'notes/cards.md')!
  // The review takes the editor's place at the sidebar's width: the banner is not left behind it.
  await expect(reviewing.getByTestId('draft-banner')).toBeHidden()
  const review = (await reviewing.locator('.dialog').boundingBox())!
  const reviewFrame = (await (await reviewing.frameElement()).boundingBox())!
  expect(review.width).toBeGreaterThan(reviewFrame.width - 2)
  await expect(reviewing.getByTestId('draft-counts')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(shots, 'dsh-card-review.png') })
  await reviewing.getByTestId('dialog-close').click()
  await one.locator('[data-kition-card-action="merge"]').click()
  await expect(one).toHaveAttribute('data-state', 'merged', { timeout: 60_000 })
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(DRAFT_ONE)
  await expect.poll(() => inspected(pageFrame(page, 'notes/cards.md')!), { timeout: 60_000 }).toContain(DRAFT_ONE)
  await page.screenshot({ path: path.join(shots, 'dsh-card-merged.png') })

  // Another draft, discarded from its card (after the person confirms in the page's own dialog).
  await say(page, 'Card draft two')
  const two = card(page, 'notes/cards.md')
  await expect(two).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  await two.locator('[data-kition-card-action="discard"]').click()
  await page.locator('[data-kition-dialog-choice="discard"]').click()
  await expect(two).toHaveAttribute('data-state', 'discarded', { timeout: 60_000 })
  expect(fs.readFileSync(file, 'utf8')).not.toContain(DRAFT_TWO)

  // A draft whose file changed since it began: Merge and overwrite.
  await say(page, 'Card draft three')
  const three = card(page, 'notes/cards.md')
  await expect(three).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  fs.appendFileSync(file, '\nChanged by the person outside the editor.\n')
  await expect(three).toHaveAttribute('data-state', 'stale', { timeout: 60_000 })
  await expect(three.locator('[data-kition-card-action="merge"]')).toHaveCount(0)
  await three.locator('[data-kition-card-action="overwrite"]').click()
  await expect(three).toHaveAttribute('data-state', 'merged', { timeout: 60_000 })
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(DRAFT_THREE)
  await page.screenshot({ path: path.join(shots, 'dsh-card-overwrite.png') })

  // A draft merged outside DeepSeek Harness (the command line): its card says only that the draft is gone.
  await say(page, 'Card draft four')
  const four = card(page, 'notes/cards.md')
  await expect(four).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), 'drafts', 'merge', 'notes/cards.md', '--workspace', workspace, '--overwrite'], { env: isolated(base, { KITION_KITS_MCP: kition, KITION_INDEX: index }), stdio: 'pipe' })
  await expect(four).toHaveAttribute('data-state', 'draft-gone', { timeout: 60_000 })

  // The conversation loaded again, and in another browser, shows the same cards: the host keeps the reviews.
  const expected = ['live', 'merged', 'discarded', 'merged', 'draft-gone']
  const states = (on: Page) => on.locator('[data-kition-card="notes/cards.md"]').evaluateAll((cards) => cards.map((element) => element.getAttribute('data-state')))
  // The web UI keeps the open session in the browser, not in its address: the other browser picks it in the list.
  const row = await page.locator('[role="treeitem"][aria-selected="true"][data-row-key^="session:"]').first().getAttribute('data-row-key')
  cardsRow = row
  await page.reload()
  await expect.poll(() => states(page), { timeout: 60_000 }).toEqual(expected)
  await page.screenshot({ path: path.join(shots, 'dsh-cards-reloaded.png') })
  const other = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  try {
    const elsewhere = await other.newPage()
    await elsewhere.goto(dsh.url)
    await elsewhere.getByRole('button', { name: 'Continue' }).click({ timeout: 15_000 }).catch(() => {})
    await elsewhere.locator(`[data-row-key="${row}"]`).click()
    await expect.poll(() => states(elsewhere), { timeout: 60_000 }).toEqual(expected)
  } finally {
    await other.close()
  }
})

test('in Chinese and dark, in a narrower window: the cards, a tab’s marks, the review and the settings card are whole, unclipped and in Chinese', async ({ page }) => {
  expect(cardsRow, 'the cards test ran first').not.toBeNull()
  await page.setViewportSize({ width: 1180, height: 820 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(dsh.url)
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 15_000 }).catch(() => {})
  await page.locator(`[data-row-key="${cardsRow}"]`).click()
  await language(page, 'zh')
  try {
    const chinese = /[\u4e00-\u9fff]/
    const cards = page.locator('[data-kition-card]')
    await expect(cards.first()).toBeVisible({ timeout: 30_000 })
    // A new draft: its card's actions, and the tab's Draft mark.
    const before = await cards.count()
    await say(page, 'Card draft one')
    await expect(cards).toHaveCount(before + 1, { timeout: 120_000 })
    const drafted = card(page, 'notes/cards.md')
    await expect(drafted).not.toHaveAttribute('data-state', 'pending', { timeout: 120_000 })
    const toolAnswers = () => model.requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content))
    expect(await drafted.getAttribute('data-state'), `the agent's last tool answer: ${toolAnswers().at(-1)}`).toBe('draft-open')
    // Each card measured at once, in the page, and again until the cards settle (they render as the turn ends).
    const problems = () =>
      cards.evaluateAll((all, pattern) =>
        all.flatMap((card, index) => {
          const box = card.getBoundingClientRect()
          const found: string[] = []
          for (const button of card.querySelectorAll('button')) {
            const own = button.getBoundingClientRect()
            if (own.left < box.left - 0.5 || own.top < box.top - 0.5 || own.right > box.right + 0.5 || own.bottom > box.bottom + 0.5) found.push(`card ${index}: ${button.textContent} outside`)
            if (!new RegExp(pattern).test(button.textContent ?? '')) found.push(`card ${index}: ${button.textContent} not in Chinese`)
          }
          for (const child of card.querySelectorAll<HTMLElement>('*')) if (child.scrollWidth > child.clientWidth + 1 && getComputedStyle(child).textOverflow !== 'ellipsis') found.push(`card ${index}: ${child.tagName} ${child.textContent?.slice(0, 30)} overflows`)
          return found
        }), chinese.source)
    await expect.poll(problems, { timeout: 15_000 }).toEqual([])
    await page.screenshot({ path: path.join(shots, 'dsh-zh-dark-cards.png') })
    await drafted.locator('[data-kition-card-action="open"]').click()
    const mark = page.locator('[data-kition-draft]').first()
    await expect(mark).toBeVisible({ timeout: 60_000 })
    const tab = page.locator('[role="tab"]', { has: mark }).first()
    const tabBox = (await tab.boundingBox())!
    const markBox = (await mark.boundingBox())!
    // Whole, and clear of the last 30 px, which DeepSeek Harness fades under the tab's close button.
    expect(inside(markBox, tabBox)).toBe(true)
    expect(markBox.x + markBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width - 30)
    expect(await mark.innerText()).toMatch(chinese)
    await drafted.locator('[data-kition-card-action="review"]').click()
    await expect.poll(async () => (await pageFrame(page, 'notes/cards.md')?.getByTestId('draft-review').isVisible().catch(() => false)) ?? false, { timeout: 30_000 }).toBe(true)
    const reviewing = pageFrame(page, 'notes/cards.md')!
    await expect(reviewing.getByTestId('draft-counts')).toBeVisible({ timeout: 30_000 })
    // The review fills the frame; its buttons are on its bottom edge while the review scrolls
    // (nothing shows below them), else after its content.
    const placed = () =>
      reviewing.evaluate(() => {
        const dialog = document.querySelector('.dialog')!.getBoundingClientRect()
        const scrolls = document.querySelector('.dialog')!.scrollHeight > document.querySelector('.dialog')!.clientHeight + 1
        const actions = document.querySelector('.review__actions')!.getBoundingClientRect()
        const fills = Math.abs(dialog.width - innerWidth) <= 1 && Math.abs(dialog.height - innerHeight) <= 1
        return fills && (scrolls ? Math.abs(actions.bottom - dialog.bottom) <= 1 : actions.bottom <= dialog.bottom + 1)
      })
    await expect.poll(placed).toBe(true)
    expect(await reviewing.locator('.review__actions').innerText()).toMatch(chinese)
    await page.screenshot({ path: path.join(shots, 'dsh-zh-dark-review.png') })
    await reviewing.getByTestId('dialog-close').click()
    await drafted.locator('[data-kition-card-action="discard"]').click()
    await expect(page.locator('[data-kition-dialog]')).toContainText(chinese)
    await page.screenshot({ path: path.join(shots, 'dsh-zh-dark-dialog.png') })
    await page.locator('[data-kition-dialog-choice="discard"]').click()
    await expect(drafted).toHaveAttribute('data-state', 'discarded', { timeout: 60_000 })
    // The settings card, on the plugin's page.
    await page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: /^插件$/ }).first().click()
    await page.getByText('@kition/dsh-kits', { exact: true }).first().click()
    const settings = page.locator('[data-kition-setting]').first()
    await expect(settings).toBeVisible()
    const form = page.locator('[data-kition-settings]').first()
    expect(await form.innerText()).toMatch(chinese)
    expect(await form.evaluate((element) => [...element.querySelectorAll<HTMLElement>('*')].every((child) => child.scrollWidth <= child.clientWidth + 1)), 'nothing in the settings card overflows').toBe(true)
    await page.screenshot({ path: path.join(shots, 'dsh-zh-dark-settings.png') })
  } finally {
    // Back in the session (the plugin's page has no composer), DeepSeek Harness in English again for the tests after.
    await page.keyboard.press('Escape')
    await page.locator(`[data-row-key="${cardsRow}"]`).click()
    await language(page, 'en')
  }
})

test('the live window is the person’s setting: turned off on the plugin’s page, an edit of a file not open opens nothing', async ({ page }) => {
  await signIn(page)
  await page.getByText('Plugins', { exact: true }).first().click()
  await page.getByText('@kition/dsh-kits', { exact: true }).first().click()
  const toggle = page.locator('[data-kition-setting="liveFloat"]')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect.poll(() => toggle.isChecked()).toBe(false)
  await expect.poll(() => fs.readFileSync(path.join(base, 'dsh/profiles', PROFILE, 'cordis.patch.yml'), 'utf8')).toContain('liveFloat: false')
  await signIn(page)
  await say(page, 'No float edit')
  await expect(card(page, 'notes/quiet.md')).toHaveAttribute('data-state', /saved|live/, { timeout: 120_000 })
  await page.waitForTimeout(2000)
  expect(pageFrame(page, 'notes/quiet.md')).toBeUndefined()
  expect(fs.readFileSync(path.join(workspace, 'notes/quiet.md'), 'utf8')).toContain('Edited without a window.')
})

test('a kit’s view-only format opens read-only: a .csv in Kition Sheet from Open with', async ({ page }) => {
  await signIn(page)
  await files(page)
  await openInTree(page, 'people.csv')
  const menu = page.locator('[data-document-viewer-menu]').first()
  await expect(menu).toBeVisible()
  await menu.click()
  await page.getByText('Kition Sheet', { exact: true }).first().click()
  await expect.poll(() => !!pageFrame(page, 'people.csv'), { timeout: 60_000 }).toBe(true)
  const frame = pageFrame(page, 'people.csv')!
  await opened(frame)
  expect(await frame.evaluate(() => (window as unknown as { kitionGatewayPage: { state: { readOnly: boolean; kit: string } } }).kitionGatewayPage.state)).toMatchObject({ readOnly: true, kit: 'kit.sheet' })
  await expect(page.locator('[data-kition-readonly]').first()).toBeVisible()
  await page.screenshot({ path: path.join(shots, 'dsh-csv-read-only.png') })
})

test('a view-only format of a kit not installed opens read-only, the kit index saying which kit views it: a .svg in Kition Vector', async ({ page }) => {
  expect(fs.existsSync(path.join(base, 'kition/kits/vector'))).toBe(true)
  expect(fs.readdirSync(path.join(base, 'kition/kits/vector'))).toEqual(['ui'])
  await signIn(page)
  await files(page)
  await openInTree(page, 'poster.svg')
  const menu = page.locator('[data-document-viewer-menu]').first()
  await expect(menu).toBeVisible()
  await menu.click()
  await page.getByText('Kition Vector', { exact: true }).first().click()
  await expect.poll(() => !!pageFrame(page, 'poster.svg'), { timeout: 60_000 }).toBe(true)
  const frame = pageFrame(page, 'poster.svg')!
  await opened(frame)
  expect(await frame.evaluate(() => (window as unknown as { kitionGatewayPage: { state: { readOnly: boolean; kit: string } } }).kitionGatewayPage.state)).toMatchObject({ readOnly: true, kit: 'kit.vector' })
  await page.screenshot({ path: path.join(shots, 'dsh-svg-read-only.png') })
})

test('the gateway the host module started stops with DeepSeek Harness', async () => {
  const run = path.join(base, 'kition/run')
  expect(fs.readdirSync(run).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  await dsh.stop()
  await expect.poll(() => fs.readdirSync(run).filter((name) => name.endsWith('.json')).length, { timeout: 30_000 }).toBe(0)
})
