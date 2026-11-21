// install/install.sh against fake npm registries served on loopback: which package it takes, what
// it checks, where it installs, and what it says. The public registries it tries last are behind a
// proxy that answers nothing, so no test reaches the network; nor the real ~/.kition or ~/.npmrc.
// (install/install.ps1 needs Windows PowerShell and is not run here.) A rehearsal launcher's copy,
// whose scope line names its own scope (tools/stage-package.mjs), installs that scope's package.
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installerWithScope } from './stage-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'install', 'install.sh')
const platform = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const integrity = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'install-script-'))

/**
 * A registry serving @kition/cli-<platform> at `versions` (each `{ wrong, forPlatform }`): the
 * metadata of each version and of `latest` (the last one), and the tarballs. Answers its address
 * and the paths it was asked.
 */
async function registry(versions, scope = '@kition') {
  const files = new Map()
  let latest = null
  for (const [version, { wrong = false, forPlatform = platform } = {}] of Object.entries(versions)) {
    const stage = fs.mkdtempSync(path.join(scratch, 'stage-'))
    fs.mkdirSync(path.join(stage, 'package', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'package', 'bin', 'kition'), `#!/bin/sh\necho "kition ${version} (kit protocol kition-kit/1, index format 1)"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({ name: `${scope}/cli-${forPlatform}`, version }))
    const tgz = path.join(stage, 'cli.tgz')
    execFileSync('tar', ['-czf', tgz, '-C', stage, 'package'])
    const bytes = fs.readFileSync(tgz)
    const name = `${scope}/cli-${forPlatform}`
    const metadata = JSON.stringify({ name, version, _nodeVersion: '24.1.0', dist: { integrity: wrong ? integrity(Buffer.from('other')) : integrity(bytes), tarball: 'elsewhere' } }, null, 1)
    files.set(`/${name.replace('/', '%2f')}/${version}`, metadata)
    files.set(`/${name}/-/cli-${forPlatform}-${version}.tgz`, bytes)
    latest = metadata
    files.set(`/${name.replace('/', '%2f')}/latest`, latest)
  }
  const asked = []
  const server = http.createServer((request, response) => {
    asked.push(request.url)
    const body = files.get(request.url)
    if (body === undefined) return response.writeHead(404).end('{}')
    response.writeHead(200).end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/`, asked, close: () => new Promise((resolve) => server.close(resolve)) }
}

let good
let bad
let older
let staged
beforeAll(async () => {
  good = await registry({ '9.9.8': {}, '9.9.9': {} })
  bad = await registry({ '9.9.9': { wrong: true } })
  older = await registry({ '9.9.6': { forPlatform: 'sunos-x64' } })
  staged = await registry({ '9.9.7-stage.3': {} }, '@kitionstage')
})
afterAll(async () => {
  for (const each of [good, bad, older, staged]) await each.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Runs install.sh with `args` in a fresh HOME; answers its exit status, output and the home. */
function install(args = [], env = {}, file = script) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'))
  const kitionHome = path.join(home, 'kition-home')
  const dead = 'http://127.0.0.1:9'
  const vars = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: home, KITION_HOME: kitionHome, KITION_NPM_REGISTRY: good.url, https_proxy: dead, http_proxy: dead, HTTPS_PROXY: dead, no_proxy: '127.0.0.1', ...env }
  for (const [key, value] of Object.entries(vars)) if (value === undefined) delete vars[key]
  return new Promise((resolve) => {
    execFile('sh', [file, ...args], { env: vars, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, home, kitionHome })
    })
  })
}

