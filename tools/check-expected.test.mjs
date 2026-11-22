import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-expected.mjs')
const repos = []

function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A repository with one base commit; `commit` applies changes on top of it. */
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-expected-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test User')
  git(dir, 'config', 'user.email', 'test-user@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  const commit = (changes) => {
    for (const [file, text] of Object.entries(changes)) {
      const full = path.join(dir, file)
      if (text === null) fs.rmSync(full)
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, text)
      }
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'change')
  }
  commit(files)
  git(dir, 'tag', 'base')
  return { dir, commit }
}

function run(dir) {
  const result = spawnSync(process.execPath, [tool, '--repo', dir, '--json', 'base..HEAD'], { encoding: 'utf8' })
  return { code: result.status, report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr }
}

afterEach(() => {
  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CASE = `format: 1
id: doc.review.comments/basic
feature: doc.review.comments
intent: Comments survive a round trip.
layer: gate
input: [input/basic.docx]
steps:
  - open: input/basic.docx
  - save: out/basic.docx
expected:
  - actual: out/basic.docx
    compare: package
tolerance: exact
since: "2026-10-21"
`

const RUST_TEST = `#[test]
fn round_trip() {
    let doc = open("basic.docx");
    assert_eq!(doc.comments().len(), 2);
    assert!(doc.is_valid());
}
`

const JS_TEST = `import { expect, it } from 'vitest'

it('keeps comments', () => {
  expect(roundTrip('basic.docx').comments).toHaveLength(2)
})
`

describe('check-expected', () => {
  it('reports a changed expected/ file', () => {
    const { dir, commit } = repo({
      'cases/doc.review.comments/basic/case.yaml': CASE,
      'cases/doc.review.comments/basic/expected/values.json': '{"comments": 2}\n',
    })
    commit({ 'cases/doc.review.comments/basic/expected/values.json': '{"comments": 1}\n' })
    const { code, report } = run(dir)
    expect(code).toBe(1)
    expect(report.findings['expected-changed']).toEqual([
      { path: 'cases/doc.review.comments/basic/expected/values.json', reason: 'expected result changed' },
    ])
    expect(report.findings['tests-weakened']).toEqual([])
  })

  // regressions/issue-expected-folder-rename: a kit's expected previews are conformance/expected/;
  // the old folder name stays protected until every kit has moved, and the move itself is listed.
  it('protects conformance/expected/, the old folder name until the kits have moved, and lists the rename', () => {
    // The old name, read only during the rename (check-expected.mjs BEFORE_RENAME_GLOBS).
    const old = 'conformance/golden/'
    {
      const { dir, commit } = repo({ 'conformance/expected/basic.png': 'png 1\n', 'conformance/expected/tolerance.json': '{}\n' })
      commit({ 'conformance/expected/basic.png': 'png 2\n', 'conformance/expected/basic-scale-2.png': 'png 3\n', 'conformance/expected/tolerance.json': null })
      const { code, report } = run(dir)
      expect(code).toBe(1)
      expect(report.findings['expected-changed']).toEqual([{ path: 'conformance/expected/basic.png', reason: 'expected result changed' }])
      expect(report.findings['expected-added']).toEqual([{ path: 'conformance/expected/basic-scale-2.png', reason: 'new expected result' }])
      expect(report.findings['expected-deleted']).toEqual([{ path: 'conformance/expected/tolerance.json', reason: 'expected result deleted' }])
    }
    {
      const { dir, commit } = repo({ [`${old}basic.png`]: 'png 1\n' })
      commit({ [`${old}basic.png`]: 'png 2\n' })
      expect(run(dir).report.findings['expected-changed']).toEqual([{ path: `${old}basic.png`, reason: 'expected result changed' }])
    }
    {
      const { dir, commit } = repo({ [`${old}basic.png`]: 'png 1\n' })
      commit({ [`${old}basic.png`]: null, 'conformance/expected/basic.png': 'png 1\n' })
      const { code, report } = run(dir)
      expect(code).toBe(1)
      expect(report.findings['expected-changed']).toEqual([{ path: 'conformance/expected/basic.png', reason: `renamed from ${old}basic.png` }])
    }
  })

  it('reports a deleted assertion', () => {
    const { dir, commit } = repo({ 'crates/doc/tests/comments.rs': RUST_TEST })
    commit({ 'crates/doc/tests/comments.rs': RUST_TEST.replace('    assert!(doc.is_valid());\n', '') })
    const { code, report } = run(dir)
    expect(code).toBe(1)
    expect(report.findings['tests-weakened']).toEqual([{ path: 'crates/doc/tests/comments.rs', reason: '1 assertion(s) removed' }])
  })

  it('reports an added skip or ignore', () => {
    const { dir, commit } = repo({ 'web/tests/comments.test.ts': JS_TEST, 'crates/doc/tests/comments.rs': RUST_TEST })
    commit({
      'web/tests/comments.test.ts': JS_TEST.replace("it('keeps", "it.skip('keeps"),
      'crates/doc/tests/comments.rs': RUST_TEST.replace('#[test]\n', '#[test]\n#[ignore]\n'),
    })
    const { code, report } = run(dir)
    expect(code).toBe(1)
    const weakened = report.findings['tests-weakened'].map((finding) => finding.path).sort()
    expect(weakened).toEqual(['crates/doc/tests/comments.rs', 'web/tests/comments.test.ts'])
    expect(report.findings['tests-weakened'].every((finding) => finding.reason.includes('marker(s) added'))).toBe(true)
  })

  it('passes an ordinary commit', () => {
    const { dir, commit } = repo({
      'cases/doc.review.comments/basic/case.yaml': CASE,
      'cases/doc.review.comments/basic/expected/values.json': '{"comments": 2}\n',
      'crates/doc/tests/comments.rs': RUST_TEST,
      'crates/doc/src/lib.rs': 'pub fn open() {}\n',
    })
    commit({
      'crates/doc/src/lib.rs': 'pub fn open() {}\npub fn save() {}\n',
      'crates/doc/tests/comments.rs': `${RUST_TEST}\n#[test]\nfn saves() {\n    assert!(save().is_ok());\n}\n`,
      'cases/doc.review.comments/basic/case.yaml': CASE.replace('Comments survive a round trip.', 'Comment threads survive a round trip.'),
    })
    const { code, report, stderr } = run(dir)
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(report.total).toBe(0)
  })

  it('reports guarded case.yaml fields, a move out of the gate layer, and a deleted case', () => {
    const { dir, commit } = repo({
      'cases/doc.review.comments/basic/case.yaml': CASE,
      'cases/doc.review.comments/other/case.yaml': CASE.replace('/basic', '/other'),
    })
    commit({
      'cases/doc.review.comments/basic/case.yaml': CASE.replace('tolerance: exact', 'tolerance: render').replace('layer: gate', 'layer: corpus'),
      'cases/doc.review.comments/other/case.yaml': null,
    })
    const { code, report } = run(dir)
    expect(code).toBe(1)
    expect(report.findings['expected-changed'].map((finding) => finding.reason)).toEqual([
      'case field "tolerance" changed',
      'case moved out of the gate layer to "corpus"',
    ])
    expect(report.findings['expected-deleted']).toEqual([{ path: 'cases/doc.review.comments/other/case.yaml', reason: 'case deleted' }])
  })

  it('reads features.yaml: protected globs, removed features, lowered priority', () => {
    const features = `format: 1
kit: doc
protected:
  - "crates/doc/tests/floors/**"
features:
  - id: doc.review.comments
    priority: P0
    cases:
      - doc.review.comments/basic
  - id: doc.layout.grid
    priority: P0
    cases: [doc.layout.grid/cjk]
  - id: doc.print.preview
    priority: P1
    cases: []
`
    const { dir, commit } = repo({ 'features.yaml': features, 'crates/doc/tests/floors/score.json': '{"min": 0.9}\n' })
    commit({
      'crates/doc/tests/floors/score.json': '{"min": 0.8}\n',
      'features.yaml': features
        .replace('  - id: doc.layout.grid\n    priority: P0\n    cases: [doc.layout.grid/cjk]\n', '')
        .replace('    priority: P0\n    cases:\n      - doc.review', '    priority: P1\n    cases:\n      - doc.review')
        .replace('  - id: doc.print.preview\n    priority: P1\n    cases: []\n', ''),
    })
    const { code, report } = run(dir)
    expect(code).toBe(1)
    expect(report.findings['expected-changed']).toEqual([
      { path: 'crates/doc/tests/floors/score.json', reason: 'expected result changed' },
      { path: 'features.yaml', reason: 'feature doc.review.comments priority lowered from P0 to P1' },
    ])
    expect(report.findings['expected-deleted']).toEqual([
      { path: 'features.yaml', reason: 'feature doc.layout.grid removed (it has 1 case(s))' },
    ])
  })
})
