#!/usr/bin/env node
// Makes the README's pictures (assets/readme/) from the SDK's examples, running for real: the
// embed example with the Note editor, the kits showcase (Motion, Note and Table embedded with
// @kition/embed), the grid kit headless over MCP, the agent and script examples, the title-case
// extension, and two writes against a note another writer changed.
// Every terminal picture shows the output of the run it was made from. Not a test, and not part
// of any suite or CI; re-run it by hand when the examples change:
//
//   pnpm install && pnpm --filter @kition/embed --filter @kition/script --filter @kition/extensions build
//   cargo build -p kition-kits --bin kition-kits-mcp -p grid-kit-headless
//   cargo build -p kition-note                          # in a kition-note checkout (needs its fonts)
//   KITION_KITS_DIR=<folder holding note-ui/> KITION_KIT_NOTE_BINARY=<kition-note> \
//     node tools/readme-shots.mjs [name ...]
//
// <folder holding note-ui/> is the Note kit's package unpacked (kition-note's Releases,
// kition-note-<version>.tgz). The `kits` pictures also need motion-ui/ and table-ui/ there, the
// Motion and Table packages (kition-motion's and kition-table's Releases). Run it with no HTTP proxy set (the browser reaches local servers).
// hero.svg is drawn by hand; this script does not touch it.
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { connect } from '../examples/agent-mcp/mcp-client.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'assets', 'readme')
mkdirSync(out, { recursive: true })
const only = new Set(process.argv.slice(2))
const wanted = (name) => only.size === 0 || only.has(name)
const need = (file, hint) => {
  if (!existsSync(file)) throw new Error(`no ${file}: ${hint}`)
  return file
}
const kitsDir = path.resolve(process.env.KITION_KITS_DIR ?? path.join(root, '..', 'kition', 'public', 'kits'))
const mcp = need(path.resolve(process.env.KITION_KITS_MCP ?? path.join(root, 'target', 'debug', 'kition-kits-mcp')), 'cargo build -p kition-kits --bin kition-kits-mcp, or set KITION_KITS_MCP')
const noteBinary = () => need(path.resolve(process.env.KITION_KIT_NOTE_BINARY ?? path.join(root, '..', 'kition-note', 'target', 'debug', 'kition-note')), 'build kition-note, or set KITION_KIT_NOTE_BINARY')
const node = process.execPath
const scratch = () => mkdtempSync(path.join(tmpdir(), 'sdk-readme-'))

/** The sample note the Note pictures open. */
const NOTE = `---
status: in progress
owner: Maya Chen
tags:
  - launch
---

The launch moves the new editor from beta to everyone.

> [!tip] Decision
> We ship on **December 1**, with export on by default.

## Tasks

- [x] Freeze the feature list
- [ ] Record the demo video
- [ ] Brief the support team

## Rollout

| Stage   | Audience      | Date   |
| ------- | ------------- | ------ |
| Beta    | 2,000 testers | Nov 10 |
| Preview | Paid teams    | Nov 20 |
| General | Everyone      | Dec 1  |
`

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** A line of a terminal card in a color of its own: a comment, a refusal, or a result. */
const comment = (text) => ({ text, color: '#8a8780' })
const refusal = (text) => ({ text, color: '#ff9b9b' })
const good = (text) => ({ text, color: '#7ee2a8' })
/** A terminal-style card: `$`-lines are commands; other lines are output unless marked above. */
function terminal(lines, aside = '') {
  const line = (item) => {
    const { text, color } = typeof item === 'string' ? { text: item, color: item.startsWith('$ ') ? '#b9aefc' : '#e6e3de' } : item
    return `<div style="color:${color}">${escape(text) || '&nbsp;'}</div>`
  }
  return `<!doctype html><body style="margin:0;background:#fafaf9;padding:24px">
<main style="display:inline-flex;gap:24px;align-items:center;background:#1a1a1a;border-radius:12px;padding:20px 24px;box-shadow:0 2px 8px rgba(26,26,26,.12)">
<div style="font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;min-width:720px">${lines.map(line).join('')}</div>${aside}</main></body>`
}

