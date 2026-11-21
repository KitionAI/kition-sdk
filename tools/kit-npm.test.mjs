// The kit packages' npm contract (tools/kit-npm.mjs) and the Package workflow's tool that writes,
// packs and checks them (tools/kit-npm-package.mjs), on local files and a fake registry.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_REGISTRIES, LEGACY_LAYOUT_SCOPES, indexPackage, integrityOf, kitionField, npmScope, packageManifest, packageName, parseNpmrc, registries, tarballPath, viewExtensions } from './kit-npm.mjs'
import { headlessReadme, missing, pack, state, uiReadme, writeHeadless, writeUi } from './kit-npm-package.mjs'

const scratch = []
const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-npm-')))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const kitJson = {
  id: 'kit.note',
  name: 'Note',
  version: '0.1.3',
  license: 'Apache-2.0',
  formats: [
    { id: 'md', extensions: ['.MD', 'markdown'], role: 'edit' },
    { id: 'text', extensions: ['txt', 'md'], role: 'view' },
  ],
  headless: { executable: 'kition-note', protocol: 'kition-kit/1' },
}

describe('the kit packages’ names and kition field', () => {
  it('names a kit’s packages by platform and its editor, with npm’s tarball path', () => {
    expect(packageName('note', 'linux-x64')).toBe('@kition/kit-note-linux-x64')
    expect(packageName('note', 'ui')).toBe('@kition/kit-note-ui')
    expect(() => packageName('note', 'freebsd-x64')).toThrow(/no platform/)
    expect(() => packageName('Note', 'ui')).toThrow(/not a kit name/)
    expect(tarballPath('@kition/kit-note-ui', '0.1.3')).toBe('@kition/kit-note-ui/-/kit-note-ui-0.1.3.tgz')
    expect(integrityOf(Buffer.from('kition'))).toBe('sha512-NH9AZJ/IRc/KrFvhVQk6Ekg1t67rcnKAvcDdYHrHt0B6uYe/ar1bRpjOM3pG7/cDKIbJnoP6OiP77h92OaGx7g==')
  })

  it('says in the kition field what the index needs: kit, id, name, role, platform, protocol, extensions, views, commits', () => {
    expect(viewExtensions(kitJson)).toEqual(['txt'])
    const commit = 'a'.repeat(40)
    expect(kitionField(kitJson, 'headless', { platform: 'darwin-arm64', build: { commit, sdkCommit: 'not a commit' } })).toEqual({
      kit: 'note',
      id: 'kit.note',
      name: 'Note',
      version: '0.1.3',
      role: 'headless',
      platform: 'darwin-arm64',
      protocol: 'kition-kit/1',
      extensions: ['md', 'markdown'],
      views: ['txt'],
      build: { commit },
    })
    expect(kitionField(kitJson, 'ui')).not.toHaveProperty('platform')
    expect(() => kitionField({ ...kitJson, headless: {} }, 'ui')).toThrow(/names no protocol/)
    expect(() => kitionField({ ...kitJson, formats: [] }, 'ui')).toThrow(/edits no file type/)
    expect(() => kitionField(kitJson, 'headless', { platform: 'beos-x86' })).toThrow(/no platform/)
  })

  it('introduces the kit on npm: its description, GitHub repository, homepage, bugs and keywords from repositories.json', () => {
    const ui = packageManifest(kitJson, 'ui', { files: [] })
    expect(ui).toMatchObject({
      description: 'Kition Note: a Markdown editor that never rewrites your file, for people and AI agents',
      repository: { type: 'git', url: 'git+https://github.com/KitionAI/kition-note.git' },
      homepage: 'https://github.com/KitionAI/kition-note',
      bugs: { url: 'https://github.com/KitionAI/kition-note/issues' },
    })
    expect(ui.keywords).toEqual(['kition', 'kit', 'khp', 'note', 'editor', 'webassembly', 'ai-agents'])
    const headless = packageManifest(kitJson, 'headless', { platform: 'linux-x64', files: [], repository: 'someone/kition-note' })
    expect(headless.description).toBe('Kition Note: a Markdown editor that never rewrites your file, for people and AI agents (linux-x64 executable)')
    expect(headless.repository.url).toBe('git+https://github.com/someone/kition-note.git')
    expect(headless.keywords).toEqual(['kition', 'kit', 'khp', 'note', 'headless', 'mcp', 'ai-agents'])
    expect(JSON.stringify([ui, headless])).not.toMatch(/by hand/)
    // The kition field is what the index reads: unchanged by the rest.
    expect(ui.kition).toEqual(kitionField(kitJson, 'ui'))
    const unknown = { ...kitJson, id: 'kit.quill', name: 'Quill', headless: { ...kitJson.headless, executable: 'kition-quill' } }
    expect(() => packageManifest(unknown, 'ui', { files: [] })).toThrow('"quill" is not a kit of templates/community/repositories.json (no kit entry kition-quill)')
    expect(() => packageManifest(kitJson, 'ui', { files: [], repository: 'not a repository' })).toThrow(/is not owner\/name/)
  })

  it('installs a headless package only on its platform (npm os, cpu, and glibc on Linux)', () => {
    expect(packageManifest(kitJson, 'headless', { platform: 'linux-arm64', files: [] })).toMatchObject({ name: '@kition/kit-note-linux-arm64', version: '0.1.3', os: ['linux'], cpu: ['arm64'], libc: ['glibc'], license: 'Apache-2.0' })
    expect(packageManifest(kitJson, 'headless', { platform: 'win32-x64', files: [] })).not.toHaveProperty('libc')
    expect(packageManifest(kitJson, 'ui', { files: [] })).not.toHaveProperty('os')
  })
})

