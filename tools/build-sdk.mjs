#!/usr/bin/env node
// Builds @kition/sdk (packages/sdk/dist) from the twelve library packages' sources, by the mapping
// in tools/sdk-package.mjs; packages/sdk's `build` script. It reads no package's own dist/.
//
//   node tools/build-sdk.mjs
//
// dist/standalone/  @kition/sdk/embed (its index.js is the top, which the embed server serves as
//                   /assets/embed/) and @kition/sdk/script/standalone (script/index.js): one Vite
//                   build with Loro's WebAssembly inlined (loro-crdt/base64), so a page needs no
//                   bundler setup; the two share their chunks, so Loro is there once.
// dist/lib/<dir>/   every other subpath, /script and /extensions among them: one Vite build, its
//                   packages' cross-imports shared chunks (dist/lib/chunks), loro-crdt, React and
//                   Tessera left imports (a dependency and optional peers), so /kdm, /sync, /script
//                   and /extensions in one page hold one Loro and one KDM; an import of
//                   @kition/embed points at dist/standalone. The editor's worker (dist/lib/assets)
//                   is a bundle of its own, with its own Loro, as a worker must be; Loro's
//                   WebAssembly is a file beside it (loro_wasm_bg-<hash>.wasm), never inlined,
//                   so a kit's bundler emits it as an asset and a browser caches it and compiles
//                   it apart from the worker.
// dist/types/<dir>/ the declarations of all twelve, from one TypeScript program: each package's
//                   name is a relative import, Loro's types opaque (dist/types/loro-crdt.d.ts),
//                   and every relative import has its .js, for `bundler` and `node16` alike.
// dist/lib/node-only/  what a browser gets for a Node-only subpath (@kition/sdk/embed/server): an
//                   error naming why.
// Styles, HTML pages and .mjs helpers are copied; Tessera is named by tesseraSpecifier everywhere.
// Old package names in what is emitted (comments, error messages, usage lines, declarations' doc
// comments) are renamed by the same mapping (renameOldNames), but the client names a library sends a
// server (CLIENT_NAMES); the build fails when an old name is left anywhere in dist/.
import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'vite'
import { packageNoticeSection } from './bundled-notices.mjs'
import { BINS, editorWorkerProblems, jsBase, nodeOnlyStub, oldNamesIn, PARTS, renameOldNames, SDK, standaloneKitModules, subpaths, tesseraImport } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = path.join(root, 'packages/sdk')
const dist = path.join(sdkDir, 'dist')
const types = path.join(dist, 'types')
const list = subpaths()
const isCode = (source) => /\.tsx?$/.test(source)
const sourceOf = (part, source) => path.join(root, 'packages', part.dir, source)

fs.rmSync(dist, { recursive: true, force: true })

/** The directories of the npm packages whose code the bundles (workers included) contain. */
const bundled = new Set()
const recordBundled = () => ({
  name: 'kition-bundled-packages',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      for (const id of Object.keys(chunk.modules ?? {})) {
        const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replace(/^\0/, ''))
        if (match) bundled.add(match[1])
      }
    }
  },
})

/** `{ <name under base>: <source file> }` of a group's built subpaths. */
function entries(group, base) {
  const found = {}
  for (const { group: built, part, source, js } of list) {
    if (built !== group || !isCode(source)) continue
    found[js.slice(`./dist/${base}/`.length).replace(/\.js$/, '')] = sourceOf(part, source)
  }
  // The kit modules register their kit on load: files of their own (standaloneKitModules).
  if (group === 'standalone') for (const [name, source] of Object.entries(standaloneKitModules())) found[name] = sourceOf(PARTS.find((part) => part.dir === 'script'), source)
  return found
}

/** Old package names in emitted code (renderChunk, before hashing) and text assets, as @kition/sdk names them. */
const newNames = () => ({
  name: 'kition-sdk-names',
  renderChunk(code) {
    const next = renameOldNames(code)
    return next === code ? null : { code: next, map: null }
  },
  generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'asset' && /\.(?:css|js|mjs|html)$/.test(file.fileName)) file.source = renameOldNames(typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8'))
    }
  },
})

// 1. The standalone group: Loro inlined, one copy for embed and the standalone object model.
await build({
  root: sdkDir,
  base: './',
  configFile: false,
  logLevel: 'warn',
  plugins: [recordBundled(), newNames()],
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] },
  build: {
    outDir: path.join(dist, 'standalone'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: { entry: entries('standalone', 'standalone'), formats: ['es'] },
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})

