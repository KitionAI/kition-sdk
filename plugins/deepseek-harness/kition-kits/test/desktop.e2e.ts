/**
 * The plugin in the installed DeepSeek Harness Desktop (sdk.agent.dsh-plugin/desktop-smoke, macOS,
 * local only): the app runs with a HOME, a DSH_HOME and an Electron user data folder of its own
 * (the person's Desktop profile and data are never read or written, and an instance of theirs that
 * is open keeps running), with no KITION_BIN and no kition on the PATH; the plugin's .tgz is
 * installed into its `desktop` profile with the app's own CLI from a local registry that holds
 * @kition/cli and this platform's package (test/registry.mjs), so its own kition comes with it and
 * runs the gateway; and a `.ktable` clicked in the file tree opens the real Table editor in the right
 * sidebar, served through the app's dsh-app:// forwarding; Cmd+W pressed in the editor reaches
 * DeepSeek Harness (the frame is one it routes shortcuts to) and closes the tab; and a scripted
 * agent's `mcp__kition__kit_run` (the profile's own patch layer routes the model to it) adds a record
 * in the open editor, live; its draft of another record shows a review card in the turn's tail, and
 * Merge on the card merges it, the open editor following; its edit of a file not open shows in a
 * floating window; and the plugin's settings card writes the setting into the profile.
 *
 * DSH_DESKTOP_APP names the app (default /Applications/DeepSeek Harness.app). No account is signed
 * in, no model configured, no update accepted.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { index, installKits, kition } from '../../../../examples/gateway-page/e2e/helpers'
import { shots, tableSample } from '../../../../examples/gateway-page/e2e/page'
import { bundledGateways, checkOwnKition, here, isolated, kitionRegistry, pathWithoutKition, scratch, scriptedModel } from './dsh'
import { assertServed, writeNpmrc } from './registry.mjs'

const app = process.env.DSH_DESKTOP_APP || '/Applications/DeepSeek Harness.app'
const executable = path.join(app, 'Contents/MacOS/DeepSeek Harness')
const cli = path.join(app, 'Contents/Resources/runtime/cli/bin/dsh')

test.skip(!fs.existsSync(executable), `no DeepSeek Harness Desktop at ${app}`)
test.describe.configure({ mode: 'serial' })

let base: string
let env: NodeJS.ProcessEnv
let model: Awaited<ReturnType<typeof scriptedModel>>
const ADDED = 'Added by the agent in DeepSeek Harness Desktop'
const DRAFTED = 'Drafted by the agent in DeepSeek Harness Desktop'

async function launch(): Promise<{ desktop: ElectronApplication; page: Page }> {
  const desktop = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(base, 'userdata')}`], env: env as Record<string, string>, timeout: 120_000 })
  let page: Page | undefined
  await expect.poll(() => (page = desktop.windows().find((window) => window.url().startsWith('dsh-app://app'))) !== undefined, { timeout: 120_000 }).toBe(true)
  // The test's `use` options do not reach an Electron window: its actions are bounded here.
  page!.setDefaultTimeout(30_000)
  return { desktop, page: page! }
}

/**
 * Closes the app. One that is still open after a minute fails the test, and is ended (the test
 * started it): a window that refuses to close (a page's `beforeunload` in Electron, which asks
 * nobody) would otherwise hold the test until its own timeout.
 */
async function quit(desktop: ElectronApplication) {
  const closed = await Promise.race([desktop.close().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000))])
  if (closed) return
  desktop.process().kill('SIGKILL')
  throw new Error('DeepSeek Harness Desktop did not close within a minute')
}

let registry: Awaited<ReturnType<typeof kitionRegistry>>

test.afterAll(() => {
  model?.stop()
  registry?.stop()
})

/**
 * The environment of an isolated app at `folder`: the plugin's own kition only (no KITION_BIN, no
 * kition on the PATH), every package from the test's registry.
 */
function bare(folder: string) {
  writeNpmrc(folder, registry.url)
  const bareEnv = isolated(folder, { KITION_INDEX: index, SCRIPTED_PORT: String(model.port), SCRIPTED_API_KEY: 'scripted', PATH: pathWithoutKition() })
  delete bareEnv.KITION_BIN
  return bareEnv
}

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true })
  model = await scriptedModel({
    'Add a record': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'tasks.ktable', steps: [{ command: 'record.add', params: { tableId: 1, values: { title: ADDED } } }] } }, { say: 'Added.' }],
    'Add to the later table': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'later.ktable', steps: [{ command: 'record.add', params: { tableId: 1, values: { title: ADDED } } }] } }, { say: 'Added.' }],
    'Draft a record': [{ tool: 'mcp__kition__kit_run', arguments: { path: 'tasks.ktable', draft: true, steps: [{ command: 'record.add', params: { tableId: 1, values: { title: DRAFTED } } }] } }, { say: 'Drafted.' }],
  })
  base = scratch('desktop')
  const workspace = path.join(base, 'home/Documents/deepseek-harness/default-workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.copyFileSync(tableSample(), path.join(workspace, 'tasks.ktable'))
  fs.copyFileSync(tableSample(), path.join(workspace, 'later.ktable'))
  installKits(path.join(base, 'kition'), ['table'])
  registry = await kitionRegistry(base, kition)
  env = bare(base)
})

