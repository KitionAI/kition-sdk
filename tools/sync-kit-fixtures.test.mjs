// tools/sync-kit-fixtures.mjs: kition-kits' manifest fixtures (crates/kition-kits/tests/fixtures/
// kits/<kit>.json) are the kits' committed kit.json, byte for byte. Hand-copied snapshots went
// stale, so tests kept asserting a kit had no object model
// after it gained one.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const tool = path.join(root, 'tools/sync-kit-fixtures.mjs')

/** Runs the tool; answers its exit status and output. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [tool, ...args], { stdio: 'pipe', encoding: 'utf8' })
    return { status: 0, output: stdout }
  } catch (error) {
    return { status: error.status, output: `${error.stdout}${error.stderr}` }
  }
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' })

describe('sync-kit-fixtures', () => {
  it("copies each kit repository's committed kit.json, and --check reports one that differs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-fixtures-'))
    const repos = path.join(dir, 'repos')
    const fixtures = path.join(dir, 'fixtures')
    const note = path.join(repos, 'kition-note')
    fs.mkdirSync(note, { recursive: true })
    fs.mkdirSync(fixtures)
    const committed = '{\n  "id": "kit.note",\n  "version": "1.2.3"\n}\n'
    fs.writeFileSync(path.join(note, 'kit.json'), committed)
    git(note, 'init', '-q')
    git(note, 'add', 'kit.json')
    git(note, 'commit', '-q', '-m', 'kit')
    // Another session's uncommitted edit is not copied.
    fs.writeFileSync(path.join(note, 'kit.json'), '{ "id": "kit.note", "version": "9.9.9" }\n')
    fs.writeFileSync(path.join(fixtures, 'note.json'), '{ "id": "kit.note", "version": "0.1.0" }\n')
    fs.writeFileSync(path.join(fixtures, 'unpublished.json'), '{}\n')

    const stale = run(['--check', '--repos', repos, '--fixtures', fixtures])
    expect(stale.status).toBe(1)
    expect(stale.output).toContain('note.json')
    expect(stale.output).toContain('unpublished.json (no such kit)')

    expect(run(['--repos', repos, '--fixtures', fixtures]).status).toBe(0)
    expect(fs.readFileSync(path.join(fixtures, 'note.json'), 'utf8')).toBe(committed)
    expect(fs.existsSync(path.join(fixtures, 'unpublished.json'))).toBe(false)
    expect(run(['--check', '--repos', repos, '--fixtures', fixtures]).status).toBe(0)
  })

  it('passes --check where no kit repository is checked out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-fixtures-'))
    const checked = run(['--check', '--repos', dir, '--fixtures', dir])
    expect(checked.status).toBe(0)
    expect(checked.output).toContain('nothing to check')
  })

  it("match the kits' committed manifests (skipped where the kit repositories aren't checked out)", () => {
    const checked = run(['--check'])
    expect(checked.status, checked.output).toBe(0)
  })
})
