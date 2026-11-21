import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BINARY_VARIABLE, KITION_NAME, LAUNCHER_VARIABLE, PACKAGE_NAME, PLATFORMS, SCOPE_VARIABLE, launchedAs, launcherScope, resolveKition, supportedPlatforms, type Machine } from '../src/index'

const root = new URL('../../../', import.meta.url)
const sdk = JSON.parse(fs.readFileSync(new URL('sdk.json', root), 'utf8'))

const posix = (file: string) => file.replace(/\/[^/]*$/, '') || '/'
const posixBase = (file: string) => file.slice(file.lastIndexOf('/') + 1)

/** A machine with the given files (`/`-joined paths), links and installed packages. */
function machine(over: Partial<Machine> & { files?: string[]; packages?: Record<string, string>; links?: Record<string, string> } = {}): Machine {
  const { files = [], packages = {}, links = {}, ...rest } = over
  return {
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    packageDir: (name) => packages[name] ?? null,
    isFile: (file) => files.includes(file),
    realPath: (file) => links[file] ?? file,
    self: '/npm/lib/node_modules/@kition/cli/dist/cli.js',
    join: (...parts) => parts.join('/'),
    dirname: posix,
    basename: posixBase,
    ...rest,
  }
}

const bundled = {
  packages: { '@kition/cli-darwin-arm64': '/nm/@kition/cli-darwin-arm64' },
  files: ['/nm/@kition/cli-darwin-arm64/bin/kition'],
}

