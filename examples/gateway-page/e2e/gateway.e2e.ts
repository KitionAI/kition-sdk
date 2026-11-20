/**
 * The gateway's editor page with real kits (sdk.gateway.page, sdk.agent.live-editor): Table and Note, their headless builds and editor packages installed from
 * the kit index's release assets, a real `kition gateway`, and a real `kition mcp` stdio process for
 * the same workspace, which relays the agent's calls to the gateway.
 *
 * - direct opening: `kition gateway url` gives an address that lets one tab in; a request without
 *   a credential is refused; the person edits a Table cell and saves, and the file changes on disk;
 * - behind a same-origin proxy under a path prefix (`proxy.mjs`, which adds the token): an agent's
 *   `kit_run` arrives in the open Note editor's engine without a reload and is undone in the
 *   editor's history (the agent's undo scope, KitModel M12a);
 *   with no editor open the same call runs headless and an editor opened then shows it;
 * - an embedding window hears the page (`ready`, `state`, `draft`) and sets its theme;
 * - a narrow pane opens the editor without overflowing it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { McpClient, openUrl, startGateway, startProxy, type Gateway } from './helpers'
import { inspected, kitFrame, noteSample, opened, proxied, setup, shots, tableSample, watch } from './page'

test.beforeAll(() => fs.mkdirSync(shots, { recursive: true }))

test('direct opening lets one tab in, refuses a request without a credential, and a cell edited and saved changes the file on disk', async ({ page, browser }) => {
  const { home, workspace } = await setup('direct')
  fs.copyFileSync(tableSample(), path.join(workspace, 'tasks.ktable'))
  const gateway = await startGateway(home, workspace)
  try {
    for (const address of ['/page/?path=tasks.ktable', '/kits-ui/table@0.5.6/index.html', '/api/v1/kits', '/kit-files/tasks.ktable']) {
      expect((await fetch(`${gateway.url}${address}`)).status, address).toBe(401)
    }
    const problems = watch(page)
    const address = openUrl(home, workspace, 'tasks.ktable')
    expect(address).not.toContain(gateway.token)
    const started = Date.now()
    await page.goto(address)
    await opened(page)
    const loadMs = Date.now() - started
    expect(page.url(), 'the bootstrap leaves the address bar').not.toContain('bootstrap')
    expect(await page.evaluate(() => sessionStorage.getItem('kition-gateway-session'))).toMatch(/^[0-9a-f]{64}$/)
    await page.screenshot({ path: path.join(shots, 'direct-table-open.png') })

    // The same address does not let a second tab in.
    const second = await browser.newPage()
    await second.goto(address)
    await expect(second.getByTestId('state-unreachable')).toBeVisible()
    await second.close()

    // The person edits a cell and saves.
    const before = fs.readFileSync(path.join(workspace, 'tasks.ktable'))
    await page.mouse.dblclick(178, 225)
    await page.waitForTimeout(500)
    await page.keyboard.press('Meta+A')
    await page.keyboard.type('Edited by the person')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    await page.keyboard.press('Meta+S')
    await expect.poll(() => fs.readFileSync(path.join(workspace, 'tasks.ktable')).includes('Edited by the person'), { timeout: 30_000 }).toBe(true)
    expect(Buffer.compare(before, fs.readFileSync(path.join(workspace, 'tasks.ktable')))).not.toBe(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as { kitionGatewayPage: { state: { dirty: boolean } } }).kitionGatewayPage.state.dirty)).toBe(false)
    await page.screenshot({ path: path.join(shots, 'direct-table-saved.png') })
    expect(problems, problems.join('\n')).toEqual([])
    console.log(`table: opened in ${loadMs} ms (direct)`)
  } finally {
    await gateway.stop()
  }
})

test('behind a proxy under a prefix: an agent edit through a relayed kition mcp arrives live and is undone; without an editor it runs headless', async ({ page }) => {
  const { home, workspace } = await setup('live')
  fs.mkdirSync(path.join(workspace, 'notes'))
  fs.writeFileSync(path.join(workspace, 'notes/plan.md'), noteSample())
  fs.writeFileSync(path.join(workspace, 'notes/later.md'), '# Later\n\nNothing yet.\n')
  const gateway = await startGateway(home, workspace)
  const proxy = await startProxy(gateway.url, gateway.token)
  const agent = new McpClient(home, workspace)
  try {
    expect(proxy.url).toMatch(/\/kition\/$/)
    const problems = watch(page)
    await page.goto(proxied(proxy.url, 'notes/plan.md'))
    await opened(page)
    // Every request of the page and its editor went through the prefix.
    expect(page.url()).toContain('/kition/page/')
    expect(kitFrame(page).url()).toContain('/kition/kits-ui/note@')
    await kitFrame(page).evaluate(() => ((window as unknown as { e2eMark: number }).e2eMark = 1))
    await agent.initialize()
    const answer = (await agent.call('kit_run', { path: 'notes/plan.md', steps: [{ command: 'block.append', params: { markdown: 'Appended by the agent.' } }] })) as Record<string, unknown>
    expect(answer.live, JSON.stringify(answer)).toBe(true)
    await expect.poll(() => inspected(page)).toContain('Appended by the agent.')
    expect(await kitFrame(page).evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark), 'the editor was not reloaded').toBe(1)
    await expect.poll(() => fs.readFileSync(path.join(workspace, 'notes/plan.md'), 'utf8')).toContain('Appended by the agent.')
    await page.screenshot({ path: path.join(shots, 'live-note-agent-edit.png') })

    // It is a step of the agent's undo scope in the editor's history (KitModel M12a): undone there,
    // live, through the same relay.
    const undone = (await agent.call('kit_run', { path: 'notes/plan.md', steps: [{ command: 'edit.undo', params: { scope: 'agent' } }] })) as Record<string, unknown>
    expect(undone.live, JSON.stringify(undone)).toBe(true)
    await expect.poll(() => inspected(page)).not.toContain('Appended by the agent.')
    expect(await kitFrame(page).evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark), 'still not reloaded').toBe(1)
    await page.screenshot({ path: path.join(shots, 'live-note-undone.png') })

    // No editor has notes/later.md open: the same call runs headless, and an editor opened then shows it.
    const headless = (await agent.call('kit_run', { path: 'notes/later.md', steps: [{ command: 'block.append', params: { markdown: 'Written headless.' } }] })) as Record<string, unknown>
    expect(headless.live ?? false, JSON.stringify(headless)).toBe(false)
    expect(fs.readFileSync(path.join(workspace, 'notes/later.md'), 'utf8')).toContain('Written headless.')
    await page.goto(proxied(proxy.url, 'notes/later.md'))
    await opened(page)
    await expect.poll(() => inspected(page)).toContain('Written headless.')
    await page.screenshot({ path: path.join(shots, 'live-note-headless-then-open.png') })
    expect(problems, problems.join('\n')).toEqual([])
  } finally {
    agent.stop()
    proxy.stop()
    await gateway.stop()
  }
})

test('an embedding window hears the page and sets its theme; a narrow pane does not overflow', async ({ page }) => {
  const { home, workspace } = await setup('embed', ['note'])
  fs.writeFileSync(path.join(workspace, 'plan.md'), noteSample())
  const gateway: Gateway = await startGateway(home, workspace)
  const proxy = await startProxy(gateway.url, gateway.token)
  try {
    // The host's own page, on the proxy's origin, frames the page and records what it hears.
    await page.goto(new URL('/host', proxy.url).href)
    await page.evaluate((src) => {
      const messages: unknown[] = []
      ;(window as unknown as { heard: unknown[] }).heard = messages
      window.addEventListener('message', (event) => messages.push(event.data))
      const frame = document.createElement('iframe')
      frame.src = src
      frame.style.cssText = 'width: 420px; height: 700px; border: 0'
      frame.id = 'page'
      document.body.append(frame)
    }, proxied(proxy.url, 'plan.md', '') + '&theme=light')
    const heard = () => page.evaluate(() => (window as unknown as { heard: Array<{ type: string; status?: string }> }).heard)
    await expect.poll(async () => (await heard()).some((message) => message.type === 'ready')).toBe(true)
    await expect.poll(async () => (await heard()).some((message) => message.type === 'state' && message.status === 'open'), { timeout: 120_000 }).toBe(true)
    const framed = page.frames().find((frame) => frame.url().includes('/kition/page/'))!
    await page.evaluate(() => (document.getElementById('page') as HTMLIFrameElement).contentWindow!.postMessage({ kitionGatewayPage: 1, type: 'theme', theme: 'dark' }, location.origin))
    await expect.poll(() => framed.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    // 420 px wide: the editor opened in its Focus mode and its page does not scroll sideways.
    const kit = page.frames().find((frame) => frame.url().includes('/kits-ui/'))!
    await expect.poll(() => kit.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
    await expect.poll(() => kit.evaluate(() => document.body.innerText)).toContain('Exit focus')
    await page.screenshot({ path: path.join(shots, 'embedded-narrow-dark.png') })
  } finally {
    proxy.stop()
    await gateway.stop()
  }
})
