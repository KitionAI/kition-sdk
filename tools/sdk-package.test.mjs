// @kition/sdk: the mapping from the twelve library packages to its subpaths (tools/sdk-package.mjs),
// its package.json, and the codemod that moves a consumer to it (tools/migrate-to-sdk.mjs).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCKFILES, migrateFolder, migrateManifest, migrateText } from './migrate-to-sdk.mjs'
import { BINS, OLD_TESSERA, PARTS, SDK, TESSERA, manifestOf, sdkBin, sdkExports, sdkSideEffects, sdkSpecifier, subpaths, tesseraImport, tesseraSpecifier } from './sdk-package.mjs'

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
      expect(list.filter((entry) => entry.part === part).map(({ from }) => from)).toEqual(keys.map((key) => `${part.name}${key === '.' ? '' : key.slice(1)}`))
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
})

describe('migrate-to-sdk: a consumer moved to @kition/sdk', () => {
  it('rewrites imports, exports, dynamic imports, requires, test mocks and CSS imports; lists an old name used otherwise; leaves other names alone', () => {
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
      'export default { resolve: { dedupe: [`@kition/kit-engine`, "@kition/kit-host"] } }',
      "import { Button } from '@kition/tessera-ui'",
      "import kit from '@kition/kit-note-ui/note-ui/kit.json'",
      "const cli = '@kition/cli'",
      "// see @kition/embed's README",
    ])
    expect(changes).toHaveLength(8)
    expect(notes).toEqual([
      'line 9: @kition/kit-engine is named here as something other than an import (export default { resolve: { dedupe: [`@kition/kit-engine`, "@kition/kit-host"] } }); change it by hand (the package is @kition/sdk, its subpath @kition/sdk/engine)',
      'line 9: @kition/kit-host is named here as something other than an import (export default { resolve: { dedupe: [`@kition/kit-engine`, "@kition/kit-host"] } }); change it by hand (the package is @kition/sdk, its subpath @kition/sdk/host)',
    ])
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
    expect(notes).toEqual(['pnpm.overrides: @kition/kit-editor -> "link:../../kition-sdk/packages/kit-editor" names @kition/kit-editor; point it at @kition/sdk by hand'])
    expect(changes.length).toBeGreaterThan(4)
    // A project that still has Tessera's old packages keeps them, with a note naming kition-tessera's
    // codemod (which moves them, and their link: paths, to @kition/tessera); --sdk-spec names another range.
    const old = migrateManifest({ dependencies: { '@kition/kit-editor': '^0.5.2', '@kition/tessera-ui': 'link:../ui' }, devDependencies: { '@kition/tessera-icons': '^0.1.0' } }, { sdkSpec: 'workspace:*' })
    expect(old.manifest.dependencies).toEqual({ '@kition/sdk': 'workspace:*', '@kition/tessera-ui': 'link:../ui' })
    expect(old.manifest.devDependencies).toEqual({ '@kition/tessera-icons': '^0.1.0' })
    expect(old.notes).toEqual(["@kition/tessera-ui, @kition/tessera-icons: Tessera is one package now, @kition/tessera, which @kition/sdk/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs <folder> (its package.json and its imports)"])
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
    expect(moved.notes).toEqual([expect.stringContaining("@kition/tessera-icons: Tessera is one package now, @kition/tessera, which @kition/sdk/editor imports; move this project to it with kition-tessera's scripts/migrate-to-tessera.mjs")])
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
    expect(ran.stdout).toContain('by hand: @kition/tessera-icons: Tessera is one package now')
    for (const bad of [[dir, '--sdk-spec'], [dir, '--tessera-spec', '--check'], [dir, '--version', '^1.0.0']]) expect(spawnSync(process.execPath, [tool, ...bad], { encoding: 'utf8' }).status, bad.join(' ')).toBe(2)
  })

  it('migrates a folder, never a lockfile, node_modules or build output; --check lists and exits 1', () => {
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
    expect(checked.stdout).toContain('3 file(s) would change, 1 place(s) to change by hand')
    expect(checked.stdout).toContain('by hand: a package manager hook naming @kition/embed: point it at @kition/sdk by hand')
    expect(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8')).toBe("import { KitionEmbed } from '@kition/embed'\n")
    const report = migrateFolder(dir)
    expect(report.map(({ file }) => path.relative(dir, file)).sort()).toEqual(['.pnpmfile.cjs', 'package.json', 'src/app.css', 'src/main.ts'])
    expect(fs.readFileSync(path.join(dir, 'src/main.ts'), 'utf8')).toBe("import { KitionEmbed } from '@kition/sdk/embed'\n")
    expect(fs.readFileSync(path.join(dir, 'src/app.css'), 'utf8')).toBe("@import '@kition/sdk/editor/styles.css';\n")
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies).toEqual({ '@kition/sdk': `^${sdk.version}` })
    for (const [file, text] of Object.entries(before)) expect(fs.readFileSync(path.join(dir, file), 'utf8'), file).toBe(text)
    const again = spawnSync(process.execPath, [tool, dir, '--check'], { encoding: 'utf8' })
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('0 file(s) would change, 1 place(s) to change by hand')
  })
})

it(`${SDK} is in the kit naming rules' list of the scope's other packages`, () => {
  // In layout 1 a kit's packages are <scope>/<kit>: no kit may be named sdk.
  expect(fs.readFileSync(path.join(root, 'tools/kit-npm.mjs'), 'utf8')).toMatch(/NOT_KIT_NAMES = \[[^\]]*'sdk'/)
})
