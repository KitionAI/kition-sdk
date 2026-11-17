import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { kitExecutables } from './kit-handshake.mjs'
import { assetUrl, bundles, releaseManifest, writeRelease } from './sdk-release.mjs'

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const scratch = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-release-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const kit = { kit: 'note', id: 'kit.note', version: '0.3.0', repository: 'KitionAI/kition-note', tag: 'package-v0.3.0', commit: 'a'.repeat(40), sdkCommit: 'b'.repeat(40), url: 'https://example.invalid/kition-note-0.3.0.tgz', protocol: 'kition-kit/2', manifest: 'kits/note/kit.json', file: 'kits/kition-note-0.3.0.tgz', size: 3, sha256: 'c'.repeat(64) }

/** A bundle manifest as sdk-bundle.mjs writes it. */
function manifest(platform, overrides = {}) {
  const exe = platform.startsWith('win32') ? '.exe' : ''
  return {
    name: 'kition-sdk',
    version: '9.9.9',
    source: { commit: 'd'.repeat(40), clean: true },
    platform,
    packages: [{ name: '@kition/embed', version: '9.9.9', file: 'npm/kition-embed-9.9.9.tgz', size: 1, sha256: 'e'.repeat(64) }],
    kits: [kit],
    binaries: [
      { name: 'kition-kits-mcp', protocol: 'kition-kit/2', file: `bin/${platform}/kition-kits-mcp${exe}`, size: 1, sha256: 'f'.repeat(64) },
      { name: 'kition-note', kit: 'note', kitVersion: '0.3.0', protocol: 'kition-kit/2', file: `bin/${platform}/kition-note${exe}`, size: 1, sha256: '0'.repeat(64) },
    ],
    docs: [],
    ...overrides,
  }
}

/** Writes kition-sdk-9.9.9-<platform>.tar.gz holding <folder>/manifest.json. */
function writeBundle(dir, platform, body) {
  const folder = `kition-sdk-9.9.9-${platform}`
  fs.mkdirSync(path.join(dir, 'stage', folder), { recursive: true })
  fs.writeFileSync(path.join(dir, 'stage', folder, 'manifest.json'), JSON.stringify(body))
  execFileSync('tar', ['-czf', path.join(dir, `${folder}.tar.gz`), '-C', path.join(dir, 'stage'), folder])
  fs.rmSync(path.join(dir, 'stage'), { recursive: true })
}

describe('sdk-release: the release manifest of one SDK version', () => {
  it('finds one bundle per platform, of this version only', () => {
    const dir = tempDir()
    for (const file of ['kition-sdk-9.9.9-darwin-arm64.tar.gz', 'kition-sdk-9.9.9-win32-x64.tar.gz', 'kition-sdk-9.9.8-linux-x64.tar.gz', 'kition-sdk-9.9.9.tar.gz']) fs.writeFileSync(path.join(dir, file), '')
    expect(bundles(dir, '9.9.9')).toEqual([
      { file: 'kition-sdk-9.9.9-darwin-arm64.tar.gz', platform: 'darwin-arm64' },
      { file: 'kition-sdk-9.9.9-win32-x64.tar.gz', platform: 'win32-x64' },
    ])
  })

  it('names each platform bundle, executable, kit and schema with its SHA-256 and versioned URL', () => {
    const dir = tempDir()
    writeBundle(dir, 'darwin-arm64', manifest('darwin-arm64'))
    writeBundle(dir, 'win32-x64', manifest('win32-x64'))
    const written = writeRelease(dir, '9.9.9')
    expect(written.tag).toBe('sdk-v9.9.9')
    expect(written.commit).toBe('d'.repeat(40))
    expect(written.kits).toEqual([{ kit: 'note', id: 'kit.note', version: '0.3.0', repository: 'KitionAI/kition-note', tag: 'package-v0.3.0', commit: 'a'.repeat(40), sdkCommit: 'b'.repeat(40), url: kit.url, protocol: 'kition-kit/2', manifest: 'kits/note/kit.json', asset: 'kition-note-0.3.0.tgz', size: 3, sha256: 'c'.repeat(64) }])
    const darwin = written.platforms['darwin-arm64']
    expect(darwin.sha256).toBe(sha256(path.join(dir, 'kition-sdk-9.9.9-darwin-arm64.tar.gz')))
    expect(darwin.url).toBe('https://github.com/KitionAI/kition-sdk/releases/download/sdk-v9.9.9/kition-sdk-9.9.9-darwin-arm64.tar.gz')
    expect(darwin.binaries.find((binary) => binary.name === 'kition-note')).toMatchObject({ kitVersion: '0.3.0', file: 'bin/darwin-arm64/kition-note' })
    expect(written.platforms['win32-x64'].binaries.map((binary) => binary.file)).toEqual(['bin/win32-x64/kition-kits-mcp.exe', 'bin/win32-x64/kition-note.exe'])
    const schema = written.schemas.find((entry) => entry.file === 'mcp-tools.schema.json')
    expect(schema.url).toBe(assetUrl('9.9.9', 'mcp-tools.schema.json'))
    expect(schema.sha256).toBe(sha256(path.join(dir, 'mcp-tools.schema.json')))

    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split('  '))
    expect(sums.map(([, file]) => file)).toContain('kition-sdk-9.9.9.json')
    expect(sums.map(([, file]) => file)).toContain('kition-sdk-9.9.9-win32-x64.tar.gz')
    for (const [sum, file] of sums) expect(sum).toBe(sha256(path.join(dir, file)))
  })

  it('refuses bundles that disagree or a kit executable that answers another version', () => {
    const found = (platform, overrides) => ({ platform, file: `kition-sdk-9.9.9-${platform}.tar.gz`, size: 1, sha256: '1'.repeat(64), manifest: manifest(platform, overrides) })
    expect(() => releaseManifest('9.9.9', [found('darwin-arm64'), found('linux-x64', { source: { commit: '2'.repeat(40), clean: true } })], [])).toThrow(/is from/)
    expect(() => releaseManifest('9.9.9', [found('darwin-arm64', { source: { commit: 'd'.repeat(40), clean: false } })], [])).toThrow(/with changes/)
    expect(() => releaseManifest('9.9.9', [found('darwin-arm64', { version: '9.9.8' })], [])).toThrow(/is 9\.9\.8/)
    const stale = manifest('linux-x64').binaries.map((binary) => (binary.kit ? { ...binary, kitVersion: '0.1.0' } : binary))
    expect(() => releaseManifest('9.9.9', [found('linux-x64', { binaries: stale })], [])).toThrow(/no kition-note that answers 0\.3\.0/)
    expect(() => releaseManifest('9.9.9', [], [])).toThrow(/no kition-sdk-9\.9\.9-<platform>/)
  })

  it('checks the kit executables of a folder, not the two servers', () => {
    const dir = tempDir()
    for (const file of ['kition-kits', 'kition-kits-mcp.exe', 'kition-note', 'kition-table.exe', 'handshakes.json', 'kition-note.pdb']) fs.writeFileSync(path.join(dir, file), '')
    expect(kitExecutables(dir)).toEqual(['kition-note', 'kition-table.exe'])
  })
})
