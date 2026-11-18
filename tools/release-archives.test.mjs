import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareVersions, schemaProblems, writeReleaseArchives } from './release-archives.mjs'

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const scratch = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-archives-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const kitJson = (kit, version, { protocol = 'kition-kit/2', name = kit[0].toUpperCase() + kit.slice(1), extensions = [kit === 'note' ? 'md' : 'ktable'] } = {}) => ({
  id: `kit.${kit}`, name, version,
  formats: [{ id: kit, extensions, role: 'edit' }, { id: 'pdf', extensions: ['pdf'], role: 'export' }],
  headless: { executable: `kition-${kit}`, protocol },
})

/**
 * `bin-<platform>/` folders as the release workflow downloads them: kition, each kit's executable,
 * handshakes.json and kits/<kit>/kit.json.
 */
function bins(platforms, kits, { answers = {} } = {}) {
  const dir = tempDir()
  for (const platform of platforms) {
    const exe = platform.startsWith('win32') ? '.exe' : ''
    const folder = path.join(dir, `bin-${platform}`)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, `kition${exe}`), `kition for ${platform}`)
    fs.writeFileSync(path.join(folder, `kition-kits-mcp${exe}`), 'server')
    const handshakes = {}
    for (const manifest of kits) {
      const kit = manifest.id.slice(4)
      const file = `kition-${kit}${exe}`
      fs.writeFileSync(path.join(folder, file), `${kit} ${manifest.version} for ${platform}`)
      fs.mkdirSync(path.join(folder, 'kits', kit), { recursive: true })
      fs.writeFileSync(path.join(folder, 'kits', kit, 'kit.json'), JSON.stringify(manifest))
      handshakes[file] = { sha256: sha256(path.join(folder, file)), protocolVersion: Number(manifest.headless.protocol.split('/')[1]), kit: { id: manifest.id, version: answers[kit] ?? manifest.version } }
    }
    fs.writeFileSync(path.join(folder, 'handshakes.json'), JSON.stringify(handshakes))
  }
  return dir
}

const listed = (archive) => execFileSync('tar', ['-tzvf', archive], { encoding: 'utf8' }).trim().split('\n')
const BASE1 = 'https://github.com/KitionAI/kition-sdk/releases/download/sdk-v1.0.0'
const BASE2 = 'https://github.com/KitionAI/kition-sdk/releases/download/sdk-v1.1.0'

