#!/usr/bin/env node
// @kition/sdk: the SDK's twelve TypeScript library packages as one npm package with subpath
// exports (packages/sdk). This module is the one mapping from the twelve names to the subpaths;
// tools/build-sdk.mjs builds the package by it, tools/migrate-to-sdk.mjs rewrites a consumer by
// it, and tools/sdk-package.test.mjs checks packages/sdk/package.json against it.
//
//   node tools/sdk-package.mjs            print the mapping (old specifier -> new specifier)
//   node tools/sdk-package.mjs --write    write packages/sdk/package.json's exports, bin and sideEffects
//   node tools/sdk-package.mjs --check    exit 1 when packages/sdk/package.json differs from them
//
// The twelve packages stay in the workspace with their own names until every consumer imports
// @kition/sdk; each subpath mirrors one of their exports (their publishConfig.exports), so a
// consumer changes only the specifier.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The merged package's name. */
export const SDK = '@kition/sdk'

/**
 * Each library package: its npm name, its folder under packages/, the subpath it becomes, and its
 * build group. `standalone` packages inline Loro's WebAssembly (base64), so a page needs no bundler
 * setup (as @kition/embed and @kition/script do today); they are built together, so they share one
 * copy of Loro. `lib` packages leave loro-crdt an import, so a kit engine that imports loro-crdt
 * itself and @kition/sdk/kdm shares one Loro. `node` marks a package for Node only.
 */
export const PARTS = [
  // @kition/embed's workspace exports name its dist (its declarations are built by its own script):
  // its source is its Vite entry.
  { name: '@kition/embed', dir: 'embed', subpath: 'embed', group: 'standalone', sources: { '.': './src/index.ts' } },
  { name: '@kition/embed-server', dir: 'embed-server', subpath: 'embed/server', group: 'lib', node: true },
  { name: '@kition/sync', dir: 'sync', subpath: 'sync', group: 'lib' },
  { name: '@kition/script', dir: 'script', subpath: 'script', group: 'standalone' },
  { name: '@kition/extensions', dir: 'extensions', subpath: 'extensions', group: 'lib' },
  { name: '@kition/kdm', dir: 'kdm', subpath: 'kdm', group: 'lib' },
  { name: '@kition/kit-editor', dir: 'kit-editor', subpath: 'editor', group: 'lib' },
  { name: '@kition/kit-engine', dir: 'kit-engine', subpath: 'engine', group: 'lib' },
  { name: '@kition/kit-host', dir: 'kit-host', subpath: 'host', group: 'lib' },
  { name: '@kition/kit-dev-host', dir: 'kit-dev-host', subpath: 'dev-host', group: 'lib' },
  { name: '@kition/kit-ui-protocol', dir: 'kit-ui-protocol', subpath: 'protocol', group: 'lib' },
  { name: '@kition/convergence', dir: 'convergence', subpath: 'convergence', group: 'lib' },
]

/** Executables a package carries (its package.json `bin`), with the source each is built from. */
export const BINS = { 'kition-embed-server': { dir: 'embed-server', source: 'src/cli.ts' } }

/** The Tessera package @kition/sdk/editor imports, an optional peer of @kition/sdk. */
export const TESSERA = '@kition/tessera'

/**
 * Tessera's import specifiers in @kition/sdk/editor (JavaScript, declarations and styles.css):
 * `part` is ui, icons or tokens, `rest` the subpath after it ('' or '/react', '/styles.css', ...).
 * Tessera is one package, @kition/tessera, whose subpaths /ui, /icons and /tokens mirror the three
 * packages it replaced (kition-tessera's scripts/migrate-to-tessera.mjs moves a consumer). The
 * twelve packages here (@kition/kit-editor) still name those three; only @kition/sdk's build
 * renames them, and peerDependencies in packages/sdk/package.json name @kition/tessera
 * (tools/sdk-package.test.mjs fails until they agree with this function).
 */
export const tesseraSpecifier = (part, rest) => `${TESSERA}/${part}${rest}`

/** Tessera's old packages, as the twelve packages name them: `@kition/tessera-<part><rest>`. */
const OLD_TESSERA_SPECIFIER = /^@kition\/tessera-(ui|icons|tokens)((?:\/.*)?)$/