// Each test runs the script up to three times, with curl and tar: seconds alone, more on a busy machine.
describe.runIf(process.platform !== 'win32')('install.sh', { timeout: 60_000 }, () => {
  it('installs the latest kition for this platform into $KITION_HOME/bin and says how to put it on the PATH', async () => {
    const result = await install()
    expect(result.stderr).toContain(`installed kition 9.9.9 (kit protocol kition-kit/1, index format 1) as ${result.kitionHome}/bin/kition (from ${good.url})`)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(execFileSync(path.join(result.kitionHome, 'bin', 'kition'), { encoding: 'utf8' })).toContain('kition 9.9.9')
    expect(fs.readdirSync(path.join(result.kitionHome, 'bin'))).toEqual(['kition'])
    // Nothing is left in tmp/, and no profile was written.
    expect(fs.readdirSync(path.join(result.kitionHome, 'tmp'))).toEqual([])
    expect(fs.readdirSync(result.home)).toEqual(['kition-home'])
    expect(result.stderr).toContain(`export PATH="${result.kitionHome}/bin:$PATH"`)
  })

  it('installs the version given as an argument or by KITION_VERSION', async () => {
    const byArgument = await install(['v9.9.8'])
    expect(byArgument.status).toBe(0)
    expect(execFileSync(path.join(byArgument.kitionHome, 'bin', 'kition'), { encoding: 'utf8' })).toContain('kition 9.9.8')
    const byVariable = await install([], { KITION_VERSION: '9.9.8' })
    expect(byVariable.status).toBe(0)
    expect(byVariable.stderr).toContain('installed kition 9.9.8')
  })

  it('installs into ~/.kition without KITION_HOME, and says nothing of the PATH when it is on it', async () => {
    const result = await install([], { KITION_HOME: undefined })
    expect(result.status).toBe(0)
    expect(fs.existsSync(path.join(result.home, '.kition', 'bin', 'kition'))).toBe(true)
    const onPath = await install([], { PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.join(scratch, 'x')}` })
    expect(onPath.stderr).toContain('is not on your PATH')
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const quiet = await install([], { HOME: home, KITION_HOME: undefined, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${home}/.kition/bin` })
    expect(quiet.status).toBe(0)
    expect(quiet.stderr).not.toContain('is not on your PATH')
  })

  it('installs nothing from a registry whose package is not the integrity its metadata gives, and takes the next one', async () => {
    const refused = await install([], { KITION_NPM_REGISTRY: bad.url })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(new RegExp(`${bad.url}: @kition/cli-${platform} 9\\.9\\.9 has the integrity sha512-\\S+, and its metadata gives sha512-\\S+: refused`))
    expect(refused.stderr).toContain('https://registry.npmjs.org/: no ')
    expect(fs.existsSync(path.join(refused.kitionHome, 'bin', 'kition'))).toBe(false)
    // A dead registry, then one serving other bytes, then the good one.
    const next = await install([], { KITION_NPM_REGISTRY: `http://127.0.0.1:9,${bad.url},${good.url}` })
    expect(next.status).toBe(0)
    expect(next.stderr).toContain(`(from ${good.url})`)
  })

  it('takes npm’s own setting for the @kition scope or its registry from the .npmrc, before the public registries', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'npmrc-'))
    fs.writeFileSync(path.join(home, 'scoped'), `# mine\n@kition:registry = "${good.url}"\n`)
    const scoped = await install([], { KITION_NPM_REGISTRY: undefined, npm_config_userconfig: path.join(home, 'scoped') })
    expect(scoped.status).toBe(0)
    expect(scoped.stderr).toContain(`(from ${good.url})`)
    fs.writeFileSync(path.join(home, 'general'), `registry=${good.url}\n`)
    const general = await install([], { KITION_NPM_REGISTRY: undefined, npm_config_userconfig: path.join(home, 'general') })
    expect(general.status).toBe(0)
    const byVariable = await install([], { KITION_NPM_REGISTRY: undefined, npm_config_registry: good.url })
    expect(byVariable.status).toBe(0)
  })

  it('refuses Linux with the musl C library, and says why', async () => {
    // uname and ldd as Alpine's answer them, first on the PATH.
    const bin = fs.mkdtempSync(path.join(scratch, 'alpine-'))
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)" >&2\nexit 1\n', { mode: 0o755 })
    const result = await install([], { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('this Linux uses the musl C library')
    expect(fs.existsSync(path.join(result.kitionHome, 'bin'))).toBe(false)
  })

  it('says so, naming every registry tried, when none has kition for this platform or the version', async () => {
    const other = await install(['9.9.6'], { KITION_NPM_REGISTRY: older.url })
    expect(other.status).toBe(1)
    expect(other.stderr).toContain(`no registry served @kition/cli-${platform} 9.9.6`)
    expect(other.stderr).toContain(`${older.url}: no @kition/cli-${platform}@9.9.6 there`)
    const missing = await install(['1.0.0'])
    expect(missing.status).toBe(1)
    for (const tried of [good.url, 'https://registry.npmjs.org/', 'https://registry.npmmirror.com/']) expect(missing.stderr).toContain(`${tried}: no @kition/cli-${platform}@1.0.0 there`)
    expect(missing.stderr).toContain('KITION_NPM_REGISTRY')
  })

  it("as a rehearsal launcher carries it: installs its scope's package, from the registry the scope's own npm setting names", async () => {
    const copy = path.join(fs.mkdtempSync(path.join(scratch, 'staged-')), 'install.sh')
    fs.writeFileSync(copy, installerWithScope('install.sh', fs.readFileSync(script, 'utf8'), '@kitionstage'))
    const result = await install([], { KITION_NPM_REGISTRY: staged.url }, copy)
    expect(result.stderr).toContain(`installed kition 9.9.7-stage.3 (kit protocol kition-kit/1, index format 1) as ${result.kitionHome}/bin/kition (from ${staged.url})`)
    expect(result.status).toBe(0)
    expect(staged.asked).toContain(`/@kitionstage%2fcli-${platform}/latest`)
    expect(staged.asked).toContain(`/@kitionstage/cli-${platform}/-/cli-${platform}-9.9.7-stage.3.tgz`)
    // It never asks for @kition's package; the real installer finds no @kition package there.
    expect(staged.asked.filter((asked) => asked.includes('@kition%2f') || asked.includes('@kition/'))).toEqual([])
    const real = await install([], { KITION_NPM_REGISTRY: staged.url })
    expect(real.status).toBe(1)
    expect(real.stderr).toContain(`${staged.url}: no @kition/cli-${platform}@latest there`)
    const home = fs.mkdtempSync(path.join(scratch, 'npmrc-'))
    fs.writeFileSync(path.join(home, 'scoped'), `@kitionstage:registry=${staged.url}\n`)
    const scoped = await install([], { KITION_NPM_REGISTRY: undefined, npm_config_userconfig: path.join(home, 'scoped') }, copy)
    expect(scoped.status).toBe(0)
    expect(scoped.stderr).toContain(`(from ${staged.url})`)
  })
})
