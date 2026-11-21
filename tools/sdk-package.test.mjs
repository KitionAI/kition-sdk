// @kition/sdk: the mapping from the twelve library packages to its subpaths (tools/sdk-package.mjs),
// its package.json, and the codemod that moves a consumer to it (tools/migrate-to-sdk.mjs).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { formatReport, isPackageManagerFile, LOCKFILES, mentionsLeft, migrateCase, migrateFolder, migrateManifest, migrateText, migrateTsv, packageManagerNotes } from './migrate-to-sdk.mjs'
import { BINS, CLIENT_NAMES, OLD_TESSERA, PARTS, SDK, TESSERA, editorWorkerProblems, manifestOf, oldNamesIn, renameOldNames, sdkBin, sdkExports, sdkSideEffects, sdkSpecifier, standaloneKitModules, subpaths, tesseraImport, tesseraSpecifier } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const sdk = read('packages/sdk/package.json')

const scratch = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('@kition/sdk: one package for the twelve library packages', () => {
  it('maps each of the twelve packages to one subpath, and mirrors every export and executable they have', () => {
    expect(PARTS.map((part) => part.name).sort()).toEqual([
      '@kition/convergence', '@kition/embed', '@kition/embed-server', '@kition/extensions', '@kition/kdm', '@kition/kit-dev-host',
      '@kition/kit-editor', '@kition/kit-engine', '@kition/kit-host', '@kition/kit-ui-protocol', '@kition/script', '@kition/sync',
    ])
    for (const part of PARTS) expect(manifestOf(part).name).toBe(part.name)
    const list = subpaths()
    for (const part of PARTS) {
      const manifest = manifestOf(part)
      const keys = Object.keys(manifest.publishConfig.exports)
      expect(list.filter((entry) => entry.part === part && !entry.sdkOnly).map(({ from }) => from)).toEqual(keys.map((key) => `${part.name}${key === '.' ? '' : key.slice(1)}`))
      for (const name of Object.keys(manifest.bin ?? {})) expect(Object.keys(BINS)).toContain(name)
    }
    const keys = list.map(({ key }) => key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain('.')
  })

  it('names each old specifier as a subpath of @kition/sdk', () => {
    expect(sdkSpecifier('@kition/embed')).toBe('@kition/sdk/embed')
    expect(sdkSpecifier('@kition/embed-server')).toBe('@kition/sdk/embed/server')
    expect(sdkSpecifier('@kition/embed-server/callbacks')).toBe('@kition/sdk/embed/server/callbacks')
    expect(sdkSpecifier('@kition/script/kits/note')).toBe('@kition/sdk/script/kits/note')
    expect(sdkSpecifier('@kition/kit-editor/styles.css')).toBe('@kition/sdk/editor/styles.css')
    expect(sdkSpecifier('@kition/kit-ui-protocol')).toBe('@kition/sdk/protocol')
    expect(sdkSpecifier('@kition/kit-dev-host/check-ui-ids')).toBe('@kition/sdk/dev-host/check-ui-ids')
    for (const other of ['@kition/sdk/embed', '@kition/cli', '@kition/gateway-page', '@kition/tessera-ui', '@kition/kit-note-ui', '@kition/embedded', 'react']) expect(sdkSpecifier(other)).toBeNull()
  })

  it('has package.json as the mapping writes it: exports with no root module, the Node-only server behind its condition, bin and sideEffects', () => {
    expect(sdk.exports).toEqual(sdkExports())
    expect(sdk.bin).toEqual(sdkBin())
    expect(sdk.sideEffects).toEqual(sdkSideEffects())
    expect(sdk.main).toBeUndefined()
    expect(sdk.types).toBeUndefined()
    expect(sdk.exports['./embed/server']).toEqual({ types: './dist/types/embed-server/src/index.d.ts', node: './dist/lib/embed-server/index.js', default: './dist/lib/node-only/embed-server.js' })
    expect(sdk.exports['./editor/styles.css']).toBe('./dist/lib/kit-editor/styles.css')
    expect(sdk.exports['./embed']).toEqual({ types: './dist/types/embed/src/index.d.ts', import: './dist/standalone/index.js' })
    expect(sdk.sideEffects).toContain('*.css')
    // The object model and the extension host are library builds, sharing Loro and the KDM with
    // /kdm and /sync; the self-contained object model is /script/standalone, beside /embed.
    expect(sdk.exports['./script']).toEqual({ types: './dist/types/script/src/index.d.ts', import: './dist/lib/script/index.js' })
    expect(sdk.exports['./script/kits/note']).toEqual({ types: './dist/types/script/kits/note.d.ts', import: './dist/lib/script/kits/note.js' })
    expect(sdk.exports['./extensions']).toEqual({ types: './dist/types/extensions/src/index.d.ts', import: './dist/lib/extensions/index.js' })
    expect(sdk.exports['./script/standalone']).toEqual({ types: './dist/types/script/src/standalone.d.ts', import: './dist/standalone/script/index.js' })
    expect(Object.entries(sdk.exports).filter(([, target]) => JSON.stringify(target).includes('/dist/standalone/')).map(([key]) => key)).toEqual(['./embed', './script/standalone'])
    expect(sdk.sideEffects).toEqual(['*.css', './dist/lib/script/kits/*.js', './dist/standalone/script/index.js', './dist/standalone/script/kits/*.js', './dist/lib/embed-server/cli.js'])
    expect(Object.keys(standaloneKitModules())).toHaveLength(16)
    expect(standaloneKitModules()['script/kits/note']).toBe('./kits/note.ts')
    expect(spawnSync(process.execPath, [path.join(root, 'tools/sdk-package.mjs'), '--check'], { encoding: 'utf8' }).status).toBe(0)
  })

  it('depends on no other @kition library package: loro-crdt as kdm has it, React and @kition/tessera optional peers', () => {
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(sdk[section] ?? {})) expect(name.startsWith('@kition/') && name !== TESSERA, `${section}: ${name}`).toBe(false)
    }
    expect(sdk.dependencies).toEqual({ 'loro-crdt': read('packages/kdm/package.json').dependencies['loro-crdt'] })
    expect(Object.keys(sdk.peerDependencies).sort()).toEqual([TESSERA, 'react', 'react-dom'])
    for (const name of Object.keys(sdk.peerDependencies)) expect(sdk.peerDependenciesMeta[name], name).toEqual({ optional: true })
    // The twelve packages keep Tessera's three old packages; @kition/sdk's one peer takes their range.
    const editor = read('packages/kit-editor/package.json')
    expect(Object.keys(editor.dependencies).filter((name) => name.startsWith('@kition/tessera')).sort()).toEqual(OLD_TESSERA)
    for (const name of OLD_TESSERA) expect(sdk.peerDependencies[TESSERA], name).toBe(editor.dependencies[name])
    for (const name of ['react', 'react-dom']) expect(sdk.peerDependencies[name]).toBe(editor.peerDependencies[name])
    expect(sdk.version).toBe(read('sdk.json').version)
  })

  it('names Tessera as the one package @kition/tessera: @kition/tessera-<part><rest> is @kition/tessera/<part><rest>', () => {
    expect(TESSERA).toBe('@kition/tessera')
    expect(tesseraSpecifier('ui', '/styles.css')).toBe('@kition/tessera/ui/styles.css')
    expect(tesseraImport('@kition/tessera-ui/styles.css')).toBe('@kition/tessera/ui/styles.css')
    expect(tesseraImport('@kition/tessera-icons/react')).toBe('@kition/tessera/icons/react')
    expect(tesseraImport('@kition/tessera-tokens')).toBe('@kition/tessera/tokens')
    expect(tesseraImport('@kition/tessera-ui/workspaceTree')).toBe('@kition/tessera/ui/workspaceTree')
    for (const other of ['@kition/kit-editor', '@kition/tessera', '@kition/tessera/ui', '@kition/tessera-uix', 'react']) expect(tesseraImport(other), other).toBeNull()
  })

  it('renames the old package names in what it ships (comments, messages, declarations) by the same mapping, but the client names a library sends a server', () => {
    expect(renameOldNames("//   import { runModeSmoke } from '@kition/kit-dev-host/mode-smoke'")).toBe("//   import { runModeSmoke } from '@kition/sdk/dev-host/mode-smoke'")
    expect(renameOldNames('throw new Error("@kition/embed is not installed next to @kition/embed-server: install it")')).toBe('throw new Error("@kition/sdk/embed is not installed next to @kition/sdk/embed/server: install it")')
    expect(renameOldNames(" * Import `@kition/kit-editor/styles.css` once; Tessera (`@kition/tessera-ui`), `@kition/script/kits/<kit>`, @kition/kdm's changesSince")).toBe(" * Import `@kition/sdk/editor/styles.css` once; Tessera (`@kition/tessera/ui`), `@kition/sdk/script/kits/<kit>`, @kition/sdk/kdm's changesSince")
    for (const other of ['@kition/embedded', '@kition/sdk/embed', '@kition/tessera/ui', '@kition/cli', '@kition/kit-note-ui']) expect(renameOldNames(other)).toBe(other)
    // Client names go over the wire (the sync hello, kits.initialize): kept, and allowed by the checks.
    expect(CLIENT_NAMES).toEqual(['@kition/embed', '@kition/script', '@kition/sync'])
    const clients = 'client: t.client ?? { name: "@kition/script", version: "0.1.0" }\nclient: { name: \'@kition/sync\', version: v }\n{ name: "@kition/embed", version: pe }'
    expect(renameOldNames(clients)).toBe(clients)
    expect(oldNamesIn(clients)).toEqual([])
    // Only those three, and only as a client's { name, version }.
    expect(renameOldNames('{ name: "@kition/kdm", version: 1 }')).toBe('{ name: "@kition/sdk/kdm", version: 1 }')
    expect(oldNamesIn('a\n// @kition/kit-host\nconst name = "@kition/script"')).toEqual([{ name: '@kition/kit-host', line: 2 }, { name: '@kition/script', line: 3 }])
    expect(oldNamesIn(renameOldNames('@kition/embed-server @kition/tessera-icons/react @kition/kit-ui-protocol'))).toEqual([])
  })

  it("ships Loro's WebAssembly as a file beside the editor's worker, named as a bundler finds it, never inlined", () => {
    const worker = 'dist/lib/assets/kitEngine.worker-AbC_1-x.js'
    const wasm = 'dist/lib/assets/loro_wasm_bg-Gulzks_0.wasm'
    const editor = 'dist/lib/kit-editor/index.js'
    const glue = 'async function init(n) { return WebAssembly.instantiateStreaming(fetch(n), {}) }\n'
    const good = {
      [worker]: `${glue}init(new URL("./loro_wasm_bg-Gulzks_0.wasm", import.meta.url))\n`,
      [wasm]: '\0asm',
      [editor]: 'const w = new Worker(new URL("../assets/kitEngine.worker-AbC_1-x.js", import.meta.url), { type: "module" })\nconst v = new Worker(new URL(\'../assets/kitEngine.worker-AbC_1-x.js\', import.meta.url), { type: "module" })\n',
    }
    const problems = (files) => editorWorkerProblems(Object.keys(files), (file) => files[file])
    expect(problems(good)).toEqual([])
    // Library mode's inlining: no wasm file, the module as base64 in the worker.
    const inlined = { [worker]: `${glue}init(new URL("data:application/wasm;base64,${'A'.repeat(70000)}", import.meta.url))\n`, [editor]: good[editor] }
    expect(problems(inlined)).toEqual([expect.stringMatching(/0 Loro wasm files .*inlines Loro again/)])
    expect(problems({ ...inlined, [wasm]: '\0asm' })).toEqual([expect.stringMatching(/does not name .*loro_wasm_bg-Gulzks_0\.wasm/), expect.stringMatching(/inlines a large data: URL/)])
    expect(problems({ ...good, [worker]: `${glue}const x = "data:font/woff2;base64,${'B'.repeat(70000)}"\n${good[worker]}` })).toEqual([expect.stringMatching(/inlines a large data: URL/)])
    // Library mode's worker URL, which a bundler copies as an opaque file (without the wasm).
    const ignored = 'new Worker(new URL(/* @vite-ignore */ "" + new URL("../assets/kitEngine.worker-AbC_1-x.js", import.meta.url).href, import.meta.url), { type: "module" })'
    expect(problems({ ...good, [editor]: `${good[editor]}${ignored}\n` })).toEqual([expect.stringMatching(/names .* 3 times, 2 of them as new Worker/)])
    expect(problems({ ...good, [editor]: 'nothing' })).toEqual([expect.stringMatching(/no chunk of @kition\/sdk starts/)])
    // loro-crdt/browser's loader: a blocking request and a synchronous compile.
    expect(problems({ ...good, [worker]: 'throw new Error("loro-crdt browser build requires XMLHttpRequest for synchronous WASM loading.")\nnew WebAssembly.Module(new URL("./loro_wasm_bg-Gulzks_0.wasm", import.meta.url))' })).toEqual([expect.stringMatching(/as loro-crdt\/browser does/)])
    expect(problems({ ...good, [worker.replace('AbC', 'Two')]: good[worker] })).toEqual([expect.stringMatching(/2 editor workers/)])
    // The built package, when it is there, is as the check wants it.
    const built = path.join(root, 'packages/sdk')
    if (fs.existsSync(path.join(built, 'dist/lib/assets'))) {
      const files = fs.readdirSync(path.join(built, 'dist'), { recursive: true }).map((file) => `dist/${file.split(path.sep).join('/')}`).filter((file) => /\.(?:js|wasm)$/.test(file))
      expect(editorWorkerProblems(files, (file) => fs.readFileSync(path.join(built, file), 'utf8'))).toEqual([])
    }
  })
})

