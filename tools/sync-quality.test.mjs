import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { qualityRepository } from './quality-repositories.mjs'

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

/** Runs the tool with only the given arguments: every value from the data. */
function bare(dir, ...extra) {
  const result = spawnSync(process.execPath, [tool, dir, ...extra], { encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

/** An empty repository in a directory named `name`, so the tool finds its data. */
function namedRepo(name, files = {}) {
  const dir = path.join(tempRepo(), name)
  for (const [file, text] of Object.entries({ '.keep': '', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  return dir
}

const readIn = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')
/** How often `part` occurs in `text`. */
const count = (text, part) => text.split(part).length - 1

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

describe('sync-quality: where the checks run', () => {
  const FMT = 'cargo fmt --all -- --check'

  // A kit's pre-finish check is the fmt check; its full checks run in the kit's CI run. No
  // sentence about the full checks may name the fmt check (it said a unit test is one "that
  // `cargo fmt --all -- --check` already runs" and a commit "is refused by" it).
  it("a kit-CI repository: the fmt check is the pre-finish check, and the full checks are the kit's CI run", () => {
    const dir = namedRepo('kition-design')
    expect(bare(dir).code).toBe(0)
    const quality = readIn(dir, 'docs/quality.md')
    const agents = readIn(dir, 'AGENTS.md')
    expect(quality).toContain('# Quality: Kition Design\n')
    expect(readIn(dir, '.github/CODEOWNERS')).toContain('/docs/quality.md @KitionAI/owners\n')
    // The check is named only as the pre-finish check: in the code block, and once in AGENTS.md.
    expect(count(quality, FMT)).toBe(1)
    expect(quality).toContain(`The pre-finish check, which you run before you finish any task:\n\n\`\`\`sh\n${FMT}\n\`\`\`\n`)
    expect(count(agents, FMT)).toBe(1)
    expect(agents).toContain(`- Before you finish any task, run \`${FMT}\`. If it fails, the task is not done.`)
    expect(readIn(dir, '.claude/hooks/quality-gate.sh')).toContain(`CHECK_COMMAND='${FMT}'\n`)
    // The sentences about the full checks.
    expect(quality).toContain(
      "| `unit` | Not executed by the case runner: the case points at an existing test (`cargo-test` or `exec` step) that the full checks (the kit's CI run, see How to run) already include. The runner only checks the test exists, so the catalogue links to it | (inside the full checks) | Not done: the kit's CI run fails; cannot merge |",
    )
    expect(quality).toContain("| `gate` | Every commit, every PR, before a task is done (`cargo xtask gate --affected`, in the full checks; all before merge) |")
    expect(quality).toContain("This check is the fast local part. The full checks and tests run on GitHub, not on your machine,\nin the kit's CI run:")
    expect(quality).toContain("A task is done only when HEAD has a passing CI run and is on `origin/main`: push it\nwith Kition's `scripts/kit-ci.sh`")
    expect(quality).toContain("   the task is not done.\n   Then report the result of the kit's CI run of HEAD: the task is done only when it passes and\n   HEAD is on `origin/main`.\n3. Run")
    expect(quality).toContain("4. Put the case id in the commit message (`Cases: <id>, …`); the change is done when the case\n   passes in the kit's CI run.")
    expect(quality).not.toContain('This check is also the full check')
    expect(quality).not.toContain("the repository's CI run")
    expect(agents).toContain("- The full checks and tests run on GitHub, in the kit's CI run, not on your machine: a task is\n  done only when HEAD has a passing CI run and is on `origin/main`.")
    expect(agents).not.toContain("the repository's CI run")
    expect(bare(dir, '--verify')).toMatchObject({ code: 0, out: 'sync-quality: up to date\n' })
  })

  it('a local-checks repository: the check is the full check, and no sentence names CI', () => {
    const dir = namedRepo('kition-local')
    expect(bare(dir).code).toBe(0)
    const quality = readIn(dir, 'docs/quality.md')
    const agents = readIn(dir, 'AGENTS.md')
    expect(quality).toContain('# Quality: kition-local\n')
    expect(quality).toContain(
      '| `unit` | Not executed by the case runner: the case points at an existing test (`cargo-test` or `exec` step) that the full checks (`cargo xtask ci`, see How to run) already include. The runner only checks the test exists, so the catalogue links to it | (inside the full checks) | Not done: `cargo xtask ci` fails; cannot merge |',
    )
    expect(quality).toContain('```sh\ncargo xtask ci\n```\n\nThe task is not done until it exits 0.')
    expect(quality).toContain('This check is also the full check: the full checks and tests run on your machine, by this\ncommand.')
    expect(quality).toContain('   the task is not done.\n3. Run')
    expect(quality).toContain('the change is done when the case\n   passes in `cargo xtask ci`.')
    for (const text of [quality, agents]) {
      expect(text).not.toMatch(/CI run\b/)
      expect(text).not.toContain('kit-ci.sh')
    }
    expect(agents).toContain('- Before you finish any task, run `cargo xtask ci`. If it fails, the task is not done.')
  })

  it("a repository whose full checks run in its own CI says so, and takes its product name from the family's data", () => {
    const sdk = namedRepo('kition-sdk')
    expect(bare(sdk).code).toBe(0)
    const quality = readIn(sdk, 'docs/quality.md')
    expect(quality).toContain('# Quality: Kition SDK\n')
    expect(quality).toContain("that the full checks (the repository's CI run, see How to run) already include")
    expect(quality).toContain("The full checks and tests run on GitHub, in the repository's CI run\n(`.github/workflows/ci.yml`) on every push to `main` and every pull request.")
    expect(readIn(sdk, 'AGENTS.md')).toContain("- The full checks and tests run on GitHub, in the repository's CI run (`.github/workflows/ci.yml`)")
    expect(quality).not.toContain("kit's CI run")
    // Kition Desktop is the family product that lives in kition; khp's name is in the quality table.
    const desktop = namedRepo('kition')
    expect(bare(desktop).code).toBe(0)
    expect(readIn(desktop, 'docs/quality.md')).toContain('# Quality: Kition Desktop\n')
    const khp = namedRepo('khp')
    expect(bare(khp).code).toBe(0)
    expect(readIn(khp, 'docs/quality.md')).toContain('# Quality: Kit Harness Protocol\n')
  })

  it('takes the title and the owner from the data, and --name and --owner override them', () => {
    const dir = namedRepo('kition-cad')
    expect(bare(dir, '--name', 'Other', '--owner', '@someone').code).toBe(0)
    expect(readIn(dir, 'docs/quality.md')).toContain('# Quality: Other\n')
    expect(readIn(dir, '.github/CODEOWNERS')).toContain('**/expected/ @someone\n')
    const differs = bare(dir, '--verify')
    expect(differs.code).toBe(1)
    expect(differs.out).toContain('differs: docs/quality.md\ndiffers: .github/CODEOWNERS\n')
    expect(bare(dir).code).toBe(0)
    expect(readIn(dir, 'docs/quality.md')).toContain('# Quality: Kition CAD\n')
    expect(bare(dir, '--verify')).toMatchObject({ code: 0, out: 'sync-quality: up to date\n' })
  })

  it("warns about a repository's own lines that contradict the generated block, and never fails for them", () => {
    const own = [
      '# Kition kit rules (read first)',
      '',
      '- No CI workflows in this repository besides the Package workflow (`.github/workflows/package.yml`),',
      '- `cargo xtask ci` before every commit. Parallel agents: separate `CARGO_TARGET_DIR` per agent.',
      '- `cargo xtask assets` (part of `cargo xtask ci`) fails otherwise.',
      '',
      '### Quality gates (before every commit)',
      '',
      '`cargo xtask ci` (fmt, clippy -D warnings, tests, layers, assets, wasm), and for editor changes',
      '',
    ].join('\n')
    const dir = namedRepo('kition-layout', { 'AGENTS.md': own, '.claude/CLAUDE.md': '# Notes\n\n- **Quality gates** before every commit: `cargo fmt --check`, `cargo test --workspace`.\n' })
    const write = bare(dir)
    expect(write.code).toBe(0)
    // Line numbers are those of the files as written: the generated block moved the lines down.
    const agents = readIn(dir, 'AGENTS.md').split('\n')
    const at = (start) => agents.findIndex((line) => line.startsWith(start)) + 1
    const claude = readIn(dir, '.claude/CLAUDE.md').split('\n')
    const expected = [
      `warning: AGENTS.md:${at('- No CI')}: forbids CI; the full checks run on GitHub: - No CI workflows in this repository besides the Package workflow (\`.github/workflows/package.yml\`),`,
      `warning: AGENTS.md:${at('- \`cargo xtask ci\` before')}: asks for the full checks on this machine before a commit or a task; they run in the kit's CI run: - \`cargo xtask ci\` before every commit. Parallel agents: separate \`CARGO_TARGET_DIR\` per agent.`,
      `warning: AGENTS.md:${at('\`cargo xtask ci\` (fmt')}: asks for the full checks on this machine before a commit or a task; they run in the kit's CI run: \`cargo xtask ci\` (fmt, clippy -D warnings, tests, layers, assets, wasm), and for editor changes`,
      `warning: .claude/CLAUDE.md:${claude.findIndex((line) => line.includes('Quality gates')) + 1}: asks for the full checks on this machine before a commit or a task; they run in the kit's CI run: - **Quality gates** before every commit: \`cargo fmt --check\`, \`cargo test --workspace\`.`,
    ]
    expect(write.out.split('\n').filter((line) => line.startsWith('warning:'))).toEqual(expected)
    const verify = bare(dir, '--verify')
    expect(verify.code).toBe(0)
    expect(verify.out).toBe(`${expected.join('\n')}\nsync-quality: up to date\n`)
    // The generated block itself names CI and the kit's CI run: never a warning.
    expect(readIn(dir, 'AGENTS.md')).toContain("in the kit's CI run, not on your machine")

    // Where the full checks are local, a repository may forbid CI and ask for its check before a commit.
    const local = namedRepo('khp', { 'AGENTS.md': own })
    expect(bare(local).out).not.toContain('warning:')
  })

  it('reads the quality table: one source for a name, known fields and kinds only', () => {
    const community = { repositories: { 'kition-x': { title: 'Kition X' } }, family: { products: [{ id: 'p', name: 'Product P', repo: 'p' }] } }
    const table = (entry) => ({ owner: '@KitionAI/owners', repositories: { 'kition-x': entry, p: {}, q: { name: 'Q' } } })
    expect(qualityRepository('kition-x', { table: table({ check: 'make', fullChecks: 'kit-ci' }), community })).toEqual({
      listed: true,
      name: 'Kition X',
      check: 'make',
      fullChecks: 'kit-ci',
      owner: '@KitionAI/owners',
    })
    expect(qualityRepository('p', { table: table({}), community })).toMatchObject({ name: 'Product P', check: 'cargo xtask ci', fullChecks: 'check' })
    expect(qualityRepository('q', { table: table({}), community }).name).toBe('Q')
    expect(qualityRepository('elsewhere', { table: table({}), community })).toMatchObject({ listed: false, name: null })
    expect(() => qualityRepository('kition-x', { table: table({ name: 'Kition X' }), community })).toThrow('give it there only')
    expect(() => qualityRepository('kition-x', { table: table({ fullChecks: 'local' }), community })).toThrow('fullChecks must be one of kit-ci, ci, check')
    expect(() => qualityRepository('kition-x', { table: table({ command: 'make' }), community })).toThrow('unknown field command')
    expect(() => qualityRepository('kition-x', { table: table({ check: 'a\nb' }), community })).toThrow('one line without backticks')
    expect(() => qualityRepository('kition-x', { table: { ...table({}), owner: 'owners' }, community })).toThrow('owner must look like')
  })
})
