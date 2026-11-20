// The kition-kits DeepSeek Harness plugin (plugins/deepseek-harness/kition-kits, @kition/dsh-kits):
// its bundle manifest, its patch, its browser module (built, and the extensions it claims), its
// skills and its launcher. Its host module is tested in tools/dsh-plugin-host.test.mjs, its
// generated kit skills against their guides in tools/agent-plugin.test.mjs; a real DeepSeek Harness
// runs it in the plugin's test/e2e.sh (headless) and test/web.e2e.ts and test/desktop.e2e.ts.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

import { PUBLISHED_KITS } from './published-kits.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const plugin = path.join(root, 'plugins/deepseek-harness/kition-kits')
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'))
const sdk = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8'))

// A patch's `!!js` values, kept as their source.
const js = { tag: 'tag:yaml.org,2002:js', resolve: (source) => ({ js: source }) }
const patch = (file) => YAML.parse(fs.readFileSync(path.join(plugin, file), 'utf8'), { customTags: [js] })
const frontmatter = (text) => Object.fromEntries([...text.split('---')[1].matchAll(/^([a-z-]+): (.*)$/gm)].map(([, key, value]) => [key, value]))

describe('the kition that comes with the plugin', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const platforms = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))

  it('is @kition/cli at exactly the SDK version, the version the release stamps on packages/kition, and the plugin depends on nothing else', () => {
    expect(manifest.dependencies).toEqual({ '@kition/cli': sdk.version })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/package.json'), 'utf8')).version).toBe(sdk.version)
  })

  it('is published before the plugin, which the release installs from its archives first', () => {
    const at = (text) => {
      const found = release.indexOf(text)
      expect(found, text).toBeGreaterThan(-1)
      return found
    }
    // Platform packages, then @kition/cli, then the plugin that depends on it.
    expect(at('for archive in target/kition/packed/*.tgz; do publish "$archive"; done')).toBeLessThan(at('publish target/npm-pack/kition.tgz\n'))
    expect(at('publish target/npm-pack/kition.tgz\n')).toBeLessThan(at('publish target/npm-pack/dsh-kits.tgz'))
    // The check runs on the linked @kition/cli, before anything is published.
    const check = at('node tools/check-dsh-plugin-package.mjs --plugin target/npm-pack/dsh-kits.tgz --launcher target/npm-pack/kition.tgz --platforms target/kition/packed')
    expect(at('platform-package.mjs link --launcher target/npm-pack/kition.tgz')).toBeLessThan(check)
    expect(check).toBeLessThan(at('- name: Publish on npm in dependency order'))
  })

  it('is built for the platforms of the release matrix, which the README names', () => {
    const matrix = [...release.matchAll(/- \{ platform: ([a-z0-9-]+),/g)].map(([, platform]) => platform)
    expect(matrix.sort()).toEqual([...platforms].sort())
    // The README's paragraph that starts so, to its blank line.
    const readme = fs.readFileSync(path.join(plugin, 'README.md'), 'utf8')
    const start = readme.indexOf('\nThe plugin has a kition for')
    expect(start, 'README: "The plugin has a kition for ..."').toBeGreaterThan(-1)
    const line = readme.slice(start + 1, readme.indexOf('\n\n', start + 1))
    expect([...line.matchAll(/`([a-z0-9]+-[a-z0-9]+)`/g)].map(([, key]) => key).sort()).toEqual([...platforms].sort())
  })
})