describe('resolveKition', () => {
  it('names the package, command and variables sdk.json gives', () => {
    expect(PACKAGE_NAME).toBe(sdk.binaries.cli.npm)
    expect(KITION_NAME).toBe(sdk.binaries.cli.name)
    expect(BINARY_VARIABLE).toBe(sdk.binaries.cli.binary)
    expect(LAUNCHER_VARIABLE).toBe(sdk.binaries.cli.launcher)
  })

  it('starts the platform package’s kition', () => {
    expect(resolveKition(machine(bundled))).toEqual({ ok: true, command: '/nm/@kition/cli-darwin-arm64/bin/kition', from: 'package' })
  })

  it('takes the executable KITION_BINARY names before the platform package', () => {
    const files = [...bundled.files, '/dev/target/debug/kition']
    expect(resolveKition(machine({ ...bundled, files, env: { [BINARY_VARIABLE]: '/dev/target/debug/kition' } }))).toEqual({ ok: true, command: '/dev/target/debug/kition', from: 'env' })
  })

  it('refuses a named executable that is missing rather than start another', () => {
    const result = resolveKition(machine({ ...bundled, env: { [BINARY_VARIABLE]: '/gone' } }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain(`${BINARY_VARIABLE} names /gone`)
  })

  it('never looks on the PATH, where npm’s kition command is this launcher', () => {
    const result = resolveKition(machine({ env: { PATH: '/npm/bin:/home/me/.kition/bin' }, files: ['/npm/bin/kition', '/home/me/.kition/bin/kition'] }))
    expect(result.ok).toBe(false)
  })

  it('looks for bin/kition.exe on Windows', () => {
    const windows = machine({ platform: 'win32', arch: 'x64', packages: { '@kition/cli-win32-x64': 'C:/nm/cli' }, files: ['C:/nm/cli/bin/kition.exe'] })
    expect(resolveKition(windows)).toEqual({ ok: true, command: 'C:/nm/cli/bin/kition.exe', from: 'package' })
  })

  it('names the supported platforms and install.sh on an unsupported one', () => {
    const result = resolveKition(machine({ platform: 'freebsd', arch: 'x64' }))
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).toContain('this platform (freebsd-x64)')
    expect(message).toContain(supportedPlatforms())
    for (const platform of Object.keys(PLATFORMS)) expect(message).toContain(platform)
    expect(message).toContain('install.sh')
    expect(message).toContain(BINARY_VARIABLE)
  })

  it('names install.ps1 on Windows', () => {
    const result = resolveKition(machine({ platform: 'win32', arch: 'arm64' }))
    expect(!result.ok && result.message).toContain('install.ps1')
  })

  it('says the optional package is missing on a supported platform without it (--omit=optional)', () => {
    const result = resolveKition(machine({ platform: 'linux', arch: 'x64', glibc: true }))
    expect(!result.ok && result.message).toContain('@kition/cli-linux-x64 that carries it is not installed')
    expect(!result.ok && result.message).toContain('--omit=optional')
    expect(!result.ok && result.message).toContain('install.sh')
  })

  it('starts the platform package of the scope it is published under (a rehearsal’s @kitionstage/cli)', () => {
    const staged = { name: '@kitionstage/cli', packages: { ...bundled.packages, '@kitionstage/cli-darwin-arm64': '/nm/@kitionstage/cli-darwin-arm64' }, files: [...bundled.files, '/nm/@kitionstage/cli-darwin-arm64/bin/kition'] }
    expect(resolveKition(machine(staged))).toEqual({ ok: true, command: '/nm/@kitionstage/cli-darwin-arm64/bin/kition', from: 'package' })
    // Never the real package's kition, which is another version.
    const result = resolveKition(machine({ ...bundled, name: '@kitionstage/cli' }))
    expect(!result.ok && result.message).toContain('@kitionstage/cli-darwin-arm64 that carries it is not installed')
    expect(!result.ok && result.message).toContain('Install @kitionstage/cli again')
  })

  it('does not take the glibc package on musl Linux', () => {
    const musl = machine({
      platform: 'linux', arch: 'x64', glibc: false,
      packages: { '@kition/cli-linux-x64': '/nm/x' }, files: ['/nm/x/bin/kition'],
    })
    const result = resolveKition(musl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('linux-x64 (not glibc: musl, as on Alpine)')
  })
})

describe('launchedAs', () => {
  const kition = '/somewhere/bin/kition'

  it('is npx from npx’s cache, whatever links are there', () => {
    const self = '/home/me/.npm/_npx/0f94ee7615faf582/node_modules/@kition/cli/dist/cli.js'
    const npx = machine({ self, files: ['/home/me/.npm/_npx/0f94ee7615faf582/node_modules/.bin/kition'], links: { '/home/me/.npm/_npx/0f94ee7615faf582/node_modules/.bin/kition': self } })
    expect(launchedAs(npx, kition)).toEqual({ via: 'npx', command: ['npx', '-y', '@kition/cli'], executable: kition })
    const windows = machine({ platform: 'win32', self: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1d6e\\node_modules\\@kition\\cli\\dist\\cli.js' })
    expect(launchedAs(windows, kition)?.via).toBe('npx')
  })

  it('is npx or npm’s command of the package it is published as', () => {
    const npx = machine({ name: '@kitionstage/cli', self: '/home/me/.npm/_npx/0f94/node_modules/@kitionstage/cli/dist/cli.js' })
    expect(launchedAs(npx, kition)).toEqual({ via: 'npx', command: ['npx', '-y', '@kitionstage/cli'], executable: kition })
    const self = '/opt/npm/lib/node_modules/@kitionstage/cli/dist/cli.js'
    const global = machine({ name: '@kitionstage/cli', self, files: ['/opt/npm/bin/kition'], links: { '/opt/npm/bin/kition': self } })
    expect(launchedAs(global, kition)).toEqual({ via: 'npm', command: ['/opt/npm/bin/kition'], executable: kition })
    expect(launchedAs({ ...global, name: undefined }, kition)).toBeNull()
  })

  it('is npm’s global kition command, the link in <prefix>/bin, not the path inside node_modules', () => {
    const self = '/opt/npm/lib/node_modules/@kition/cli/dist/cli.js'
    const global = machine({ self, files: ['/opt/npm/bin/kition'], links: { '/opt/npm/bin/kition': self } })
    expect(launchedAs(global, kition)).toEqual({ via: 'npm', command: ['/opt/npm/bin/kition'], executable: kition })
  })

  it('is a project’s node_modules/.bin/kition for a project install', () => {
    const self = '/work/app/node_modules/@kition/cli/dist/cli.js'
    const local = machine({ self, files: ['/work/app/node_modules/.bin/kition'], links: { '/work/app/node_modules/.bin/kition': self } })
    expect(launchedAs(local, kition)).toEqual({ via: 'npm', command: ['/work/app/node_modules/.bin/kition'], executable: kition })
  })

  it('passes over a kition command that is not a link to this launcher', () => {
    const self = '/opt/npm/lib/node_modules/@kition/cli/dist/cli.js'
    const other = machine({ self, files: ['/opt/npm/bin/kition'], links: { '/opt/npm/bin/kition': '/elsewhere/@kition/cli/dist/cli.js' } })
    expect(launchedAs(other, kition)).toBeNull()
  })

  it('is npm’s kition.cmd on Windows, beside the global node_modules', () => {
    const win = (file: string) => file.replace(/\\[^\\]*$/, '')
    const base = (file: string) => file.slice(file.lastIndexOf('\\') + 1)
    const global = machine({
      platform: 'win32', self: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@kition\\cli\\dist\\cli.js',
      files: ['C:\\Users\\me\\AppData\\Roaming\\npm\\kition.cmd'], join: (...parts) => parts.join('\\'), dirname: win, basename: base,
    })
    expect(launchedAs(global, kition)).toEqual({ via: 'npm', command: ['C:\\Users\\me\\AppData\\Roaming\\npm\\kition.cmd'], executable: kition })
  })

  it('is nothing to say from a checkout or an unknown layout', () => {
    expect(launchedAs(machine({ self: '/src/kition-sdk/packages/kition/dist/cli.js' }), kition)).toBeNull()
    expect(launchedAs(machine({ self: '/opt/npm/lib/node_modules/@kition/cli/dist/cli.js' }), kition)).toBeNull()
    // A package of another name, with a kition command linked to it, is not this launcher.
    const other = '/opt/npm/lib/node_modules/kition/dist/cli.js'
    expect(launchedAs(machine({ self: other, files: ['/opt/npm/bin/kition'], links: { '/opt/npm/bin/kition': other } }), kition)).toBeNull()
  })
})

describe('launcherScope', () => {
  it('is the scope of a launcher published elsewhere than @kition, when KITION_NPM_SCOPE is not set', () => {
    expect(launcherScope('@kitionstage/cli', {})).toBe('@kitionstage')
    expect(launcherScope(PACKAGE_NAME, {})).toBeNull()
    expect(launcherScope('@kitionstage/cli', { [SCOPE_VARIABLE]: '@kition' })).toBeNull()
    expect(launcherScope('@kitionstage/cli', { [SCOPE_VARIABLE]: '' })).toBeNull()
    expect(launcherScope('kition-cli', {})).toBeNull()
  })
})
