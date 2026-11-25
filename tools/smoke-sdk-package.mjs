#!/usr/bin/env node
// @kition/sdk as a consumer installs it: its packed archive (node tools/pack-public-packages.mjs sdk
// writes target/npm-pack/sdk.tgz) unpacked into a project in the system's temporary folder, outside
// the workspace, so nothing resolves through the workspace's node_modules. Offline: its dependency
// peers are linked from the workspace (React, its types), and its Tessera peer
// @kition/tessera from the folder --tessera names (default: the built package in the
// kition-tessera checkout beside this one, ../kition-tessera/packages/tessera, after its
// `pnpm build:packages`; or a folder npm installed it in, as release.yml passes the
// rehearsal Tessera), as npm serves it (its publishConfig exports, when it has them). It checks:
//
//   1. Node: every subpath Node runs imports (all but the editor's, which needs a page); the
//      embed server's command carries its #!; `@kition/sdk` alone is refused (no root module);
//      every Tessera specifier in the package (code, declarations, styles) is one @kition/tessera
//      exports; every package its code and declarations import is a dependency, a peer, an
//      optional dependency or a Node builtin (a package only a dependency of a peer brings, such
//      as use-sync-external-store, which Tessera's radix-ui imports, is not @kition/sdk's to name).
//   2. Types: a project importing every subpath compiles under `moduleResolution: bundler` and
//      under `node16`, with skipLibCheck off for @kition/sdk's own declarations; `@kition/sdk`
//      alone has no types.
//   3. A browser bundle (Vite) of a page importing only @kition/sdk/embed holds nothing of the
//      editor (no React, Tessera or editor worker); one importing @kition/sdk/embed/server gets
//      only the Node-only error. A page importing @kition/sdk/editor, bundled as a kit bundles it,
//      emits the editor's worker as an asset of its own with nothing inlined
//      (tools/smoke-sdk-worker.mjs runs it in Chromium).
//      A page importing @kition/sdk/kdm, /sync, /script and /extensions together holds exactly one
//      KDM; a page of @kition/sdk/script/standalone alone holds its own one; /kdm exports Replica
//      and /extensions/runtime WORKER_RUNTIME.
//   4. Sizes: the archive, the unpacked files and the largest ones, beside the ten packages'
//      archives in target/npm-pack when they are there; the /script library entry beside
//      /script/standalone (each with the package files it imports). LICENSE is at the package's
//      top, the repository's.
//
//   node tools/smoke-sdk-package.mjs [--archive <sdk.tgz>] [--tessera <@kition/tessera folder>] [--keep]
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { build } from 'vite'
import { importedPackages, packageFolderImports } from './check-public-package-imports.mjs'
import { consumerInputs, installSdk, kitViteConfig } from './sdk-consumer.mjs'
import { EDITOR_WORKER, editorWorkerProblems, PARTS, SDK, subpaths, TESSERA } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const { archive, tessera } = consumerInputs('smoke-sdk-package', args)

/** A schema error of the KDM (packages/kdm/src/schema.ts): once in each copy of the KDM's code. */
const KDM_MARKER = 'a prefix has at most 32 characters'

