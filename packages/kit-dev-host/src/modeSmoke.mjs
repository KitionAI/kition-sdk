// A smoke test of a kit's editor in each display mode (kit-editor's EditorFrame), through the kit's
// development host. For Menus, Single line, and Classic it opens dev.html with only that mode and
// Focus allowed (`?modes=<mode>,focus`), checks the frame shows that mode, enters Focus with
// Cmd/Ctrl+\, leaves it with Escape, enters it again from the mode menu (whose row then
// unmounts) and leaves it with Escape, checks Single line's row mounts no test id twice (with a
// group's popover closed and open), and reports page errors. The kit passes Playwright's
// browser type and Vite's createServer (it has them installed):
//
//   import { chromium, webkit } from 'playwright'
//   import { createServer } from 'vite'
//   import { runModeSmoke } from '@kition/kit-dev-host/mode-smoke'
//   await runModeSmoke({ kit: 'kit.doc', config: new URL('../vite.config.ts', import.meta.url).pathname, browser: process.argv[2] === 'webkit' ? webkit : chromium, createServer })
//
// With `line: { tab, primary, min }` it also opens the editor with Single line chosen and Menus
// allowed (`?modes=line,menus,classic,focus`) at 1440 and 1024 px wide, selects `tab`, and
// checks that the row still fits (the frame did not step down to Menus), shows at least `min`
// (default 6) enabled buttons, and draws every test id in `primary` inline. With KUI_SHOTS set to
// a folder it saves `<kit>-line-<width>.png` there.
//
// At the editor widths Kition gives a kit (1165 and 749 px: 1440 and 1024 px windows less its
// sidebar) it opens the editor in Classic with every mode allowed (`?modes=classic,line,menus,focus`)
// and checks that Classic still shows (its ribbon gives way in steps, so the frame does not step
// down), then enters Focus and checks that the Focus bar covers none of the kit's controls (a bar
// a kit draws at the bottom, such as a timeline, must be in `FrameChrome`). With KUI_SHOTS it
// saves `<kit>-classic-<width>.png` and `<kit>-focus-<width>.png`.
//
// An editor whose tabs come from the engine's commands draws them a moment after the file opens:
// each step waits for the frame's tabs (up to 5 s) before reading the mode. An editor without tabs
// shows Menus whatever mode is chosen, and its mode button enters Focus itself; the smoke expects
// that of it.
//
// Prints PASS or FAIL per step; sets a failing exit code when a step failed.

import { mkdir } from 'node:fs/promises'
import { focusBarReport, lineRowReport } from './lineRow.mjs'

