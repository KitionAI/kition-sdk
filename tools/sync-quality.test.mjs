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
    expect(quality).toContain(
      "which runs fmt,\nclippy, `cargo test --workspace`, the kit's `cargo xtask ci` and every `test`\nand `test:*` script of `web/` (and of the root, when it has a pnpm lockfile).\nA task",
    )
    expect(quality).toContain('When the gate runner arrives, this section names `cargo xtask gate --affected`')
    expect(quality).toContain('Written by `cargo xtask features`; the check fails when it differs from `cases/`')
    expect(quality).toContain('Only `self` references may be blessed, with `cargo xtask gate --bless <case-id>`, and only')
    expect(agents).toContain('- Never start `cargo xtask eval` (the real-model `layer: eval` cases)')
    expect(quality).not.toContain('no `tools/xtask`')
    expect(quality).toContain("A task is done only when HEAD has a passing CI run and is on `origin/main`: push it\nwith Kition's `scripts/kit-ci.sh`")
    expect(quality).toContain("   the task is not done.\n   Then report the result of the kit's CI run of HEAD: the task is done only when it passes and\n   HEAD is on `origin/main`.\n3. Run")
    expect(quality).toContain("4. Put the case id in the commit message (`Cases: <id>, …`); the change is done when the case\n   passes in the kit's CI run.")
    expect(quality).not.toContain('This check is also the full check')
    expect(quality).not.toContain("the repository's CI run")
    expect(agents).toContain("- The full checks and tests run on GitHub, in the kit's CI run, not on your machine: a task is\n  done only when HEAD has a passing CI run and is on `origin/main`.")
    expect(agents).not.toContain("the repository's CI run")
    expect(bare(dir, '--verify')).toMatchObject({ code: 0, out: 'sync-quality: up to date\n' })
  })

  // A kit without tools/xtask (kition-table, kition-html): Kition's kit-ci.yml skips the
  // `cargo xtask ci` step, and there is no `cargo xtask gate`, `features` or `eval`. No sentence
  // may name them; each says what runs instead.
  it('a kit without xtask: no sentence names a cargo xtask command; each says what runs instead', () => {
    const dir = namedRepo('kition-table')
    expect(bare(dir).code).toBe(0)
    const quality = readIn(dir, 'docs/quality.md')
    const agents = readIn(dir, 'AGENTS.md')
    for (const text of [quality, agents]) expect(text).not.toMatch(/`cargo xtask (ci|gate|features|eval)/)
    expect(quality).toContain(
      "| `gate` | Every commit, every PR, before a task is done (the tests its `cargo-test`, `exec` and `flow` steps name, which the full checks include; all before merge) |",
    )
    expect(quality).toContain("| `eval` | Only when a maintainer starts it (kition-sdk's `tools/eval-cases.mjs`, F-QA-16):")
    expect(quality).toContain(
      "which runs fmt,\nclippy, `cargo test --workspace`, and every `test`\nand `test:*` script of `web/` (and of the root, when it has a pnpm lockfile); its\n`cargo xtask` step is skipped, since this kit has no `tools/xtask`.\nA task",
    )
    expect(quality).toContain(
      'This repository has no `cargo xtask`, so no case runner: a gating test is the test its case\'s\nsteps name, and the full checks run it. To run one alone, run its step: `cargo test -p <package>\n--test <test> <filter>` for a `cargo-test` step, the `cmd` of an `exec` step, or the scenario of a\n`flow` step.',
    )
    expect(quality).not.toContain('When the gate runner arrives')
    expect(quality).toContain("| `cases` | list<string> | yes | Case ids whose `feature` is this id. Kept by hand: add a case's id here in the commit that adds the case |")
    expect(quality).toContain('Only `self` references may be blessed, by rerunning the test or script that writes them, and only')
    expect(agents).toContain("- Never start kition-sdk's `tools/eval-cases.mjs` (the real-model `layer: eval` cases)")
    expect(bare(dir, '--verify')).toMatchObject({ code: 0, out: 'sync-quality: up to date\n' })
  })

  // The workspace rule, once and for every repository: no rule about one kit's worktrees.
  it('says the workspace rule on checkouts once, for every repository', () => {
    for (const name of ['kition-pdf', 'kition-table', 'kition-sdk', 'khp']) {
      const agents = readIn((() => {
        const dir = namedRepo(name)
        bare(dir)
        return dir
      })(), 'AGENTS.md')
      expect(count(agents, "- Commit on `main` in the repository's main checkout: no git worktrees, and one agent per\n  repository at a time.\n")).toBe(1)
      expect(agents).not.toContain('kition-slide')
    }
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

  // The rule asks for a sentence that REQUIRES the full command before a commit or a task's end.
  // Real lines from the kits: before, when they still required `cargo xtask ci` before every
  // commit (kition-doc 08858885^, kition-cad 6197c137^, kition-layout 049a18de^), and after, when
  // they say the full checks run in the kit's CI run; the kits renamed "Quality gates" to silence
  // the old rule, so the after lines are also checked under their old heading and label.
  it('warns about a requirement to run the full checks locally, not about a line that says they run in CI', () => {
    const before = [
      '## Quality gates',
      'Before every commit: `cargo xtask ci` (fmt, clippy -D warnings, tests, assets, layers, wasm). Commit after every arc of work that builds.',
      '',
      '- **Quality gates** before every commit: `cargo xtask ci` (fmt, clippy -D warnings, tests, assets, layers, wasm). Commit after every feature arc that builds, and push to `main`.',
      '- **Quality gates** before every commit: `cargo xtask ci` (fmt, clippy -D warnings, tests, assets, layers, wasm). One task id per commit (`M2.1: type tool caret navigation`).',
      '',
    ]
    const after = [
      '## Quality gates',
      "On this machine run only the fast checks: `cargo fmt --all -- --check`, `cargo check -p <touched crates> --all-targets`, the wasm check (`cargo xtask wasm`) and `pnpm typecheck` in `web/`. Commit after every arc of work that builds. The full checks run in the kit's CI run on GitHub (`.github/workflows/ci.yml`, which calls Kition's reusable kit CI): clippy, `cargo test --workspace`, `cargo xtask ci` (fmt, clippy -D warnings, tests, assets, layers, wasm) and every `test:*` script of `web/`. A task is done when the CI run of HEAD passes and HEAD is on `origin/main` (Kition's `scripts/kit-ci.sh` `push`, `wait`, `land`). Add no other workflows, and do not start the Package workflow (`.github/workflows/package.yml`): releasing is the owner's step.",
      '',
      "- **Quality gates.** On this machine run only the fast checks: `cargo fmt --all -- --check`, `cargo check -p <touched crates> --all-targets`, the wasm check (`cargo xtask wasm`) and `pnpm typecheck` in `web/`. Commit after every feature arc that builds. The full checks run in the kit's CI run on GitHub (`.github/workflows/ci.yml`, which calls Kition's reusable kit CI): clippy, `cargo test --workspace`, `cargo xtask ci` (fmt, clippy -D warnings, tests, assets, layers, wasm) and every `test:*` script of `web/`. A task is done when the CI run of HEAD passes and HEAD is on `origin/main` (Kition's `scripts/kit-ci.sh` `push`, `wait`, `land`); never push untested commits to `main`. Add no other workflows, and do not start the Package workflow (`.github/workflows/package.yml`): releasing is the owner's step.",
      "- **Quality gates run in the kit's CI run** on GitHub, not on this machine. Locally, run only the fast checks: `cargo fmt --all -- --check`, `cargo check -p <touched crates> --all-targets`, the wasm `cargo check` (`cargo check --target wasm32-unknown-unknown -p <touched crate>`) and `pnpm typecheck` in `web/`. The full checks (clippy, `cargo test --workspace`, `cargo xtask ci` — fmt, clippy -D warnings, tests, assets, layers, wasm — and every `test:*` script of `web/`) run in the CI run that `.github/workflows/ci.yml` starts through Kition's reusable kit CI; add no other workflow, and never start the Package workflow (releasing is the owner's step). A task is done when the CI run of HEAD is green and HEAD is on `origin/main` (Kition's `scripts/kit-ci.sh push`, `wait`, `land`). One task id per commit (`M2.1: type tool caret navigation`).",
      '',
      '## Checks',
      "`cargo xtask ci` runs in the kit's CI run; locally, run `cargo fmt --all -- --check` before you finish.",
      '',
    ]
    const text = (lines) => ['# Kit rules', '', ...lines].join('\n')
    const warnings = (lines) => {
      const out = bare(namedRepo('kition-doc', { 'AGENTS.md': text(lines) })).out
      return out.split('\n').filter((line) => line.startsWith('warning:')).map((line) => line.replace(/^warning: AGENTS\.md:\d+: /, ''))
    }
    const full = "asks for the full checks on this machine before a commit or a task; they run in the kit's CI run: "
    expect(warnings(before)).toEqual([before[1], before[3], before[4]].map((line) => full + line))
    expect(warnings(after)).toEqual([])
    // Other wordings that require the full command here, and one that only names it.
    const more = [
      '- `cargo test --workspace` must pass locally.',
      '- Before you finish, run `cargo xtask ci`.',
      '- `cargo xtask ci` is what CI runs; `cargo xtask wasm` is part of it.',
    ]
    expect(warnings(more)).toEqual([more[0], more[1]].map((line) => full + line))
  })

  it('warns about advice to give parallel agents separate git worktrees, in every repository', () => {
    const own = [
      '# Notes',
      '',
      '- Parallel agents: separate git worktrees and `CARGO_TARGET_DIR=target/agent-<name>`; keep every `Cargo.toml` valid (the `crates/*` glob).',
      '- Never use git worktrees here.',
      '',
    ].join('\n')
    const say = "advises git worktrees; agents commit on `main` in the repository's main checkout, one agent per repository at a time: "
    for (const name of ['kition-motion', 'kition-sdk', 'khp']) {
      const dir = namedRepo(name, { '.claude/CLAUDE.md': own })
      const out = bare(dir).out
      const claude = readIn(dir, '.claude/CLAUDE.md').split('\n')
      const at = claude.findIndex((line) => line.startsWith('- Parallel agents')) + 1
      expect(out.split('\n').filter((line) => line.startsWith('warning:'))).toEqual([`warning: .claude/CLAUDE.md:${at}: ${say}${claude[at - 1].trim()}`])
    }
  })

  it('reads the quality table: one source for a name, known fields and kinds only', () => {
    const community = { repositories: { 'kition-x': { title: 'Kition X' } }, family: { products: [{ id: 'p', name: 'Product P', repo: 'p' }] } }
    const table = (entry) => ({ owner: '@KitionAI/owners', repositories: { 'kition-x': entry, p: {}, q: { name: 'Q' } } })
    expect(qualityRepository('kition-x', { table: table({ check: 'make', fullChecks: 'kit-ci' }), community })).toEqual({
      listed: true,
      name: 'Kition X',
      check: 'make',
      fullChecks: 'kit-ci',
      xtask: true,
      owner: '@KitionAI/owners',
    })
    expect(qualityRepository('p', { table: table({}), community })).toMatchObject({ name: 'Product P', check: 'cargo xtask ci', fullChecks: 'check' })
    expect(qualityRepository('q', { table: table({}), community }).name).toBe('Q')
    expect(qualityRepository('elsewhere', { table: table({}), community })).toMatchObject({ listed: false, name: null })
    expect(() => qualityRepository('kition-x', { table: table({ name: 'Kition X' }), community })).toThrow('give it there only')
    expect(() => qualityRepository('kition-x', { table: table({ fullChecks: 'local' }), community })).toThrow('fullChecks must be one of kit-ci, ci, check')
    expect(() => qualityRepository('kition-x', { table: table({ command: 'make' }), community })).toThrow('unknown field command')
    expect(qualityRepository('kition-x', { table: table({ check: 'make', xtask: false }), community }).xtask).toBe(false)
    expect(() => qualityRepository('kition-x', { table: table({ xtask: 'no' }), community })).toThrow('xtask must be true or false')
    expect(() => qualityRepository('kition-x', { table: table({ xtask: false }), community })).toThrow('check runs cargo xtask, but xtask is false')
    expect(() => qualityRepository('kition-x', { table: table({ check: 'a\nb' }), community })).toThrow('one line without backticks')
    expect(() => qualityRepository('kition-x', { table: { ...table({}), owner: 'owners' }, community })).toThrow('owner must look like')
  })
})
