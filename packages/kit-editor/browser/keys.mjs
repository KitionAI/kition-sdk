#!/usr/bin/env node
/**
 * Keys under host calls (kit-editor's browser test; GitHub CI runs it, `pnpm test:editor:keys`):
 * the typing kit (`public/engine/typing_engine.js`, the shared editor in `editor.tsx`) opens in
 * kit-dev-host; Playwright types 300 characters, presses Enter and Backspace 50 times each, then
 * Shift+ArrowLeft 300 times, as fast as it can, while two loops in the host page call the editor
 * without pause (`ai.inspect`, `ai.version`, `ai.changes`, `model.describe`, `model.batch`,
 * `document/check`, `ai.run` reads). Every key must reach the engine once, in the order pressed,
 * and the text and selection must be what they make. Each round is run with no engine cost and with
 * host members and tool events made slow (`hostCost`, `toolCost`).
 *
 * `node keys.mjs [chromium|webkit|all] [rounds]` (default: all, 6).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from '@playwright/test'
import { createServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdk = path.resolve(here, '..', '..', '..')
const which = process.argv[2] ?? 'all'
const rounds = Number(process.argv[3] ?? 6)
const COSTS = [
  { hostCost: 0, toolCost: 0 },
  { hostCost: 4, toolCost: 1 },
  { hostCost: 15, toolCost: 0 },
]

const server = await createServer({
  root: here,
  configFile: false,
  logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [sdk, path.resolve(sdk, '..', 'kition-tessera')] } },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`

const TYPED = Array.from({ length: 300 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789,.()=+-'[(i * 7) % 43]).join('')
const START = 'Sample'

/** What the engine's key log must hold, in order. */
function expectedKeys() {
  const keys = [...TYPED]
  for (let i = 0; i < 50; i += 1) keys.push('Enter', 'Backspace')
  for (let i = 0; i < 300; i += 1) keys.push('Shift+ArrowLeft')
  return keys
}

/** The engine's log with typed text split into characters (text that arrived together is still in order). */
function flatten(keys) {
  return keys.flatMap((key) => (key.length > 1 && !/^(Shift\+)?[A-Z][a-zA-Z]+$/.test(key) ? [...key] : [key]))
}

let failures = 0
const browsers = which === 'all' ? ['chromium', 'webkit'] : [which]
for (const name of browsers) {
  const browser = await (name === 'webkit' ? webkit : chromium).launch()
  for (let round = 0; round < rounds; round += 1) {
    const cost = COSTS[round % COSTS.length]
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const label = `${name} round ${round + 1} (hostCost ${cost.hostCost} ms, toolCost ${cost.toolCost} ms)`
    try {
      await page.goto(`${origin}/host.html?hostCost=${cost.hostCost}&toolCost=${cost.toolCost}`)
      await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60_000 })
      const kit = page.frameLocator('#kit')
      const region = kit.getByTestId('typing-canvas')
      await region.waitFor()
      const box = await region.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForFunction(() => {
        const frame = document.getElementById('kit')
        const doc = frame?.contentDocument
        return doc?.activeElement?.getAttribute('data-testid') === 'kit-text-sink'
      }, null, { timeout: 10_000 })

      // Two loops calling the editor as an agent's host and the kits' tests do, without pause.
      await page.evaluate(() => {
        const c = window.devHost.connection()
        const state = { on: true, calls: 0, failed: [] }
        window.__hammer = state
        const loop = async (reads) => {
          let since = await c.ai.version()
          while (state.on) {
            const calls = [c.ai.inspect(), c.ai.changes(since), c.model.describe(), c.model.batch({ load: [] }), c.check()]
            if (reads) calls.push(c.ai.run([{ command: 'text.read', params: {} }], false))
            for (const result of await Promise.allSettled(calls)) {
              state.calls += 1
              if (result.status === 'rejected' && state.failed.length < 5) state.failed.push(String(result.reason?.message ?? result.reason))
            }
            since = await c.ai.version()
          }
        }
        state.done = Promise.all([loop(false), loop(true)])
      })

      await page.keyboard.type(TYPED)
      for (let i = 0; i < 50; i += 1) {
        await page.keyboard.press('Enter')
        await page.keyboard.press('Backspace')
      }
      for (let i = 0; i < 300; i += 1) await page.keyboard.press('Shift+ArrowLeft')

      const hammer = await page.evaluate(async () => {
        window.__hammer.on = false
        await window.__hammer.done
        return { calls: window.__hammer.calls, failed: window.__hammer.failed }
      })
      const expected = expectedKeys()
      const read = (command) => page.evaluate(async (command) => (await window.devHost.connection().ai.run([{ command, params: {} }], false)).completed[0].result, command)
      let keys = []
      for (let i = 0; i < 100; i += 1) {
        keys = flatten((await read('keys.read')).keys)
        if (keys.length >= expected.length) break
        await page.waitForTimeout(100)
      }
      const text = await read('text.read')
      const length = [...START].length + TYPED.length
      const problems = []
      if (hammer.failed.length) problems.push(`host calls failed: ${JSON.stringify(hammer.failed)}`)
      if (hammer.calls < 20) problems.push(`only ${hammer.calls} host calls ran`)
      const first = expected.findIndex((key, i) => keys[i] !== key)
      if (first >= 0 || keys.length !== expected.length) {
        problems.push(`keys: ${keys.length} of ${expected.length} reached the engine; first difference at ${first}: expected ${JSON.stringify(expected.slice(first, first + 4))}, got ${JSON.stringify(keys.slice(first, first + 4))}`)
      }
      if (text.text !== START + TYPED) problems.push(`text: ${JSON.stringify(text.text.slice(-40))}`)
      if (text.anchor !== length || text.focus !== length - 300) problems.push(`selection ${text.anchor}–${text.focus}, expected ${length}–${length - 300}`)
      if (errors.length) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`)
      if (problems.length) {
        failures += 1
        console.log(`FAIL ${label}: ${problems.join('; ')}`)
      } else console.log(`PASS ${label}: ${expected.length} keys in order under ${hammer.calls} host calls`)
    } catch (error) {
      failures += 1
      console.log(`FAIL ${label}: ${error instanceof Error ? error.stack : String(error)}`)
    } finally {
      await page.close()
    }
  }
  await browser.close()
}
await server.close()
console.log(failures ? `${failures} round(s) failed` : 'all rounds passed')
process.exit(failures ? 1 : 0)
