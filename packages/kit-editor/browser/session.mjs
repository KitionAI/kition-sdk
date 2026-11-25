#!/usr/bin/env node
/**
 * A document's session through the host, in a browser (kit-editor's browser test; GitHub CI runs
 * it on the sources, `pnpm test:editor:session`, and the release on the packed `@kition/sdk`,
 * tools/smoke-sdk-worker.mjs): the typing kit (`public/engine/typing_engine.js`) opens in
 * kit-dev-host keeping its replica and checkpoints (`?checkpoints=1`); the person types, the host
 * saves (the file and the stored snapshot), records a checkpoint and reopens the document, which
 * opens with the stored snapshot; an agent edits a draft, which the host merges, and the host
 * restores the checkpoint. Each step is checked in the engine (`text.read`) and the page throws
 * nothing.
 *
 * `node session.mjs [chromium|webkit|all]` (default: chromium) runs it on the sources under Vite's
 * development server; `typingSession(page, origin)` runs it on a page served at `origin`.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TYPED = 'Hello'
const DRAFTED = ' drafted'
const SAVED = `Sample${TYPED}`
const DRAFT_ORIGIN = { kind: 'agent', principal: 'agent:session', label: 'Merged the draft' }

/** Runs the session on the host page served at `origin` (ending in `/`); throws at the first step that fails. */
export async function typingSession(page, origin) {
  const errors = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  const check = (what, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  const opened = async () => {
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes(' open in '), null, { timeout: 60_000 })
    await page.frameLocator('#kit').getByTestId('typing-canvas').waitFor({ timeout: 30_000 })
  }
  const read = () => page.evaluate(async () => (await window.devHost.connection().ai.run([{ command: 'text.read', params: {} }], false)).completed[0].result)
  const file = () => page.evaluate(() => new TextDecoder().decode(window.devHost.files.get('Sample.typing').bytes))
  const steps = []

  await page.goto(new URL('host.html?checkpoints=1', origin).href)
  await opened()
  check('opened from the file', (await read()).opened, 'file')

  // The person types.
  const region = page.frameLocator('#kit').getByTestId('typing-canvas')
  const box = await region.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => document.getElementById('kit')?.contentDocument?.activeElement?.getAttribute('data-testid') === 'kit-text-sink', null, { timeout: 10_000 })
  await page.keyboard.type(TYPED)
  await page.waitForFunction(async (text) => (await window.devHost.connection().ai.run([{ command: 'text.read', params: {} }], false)).completed[0].result.text === text, SAVED, { timeout: 10_000, polling: 100 })
  const typed = await read()
  steps.push(`typed (${typed.changes} changes)`)

  // The host saves: the file and the stored snapshot; then records a checkpoint of that version.
  check('saved', (await page.evaluate(() => window.devHost.connection().save())).saved, true)
  check('the saved file', await file(), SAVED)
  const checkpoint = await page.evaluate(() => window.devHost.recordCheckpoint({ origin: 'save', label: 'Typed' }))
  if (!checkpoint?.id) throw new Error(`no checkpoint was recorded: ${JSON.stringify(checkpoint)}`)
  steps.push('saved')

  // Reopened as Kition reopens a file: with the stored snapshot, its version going on.
  await page.evaluate(() => window.devHost.reload())
  await opened()
  const reopened = await read()
  check('reopened', { opened: reopened.opened, text: reopened.text, changes: reopened.changes }, { opened: 'replica', text: SAVED, changes: typed.changes })
  steps.push('reopened with the stored snapshot')

  // An agent edits a draft; the live document is untouched until the host merges it.
  const run = await page.evaluate((text) => window.devHost.connection().ai.run([{ command: 'text.append', params: { text } }], false, { draft: true }), DRAFTED)
  check('the draft step ran', run.completed.length, 1)
  check('the document while the draft is open', (await read()).text, SAVED)
  const merged = await page.evaluate((origin) => window.devHost.connection().draft.merge(origin), DRAFT_ORIGIN)
  check('merged', merged.merged, true)
  check('the document after the merge', (await read()).text, SAVED + DRAFTED)
  steps.push('merged a draft')

  // The host restores the checkpoint: the state saved before the draft.
  await page.evaluate((id) => window.devHost.restoreCheckpoint(id), checkpoint.id)
  check('the document after the restore', (await read()).text, SAVED)
  steps.push('restored the checkpoint')

  check('page errors', errors, [])
  return steps
}

// Run on the sources under Vite's development server.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium, webkit } = await import('@playwright/test')
  const { createServer } = await import('vite')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sdk = path.resolve(here, '..', '..', '..')
  const which = process.argv[2] ?? 'chromium'
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
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/`
  let failures = 0
  for (const name of which === 'all' ? ['chromium', 'webkit'] : [which]) {
    const browser = await (name === 'webkit' ? webkit : chromium).launch()
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    try {
      console.log(`PASS ${name}: ${(await typingSession(page, origin)).join(', ')}`)
    } catch (error) {
      failures += 1
      console.log(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`)
    } finally {
      await browser.close()
    }
  }
  await server.close()
  process.exit(failures ? 1 : 0)
}