/** The three packages @kition/tessera replaced (a consumer that still names them moves with migrate-to-tessera). */
export const OLD_TESSERA = ['@kition/tessera-icons', '@kition/tessera-tokens', '@kition/tessera-ui']

/** An old Tessera `specifier` as tesseraSpecifier names it, or null when it is not one. */
export function tesseraImport(specifier) {
  const match = OLD_TESSERA_SPECIFIER.exec(specifier)
  return match ? tesseraSpecifier(match[1], match[2]) : null
}

/** The package a bare specifier names: `@scope/name` or `name`. */
export const packageOf = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')

/** The part an old package name is, or undefined. */
export const partOf = (name) => PARTS.find((part) => part.name === name)

/**
 * `specifier` as @kition/sdk names it (`@kition/kit-editor/styles.css` -> `@kition/sdk/editor/styles.css`),
 * or null when it names none of the twelve packages.
 */
export function sdkSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('@kition/')) return null
  const part = partOf(packageOf(specifier))
  if (!part) return null
  return `${SDK}/${part.subpath}${specifier.slice(part.name.length)}`
}

/**
 * Old names @kition/sdk keeps on purpose: the client name a library sends a server as
 * `{ name: '<old>', version }`, in the sync protocol's hello (@kition/sync's SyncClient, and the
 * clients @kition/embed and @kition/script make of it) and in the Kit Process Protocol's
 * kits.initialize (@kition/script's headless kits). A server may log, count or match it, so
 * renaming one changes what servers see: decided at cutover, not by the build. tools/build-sdk.mjs
 * leaves these, and the pack check allows exactly these in @kition/sdk.
 */
export const CLIENT_NAMES = ['@kition/embed', '@kition/script', '@kition/sync']

/** The fifteen old package names (the twelve and Tessera's three), longest first. */
const OLD_NAMES = [...PARTS.map((part) => part.name), ...OLD_TESSERA].sort((a, b) => b.length - a.length)

/** An old package name anywhere in text (a comment, a message, a usage line); a subpath after it stays. */
const OLD_NAME = new RegExp(`@kition/(?:${OLD_NAMES.map((name) => name.slice('@kition/'.length)).join('|')})(?![\\w-])`, 'g')