/** The package files `entry` (a path under `dir`) imports, itself and transitively, by relative specifiers. */
function moduleClosure(dir, entry) {
  const seen = new Set()
  const visit = (file) => {
    const normal = path.posix.normalize(file.replace(/^\.\//, ''))
    if (seen.has(normal)) return
    seen.add(normal)
    const text = fs.readFileSync(path.join(dir, normal), 'utf8')
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) visit(path.posix.join(path.posix.dirname(normal), match[1]))
  }
  visit(entry)
  return [...seen]
}

const consumer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kition-sdk-consumer-')))
const results = []
const pass = (line) => {
  results.push(line)
  console.log(`PASS ${line}`)
}

try {
  const { installed, manifest, ownTessera } = installSdk({ consumer, archive, tessera })

  const all = subpaths()
  const code = all.filter(({ types }) => types)
  const specifierOf = ({ key }) => `${SDK}${key.slice(1)}`
  // The editor needs a page (React, Tessera's styles): not imported in Node.
  const browserOnly = new Set(all.filter(({ part }) => part.dir === 'kit-editor').map(specifierOf))

  // 1. Node.
  const nodeCheck = path.join(consumer, 'node-check.mjs')
  fs.writeFileSync(nodeCheck, `
const results = {}
for (const specifier of JSON.parse(process.argv[2])) {
  try {
    const loaded = await import(specifier)
    results[specifier] = { ok: true, exports: Object.keys(loaded).length }
  } catch (error) {
    results[specifier] = { ok: false, error: String(error?.code ?? '') + ' ' + String(error?.message ?? error).split('\\n')[0] }
  }
}
console.log(JSON.stringify(results))
`)
  const nodeSafe = code.map(specifierOf).filter((specifier) => !browserOnly.has(specifier))
  const ran = spawnSync(process.execPath, [nodeCheck, JSON.stringify([...nodeSafe, SDK])], { cwd: consumer, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(ran.status, 0, ran.stderr)
  const imported = JSON.parse(ran.stdout.trim().split('\n').pop())
  const failed = nodeSafe.filter((specifier) => !imported[specifier].ok).map((specifier) => `${specifier}: ${imported[specifier].error}`)
  assert.deepEqual(failed, [], 'every Node-safe subpath imports in Node')
  assert.ok(nodeSafe.every((specifier) => imported[specifier].exports > 0), 'every subpath exports something')
  assert.ok(!imported[SDK].ok && /ERR_PACKAGE_PATH_NOT_EXPORTED/.test(imported[SDK].error), `${SDK} alone is refused: ${imported[SDK].error}`)
  // Every Tessera specifier the package names (the editor's code, declarations and styles) is one
  // that @kition/tessera exports, resolved as Node resolves it (CSS by the default condition).
  const tesseraSpecifiers = new Set()
  for (const file of fs.readdirSync(path.join(installed, 'dist'), { recursive: true }).filter((file) => /\.(?:js|d\.ts|css)$/.test(file))) {
    for (const match of fs.readFileSync(path.join(installed, 'dist', file), 'utf8').matchAll(/(?:from\s*|import\s*\(?\s*|@import\s+)['"](@kition\/tessera[^'"]*)['"]/g)) tesseraSpecifiers.add(match[1])
  }
  assert.ok(tesseraSpecifiers.size > 0, `${SDK}/editor names ${TESSERA}`)
  assert.deepEqual([...tesseraSpecifiers].filter((specifier) => !specifier.startsWith(`${TESSERA}/`)), [], `every Tessera specifier is a subpath of ${TESSERA}`)
  const resolveCheck = path.join(consumer, 'resolve-check.mjs')
  fs.writeFileSync(resolveCheck, `
const missing = []
for (const specifier of JSON.parse(process.argv[2])) {
  try { import.meta.resolve(specifier) } catch (error) { missing.push(specifier + ': ' + (error?.code ?? error)) }
}
console.log(JSON.stringify(missing))
`)
  const resolved = spawnSync(process.execPath, [resolveCheck, JSON.stringify([...tesseraSpecifiers].sort())], { cwd: consumer, encoding: 'utf8' })
  assert.equal(resolved.status, 0, resolved.stderr)
  assert.deepEqual(JSON.parse(resolved.stdout.trim().split('\n').pop()), [], `every Tessera specifier of ${SDK} is exported by ${TESSERA} (${ownTessera.name}@${ownTessera.version})`)
  pass(`the ${tesseraSpecifiers.size} Tessera specifiers ${SDK} names resolve in ${TESSERA} (${ownTessera.name}@${ownTessera.version}): ${[...tesseraSpecifiers].sort().join(', ')}`)
  const declared = packageFolderImports(installed)
  assert.deepEqual(declared.undeclared, [], `every package ${SDK}'s modules import is declared in its package.json (dependencies, peerDependencies, optionalDependencies) or a Node builtin`)
  pass(`the packages ${SDK}'s code and declarations import are all declared: ${declared.imported.join(', ')}`)
  pass(`Node imports ${nodeSafe.length} subpaths; ${SDK} alone is refused (${imported[SDK].error.trim().split(' ')[0]}); not imported in Node (a page's): ${[...browserOnly].join(', ')}`)
  // The embed server, installed from @kition/sdk, finds the embed module in its own package and
  // serves it with its chunks (it found @kition/embed's before).
  const serverCheck = path.join(consumer, 'server-check.mjs')
  fs.writeFileSync(serverCheck, `
import { startEmbedServer } from '${SDK}/embed/server'
const service = await startEmbedServer({ secret: 'x'.repeat(32), kitsUrl: 'http://127.0.0.1:9/', integrators: [], kits: [], port: 0 })
try {
  const entry = await fetch(service.url + '/assets/embed/index.js')
  const text = await entry.text()
  const chunk = /from ["']\\.\\/(chunks\\/[^"']+)["']/.exec(text)?.[1]
  const second = chunk ? await fetch(service.url + '/assets/embed/' + chunk) : null
  console.log(JSON.stringify({ status: entry.status, length: text.length, chunk, chunkStatus: second?.status }))
} finally { await service.close() }
`)
  const served = spawnSync(process.execPath, [serverCheck], { cwd: consumer, encoding: 'utf8' })
  assert.equal(served.status, 0, served.stderr)
  const answer = JSON.parse(served.stdout.trim().split('\n').pop())
  assert.equal(answer.status, 200, 'the embed server serves /assets/embed/index.js')
  assert.equal(answer.length, fs.readFileSync(path.join(installed, manifest.exports['./embed'].import), 'utf8').length, "and it is @kition/sdk/embed's module")
  assert.ok(answer.chunk && answer.chunkStatus === 200, `and its chunk ${answer.chunk}`)
  pass(`the embed server from ${SDK}/embed/server serves ${SDK}/embed's module and its chunks (/assets/embed/index.js, /assets/embed/${answer.chunk})`)
  for (const [name, file] of Object.entries(manifest.bin ?? {})) {
    assert.ok(fs.readFileSync(path.join(installed, file), 'utf8').startsWith('#!/usr/bin/env node\n'), `${name}: ${file} starts with #!`)
  }
  assert.ok(fs.existsSync(path.join(installed, 'LICENSE')), `${SDK} has LICENSE at its top`)
  assert.equal(fs.readFileSync(path.join(installed, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), `${SDK}'s LICENSE is the repository's`)
  pass(`${SDK} has LICENSE at its top (the repository's)`)
  // What a host app takes from the package instead of copying kition-sdk's sources.
  const exportsCheck = path.join(consumer, 'exports-check.mjs')
  fs.writeFileSync(exportsCheck, `
const kdm = await import('${SDK}/kdm')
const runtime = await import('${SDK}/extensions/runtime')
console.log(JSON.stringify({ replica: typeof kdm.Replica?.load, parseSchema: typeof kdm.parseSchema, runtime: typeof runtime.WORKER_RUNTIME, runtimeLength: runtime.WORKER_RUNTIME?.length ?? 0, sandbox: typeof runtime.SANDBOX_HTML, panel: typeof runtime.PANEL_HTML }))
`)
  const exportsRan = spawnSync(process.execPath, [exportsCheck], { cwd: consumer, encoding: 'utf8' })
  assert.equal(exportsRan.status, 0, exportsRan.stderr)
  const exported = JSON.parse(exportsRan.stdout.trim().split('\n').pop())
  assert.deepEqual({ ...exported, runtimeLength: exported.runtimeLength > 1000 }, { replica: 'function', parseSchema: 'function', runtime: 'string', runtimeLength: true, sandbox: 'string', panel: 'string' }, `${SDK}/kdm's Replica.load and parseSchema, and ${SDK}/extensions/runtime's WORKER_RUNTIME, SANDBOX_HTML and PANEL_HTML`)
  for (const page of ['sandbox.html', 'panel.html']) {
    const file = fileURLToPath(spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve('${SDK}/extensions/${page}'))`], { cwd: consumer, encoding: 'utf8' }).stdout.trim())
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('<!doctype html>'), `${SDK}/extensions/${page} resolves to a page (${file})`)
  }
  pass(`${SDK}/kdm exports Replica.load and parseSchema; ${SDK}/extensions/runtime exports WORKER_RUNTIME (${exported.runtimeLength} characters), SANDBOX_HTML and PANEL_HTML; /extensions/sandbox.html and /extensions/panel.html resolve to files a host copies`)

  // Side effects: only the files package.json's sideEffects names register anything on load (each
  // kit module of /script/kits registers its schema).
  const globToRegExp = (glob) => new RegExp(`^${glob.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
  const effectful = manifest.sideEffects.map((glob) => (glob.includes('/') ? globToRegExp(glob) : new RegExp(`(?:^|/)${globToRegExp(glob).source.slice(1)}`)))
  const registering = fs.readdirSync(path.join(installed, 'dist'), { recursive: true }).map((file) => `dist/${file}`).filter((file) => file.endsWith('.js') && /\bid: "kit\.[a-z]+", schema:/.test(fs.readFileSync(path.join(installed, file), 'utf8')))
  assert.ok(registering.length >= 16, 'the kit modules register their schemas')
  assert.deepEqual(registering.filter((file) => !effectful.some((pattern) => pattern.test(file))), [], 'every file that registers a kit is in sideEffects')
  pass(`the ${registering.length} files that register a kit on load are all in sideEffects (${manifest.sideEffects.join(', ')}); the rest is free of side effects`)

  // 2. Types, under both resolutions.
  const typesCheck = path.join(consumer, 'types-check.ts')
  fs.writeFileSync(typesCheck, code.map((entry, i) => `import * as m${i} from '${specifierOf(entry)}'\nexport type T${i} = typeof m${i}\n`).join(''))
  const rootCheck = path.join(consumer, 'root-check.ts')
  fs.writeFileSync(rootCheck, `import * as sdk from '${SDK}'\nexport type Root = typeof sdk\n`)
  const ours = (file) => file === typesCheck || file.startsWith(`${installed}${path.sep}`)
  for (const [mode, options] of [
    ['bundler', { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }],
    ['node16', { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 }],
  ]) {
    const compilerOptions = { ...options, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noEmit: true, skipLibCheck: false, jsx: ts.JsxEmit.ReactJSX, types: ['node', 'react', 'react-dom'] }
    const program = ts.createProgram([typesCheck], compilerOptions)
    // Every error counts, under both resolutions: @kition/tessera's declarations name their relative
    // imports with .js, so node16 follows them as bundler does.
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => !diagnostic.file || ours(diagnostic.file.fileName))
    const text = ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => consumer, getNewLine: () => '\n' })
    assert.equal(diagnostics.length, 0, `types under ${mode}:\n${text.slice(0, 4000)}`)
    const declarations = program.getSourceFiles().filter((file) => file.fileName.startsWith(`${installed}${path.sep}`)).length
    // The editor's Tessera names are read from Tessera's declarations (not unresolved, which would make them any).
    const tesseraDeclarations = program.getSourceFiles().filter((file) => fs.realpathSync(file.fileName).startsWith(`${fs.realpathSync(tessera)}${path.sep}`)).length
    assert.ok(tesseraDeclarations > 0, `${TESSERA}'s declarations are read under ${mode}`)
    const refused = ts.getPreEmitDiagnostics(ts.createProgram([rootCheck], compilerOptions)).filter((diagnostic) => diagnostic.file?.fileName === rootCheck)
    assert.ok(refused.some((diagnostic) => [2307, 2792].includes(diagnostic.code)), `${SDK} alone has no types under ${mode}`)
    pass(`types of ${code.length} subpaths resolve under moduleResolution ${mode} (${declarations} declaration files, skipLibCheck off for ${SDK}, ${tesseraDeclarations} of ${TESSERA}'s); ${SDK} alone: TS${refused[0].code}`)
  }

  // 3. Browser bundles.
  const bundle = async (name, source) => {
    const dir = path.join(consumer, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'main.js'), source)
    await build({ root: dir, configFile: false, logLevel: 'error', build: { outDir: path.join(dir, 'dist'), emptyOutDir: true, sourcemap: false, rollupOptions: { input: path.join(dir, 'main.js') } } })
    const files = fs.readdirSync(path.join(dir, 'dist'), { recursive: true }).filter((file) => file.endsWith('.js')).map((file) => path.join(dir, 'dist', file))
    return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
  }
  const embed = await bundle('page-embed', `import { KitionEmbed } from '${SDK}/embed'\nwindow.KitionEmbed = KitionEmbed\n`)
  const embedText = embed.map(({ text }) => text).join('\n')
  const editorMarkers = ['kitEngine.worker', '@kition/tessera', 'react.production', 'react-dom', '__SECRET_INTERNALS', 'useSyncExternalStore', 'ribbon']
  const present = editorMarkers.filter((marker) => embedText.includes(marker))
  assert.deepEqual(present, [], 'a page importing only /embed bundles nothing of the editor')
  const first = embed.reduce((smallest, file) => (file.text.includes('window.KitionEmbed') ? file : smallest), embed[0])
  const embedBytes = embed.reduce((sum, { text }) => sum + Buffer.byteLength(text), 0)
  pass(`a page importing only ${SDK}/embed: ${embed.length} files, ${(embedBytes / 1e6).toFixed(2)} MB in all, first chunk ${(Buffer.byteLength(first.text) / 1e3).toFixed(0)} kB; none of ${editorMarkers.join(', ')}`)
  const server = await bundle('page-server', `import * as server from '${SDK}/embed/server'\nwindow.server = server\n`)
  const serverText = server.map(({ text }) => text).join('\n')
  assert.ok(serverText.includes('runs in Node only'), 'a browser bundle of /embed/server gets the Node-only error')
  assert.ok(!/node:http|createServer|createHmac/.test(serverText), 'and none of the server')
  pass(`a page importing ${SDK}/embed/server gets only the error "${SDK}/embed/server runs in Node only ..." (${Buffer.byteLength(serverText)} bytes)`)

  // A host app's page (as Kition Desktop's) importing the KDM, sync, the object model and the
  // extension host together: one KDM, counted by a schema error each copy of its code has once.
  const kdms = (files) => files.map(({ text }) => text).join('\n').split(KDM_MARKER).length - 1
  const host = await bundle('page-host', `import { Replica } from '${SDK}/kdm'\nimport { SyncClient } from '${SDK}/sync'\nimport { openDocument, portFromConnection } from '${SDK}/script'\nimport '${SDK}/script/kits'\nimport { ExtensionHost, iframeSandbox } from '${SDK}/extensions'\nimport { WORKER_RUNTIME } from '${SDK}/extensions/runtime'\nwindow.used = { Replica, SyncClient, openDocument, portFromConnection, ExtensionHost, iframeSandbox, WORKER_RUNTIME }\n`)
  assert.equal(kdms(host), 1, `a page importing ${SDK}/kdm, /sync, /script, /script/kits, /extensions and /extensions/runtime holds one KDM`)
  const hostBytes = host.reduce((sum, { text }) => sum + Buffer.byteLength(text), 0)
  pass(`a page importing ${SDK}/kdm, /sync, /script, /script/kits, /extensions and /extensions/runtime: one KDM (${(hostBytes / 1e6).toFixed(2)} MB of JavaScript in ${host.length} files)`)
  const standaloneFiles = Object.values(manifest.exports).flatMap((target) => (typeof target === 'string' ? [] : [target.import ?? target.default])).filter((file) => file?.startsWith('./dist/standalone/'))
  const standaloneImports = fs.readdirSync(path.join(installed, 'dist/standalone'), { recursive: true }).filter((file) => file.endsWith('.js') && importedPackages(fs.readFileSync(path.join(installed, 'dist/standalone', file), 'utf8')).length > 0)
  assert.deepEqual(standaloneImports, [], `${SDK}'s standalone build (${standaloneFiles.join(', ')}) imports no package`)
  const scriptStandalone = await bundle('page-script-standalone', `import { openDocument, KITS } from '${SDK}/script/standalone'\nwindow.used = { openDocument, KITS }\n`)
  assert.equal(kdms(scriptStandalone), 1, `a page importing ${SDK}/script/standalone holds its own KDM`)
  pass(`${SDK}/script/standalone is self-contained: no package import in dist/standalone, a page of it alone has one KDM`)

  // An editor page bundled as a kit bundles it (kitViteConfig, as kition-html's): the editor's
  // worker is an asset of its own in the kit's build, with nothing inlined.
  const packaged = fs.readdirSync(installed, { recursive: true }).map((file) => file.split(path.sep).join('/'))
  assert.deepEqual(editorWorkerProblems(packaged, (file) => fs.readFileSync(path.join(installed, file), 'utf8')), [], `${SDK}'s editor worker`)
  const packagedWorker = packaged.find((file) => EDITOR_WORKER.test(file))
  const kit = path.join(consumer, 'page-editor')
  fs.mkdirSync(kit)
  fs.writeFileSync(path.join(kit, 'index.html'), '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n')
  fs.writeFileSync(path.join(kit, 'main.js'), `import { KitEngine } from '${SDK}/editor'\nwindow.KitEngine = KitEngine\n`)
  await build(kitViteConfig(kit))
  const kitAssets = path.join(kit, 'dist/assets')
  const emitted = fs.readdirSync(kitAssets)
  const kitWorker = emitted.filter((file) => /^kitEngine\.worker-[\w-]+\.js$/.test(file))
  assert.equal(kitWorker.length, 1, `the kit's build emits the editor's worker: ${emitted.join(', ')}`)
  const kitWorkerText = fs.readFileSync(path.join(kitAssets, kitWorker[0]), 'utf8')
  assert.ok(!/data:application\/wasm/.test(kitWorkerText) && !/;base64,[A-Za-z0-9+/]{65536}/.test(kitWorkerText), "the kit's worker inlines no wasm")
  const kitBytes = emitted.reduce((sum, file) => sum + fs.statSync(path.join(kitAssets, file)).size, 0)
  pass(`an editor page bundled as a kit (Vite, ${SDK} not pre-bundled): ${packagedWorker} becomes the kit's ${kitWorker[0]} (${(Buffer.byteLength(kitWorkerText) / 1e3).toFixed(0)} kB), nothing inlined; ${emitted.length} files, ${(kitBytes / 1e6).toFixed(2)} MB in all`)

  // 4. Sizes.
  const files = fs.readdirSync(installed, { recursive: true }).map((file) => path.join(installed, file)).filter((file) => fs.statSync(file).isFile())
  const unpacked = files.reduce((sum, file) => sum + fs.statSync(file).size, 0)
  const largest = files.map((file) => ({ file: path.relative(installed, file), size: fs.statSync(file).size })).sort((a, b) => b.size - a.size).slice(0, 8)
  const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`
  console.log(`\n${SDK}: packed ${mb(fs.statSync(archive).size)}, unpacked ${mb(unpacked)} in ${files.length} files`)
  for (const { file, size } of largest) console.log(`  ${mb(size).padStart(9)}  ${file}`)
  for (const key of ['./script', './script/standalone']) {
    const own = moduleClosure(installed, manifest.exports[key].import)
    const bytes = own.reduce((sum, file) => sum + fs.statSync(path.join(installed, file)).size, 0)
    console.log(`${SDK}${key.slice(1)}: ${mb(bytes)} in ${own.length} files of the package`)
  }
  const old = PARTS.map((part) => path.join(path.dirname(archive), `${part.dir}.tgz`))
  if (old.every((file) => fs.existsSync(file))) {
    let oldUnpacked = 0
    for (const file of old) for (const line of execFileSync('tar', ['-tzvf', file], { encoding: 'utf8' }).trim().split('\n')) oldUnpacked += Number(line.trim().split(/\s+/)[4]) || 0
    const oldPacked = old.reduce((sum, file) => sum + fs.statSync(file).size, 0)
    console.log(`the ten packages packed here: packed ${mb(oldPacked)}, unpacked ${mb(oldUnpacked)}`)
  }
  console.log(`\nsmoke-sdk-package: ${results.length} checks passed`)
} finally {
  if (!args.includes('--keep')) fs.rmSync(consumer, { recursive: true, force: true })
  else console.log(`kept ${consumer}`)
}