describe('release-archives: the kition and kit archives, and the kit index', () => {
  it('archives kition and each kit for each platform, and indexes the kits at absolute addresses of this release', () => {
    const out = tempDir()
    const done = writeReleaseArchives({ binDir: bins(['darwin-arm64', 'win32-x64'], [kitJson('note', '0.3.0'), kitJson('table', '0.4.0')]), out, version: '1.0.0' })
    expect(fs.readdirSync(out).sort()).toEqual([
      'kition-1.0.0-darwin-arm64.tar.gz', 'kition-1.0.0-win32-x64.tar.gz',
      'kition-note-0.3.0-darwin-arm64.tar.gz', 'kition-note-0.3.0-win32-x64.tar.gz',
      'kition-table-0.4.0-darwin-arm64.tar.gz', 'kition-table-0.4.0-win32-x64.tar.gz',
      'kits-index.json',
    ])
    // Plain files at the top, the executables executable.
    const kition = listed(path.join(out, 'kition-1.0.0-darwin-arm64.tar.gz'))
    expect(kition.map((line) => line.split(/\s+/).pop())).toEqual(['kition', 'LICENSE'])
    expect(kition[0]).toMatch(/^-rwxr-xr-x/)
    expect(listed(path.join(out, 'kition-1.0.0-win32-x64.tar.gz')).map((line) => line.split(/\s+/).pop())).toEqual(['kition.exe', 'LICENSE'])
    const note = listed(path.join(out, 'kition-note-0.3.0-win32-x64.tar.gz'))
    expect(note.map((line) => line.split(/\s+/).pop())).toEqual(['kit.json', 'kition-note.exe'])
    expect(note[1]).toMatch(/^-rwxr-xr-x/)

    const index = JSON.parse(fs.readFileSync(path.join(out, 'kits-index.json'), 'utf8'))
    expect(schemaProblems(index)).toEqual([])
    expect(index).toEqual(done.index)
    expect(Object.keys(index.kits)).toEqual(['note', 'table'])
    expect(index.kits.note).toMatchObject({ id: 'kit.note', name: 'Note', extensions: ['md'] })
    const archive = path.join(out, 'kition-note-0.3.0-darwin-arm64.tar.gz')
    expect(index.kits.note.versions['0.3.0']).toEqual({
      protocol: 'kition-kit/2',
      platforms: {
        'darwin-arm64': { url: `${BASE1}/kition-note-0.3.0-darwin-arm64.tar.gz`, size: fs.statSync(archive).size, sha256: sha256(archive) },
        'win32-x64': expect.objectContaining({ url: `${BASE1}/kition-note-0.3.0-win32-x64.tar.gz` }),
      },
    })
    expect(done.cli.map((entry) => entry.file)).toEqual(['kition-1.0.0-darwin-arm64.tar.gz', 'kition-1.0.0-win32-x64.tar.gz'])
    expect(done.cli[0].sha256).toBe(sha256(path.join(out, 'kition-1.0.0-darwin-arm64.tar.gz')))
  })

  it('carries every version of the previous index forward and adds the new ones at this release', () => {
    const first = tempDir()
    writeReleaseArchives({ binDir: bins(['darwin-arm64', 'linux-x64'], [kitJson('note', '0.3.0'), kitJson('table', '0.4.0')]), out: first, version: '1.0.0' })
    const previous = JSON.parse(fs.readFileSync(path.join(first, 'kits-index.json'), 'utf8'))

    // The next release builds Note 0.4.0 (now also .markdown) and Table 0.4.0 again.
    const second = tempDir()
    const done = writeReleaseArchives({ binDir: bins(['darwin-arm64', 'linux-x64'], [kitJson('note', '0.4.0', { name: 'Notes', extensions: ['md', 'markdown'] }), kitJson('table', '0.4.0')]), out: second, version: '1.1.0', previous })
    const index = JSON.parse(fs.readFileSync(path.join(second, 'kits-index.json'), 'utf8'))
    expect(schemaProblems(index)).toEqual([])
    expect(Object.keys(index.kits.note.versions)).toEqual(['0.3.0', '0.4.0'])
    // The old version keeps its archive in the release that published it.
    expect(index.kits.note.versions['0.3.0']).toEqual(previous.kits.note.versions['0.3.0'])
    expect(index.kits.note.versions['0.3.0'].platforms['linux-x64'].url).toBe(`${BASE1}/kition-note-0.3.0-linux-x64.tar.gz`)
    expect(index.kits.note.versions['0.4.0'].platforms['linux-x64'].url).toBe(`${BASE2}/kition-note-0.4.0-linux-x64.tar.gz`)
    expect(index.kits.note).toMatchObject({ name: 'Notes', extensions: ['md', 'markdown'] })
    // Table 0.4.0 was published already: its first archive stays, and none is made again.
    expect(index.kits.table).toEqual(previous.kits.table)
    expect(fs.existsSync(path.join(second, 'kition-table-0.4.0-linux-x64.tar.gz'))).toBe(false)
    expect(done.carried.map((entry) => `${entry.kit} ${entry.version} ${entry.platform}`)).toEqual(['table 0.4.0 darwin-arm64', 'table 0.4.0 linux-x64'])
    expect(done.archives.map((entry) => entry.file)).toEqual(['kition-note-0.4.0-darwin-arm64.tar.gz', 'kition-note-0.4.0-linux-x64.tar.gz'])

    // A third release on a new platform adds that platform to the version listed already.
    const third = tempDir()
    writeReleaseArchives({ binDir: bins(['linux-arm64'], [kitJson('note', '0.4.0', { name: 'Notes', extensions: ['md', 'markdown'] })]), out: third, version: '1.2.0', previous: index })
    const grown = JSON.parse(fs.readFileSync(path.join(third, 'kits-index.json'), 'utf8'))
    expect(Object.keys(grown.kits.note.versions['0.4.0'].platforms)).toEqual(['darwin-arm64', 'linux-arm64', 'linux-x64'])
    expect(Object.keys(grown.kits.note.versions)).toEqual(['0.3.0', '0.4.0'])
    expect(grown.kits.table).toEqual(previous.kits.table)
  })

  it('keeps the newest version’s name when this release builds an older one', () => {
    const first = tempDir()
    writeReleaseArchives({ binDir: bins(['linux-x64'], [kitJson('note', '0.5.0', { name: 'Note' })]), out: first, version: '1.0.0' })
    const previous = JSON.parse(fs.readFileSync(path.join(first, 'kits-index.json'), 'utf8'))
    const second = tempDir()
    const done = writeReleaseArchives({ binDir: bins(['linux-x64'], [kitJson('note', '0.4.1', { name: 'Old name' })]), out: second, version: '1.1.0', previous })
    expect(done.index.kits.note.name).toBe('Note')
    expect(Object.keys(done.index.kits.note.versions)).toEqual(['0.4.1', '0.5.0'])
  })

  it('leaves out kits no longer published, and refuses an unpublished kit', () => {
    const previous = {
      schemaVersion: 1,
      kits: { secret: { id: 'kit.secret', name: 'Secret', extensions: ['sec'], versions: { '1.0.0': { protocol: 'kition-kit/2', platforms: { 'linux-x64': { url: 'https://example.com/s.tar.gz', size: 1, sha256: '0'.repeat(64) } } } } } },
    }
    const done = writeReleaseArchives({ binDir: bins(['linux-x64'], [kitJson('note', '0.3.0')]), out: tempDir(), version: '1.0.0', previous })
    expect(done.dropped).toEqual(['secret'])
    expect(Object.keys(done.index.kits)).toEqual(['note'])
    expect(() => writeReleaseArchives({ binDir: bins(['linux-x64'], [kitJson('secret', '1.0.0')]), out: tempDir(), version: '1.0.0' })).toThrow(/secret is not in published-kits.json/)
  })

  it('refuses a previous index it cannot carry forward', () => {
    const binDir = bins(['linux-x64'], [kitJson('note', '0.3.0')])
    const entry = (url, protocol = 'kition-kit/2') => ({ schemaVersion: 1, kits: { note: { id: 'kit.note', name: 'Note', extensions: ['md'], versions: { '0.3.0': { protocol, platforms: { 'darwin-arm64': { url, size: 1, sha256: '0'.repeat(64) } } } } } } })
    expect(() => writeReleaseArchives({ binDir, out: tempDir(), version: '1.1.0', previous: entry('kition-note-0.3.0-darwin-arm64.tar.gz') })).toThrow(/relative address/)
    expect(() => writeReleaseArchives({ binDir, out: tempDir(), version: '1.1.0', previous: entry('https://example.com/a.tar.gz', 'kition-kit/1') })).toThrow(/speaking kition-kit\/1, but this build speaks kition-kit\/2/)
    expect(() => writeReleaseArchives({ binDir, out: tempDir(), version: '1.1.0', previous: { schemaVersion: 2, kits: {} } })).toThrow(/format 2/)
    const bad = entry('https://example.com/a.tar.gz')
    bad.kits.note.versions['0.3.0'].platforms['darwin-arm64'].sha256 = 'XYZ'
    expect(() => writeReleaseArchives({ binDir, out: tempDir(), version: '1.1.0', previous: bad })).toThrow(/not a kit index:\n.*sha256.*does not match/)
  })

  it('refuses an executable that is not the one checked, or answers another version, or a platform that lacks a kit', () => {
    expect(() => writeReleaseArchives({ binDir: bins(['linux-x64'], [kitJson('note', '0.3.0')], { answers: { note: '0.2.9' } }), out: tempDir(), version: '1.0.0' })).toThrow(/answers kit.initialize as kit.note 0.2.9; its kit.json is kit.note 0.3.0/)
    const tampered = bins(['linux-x64'], [kitJson('note', '0.3.0')])
    fs.writeFileSync(path.join(tampered, 'bin-linux-x64', 'kition-note'), 'another build')
    expect(() => writeReleaseArchives({ binDir: tampered, out: tempDir(), version: '1.0.0' })).toThrow(/not the file its handshake was recorded for/)
    const uneven = bins(['linux-x64'], [kitJson('note', '0.3.0')])
    fs.cpSync(bins(['darwin-arm64'], []) + '/bin-darwin-arm64', path.join(uneven, 'bin-darwin-arm64'), { recursive: true })
    expect(() => writeReleaseArchives({ binDir: uneven, out: tempDir(), version: '1.0.0' })).toThrow(/note is built for linux-x64 but not darwin-arm64/)
    const unknown = bins(['linux-x64'], [])
    fs.renameSync(path.join(unknown, 'bin-linux-x64'), path.join(unknown, 'bin-linux-riscv64'))
    expect(() => writeReleaseArchives({ binDir: unknown, out: tempDir(), version: '1.0.0' })).toThrow(/no platform linux-riscv64/)
  })
})

