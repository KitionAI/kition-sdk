// KitionAI/kition's kit lock as the release and the SDK bundle read it (tools/kit-lock.mjs): an npm
// pin per kit, its packages named from the kit and the scope, never a GitHub Release pin.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { lockPin, lockPins, PIN_FIELDS } from './kit-lock.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const integrity = (text) => `sha512-${crypto.createHash('sha512').update(text).digest('base64')}`
const commit = (digit) => digit.repeat(40)

/** An npm pin as KitionAI/kition's scripts/pin-kits.mjs writes it (its fields in its order). */
const npmPin = (scope, overrides = {}) => ({
  scope,
  version: '0.1.5',
  commit: commit('a'),
  sdkCommit: commit('b'),
  tesseraCommit: commit('c'),
  fontsCommit: commit('d'),
  editor: { integrity: integrity('editor'), size: 13023500 },
  platforms: { 'darwin-arm64': { integrity: integrity('darwin-arm64'), size: 4100000 }, 'linux-x64': { integrity: integrity('linux-x64'), size: 4300000 } },
  ...overrides,
})

/** A GitHub Release pin, the form Kition's lock on main still has. */
const releasePin = {
  repository: 'KitionAI/kition-note',
  version: '0.1.5',
  tag: 'package-v0.1.5',
  asset: 'kition-note-0.1.5.tgz',
  size: 9437398,
  sha256: 'f'.repeat(64),
  commit: commit('a'),
  sdkCommit: commit('b'),
  tesseraCommit: commit('c'),
  fontsCommit: commit('d'),
}

const scratch = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const writeLock = (entries) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-lock-'))
  scratch.push(dir)
  const file = path.join(dir, 'kits.lock.json')
  fs.writeFileSync(file, `${JSON.stringify({ $comment: 'the kit packages Kition ships', ...entries }, null, 2)}\n`)
  return file
}

describe("Kition's kit lock: an npm pin per kit, its packages named from the kit and the scope", () => {
  it('names the packages of a pin by the scope’s layout, and carries what the pin has', () => {
    const stage = lockPin('note', npmPin('@kitionstage'))
    expect(stage.editor).toEqual({ package: '@kitionstage/note', integrity: integrity('editor'), size: 13023500 })
    expect(stage.platforms).toEqual({
      'darwin-arm64': { package: '@kitionstage/note-darwin-arm64', integrity: integrity('darwin-arm64'), size: 4100000 },
      'linux-x64': { package: '@kitionstage/note-linux-x64', integrity: integrity('linux-x64'), size: 4300000 },
    })
    expect(stage).toMatchObject({ kit: 'note', scope: '@kitionstage', version: '0.1.5', commit: commit('a'), sdkCommit: commit('b'), tesseraCommit: commit('c'), fontsCommit: commit('d') })
    // @kition keeps the legacy names until the cutover (tools/kit-npm.mjs LEGACY_LAYOUT_SCOPES).
    const real = lockPin('note', npmPin('@kition'), { scope: '@kition' })
    expect(real.editor.package).toBe('@kition/kit-note-ui')
    expect(real.platforms['darwin-arm64'].package).toBe('@kition/kit-note-darwin-arm64')
    // A pin with no platform package yet is still a pin of its editor.
    expect(lockPin('html', npmPin('@kitionstage', { platforms: {} })).platforms).toEqual({})
    expect(PIN_FIELDS).toEqual(['scope', 'version', 'commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit', 'editor', 'platforms'])
  })

  it('refuses a GitHub Release pin, a package field, and every malformed or missing field, naming each', () => {
    expect(() => lockPin('note', releasePin)).toThrow(/note: a GitHub Release pin \(repository KitionAI\/kition-note, asset kition-note-0\.1\.5\.tgz\); the release takes kits from npm only/)
    // The names are derived: a pin that writes one down is not Kition's form.
    expect(() => lockPin('note', npmPin('@kitionstage', { package: '@kitionstage/note' }))).toThrow(/package is not a pin's/)
    expect(() => lockPin('note', undefined)).toThrow(/the lock pins no note/)
    const broken = npmPin('kitionstage', {
      version: 'v1',
      sdkCommit: 'abc',
      editor: { integrity: 'sha1-x', size: 0, url: 'x' },
      platforms: { 'linux-x64-musl': { integrity: integrity('x'), size: 1 }, 'win32-x64': { size: 1 } },
    })
    const message = (() => {
      try {
        lockPin('note', broken)
      } catch (error) {
        return error.message
      }
    })()
    for (const part of [/version v1 is not a version/, /no valid sdkCommit/, /scope is "kitionstage", not an npm scope/, /editor has url beside integrity and size/, /editor\.integrity sha1-x is not an npm integrity/, /editor\.size 0 is not a size/, /platform linux-x64-musl is not one of/, /platforms\.win32-x64\.integrity missing/]) expect(message).toMatch(part)
    // In layout 1 a kit may not be named like another package of the scope.
    expect(() => lockPin('sdk', npmPin('@kitionstage'))).toThrow(/sdk is not a kit name in @kitionstage/)
    // The release takes kits of its own scope only.
    expect(() => lockPin('note', npmPin('@kitionstage'), { scope: '@kition' })).toThrow(/scope @kitionstage is not the release's @kition/)
  })

  it('reads a lock file and names every kit it cannot take; the command prints each kit or fails', () => {
    const good = writeLock({ note: npmPin('@kitionstage'), table: npmPin('@kitionstage', { version: '0.2.0' }) })
    expect(lockPins(good, ['note', 'table']).map((pin) => `${pin.kit} ${pin.version} ${pin.editor.package}`)).toEqual(['note 0.1.5 @kitionstage/note', 'table 0.2.0 @kitionstage/table'])
    const mixed = writeLock({ note: releasePin, table: npmPin('@kitionstage') })
    expect(() => lockPins(mixed, ['note', 'table', 'cad'])).toThrow(/kits\.lock\.json pins kits a release cannot take:\n {2}note: a GitHub Release pin.*\n {2}cad: the lock pins no cad/)
    const run = (...args) => spawnSync(process.execPath, [path.join(root, 'tools/kit-lock.mjs'), ...args], { encoding: 'utf8' })
    const ok = run(good, '--scope', '@kitionstage', '--kits', 'note,table')
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout.trim().split('\n')).toEqual([`note 0.1.5 @kitionstage/note ${commit('a')}`, `table 0.2.0 @kitionstage/table ${commit('a')}`])
    const wrongScope = run(good, '--scope', '@kition', '--kits', 'note')
    expect(wrongScope.status).toBe(1)
    expect(wrongScope.stderr).toMatch(/scope @kitionstage is not the release's @kition/)
    // Without --kits: every published kit (published-kits.json).
    const all = run(good)
    expect(all.status).toBe(1)
    expect(all.stderr).toMatch(/board: the lock pins no board/)
  })
})
