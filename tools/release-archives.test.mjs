import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeReleaseArchives } from './release-archives.mjs'

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

/**
 * `bin-<platform>/` folders as the release workflow downloads them: kition, kition-kits-mcp, and
 * a published kit's executable with its kits/<kit>/kit.json (which the bundle carries, and no
 * archive of this tool).
 */
function bins(platforms) {
  const dir = tempDir()
  for (const platform of platforms) {
    const exe = platform.startsWith('win32') ? '.exe' : ''
    const folder = path.join(dir, `bin-${platform}`)
    fs.mkdirSync(path.join(folder, 'kits', 'note'), { recursive: true })
    fs.writeFileSync(path.join(folder, `kition${exe}`), `kition for ${platform}`)
    fs.writeFileSync(path.join(folder, `kition-kits-mcp${exe}`), 'server')
    fs.writeFileSync(path.join(folder, `kition-note${exe}`), `note for ${platform}`)
    fs.writeFileSync(path.join(folder, 'kits', 'note', 'kit.json'), JSON.stringify({ id: 'kit.note', version: '0.1.0' }))
  }
  return dir
}

const listed = (archive) => execFileSync('tar', ['-tzvf', archive], { encoding: 'utf8' }).trim().split('\n')

describe('release-archives: the kition archives of an SDK release', () => {
  it('archives kition for each platform, and no kit and no kit index', () => {
    const out = tempDir()
    const done = writeReleaseArchives({ binDir: bins(['darwin-arm64', 'win32-x64']), out, version: '1.0.0' })
    expect(fs.readdirSync(out).sort()).toEqual(['kition-1.0.0-darwin-arm64.tar.gz', 'kition-1.0.0-win32-x64.tar.gz'])
    // Plain files at the top, the executable executable.
    const kition = listed(path.join(out, 'kition-1.0.0-darwin-arm64.tar.gz'))
    expect(kition.map((line) => line.split(/\s+/).pop())).toEqual(['kition', 'LICENSE'])
    expect(kition[0]).toMatch(/^-rwxr-xr-x/)
    expect(listed(path.join(out, 'kition-1.0.0-win32-x64.tar.gz')).map((line) => line.split(/\s+/).pop())).toEqual(['kition.exe', 'LICENSE'])
    expect(done.cli.map((entry) => entry.file)).toEqual(['kition-1.0.0-darwin-arm64.tar.gz', 'kition-1.0.0-win32-x64.tar.gz'])
    expect(done.cli[0].sha256).toBe(sha256(path.join(out, 'kition-1.0.0-darwin-arm64.tar.gz')))
    expect(done.cli[0].size).toBe(fs.statSync(path.join(out, 'kition-1.0.0-darwin-arm64.tar.gz')).size)
  })

  it('refuses a platform it does not know, a folder without kition, and a folder of no platform', () => {
    const unknown = bins(['linux-x64'])
    fs.renameSync(path.join(unknown, 'bin-linux-x64'), path.join(unknown, 'bin-linux-riscv64'))
    expect(() => writeReleaseArchives({ binDir: unknown, out: tempDir(), version: '1.0.0' })).toThrow(/no platform linux-riscv64/)
    const without = bins(['linux-x64'])
    fs.rmSync(path.join(without, 'bin-linux-x64', 'kition'))
    expect(() => writeReleaseArchives({ binDir: without, out: tempDir(), version: '1.0.0' })).toThrow(/has no kition/)
    expect(() => writeReleaseArchives({ binDir: tempDir(), out: tempDir(), version: '1.0.0' })).toThrow(/holds no bin-<platform>\/ folder/)
  })
})
