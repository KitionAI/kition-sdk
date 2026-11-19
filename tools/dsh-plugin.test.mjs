// The kition-kits DeepSeek Harness plugin (plugins/deepseek-harness/kition-kits, @kition/dsh-kits):
// its bundle manifest, its two patches, its skills and its launcher. Its generated kit skills are
// checked against their guides by tools/agent-plugin.test.mjs; a real DeepSeek Harness runs it in
// the plugin's test/e2e.sh.
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

// The keys DeepSeek Harness 0.2.2-rc.5's dsh-mcp-client accepts, by transport.
const MCP_KEYS = ['serverName', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'startupTimeoutMs', 'closeTimeoutMs', 'expandTemplates', 'failOnStartupError', 'maxInstructionBytes', 'reconnect', 'transport']

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

  it('admits the pinned DeepSeek Harness release and no 0.3.0 prerelease', () => {
    expect(manifest.dsh.target).toBe('0.2.2-rc.5')
    expect(manifest.dsh.commit).toMatch(/^[0-9a-f]{8,40}$/)
    // DeepSeek Harness compares with prereleases included: `<0.3.0` would admit 0.3.0-rc.1.
    expect(manifest.engines.dsh).toBe(`>=${manifest.dsh.target} <0.3.0-0`)
  })

  it('lists files that exist, and packs them without its tests', () => {
    for (const entry of manifest.files) expect(fs.existsSync(path.join(plugin, entry)), entry).toBe(true)
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: plugin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const files = packed.files.map((file) => file.path).sort()
    expect(files).toContain('bin/kits-mcp.mjs')
    expect(files).toContain('cordis.patch.yml')
    expect(files).toContain('kition-kits.http.cordis.patch.yml')
    expect(files).toContain('skills/drafts-merge/SKILL.md')
    for (const kit of PUBLISHED_KITS) expect(files).toContain(`skills/${kit}-editing/SKILL.md`)
    expect(files.filter((file) => file.startsWith('test/'))).toEqual([])
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

  it('insert the MCP server row, which starts the launcher with dsh’s own Node on the workspace', () => {
    const [{ insert }] = patch('cordis.patch.yml')
    const row = insert.find((entry) => entry.id === 'kition-kits')
    expect(row.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(row.config.serverName).toBe('kition')
    expect(row.config.transport).toBe('stdio')
    expect(row.config.command.js).toBe('process.execPath')
    for (const key of Object.keys(row.config)) expect(MCP_KEYS, key).toContain(key)
    const [launcher, ...rest] = evaluate(row.config.args, { KITION_WORKSPACE: '/w' })
    expect(real(launcher)).toBe(real(path.join(plugin, 'bin/kits-mcp.mjs')))
    expect(rest).toEqual(['--workspace', '/w'])
    expect(evaluate(row.config.args, {})[2]).toBe(process.cwd())
  })

  it('insert the skills row, with only the plugin’s skills', () => {
    const [{ insert }] = patch('cordis.patch.yml')
    expect(insert.map((entry) => entry.id)).toEqual(['kition-kits', 'kition-kits-skills'])
    const row = insert.find((entry) => entry.id === 'kition-kits-skills')
    expect(row.name).toBe('@deepseek-ai/dsh-skill-filesystem')
    expect(row.config.providerName).toBe('kition-kits')
    expect(row.config.includeDefaultRoots).toBe(false)
    expect(row.config.customSkillDirs).toHaveLength(1)
    expect(real(evaluate(row.config.customSkillDirs[0]))).toBe(real(path.join(plugin, 'skills')))
  })

  it('let a running Kition take the MCP row over by its id, restating every key', () => {
    const rows = patch('kition-kits.http.cordis.patch.yml')
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.id).toBe('kition-kits')
    expect(row.config.serverName).toBe('kition')
    expect(row.config.transport).toBe('streamable-http')
    expect(evaluate(row.config.url, { KITION_MCP_URL: 'http://127.0.0.1:1/api/v1/mcp/kits' })).toBe('http://127.0.0.1:1/api/v1/mcp/kits')
    for (const key of Object.keys(row.config)) expect(MCP_KEYS, key).toContain(key)
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
  const run = (args, env) =>
    execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' }).trim().split('\n')
  const failure = (args, env) => {
    try {
      execFileSync(process.execPath, [path.join(plugin, 'bin/kits-mcp.mjs'), ...args], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', stdio: 'pipe' })
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
