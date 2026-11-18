import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KITION_NAME, LAUNCHED_VARIABLE, PACKAGE_NAME, PLATFORMS, SERVER_NAME, SERVER_VARIABLE, resolveServer, serverArgs, supportedPlatforms, type Machine } from '../src/index'

const root = new URL('../../../', import.meta.url)
const sdk = JSON.parse(fs.readFileSync(new URL('sdk.json', root), 'utf8'))

/** A machine with the given files (`/`-joined paths) and installed packages. */
function machine(over: Partial<Machine> & { files?: string[]; packages?: Record<string, string>; links?: Record<string, string> } = {}): Machine {
  const { files = [], packages = {}, links = {}, ...rest } = over
  return {
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    packageDir: (name) => packages[name] ?? null,
    isFile: (file) => files.includes(file),
    realPath: (file) => links[file] ?? file,
    self: '/npm/lib/node_modules/@kition/kits-mcp/dist/cli.js',
    delimiter: ':',
    join: (...parts) => parts.join('/'),
    ...rest,
  }
}

const bundled = {
  packages: { '@kition/kits-mcp-darwin-arm64': '/nm/@kition/kits-mcp-darwin-arm64' },
  files: ['/nm/@kition/kits-mcp-darwin-arm64/bin/kition'],
}

describe('resolveServer', () => {
  it('names the variable, package and programs sdk.json gives', () => {
    expect(SERVER_VARIABLE).toBe(sdk.binaries.mcp.env)
    expect(PACKAGE_NAME).toBe(sdk.binaries.mcp.npm)
    expect(SERVER_NAME).toBe(sdk.binaries.mcp.name)
    expect(KITION_NAME).toBe(sdk.binaries.cli.name)
  })

  it('starts the platform package’s kition', () => {
    expect(resolveServer(machine(bundled))).toEqual({ ok: true, command: '/nm/@kition/kits-mcp-darwin-arm64/bin/kition', kind: 'kition', from: 'package' })
  })

  it('takes what the environment names before the platform package: kition as kition, anything else as kition-kits-mcp', () => {
    const files = [...bundled.files, '/dev/kition-kits-mcp', '/dev/target/debug/kition']
    expect(resolveServer(machine({ ...bundled, files, env: { [SERVER_VARIABLE]: '/dev/kition-kits-mcp' } }))).toEqual({ ok: true, command: '/dev/kition-kits-mcp', kind: 'server', from: 'env' })
    expect(resolveServer(machine({ ...bundled, files, env: { [SERVER_VARIABLE]: '/dev/target/debug/kition' } }))).toEqual({ ok: true, command: '/dev/target/debug/kition', kind: 'kition', from: 'env' })
    const windows = machine({ platform: 'win32', arch: 'x64', env: { [SERVER_VARIABLE]: 'C:\\kition\\bin\\kition.exe' }, files: ['C:\\kition\\bin\\kition.exe'] })
    expect(resolveServer(windows)).toMatchObject({ ok: true, kind: 'kition' })
  })

  it('refuses a named executable that is missing rather than start another', () => {
    const result = resolveServer(machine({ ...bundled, env: { [SERVER_VARIABLE]: '/gone' } }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain(`${SERVER_VARIABLE} names /gone`)
  })

  it('falls back to kition on the PATH, then to kition-kits-mcp, passing over this launcher itself', () => {
    const shim = '/npm/bin/kition-kits-mcp'
    const links = { [shim]: '/npm/lib/node_modules/@kition/kits-mcp/dist/cli.js' }
    const env = { PATH: '/npm/bin:/opt/kition/bin:/home/me/.kition/bin' }
    const both = machine({ env, files: [shim, '/opt/kition/bin/kition-kits-mcp', '/home/me/.kition/bin/kition'], links })
    expect(resolveServer(both)).toEqual({ ok: true, command: '/home/me/.kition/bin/kition', kind: 'kition', from: 'path' })
    const server = machine({ env, files: [shim, '/opt/kition/bin/kition-kits-mcp'], links })
    expect(resolveServer(server)).toEqual({ ok: true, command: '/opt/kition/bin/kition-kits-mcp', kind: 'server', from: 'path' })
  })

  it('looks for kition.exe on Windows', () => {
    const result = resolveServer(machine({ platform: 'win32', arch: 'x64', env: { Path: 'C:/kition' }, delimiter: ';', files: ['C:/kition/kition.exe'] }))
    expect(result).toMatchObject({ ok: true, command: 'C:/kition/kition.exe', kind: 'kition', from: 'path' })
  })

  it('never looks on the PATH from a program another launcher started, so launchers never start each other', () => {
    const result = resolveServer(machine({ env: { PATH: '/opt/kition/bin', [LAUNCHED_VARIABLE]: '1' }, files: ['/opt/kition/bin/kition-kits-mcp', '/opt/kition/bin/kition'] }))
    expect(result.ok).toBe(false)
  })

  it('says which platforms it supports when it finds no kition on an unsupported one', () => {
    const result = resolveServer(machine({ platform: 'freebsd', arch: 'x64' }))
    expect(result.ok).toBe(false)
    const message = result.ok ? '' : result.message
    expect(message).toContain('this platform (freebsd-x64)')
    expect(message).toContain(supportedPlatforms())
    for (const platform of Object.keys(PLATFORMS)) expect(message).toContain(platform)
    expect(message).toContain(SERVER_VARIABLE)
  })

  it('says the optional package is missing on a supported platform without it', () => {
    const result = resolveServer(machine({ platform: 'linux', arch: 'x64', glibc: true }))
    expect(!result.ok && result.message).toContain('@kition/kits-mcp-linux-x64 that carries it is not installed')
  })

  it('does not take the glibc package on musl Linux', () => {
    const musl = machine({
      platform: 'linux', arch: 'x64', glibc: false,
      packages: { '@kition/kits-mcp-linux-x64': '/nm/x' }, files: ['/nm/x/bin/kition'],
    })
    const result = resolveServer(musl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('linux-x64 (not glibc)')
  })
})

describe('serverArgs', () => {
  it('starts kition as kition mcp with the person’s arguments, and kition-kits-mcp with them alone', () => {
    expect(serverArgs(['--workspace', '.'], 'kition')).toEqual(['mcp', '--workspace', '.'])
    expect(serverArgs(['drafts', 'list', '--workspace', '.'], 'kition')).toEqual(['mcp', 'drafts', 'list', '--workspace', '.'])
    expect(serverArgs(['--workspace', '.', '--kits-dir', '/mine'], 'kition')).toEqual(['mcp', '--workspace', '.', '--kits-dir', '/mine'])
    expect(serverArgs(['--workspace', '.'], 'server')).toEqual(['--workspace', '.'])
  })

  it('hands kit commands to kition as they are, and has none for kition-kits-mcp', () => {
    expect(serverArgs(['kit', 'install', 'note'], 'kition')).toEqual(['kit', 'install', 'note'])
    expect(serverArgs(['kit', 'list'], 'server')).toBeNull()
  })
})
