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

/**
 * Tessera's import specifiers in @kition/sdk/editor (JavaScript, declarations and styles.css):
 * `part` is ui, icons or tokens, `rest` the subpath after it ('' or '/react', '/styles.css', ...).
 * Today Tessera is three npm packages, @kition/tessera-ui, -icons and -tokens. When the one package
 * @kition/tessera (subpaths /ui, /icons, /tokens) is on npm, the switch is this one line:
 *
 *   export const tesseraSpecifier = (part, rest) => `@kition/tessera/${part}${rest}`
 *
 * then peerDependencies in packages/sdk/package.json name @kition/tessera instead of the three
 * (tools/sdk-package.test.mjs fails until they agree with this function).
 */
export const tesseraSpecifier = (part, rest) => `@kition/tessera-${part}${rest}`

/** Tessera's packages as the editor names them today: `@kition/tessera-<part><rest>`. */
const TESSERA = /^@kition\/tessera-(ui|icons|tokens)((?:\/.*)?)$/

/** `specifier` with Tessera named by tesseraSpecifier, or null when it is not Tessera's. */
export function tesseraImport(specifier) {
  const match = TESSERA.exec(specifier)
  return match ? tesseraSpecifier(match[1], match[2]) : null
}

/** The npm packages tesseraSpecifier names (for peerDependencies). */
export const tesseraPackages = () => [...new Set(['ui', 'icons', 'tokens'].map((part) => packageOf(tesseraSpecifier(part, ''))))].sort()

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