describe('the release’s check of the packed plugin (tools/check-dsh-plugin-package.mjs)', async () => {
  const { checkInstall, checkManifests } = await import('./check-dsh-plugin-package.mjs')
  const version = sdk.version
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kits-package-')))
  const pack = (folder) => path.join(dir, JSON.parse(execFileSync('npm', ['pack', folder, '--pack-destination', dir, '--json'], { encoding: 'utf8' }))[0].filename)
  // Every platform package, this platform's with a stand-in kition that has the gateway command.
  for (const key of keys) {
    const exe = path.join(dir, 'exe', key, key.startsWith('win32') ? 'kition.exe' : 'kition')
    fs.mkdirSync(path.dirname(exe), { recursive: true })
    fs.writeFileSync(exe, `#!/bin/sh\nif [ "$1" = --version ]; then echo "kition ${version} (stand-in)"; exit 0; fi\nif [ "$1 $2" = "gateway --help" ]; then echo "usage: kition gateway"; exit 0; fi\nexit 2\n`, { mode: 0o755 })
    execFileSync(process.execPath, [path.join(root, 'packages/kition/scripts/platform-package.mjs'), 'platform', '--platform', key, '--kition', exe, '--out', path.join(dir, 'platforms')])
    pack(path.join(dir, 'platforms', key))
  }
  // @kition/cli, linked to them by version as the release links it.
  const cli = path.join(dir, 'cli')
  fs.mkdirSync(cli)
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@kition/cli', version, files: [] }))
  const launcher = pack(cli)
  execFileSync(process.execPath, [path.join(root, 'packages/kition/scripts/platform-package.mjs'), 'link', '--launcher', launcher, '--out', dir])
  const archives = { plugin: pack(plugin), launcher, platforms: dir }

  it('passes the plugin as packed, and installs it by name with this platform’s kition', async () => {
    expect(checkManifests(archives)).toBe(version)
    expect(await checkInstall(archives, version)).toMatch(new RegExp(`node_modules/@kition/cli-${process.platform}-${process.arch}/bin/kition$`))
  }, 120_000)

  // The registry leak (regressions/issue-dsh-registry-leak): `npm run`, `npm exec` and `npx` give
  // their children npm_config_userconfig, the person's own ~/.npmrc; a package manager reads it
  // instead of the test's, the @kition scope falls through to the registry it names (npm's, whose
  // @kition/cli-<platform> of the same version has no gateway), and that kition is installed.
  it('installs from the local registry only, whatever npm and pnpm settings the runner carries (registry leak)', async () => {
    const { assertServed, hermeticInstallEnv, startRegistry } = await import('../plugins/deepseek-harness/kition-kits/test/registry.mjs')
    const key = `${process.platform}-${process.arch}`
    const leak = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kits-leak-')))
    // "Public": @kition/cli and this platform's package of the same version, a kition without the gateway.
    const stale = path.join(leak, 'stale', 'kition')
    fs.mkdirSync(path.dirname(stale))
    fs.writeFileSync(stale, `#!/bin/sh\nif [ "$1" = --version ]; then echo "kition ${version} (published)"; exit 0; fi\necho "kition: unknown command $1" >&2\nexit 2\n`, { mode: 0o755 })
    const publicFolder = path.join(leak, 'public')
    fs.mkdirSync(publicFolder)
    execFileSync(process.execPath, [path.join(root, 'packages/kition/scripts/platform-package.mjs'), 'platform', '--platform', key, '--kition', stale, '--out', path.join(leak, 'stale-platform')])
    execFileSync('npm', ['pack', path.join(leak, 'stale-platform', key), '--pack-destination', publicFolder])
    fs.copyFileSync(archives.launcher, path.join(publicFolder, path.basename(archives.launcher)))
    const localFolder = path.join(leak, 'local')
    fs.mkdirSync(localFolder)
    for (const file of fs.readdirSync(dir).filter((name) => name.startsWith('kition-cli-') && name.endsWith('.tgz'))) fs.copyFileSync(path.join(dir, file), path.join(localFolder, file))
    const publicRegistry = await startRegistry(publicFolder)
    const local = await startRegistry(localFolder)
    try {
      // The runner's settings, as `npx playwright test` leaves them: a userconfig naming the "public" registry.
      const userconfig = path.join(leak, 'person.npmrc')
      fs.writeFileSync(userconfig, `registry=${publicRegistry.url}\n`)
      const runner = { ...process.env, npm_config_userconfig: userconfig, npm_config_registry: publicRegistry.url, pnpm_config_registry: publicRegistry.url }
      // The registries are on loopback: no proxy stands between (the tests always dropped them).
      for (const key of Object.keys(runner)) if (/_proxy$/i.test(key)) delete runner[key]
      // As DeepSeek Harness installs a plugin (pnpm, node-linker hoisted). Not spawnSync: the
      // registries answer from this process, whose event loop must go on.
      const install = async (base, env) => {
        const project = path.join(base, 'profile')
        fs.mkdirSync(project, { recursive: true })
        fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n')
        await new Promise((resolve, reject) => {
          const child = spawn('pnpm', ['add', archives.plugin, '--config.node-linker=hoisted'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
          let output = ''
          child.stdout.on('data', (chunk) => (output += chunk))
          child.stderr.on('data', (chunk) => (output += chunk))
          child.on('error', reject)
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pnpm add exited with status ${code}: ${output}`))))
        })
        return path.join(project, 'node_modules', `@kition/cli-${key}`, 'bin', 'kition')
      }
      // What the tests did: the runner's environment with a HOME whose .npmrc names the local registry.
      const before = path.join(leak, 'before')
      fs.mkdirSync(path.join(before, 'home'), { recursive: true })
      fs.writeFileSync(path.join(before, 'home/.npmrc'), `@kition:registry=${local.url}\n`)
      const leaked = await install(before, { ...runner, HOME: path.join(before, 'home'), PNPM_HOME: path.join(before, 'pnpm'), npm_config_cache: path.join(before, 'npm-cache') })
      expect(fs.readFileSync(leaked, 'utf8'), 'the leak: the stale kition came from the "public" registry').toContain('(published)')
      // Now: the local registry only, every package it was asked for served by it, the packed kition itself.
      const now = path.join(leak, 'now')
      const served = local.requests.length
      const own = await install(now, hermeticInstallEnv(now, local.url, runner))
      expect(assertServed(local.requests.slice(served), ['@kition/cli', `@kition/cli-${key}`])).toHaveLength(2)
      expect(fs.readFileSync(own).equals(fs.readFileSync(path.join(dir, 'exe', key, 'kition'))), 'the kition installed is the one packed').toBe(true)
      expect(execFileSync(own, ['gateway', '--help'], { encoding: 'utf8' })).toContain('kition gateway')
      expect(() => assertServed([], ['@kition/cli'])).toThrow(/did not serve @kition\/cli: the install took them from elsewhere/)
    } finally {
      await publicRegistry.stop()
      await local.stop()
      fs.rmSync(leak, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses a plugin whose @kition/cli is a range or another version', () => {
    const drifted = path.join(dir, 'drifted')
    fs.cpSync(plugin, drifted, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules`) })
    for (const spec of [`^${version}`, '0.0.1']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(drifted, 'package.json'), 'utf8'))
      fs.writeFileSync(path.join(drifted, 'package.json'), JSON.stringify({ ...manifest, dependencies: { '@kition/cli': spec } }))
      expect(() => checkManifests({ ...archives, plugin: pack(drifted) }), spec).toThrow(/depends on @kition\/cli at exactly its own version/)
    }
  }, 120_000)
})

describe('the bundle manifest', () => {
  it('is a public package at the SDK version that DeepSeek Harness installs as a bundle', () => {
    expect(manifest.name).toBe('@kition/dsh-kits')
    expect(manifest.private).toBeUndefined()
    expect(manifest.version).toBe(sdk.version)
    expect(manifest.license).toBe('Apache-2.0')
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.repository.directory).toBe('plugins/deepseek-harness/kition-kits')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('has a host module as its main export and a browser module DeepSeek Harness loads for the web UI', () => {
    expect(manifest.main).toBe('./lib/host.mjs')
    expect(manifest.exports['.']).toBe('./lib/host.mjs')
    expect(manifest.exports['./client']).toBe('./lib/client.js')
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(manifest.dsh.client).toEqual({ platform: 'web' })
    expect(fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8')).toMatch(/^window\.__ModuleLoader__\.load\(\{\n  id: "@kition\/dsh-kits",/m)
  })

  it('admits the pinned DeepSeek Harness release, the oldest one tested (Desktop’s), and no 0.3.0 prerelease', () => {
    expect(manifest.dsh.target).toBe('0.2.2-rc.5')
    expect(manifest.dsh.commit).toMatch(/^[0-9a-f]{8,40}$/)
    expect(manifest.dsh.tested).toEqual(['0.2.2-rc.5', '0.2.2-rc.2'])
    // DeepSeek Harness compares with prereleases included: `<0.3.0` would admit 0.3.0-rc.1.
    expect(manifest.engines.dsh).toBe(`>=${manifest.dsh.tested.at(-1)} <0.3.0-0`)
  })

  it('lists files that exist, and packs the host module, the built browser module, the launcher and the skills, and nothing else', () => {
    for (const entry of manifest.files) expect(fs.existsSync(path.join(plugin, entry)), entry).toBe(true)
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: plugin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const files = packed.files.map((file) => file.path).sort()
    const code = files.filter((file) => !file.startsWith('skills/'))
    expect(code).toEqual(
      ['README.md', 'bin/kits-mcp.mjs', 'cordis.patch.yml', 'lib/client.js', 'lib/forward.mjs', 'lib/freshness.mjs', 'lib/gateways.mjs', 'lib/host.mjs', 'lib/kition.mjs', 'lib/live.mjs', 'lib/mcp.mjs', 'lib/reviews.mjs', 'lib/routes.mjs', 'lib/tools.mjs', 'lib/workspaces.mjs', 'package.json'].sort(),
    )
    expect(files).toContain('skills/drafts-merge/SKILL.md')
    for (const kit of PUBLISHED_KITS) expect(files).toContain(`skills/${kit}-editing/SKILL.md`)
    // The host module needs nothing installed: only Node's own modules and its own files.
    for (const file of code.filter((name) => name.startsWith('lib/') && name.endsWith('.mjs'))) {
      const imports = [...fs.readFileSync(path.join(plugin, file), 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
      for (const specifier of imports) expect(specifier, `${file} imports ${specifier}`).toMatch(/^(node:|\.\/)/)
    }
  })
})

describe('the browser module', async () => {
  const { buildClient, extensionTable } = await import('../plugins/deepseek-harness/kition-kits/build-client.mjs')

  it('is built from its sources: lib/client.js is what build-client.mjs makes now', async () => {
    expect(fs.readFileSync(path.join(plugin, 'lib/client.js'), 'utf8'), 'run node plugins/deepseek-harness/kition-kits/build-client.mjs').toBe(await buildClient())
  }, 60_000)

  it('opens the extensions each published kit edits, from the kits’ manifests, HTML going to the HTML kit, and those a kit only views read-only', () => {
    const table = extensionTable()
    const fixtures = path.join(root, 'crates/kition-kits/tests/fixtures/kits')
    const edited = new Map()
    const viewed = new Map()
    for (const kit of PUBLISHED_KITS) {
      for (const format of JSON.parse(fs.readFileSync(path.join(fixtures, `${kit}.json`), 'utf8')).formats) {
        for (const extension of format.extensions) {
          const role = format.role === 'edit' ? edited : viewed
          if (!role.has(extension)) role.set(extension, kit)
        }
      }
    }
    for (const [extension, kit] of edited) expect(table[extension], extension).toEqual({ kit, view: false })
    // A format no kit edits opens read-only in the first kit that views it (Sheet's .csv, Vector's .svg).
    for (const [extension, kit] of viewed) if (!edited.has(extension)) expect(table[extension], extension).toEqual({ kit, view: true })
    expect(Object.keys(table).sort()).toEqual([...new Set([...edited.keys(), ...viewed.keys()])].sort())
    expect(table).toMatchObject({ md: { kit: 'note' }, html: { kit: 'html', view: false }, htm: { kit: 'html' }, docx: { kit: 'doc' }, csv: { kit: 'sheet', view: true }, svg: { kit: 'vector', view: true }, ktable: { kit: 'table' } })
    expect(new Set(Object.values(table).map((entry) => entry.kit))).toEqual(new Set(PUBLISHED_KITS))
  })
})

describe('the patches', () => {
  // A profile folder whose node_modules holds the plugin, as `dsh plugin add` leaves it: `baseUrl`
  // in a bundle's patch is the profile's folder.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  fs.mkdirSync(path.join(profile, 'node_modules/@kition'), { recursive: true })
  fs.symlinkSync(plugin, path.join(profile, 'node_modules/@kition/dsh-kits'), 'dir')
  const evaluate = (value, env = {}) => {
    const scoped = new Proxy(process, { get: (target, key) => (key === 'env' ? env : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) })
    return new Function('baseUrl', 'process', `return (${value.js})`)(pathToFileURL(profile).href + '/', scoped)
  }
  const real = (file) => fs.realpathSync(file)

  it('inserts the host module, by the package’s name (which also loads its browser module), and no MCP server row bound to a folder', () => {
    const [{ insert }] = patch('cordis.patch.yml')
    const row = insert.find((entry) => entry.id === 'kition-kits-host')
    expect(row).toEqual({ id: 'kition-kits-host', name: '@kition/dsh-kits' })
    expect(insert.filter((entry) => entry.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(fs.existsSync(path.join(plugin, 'kition-kits.http.cordis.patch.yml'))).toBe(false)
  })

  it('insert the skills row, with only the plugin’s skills', () => {
    const [{ insert }] = patch('cordis.patch.yml')
    expect(insert.map((entry) => entry.id)).toEqual(['kition-kits-host', 'kition-kits-skills'])
    const row = insert.find((entry) => entry.id === 'kition-kits-skills')
    expect(row.name).toBe('@deepseek-ai/dsh-skill-filesystem')
    expect(row.config.providerName).toBe('kition-kits')
    expect(row.config.includeDefaultRoots).toBe(false)
    expect(row.config.customSkillDirs).toHaveLength(1)
    expect(real(evaluate(row.config.customSkillDirs[0]))).toBe(real(path.join(plugin, 'skills')))
  })

})

describe('the skills', () => {
  const skills = fs.readdirSync(path.join(plugin, 'skills')).sort()

  it('are an editing skill per published kit and the four draft skills', () => {
    expect(skills).toEqual([...PUBLISHED_KITS.map((kit) => `${kit}-editing`), 'drafts-compare', 'drafts-discard', 'drafts-list', 'drafts-merge'].sort())
    for (const name of skills) {
      const fields = frontmatter(fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8'))
      expect(fields.name).toBe(name)
      expect(fields.description).toBeTruthy()
    }
  })

  it('leave merging and discarding to the person (KHP A14), and take the file from their message', () => {
    for (const name of ['drafts-list', 'drafts-compare', 'drafts-merge', 'drafts-discard']) {
      const text = fs.readFileSync(path.join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
      const fields = frontmatter(text)
      expect(fields['disable-model-invocation'], name).toBe(['drafts-merge', 'drafts-discard'].includes(name) ? 'true' : undefined)
      // DeepSeek Harness replaces no $ARGUMENTS.
      expect(text, name).not.toContain('$ARGUMENTS')
      expect(text, name).toContain(`../../bin/kits-mcp.mjs drafts ${name.slice('drafts-'.length)}`)
    }
    expect(fs.readFileSync(path.join(plugin, 'skills/drafts-merge/SKILL.md'), 'utf8')).toMatch(/`stale`[\s\S]*`--overwrite`/)
  })
})

describe('the launcher', () => {
  // Stand-ins for kition-kits-mcp, kition and npx that print the arguments they were started with.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kits-launcher-'))
  const printer = '#!/bin/sh\nprintf "%s\\n" "$@"\n'
  // A kition the plugin takes: it has the gateway command.
  const kitionPrinter = '#!/bin/sh\nif [ "$1 $2" = "gateway --help" ]; then echo "usage: kition gateway"; exit 0; fi\nprintf "%s\\n" "$@"\n'
  const fake = path.join(dir, 'kition-kits-mcp')
  fs.writeFileSync(fake, printer, { mode: 0o755 })
  const repos = path.join(dir, 'repos')
  // A built kit, a kit not built, a build named for another kit, and a built repository that is no kit.
  for (const [repo, executable, kit] of [['kition-slide', 'kition-slide', true], ['kition-doc', null, true], ['kition-scene-curves', 'kition-scene', true], ['kition-server', 'kition-server', false]]) {
    fs.mkdirSync(path.join(repos, repo, 'target/debug'), { recursive: true })
    if (executable) fs.writeFileSync(path.join(repos, repo, 'target/debug', executable), '', { mode: 0o755 })
    if (kit) fs.writeFileSync(path.join(repos, repo, 'kit.json'), '{}')
  }
  // A HOME of its own: a kition installed in the HOME of the machine running the tests is not found.
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const run = (args, env) =>
    execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), ...args], { env: { PATH: '/usr/bin:/bin', HOME: home, ...env }, encoding: 'utf8' }).trim().split('\n')
  const failure = (args, env) => {
    try {
      execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), ...args], { env: { PATH: '/usr/bin:/bin', HOME: home, ...env }, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      return { status: error.status, stderr: error.stderr }
    }
    return { status: 0, stderr: '' }
  }

  it('serves one tool set for every kit by default, with the built kit repositories', () => {
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: fake, KITION_KIT_REPOS: repos, KITION_KITS_DIR: '' })).toEqual([
      '--workspace',
      '/w',
      '--kit',
      path.join(repos, 'kition-slide/target/debug/kition-slide'),
      '--unified',
    ])
  })

  it('gives each kit its own tools when unified is off, and never passes --unified to drafts', () => {
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: fake, KITION_KITS_UNIFIED: 'false', KITION_KITS_DIR: '/kits' })).toEqual(['--workspace', '/w', '--kits-dir', '/kits'])
    expect(run(['drafts', 'list', '--workspace', '/w'], { KITION_KITS_MCP: fake })).toEqual(['drafts', 'list', '--workspace', '/w'])
  })

  it('takes kition-kits-mcp from the PATH when the option is unset', () => {
    expect(run(['--workspace', '/w'], { PATH: `${dir}:/usr/bin:/bin`, KITION_KITS_UNIFIED: 'false' })).toEqual(['--workspace', '/w'])
  })

  it('prefers kition, from the option or the PATH, and starts it as kition mcp', () => {
    const bin = path.join(dir, 'with-kition')
    fs.mkdirSync(bin, { recursive: true })
    const kition = path.join(bin, 'kition')
    fs.writeFileSync(kition, kitionPrinter, { mode: 0o755 })
    const both = `${bin}:${dir}:/usr/bin:/bin`
    expect(run(['--workspace', '/w'], { PATH: both })).toEqual(['mcp', '--workspace', '/w', '--unified'])
    expect(run(['drafts', 'list', '--workspace', '/w'], { PATH: both, KITION_KITS_MCP: '' })).toEqual(['mcp', 'drafts', 'list', '--workspace', '/w'])
    expect(run(['--workspace', '/w'], { KITION_KITS_MCP: kition, KITION_KITS_DIR: '/kits', KITION_KITS_UNIFIED: 'false' })).toEqual(['mcp', '--workspace', '/w', '--kits-dir', '/kits'])
  })

  it('falls back to the npm launcher through npx, without the unset option in its environment', () => {
    const bin = path.join(dir, 'npx-only')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "env=%s\\n" "${KITION_KITS_MCP-unset}"\n', { mode: 0o755 })
    const env = { PATH: `${bin}:/usr/bin:/bin`, KITION_KITS_MCP: '${KITION_KITS_MCP}', KITION_KITS_DIR: '' }
    expect(run(['--workspace', '/w'], env)).toEqual(['-y', '@kition/cli', 'mcp', '--workspace', '/w', '--unified', 'env=unset'])
    expect(run(['drafts', 'list', '--workspace', '/w'], env)).toEqual(['-y', '@kition/cli', 'mcp', 'drafts', 'list', '--workspace', '/w', 'env=unset'])
  })

  it('says what is missing when it finds no server, or the option names no executable', () => {
    const none = failure(['--workspace', '/w'], { PATH: path.join(dir, 'empty') })
    expect(none.status).toBe(1)
    expect(none.stderr).toMatch(/^kition-kits: kition cannot run here\. The plugin was added from a folder/)
    expect(none.stderr).toContain('No kition-kits-mcp and no npx on the PATH either.')
    const wrong = failure(['--workspace', '/w'], { KITION_KITS_MCP: path.join(dir, 'missing') })
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain(`KITION_KITS_MCP is ${path.join(dir, 'missing')}, which is not an executable file`)
  })

  it('exits with the server’s status', () => {
    const failing = path.join(dir, 'failing')
    fs.writeFileSync(failing, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    expect(failure(['--workspace', '/w'], { KITION_KITS_MCP: failing }).status).toBe(3)
  })
})

describe('the launcher, where DeepSeek Harness Desktop’s PATH has no kition', () => {
  it('finds kition where install.sh puts it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kits-home-'))
    fs.mkdirSync(path.join(home, '.kition/bin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kition/bin/kition'), '#!/bin/sh\nif [ "$1 $2" = "gateway --help" ]; then echo "usage: kition gateway"; exit 0; fi\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const printed = execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), 'drafts', 'list', '--workspace', '/w'], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' })
    expect(printed.trim().split('\n')).toEqual(['mcp', 'drafts', 'list', '--workspace', '/w'])
  })
})