describe('migrate-to-sdk: a consumer moved to @kition/sdk', () => {
  it('rewrites imports, exports, dynamic imports, requires, test mocks, CSS imports and package lists; lists an old name used otherwise; leaves other names alone', () => {
    const source = [
      "import { KitionEmbed } from '@kition/embed'",
      'import { mountEditor } from "@kition/kit-editor"',
      "import '@kition/kit-editor/styles.css'",
      "export * from '@kition/kit-ui-protocol'",
      "export type { Replica } from '@kition/kdm'",
      "const note = await import('@kition/script/kits/note')",
      "const server = require('@kition/embed-server/callbacks')",
      "vi.mock('@kition/sync/openToken', () => ({}))",
      'export default { resolve: { dedupe: [`@kition/kit-engine`, "@kition/kit-host"] } }',
      "import { Button } from '@kition/tessera-ui'",
      "import kit from '@kition/kit-note-ui/note-ui/kit.json'",
      "const cli = '@kition/cli'",
      "// see @kition/embed's README",
    ].join('\n')
    const { text, changes, notes } = migrateText(source)
    expect(text.split('\n')).toEqual([
      "import { KitionEmbed } from '@kition/sdk/embed'",
      'import { mountEditor } from "@kition/sdk/editor"',
      "import '@kition/sdk/editor/styles.css'",
      "export * from '@kition/sdk/protocol'",
      "export type { Replica } from '@kition/sdk/kdm'",
      "const note = await import('@kition/sdk/script/kits/note')",
      "const server = require('@kition/sdk/embed/server/callbacks')",
      "vi.mock('@kition/sdk/sync/openToken', () => ({}))",
      'export default { resolve: { dedupe: [`@kition/sdk`] } }',
      "import { Button } from '@kition/tessera-ui'",
      "import kit from '@kition/kit-note-ui/note-ui/kit.json'",
      "const cli = '@kition/cli'",
      "// see @kition/embed's README",
    ])
    // Eight specifiers, and the two package names of the dedupe list, which become the package once.
    expect(changes).toHaveLength(10)
    expect(notes).toEqual([{ line: 13, text: "@kition/embed (unquoted, as in a comment): it is @kition/sdk/embed now, of the package @kition/sdk (// see @kition/embed's README)" }])
    const quoted = migrateText("const name = '@kition/kit-engine'\n")
    expect(quoted.notes).toEqual([{ line: 1, text: "@kition/kit-engine is named here as something other than an import (const name = '@kition/kit-engine'); change it by hand: the package is @kition/sdk, this subpath @kition/sdk/engine" }])
    const more = migrateText("declare module '@kition/kdm' {}\nconst at = import.meta.resolve('@kition/embed')\nconst all = await vi.importActual(\n'@kition/kit-host')\n")
    expect(more.text).toBe("declare module '@kition/sdk/kdm' {}\nconst at = import.meta.resolve('@kition/sdk/embed')\nconst all = await vi.importActual(\n'@kition/kit-host')\n")
    expect(more.notes).toHaveLength(1)
    const css = migrateText("@import '@kition/kit-editor/styles.css';\n@import \"@kition/tessera-ui/styles.css\";\n")
    expect(css.text).toBe("@import '@kition/sdk/editor/styles.css';\n@import \"@kition/tessera-ui/styles.css\";\n")
  })

  it('replaces the old names in package.json by @kition/sdk once per section, adds @kition/tessera for the editor, and lists overrides for a person', () => {
    const { manifest, changes, notes } = migrateManifest({
      name: 'kition-note-web',
      dependencies: { '@kition/kit-editor': '^0.5.2', '@kition/kdm': '^0.5.2', react: '^19.0.0', 'loro-crdt': '1.16.4' },
      devDependencies: { '@kition/kit-dev-host': '^0.5.2', vitest: '^2.1.0' },
      peerDependencies: { '@kition/embed': '>=0.5' },
      peerDependenciesMeta: { '@kition/embed': { optional: true } },
      pnpm: { overrides: { '@kition/kit-editor': 'link:../../kition-sdk/packages/kit-editor', '@kition/tessera-ui': 'link:../x' } },
    })
    expect(manifest.dependencies).toEqual({ '@kition/sdk': `^${sdk.version}`, react: '^19.0.0', 'loro-crdt': '1.16.4', '@kition/tessera': sdk.peerDependencies['@kition/tessera'] })
    expect(Object.keys(manifest.dependencies)[0]).toBe('@kition/sdk')
    // Once: devDependencies lose @kition/kit-dev-host, which @kition/sdk in dependencies covers.
    expect(manifest.devDependencies).toEqual({ vitest: '^2.1.0' })
    expect(manifest.peerDependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    expect(manifest.peerDependenciesMeta).toEqual({ '@kition/sdk': { optional: true } })
    expect(manifest.pnpm.overrides).toEqual({ '@kition/kit-editor': 'link:../../kition-sdk/packages/kit-editor', '@kition/tessera-ui': 'link:../x' })
    expect(notes.map(({ text }) => text)).toEqual(['pnpm.overrides: @kition/kit-editor -> "link:../../kition-sdk/packages/kit-editor" names @kition/kit-editor; point it at @kition/sdk by hand'])
    expect(changes.length).toBeGreaterThan(4)
    // A project that still has Tessera's old packages keeps them, with a note naming kition-tessera's
    // codemod (which moves them, and their link: paths, to @kition/tessera); --sdk-spec names another range.
    const old = migrateManifest({ dependencies: { '@kition/kit-editor': '^0.5.2', '@kition/tessera-ui': 'link:../ui' }, devDependencies: { '@kition/tessera-icons': '^0.1.0' } }, { sdkSpec: 'workspace:*' })
    expect(old.manifest.dependencies).toEqual({ '@kition/sdk': 'workspace:*', '@kition/tessera-ui': 'link:../ui' })
    expect(old.manifest.devDependencies).toEqual({ '@kition/tessera-icons': '^0.1.0' })
    expect(old.notes.map(({ text }) => text)).toEqual(["@kition/tessera-ui, @kition/tessera-icons: Tessera is one package now, @kition/tessera, which @kition/sdk/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs <folder> (its package.json and its imports)"])
    // A project that has @kition/tessera keeps its own range.
    const own = migrateManifest({ dependencies: { '@kition/kit-editor': '^0.5.2' }, devDependencies: { '@kition/tessera': 'link:../tessera' } })
    expect(own.manifest.dependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    expect(own.manifest.devDependencies).toEqual({ '@kition/tessera': 'link:../tessera' })
    expect(own.notes).toEqual([])
    // Without the editor, no Tessera.
    expect(migrateManifest({ dependencies: { '@kition/embed': '^0.5.2' } }).manifest.dependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    expect(migrateManifest({ dependencies: { react: '^19' } }).changes).toEqual([])
    // Only devDependencies: @kition/sdk goes there.
    expect(migrateManifest({ devDependencies: { '@kition/kit-dev-host': '^0.1.0', '@kition/kit-host': '^0.1.0' } }).manifest.devDependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
  })

  it('writes exactly the specs given for @kition/sdk and @kition/tessera (a rehearsal\'s npm aliases), also over entries the project has', () => {
    const sdkSpec = 'npm:@kitionstage/sdk@0.5.2-stage.4'
    const tesseraSpec = 'npm:@kitionstage/tessera@0.1.1-stage.3'
    // A kit's web/package.json as the kits have it: the editor, the engine, the host and Tessera's icons.
    const kit = {
      name: 'kition-note-web',
      dependencies: { '@kition/kdm': '^0.1.0', '@kition/kit-editor': '^0.1.0', '@kition/kit-engine': '^0.1.0', '@kition/kit-host': '^0.1.0', '@kition/kit-ui-protocol': '^0.1.0', '@kition/tessera-icons': '^0.1.0', react: '^19.0.0' },
      devDependencies: { '@kition/kit-dev-host': '^0.1.0', vite: '^6.0.0' },
    }
    const moved = migrateManifest(kit, { sdkSpec, tesseraSpec })
    expect(moved.manifest.dependencies).toEqual({ '@kition/sdk': sdkSpec, '@kition/tessera-icons': '^0.1.0', react: '^19.0.0', '@kition/tessera': tesseraSpec })
    expect(moved.manifest.devDependencies).toEqual({ vite: '^6.0.0' })
    expect(moved.changes).toContainEqual({ from: 'dependencies: (Tessera came with @kition/kit-editor)', to: `dependencies: @kition/tessera@${tesseraSpec}` })
    // Tessera's old package stays for kition-tessera's codemod, which keeps the @kition/tessera entry.
    expect(moved.notes.map(({ text }) => text)).toEqual([expect.stringContaining("@kition/tessera-icons: Tessera is one package now, @kition/tessera, which @kition/sdk/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs")])
    expect(kit.dependencies['@kition/sdk']).toBeUndefined()
    // A project moved before: its entries take the new specs, in their places.
    const again = migrateManifest({ dependencies: { '@kition/sdk': '^0.5.2', '@kition/tessera': '^0.1.0', react: '^19.0.0' } }, { sdkSpec, tesseraSpec })
    expect(again.manifest.dependencies).toEqual({ '@kition/sdk': sdkSpec, '@kition/tessera': tesseraSpec, react: '^19.0.0' })
    expect(again.changes).toEqual([
      { from: 'dependencies: @kition/sdk@^0.5.2', to: `dependencies: @kition/sdk@${sdkSpec}` },
      { from: 'dependencies: @kition/tessera@^0.1.0', to: `dependencies: @kition/tessera@${tesseraSpec}` },
    ])
    expect(migrateManifest(again.manifest, { sdkSpec, tesseraSpec }).changes).toEqual([])
    // Without the specs, an entry the project has is its own; --tessera-spec alone adds nothing where no Tessera was.
    expect(migrateManifest({ dependencies: { '@kition/sdk': '^0.5.0', '@kition/tessera': '^0.1.0' } }).changes).toEqual([])
    expect(migrateManifest({ dependencies: { '@kition/embed': '^0.5.2' } }, { tesseraSpec }).manifest.dependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    // With a spec, beside Tessera's old packages in a project already on @kition/sdk.
    expect(migrateManifest({ devDependencies: { '@kition/sdk': '^0.5.2', '@kition/tessera-ui': '^0.1.0' } }, { tesseraSpec }).manifest.devDependencies).toEqual({ '@kition/sdk': '^0.5.2', '@kition/tessera-ui': '^0.1.0', '@kition/tessera': tesseraSpec })

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-to-sdk-spec-'))
    scratch.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(kit, null, 2)}\n`)
    const tool = path.join(root, 'tools/migrate-to-sdk.mjs')
    const ran = spawnSync(process.execPath, [tool, dir, '--sdk-spec', sdkSpec, '--tessera-spec', tesseraSpec], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies).toEqual(moved.manifest.dependencies)
    // Written, and the place left for a person listed with its line (exit 0 without --check).
    expect(ran.stdout).toContain(`needs a person: 1 place(s)\n  ${path.relative(process.cwd(), path.join(dir, 'package.json'))}:9: @kition/tessera-icons: Tessera is one package now`)
    for (const bad of [[dir, '--sdk-spec'], [dir, '--tessera-spec', '--check'], [dir, '--version', '^1.0.0']]) expect(spawnSync(process.execPath, [tool, ...bad], { encoding: 'utf8' }).status, bad.join(' ')).toBe(2)
  })

  it('migrates a folder, never a lockfile, node_modules or build output; the report ends with what changed and what needs a person; --check exits 1 for either', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-to-sdk-'))
    scratch.push(dir)
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    }
    write('package.json', `${JSON.stringify({ name: 'web', dependencies: { '@kition/embed': '^0.5.2' } }, null, 2)}\n`)
    write('src/main.ts', "import { KitionEmbed } from '@kition/embed'\n")
    write('src/app.css', "@import '@kition/kit-editor/styles.css';\n")
    for (const lockfile of LOCKFILES) write(lockfile, "'@kition/embed': 0.5.2\n")
    write('node_modules/@kition/embed/index.js', "export * from '@kition/kdm'\n")
    write('dist/index.js', "import '@kition/embed'\n")
    write('README.md', "npm i '@kition/embed'\n")
    write('.pnpmfile.cjs', "const local = { '@kition/embed': '../kition-sdk/packages/embed' }\n")
    const before = Object.fromEntries([...LOCKFILES, 'node_modules/@kition/embed/index.js', 'dist/index.js', 'README.md', '.pnpmfile.cjs'].map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]))
    const tool = path.join(root, 'tools/migrate-to-sdk.mjs')
    const checked = spawnSync(process.execPath, [tool, dir, '--check'], { encoding: 'utf8' })
    expect(checked.status).toBe(1)
    expect(checked.stdout).toContain("@kition/embed -> @kition/sdk/embed")
    expect(checked.stdout).toContain('3 file(s) would change, 1 place(s) need a person')
    expect(checked.stdout).toMatch(/\nneeds a person: 1 place\(s\)\n  .*\.pnpmfile\.cjs:1: an @kition package other than @kition\/sdk and @kition\/tessera and an old SDK package's short name or folder .*: link @kition\/sdk to kition-sdk's packages\/sdk/)
    expect(checked.stdout.indexOf('changed (would change')).toBeLessThan(checked.stdout.indexOf('needs a person:'))
    expect(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8')).toBe("import { KitionEmbed } from '@kition/embed'\n")
    const report = migrateFolder(dir)
    expect(report.map(({ file }) => path.relative(dir, file)).sort()).toEqual(['.pnpmfile.cjs', 'package.json', 'src/app.css', 'src/main.ts'])
    expect(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8')).toBe("import { KitionEmbed } from '@kition/sdk/embed'\n")
    expect(fs.readFileSync(path.join(dir, 'src/app.css'), 'utf8')).toBe("@import '@kition/sdk/editor/styles.css';\n")
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    for (const [file, text] of Object.entries(before)) expect(fs.readFileSync(path.join(dir, file), 'utf8'), file).toBe(text)
    // Nothing left to rewrite, but a place for a person: --check still fails until the hook is fixed.
    const again = spawnSync(process.execPath, [tool, dir, '--check'], { encoding: 'utf8' })
    expect(again.status).toBe(1)
    expect(again.stdout).toContain('0 file(s) would change, 1 place(s) need a person')
    write('.pnpmfile.cjs', "const local = { '@kition/sdk': '../kition-sdk/packages/sdk' }\n")
    const done = spawnSync(process.execPath, [tool, dir, '--check'], { encoding: 'utf8' })
    expect(done.status, done.stdout).toBe(0)
    expect(done.stdout).toContain('0 file(s) would change, 0 place(s) need a person')
  })

  it('flags a package manager hook that builds the old names from short ones, and leaves a moved one alone', () => {
    expect(['.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpmfile.js', '.pnpmfile.js', '.yarnrc.yml'].every(isPackageManagerFile)).toBe(true)
    expect(isPackageManagerFile('pnpmfile.ts')).toBe(false)
    const hook = [
      '// Installs the published @kition/* packages.',
      'const local = {',
      "  ...Object.fromEntries(['kit-dev-host', 'kit-editor'].map((name) => [`@kition/${name}`, path.join(sdk, 'packages', name)])),",
      "  '@kition/kdm': path.join(sdk, 'packages/kdm'),",
      "  'kdm-short': require('../../kition-sdk/packages/kit-host/package.json'),",
      "  '@kition/tessera-ui': path.join(tessera, 'packages', 'ui'),",
      '}',
    ].join('\n')
    expect(packageManagerNotes(hook).map(({ line }) => line)).toEqual([1, 3, 4, 5, 6])
    expect(packageManagerNotes(hook)[1].text).toContain(`link ${SDK} to kition-sdk's packages/sdk`)
    // A hook moved to @kition/sdk and @kition/tessera has nothing to flag.
    const moved = "// Installs the published @kition/sdk and @kition/tessera.\nconst local = {\n  '@kition/sdk': path.join(sdk, 'packages', 'sdk'),\n  '@kition/tessera': path.join(tessera, 'packages/tessera'),\n}\n"
    expect(packageManagerNotes(moved)).toEqual([])
  })

  it('rewrites package-name lists to the package and nested optimizeDeps entries, once per list', () => {
    const config = [
      'export default {',
      "  resolve: { dedupe: ['react', '@kition/kit-editor', '@kition/kit-host'] },",
      '  optimizeDeps: {',
      '    exclude: [',
      "      '@kition/kit-editor',",
      "      '@kition/kdm',",
      "      'loro-crdt',",
      '    ],',
      "    include: ['@kition/kit-editor > use-sync-external-store/shim', '@kition/kit-editor > @kition/tessera-ui'],",
      '  },',
      "  ssr: { noExternal: ['@kition/kit-engine'] },",
      "  build: { rollupOptions: { external: ['@kition/kit-host', 'react'] } },",
      "  other: { name: '@kition/kit-dev-host > x' },",
      '}',
    ].join('\n')
    const { text, changes, notes } = migrateText(config)
    expect(text.split('\n')).toEqual([
      'export default {',
      "  resolve: { dedupe: ['react', '@kition/sdk'] },",
      '  optimizeDeps: {',
      '    exclude: [',
      "      '@kition/sdk',",
      "      'loro-crdt',",
      '    ],',
      "    include: ['@kition/sdk > use-sync-external-store/shim', '@kition/sdk > @kition/tessera-ui'],",
      '  },',
      "  ssr: { noExternal: ['@kition/sdk'] },",
      "  build: { rollupOptions: { external: ['@kition/sdk', 'react'] } },",
      "  other: { name: '@kition/sdk > x' },",
      '}',
    ])
    expect(changes).toContainEqual({ from: 'include: @kition/kit-editor > use-sync-external-store/shim', to: 'include: @kition/sdk > use-sync-external-store/shim' })
    expect(changes).toContainEqual({ from: 'exclude: @kition/kdm', to: 'exclude: @kition/sdk' })
    expect(changes).toContainEqual({ from: '@kition/kit-dev-host > x', to: '@kition/sdk > x' })
    // Rollup's external matches whole ids: the one note.
    expect(notes).toEqual([{ line: 11, text: expect.stringContaining("Rollup's external matches whole module ids") }])
    // A second run changes nothing.
    expect(migrateText(text).changes).toEqual([])
  })

  it('flags old names in comments, regex-escaped, built from parts, and paths into the kition-sdk checkout, with what replaces them', () => {
    const source = [
      '// @kition/kit-editor may be linked from a kition-sdk checkout',
      'const old = /^@kition\\/kdm$/',
      "const escaped = '@kition\\\\/kit-host'",
      'const names = short.map((name) => `@kition/${name}`)',
      "const alias = { '@kition/sdk/editor': path.join(sdk, 'kition-sdk/packages/kit-editor/src') }",
      "const { runModeSmoke } = await import('../../kition-sdk/packages/kit-dev-host/src/modeSmoke.mjs')",
      "const { checkUiIds } = await import(new URL('packages/kit-dev-host/src/checkUiIds.mjs', base).href)",
      "const engine = path.join(sdk, 'packages', 'kit-engine')",
      "import { x } from '@kition/sdk/editor' // @kition/sdk is fine",
    ].join('\n')
    const { text, changes, notes } = migrateText(source)
    expect(text).toBe(source)
    expect(changes).toEqual([])
    expect(notes.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(notes[0].text).toContain('@kition/kit-editor (unquoted, as in a comment): it is @kition/sdk/editor now')
    expect(notes[1].text).toContain('@kition\\/kdm (regex-escaped): it is @kition/sdk/kdm now')
    expect(notes[2].text).toContain('@kition\\\\/kit-host (regex-escaped): it is @kition/sdk/host now')
    expect(notes[3].text).toContain('a package name built from parts')
    expect(notes[4].text).toContain("a path into kition-sdk's packages/kit-editor/src")
    expect(notes[5].text).toContain("a path into kition-sdk's packages/kit-dev-host/src/modeSmoke.mjs: import @kition/sdk/dev-host/mode-smoke instead")
    expect(notes[6].text).toContain('import @kition/sdk/dev-host/check-ui-ids instead')
    expect(notes[7].text).toContain("a path into kition-sdk's packages/kit-engine")
  })

  it('rewrites specifiers dynamic loaders take (a dev server\'s ssrLoadModule, createRequire\'s and a plugin\'s resolve, a runner\'s import, jiti, import() with a comment); lists <old>/package.json', () => {
    // kition-layout's web/tests/collab.mjs before its move (ea0050f0^), and the other loaders' forms.
    const source = [
      "const { SyncClient, startRelay, SyncRpcError } = await vite.ssrLoadModule('@kition/sync')",
      "const { LORO_REPLICA_VERSIONS: versions } = await vite.ssrLoadModule('@kition/sync/replicaVersions')",
      'const editor = await server.ssrLoadModule("@kition/kit-editor")',
      "const smoke = createRequire(import.meta.url).resolve('@kition/kit-dev-host/mode-smoke')",
      "const kdm = await import(/* @vite-ignore */ '@kition/kdm')",
      "const id = await this.resolve('@kition/sync', importer)",
      "const sync = await runner.import('@kition/sync')",
      "const loaded = jiti('@kition/kit-engine')",
      "const manifest = require.resolve('@kition/kit-engine/package.json')",
      "const label = '@kition/kdm'",
    ].join('\n')
    const { text, changes, notes } = migrateText(source)
    expect(text.split('\n')).toEqual([
      "const { SyncClient, startRelay, SyncRpcError } = await vite.ssrLoadModule('@kition/sdk/sync')",
      "const { LORO_REPLICA_VERSIONS: versions } = await vite.ssrLoadModule('@kition/sdk/sync/replicaVersions')",
      'const editor = await server.ssrLoadModule("@kition/sdk/editor")',
      "const smoke = createRequire(import.meta.url).resolve('@kition/sdk/dev-host/mode-smoke')",
      "const kdm = await import(/* @vite-ignore */ '@kition/sdk/kdm')",
      "const id = await this.resolve('@kition/sdk/sync', importer)",
      "const sync = await runner.import('@kition/sdk/sync')",
      "const loaded = jiti('@kition/sdk/engine')",
      "const manifest = require.resolve('@kition/kit-engine/package.json')",
      "const label = '@kition/kdm'",
    ])
    expect(changes).toHaveLength(8)
    expect(notes).toEqual([
      { line: 9, text: '@kition/kit-engine/package.json: @kition/sdk exports no package.json; resolve one of its subpaths (@kition/sdk/engine) or read packages/sdk/package.json by hand' },
      { line: 10, text: "@kition/kdm is named here as something other than an import (const label = '@kition/kdm'); change it by hand: the package is @kition/sdk, this subpath @kition/sdk/kdm" },
    ])
  })

  it('rewrites old names in a .tsv catalog\'s comments and lists them in its data', () => {
    // kition-cad's web/src/i18n/upstream/uk.tsv before its move (8618050e^).
    const catalog = [
      '# UTF-8: (empty)<TAB>English source<TAB>Ukrainian translation. The first column is ignored by',
      "# this kit's loader (@kition/kit-editor's loadPhrases); it is kept empty so the catalog keeps its",
      '# three-column form, as @kition/kit-dev-host/mode-smoke.',
      '\t  Cancel  \tСкасувати',
      '\tOpened by @kition/kit-editor\tВідкрито @kition/kit-editor',
      '',
    ].join('\n')
    const { text, changes, notes } = migrateTsv(catalog)
    expect(text.split('\n')).toEqual([
      '# UTF-8: (empty)<TAB>English source<TAB>Ukrainian translation. The first column is ignored by',
      "# this kit's loader (@kition/sdk/editor's loadPhrases); it is kept empty so the catalog keeps its",
      '# three-column form, as @kition/sdk/dev-host/mode-smoke.',
      '\t  Cancel  \tСкасувати',
      '\tOpened by @kition/kit-editor\tВідкрито @kition/kit-editor',
      '',
    ])
    expect(changes).toEqual([{ from: '@kition/kit-editor', to: '@kition/sdk/editor' }, { from: '@kition/kit-dev-host/mode-smoke', to: '@kition/sdk/dev-host/mode-smoke' }])
    expect(notes).toEqual([{ line: 5, text: "@kition/kit-editor -> @kition/sdk/editor in the catalog's data (a source string or a translation): change it by hand if it names the package (Opened by @kition/kit-editor\tВідкрито @kition/kit-editor)" }])
  })

  it('rewrites old names in a case.yaml\'s intent and lists them in its protected fields', () => {
    // kition-layout's cases/regressions/issue-published-editor-shim/case.yaml before its move (ea0050f0^).
    const kase = [
      'format: 1',
      'id: regressions/issue-published-editor-shim',
      'intent: >-',
      '  The development page opens the editor on the published @kition/kit-editor installed from',
      '  npm, with the CommonJS shim that @kition/kit-editor/styles.css. reaches.',
      'layer: gate',
      'steps:',
      "  - exec: { cmd: [node, -e, \"import('@kition/kit-editor')\"] }",
      'expected:',
      '  - actual: out:exec',
      '',
    ].join('\n')
    const { text, changes, notes } = migrateCase(kase)
    expect(text.split('\n').slice(3, 5)).toEqual([
      '  The development page opens the editor on the published @kition/sdk/editor installed from',
      '  npm, with the CommonJS shim that @kition/sdk/editor/styles.css. reaches.',
    ])
    expect(text.split('\n').slice(5)).toEqual(kase.split('\n').slice(5))
    expect(changes).toEqual([{ from: '@kition/kit-editor', to: '@kition/sdk/editor' }, { from: '@kition/kit-editor/styles.css', to: '@kition/sdk/editor/styles.css' }])
    expect(notes).toEqual([{ line: 8, text: "@kition/kit-editor -> @kition/sdk/editor in the case's steps: a case's steps, input and expected results are protected, so only a maintainer changes them (- exec: { cmd: [node, -e, \"import('@kition/kit-editor')\"] })" }])
  })

  it('lists the mentions left in text files it does not rewrite, in the folder and in the repository around it, without failing --check for them', () => {
    // A kit repository as kition-cad was before its move: web/ is migrated; AGENTS.md, docs/ and
    // cases/ are outside it.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-to-sdk-repo-')))
    scratch.push(repo)
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      fs.writeFileSync(path.join(repo, file), text)
    }
    fs.mkdirSync(path.join(repo, '.git'))
    write('AGENTS.md', "- `web/` is a React app on `@kition/kit-editor` (kition-sdk's\n")
    write('docs/development.md', 'Links @kition/kdm, @kition/kit-editor and @kition/kit-engine.\n')
    write('cases/x/case.yaml', 'intent: >-\n  relayed by @kition/sync\n')
    write('golden_docs/a.md', '@kition/kit-editor\n')
    write('target/b.md', '@kition/kit-editor\n')
    write('web/package.json', `${JSON.stringify({ name: 'web', dependencies: { '@kition/kit-editor': '0.1.0' } }, null, 2)}\n`)
    write('web/src/main.tsx', "import { mountEditor } from '@kition/kit-editor'\n")
    write('web/src/i18n/uk.tsv', "# this kit's loader (@kition/kit-editor's loadPhrases)\n")
    write('web/cases/y/case.yaml', 'intent: >-\n  on @kition/kit-editor\nsteps: []\n')
    write('web/README.md', 'Built on @kition/kit-editor.\n')
    write('web/fixtures/note.json', '{ "by": "@kition\\/kdm" }\n')
    write('web/pnpm-lock.yaml', "'@kition/kit-editor': 0.1.0\n")
    fs.writeFileSync(path.join(repo, 'web/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x40, ...Buffer.from('@kition/kit-editor')]))
    const web = path.join(repo, 'web')
    const where = (list) => list.map(({ file, line }) => `${path.relative(repo, file)}:${line}`).sort()
    expect(where(mentionsLeft(web))).toEqual(['AGENTS.md:1', 'cases/x/case.yaml:2', 'docs/development.md:1', 'web/README.md:1', 'web/fixtures/note.json:1'])
    expect(where(mentionsLeft(web, { repo: false }))).toEqual(['web/README.md:1', 'web/fixtures/note.json:1'])
    expect(mentionsLeft(web).find(({ file }) => file.endsWith('development.md')).text).toBe('@kition/kdm -> @kition/sdk/kdm, @kition/kit-editor -> @kition/sdk/editor, @kition/kit-engine -> @kition/sdk/engine (Links @kition/kdm, @kition/kit-editor and @kition/kit-engine.)')
    expect(mentionsLeft(web).find(({ file }) => file.endsWith('note.json')).text).toContain('@kition\\/kdm -> @kition/sdk/kdm')
    const tool = path.join(root, 'tools/migrate-to-sdk.mjs')
    const checked = spawnSync(process.execPath, [tool, web, '--check'], { encoding: 'utf8', cwd: repo })
    expect(checked.status).toBe(1)
    expect(checked.stdout).toContain('4 file(s) would change, 0 place(s) need a person, 5 mention(s) left')
    expect(checked.stdout).toMatch(/\nmentions left \(text files not rewritten; change them by hand where they mean the package\): 5 line\(s\)\n {2}web\/README\.md:1: @kition\/kit-editor -> @kition\/sdk\/editor \(Built on @kition\/kit-editor\.\)\n/)
    expect(checked.stdout).toContain('\n  AGENTS.md:1: @kition/kit-editor -> @kition/sdk/editor (')
    expect(spawnSync(process.execPath, [tool, web, '--check', '--no-repo'], { encoding: 'utf8', cwd: repo }).stdout).toContain('2 mention(s) left')
    const written = spawnSync(process.execPath, [tool, web], { encoding: 'utf8', cwd: repo })
    expect(written.status, written.stderr).toBe(0)
    expect(fs.readFileSync(path.join(web, 'src/i18n/uk.tsv'), 'utf8')).toBe("# this kit's loader (@kition/sdk/editor's loadPhrases)\n")
    expect(fs.readFileSync(path.join(web, 'cases/y/case.yaml'), 'utf8')).toBe('intent: >-\n  on @kition/sdk/editor\nsteps: []\n')
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toContain('@kition/kit-editor')
    expect(fs.readFileSync(path.join(web, 'pnpm-lock.yaml'), 'utf8')).toContain('@kition/kit-editor')
    // Only the mentions are left: --check passes, and still names them.
    const after = spawnSync(process.execPath, [tool, web, '--check'], { encoding: 'utf8', cwd: repo })
    expect(after.status, after.stdout).toBe(0)
    expect(after.stdout).toContain('0 file(s) would change, 0 place(s) need a person, 5 mention(s) left')
    expect(formatReport([], { mentions: [] }).text).toContain('mentions left (text files not rewritten; change them by hand where they mean the package): 0 line(s)')
  })

  it('puts @kition/sdk and @kition/tessera in sorted position and keeps the other keys in their order', () => {
    const { manifest } = migrateManifest({
      dependencies: { zod: '^3', '@vitejs/plugin-react': '^4', '@kition/kit-host': '^0.1.0', 'loro-crdt': '1.16.4', '@kition/kit-editor': '^0.1.0', react: '^19' },
      devDependencies: { vite: '^6', '@kition/kit-dev-host': '^0.1.0' },
    })
    // The new keys go before the first key that sorts after them (here the first); the file's own order stays.
    expect(Object.keys(manifest.dependencies)).toEqual(['@kition/sdk', '@kition/tessera', 'zod', '@vitejs/plugin-react', 'loro-crdt', 'react'])
    expect(Object.keys(manifest.devDependencies)).toEqual(['vite'])
    const sorted = migrateManifest({ dependencies: { '@codemirror/view': '^6', '@kition/kdm': '^0.1.0', '@kition/kit-editor': '^0.1.0', '@tanstack/react-virtual': '^3', react: '^19' } })
    expect(Object.keys(sorted.manifest.dependencies)).toEqual(['@codemirror/view', '@kition/sdk', '@kition/tessera', '@tanstack/react-virtual', 'react'])
  })
})

it(`${SDK} is in the kit naming rules' list of the scope's other packages`, () => {
  // In layout 1 a kit's packages are <scope>/<kit>: no kit may be named sdk.
  expect(fs.readFileSync(path.join(root, 'tools/kit-npm.mjs'), 'utf8')).toMatch(/NOT_KIT_NAMES = \[[^\]]*'sdk'/)
})