/** Whether the kit's frame draws tabs (or menus), waiting up to 5 s for tabs built from the engine's commands. */
async function hasTabs(frame) {
  try {
    await frame.locator('.kui-frame-top [role="tab"], .kui-frame-top .kui-menu-bar-item').first().waitFor({ state: 'attached', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** The frame's shown mode once it is `wanted` (or after 3 s, whatever it is then). */
async function modeOnce(page, wanted) {
  const kitFrame = await (await page.$('#kit')).contentFrame()
  await kitFrame.waitForFunction((mode) => document.querySelector('.kui-app')?.getAttribute('data-mode') === mode, wanted, { timeout: 3000 }).catch(() => undefined)
  return kitFrame.evaluate(() => document.querySelector('.kui-app')?.getAttribute('data-mode') ?? null)
}

/** Runs the smoke; `locale` is the dev page's `?locale=`. */

// The modifier the editor reads for Mod+\ (kit-editor's isMac tests navigator.platform). Not
// Playwright's ControlOrMeta, which follows the OS running the test: Playwright's WebKit reports a
// Mac platform on Linux too, so there the editor expects Meta while ControlOrMeta presses Control.
const primaryModifier = async (page) => ((await page.evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))) ? 'Meta' : 'Control')
export async function runModeSmoke({ kit, config, browser: type, createServer, locale = 'en-US', line = null }) {
  const server = await createServer({ configFile: config, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const browser = await type.launch()
  let failures = 0
  const step = (name, ok, detail = '') => {
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${kit} ${name}${detail ? ` - ${detail}` : ''}`)
  }
  try {
    for (const mode of ['menus', 'line', 'classic']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/dev.html?modes=${mode},focus&locale=${locale}`)
      await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90000 })
      const frame = page.frameLocator('#kit')
      const app = frame.locator('.kui-app')
      // Without tabs every mode draws as Menus, and the mode button is a Focus button.
      const tabs = await hasTabs(frame)
      const expected = tabs ? mode : 'menus'
      const shown = await modeOnce(page, expected)
      step(`${mode}: shows ${expected}${tabs ? '' : ' (no tabs)'}`, shown === expected, shown ?? 'no frame')
      await app.focus()
      await page.keyboard.press(`${await primaryModifier(page)}+Backslash`)
      step(`${mode}: Cmd+\\ enters Focus`, (await app.getAttribute('data-mode')) === 'focus' && (await frame.locator('.kui-focus-bar').count()) === 1)
      await page.keyboard.press('Escape')
      step(`${mode}: Escape leaves Focus`, (await app.getAttribute('data-mode')) === expected)
      const modeButton = frame.locator('.kui-mode-button')
      if (await modeButton.count()) {
        await modeButton.click()
        if (tabs) await frame.locator('[data-testid$="-mode-focus"]').click()
        step(`${mode}: the mode ${tabs ? 'menu' : 'button'} enters Focus`, (await app.getAttribute('data-mode')) === 'focus')
        await page.keyboard.press('Escape')
        step(`${mode}: Escape leaves Focus entered from the ${tabs ? 'menu' : 'button'}`, (await app.getAttribute('data-mode')) === expected)
      }
      if (mode === 'line') {
        const kitFrame = await (await page.$('#kit')).contentFrame()
        const repeated = () =>
          kitFrame.evaluate(() => {
            const ids = [...document.querySelectorAll('.kui-line [data-testid]')].map((element) => element.getAttribute('data-testid'))
            return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
          })
        const closed = await repeated()
        step('line: no test id twice in the row', closed.length === 0, closed.join(', '))
        const opener = frame.locator('.kui-line-more, .kui-line-collapsed').first()
        if (await opener.count()) {
          await opener.click()
          const open = await repeated()
          step('line: no test id twice with a popover open', open.length === 0, open.join(', '))
          await page.keyboard.press('Escape')
        }
      }
      step(`${mode}: no page errors`, errors.length === 0, errors.join('; '))
      await context.close()
    }
    const shots = process.env.KUI_SHOTS
    if (shots) await mkdir(shots, { recursive: true })
    for (const width of [1165, 749]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/dev.html?modes=classic,line,menus,focus&locale=${locale}`)
      await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90000 })
      const frame = page.frameLocator('#kit')
      const app = frame.locator('.kui-app')
      const tabs = await hasTabs(frame)
      // The ribbon gives way a step per drawing, and the frame steps down after that.
      await page.waitForTimeout(800)
      const shown = await modeOnce(page, tabs ? 'classic' : 'menus')
      if (tabs) step(`classic ${width}: Classic fits (the ribbon gives way, the frame does not step down)`, shown === 'classic', shown ?? 'no frame')
      else step(`classic ${width}: an editor without tabs shows Menus`, shown === 'menus', shown ?? 'no frame')
      if (shots) await page.screenshot({ path: `${shots}/${kit}-classic-${width}.png` })
      await app.focus()
      await page.keyboard.press(`${await primaryModifier(page)}+Backslash`)
      await page.waitForTimeout(300)
      const kitFrame = await (await page.$('#kit')).contentFrame()
      const covered = await kitFrame.evaluate(focusBarReport)
      step(`focus ${width}: the Focus bar covers none of the kit's controls`, covered.length === 0, covered.join(', '))
      if (shots) await page.screenshot({ path: `${shots}/${kit}-focus-${width}.png` })
      step(`classic and focus ${width}: no page errors`, errors.length === 0, errors.join('; '))
      await context.close()
    }
    if (line) {
      for (const width of [1440, 1024]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${origin}/dev.html?modes=line,menus,classic,focus&locale=${locale}`)
        await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 90000 })
        const frame = page.frameLocator('#kit')
        const app = frame.locator('.kui-app')
        await page.waitForTimeout(300)
        if (line.tab && (await app.getAttribute('data-mode')) === 'line') await frame.getByTestId(`ribbon-tab-${line.tab}`).click()
        // The frame measures the row after drawing it, and steps down after that.
        await page.waitForTimeout(500)
        const shown = await app.getAttribute('data-mode')
        step(`line ${width}: ${line.tab ?? 'the first tab'} fits in Single line`, shown === 'line', shown ?? 'no frame')
        const kitFrame = await (await page.$('#kit')).contentFrame()
        const report = await kitFrame.evaluate(lineRowReport, line.primary ?? [])
        const min = line.min ?? 6
        step(`line ${width}: at least ${min} enabled buttons in the row`, report.buttons >= min, `${report.buttons} buttons, ${report.fields} fields`)
        step(`line ${width}: the primary items are in the row`, report.missing.length === 0, report.missing.join(', '))
        step(`line ${width}: no button is cut off outside the row`, report.clipped.length === 0, report.clipped.join(', '))
        if (shots) await page.screenshot({ path: `${shots}/${kit}-line-${width}.png` })
        step(`line ${width}: no page errors`, errors.length === 0, errors.join('; '))
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  if (failures) process.exitCode = 1
}
