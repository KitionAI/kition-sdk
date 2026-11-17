#!/usr/bin/env node
// Exercise the packed editor worker and engine through a consumer's production bundle.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const consumer = fs.mkdtempSync(path.join(root, 'target/npm-consumer-'))
const modules = path.join(consumer, 'node_modules')
fs.mkdirSync(path.join(modules, '@kition'), { recursive: true })
for (const archive of fs.readdirSync(path.join(root, 'target/npm-pack')).filter((name) => name.endsWith('.tgz'))) {
  const unpacked = fs.mkdtempSync(path.join(consumer, 'unpack-'))
  execFileSync('tar', ['-xzf', path.join(root, 'target/npm-pack', archive), '-C', unpacked])
  const pkg = path.join(unpacked, 'package')
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
  fs.renameSync(pkg, path.join(modules, manifest.name))
}
for (const name of ['react', 'react-dom']) fs.symlinkSync(path.join(root, 'node_modules', name), path.join(modules, name), 'dir')
fs.symlinkSync(path.join(root, 'packages/kdm/node_modules/loro-crdt'), path.join(modules, 'loro-crdt'), 'dir')
for (const name of ['ui', 'icons', 'tokens']) fs.symlinkSync(path.join(root, '..', 'kition-tessera/packages', name), path.join(modules, '@kition', `tessera-${name}`), 'dir')
fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}\n')
fs.writeFileSync(path.join(consumer, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>\n')
fs.writeFileSync(path.join(consumer, 'main.js'), `
import { KitEngine } from '@kition/kit-editor'
import '@kition/kit-editor/styles.css'
const schema = {kdm:1,kit:'kit.smoke',schemaVersion:1,root:'Root',types:{Root:{fields:{title:{kind:'string'}}}}}
window.smoke = async () => {
  const engine = await KitEngine.open({kitId:'kit.smoke',base:'/engine',module:'engine',documentClass:'SmokeDocument',runtime:'ts-worker'}, 'smoke.txt', new TextEncoder().encode('Packed engine').buffer)
  try {
    const described = await engine.modelDescribe(schema)
    if (described.kit !== 'kit.smoke') throw new Error('model did not load')
    const loaded = await engine.modelBatch({ops:[],load:[{target:'root',fields:['title']}]}, schema)
    if (loaded.loaded[0].fields.title !== 'Packed engine') throw new Error('model did not read the document')
    return new TextDecoder().decode(await engine.save())
  } finally { engine.dispose() }
}
`)
fs.writeFileSync(path.join(consumer, 'engine.js'), `
import { newDocId, parseSchema, Replica, system } from '@kition/kdm'
import { kitEngineClass } from '@kition/kit-engine'
const schema = parseSchema({kdm:1,kit:'kit.smoke',schemaVersion:1,root:'Root',types:{Root:{fields:{title:{kind:'string'}}}}})
export default async function prepare() {}
export const SmokeDocument = kitEngineClass({schema,load:replica=>({title:replica.get(replica.objectsOfType('Root')[0],'title')}),apply:()=>({kind:'full'}),command:()=>null,commands:()=>[],import:(_name,bytes,actor)=>Replica.createWith(schema,newDocId(),actor,system('import'),tx=>tx.create('Root',{title:new TextDecoder().decode(bytes)})).replica,export:view=>new TextEncoder().encode(view.title)})
`)
await build({ root: consumer, configFile: false, resolve: { dedupe: ['react', 'react-dom'] }, build: { sourcemap: false } })
await build({ root: consumer, configFile: false, resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] }, build: {
  lib: { entry: path.join(consumer, 'engine.js'), formats: ['es'], fileName: () => 'engine.js' }, outDir: 'dist/engine', sourcemap: false,
} })
const server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } })
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`) })
  await page.goto(server.resolvedUrls.local[0])
  assert.equal(await page.evaluate(() => Promise.race([window.smoke(), new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not answer')), 15000))])), 'Packed engine')
  assert.deepEqual(errors, [])
  console.log('PASS packed editor starts its worker, opens the packed engine, and saves its document')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
}
