#!/usr/bin/env node
// Builds the plugin's browser module, lib/client.js, from src/client/: one script DeepSeek
// Harness's module loader runs (`window.__ModuleLoader__.load({ id, factory })`), with React from
// the loader's `require` and everything else, @kition/gateway-page's protocol included, inside.
// The table of the extensions each published kit edits is made here, from published-kits.json and
// the kits' committed manifests (crates/kition-kits/tests/fixtures/kits/<kit>.json), never by hand.
// lib/client.js is committed: the package is installed from its archive with nothing built.
//
//   node build-client.mjs            write lib/client.js
//   node build-client.mjs --out <f>  write <f> only (the test that checks the committed copy)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdk = path.resolve(here, '../../..')

/** The module id DeepSeek Harness loads the browser module under: the package's name. */
export const MODULE_ID = '@kition/dsh-kits'

/**
 * Each extension a published kit edits, and the kit: `{ md: 'note', ... }`, sorted. A kit's
 * view-only formats are left out (the gateway's page opens edit formats only); an extension two
 * kits edit goes to the first in published-kits.json, as the page chooses.
 */
export function extensionTable() {
  const published = JSON.parse(fs.readFileSync(path.join(sdk, 'published-kits.json'), 'utf8'))
  const table = {}
  for (const kit of published) {
    const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'crates/kition-kits/tests/fixtures/kits', `${kit}.json`), 'utf8'))
    for (const format of manifest.formats ?? []) {
      if (format.role !== 'edit') continue
      for (const extension of format.extensions) table[extension.toLowerCase()] ??= kit
    }
  }
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
}

/** The browser module's source: the bundle wrapped for the module loader. */
export async function buildClient() {
  const { build } = await import('vite')
  const table = extensionTable()
  const output = await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@kition/gateway-page': path.join(sdk, 'packages/gateway-page/src/index.ts') } },
    plugins: [
      {
        name: 'kition-kit-extensions',
        resolveId: (id) => (id === 'virtual:kit-extensions' ? '\0kit-extensions' : null),
        load: (id) => (id === '\0kit-extensions' ? `export default ${JSON.stringify(table)}` : null),
      },
    ],
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      lib: { entry: path.join(here, 'src/client/index.ts'), formats: ['cjs'], fileName: () => 'client.js' },
      rollupOptions: { external: ['react'], output: { exports: 'named', interop: 'auto' } },
    },
  })
  const chunk = [output].flat()[0].output.find((file) => file.type === 'chunk')
  // Not indented: that would change the text of multi-line template literals.
  const body = chunk.code.replace(/\n+$/, '')
  return [
    '// @kition/dsh-kits: the Kition kits in DeepSeek Harness, the browser module. Built by build-client.mjs',
    '// from src/client/; do not edit.',
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(MODULE_ID)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    body,
    '    return module.exports;',
    '  }',
    '});',
    '',
  ].join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out')
  const out = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(here, 'lib/client.js')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, await buildClient())
  if (at < 0) console.log(`built ${path.relative(process.cwd(), out)}`)
}
