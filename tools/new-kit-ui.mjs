#!/usr/bin/env node
// Scaffolds a kit's own editor (the Kition kit platform's kit editors, docs/platform/kits/ui.md) in `<repo>/web`: a Vite + React app on
// @kition/kit-editor, its engine built to WebAssembly into `public/engine`, and a development host.
// Existing files are kept, so it can be run again to add what is missing.
//
//   node tools/new-kit-ui.mjs --repo ./example-kit --id example.notes --name Notes \
//     --crate example-notes --module example_notes --class NotesDocument \
//     --sample Sample.docx --accept .docx --port 5181
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
)
for (const key of ['repo', 'id', 'name', 'crate', 'module', 'class', 'sample', 'accept', 'port']) {
  if (!args[key]) {
    console.error(`missing --${key}`)
    process.exit(2)
  }
}
const web = path.resolve(args.repo, 'web')
const slug = args.id.replace(/^kit\./, '')

const files = {
  'package.json': `${JSON.stringify(
    {
      name: `kition-${slug}-ui`,
      version: '0.1.0',
      private: true,
      description: `The ${args.name} kit's own editor (Kition kit platform, kit editors), embedded by hosts over the Kit UI protocol.`,
      license: 'Apache-2.0',
      type: 'module',
      scripts: { engine: 'sh scripts/build-engine.sh', dev: 'vite', build: 'tsc --noEmit && vite build', typecheck: 'tsc --noEmit' },
      dependencies: {
        '@kition/kit-editor': 'link:../../kition-sdk/packages/kit-editor',
        '@kition/kit-host': 'link:../../kition-sdk/packages/kit-host',
        '@kition/kit-ui-protocol': 'link:../../kition-sdk/packages/kit-ui-protocol',
        '@kition/kit-dev-host': 'link:../../kition-sdk/packages/kit-dev-host',
        '@kition/tessera-icons': 'link:../../kition-tessera/packages/icons',
        react: '^19.2.5',
        'react-dom': '^19.2.5',
      },
      devDependencies: {
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@vitejs/plugin-react': '^4.3.0',
        typescript: '^5.6.0',
        vite: '^6.0.0',
      },
    },
    null,
    2,
  )}\n`,
  'vite.config.ts': `import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The kit package is served from wherever a host puts it, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // @kition/kit-editor is linked from kition-sdk; one React for the page.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: { exclude: ['@kition/kit-editor', '@kition/kit-host', '@kition/kit-ui-protocol', '@kition/kit-dev-host'] },
  worker: { format: 'es' },
  server: {
    port: ${Number(args.port)},
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url)), fileURLToPath(new URL('../../kition-sdk', import.meta.url)), fileURLToPath(new URL('../../kition-tessera', import.meta.url))] },
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input: { index: fileURLToPath(new URL('index.html', import.meta.url)), dev: fileURLToPath(new URL('dev.html', import.meta.url)) } },
  },
})
`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable', 'WebWorker'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        isolatedModules: true,
        resolveJsonModule: true,
        types: ['vite/client'],
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`,
  '.gitignore': 'node_modules/\ndist/\npublic/engine/\n',
  'index.html': `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${args.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
  'dev.html': `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="UTF-8" />
    <title>${args.name} kit: development host</title>
    <style>
      html, body { height: 100%; margin: 0; font-family: system-ui, sans-serif; }
      body { display: flex; flex-direction: column; }
      header { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #e5e3df; font-size: 13px; }
      iframe { flex: 1; border: 0; }
    </style>
  </head>
  <body>
    <header><strong>Development host</strong><span id="status">opening…</span><span style="flex: 1"></span><input id="file" type="file" accept="${args.accept}" /></header>
    <iframe id="kit" src="about:blank" allow="fullscreen; clipboard-read; clipboard-write" title="${args.name}"></iframe>
    <script type="module" src="./src/devHost.ts"></script>
  </body>
</html>
`,
  'scripts/build-engine.sh': `#!/bin/sh
# Builds the ${args.name} engine (crates/${args.crate}) to WebAssembly into public/engine, where the
# editor loads it from its own package. Needs wasm-pack.
set -eu
web="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$web/.." && pwd)"
if toolchain="$(rustc --print sysroot 2>/dev/null)" && [ -d "$toolchain/lib" ]; then
  export DYLD_FALLBACK_LIBRARY_PATH="$toolchain/lib\${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
fi
export CARGO_TARGET_DIR="\${CARGO_TARGET_DIR:-$repo/target}"
cd "$repo"
wasm-pack build crates/${args.crate} --target web --release --no-typescript --out-dir "$web/public/engine"
rm -f "$web/public/engine/.gitignore" "$web/public/engine/package.json"
`,
  'src/main.tsx': `import { createRoot } from 'react-dom/client'
import { connectHost, createKitStrings, defineKitUi } from '@kition/kit-editor'
import '@kition/kit-editor/styles.css'
import './app.css'
import { App } from './App'
import { CATALOGS } from './strings'
import manifest from '../../kit.json'

/** Every element this editor draws besides engine commands and menus (Kit UI protocol section 9). */
const KIT_UI = defineKitUi({ tools: [], panels: [], tabs: [], groups: [], controls: [] })

const root = createRoot(document.getElementById('root')!)

// Opened outside a host, the page says where it belongs instead of waiting forever.
const alone = window.setTimeout(() => {
  const t = createKitStrings(CATALOGS, navigator.language)
  root.render(<div className="kui-alone">{t('noHost')}</div>)
}, 3000)

void connectHost({ id: '${args.id}', version: '0.1.0', capabilities: ['ai'], brand: manifest.ui?.brand, display: manifest.ui?.display, ui: KIT_UI }).then((host) => {
  window.clearTimeout(alone)
  // No StrictMode: its doubled effects would open the document twice, in two engine workers.
  root.render(<App host={host} />)
})
`,
  'src/devHost.ts': `/** The development host (dev.html): opens \`public/sample/${args.sample}\`, or a file chosen in the page. */
import { startDevHost } from '@kition/kit-dev-host'

startDevHost({ sample: './sample/${args.sample}' })
`,
  'src/engine.ts': `import type { KitModuleManifest } from '@kition/kit-editor'

/** The engine, from this package's own folder. */
export function engineManifest(): KitModuleManifest {
  return {
    kitId: '${args.id}',
    base: new URL('./engine/', document.baseURI).href,
    module: '${args.module}',
    documentClass: '${args.class}',
  }
}
`,
}

let wrote = 0
for (const [name, content] of Object.entries(files)) {
  const target = path.join(web, name)
  if (fs.existsSync(target)) continue
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  if (name.endsWith('.sh')) fs.chmodSync(target, 0o755)
  wrote += 1
}
fs.mkdirSync(path.join(web, 'public/sample'), { recursive: true })
console.log(`${web}: wrote ${wrote} files; add src/App.tsx, src/strings.ts, src/app.css, and public/sample/${args.sample}`)
