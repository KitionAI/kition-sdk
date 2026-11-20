#!/usr/bin/env node
// Builds the editor page (page/index.html, src/page/) into dist/page/ and into kition-kits-http's
// page/, where `kition gateway` embeds it (crates/kition-kits-http/src/page.rs): index.html,
// page.js and page.css, with fixed names (the gateway caches them by content, `ETag`) and relative
// addresses (the page works under any path prefix).
//
//   node build-page.mjs            build both
//   node build-page.mjs --out <d>  build into <d> only (the test that checks the embedded copy)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const embedded = path.resolve(here, '../../crates/kition-kits-http/page')
const at = process.argv.indexOf('--out')
const out = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(here, 'dist/page')

await build({
  root: path.join(here, 'page'),
  base: './',
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: out,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.join(here, 'page/index.html'),
      output: { entryFileNames: 'page.js', chunkFileNames: 'page-[name].js', assetFileNames: 'page.[ext]', inlineDynamicImports: true },
    },
  },
})
const files = fs.readdirSync(out).sort()
if (files.join(',') !== 'index.html,page.css,page.js') throw new Error(`the page built into ${files.join(', ')}; the gateway embeds index.html, page.css and page.js`)
if (at < 0) {
  fs.mkdirSync(embedded, { recursive: true })
  for (const file of files) fs.copyFileSync(path.join(out, file), path.join(embedded, file))
  console.log(`built the editor page into ${path.relative(process.cwd(), out)} and ${path.relative(process.cwd(), embedded)}`)
}