// Loro's WebAssembly beside the editor's worker, as a file of its own (dist/lib/assets/
// loro_wasm_bg-<hash>.wasm), which the worker names `new URL('./loro_wasm_bg-<hash>.wasm',
// import.meta.url)`: the form a kit's bundler finds, emits as an asset and rewrites, and a server
// sends as application/wasm. Library mode would inline it as a 3.4 MB data: URL (base64, 4.5 MB),
// which every kit then ships inside its worker and the browser can neither cache apart nor compile
// while it downloads. The URL is a placeholder until the chunk is rendered, so Vite's own
// `new URL(..., import.meta.url)` handling (which inlines in library mode) never sees it.
const LORO_WASM_URL = '__kition_loro_wasm_url__'
const LORO_WASM_SOURCE = /\bnew URL\((["'])(?:\.\/)?loro_wasm_bg\.wasm\1,\s*import\.meta\.url\)/g
const loroWasmFile = () => {
  let ref = null
  return {
    name: 'kition-loro-wasm-file',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!/[\\/]loro-crdt[\\/](?:browser|web|bundler)[\\/]loro_wasm(?:_bg)?\.js$/.test(file)) return null
      const found = code.match(LORO_WASM_SOURCE) ?? []
      if (!found.length) return null
      if (found.length !== 1) throw new Error(`${file} names loro_wasm_bg.wasm ${found.length} times; tools/build-sdk.mjs expects one new URL(...)`)
      ref ??= this.emitFile({ type: 'asset', name: 'loro_wasm_bg.wasm', source: fs.readFileSync(path.join(path.dirname(file), 'loro_wasm_bg.wasm')) })
      return { code: code.replace(LORO_WASM_SOURCE, `new URL(${LORO_WASM_URL}, import.meta.url)`), map: null }
    },
    renderChunk(code, chunk) {
      if (!code.includes(LORO_WASM_URL)) return null
      const relative = path.posix.relative(path.posix.dirname(chunk.fileName), this.getFileName(ref))
      return { code: code.replaceAll(LORO_WASM_URL, JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`)), map: null }
    },
  }
}

// Loro in the editor's worker is loro-crdt/web, whose init compiles the wasm with
// WebAssembly.instantiateStreaming while it downloads (and lets the browser cache the compiled
// code), instead of loro-crdt/browser's blocking request and synchronous compile when the worker
// starts. Every import of loro-crdt in the worker is that one module. Its init is asynchronous, so
// a gate, the worker entry's first import, holds the page's requests until Loro is ready and then
// hands them to the worker's own handler in order; when Loro cannot load, the worker fails as a
// worker whose module threw (the page's onerror, which fails the engine's calls). The twelve
// packages' sources are unchanged: @kition/kit-editor's own worker still uses loro-crdt/browser.
const WORKER_ENTRY = path.join(root, 'packages/kit-editor/src/engine/kitEngine.worker.ts')
const LORO_WEB = path.join(fs.realpathSync(path.join(root, 'packages/kdm/node_modules/loro-crdt')), 'web/index.js')
const LORO_GATE = '\0kition-loro-gate'
const LORO_GATE_SOURCE = `import init from ${JSON.stringify(LORO_WEB)}
const held = []
let ready = false
const hold = (event) => {
  if (ready) return
  event.stopImmediatePropagation()
  held.push(event)
}
self.addEventListener('message', hold)
init().then(
  () => {
    ready = true
    self.removeEventListener('message', hold)
    for (const event of held.splice(0)) self.dispatchEvent(new MessageEvent('message', { data: event.data, origin: event.origin, lastEventId: event.lastEventId, ports: [...event.ports] }))
  },
  (error) => {
    setTimeout(() => {
      throw new Error("Loro's WebAssembly did not load: " + (error && error.message ? error.message : String(error)))
    })
  },
)
`
let gatedWorker = false
const loroWeb = () => ({
  name: 'kition-loro-web',
  enforce: 'pre',
  resolveId(source) {
    if (source === LORO_GATE) return LORO_GATE
    if (source === 'loro-crdt') return LORO_WEB
    if (source.startsWith('loro-crdt/')) throw new Error(`the editor's worker imports ${source}; tools/build-sdk.mjs gives it loro-crdt (as loro-crdt/web) only`)
    return null
  },
  load(id) {
    return id === LORO_GATE ? LORO_GATE_SOURCE : null
  },
  transform(code, id) {
    if (id.split('?')[0] !== WORKER_ENTRY) return null
    gatedWorker = true
    return { code: `import ${JSON.stringify(LORO_GATE)}\n${code}`, map: null }
  },
})

// The editor's chunk starts the worker as `new Worker(new URL('../assets/kitEngine.worker-<hash>.js',
// import.meta.url), { type: 'module' })`, the form a kit's bundler recognizes as a worker: it bundles
// the worker for the kit (minified, Loro's wasm emitted as an asset beside it, its URL rewritten).
// Library mode renders it as `new URL(/* @vite-ignore */ "" + new URL(...).href, import.meta.url)`,
// which a bundler copies as an opaque file: the worker's own `new URL('./loro_wasm_bg-<hash>.wasm',
// import.meta.url)` would then name a file the kit's build never emitted.
const IGNORED_WORKER_URL = /new URL\(\s*\/\* @vite-ignore \*\/\s*""\s*\+\s*new URL\((["'])([^"']*\/kitEngine\.worker-[\w-]+\.js)\1,\s*import\.meta\.url\)\.href(?:\s*\+\s*"")?,\s*import\.meta\.url\s*\)/g
const plainWorkerUrl = () => ({
  name: 'kition-plain-worker-url',
  enforce: 'post',
  renderChunk(code) {
    if (!code.includes('kitEngine.worker-')) return null
    const next = code.replace(IGNORED_WORKER_URL, (_, quote, file) => `new URL(${JSON.stringify(file)}, import.meta.url)`)
    return next === code ? null : { code: next, map: null }
  },
})

// 2. The lib group.
// An import of a standalone subpath stays an import, of `kition-sdk-standalone:<file under dist>`,
// rendered per chunk as the relative path from that chunk to the file (renderChunk below).
const STANDALONE = 'kition-sdk-standalone:'
const standaloneTarget = new Map(list.filter(({ group, sdkOnly }) => group === 'standalone' && !sdkOnly).map(({ from, js }) => [from, `${STANDALONE}${js.slice('./dist/'.length)}`]))
const standaloneNames = new Set(PARTS.filter((part) => part.group === 'standalone').map((part) => part.name))
const embedServer = path.join(root, 'packages/embed-server/src/server.ts')
const sdkImports = () => ({
  name: 'kition-sdk-imports',
  enforce: 'pre',
  resolveId(source) {
    const tessera = tesseraImport(source)
    if (tessera) return { id: tessera, external: true }
    if (standaloneTarget.has(source)) return { id: standaloneTarget.get(source), external: true }
    const name = source.startsWith('@kition/') ? source.split('/').slice(0, 2).join('/') : null
    if (name && standaloneNames.has(name)) throw new Error(`${source} is no subpath of ${name}'s exports`)
    return null
  },
  transform(code, id) {
    if (id !== embedServer) return null
    // The embed server serves @kition/embed's dist; in @kition/sdk that is the embed subpath's folder.
    const from = "import.meta.resolve('@kition/embed')"
    if (!code.includes(from)) throw new Error(`${path.relative(root, id)} no longer finds the embed module as ${from}: update tools/build-sdk.mjs`)
    return code.replaceAll(from, `import.meta.resolve('${SDK}/embed')`)
  },
  renderChunk(code, chunk) {
    if (!code.includes(STANDALONE)) return null
    const from = path.posix.dirname(`lib/${chunk.fileName}`)
    const next = code.replace(new RegExp(`(["'])${STANDALONE}([^"']+)\\1`, 'g'), (_, quote, file) => {
      const relative = path.posix.relative(from, file)
      return `${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`
    })
    if (next.includes(STANDALONE)) throw new Error(`${chunk.fileName}: an import of a standalone subpath was not rendered`)
    return { code: next, map: null }
  },
})
const libEntries = entries('lib', 'lib')
for (const [, { dir, source }] of Object.entries(BINS)) {
  const part = PARTS.find((candidate) => candidate.dir === dir)
  libEntries[`${jsBase(part).slice('lib/'.length)}/${path.basename(source, '.ts')}`] = sourceOf(part, source)
}
const binChunks = new Set(Object.values(BINS).map(({ dir, source }) => `${dir}/${path.basename(source, '.ts')}`))
await build({
  root: sdkDir,
  base: './',
  configFile: false,
  logLevel: 'warn',
  plugins: [sdkImports(), recordBundled(), newNames(), plainWorkerUrl()],
  worker: { format: 'es', plugins: () => [loroWeb(), loroWasmFile(), recordBundled(), newNames()], rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    outDir: path.join(dist, 'lib'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: { entry: libEntries, formats: ['es'] },
    rollupOptions: {
      external: (id) => /^node:/.test(id) || isBuiltin(id) || /^loro-crdt(?:\/|$)/.test(id) || /^react(?:-dom)?(?:\/|$)/.test(id),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        banner: (chunk) => (chunk.isEntry && binChunks.has(chunk.name) ? '#!/usr/bin/env node' : ''),
      },
    },
  },
})

if (!gatedWorker) throw new Error(`the editor's worker is no longer built from ${path.relative(root, WORKER_ENTRY)}: update WORKER_ENTRY in tools/build-sdk.mjs`)

// 3. Styles, pages and .mjs helpers, as the packages copy them; Tessera named by tesseraSpecifier.
const tesseraInCss = (text) => text.replace(/(@import\s+['"])([^'"]+)(['"])/g, (whole, lead, specifier, close) => {
  const next = tesseraImport(specifier)
  return next ? `${lead}${next}${close}` : whole
})
for (const { part, source, js } of list) {
  if (isCode(source)) continue
  const output = path.join(sdkDir, js)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const text = fs.readFileSync(sourceOf(part, source))
  fs.writeFileSync(output, source.endsWith('.css') ? renameOldNames(tesseraInCss(text.toString('utf8'))) : /\.(?:mjs|html)$/.test(source) ? renameOldNames(text.toString('utf8')) : text)
}

// 4. A browser's answer for a Node-only subpath.
for (const { part, key, types: declared } of list) {
  if (!part.node || !declared) continue
  const output = path.join(sdkDir, nodeOnlyStub(key))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `// ${SDK}${key.slice(1)} is for Node only; this is what other conditions (a browser bundle) get.\nthrow new Error(${JSON.stringify(`${SDK}${key.slice(1)} runs in Node only: import it on your server; a page imports ${SDK}/embed`)})\n`)
}

// 5. Declarations: one program over the twelve packages' sources.
const paths = {}
for (const { part, from, source } of list) if (/\.(?:tsx?|mjs)$/.test(source)) paths[from] = [sourceOf(part, source)]
const config = ts.parseJsonConfigFileContent(
  {
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, allowJs: true, checkJs: false, outDir: types, rootDir: path.join(root, 'packages'), paths, types: ['node', 'vite/client'] },
    include: PARTS.flatMap((part) => [`packages/${part.dir}/src`, ...(fs.existsSync(path.join(root, 'packages', part.dir, 'kits')) ? [`packages/${part.dir}/kits`] : [])]),
    exclude: ['**/*.test.*', '**/test/**', '**/fixtures/**'],
  },
  ts.sys,
  root,
)
const program = ts.createProgram(config.fileNames, config.options)
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  process.exit(1)
}
const emitted = program.emit()
if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('declaration emission failed')

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const declarations = walk(types).filter((file) => /\.d\.m?ts$/.test(file))
const relativeTo = (file, target) => {
  const relative = path.relative(path.dirname(file), target).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}
/** A declaration file as the module a relative import names: its .js (or .mjs). */
const asModule = (file) => file.replace(/\.d\.ts$/, '.js').replace(/\.d\.mts$/, '.mjs')
const declarationTarget = new Map(list.filter(({ types: declared }) => declared).map(({ from, types: declared }) => [from, path.join(sdkDir, declared)]))
const LORO_ALIASES = { PeerID: '`${number}`', TreeID: '`${number}@${number}`', ContainerID: 'string' }
const loroImport = /import (type )?\{([^}]*)\} from ['"]loro-crdt['"];?/g
const loroNames = new Set()
const specifier = /((?:from |import\(|import |export \* from )['"])([^'"]+)(['"])/g
for (const file of declarations) {
  const text = fs.readFileSync(file, 'utf8')
  let next = text.replace(loroImport, (_, lead, names) => {
    for (const name of names.split(',')) if (name.trim()) loroNames.add(name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
    return `import type {${names.replace(/\btype\s+/g, '')}} from '${relativeTo(file, path.join(types, 'loro-crdt.js'))}';`
  })
  next = next.replace(specifier, (whole, lead, named, close) => {
    if (named.startsWith('.')) {
      if (/\.m?js$/.test(named)) return whole
      const target = path.resolve(path.dirname(file), named.replace(/\.tsx?$/, ''))
      for (const [suffix, module] of [['.d.ts', '.js'], ['.d.mts', '.mjs'], ['/index.d.ts', '/index.js']]) {
        if (fs.existsSync(`${target}${suffix}`)) return `${lead}${relativeTo(file, target)}${module}${close}`
      }
      throw new Error(`${path.relative(sdkDir, file)} imports ${named}, which was not emitted`)
    }
    if (declarationTarget.has(named)) return `${lead}${asModule(relativeTo(file, declarationTarget.get(named)))}${close}`
    const tessera = tesseraImport(named)
    if (tessera) return `${lead}${tessera}${close}`
    if (named.startsWith('@kition/') && !named.startsWith('@kition/tessera')) throw new Error(`${path.relative(sdkDir, file)} names ${named}, which is not a subpath of ${SDK}`)
    return whole
  })
  next = renameOldNames(next)
  if (/['"]loro-crdt['"]/.test(next)) throw new Error(`${path.relative(sdkDir, file)} names loro-crdt in a way tools/build-sdk.mjs does not rewrite`)
  if (/\/\/\/\s*<reference types="vite/.test(next)) throw new Error(`${path.relative(sdkDir, file)} references Vite's types, which a consumer does not have`)
  if (next !== text) fs.writeFileSync(file, next)
}
if (loroNames.size) {
  const declared = [...loroNames].sort().map((name) => (LORO_ALIASES[name] ? `export type ${name} = ${LORO_ALIASES[name]}\n` : `export declare class ${name} {}\n`))
  fs.writeFileSync(path.join(types, 'loro-crdt.d.ts'), `/** The Loro (loro-crdt) types these declarations name, without Loro's own declarations. */\n${declared.join('')}`)
}
for (const { key, types: declared } of list) if (declared && !fs.existsSync(path.join(sdkDir, declared))) throw new Error(`${SDK}${key.slice(1)}: ${declared} was not emitted`)

// 6. The license, at the package's top (where npm and a reader look for it; not in git), and the
// notices of the third-party code the bundles contain.
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(sdkDir, 'LICENSE'))
const notices = new Map()
for (const dir of bundled) {
  const section = packageNoticeSection(dir)
  notices.set(section.key, section.text)
}
if (notices.size) {
  const sections = [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => `${'-'.repeat(72)}\n${text}\n`)
  fs.writeFileSync(path.join(dist, 'THIRD_PARTY_NOTICES'), `Third-party notices for ${SDK}\n\nThe files in dist/ include code from the packages below, each under its own license.\n\n${sections.join('\n')}`)
}
for (const { key, js } of list) if (!fs.existsSync(path.join(sdkDir, js))) throw new Error(`${SDK}${key.slice(1)}: ${js} was not built`)
// No old package name is left in what @kition/sdk ships, but the client names.
const left = walk(dist).filter((file) => /\.(?:[cm]?js|d\.m?ts|css|html)$/.test(file)).flatMap((file) => oldNamesIn(fs.readFileSync(file, 'utf8')).map(({ name, line }) => `${path.relative(sdkDir, file)}:${line}: ${name}`))
if (left.length) throw new Error(`old package names left in ${SDK}'s dist (rename them in tools/build-sdk.mjs, or add a client name to CLIENT_NAMES in tools/sdk-package.mjs):\n${left.join('\n')}`)
// The editor's worker names Loro's WebAssembly beside it and inlines none (loroWasmFile above).
const shipped = walk(dist).map((file) => path.relative(sdkDir, file).split(path.sep).join('/'))
const workerProblems = editorWorkerProblems(shipped, (file) => fs.readFileSync(path.join(sdkDir, file), 'utf8'))
if (workerProblems.length) throw new Error(`${SDK}'s editor worker:\n${workerProblems.join('\n')}`)
console.log(`${SDK}: built ${list.length} subpaths in packages/sdk/dist (${declarations.length} declarations)`)
