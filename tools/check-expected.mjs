#!/usr/bin/env node
// Lists the changes in a range of commits that only a maintainer may approve: changed expected
// results and weakened tests (docs/quality.md, "Expected results are protected"). Reviewers
// and CI run it on every candidate; anything it lists goes to the maintainers.
//
//   node tools/check-expected.mjs [--repo <dir>] [--json] [<base>..<head> | <base>]
//
// The range defaults to origin/main..HEAD; a single revision means <base>..HEAD. Changes are
// taken from the merge base of <base> and <head> to <head>.
//
// Four kinds of finding:
//   expected-added    a new file under an expected-results path
//   expected-changed  a changed or renamed expected result; in an existing case.yaml a change
//                     to expected, tolerance, reference, input or steps, or a move out of the
//                     gate layer; in features.yaml a lowered priority or a removed
//                     protected glob
//   expected-deleted  a deleted expected result, a deleted case, or a feature with cases
//                     removed from features.yaml
//   tests-weakened    deleted assertions or tests, deleted test files, and added skip, ignore,
//                     only or todo markers (Rust, JavaScript and TypeScript, Python)
//
// Expected-results paths: the globs below (EXPECTED_GLOBS) and the `protected` globs of
// features.yaml (both sides of the range). Exit 0: nothing found; 1: findings; 2: usage or git error.
//
// Warnings (never a finding, never the exit code): every file tracked at <head> whose name says it
// is an expected result (EXPECTED_NAMES: expected_*, *_expected.*, *.expected.*, *fingerprints*,
// *.snap) and that no expected-results path protects, such as a single expected file next to a
// test; list it under `protected` in features.yaml (or move it into an expected/ folder).
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const EXPECTED_GLOBS = [
  '**/expected/**',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*-snapshots/**',
  '**/*.baseline.json',
]
// Names that say a file holds expected results, wherever it is (matched on the file name).
// `fingerprints` in a source file's name is code that computes them, not a result.
const EXPECTED_NAMES = [/^expected[_-]/i, /[_-]expected\./i, /\.expected\./i, /fingerprints/i, /\.snap$/i]
const SOURCE = /\.(rs|[cm]?[jt]sx?|py|go|swift|kt|java|c|cc|cpp|h|hpp)$/i
const GUARDED_CASE_FIELDS = ['expected', 'tolerance', 'reference', 'input', 'steps']
const KINDS = ['expected-added', 'expected-changed', 'expected-deleted', 'tests-weakened']