describe('the npm scope (KITION_NPM_SCOPE) and its layout', () => {
  it('is @kition with the legacy names when the variable is unset or empty', () => {
    expect(LEGACY_LAYOUT_SCOPES).toEqual(['@kition'])
    for (const env of [{}, { KITION_NPM_SCOPE: '' }]) {
      const scope = npmScope(env)
      expect(scope).toBe('@kition')
      expect(packageName('note', 'ui', scope)).toBe('@kition/kit-note-ui')
      expect(packageName('note', 'darwin-arm64', scope)).toBe('@kition/kit-note-darwin-arm64')
      expect(indexPackage(scope)).toBe('@kition/kits-index')
    }
    // The legacy names never collide with the scope's other packages, so no kit name is refused there.
    expect(packageName('cli', 'ui', '@kition')).toBe('@kition/kit-cli-ui')
  })

  it('names another scope’s packages by layout 1: <scope>/<kit>, <scope>/<kit>-<platform>, <scope>/kits', () => {
    const scope = npmScope({ KITION_NPM_SCOPE: '@kitionstage' })
    expect(scope).toBe('@kitionstage')
    expect(packageName('note', 'ui', scope)).toBe('@kitionstage/note')
    expect(packageName('note', 'linux-x64', scope)).toBe('@kitionstage/note-linux-x64')
    expect(indexPackage(scope)).toBe('@kitionstage/kits')
    expect(tarballPath('@kitionstage/note', '0.1.3')).toBe('@kitionstage/note/-/note-0.1.3.tgz')
    expect(packageManifest(kitJson, 'headless', { platform: 'linux-arm64', files: [], scope }).name).toBe('@kitionstage/note-linux-arm64')
    expect(packageManifest(kitJson, 'ui', { files: [], scope }).name).toBe('@kitionstage/note')
    // A kit named like another package of the scope would be that package: no such kit.
    for (const other of ['cli', 'sdk', 'kits', 'tessera', 'kit', 'embed']) {
      expect(() => packageName(other, 'ui', scope)).toThrow(`${other} is not a kit name in @kitionstage`)
      expect(() => packageName(other, 'darwin-arm64', scope)).toThrow(/is not a kit name in @kitionstage/)
    }
  })

  it('refuses a scope that is not @ and lowercase letters, digits and dashes', () => {
    for (const bad of ['kition', '@Kition', '@-x', '@', '@kition/x', '@kit ion', ' @kition']) {
      expect(() => npmScope({ KITION_NPM_SCOPE: bad })).toThrow(/KITION_NPM_SCOPE is .*, not an npm scope/)
      expect(() => packageName('note', 'ui', bad)).toThrow(/not an npm scope/)
      expect(() => indexPackage(bad)).toThrow(/not an npm scope/)
    }
  })

  it('reads npm’s registry setting of the scope', () => {
    const npmrc = '@kition:registry=https://kition.example/\n@kitionstage:registry=https://stage.example/\n'
    expect(registries({}, npmrc)[0]).toBe('https://kition.example/')
    expect(registries({ KITION_NPM_SCOPE: '@kitionstage' }, npmrc)[0]).toBe('https://stage.example/')
  })
})

