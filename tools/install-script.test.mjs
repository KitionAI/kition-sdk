// install/install.sh against a fake release served on loopback: which archive it takes, what it
// checks, where it installs, and what it says. No test reaches the network or the real ~/.kition.
// (install/install.ps1 needs Windows PowerShell and is not run here.)
import { execFile, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'install', 'install.sh')
const platform = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'install-script-'))
const releases = path.join(scratch, 'releases')

/** A release sdk-v<version> holding kition-<version>-<platform>.tar.gz and SHA256SUMS. */
function release(version, { sums = true, wrongSum = false, forPlatform = platform } = {}) {
  const dir = path.join(releases, `sdk-v${version}`)
  const stage = path.join(scratch, `stage-${version}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, 'kition'), `#!/bin/sh\necho "kition ${version} (kit protocol kition-kit/2, index format 1)"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'LICENSE'), 'license')
  const archive = `kition-${version}-${forPlatform}.tar.gz`
  execFileSync('tar', ['-czf', path.join(dir, archive), '-C', stage, 'kition', 'LICENSE'])
  const sum = wrongSum ? '0'.repeat(64) : sha256(path.join(dir, archive))
  if (sums) fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${'1'.repeat(64)}  kition-sdk-${version}.json\n${sum}  ${archive}\n`)
}

let server
let base
beforeAll(async () => {
  release('9.9.8')
  release('9.9.9')
  release('9.9.7', { wrongSum: true })
  release('9.9.6', { forPlatform: 'sunos-x64' })
  // GitHub's two forms: /latest/download/<asset> (here 9.9.9) and /download/<tag>/<asset>.
  server = http.createServer((request, response) => {
    const url = decodeURIComponent(request.url.split('?')[0])
    const match = url.match(/^\/releases\/(?:latest\/download|download\/(sdk-v[^/]+))\/([^/]+)$/)
    const file = match && path.join(releases, match[1] ?? 'sdk-v9.9.9', match[2])
    if (!file || !fs.existsSync(file)) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/releases`
})
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Runs install.sh with `args` in a fresh HOME; answers its exit status, output and the home. */
function install(args = [], env = {}) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'))
  const kitionHome = path.join(home, 'kition-home')
  const vars = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, KITION_HOME: kitionHome, KITION_RELEASES_URL: base, ...env }
  for (const [key, value] of Object.entries(vars)) if (value === undefined) delete vars[key]
  return new Promise((resolve) => {
    execFile('sh', [script, ...args], { env: vars, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, home, kitionHome })
    })
  })
}

describe.runIf(process.platform !== 'win32')('install.sh', () => {
  it('installs the latest kition for this platform into $KITION_HOME/bin and says how to put it on the PATH', async () => {
    const result = await install()
    expect(result.stderr).toContain(`installed kition 9.9.9 (kit protocol kition-kit/2, index format 1) as ${result.kitionHome}/bin/kition`)
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

  it('installs nothing when the archive does not match SHA256SUMS', async () => {
    const result = await install(['9.9.7'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/kition-9\.9\.7-.*\.tar\.gz has SHA-256 [0-9a-f]{64}; the release's SHA256SUMS says 0{64}\. Nothing was installed\./)
    expect(fs.existsSync(path.join(result.kitionHome, 'bin', 'kition'))).toBe(false)
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

  it('says so when the release has no kition for this platform, or the version is not there', async () => {
    const other = await install(['9.9.6'])
    expect(other.status).toBe(1)
    expect(other.stderr).toContain(`has no kition for ${platform}`)
    const missing = await install(['1.0.0'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('could not download')
    expect(missing.stderr).toContain('/releases/download/sdk-v1.0.0/SHA256SUMS')
  })
})
