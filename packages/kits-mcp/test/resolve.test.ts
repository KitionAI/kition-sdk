import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LAUNCHED_VARIABLE, PACKAGE_NAME, PLATFORMS, SERVER_VARIABLE, resolveServer, serverArgs, supportedPlatforms, type Machine } from '../src/index'

const root = new URL('../../../', import.meta.url)
const sdk = JSON.parse(fs.readFileSync(new URL('sdk.json', root), 'utf8'))

/** A machine with the given files and folders (`/`-joined paths) and installed packages. */
function machine(over: Partial<Machine> & { files?: string[]; dirs?: string[]; packages?: Record<string, string>; links?: Record<string, string> } = {}): Machine {
  const { files = [], dirs = [], packages = {}, links = {}, ...rest } = over
  return {
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    packageDir: (name) => packages[name] ?? null,
    isFile: (file) => files.includes(file),
    isDir: (dir) => dirs.includes(dir),
    realPath: (file) => links[file] ?? file,
    self: '/npm/lib/node_modules/@kition/kits-mcp/dist/cli.js',
    delimiter: ':',
    join: (...parts) => parts.join('/'),
    ...rest,
  }
}

const bundled = {
  packages: { '@kition/kits-mcp-darwin-arm64': '/nm/@kition/kits-mcp-darwin-arm64' },
  files: ['/nm/@kition/kits-mcp-darwin-arm64/bin/kition-kits-mcp'],
  dirs: ['/nm/@kition/kits-mcp-darwin-arm64/kits'],
}

describe('resolveServer', () => {
  it('names the variable and package sdk.json gives the MCP server', () => {
    expect(SERVER_VARIABLE).toBe(sdk.binaries.mcp.env)
    expect(PACKAGE_NAME).toBe(sdk.binaries.mcp.npm)
  })

  it('starts the platform package’s server with the kits it carries', () => {
    expect(resolveServer(machine(bundled))).toEqual({
      ok: true,
      server: '/nm/@kition/kits-mcp-darwin-arm64/bin/kition-kits-mcp',
      from: 'package',
      kitsDir: '/nm/@kition/kits-mcp-darwin-arm64/kits',
    })
  })

  it('names no kits folder when the platform package carries none', () => {
    expect(resolveServer(machine({ ...bundled, dirs: [] }))).toMatchObject({ ok: true, from: 'package', kitsDir: null })
  })

  it('takes the server the environment names before the platform package, without its kits', () => {
    const named = machine({ ...bundled, env: { [SERVER_VARIABLE]: '/dev/kition-kits-mcp' }, files: [...bundled.files, '/dev/kition-kits-mcp'] })
    expect(resolveServer(named)).toEqual({ ok: true, server: '/dev/kition-kits-mcp', from: 'env', kitsDir: null })
  })

  it('refuses a named server that is missing rather than start another', () => {
    const result = resolveServer(machine({ ...bundled, env: { [SERVER_VARIABLE]: '/gone' } }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain(`${SERVER_VARIABLE} names /gone`)
  })

  it('falls back to kition-kits-mcp on the PATH, passing over this launcher itself', () => {
    const shim = '/npm/bin/kition-kits-mcp'
    const result = resolveServer(machine({
      env: { PATH: '/npm/bin:/opt/kition/bin' },
      files: [shim, '/opt/kition/bin/kition-kits-mcp'],
      links: { [shim]: '/npm/lib/node_modules/@kition/kits-mcp/dist/cli.js' },
    }))
    expect(result).toEqual({ ok: true, server: '/opt/kition/bin/kition-kits-mcp', from: 'path', kitsDir: null })
  })

  it('looks for kition-kits-mcp.exe on Windows', () => {
    const result = resolveServer(machine({ platform: 'win32', arch: 'x64', env: { Path: 'C:/kition' }, delimiter: ';', files: ['C:/kition/kition-kits-mcp.exe'] }))
    expect(result).toMatchObject({ ok: true, server: 'C:/kition/kition-kits-mcp.exe', from: 'path' })
  })

  it('never looks on the PATH from a server another launcher started, so launchers never start each other', () => {
    const result = resolveServer(machine({ env: { PATH: '/opt/kition/bin', [LAUNCHED_VARIABLE]: '1' }, files: ['/opt/kition/bin/kition-kits-mcp'] }))
    expect(result.ok).toBe(false)
  })

  it('says which platforms it supports when it finds no server on an unsupported one', () => {
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
      packages: { '@kition/kits-mcp-linux-x64': '/nm/x' }, files: ['/nm/x/bin/kition-kits-mcp'],
    })
    const result = resolveServer(musl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('linux-x64 (not glibc)')
  })
})

describe('serverArgs', () => {
  it('adds the bundled kits only when the person named none', () => {
    expect(serverArgs(['--workspace', '.'], '/k')).toEqual(['--workspace', '.', '--kits-dir', '/k'])
    expect(serverArgs(['drafts', 'list', '--workspace', '.'], '/k')).toEqual(['drafts', 'list', '--workspace', '.', '--kits-dir', '/k'])
    expect(serverArgs(['--workspace', '.', '--kits-dir', '/mine'], '/k')).toEqual(['--workspace', '.', '--kits-dir', '/mine'])
    expect(serverArgs(['--workspace', '.', '--kit', '/bin/kition-note'], '/k')).toEqual(['--workspace', '.', '--kit', '/bin/kition-note'])
    expect(serverArgs(['--workspace', '.'], null)).toEqual(['--workspace', '.'])
  })
})
