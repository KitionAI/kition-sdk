#!/usr/bin/env node
// @kition/sdk's editor worker in Chromium, as a kit serves it. The packed archive (node
// tools/pack-public-packages.mjs sdk writes target/npm-pack/sdk.tgz) is installed in a project in
// the system's temporary folder, outside the workspace (tools/sdk-consumer.mjs: offline, its
// dependency and peers linked), with a kit editor's Vite configuration (kitViteConfig, as
// kition-html's: @kition/sdk not pre-bundled, module workers). Its page starts the editor's engine
// worker (KitEngine.open) on a small kit engine of its own (built from @kition/sdk/kdm and
// /engine), reads the object model, writes one field through the worker's KDM (model/batch set,
// Loro in the worker) and saves the document, which the engine writes from its replica: it must
// carry the new value. It runs twice:
//
//   build   the kit's production build (vite build), served as static files (vite preview);
//   dev     the kit's development server (vite), the package served unbundled.
//
// Each time Loro's WebAssembly must come as a response of its own, a .wasm file with the
// content type application/wasm (what WebAssembly.instantiateStreaming needs), and the worker's
// script must inline no WebAssembly (no data:application/wasm, no large base64 data: URL); no
// request fails and the page throws nothing. Prints the kit build's dist/assets.
//
//   node tools/smoke-sdk-worker.mjs [--archive <sdk.tgz>] [--tessera <@kition/tessera folder>] [--keep] [--build-only]
//
// --build-only runs the production build alone, as release.yml does: with a Tessera npm installed
// (outside the consumer), the development server serves react-dom unbundled (CommonJS, "does not
// provide an export named 'default'") under kition-html's settings, which leave @kition/sdk out of
// Vite's optimizer and include nothing of Tessera; a kit includes '@kition/tessera/ui' there.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import { build, createServer, preview } from 'vite'
import { consumerInputs, installSdk, kitViteConfig } from './sdk-consumer.mjs'
import { SDK } from './sdk-package.mjs'

const args = process.argv.slice(2)
const { archive, tessera } = consumerInputs('smoke-sdk-worker', args)
const consumer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kition-sdk-worker-')))
const TITLE = 'Through the worker'

/** The page's answer and what the browser fetched, at `url`. */
async function run(browser, url, mode) {
  const page = await browser.newPage()
  const errors = []
  const responses = []
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  // Dedicated workers' requests are the page's too.
  page.on('response', (response) => {
    responses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] ?? '' })
    if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`)
  })
  // An error, or Loro's glue warning that it fell back from WebAssembly.instantiateStreaming (a
  // wasm served with another content type), fails the run.
  page.on('worker', (worker) => worker.on('console', (message) => { if (message.type() === 'error' || /instantiateStreaming/.test(message.text())) errors.push(`worker ${message.type()}: ${message.text()}`) }))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.smoke === 'function', null, { timeout: 30000 }).catch((error) => {
    throw new Error(`${mode}: the page did not load (${error.message}):\n${errors.join('\n')}`)
  })
  const answer = await page.evaluate(() => Promise.race([window.smoke(), new Promise((_, reject) => setTimeout(() => reject(new Error('the worker did not answer in 30 s')), 30000))]))
  await page.close()
  assert.deepEqual(errors, [], `${mode}: nothing fails`)
  assert.deepEqual(answer, { described: 'kit.smoke', before: 'Packed engine', after: TITLE, saved: TITLE }, `${mode}: the worker reads, writes and saves through KDM`)
  const wasm = responses.filter((response) => new URL(response.url).pathname.endsWith('.wasm'))
  assert.equal(wasm.length, 1, `${mode}: Loro's wasm is fetched once, as a file of its own: ${responses.map((response) => response.url).join(', ')}`)
  assert.equal(wasm[0].status, 200, `${mode}: ${wasm[0].url}`)
  assert.match(wasm[0].type, /^application\/wasm(?:;|$)/, `${mode}: ${wasm[0].url} is served as application/wasm`)
  assert.match(new URL(wasm[0].url).pathname, /loro_wasm_bg[\w-]*\.wasm$/, `${mode}: it is Loro's`)
  const workers = responses.filter((response) => /kitEngine\.worker[^/]*\.js/.test(new URL(response.url).pathname))
  assert.equal(workers.length, 1, `${mode}: the worker's script is fetched: ${responses.map((response) => response.url).join(', ')}`)
  // The development server appends the worker's source map as a data: URL; that is not WebAssembly.
  const script = (await (await fetch(workers[0].url)).text()).replace(/\n\/\/# sourceMappingURL=data:application\/json;[^\n]*/g, '')
  assert.ok(!/data:application\/wasm/.test(script) && !/;base64,[A-Za-z0-9+/]{65536}/.test(script), `${mode}: the worker inlines no WebAssembly`)
  console.log(`PASS ${mode}: the editor's worker (${new URL(workers[0].url).pathname}, ${(Buffer.byteLength(script) / 1e3).toFixed(0)} kB) fetched Loro's wasm ${new URL(wasm[0].url).pathname} as ${wasm[0].type}, read the model, set its title through KDM and saved "${answer.saved}"`)
}

