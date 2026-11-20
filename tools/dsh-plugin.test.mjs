// The kition-kits DeepSeek Harness plugin (plugins/deepseek-harness/kition-kits, @kition/dsh-kits):
// its bundle manifest, its patch, its browser module (built, and the extensions it claims), its
// skills and its launcher. Its host module is tested in tools/dsh-plugin-host.test.mjs, its
// generated kit skills against their guides in tools/agent-plugin.test.mjs; a real DeepSeek Harness
// runs it in the plugin's test/e2e.sh (headless) and test/web.e2e.ts and test/desktop.e2e.ts.
import { execFileSync } from 'node:child_process'
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
      ['README.md', 'bin/kits-mcp.mjs', 'cordis.patch.yml', 'lib/client.js', 'lib/forward.mjs', 'lib/gateways.mjs', 'lib/host.mjs', 'lib/kition.mjs', 'lib/mcp.mjs', 'lib/routes.mjs', 'lib/tools.mjs', 'lib/workspaces.mjs', 'package.json'].sort(),
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

  it('opens the extensions each published kit edits, from the kits’ manifests, HTML going to the HTML kit', () => {
    const table = extensionTable()
    const fixtures = path.join(root, 'crates/kition-kits/tests/fixtures/kits')
    const edited = new Set()
    for (const kit of PUBLISHED_KITS) {
      for (const format of JSON.parse(fs.readFileSync(path.join(fixtures, `${kit}.json`), 'utf8')).formats) {
        if (format.role !== 'edit') continue
        for (const extension of format.extensions) {
          edited.add(extension)
          expect(table[extension], extension).toBeDefined()
        }
      }
    }
    // Only edit formats: the gateway's page opens no kit's view-only formats (Doc's .html, Vector's .svg, Sheet's .csv).
    expect(Object.keys(table).filter((extension) => !edited.has(extension))).toEqual([])
    for (const extension of ['csv', 'svg', 'xls', 'fig', 'idml']) expect(table[extension], extension).toBeUndefined()
    expect(table).toMatchObject({ md: 'note', html: 'html', htm: 'html', docx: 'doc', xlsx: 'sheet', pptx: 'slide', pdf: 'pdf', ktable: 'table', kboard: 'board' })
    expect(new Set(Object.values(table))).toEqual(new Set(PUBLISHED_KITS))
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
    fs.writeFileSync(kition, printer, { mode: 0o755 })
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
    expect(none.stderr).toMatch(/^kition-kits: no kition, no kition-kits-mcp and no npx on the PATH/)
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
    fs.writeFileSync(path.join(home, '.kition/bin/kition'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const printed = execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), 'drafts', 'list', '--workspace', '/w'], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' })
    expect(printed.trim().split('\n')).toEqual(['mcp', 'drafts', 'list', '--workspace', '/w'])
  })
})
