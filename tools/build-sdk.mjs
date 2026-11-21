#!/usr/bin/env node
// Builds @kition/sdk (packages/sdk/dist) from the twelve library packages' sources, by the mapping
// in tools/sdk-package.mjs; packages/sdk's `build` script. It reads no package's own dist/.
//
//   node tools/build-sdk.mjs
//
// dist/standalone/  @kition/sdk/embed (its index.js is the top, which the embed server serves as
//                   /assets/embed/) and @kition/sdk/script/*: one Vite build with Loro's
//                   WebAssembly inlined (loro-crdt/base64), so a page needs no bundler setup; the
//                   two share their chunks, so Loro is there once.
// dist/lib/<dir>/   every other package: one Vite build, its packages' cross-imports shared chunks
//                   (dist/lib/chunks), loro-crdt, React and Tessera left imports (a dependency and
//                   optional peers); an import of @kition/embed or @kition/script points at
//                   dist/standalone. The editor's worker (dist/lib/assets) is a bundle of its own,
//                   with its own Loro, as a worker must be.
// dist/types/<dir>/ the declarations of all twelve, from one TypeScript program: each package's
//                   name is a relative import, Loro's types opaque (dist/types/loro-crdt.d.ts),
//                   and every relative import has its .js, for `bundler` and `node16` alike.
// dist/lib/node-only/  what a browser gets for a Node-only subpath (@kition/sdk/embed/server): an
//                   error naming why.
// Styles, HTML pages and .mjs helpers are copied; Tessera is named by tesseraSpecifier everywhere.
import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'vite'
import { packageNoticeSection } from './bundled-notices.mjs'
import { BINS, jsBase, nodeOnlyStub, PARTS, SDK, subpaths, tesseraImport } from './sdk-package.mjs'

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
  for (const { part, source, js } of list) {
    if (part.group !== group || !isCode(source)) continue
    found[js.slice(`./dist/${base}/`.length).replace(/\.js$/, '')] = sourceOf(part, source)
  }
  return found
}

// 1. The standalone group: Loro inlined, one copy for embed and script.
await build({
  root: sdkDir,
  base: './',
  configFile: false,
  logLevel: 'warn',
  plugins: [recordBundled()],
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

// 2. The lib group.
// An import of a standalone subpath stays an import, of `kition-sdk-standalone:<file under dist>`,
// rendered per chunk as the relative path from that chunk to the file (renderChunk below).
const STANDALONE = 'kition-sdk-standalone:'
const standaloneTarget = new Map(list.filter(({ part }) => part.group === 'standalone').map(({ from, js }) => [from, `${STANDALONE}${js.slice('./dist/'.length)}`]))
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
  plugins: [sdkImports(), recordBundled()],
  worker: { format: 'es', plugins: () => [recordBundled()], rollupOptions: { output: { inlineDynamicImports: true } } },
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
  fs.writeFileSync(output, source.endsWith('.css') ? tesseraInCss(text.toString('utf8')) : text)
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
  if (/['"]loro-crdt['"]/.test(next)) throw new Error(`${path.relative(sdkDir, file)} names loro-crdt in a way tools/build-sdk.mjs does not rewrite`)
  if (/\/\/\/\s*<reference types="vite/.test(next)) throw new Error(`${path.relative(sdkDir, file)} references Vite's types, which a consumer does not have`)
  if (next !== text) fs.writeFileSync(file, next)
}
if (loroNames.size) {
  const declared = [...loroNames].sort().map((name) => (LORO_ALIASES[name] ? `export type ${name} = ${LORO_ALIASES[name]}\n` : `export declare class ${name} {}\n`))
  fs.writeFileSync(path.join(types, 'loro-crdt.d.ts'), `/** The Loro (loro-crdt) types these declarations name, without Loro's own declarations. */\n${declared.join('')}`)
}
for (const { key, types: declared } of list) if (declared && !fs.existsSync(path.join(sdkDir, declared))) throw new Error(`${SDK}${key.slice(1)}: ${declared} was not emitted`)

// 6. The license, and the notices of the third-party code the bundles contain.
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'))
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
console.log(`${SDK}: built ${list.length} subpaths in packages/sdk/dist (${declarations.length} declarations)`)