/** examples/extensions/title-case on a note from the Note kit's package, as the extension host runs it in Node. */
async function titleCase() {
  // The packages' TypeScript sources, loaded through Vite as the SDK's own tests load them.
  const { createServer } = await import('vite')
  const vite = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } })
  const load = (file) => vite.ssrLoadModule(path.join(root, file))
  const { openKitPackage } = await load('packages/script/src/node.ts')
  const { portFromEngine } = await load('packages/script/src/index.ts')
  const { ExtensionHost, RpcPeer } = await load('packages/extensions/src/index.ts')
  const { startRuntime } = await load('packages/extensions/src/runtime/index.ts')
  const example = (name) => readFileSync(path.join(root, 'examples', 'extensions', 'title-case', name), 'utf8')
  const disposers = []
  const sandbox = async () => {
    const channel = new MessageChannel()
    const peer = startRuntime(channel.port2, async (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))
    const dispose = () => {
      peer.close()
      channel.port1.close()
    }
    disposers.push(dispose)
    return { port: channel.port1, dispose }
  }
  const notes = await openKitPackage(path.join(kitsDir, 'note-ui'))
  const file = notes.create('Review.md')
  file.engine.execute('note.write', JSON.stringify({ markdown: '# quarterly business review\n\nrevenue grew in the north\n\n## next steps for the team\n' }))
  const host = new ExtensionHost({ sandbox })
  const manifest = JSON.parse(example('extension.json'))
  host.load({ manifest: example('extension.json'), source: example('extension.mjs'), files: { 'panel.html': example('panel.html') } })
  host.openDocument({ id: 'Review.md', kitId: 'kit.note', path: 'Review.md', port: portFromEngine(file.engine, 'kit.note'), schema: notes.schema })
  const channel = new MessageChannel()
  const panel = new RpcPeer(channel.port1)
  const opened = await host.openPanel('Review.md', manifest.id, 'titleCase.titles', channel.port2)
  const titles = async () => (await panel.request('panel/request', { type: 'titles' })).titles.map((title) => `${'#'.repeat(title.level)} ${title.text}`).join('  ')
  const lines = [`headings: ${await titles()}`]
  const result = await host.runCommand('Review.md', manifest.id, 'titleCase.apply')
  lines.push(`titleCase.apply -> ${JSON.stringify(result)}`, `headings: ${await titles()}`)
  opened.close()
  panel.close()
  host.dispose()
  for (const dispose of disposers) dispose()
  file.close()
  await vite.close()
  return lines.join('\n')
}


/** A Motion title composition and a Table project tracker, made with the kits' own engines from their packages, in Node. */
async function kitSamples() {
  const { openKitPackage } = await import('../packages/script/dist/node.js')
  const run = (file, command, params) => {
    const answer = file.engine.execute(command, JSON.stringify(params))
    return typeof answer === 'string' ? JSON.parse(answer) : answer
  }
  const motion = (await openKitPackage(path.join(kitsDir, 'motion-ui'))).create('Launch title.kmotion')
  run(motion, 'comp.settings', { width: 1920, height: 1080, duration: 4 })
  const background = run(motion, 'layer.newSolid', { name: 'Background', color: '#1b1640' }).layer
  const title = run(motion, 'layer.newText', { text: 'Launch Day', position: [960, 500], size: 150, style: 'Bold', fill: '#ffffff' }).layer
  const subtitle = run(motion, 'layer.newText', { text: 'December 1 · Live for every team', position: [960, 640], size: 52, style: 'Medium', fill: '#d6d0fa' }).layer
  run(motion, 'effect.apply', { effect: 'Gradient Ramp', layers: [background], params: { shape: 1, start: [960, 430], startColor: '#5645d4', end: [2208, 430], endColor: '#0b0920' } })
  run(motion, 'layer.style.add', { style: 'outerGlow', layers: [title], params: { size: 38, opacity: 60, color: '#b9aefc' } })
  run(motion, 'layer.style.add', { style: 'dropShadow', layers: [subtitle], params: { distance: 8, size: 24, opacity: 50 } })
  run(motion, 'layer.applyTextPreset', { layer: title, preset: 'blurSlide', start: 0.2 })
  run(motion, 'layer.applyTextPreset', { layer: subtitle, preset: 'blurSlide', variant: 'subtitle', start: 0.8 })

  const table = (await openKitPackage(path.join(kitsDir, 'table-ui'))).create('Launch tracker.ktable')
  // A new file holds a starter table; this one has its own schema instead.
  run(table, 'table.tables.delete', { tableId: 1, asOrigin: 'system:setup' })
  const tableId = run(table, 'table.tables.create', {
    title: 'Launch tracker',
    fields: [
      { title: 'Task', name: 'task', type: 'text', primary: true },
      { title: 'Status', name: 'status', type: 'single_select', options: { choices: ['To do', 'In progress', 'Done'] } },
      { title: 'Owner', name: 'owner', type: 'text' },
      { title: 'Due', name: 'due', type: 'date' },
      { title: 'Shipped', name: 'shipped', type: 'checkbox' },
    ],
  }).result.id
  const rows = [
    ['Freeze the feature list', 'Done', 'Maya Chen', '2026-11-10', true],
    ['Write the release notes', 'Done', 'Sam Ortiz', '2026-11-14', true],
    ['Record the demo video', 'In progress', 'Priya Nair', '2026-11-24', false],
    ['Brief the support team', 'In progress', 'Sam Ortiz', '2026-11-26', false],
    ['Update the pricing page', 'To do', 'Leo Park', '2026-11-28', false],
    ['Publish the launch post', 'To do', 'Maya Chen', '2026-12-01', false],
  ]
  for (const [task, status, owner, due, shipped] of rows) run(table, 'table.records.create', { tableId, values: { task, status, owner, due, shipped } })
  return { motion: motion.save(), table: table.save() }
}