describe('the registries kition tries', () => {
  it('goes from KITION_NPM_REGISTRY through npm’s own setting to npmjs and npmmirror, each once', () => {
    expect(registries({}, '')).toEqual(DEFAULT_REGISTRIES)
    expect(registries({ KITION_NPM_REGISTRY: 'http://127.0.0.1:4873, https://a.example/npm' }, '')).toEqual(['http://127.0.0.1:4873/', 'https://a.example/npm/', ...DEFAULT_REGISTRIES])
    const npmrc = '# mine\nregistry = "https://file.example"\n@kition:registry=${MIRROR}/scoped\n; not this\n//registry.npmjs.org/:_authToken=secret\n'
    expect(parseNpmrc(npmrc, { MIRROR: 'https://m.example' })).toEqual({ registry: 'https://file.example', '@kition:registry': 'https://m.example/scoped', '//registry.npmjs.org/:_authToken': 'secret' })
    expect(registries({ MIRROR: 'https://m.example', npm_config_registry: 'https://env.example' }, npmrc)).toEqual(['https://m.example/scoped/', 'https://env.example/', ...DEFAULT_REGISTRIES])
    expect(registries({}, npmrc)).toEqual(['https://file.example/', ...DEFAULT_REGISTRIES])
    expect(registries({ npm_config_registry: 'https://registry.npmmirror.com' }, '')).toEqual(['https://registry.npmmirror.com/', 'https://registry.npmjs.org/'])
  })
})

