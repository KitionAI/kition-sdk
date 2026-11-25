#!/usr/bin/env node
// @kition/sdk's editor worker as a kit serves it. The packed archive (node
// tools/pack-public-packages.mjs sdk writes target/npm-pack/sdk.tgz) is installed in a project in
// the system's temporary folder, outside the workspace (tools/sdk-consumer.mjs: offline, its peers
// linked), with a kit editor's Vite configuration (kitViteConfig, as kition-html's: @kition/sdk not
// pre-bundled, module workers). Its page, a React app importing the editor's KitEngine, is built
// (vite build) and served as static files (vite preview): the build emits the editor's worker as
// an asset of its own, the page's code starts it from that file, the server answers it as
// JavaScript, and it inlines no WebAssembly (no data:application/wasm, no large base64 data: URL).
// Prints the kit build's dist/assets.
//
//   node tools/smoke-sdk-worker.mjs [--archive <sdk.tgz>] [--tessera <@kition/tessera folder>] [--keep] [--build-only]
//
// --build-only is what release.yml passes; the production build is the only one this smoke runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { build, preview } from 'vite'
import { consumerInputs, installSdk, kitViteConfig } from './sdk-consumer.mjs'
import { SDK } from './sdk-package.mjs'

const args = process.argv.slice(2)
const { archive, tessera } = consumerInputs('smoke-sdk-worker', args)
const consumer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kition-sdk-worker-')))

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
window.KitEngine = KitEngine
`)

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

  const workers = files.filter((file) => /^kitEngine\.worker-[\w-]+\.js$/.test(file))
  assert.equal(workers.length, 1, `the kit's build emits the editor's worker as one asset: ${files.join(', ')}`)
  const starters = files.filter((file) => file.endsWith('.js') && file !== workers[0] && fs.readFileSync(path.join(assets, file), 'utf8').includes(workers[0]))
  assert.ok(starters.length > 0, `a chunk of the page starts ${workers[0]}`)
  const served = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } })
  servers.push(() => new Promise((resolve, reject) => served.httpServer.close((error) => (error ? reject(error) : resolve()))))
  const response = await fetch(new URL(`assets/${workers[0]}`, served.resolvedUrls.local[0]))
  assert.equal(response.status, 200, `the server answers assets/${workers[0]}`)
  assert.match(response.headers.get('content-type') ?? '', /javascript/, `assets/${workers[0]} is served as JavaScript`)
  const script = await response.text()
  assert.ok(!/data:application\/wasm/.test(script) && !/;base64,[A-Za-z0-9+/]{65536}/.test(script), 'the worker inlines no WebAssembly')
  console.log(`PASS build: the editor's worker (assets/${workers[0]}, ${kb(Buffer.byteLength(script))}) is an asset of its own, started by ${starters.join(', ')}, served as ${response.headers.get('content-type')}, nothing inlined`)
  console.log('\nsmoke-sdk-worker: 1 check passed')
} finally {
  for (const close of servers) await close()
  if (!args.includes('--keep')) fs.rmSync(consumer, { recursive: true, force: true })
  else console.log(`kept ${consumer}`)
}
