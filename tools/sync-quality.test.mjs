import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sync-quality.mjs')
const dirs = []

function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-quality-'))
  dirs.push(dir)
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  return dir
}

function sync(dir, ...extra) {
  const result = spawnSync(process.execPath, [tool, dir, '--owner', '@example-owner', '--name', 'Kition Example', ...extra], {
    encoding: 'utf8',
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function snapshot(dir) {
  const files = {}
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[path.relative(dir, full)] = `${fs.statSync(full).mode & 0o777}:${fs.readFileSync(full, 'utf8')}`
    }
  }
  walk(dir)
  return files
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('sync-quality', () => {
  it('writes every file into an empty repository, and a second run changes nothing', () => {
    const dir = tempRepo()
    expect(sync(dir).code).toBe(0)
    const first = snapshot(dir)
    expect(Object.keys(first).sort()).toEqual([
      '.claude/CLAUDE.md',
      '.claude/hooks/quality-gate.sh',
      '.claude/settings.json',
      '.github/CODEOWNERS',
      'AGENTS.md',
      'docs/quality.md',
    ])
    expect(first['AGENTS.md']).toContain('## Quality rules (read first)')
    expect(first['docs/quality.md']).toContain('cargo xtask ci')
    expect(first['docs/quality.md']).not.toMatch(/\{\{\w+\}\}/)
    // Claude Code resolves an import relative to the file that contains it.
    const claude = /^@(\S+)$/m.exec(first['.claude/CLAUDE.md'])?.[1]
    expect(claude).toBe('../AGENTS.md')
    expect(fs.existsSync(path.resolve(dir, '.claude', claude))).toBe(true)
    expect(first['.github/CODEOWNERS']).toContain('/docs/quality.md @example-owner')
    expect(first['.github/CODEOWNERS']).toContain('/cases/waivers.yaml @example-owner')
    expect(first['.github/CODEOWNERS']).toContain('**/expected/ @example-owner')
    expect(first['.claude/hooks/quality-gate.sh'].startsWith('493:')).toBe(true)

    const second = sync(dir)
    expect(second.code).toBe(0)
    expect(second.out).toContain('up to date')
    expect(snapshot(dir)).toEqual(first)
    expect(sync(dir, '--verify').code).toBe(0)
  })

  it('puts the section after the first heading and keeps existing rules and settings', () => {
    const agents = '# Kition kit rules (read first)\n\nThese rules come first.\n'
    const settings = '{\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n'
    const dir = tempRepo({ 'AGENTS.md': agents, '.claude/settings.json': settings })
    expect(sync(dir, '--command', "cargo test -p 'kit'").code).toBe(0)
    const text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    expect(text.startsWith('# Kition kit rules (read first)\n\n<!-- kition-quality:begin')).toBe(true)
    expect(text.endsWith('kition-quality:end -->\n\nThese rules come first.\n')).toBe(true)
    expect(text).toContain("run `cargo test -p 'kit'`")
    const merged = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'))
    expect(merged.permissions.allow).toEqual(['Bash(ls)'])
    expect(merged.hooks.Stop).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, '.claude/hooks/quality-gate.sh'), 'utf8')).toContain(`CHECK_COMMAND='cargo test -p '\\''kit'\\'''`)

    const first = snapshot(dir)
    expect(sync(dir, '--command', "cargo test -p 'kit'").code).toBe(0)
    expect(snapshot(dir)).toEqual(first)
  })

  // The protocol documentation gate excludes dependency and build folders.
  it("takes a listed repository's check command from the table, and refuses one that disagrees", () => {
    const dir = path.join(tempRepo(), 'khp')
    fs.mkdirSync(dir)
    const gate = "! grep -rIlE '/(Users|home)/[a-z]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist ."
    expect(sync(dir).code).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain(`run \`${gate}\``)
    expect(fs.readFileSync(path.join(dir, 'docs/quality.md'), 'utf8')).toContain(`\n${gate}\n`)
    expect(fs.readFileSync(path.join(dir, '.claude/hooks/quality-gate.sh'), 'utf8')).toContain(
      "CHECK_COMMAND='! grep -rIlE '\\''/(Users|home)/[a-z]'\\'' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist .'",
    )
    expect(sync(dir, '--command', gate, '--verify').code).toBe(0)
    const old = sync(dir, '--command', "! grep -rIlE '/(Users|home)/[a-z]' --exclude-dir=.git .")
    expect(old.code).toBe(2)
    expect(old.err).toContain('templates/quality/repositories.json')
  })

  it('verify reports drift without writing', () => {
    const dir = tempRepo()
    expect(sync(dir).code).toBe(0)
    fs.appendFileSync(path.join(dir, 'docs/quality.md'), '\nRepository notes stay outside the block.\n')
    expect(sync(dir, '--verify').code).toBe(0)
    const agents = path.join(dir, 'AGENTS.md')
    fs.writeFileSync(agents, fs.readFileSync(agents, 'utf8').replace('Tests are the spec.', 'Tests are a hint.'))
    const result = sync(dir, '--verify')
    expect(result.code).toBe(1)
    expect(result.out).toContain('differs: AGENTS.md')
    expect(fs.readFileSync(agents, 'utf8')).toContain('Tests are a hint.')
  })

  it('reports a file left at an old location, and writes nothing until it is moved', () => {
    const old = { 'CLAUDE.md': '# Notes\n\nOwn text.\n', 'QUALITY.md': 'Own quality notes.\n', 'kit-waivers.yaml': 'kit: example\n' }
    const dir = tempRepo(old)
    const lines = [
      'old location: CLAUDE.md (move it: mkdir -p .claude && git mv CLAUDE.md .claude/CLAUDE.md)',
      'old location: QUALITY.md (move it: mkdir -p docs && git mv QUALITY.md docs/quality.md)',
      'old location: kit-waivers.yaml (move it: mkdir -p cases && git mv kit-waivers.yaml cases/waivers.yaml)',
    ]
    const verify = sync(dir, '--verify')
    expect(verify.code).toBe(1)
    for (const line of lines) expect(verify.out).toContain(`${line}\n`)
    expect(verify.out).toContain('missing: docs/quality.md')
    const write = sync(dir)
    expect(write.code).toBe(1)
    expect(write.out).toContain(lines[0])
    expect(Object.keys(snapshot(dir)).sort()).toEqual(Object.keys(old).sort())

    for (const [from, to] of [['CLAUDE.md', '.claude/CLAUDE.md'], ['QUALITY.md', 'docs/quality.md'], ['kit-waivers.yaml', 'cases/waivers.yaml']]) {
      fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true })
      fs.renameSync(path.join(dir, from), path.join(dir, to))
    }
    expect(sync(dir).code).toBe(0)
    const claude = fs.readFileSync(path.join(dir, '.claude/CLAUDE.md'), 'utf8')
    expect(claude.startsWith('# Notes\n\n<!-- kition-quality:begin')).toBe(true)
    expect(claude.endsWith('kition-quality:end -->\n\nOwn text.\n')).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'docs/quality.md'), 'utf8').endsWith('\nOwn quality notes.\n')).toBe(true)
    expect(sync(dir, '--verify')).toMatchObject({ code: 0, out: 'sync-quality: up to date\n' })

    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Left behind.\n')
    const both = sync(dir, '--verify')
    expect(both.code).toBe(1)
    expect(both.out).toBe("old location: CLAUDE.md (.claude/CLAUDE.md exists: keep the repository's own text in .claude/CLAUDE.md, then git rm CLAUDE.md)\n")
  })
})