describe('kit-npm-package: the Package workflow’s packages', () => {
  const headlessBuild = (dir) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'kit.json'), `${JSON.stringify(kitJson, null, 2)}\n`)
    fs.writeFileSync(path.join(dir, 'kition-note'), '#!/bin/sh\necho note\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'handshakes.json'), '{}')
    return dir
  }
  const uiBuild = (dir) => {
    const ui = path.join(dir, 'note-ui')
    fs.mkdirSync(path.join(ui, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html>')
    fs.writeFileSync(path.join(ui, 'kit.json'), JSON.stringify(kitJson))
    fs.writeFileSync(path.join(ui, 'engine', 'note_bg.wasm'), Buffer.from([0, 97, 115, 109]))
    fs.writeFileSync(path.join(ui, '.kition-package.json'), '{"local":true}')
    return ui
  }
  const listed = (tgz) => execFileSync('tar', ['-tzf', path.basename(tgz)], { cwd: path.dirname(tgz), encoding: 'utf8' }).trim().split('\n').filter((name) => !name.endsWith('/')).sort()

  it('packs a platform’s kit: package.json, kit.json and the executable under package/, nothing else, the executable runnable', () => {
    const dir = tempDir()
    const folder = writeHeadless({ dir: headlessBuild(path.join(dir, 'build')), platform: 'darwin-arm64', out: path.join(dir, 'folders'), commit: 'b'.repeat(40), repository: 'KitionAI/kition-note' })
    const packed = pack({ folder, out: path.join(dir, 'packed') })
    expect(packed).toMatchObject({ name: '@kition/kit-note-darwin-arm64', version: '0.1.3' })
    expect(packed.integrity).toBe(integrityOf(fs.readFileSync(packed.file)))
    expect(listed(packed.file)).toEqual(['package/README.md', 'package/kit.json', 'package/kition-note', 'package/package.json'])
    const mode = execFileSync('tar', ['-tvzf', path.basename(packed.file), 'package/kition-note'], { cwd: path.dirname(packed.file), encoding: 'utf8' })
    expect(mode).toMatch(/^-rwx/)
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
    expect(manifest.kition).toMatchObject({ role: 'headless', platform: 'darwin-arm64', build: { commit: 'b'.repeat(40) } })
    expect(manifest.repository.url).toBe('git+https://github.com/KitionAI/kition-note.git')
  })

  it('packs the editor from its folder or its package archive alike, without the local build stamp', () => {
    const dir = tempDir()
    const ui = uiBuild(path.join(dir, 'src'))
    execFileSync('tar', ['-czf', 'kition-note-0.1.3.tgz', 'note-ui'], { cwd: path.join(dir, 'src') })
    const fromFolder = pack({ folder: writeUi({ from: ui, out: path.join(dir, 'a') }), out: path.join(dir, 'packed-a') })
    const fromArchive = pack({ folder: writeUi({ from: path.join(dir, 'src', 'kition-note-0.1.3.tgz'), out: path.join(dir, 'b') }), out: path.join(dir, 'packed-b') })
    expect(listed(fromFolder.file)).toEqual(['package/note-ui/engine/note_bg.wasm', 'package/note-ui/index.html', 'package/note-ui/kit.json', 'package/package.json'])
    expect(fromArchive.integrity).toBe(fromFolder.integrity)
    expect(() => writeUi({ from: path.join(dir, 'src'), out: path.join(dir, 'c') })).toThrow(/is note-ui, not src|has no index.html|ENOENT/)
  })

  it('writes each package’s README for npm, with absolute links, in both layouts', () => {
    for (const [scope, editor] of [['@kition', '@kition/kit-note-ui'], ['@kitionstage', '@kitionstage/note']]) {
      const dir = tempDir()
      const folder = writeHeadless({ dir: headlessBuild(path.join(dir, 'build')), platform: 'linux-arm64', out: path.join(dir, 'folders'), scope })
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
      expect(manifest.files).toEqual(['README.md', 'kit.json', 'kition-note'])
      expect(manifest).not.toHaveProperty('readme')
      const readme = fs.readFileSync(path.join(folder, 'README.md'), 'utf8')
      expect(readme).toBe(headlessReadme(kitJson, { platform: 'linux-arm64', scope }))
      expect(readme.startsWith('# Kition Note for linux-arm64\n\nThe headless executable of Kition Note for linux-arm64')).toBe(true)
      expect(readme).toContain('it is not meant to be installed by hand')
      expect(readme).toContain('Kition Note: a Markdown editor that never rewrites your file, for people and AI agents.')
      expect(readme).toContain(`GitHub: https://github.com/KitionAI/kition-note · The editor: [\`${editor}\`](https://www.npmjs.com/package/${editor})`)
      expect(readme).toContain('Part of Kition: https://github.com/KitionAI')
      expect(readme).not.toContain('## The Kition family')

      // The editor package's top holds only <kit>-ui/ (kition and Kition take it so): its README is package.json's readme.
      const ui = writeUi({ from: uiBuild(path.join(dir, 'src')), out: path.join(dir, 'ui'), scope })
      expect(fs.readdirSync(ui).sort()).toEqual(['note-ui', 'package.json'])
      const uiManifest = JSON.parse(fs.readFileSync(path.join(ui, 'package.json'), 'utf8'))
      expect(uiManifest.files).toEqual(['note-ui'])
      expect(uiManifest.readme).toBe(uiReadme(kitJson))
      expect(Object.keys(uiManifest).at(-1)).toBe('kition')
      const text = uiManifest.readme
      expect(text.startsWith('# Kition Note\n\nKition Note: a Markdown editor that never rewrites your file, for people and AI agents.\n\n[GitHub](https://github.com/KitionAI/kition-note) · [Showcase](https://github.com/KitionAI/kition-showcase/tree/main/note) · [Developer docs](https://developer.kition.ai)\n')).toBe(true)
      expect(text).toContain('kit `kit.note` version 0.1.3.')
      expect(text).toContain('`kition kit install note`')
      expect(text).toContain("KitionEmbed.mount(element, { kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }")
      expect(text).toContain('| Opens | Creates | Exports |\n| --- | --- | --- |\n| `.MD`, `.markdown`, `.txt`, `.md` | — | — |')
      expect(text).toContain('## The Kition family')
      expect(text).toContain('| Office | **Note** · [Table](https://github.com/KitionAI/kition-table)')
      expect(text.endsWith('## License\n\nApache-2.0 ([LICENSE](https://github.com/KitionAI/kition-note/blob/main/LICENSE)).\n')).toBe(true)
      for (const body of [readme, text]) {
        for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g)) expect(target).toMatch(/^https:\/\//)
      }
      // No version in the prose but the editor package's own version line.
      expect(readme).not.toMatch(/\d+\.\d+\.\d+/)
      expect(text.match(/\d+\.\d+\.\d+/g)).toEqual(['0.1.3'])
    }
  })

  it('refuses a pack whose archive is not the folder’s files', () => {
    const dir = tempDir()
    const folder = writeHeadless({ dir: headlessBuild(path.join(dir, 'build')), platform: 'linux-x64', out: path.join(dir, 'folders') })
    // npm leaves out a file named .npmrc whatever `files` says: the check sees it is missing.
    fs.writeFileSync(path.join(folder, '.npmrc'), 'x=1')
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ ...manifest, files: [...manifest.files, '.npmrc'] }))
    expect(() => pack({ folder, out: path.join(dir, 'packed') })).toThrow(/lacks package\/\.npmrc/)
  })

  it('publishes a version once: publish when the registry lacks it, published for the same bytes, refused for other bytes', async () => {
    const dir = tempDir()
    const packed = pack({ folder: writeHeadless({ dir: headlessBuild(path.join(dir, 'build')), platform: 'darwin-arm64', out: path.join(dir, 'folders') }), out: path.join(dir, 'packed') })
    const registry = 'http://registry.test/'
    const answer = (integrity) => async (url) => {
      expect(url).toBe(`${registry}@kition%2fkit-note-darwin-arm64/0.1.3`)
      return integrity ? new Response(JSON.stringify({ version: '0.1.3', dist: { integrity } }), { status: 200 }) : new Response('{}', { status: 404 })
    }
    expect(await state({ tarball: packed.file, registry }, answer(null))).toBe('publish')
    expect(await state({ tarball: packed.file, registry }, answer(packed.integrity))).toBe('published')
    await expect(state({ tarball: packed.file, registry }, answer(integrityOf(Buffer.from('other'))))).rejects.toThrow(/A version is published once/)
    const have = new Set(['@kition%2fkit-note-darwin-arm64', '@kition%2fkit-note-ui'])
    const lacks = await missing({ kit: 'note', version: '0.1.3', registry }, async (url) => {
      const name = url.slice(registry.length).split('/')[0]
      return have.has(name) ? new Response(JSON.stringify({ version: '0.1.3' }), { status: 200 }) : new Response('{}', { status: 404 })
    })
    expect(lacks).toEqual({ platforms: ['darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'], ui: false })
  })
  it('writes and finds another scope’s packages by layout 1 (--scope, else KITION_NPM_SCOPE), and refuses a malformed scope', async () => {
    const dir = tempDir()
    const build = headlessBuild(path.join(dir, 'build'))
    const folder = writeHeadless({ dir: build, platform: 'darwin-arm64', out: path.join(dir, 'folders'), scope: '@kitionstage' })
    expect(path.basename(folder)).toBe('note-darwin-arm64')
    expect(pack({ folder, out: path.join(dir, 'packed') })).toMatchObject({ name: '@kitionstage/note-darwin-arm64', version: '0.1.3' })
    expect(path.basename(writeUi({ from: uiBuild(path.join(dir, 'src')), out: path.join(dir, 'ui'), scope: '@kitionstage' }))).toBe('note')
    const registry = 'http://registry.test/'
    const asked = []
    const lacks = await missing({ kit: 'note', version: '0.1.3', registry, scope: '@kitionstage' }, async (url) => {
      asked.push(url.slice(registry.length).split('/')[0])
      return new Response('{}', { status: 404 })
    })
    expect(lacks.ui).toBe(true)
    expect(asked).toEqual(['@kitionstage%2fnote-darwin-arm64', '@kitionstage%2fnote-darwin-x64', '@kitionstage%2fnote-linux-arm64', '@kitionstage%2fnote-linux-x64', '@kitionstage%2fnote-win32-x64', '@kitionstage%2fnote'])
    const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kit-npm-package.mjs')
    const run = (args, env = {}) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', env: { ...process.env, KITION_NPM_SCOPE: '', ...env } })
    const headless = ['headless', '--dir', build, '--platform', 'linux-x64', '--out', path.join(dir, 'cli')]
    expect(run(headless).stdout.trim()).toBe(path.join(dir, 'cli', 'kit-note-linux-x64'))
    expect(run(headless, { KITION_NPM_SCOPE: '@kitionstage' }).stdout.trim()).toBe(path.join(dir, 'cli', 'note-linux-x64'))
    expect(run([...headless, '--scope', '@kitionstage']).stdout.trim()).toBe(path.join(dir, 'cli', 'note-linux-x64'))
    const malformed = run(headless, { KITION_NPM_SCOPE: 'kitionstage' })
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('KITION_NPM_SCOPE is "kitionstage", not an npm scope')
    expect(run([...headless, '--scope', '@Stage']).stderr).toContain('--scope is "@Stage", not an npm scope')
  })
})