/** Per language: assertion calls, test definitions, and markers that skip or narrow tests. */
const LANGUAGES = [
  {
    extensions: ['.rs'],
    comment: /^\s*(\/\/|\/\*|\*)/,
    assertion: /\b\w*assert\w*!/g,
    test: /#\[\s*(?:\w+::)*test\b/g,
    skip: /#\[\s*ignore\b|#\[\s*cfg_attr\([^\]]*\bignore\b/g,
  },
  {
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
    comment: /^\s*(\/\/|\/\*|\*)/,
    assertion: /\bexpect(?:\.soft)?\s*\(|\bassert(?:\.\w+)?\s*\(|\bt\.(?:is|not|deepEqual|true|false|throws|throwsAsync|regex|snapshot)\s*\(/g,
    test: /(?<![.\w])(?:it|test)\s*\(/g,
    skip: /\.(?:skip|only|todo|fixme|skipIf|runIf)\s*\(|(?<![.\w])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bthis\.skip\s*\(/g,
  },
  {
    extensions: ['.py'],
    comment: /^\s*#/,
    assertion: /^\s*assert\b|\bself\.assert\w+\s*\(/g,
    test: /^\s*(?:async\s+)?def\s+test_\w*/g,
    skip: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip|\bself\.skipTest\s*\(/g,
  },
]
const TEST_FILE = /(^|\/)(tests?|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|rs)$/

function usage(message) {
  if (message) console.error(`check-expected: ${message}`)
  console.error('usage: check-expected.mjs [--repo <dir>] [--json] [<base>..<head> | <base>]')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), json: false, range: 'origin/main..HEAD' }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') options.json = true
    else if (argv[i] === '--repo') options.repo = path.resolve(argv[++i] ?? usage('--repo needs a value'))
    else if (argv[i].startsWith('--')) usage(`unknown option ${argv[i]}`)
    else rest.push(argv[i])
  }
  if (rest.length > 1) usage('give at most one range')
  if (rest.length === 1) options.range = rest[0]
  const [base, head = 'HEAD'] = options.range.includes('..') ? options.range.split(/\.\.\.?/) : [options.range]
  if (!base || !head) usage(`bad range ${options.range}`)
  return { ...options, base, head }
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
  if (result.error) throw new Error(`git ${args[0]}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout
}

/** The file at a revision, or null when it does not exist there. */
function show(repo, revision, file) {
  const result = spawnSync('git', ['-C', repo, 'show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 1 << 30 })
  return result.status === 0 ? result.stdout : null
}

/** A gitignore-style glob as a regular expression over repository-relative paths. */
function globToRegExp(glob) {
  let pattern = glob.replace(/^\//, '')
  if (!pattern.replace(/\/$/, '').includes('/')) pattern = `**/${pattern}`
  if (pattern.endsWith('/')) pattern += '**'
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (pattern.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
      source += '/.*'
      i += 2
    } else if (pattern.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// --- A small reader for the YAML subset of case.yaml and features.yaml ---------------------

const stripComment = (line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+$/, ''))

/** Top-level keys of a YAML mapping: key -> normalized text of its value (inline and block). */
function topLevel(text) {
  const blocks = new Map()
  let key = null
  for (const raw of (text ?? '').split('\n')) {
    const line = stripComment(raw)
    const start = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/)
    if (start) {
      key = start[1]
      blocks.set(key, [start[2].trim()])
    } else if (key && line.trim()) blocks.get(key).push(line)
  }
  return new Map([...blocks].map(([name, lines]) => [name, lines.join('\n').trim()]))
}

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** A YAML list given inline (`[a, b]`) or as block items (`- a`). */
function listOf(value) {
  if (!value) return []
  const inline = value.match(/^\[(.*)\]$/s)
  if (inline) return inline[1].split(',').map(unquote).filter(Boolean)
  return value
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((match) => unquote(match[1]))
}

/** The features of features.yaml: id -> { priority, cases }. */
function featuresOf(text) {
  const features = new Map()
  const lines = (text ?? '').split('\n').map(stripComment)
  const start = lines.findIndex((line) => /^features\s*:/.test(line))
  if (start < 0) return features
  let item = null
  let indent = null
  const flush = () => {
    if (!item) return
    const fields = topLevel(item.map((line) => line.slice(indent + 2)).join('\n'))
    const id = unquote(fields.get('id') ?? '')
    if (id) features.set(id, { priority: unquote(fields.get('priority') ?? ''), cases: listOf(fields.get('cases')) })
  }
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_]/.test(line)) break
    const dash = line.match(/^(\s*)-\s/)
    if (dash && (indent === null || dash[1].length === indent)) {
      flush()
      indent = dash[1].length
      item = [`${' '.repeat(indent)}  ${line.slice(indent + 2)}`]
    } else if (item) item.push(line)
  }
  flush()
  return features
}

const protectedGlobs = (text) => listOf(topLevel(text).get('protected'))

// --- The checks -------------------------------------------------------------------------------

/** Name-status entries between two revisions: { status, from, to }. */
function changes(repo, base, head) {
  const fields = git(repo, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, head]).split('\0')
  const entries = []
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++]
    const from = fields[i++]
    const to = /^[RC]/.test(status) ? fields[i++] : from
    entries.push({ status: status[0], from, to })
  }
  return entries
}

/** Added and removed lines per file, from a zero-context diff. */
function lineChanges(repo, base, head, files) {
  const result = new Map()
  if (files.length === 0) return result
  const args = ['-c', 'core.quotePath=false', 'diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base, head, '--', ...files]
  let lines = null
  let header = false
  for (const line of git(repo, args).split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
      lines = null
    } else if (header && line.startsWith('@@')) header = false
    else if (header && line.startsWith('+++ b/')) {
      const file = line.slice(6).replace(/\t$/, '')
      lines = result.get(file) ?? { added: [], removed: [] }
      result.set(file, lines)
    } else if (!header && lines && line.startsWith('+')) lines.added.push(line.slice(1))
    else if (!header && lines && line.startsWith('-')) lines.removed.push(line.slice(1))
  }
  return result
}

/** Deleted files show up only as removed lines; read them in full. */
function deletedLines(repo, base, file) {
  return (show(repo, base, file) ?? '').split('\n')
}

function count(lines, language, pattern) {
  let total = 0
  for (const line of lines) {
    if (language.comment.test(line)) continue
    total += (line.match(new RegExp(pattern.source, pattern.flags)) ?? []).length
  }
  return total
}

function check(repo, base, head) {
  const findings = Object.fromEntries(KINDS.map((kind) => [kind, []]))
  const add = (kind, file, reason) => findings[kind].push({ path: file, reason })
  const mergeBase = git(repo, ['merge-base', base, head]).trim()
  const featuresBefore = show(repo, mergeBase, 'features.yaml')
  const featuresAfter = show(repo, head, 'features.yaml')
  const globs = [...new Set([...EXPECTED_GLOBS, ...protectedGlobs(featuresBefore), ...protectedGlobs(featuresAfter)])]
  const matchers = globs.map(globToRegExp)
  const isExpected = (file) => matchers.some((matcher) => matcher.test(file))
  const isCase = (file) => /^cases\/.+\/case\.yaml$/.test(file)
  const entries = changes(repo, mergeBase, head)
  const code = []

  for (const { status, from, to } of entries) {
    const before = status === 'A' ? false : isExpected(from)
    const after = status === 'D' ? false : isExpected(to)
    if (status === 'R' && from !== to && (before || after)) {
      if (before && after) add('expected-changed', to, `renamed from ${from}`)
      else if (before) add('expected-deleted', from, `moved out of the expected results to ${to}`)
      else add('expected-added', to, `moved into the expected results from ${from}`)
    } else if (status === 'A' || status === 'C') {
      if (after) add('expected-added', to, 'new expected result')
    } else if (status === 'D') {
      if (before) add('expected-deleted', from, 'expected result deleted')
    } else if (before || after) add('expected-changed', to, 'expected result changed')

    if (isCase(from) && status === 'D') add('expected-deleted', from, 'case deleted')
    else if (isCase(from) && status === 'R' && from !== to) add('expected-changed', to, `case moved from ${from}`)
    if (isCase(from) && (status === 'M' || status === 'R')) {
      const old = topLevel(show(repo, mergeBase, from))
      const now = topLevel(show(repo, head, to))
      for (const field of GUARDED_CASE_FIELDS) {
        if ((old.get(field) ?? '') !== (now.get(field) ?? '')) add('expected-changed', to, `case field "${field}" changed`)
      }
      if (unquote(old.get('layer') ?? '') === 'gate' && unquote(now.get('layer') ?? '') !== 'gate') {
        add('expected-changed', to, `case moved out of the gate layer to "${unquote(now.get('layer') ?? '')}"`)
      }
    }

    const language = LANGUAGES.find((lang) => lang.extensions.includes(path.extname(status === 'D' ? from : to)))
    if (language) code.push({ status, from, to, language })
  }

  if (featuresBefore !== null && featuresBefore !== featuresAfter) {
    const old = featuresOf(featuresBefore)
    const now = featuresOf(featuresAfter)
    for (const [id, feature] of old) {
      const next = now.get(id)
      if (!next && feature.cases.length > 0) add('expected-deleted', 'features.yaml', `feature ${id} removed (it has ${feature.cases.length} case(s))`)
      else if (next && /^P\d$/.test(feature.priority) && /^P\d$/.test(next.priority) && next.priority > feature.priority) {
        add('expected-changed', 'features.yaml', `feature ${id} priority lowered from ${feature.priority} to ${next.priority}`)
      }
    }
    const kept = new Set(protectedGlobs(featuresAfter))
    for (const glob of protectedGlobs(featuresBefore)) {
      if (!kept.has(glob)) add('expected-changed', 'features.yaml', `protected glob removed: ${glob}`)
    }
  }

  const diffs = lineChanges(repo, mergeBase, head, code.filter((entry) => entry.status !== 'D').map((entry) => entry.to))
  for (const { status, from, to, language } of code) {
    const file = status === 'D' ? from : to
    const lines = status === 'D' ? { added: [], removed: deletedLines(repo, mergeBase, from) } : diffs.get(to)
    if (!lines) continue
    const reasons = []
    const assertions = count(lines.removed, language, language.assertion) - count(lines.added, language, language.assertion)
    if (assertions > 0) reasons.push(`${assertions} assertion(s) removed`)
    const tests = count(lines.removed, language, language.test) - count(lines.added, language, language.test)
    if (tests > 0) reasons.push(`${tests} test(s) removed`)
    const skips = count(lines.added, language, language.skip) - count(lines.removed, language, language.skip)
    if (skips > 0) {
      const first = lines.added.find((line) => !language.comment.test(line) && new RegExp(language.skip.source).test(line))
      reasons.push(`${skips} skip/ignore/only marker(s) added: ${first.trim()}`)
    }
    if (status === 'D' && TEST_FILE.test(from)) reasons.unshift('test file deleted')
    if (reasons.length > 0) add('tests-weakened', file, reasons.join('; '))
  }
  const protectedNow = [...EXPECTED_GLOBS, ...protectedGlobs(featuresAfter)].map(globToRegExp)
  const warnings = git(repo, ['ls-tree', '-r', '--name-only', head])
    .split('\n')
    .filter((file) => {
      const name = path.posix.basename(file)
      if (!file || !EXPECTED_NAMES.some((pattern) => pattern.test(name))) return false
      if (/fingerprints/i.test(name) && !EXPECTED_NAMES.some((pattern) => !/fingerprints/.test(pattern.source) && pattern.test(name)) && SOURCE.test(name)) return false
      return !protectedNow.some((matcher) => matcher.test(file))
    })
    .map((file) => ({
      path: file,
      reason: 'its name says it is an expected result, but no expected/ folder or `protected` glob of features.yaml protects it',
    }))
  return { base, head, mergeBase, files: entries.length, findings, warnings }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let report
  try {
    report = check(options.repo, options.base, options.head)
  } catch (error) {
    console.error(`check-expected: ${error.message}`)
    process.exit(2)
  }
  const total = KINDS.reduce((sum, kind) => sum + report.findings[kind].length, 0)
  if (options.json) {
    console.log(JSON.stringify({ ...report, total }, null, 2))
  } else {
    console.log(`check-expected: ${report.base}..${report.head}, ${report.files} file(s) changed`)
    for (const kind of KINDS) {
      if (report.findings[kind].length === 0) continue
      console.log(`${kind}:`)
      for (const finding of report.findings[kind]) console.log(`  ${finding.path}: ${finding.reason}`)
    }
    for (const warning of report.warnings) console.log(`warning: ${warning.path}: ${warning.reason}`)
    console.log(
      total === 0
        ? 'check-expected: no expected-result changes and no weakened tests'
        : `check-expected: ${total} finding(s); only a maintainer approves these changes`,
    )
  }
  process.exit(total === 0 ? 0 : 1)
}

main()