describe('compareVersions and schemaProblems', () => {
  it('orders semver', () => {
    expect(['0.10.0', '0.2.0', '0.2.0-rc.1', '0.2.0-beta', '1.0.0', '0.2.0-rc.10'].sort(compareVersions)).toEqual(['0.2.0-beta', '0.2.0-rc.1', '0.2.0-rc.10', '0.2.0', '0.10.0', '1.0.0'])
  })

  it('checks every rule of the index schema and refuses a keyword it does not know', () => {
    expect(schemaProblems({ schemaVersion: 1, kits: { Note: { id: 'note', name: '', extensions: [], versions: { v1: {} } } } })).toEqual(expect.arrayContaining([
      expect.stringMatching(/Note \(name\).*does not match/),
      expect.stringMatching(/\/kits\/Note\/id.*does not match/),
      expect.stringMatching(/\/kits\/Note\/name: shorter than 1/),
      expect.stringMatching(/\/kits\/Note\/extensions: fewer than 1 items/),
      expect.stringMatching(/v1 \(name\).*does not match/),
      expect.stringMatching(/\/kits\/Note\/versions\/v1: has no protocol/),
    ]))
    expect(schemaProblems({ schemaVersion: 2 })).toEqual(['/: has no kits', '/schemaVersion: is not 1'])
    expect(() => schemaProblems('x', { maxLength: 3 })).toThrow(/keyword maxLength is not checked/)
  })
})
