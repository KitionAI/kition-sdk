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
  installKits(path.join(base, 'kition'), ['table', 'note', 'sheet'])
  model = await scriptedModel({
    'Append to the plan': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: APPENDED } }] } }, { say: 'Appended.' }],
    'Draft the table': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'tasks.ktable', draft: true, steps: [{ command: 'table.records.create', params: { tableId: 1, values: { title: DRAFTED } } }] } }, { say: 'Drafted.' }],
    'Append after a restart': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: RESTARTED } }] } }, { say: 'Appended.' }],
    'Card edit': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', steps: [{ command: 'block.append', params: { markdown: CARD_EDIT } }] } }, { say: 'Edited.' }],
    'Card draft one': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_ONE } }] } }, { say: 'Drafted.' }],
    'Card draft two': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_TWO } }] } }, { say: 'Drafted.' }],
    'Card draft three': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/cards.md', draft: true, steps: [{ command: 'block.append', params: { markdown: DRAFT_THREE } }] } }, { say: 'Drafted.' }],
    'Read the note manifest': [{ tool: 'read_mcp_resource', arguments: { server: 'kition', uri: 'khp://kits/kit.note/kit.json' } }, { say: 'Read.' }],
    'No float edit': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'notes/quiet.md', steps: [{ command: 'block.append', params: { markdown: 'Edited without a window.' } }] } }, { say: 'Edited.' }],
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
  const asked: string[] = []
  page.once('dialog', (dialog) => {
    asked.push(dialog.message())
    void dialog.dismiss()
  })
  await page.locator('[role="tab"]', { hasText: 'plan.md' }).first().getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => asked).toEqual([expect.stringContaining('plan.md has unsaved changes')])
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
const card = (page: Page, file: string) => page.locator(`[data-kition-card="${file}"]`).last()
const say = async (page: Page, text: string) => {
  await page.locator('[data-composer-input]').first().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('review cards: a live edit’s card opens the file; a draft’s card reviews, merges, discards and overwrites a stale draft, and the open editor follows; a float shows an edit of a file not open without taking the keyboard; reload keeps the cards', async ({ page }) => {
  await signIn(page)
  const file = path.join(workspace, 'notes/cards.md')

  // An edit of a file not open: a floating window shows it, the composer keeps the keyboard.
  await say(page, 'Card edit')
  await expect(card(page, 'notes/cards.md')).toHaveAttribute('data-state', /saved|live/, { timeout: 120_000 })
  await expect.poll(() => pageFrame(page, 'notes/cards.md')?.url() ?? '', { timeout: 60_000 }).toContain('focus=no')
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-composer-input') ?? false)).toBe(true)
  expect(fs.readFileSync(file, 'utf8')).toContain(CARD_EDIT)
  await page.screenshot({ path: path.join(shots, 'dsh-card-float.png') })
  // Its card's Open opens the file in the sidebar.
  await card(page, 'notes/cards.md').locator('[data-kition-card-action="open"]').dispatchEvent('click')
  await expect.poll(() => page.frames().filter((frame) => frame.url().includes('/page/') && frame.url().includes(encodeURIComponent('notes/cards.md'))).length).toBeGreaterThan(0)
  const frame = pageFrame(page, 'notes/cards.md')!
  await opened(frame)

  // A draft: its card offers Review, which opens the page's review, then Merge from the card.
  await say(page, 'Card draft one')
  const one = card(page, 'notes/cards.md')
  await expect(one).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  await expect(one.locator('[data-kition-card-changes]')).toBeVisible()
  await one.locator('[data-kition-card-action="review"]').dispatchEvent('click')
  await expect(frame.getByTestId('draft-review')).toBeVisible()
  await page.screenshot({ path: path.join(shots, 'dsh-card-review.png') })
  await frame.locator('body').press('Escape')
  await one.locator('[data-kition-card-action="merge"]').dispatchEvent('click')
  await expect(one).toHaveAttribute('data-state', 'merged', { timeout: 60_000 })
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(DRAFT_ONE)
  await expect.poll(() => inspected(pageFrame(page, 'notes/cards.md')!), { timeout: 60_000 }).toContain(DRAFT_ONE)
  await page.screenshot({ path: path.join(shots, 'dsh-card-merged.png') })

  // Another draft, discarded from its card (after the person confirms).
  await say(page, 'Card draft two')
  const two = card(page, 'notes/cards.md')
  await expect(two).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  page.once('dialog', (dialog) => void dialog.accept())
  await two.locator('[data-kition-card-action="discard"]').dispatchEvent('click')
  await expect(two).toHaveAttribute('data-state', 'discarded', { timeout: 60_000 })
  expect(fs.readFileSync(file, 'utf8')).not.toContain(DRAFT_TWO)

  // A draft whose file changed since it began: Merge and overwrite.
  await say(page, 'Card draft three')
  const three = card(page, 'notes/cards.md')
  await expect(three).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
  fs.appendFileSync(file, '\nChanged by the person outside the editor.\n')
  await expect(three).toHaveAttribute('data-state', 'stale', { timeout: 60_000 })
  await expect(three.locator('[data-kition-card-action="merge"]')).toHaveCount(0)
  await three.locator('[data-kition-card-action="overwrite"]').dispatchEvent('click')
  await expect(three).toHaveAttribute('data-state', 'merged', { timeout: 60_000 })
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain(DRAFT_THREE)
  await page.screenshot({ path: path.join(shots, 'dsh-card-overwrite.png') })

  // The conversation loaded again shows the same cards.
  await page.reload()
  const states = () => page.locator('[data-kition-card="notes/cards.md"]').evaluateAll((cards) => cards.map((element) => element.getAttribute('data-state')))
  await expect.poll(states, { timeout: 60_000 }).toEqual([expect.stringMatching(/saved|live/), 'merged', 'discarded', 'merged'])
  await page.screenshot({ path: path.join(shots, 'dsh-cards-reloaded.png') })
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

test('the gateway the host module started stops with DeepSeek Harness', async () => {
  const run = path.join(base, 'kition/run')
  expect(fs.readdirSync(run).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  await dsh.stop()
  await expect.poll(() => fs.readdirSync(run).filter((name) => name.endsWith('.json')).length, { timeout: 30_000 }).toBe(0)
})