/** The CSP a kit origin serves its packages with (UI-H3), as examples/embed-app/serve.mjs does. */
const kitPolicy = (appOrigin) => [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data: blob:", "connect-src 'self' data: blob:", "media-src 'self' data: blob:",
  "object-src 'none'", "base-uri 'self'", `frame-ancestors ${appOrigin}`,
].join('; ')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.txt': 'text/plain' }
/** A static server for `dir` (under the URL `prefix`) on `port`, with `headers`; `pages` answer some paths with HTML. */
function serve(dir, port, headers = {}, pages = {}, prefix = '/') {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (pages[url.pathname]) return void response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(pages[url.pathname])
    if (!url.pathname.startsWith(prefix)) return void response.writeHead(404).end()
    let file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length - 1)))
    if (!file.startsWith(dir + path.sep)) return void response.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) return void response.writeHead(404).end()
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...headers }).end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/** A page of "your app" that embeds one kit's editor with @kition/embed, its files in memory. */
const APP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your app</title>
<style>
  html, body { height: 100%; margin: 0; font: 14px/1.4 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; background: #f6f5f4; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; height: 52px; padding: 0 20px; background: #fff; border-bottom: 1px solid #e5e3df; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 650; }
  .logo { width: 22px; height: 22px; border-radius: 6px; background: #5645d4; }
  .file { color: #5d5b54; }
  main { flex: 1; padding: 16px; display: flex; }
  .frame { flex: 1; background: #fff; border: 1px solid #e5e3df; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(26,26,26,.06); }
  .frame iframe { width: 100%; height: 100%; border: 0; }
</style></head><body>
<header><span class="brand"><span class="logo"></span>Your app</span><span class="file" id="file"></span></header>
<main><div class="frame" id="frame"></div></main>
<script type="module">
  import { KitionEmbed } from '/embed/index.js'
  window.openKit = async ({ kit, url, name, data }) => {
    document.getElementById('file').textContent = '/ ' + name
    const files = new Map([['file-1', { bytes: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), version: 1 }]])
    const storage = {
      read: async (id) => ({ bytes: files.get(id).bytes.slice(), version: 'v' + files.get(id).version }),
      stamp: async (id) => (files.has(id) ? 'v' + files.get(id).version : null),
      write: async (id, bytes) => { const next = { bytes: bytes.slice(), version: files.get(id).version + 1 }; files.set(id, next); return { version: 'v' + next.version } },
      create: async (fileName, bytes) => { const id = 'file-' + (files.size + 1); files.set(id, { bytes, version: 1 }); return { fileId: id, name: fileName, version: 'v1' } },
    }
    const identity = { user: () => ({ id: 'maya', name: 'Maya Chen' }), users: () => [], permissions: () => ({ mode: 'edit' }) }
    window.editor = await KitionEmbed.mount(document.getElementById('frame'), {
      kit: { id: kit, url }, file: { id: 'file-1', name }, storage, identity, locale: 'en-US',
      theme: { colorScheme: 'light', tokens: { '--kit-primary': '#5645d4' } },
    })
    window.mounted = true
  }
</script></body></html>`

const browser = await chromium.launch()
async function card(name, lines, aside = '') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 400 }, deviceScaleFactor: 2 })
  await page.setContent(terminal(lines, aside))
  await page.locator('main').screenshot({ path: path.join(out, `${name}.png`) })
  await page.close()
  console.log(`wrote assets/readme/${name}.png`)
}

/** Clips long lines for a picture, marking the cut. */
const clip = (text, width = 100) => text.split('\n').map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line))

/** One MCP session; `call` answers the tool's answer and logs a line for the picture. */
async function session(args) {
  // Only the kits named here: no KITION_KIT_<KIT>_BINARY from the environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^KITION_KIT_.*_BINARY$/.test(name)))
  const server = await connect(mcp, args, { env, stderr: 'ignore' })
  const lines = []
  const call = async (tool, params, show = params) => {
    const answer = await server.call(tool, params)
    lines.push(`$ ${tool} ${JSON.stringify(show)}`)
    const text = (answer.content?.find((item) => item.type === 'text')?.text ?? '').split('\n')[0]
    if (answer.isError) lines.push(...clip(`${answer.structuredContent?.error?.code ?? 'error'}: ${text}`).map(refusal))
    else lines.push(...clip(text))
    return answer
  }
  return { server, lines, call }
}

try {
  if (wanted('grid-kit')) {
    // examples/grid-kit headless: the smallest kit, served to an agent by kition-kits-mcp from its
    // kit.json and executable, drawing a cross with grid.set and showing its own preview.
    const kits = scratch()
    const workspace = scratch()
    mkdirSync(path.join(kits, 'grid'))
    copyFileSync(path.join(root, 'examples', 'grid-kit', 'kit.json'), path.join(kits, 'grid', 'kit.json'))
    copyFileSync(need(path.join(root, 'target', 'debug', 'kit-grid'), 'cargo build -p grid-kit-headless'), path.join(kits, 'grid', 'kit-grid'))
    copyFileSync(path.join(root, 'examples', 'grid-kit', 'fixture.grid'), path.join(workspace, 'fixture.grid'))
    const { server, lines, call } = await session(['--workspace', workspace, '--kits-dir', kits])
    const preview = (answer) => answer.content.find((item) => item.type === 'image')?.data
    lines.push(comment(`# the grid kit's tools: ${(await server.tools()).map((tool) => tool.name).join(', ')}`))
    const before = preview(await call('grid_inspect', { path: 'fixture.grid', preview: true }))
    const steps = [0, 1, 2, 3, 4, 5].flatMap((y) => [{ command: 'grid.set', params: { x: y + 1, y, grey: 0 } }, { command: 'grid.set', params: { x: 6 - y, y, grey: 0 } }])
    await call('grid_run', { path: 'fixture.grid', steps }, { path: 'fixture.grid', steps: [steps[0], '… 12 steps'] })
    const after = preview(await call('grid_inspect', { path: 'fixture.grid', preview: true }))
    await call('grid_check', { path: 'fixture.grid' })
    await server.close()
    const image = (data, label) => `<figure style="margin:0;text-align:center;font:13px ui-monospace,Menlo,monospace;color:#8a8780"><img src="data:image/png;base64,${data}" style="width:240px;image-rendering:pixelated;border-radius:8px;display:block;margin-bottom:8px" />${label}</figure>`
    await card('grid-kit', lines, `<div style="display:flex;gap:16px">${image(before, 'before')}${image(after, 'after')}</div>`)
  }

  if (wanted('embed')) {
    // examples/embed-app: a page of its own embeds the Note editor from another origin, over the
    // page's storage; "Run script" edits the open note through the object model.
    need(path.join(kitsDir, 'note-ui', 'kit-ui.json'), 'set KITION_KITS_DIR to a folder holding note-ui/')
    const env = { ...process.env, KITION_KITS_DIR: kitsDir, EMBED_APP_PORT: '5396', EMBED_KITS_PORT: '5397' }
    const server = spawn(node, [path.join(root, 'examples', 'embed-app', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the embed example did not start')), 60_000)
        server.stdout.on('data', (chunk) => {
          if (String(chunk).includes('5396')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
      await page.goto('http://127.0.0.1:5396/?user=alice&mode=edit&collab=0')
      await page.waitForFunction(() => Boolean(window.__EMBED_TEST__))
      await page.getByTestId('upload').setInputFiles({ name: 'Launch plan.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTE) })
      await page.locator('[data-file="Launch plan.md"]').getByTestId('file-open').click()
      const pane = page.locator('[data-pane="Launch plan.md"]')
      await pane.and(page.locator('[data-ready="true"]')).waitFor({ timeout: 90_000 })
      await page.waitForTimeout(2500)
      await page.screenshot({ path: path.join(out, 'embed.png') })
      console.log('wrote assets/readme/embed.png')
      await pane.getByTestId('pane-script').click()
      await page.getByTestId('notice').filter({ hasText: 'script:' }).waitFor({ timeout: 30_000 })
      // Down to the end of the note, where the script's section is.
      const box = await pane.locator('iframe').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 3000)
      await page.waitForTimeout(1500)
      await page.screenshot({ path: path.join(out, 'embed-script.png') })
      console.log('wrote assets/readme/embed-script.png')
      await page.close()
    } finally {
      server.kill()
    }
  }

  if (wanted('kits')) {
    // The kits showcase: Motion, Note and Table, each embedded in a page of "your app" with
    // @kition/embed, served from a kit origin of its own, on a sample made with its engine.
    for (const kit of ['motion-ui', 'note-ui', 'table-ui']) need(path.join(kitsDir, kit, 'kit-ui.json'), `set KITION_KITS_DIR to a folder holding ${kit}/`)
    const samples = await kitSamples()
    const appOrigin = 'http://127.0.0.1:5398'
    // The page, and @kition/embed's build under /embed/.
    const app = await serve(path.join(root, 'packages', 'embed', 'dist'), 5398, {}, { '/': APP_PAGE }, '/embed/')
    const kits = await serve(kitsDir, 5399, { 'content-security-policy': kitPolicy(appOrigin) })
    try {
      const shots = [
        { name: 'kit-motion', kit: 'kit.motion', package: 'motion-ui', file: 'Launch title.kmotion', bytes: samples.motion, wait: 6000, jpeg: true, // gradients compress far better as JPEG
          // The title layer selected, and the time moved to 2.5 s, after both entrances.
          then: async (page) => {
            const kit = page.frameLocator('iframe')
            await kit.getByText('Launch Day', { exact: true }).first().click()
            await page.waitForTimeout(800)
            const ruler = await kit.getByText('3s', { exact: true }).first().boundingBox()
            const start = await kit.getByText('0s', { exact: true }).first().boundingBox()
            await page.mouse.click(start.x + (ruler.x - start.x) * (2.5 / 3), ruler.y + ruler.height / 2)
            await page.waitForTimeout(2500)
          } },
        { name: 'kit-note', kit: 'kit.note', package: 'note-ui', file: 'Launch plan.md', bytes: Buffer.from(NOTE), wait: 3000 },
        { name: 'kit-table', kit: 'kit.table', package: 'table-ui', file: 'Launch tracker.ktable', bytes: samples.table, wait: 4000 },
      ]
      for (const shot of shots) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
        page.on('pageerror', (error) => console.log(`${shot.name}: ${error.message}`))
        await page.goto(`${appOrigin}/`)
        await page.waitForFunction(() => typeof window.openKit === 'function')
        await page.evaluate((options) => window.openKit(options), { kit: shot.kit, url: `http://127.0.0.1:5399/${shot.package}/`, name: shot.file, data: Buffer.from(shot.bytes).toString('base64') })
        await page.waitForFunction(() => window.mounted === true, null, { timeout: 90_000 })
        await page.waitForTimeout(shot.wait)
        if (shot.then) await shot.then(page)
        const file = `${shot.name}.${shot.jpeg ? 'jpg' : 'png'}`
        await page.screenshot({ path: path.join(out, file), ...(shot.jpeg ? { type: 'jpeg', quality: 85 } : {}) })
        console.log(`wrote assets/readme/${file}`)
        await page.close()
      }
    } finally {
      app.close()
      kits.close()
    }
  }

  if (wanted('agent-mcp')) {
    // examples/agent-mcp: an agent edits a note in a workspace folder over MCP, then checks it.
    const workspace = scratch()
    const env = { ...process.env, KITION_KITS_MCP: mcp, KITION_KIT_NOTE_BINARY: noteBinary() }
    const output = execFileSync(node, [path.join(root, 'examples', 'agent-mcp', 'run.mjs'), workspace], { env, encoding: 'utf8' })
    const shown = output.trim().split('\n').filter((line) => !line.startsWith('RESULT '))
    const saved = readFileSync(path.join(workspace, 'Notes.md'), 'utf8').trimEnd().split('\n')
    await card('agent-mcp', ['$ node examples/agent-mcp/run.mjs <folder>', ...shown, '', '$ cat <folder>/Notes.md', ...saved])
  }

  if (wanted('scripts')) {
    // examples/sdk-scripts and examples/extensions/title-case, in Node on the Note kit's package.
    need(path.join(kitsDir, 'note-ui', 'kit-ui.json'), 'set KITION_KITS_DIR to a folder holding note-ui/')
    const env = { ...process.env, KITION_KITS_DIR: kitsDir }
    const review = execFileSync(node, [path.join(root, 'examples', 'sdk-scripts', 'run-node.mjs')], { env, encoding: 'utf8' }).trim()
    // The script's answer (JSON), then what the saved file holds when it is opened again.
    const reopened = review.split('\n').filter((line) => line.startsWith('saved and reopened'))
    const done = JSON.parse(review.slice(review.indexOf('{'), review.indexOf('\n}') + 2))
    const extension = await titleCase()
    await card('scripts', [
      '$ node examples/sdk-scripts/run-node.mjs',
      `heading: ${done.heading} (level ${done.level})`,
      `task: ${JSON.stringify(done.task)}`,
      ...done.text.trimEnd().split('\n').map((line) => `  ${line}`),
      ...reopened.flatMap((line) => clip(line)),
      '',
      comment('# examples/extensions/title-case on a note, through the extension host'),
      ...extension.split('\n'),
    ])
  }

  if (wanted('concurrent')) {
    // Two writes resting on what the agent read, after the person changed one table cell.
    const workspace = scratch()
    writeFileSync(path.join(workspace, 'launch.md'), NOTE)
    const { server, lines, call } = await session(['--workspace', workspace, '--kit', noteBinary()])
    const read = await call('note_inspect', { path: 'launch.md', preview: false }, { path: 'launch.md' })
    const basis = read.structuredContent.revision
    const file = path.join(workspace, 'launch.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('| Preview | Paid teams    | Nov 20 |', '| Preview | Paid teams    | Nov 18 |'))
    lines.push(comment('# meanwhile the person moves the preview to Nov 18 and saves'))
    const cell = { command: 'table.setCell', params: { table: 0, row: 2, column: 2, text: 'Nov 22' } }
    await call('note_run', { path: 'launch.md', basis, steps: [cell] }, { basis, steps: [cell] })
    const status = { command: 'property.set', params: { key: 'status', value: 'ready' } }
    await call('note_run', { path: 'launch.md', basis, steps: [status] }, { basis, steps: [status] })
    await server.close()
    const text = readFileSync(file, 'utf8')
    lines.push(good(`✓ in the file: status ${/status: (.*)/.exec(text)[1]}, preview on ${/\| Preview \| Paid teams +\| (.*?) +\|/.exec(text)[1]}`))
    await card('concurrent', lines)
  }
} finally {
  await browser.close()
}