/** Whether the old name at `offset` of `text` is a client name: `{ name: '<name>', version: ...`. */
function isClientName(text, offset, name) {
  if (!CLIENT_NAMES.includes(name)) return false
  const before = /\{\s*name:\s*(['"])$/.exec(text.slice(Math.max(0, offset - 40), offset))
  return Boolean(before) && new RegExp(`^${before[1]}\\s*,\\s*version:`).test(text.slice(offset + name.length, offset + name.length + 40))
}

/**
 * `text` with every old package name as @kition/sdk names it (`@kition/kit-dev-host/mode-smoke` ->
 * `@kition/sdk/dev-host/mode-smoke`, `@kition/tessera-ui` -> `@kition/tessera/ui`), the client
 * names aside: what @kition/sdk's build does to the comments, messages and declarations it emits,
 * by the same mapping as its specifiers (sdkSpecifier, tesseraImport).
 */
export function renameOldNames(text) {
  return text.replace(OLD_NAME, (name, offset) => (isClientName(text, offset, name) ? name : (sdkSpecifier(name) ?? tesseraImport(name))))
}

/** The old package names left in `text`, client names aside: [{ name, line }]. */
export function oldNamesIn(text) {
  const found = []
  for (const match of text.matchAll(OLD_NAME)) {
    if (!isClientName(text, match.index, match[0])) found.push({ name: match[0], line: text.slice(0, match.index).split('\n').length })
  }
  return found
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
export const manifestOf = (part) => readJson(path.join(root, 'packages', part.dir, 'package.json'))

/** Where a part's built JavaScript goes, relative to packages/sdk/dist. */
export function jsBase(part) {
  if (part.group !== 'standalone') return `lib/${part.dir}`
  // The embed module is the top of standalone/, which the embed server serves as /assets/embed/.
  return part.dir === 'embed' ? 'standalone' : `standalone/${part.dir}`
}

/** A source file (relative to its package) -> its declaration file under dist/types/<dir>/. */
export function declarationOf(part, source) {
  const file = source.replace(/^\.\//, '')
  const declaration = file.replace(/\.tsx?$/, '.d.ts').replace(/\.mts$/, '.d.mts').replace(/\.mjs$/, '.d.mts').replace(/\.js$/, '.d.ts')
  return `./dist/types/${part.dir}/${declaration}`
}

/**
 * Every subpath of @kition/sdk: [{ part, from, key, source, js, types }] where `from` is the old
 * specifier, `key` the export key (`./editor/styles.css`), `source` the file in the old package's
 * workspace exports, `js` the built file (relative to packages/sdk) and `types` its declarations
 * (null for CSS and HTML).
 */
export function subpaths() {
  const list = []
  for (const part of PARTS) {
    const manifest = manifestOf(part)
    const published = manifest.publishConfig?.exports ?? manifest.exports
    for (const [key, exported] of Object.entries(manifest.exports)) {
      const source = part.sources?.[key] ?? exported
      if (typeof source !== 'string' || !source.startsWith('./') || source.startsWith('./dist/')) throw new Error(`${part.name}: export ${key} names no source file in the workspace (give it in PARTS sources)`)
      const target = published[key]
      const file = typeof target === 'string' ? target : target.import
      if (!file.startsWith('./dist/')) throw new Error(`${part.name}: export ${key} is published as ${file}, not under ./dist/`)
      const sub = key === '.' ? '' : key.slice(1)
      const js = `./dist/${jsBase(part)}/${file.slice('./dist/'.length)}`
      const code = /\.(?:[cm]?[jt]sx?)$/.test(source)
      list.push({ part, from: `${part.name}${sub}`, key: `./${part.subpath}${sub}`, source, js, types: code ? declarationOf(part, source) : null })
    }
  }
  return list
}

/** A browser stub for a Node-only subpath: importing it outside Node fails, naming why. */
export const nodeOnlyStub = (key) => `./dist/lib/node-only/${key.slice(2).replaceAll('/', '-')}.js`

/** packages/sdk/package.json's `exports`, in the mapping's order. No `.`: import a subpath. */
export function sdkExports() {
  const exports = {}
  for (const { part, key, js, types } of subpaths()) {
    if (!types) exports[key] = js
    else if (part.node) exports[key] = { types, node: js, default: nodeOnlyStub(key) }
    else exports[key] = { types, import: js }
  }
  return exports
}

/** packages/sdk/package.json's `bin`. */
export function sdkBin() {
  return Object.fromEntries(Object.entries(BINS).map(([name, { dir, source }]) => [name, `./dist/${jsBase(PARTS.find((part) => part.dir === dir))}/${path.basename(source).replace(/\.ts$/, '.js')}`]))
}

/**
 * The files with side effects on import, so a bundler keeps them when nothing they export is used:
 * the editor's styles, the kit registrations of @kition/sdk/script/kits (each kit module registers
 * its schema when it loads; tools/sdk-package.test.mjs checks no chunk does), and the embed
 * server's command.
 * Everything else is free of side effects, so a bundler drops what a page does not use.
 */
export function sdkSideEffects() {
  return ['*.css', './dist/standalone/script/kits/*.js', ...Object.values(sdkBin())]
}

/** The editor's worker in @kition/sdk (a path under the package), a bundle of its own with its own Loro. */
export const EDITOR_WORKER = /^dist\/lib\/assets\/kitEngine\.worker-[\w-]+\.js$/
/** Loro's WebAssembly beside it, a file of its own (tools/build-sdk.mjs emits it there). */
export const LORO_WASM = /^dist\/lib\/assets\/loro_wasm_bg-[\w-]+\.wasm$/
/** A data: URL of 64 kB or more: an inlined WebAssembly module, font or image. */
const LARGE_DATA_URL = /data:[\w./+-]*;base64,[A-Za-z0-9+/]{65536}/

/**
 * What is wrong with the editor's worker and Loro's WebAssembly among @kition/sdk's `files` (paths
 * under the package; `read(file)` gives a file's text): there is one worker and one Loro wasm in
 * dist/lib/assets, the worker names the wasm `new URL('./<wasm file>', import.meta.url)` (the form
 * a kit's bundler finds and emits as an asset), nothing is inlined in the worker as a large
 * data: URL (as Vite's library mode inlines the wasm, 4.5 MB of base64), and the worker compiles
 * Loro as loro-crdt/web does (WebAssembly.instantiateStreaming), not with loro-crdt/browser's
 * blocking request. [] when all is right.
 * tools/build-sdk.mjs, the pack check and tools/smoke-sdk-package.mjs ask it.
 */
export function editorWorkerProblems(files, read) {
  const workers = files.filter((file) => EDITOR_WORKER.test(file))
  const wasms = files.filter((file) => LORO_WASM.test(file))
  if (workers.length !== 1) return [`${SDK} has ${workers.length} editor workers (dist/lib/assets/kitEngine.worker-*.js), not one`]
  if (wasms.length !== 1) return [`${SDK} has ${wasms.length} Loro wasm files beside the editor's worker (dist/lib/assets/loro_wasm_bg-*.wasm), not one: the worker inlines Loro again`]
  const problems = []
  const worker = read(workers[0])
  const name = path.posix.basename(wasms[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`new URL\\((["'\`])\\./${name}\\1,\\s*import\\.meta\\.url\\)`).test(worker)) problems.push(`${workers[0]} does not name ${wasms[0]} as new URL('./${path.posix.basename(wasms[0])}', import.meta.url)`)
  if (/data:application\/wasm/.test(worker) || LARGE_DATA_URL.test(worker)) problems.push(`${workers[0]} inlines a large data: URL (Loro's WebAssembly as base64): it must name the .wasm file beside it`)
  // Every chunk that starts it names it as a bundler recognizes a worker (and bundles it, emitting the wasm).
  const workerName = path.posix.basename(workers[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const starters = files.filter((file) => /^dist\/lib\/.*\.js$/.test(file) && file !== workers[0]).map((file) => ({ file, text: read(file) })).filter(({ text }) => text.includes(path.posix.basename(workers[0])))
  if (!starters.length) problems.push(`no chunk of ${SDK} starts ${workers[0]}`)
  for (const { file, text } of starters) {
    const named = text.split(path.posix.basename(workers[0])).length - 1
    const plain = text.match(new RegExp(`new Worker\\(new URL\\((["'\`])\\.{1,2}/(?:[\\w-]+/)*${workerName}\\1,\\s*import\\.meta\\.url\\)`, 'g'))?.length ?? 0
    if (plain !== named) problems.push(`${file} names ${workers[0]} ${named} times, ${plain} of them as new Worker(new URL('<relative path>', import.meta.url)): a bundler copies the others as opaque files, without the wasm`)
  }
  if (worker.includes('loro-crdt browser build requires XMLHttpRequest') || !worker.includes('WebAssembly.instantiateStreaming')) problems.push(`${workers[0]} loads Loro as loro-crdt/browser does (a blocking request, compiled synchronously), not as loro-crdt/web (WebAssembly.instantiateStreaming)`)
  return problems
}

function main(argv) {
  const file = path.join(root, 'packages/sdk/package.json')
  if (argv.includes('--write') || argv.includes('--check')) {
    const manifest = readJson(file)
    const next = { ...manifest, bin: sdkBin(), exports: sdkExports(), sideEffects: sdkSideEffects() }
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (argv.includes('--check')) {
      if (fs.readFileSync(file, 'utf8') !== text) {
        console.error('packages/sdk/package.json: exports, bin or sideEffects differ from tools/sdk-package.mjs; run node tools/sdk-package.mjs --write')
        process.exit(1)
      }
      console.log('packages/sdk/package.json is up to date')
      return
    }
    fs.writeFileSync(file, text)
    console.log('wrote packages/sdk/package.json')
    return
  }
  for (const { from, key } of subpaths()) console.log(`${from} -> ${SDK}${key.slice(1)}`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