test('the app’s CLI installs the plugin into the Desktop profile; a .ktable opens in the real Table editor, Cmd+W there closes the tab, an agent’s kit tool edits it live, a draft’s card merges it, the live window opens, and the settings are kept', async () => {
  const t0 = Date.now()
  const mark = (what: string) => console.log(`desktop: ${what} at ${Date.now() - t0} ms`)
  // The app makes its profile on its first start.
  await test.step('the first start makes the profile', async () => {
    const first = await launch()
    mark('first window')
    await expect.poll(() => fs.existsSync(path.join(base, 'dsh/profiles/desktop/package.json')), { timeout: 60_000 }).toBe(true)
    mark('profile made')
    await quit(first.desktop)
    mark('first app closed')
  })
  await test.step('the app’s CLI installs the plugin', async () => {
    // The scripted model as the profile's own layer (Desktop takes no --patch).
    fs.copyFileSync(path.join(here, 'scripted-route.cordis.patch.yml'), path.join(base, 'dsh/profiles/desktop/cordis.patch.yml'))
    const before = registry.requests.length
    execFileSync(cli, ['plugin', '--profile', 'desktop', 'add', registry.archive], { env, cwd: env.HOME, stdio: 'pipe', timeout: 120_000 })
    expect(JSON.parse(fs.readFileSync(path.join(base, 'dsh/profiles/desktop/package.json'), 'utf8')).dsh.profile.bundles).toContain('@kition/dsh-kits')
    // With the plugin came its kition: @kition/cli and this platform's package.
    expect(fs.existsSync(path.join(base, `dsh/profiles/desktop/node_modules/@kition/cli-${process.platform}-${process.arch}/bin/kition`))).toBe(true)
    // From the local registry, the packed kition itself, with the gateway command.
    expect(await checkOwnKition(base, 'desktop', kition, () => registry.requests.slice(before))).toContain('bin/kition')
    mark('plugin installed')
  })

  const { desktop, page } = await test.step('the second start', () => launch())
  mark('second window')
  try {
    // The first-run notice shows on the first start only.
    if (await page.getByRole('button', { name: 'Continue' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Continue' }).click()
    await page.locator('[aria-label="New session in Default workspace"]').first().dispatchEvent('click')
    mark('session')
    await page.getByRole('button', { name: 'Close' }).first().click({ timeout: 5_000 }).catch(() => {})
    if (await page.getByRole('button', { name: 'Open right sidebar' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Open right sidebar' }).click()
    await page.getByText('Workspace files').first().click({ timeout: 10_000 }).catch(() => {})
    const started = Date.now()
    await page.getByText('tasks.ktable', { exact: true }).first().click({ timeout: 30_000 })
    const pageFrame = () => page.frames().find((frame) => frame.url().includes('/kition/w/') && frame.url().includes('/page/'))
    await expect.poll(() => !!pageFrame(), { timeout: 60_000 }).toBe(true)
    await pageFrame()!.waitForFunction(() => (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status === 'open', null, { timeout: 120_000 })
    console.log(`desktop: the Table editor opened ${Date.now() - started} ms after the click`)
    expect(bundledGateways(path.join(base, 'dsh/profiles/desktop/node_modules')), 'the gateway is the plugin’s own kition').toHaveLength(1)
    expect(pageFrame()!.url()).toMatch(/^dsh-app:\/\/app\/kition\/w\/[0-9a-f]{32}\/page\//)
    const kit = page.frames().find((frame) => frame.url().includes('/kits-ui/table@'))!
    await expect(kit.getByText('3 records')).toBeVisible()
    await page.screenshot({ path: path.join(shots, 'dsh-desktop-table-open.png') })

    // Cmd+W in the editor: the app hands it to DeepSeek Harness, which closes the tab.
    const box = (await (await kit.frameElement()).boundingBox())!
    await page.mouse.click(box.x + 178, box.y + 400)
    // Electron's main process, typed loosely: the test has no Electron typings.
    type Window = { focus(): void; webContents: { getURL(): string; sendInputEvent(event: { type: string; keyCode: string; modifiers: string[] }): void } }
    await desktop.evaluate(async (main) => {
      const { BrowserWindow } = main as unknown as { BrowserWindow: { getAllWindows(): Window[] } }
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('dsh-app://app'))!
      window.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] })
    })
    await expect.poll(() => !!pageFrame(), { timeout: 15_000 }).toBe(false)

    // The agent's kit tool, through the plugin in the Desktop host, edits the file open in the editor, live.
    await page.getByText('tasks.ktable', { exact: true }).first().click({ timeout: 30_000 })
    await expect.poll(() => !!pageFrame(), { timeout: 60_000 }).toBe(true)
    await pageFrame()!.waitForFunction(() => (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status === 'open', null, { timeout: 120_000 })
    const table = page.frames().find((frame) => frame.url().includes('/kits-ui/table@'))!
    await table.evaluate(() => ((window as unknown as { e2eMark: number }).e2eMark = 1))
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type('Add a record')
    await page.keyboard.press('Enter')
    await expect(table.getByText('4 records')).toBeVisible({ timeout: 120_000 })
    expect(await table.evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark), 'the editor was not reloaded').toBe(1)
    // The tool's answer, as the model got it: the run happened in the open editor.
    const answered = () => model.requests.flatMap((request) => request.messages).filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)).join('\n')
    await expect.poll(answered).toContain('in its open Table editor')
    await page.screenshot({ path: path.join(shots, 'dsh-desktop-agent-live.png') })

    // The turn's review card: an agent's draft, merged by the person from the card; the open editor follows.
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type('Draft a record')
    await page.keyboard.press('Enter')
    const card = page.locator('[data-kition-card="tasks.ktable"]').last()
    await expect(card).toHaveAttribute('data-state', 'draft-open', { timeout: 120_000 })
    await card.locator('[data-kition-card-action="merge"]').click()
    await expect(card).toHaveAttribute('data-state', 'merged', { timeout: 60_000 })
    await expect.poll(() => fs.readFileSync(path.join(base, 'home/Documents/deepseek-harness/default-workspace/tasks.ktable')).includes(DRAFTED), { timeout: 30_000 }).toBe(true)
    await expect(table.getByText('5 records')).toBeVisible({ timeout: 60_000 })
    await page.screenshot({ path: path.join(shots, 'dsh-desktop-card-merged.png') })

    // The live window: an edit of a file not open shows in a floating window.
    await page.locator('[data-composer-input]').first().click()
    await page.keyboard.type('Add to the later table')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.frames().find((frame) => frame.url().includes('/page/') && frame.url().includes('later.ktable'))?.url() ?? '', { timeout: 120_000 }).toContain('focus=no')
    // The edit waited for the window's editor and ran in it, live; and the turn ends. (Quitting
    // while a turn runs, Desktop asks first in a native message box, which nothing here answers:
    // the test's close then waited until its timeout.)
    await expect(page.locator('[data-kition-card="later.ktable"]').last()).toHaveAttribute('data-state', 'live', { timeout: 60_000 })
    await expect(page.getByText('Added.', { exact: true })).toHaveCount(2, { timeout: 60_000 })
    await page.screenshot({ path: path.join(shots, 'dsh-desktop-live-window.png') })

    // The settings, on the plugin's page, kept in the profile.
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByText('@kition/dsh-kits', { exact: true }).first().click()
    const toggle = page.locator('[data-kition-setting="liveFloat"]')
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect.poll(() => fs.readFileSync(path.join(base, 'dsh/profiles/desktop/cordis.patch.yml'), 'utf8')).toContain('liveFloat: false')
  } catch (error) {
    // The test's own failure first; a close that also fails is said after it.
    await quit(desktop).catch((closing) => console.error(`desktop: ${String(closing)}`))
    throw error
  }
  await test.step('the app closes', () => quit(desktop))
})

test('the Plugins page installs the plugin by its name, with its own kition; a .ktable then opens in the Table editor, and the app closes with unsaved edits in it', async () => {
  const own = scratch('desktop-page')
  const ownEnv = bare(own)
  const workspace = path.join(own, 'home/Documents/deepseek-harness/default-workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.copyFileSync(tableSample(), path.join(workspace, 'tasks.ktable'))
  installKits(path.join(own, 'kition'), ['table'])
  const open = async () => {
    const desktop = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(own, 'userdata')}`], env: ownEnv as Record<string, string>, timeout: 120_000 })
    let page: Page | undefined
    await expect.poll(() => (page = desktop.windows().find((window) => window.url().startsWith('dsh-app://app'))) !== undefined, { timeout: 120_000 }).toBe(true)
    page!.setDefaultTimeout(30_000)
    return { desktop, page: page! }
  }
  // The first start makes the profile; the scripted model as its own layer, as above (a profile
  // with no model shows the welcome page's sign-in, which the test never touches).
  await test.step('the first start makes the profile', async () => {
    const first = await open()
    await expect.poll(() => fs.existsSync(path.join(own, 'dsh/profiles/desktop/package.json')), { timeout: 60_000 }).toBe(true)
    await quit(first.desktop)
    fs.copyFileSync(path.join(here, 'scripted-route.cordis.patch.yml'), path.join(own, 'dsh/profiles/desktop/cordis.patch.yml'))
  })
  let { desktop, page } = await open()
  try {
    await test.step('the Plugins page installs the plugin by its name', async () => {
      if (await page.getByRole('button', { name: 'Continue' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByText('Plugins', { exact: true }).first().click()
      // "Add plugin" asks for a package name, a GitHub address or a local folder.
      await page.getByRole('button', { name: 'Add plugin', exact: true }).first().click()
      const dialog = page.getByRole('dialog').filter({ hasText: 'local directory path' })
      const before = registry.requests.length
      await dialog.getByRole('textbox').fill('@kition/dsh-kits')
      await dialog.getByRole('button', { name: 'Install', exact: true }).click()
      // Installed, then enabled: the page's own two steps.
      await expect(page.getByText('Installed', { exact: true })).toBeVisible({ timeout: 120_000 })
      await page.getByRole('button', { name: 'Enable now', exact: true }).click()
      await expect.poll(() => JSON.parse(fs.readFileSync(path.join(own, 'dsh/profiles/desktop/package.json'), 'utf8')).dsh?.profile?.bundles ?? [], { timeout: 120_000 }).toContain('@kition/dsh-kits')
      await expect(page.getByText('@kition/dsh-kits', { exact: true }).first()).toBeVisible({ timeout: 120_000 })
      await page.screenshot({ path: path.join(shots, 'dsh-desktop-plugins-page-installed.png') })
      expect(fs.existsSync(path.join(own, `dsh/profiles/desktop/node_modules/@kition/cli-${process.platform}-${process.arch}/bin/kition`)), 'the plugin’s own kition came with it').toBe(true)
      // By name, from the local registry too: the plugin, and the packed kition itself, with the gateway command.
      expect(await checkOwnKition(own, 'desktop', kition, () => registry.requests.slice(before))).toContain('bin/kition')
      expect(assertServed(registry.requests.slice(before), ['@kition/dsh-kits']).length, 'the registry served the plugin').toBeGreaterThan(0)
    })
    // Whatever the page says about applying it, a new start has it.
    await quit(desktop)
    ;({ desktop, page } = await open())
    await test.step('a .ktable opens in the Table editor', async () => {
      await page.locator('[aria-label="New session in Default workspace"]').first().dispatchEvent('click')
      await page.getByRole('button', { name: 'Close' }).first().click({ timeout: 5_000 }).catch(() => {})
      if (await page.getByRole('button', { name: 'Open right sidebar' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Open right sidebar' }).click()
      await page.getByText('Workspace files').first().click({ timeout: 10_000 }).catch(() => {})
      await page.getByText('tasks.ktable', { exact: true }).first().click()
      const frame = () => page.frames().find((candidate) => candidate.url().includes('/kition/w/') && candidate.url().includes('/page/'))
      await expect.poll(() => !!frame(), { timeout: 60_000 }).toBe(true)
      await frame()!.waitForFunction(() => (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status === 'open', null, { timeout: 120_000 })
      expect(bundledGateways(path.join(own, 'dsh/profiles/desktop/node_modules')), 'the gateway is the plugin’s own kition').toHaveLength(1)
    })
    await test.step('with unsaved edits in the editor, the app still closes', async () => {
      const kit = page.frames().find((candidate) => candidate.url().includes('/kits-ui/table@'))!
      await kit.getByRole('button', { name: 'Add record' }).click()
      await expect(kit.getByText('4 records')).toBeVisible()
      await expect(page.locator('[data-kition-dirty]').first()).toBeVisible({ timeout: 30_000 })
      await page.screenshot({ path: path.join(shots, 'dsh-desktop-unsaved.png') })
    })
  } catch (error) {
    await quit(desktop).catch((closing) => console.error(`desktop: ${String(closing)}`))
    throw error
  }
  await test.step('the app closes, unsaved edits and all', () => quit(desktop))
})
