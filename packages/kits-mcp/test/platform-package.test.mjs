// scripts/platform-package.mjs: the platform packages it writes from built executables, and the
// launcher archive it makes depend on them.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { optionalDependencies, platformManifest, writePlatformPackage } from '../scripts/platform-package.mjs'

const platforms = Object.keys(JSON.parse(fs.readFileSync(new URL('../src/platforms.json', import.meta.url), 'utf8'))).filter((key) => !key.startsWith('$'))
const script = fileURLToPath(new URL('../scripts/platform-package.mjs', import.meta.url))
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kits-mcp-platform-'))

describe('platform packages', () => {
  it('install only on their platform, as npm reads os, cpu and libc', () => {
    expect(platformManifest('linux-x64', '0.1.0')).toMatchObject({
      name: '@kition/kits-mcp-linux-x64', version: '0.1.0', os: ['linux'], cpu: ['x64'], libc: ['glibc'], files: ['bin'],
    })
    expect(platformManifest('darwin-arm64', '0.1.0')).not.toHaveProperty('libc')
    expect(() => platformManifest('sunos-x64', '0.1.0')).toThrow(/no platform sunos-x64/)
  })

  it('carry kition and no kit', () => {
    const dir = scratch()
    const kition = path.join(dir, 'kition.exe')
    fs.writeFileSync(kition, 'kition')
    const written = writePlatformPackage({ platform: 'win32-x64', kition, out: path.join(dir, 'npm') })
    const files = fs.readdirSync(written, { recursive: true }).map((file) => file.split(path.sep).join('/')).sort()
    expect(files).toEqual(['LICENSE', 'README.md', 'bin', 'bin/kition.exe', 'package.json'])
    expect(JSON.parse(fs.readFileSync(path.join(written, 'package.json'), 'utf8')).name).toBe('@kition/kits-mcp-win32-x64')
    expect(fs.readFileSync(path.join(written, 'README.md'), 'utf8')).toContain('~/.kition/kits')
    if (process.platform !== 'win32') expect(fs.statSync(path.join(written, 'bin/kition.exe')).mode & 0o111).toBeTruthy()
  })

  it('take only kition, named as on its platform', () => {
    const dir = scratch()
    const server = path.join(dir, 'kition-kits-mcp')
    fs.writeFileSync(server, 'server')
    expect(() => writePlatformPackage({ platform: 'linux-x64', kition: server, out: path.join(dir, 'npm') })).toThrow(/give the kition executable, not kition-kits-mcp/)
    expect(() => writePlatformPackage({ platform: 'linux-x64', kition: path.join(dir, 'kition'), out: path.join(dir, 'npm') })).toThrow(/no such file/)
  })
})

describe('linking the launcher', () => {
  it('needs every platform at the launcher’s version', () => {
    const out = scratch()
    for (const platform of platforms.slice(1)) {
      fs.mkdirSync(path.join(out, platform), { recursive: true })
      fs.writeFileSync(path.join(out, platform, 'package.json'), JSON.stringify({ name: `@kition/kits-mcp-${platform}`, version: '0.1.0' }))
    }
    expect(() => optionalDependencies(out, '0.1.0')).toThrow(`no platform package for ${platforms[0]}`)
    fs.mkdirSync(path.join(out, platforms[0]))
    fs.writeFileSync(path.join(out, platforms[0], 'package.json'), JSON.stringify({ name: `@kition/kits-mcp-${platforms[0]}`, version: '0.0.9' }))
    expect(() => optionalDependencies(out, '0.1.0')).toThrow(/is 0.0.9; the launcher is 0.1.0/)
  })

  it('adds every platform package to the packed launcher as an optional dependency', () => {
    const out = scratch()
    for (const platform of platforms) {
      fs.mkdirSync(path.join(out, platform), { recursive: true })
      fs.writeFileSync(path.join(out, platform, 'package.json'), JSON.stringify({ name: `@kition/kits-mcp-${platform}`, version: '0.1.0' }))
    }
    const stage = scratch()
    fs.mkdirSync(path.join(stage, 'package'))
    fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({ name: '@kition/kits-mcp', version: '0.1.0' }))
    const archive = path.join(stage, 'kits-mcp.tgz')
    execFileSync('tar', ['-czf', archive, '-C', stage, 'package'])
    execFileSync(process.execPath, [script, 'link', '--launcher', archive, '--out', out], { stdio: 'pipe' })
    const linked = JSON.parse(execFileSync('tar', ['-xzOf', archive, 'package/package.json'], { encoding: 'utf8' }))
    expect(linked.optionalDependencies).toEqual(Object.fromEntries(platforms.map((platform) => [`@kition/kits-mcp-${platform}`, '0.1.0'])))
  })

  it('reads platform packages packed by npm pack as well as their folders', () => {
    const out = scratch()
    for (const platform of platforms) {
      const stage = scratch()
      fs.mkdirSync(path.join(stage, 'package'))
      fs.writeFileSync(path.join(stage, 'package', 'package.json'), JSON.stringify({ name: `@kition/kits-mcp-${platform}`, version: '0.1.0' }))
      execFileSync('tar', ['-czf', path.join(out, `kition-kits-mcp-${platform}-0.1.0.tgz`), '-C', stage, 'package'])
    }
    expect(Object.keys(optionalDependencies(out, '0.1.0'))).toEqual(platforms.map((platform) => `@kition/kits-mcp-${platform}`))
  })
})