let browser
const servers = []
try {
  installSdk({ consumer, archive, tessera })
  fs.writeFileSync(path.join(consumer, 'index.html'), '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n')
  fs.writeFileSync(path.join(consumer, 'main.js'), `
import { KitEngine } from '${SDK}/editor'
// A kit's page is a React app (its own code imports React, which Vite's scanner then pre-bundles).
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
createRoot(document.body.appendChild(document.createElement('div'))).render(jsx('p', { children: createElement('span', null, 'kit') }))
const schema = { kdm: 1, kit: 'kit.smoke', schemaVersion: 1, root: 'Root', types: { Root: { fields: { title: { kind: 'string' } } } } }
window.smoke = async () => {
  const engine = await KitEngine.open({ kitId: 'kit.smoke', base: '/engine', module: 'engine', documentClass: 'SmokeDocument', runtime: 'ts-worker' }, 'smoke.txt', new TextEncoder().encode('Packed engine').buffer)
  try {
    const described = (await engine.modelDescribe(schema)).kit
    const before = (await engine.modelBatch({ ops: [], load: [{ target: 'root', fields: ['title'] }] }, schema)).loaded[0].fields.title
    const after = (await engine.modelBatch({ ops: [{ op: 'set', target: 'root', field: 'title', value: ${JSON.stringify(TITLE)} }], load: [{ target: 'root', fields: ['title'] }] }, schema)).loaded[0].fields.title
    return { described, before, after, saved: new TextDecoder().decode(await engine.save()) }
  } finally { engine.dispose() }
}
`)
  // The kit's engine: a TypeScript engine of its own, with its own Loro (inlined, as a kit's
  // engine bundle may have it), served at /engine/engine.js in both modes.
  fs.writeFileSync(path.join(consumer, 'engine.js'), `
import { newDocId, parseSchema, Replica, system } from '${SDK}/kdm'
import { kitEngineClass } from '${SDK}/engine'
const schema = parseSchema({ kdm: 1, kit: 'kit.smoke', schemaVersion: 1, root: 'Root', types: { Root: { fields: { title: { kind: 'string' } } } } })
export default async function prepare() {}
export const SmokeDocument = kitEngineClass({ schema, load: (replica) => ({ title: replica.get(replica.objectsOfType('Root')[0], 'title') }), apply: () => ({ kind: 'full' }), command: () => null, commands: () => [], import: (_name, bytes, actor) => Replica.createWith(schema, newDocId(), actor, system('import'), (tx) => tx.create('Root', { title: new TextDecoder().decode(bytes) })).replica, export: (_view, replica) => new TextEncoder().encode(replica.get(replica.objectsOfType('Root')[0], 'title')) })
`)
  await build({ root: consumer, configFile: false, logLevel: 'error', resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] }, build: {
    lib: { entry: path.join(consumer, 'engine.js'), formats: ['es'], fileName: () => 'engine.js' }, outDir: path.join(consumer, 'public/engine'), emptyOutDir: true, copyPublicDir: false, sourcemap: false,
  } })

  const config = kitViteConfig(consumer)
  await build(config)
  const assets = path.join(consumer, 'dist/assets')
  const files = fs.readdirSync(assets).sort()
  const kb = (bytes) => `${(bytes / 1e3).toFixed(0)} kB`
  console.log(`the kit's dist/assets (${files.length} files):`)
  let raw = 0
  let gzip = 0
  let brotli = 0
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(assets, file))
    const sizes = [bytes.length, gzipSync(bytes, { level: 9 }).length, brotliCompressSync(bytes).length]
    raw += sizes[0]
    gzip += sizes[1]
    brotli += sizes[2]
    console.log(`  ${file}: ${kb(sizes[0])} raw, ${kb(sizes[1])} gzip, ${kb(sizes[2])} brotli`)
  }
  console.log(`  in all: ${kb(raw)} raw, ${kb(gzip)} gzip, ${kb(brotli)} brotli`)

  browser = await chromium.launch({ headless: true })
  const served = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } })
  servers.push(() => new Promise((resolve, reject) => served.httpServer.close((error) => (error ? reject(error) : resolve()))))
  await run(browser, served.resolvedUrls.local[0], 'build')

  if (args.includes('--build-only')) {
    console.log('\nsmoke-sdk-worker: 1 check passed (--build-only: the development server is not run)')
  } else {
    const dev = await createServer({ ...config, server: { host: '127.0.0.1', strictPort: false } })
    servers.push(() => dev.close())
    await dev.listen()
    await run(browser, dev.resolvedUrls.local[0], 'dev')
    console.log('\nsmoke-sdk-worker: 2 checks passed')
  }
} finally {
  await browser?.close()
  for (const close of servers) await close()
  if (!args.includes('--keep')) fs.rmSync(consumer, { recursive: true, force: true })
  else console.log(`kept ${consumer}`)
}
