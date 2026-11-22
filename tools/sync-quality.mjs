#!/usr/bin/env node
// Writes the quality rules from templates/quality/ into one repository. Running it again
// changes nothing; when a template changes, running it again updates every generated part.
//
//   node tools/sync-quality.mjs <repo> [--verify] [--owner <@user-or-@org/team>] [--name <title>]
//        [--command <check command>]
//
// Every value comes from the data, by the repository's directory name (tools/quality-repositories.mjs
// reads it), so a repository in templates/quality/repositories.json needs no flag:
//   node ../kition-sdk/tools/sync-quality.mjs .
//
//   --verify   write nothing; exit 1 when a file is missing or differs from the templates, or a
//              file is left at an old location
//   --owner    overrides the CODEOWNERS owner of expected results and the rule files (default: the
//              table's owner)
//   --name     overrides the title of docs/quality.md (default: the product name, from
//              templates/community/repositories.json or the table; else the directory name)
//   --command  the local pre-finish check, for a repository not in the table (default
//              cargo xtask ci); a --command that disagrees with the table's check is refused
//
// The table also says where the repository's full checks run (fullChecks: the kit's CI run on
// GitHub, the repository's CI run, or the check itself, locally); the templates say so in their own
// sentences, so no sentence about the full checks names the pre-finish check.
//
// Warnings (never a failure, on every run): a line of AGENTS.md or .claude/CLAUDE.md outside the
// generated block that contradicts it (CONTRADICTIONS: a kit's own text that still asks for the
// old local full check before a commit, or forbids CI where the full checks run on GitHub) is
// printed as "warning: <file>:<line>: ...", for a person or the next agent to fix by hand.
//
// What it writes, relative to <repo>:
//   docs/quality.md               the quality reference (a generated block)
//   AGENTS.md                     the "Quality rules (read first)" section, right after the
//                                 file's first heading (a generated block)
//   .claude/CLAUDE.md             a pointer to AGENTS.md that imports it (a generated block);
//                                 skipped when .claude/CLAUDE.md is a link to AGENTS.md
//   .github/CODEOWNERS            owner lines for expected results and rule files (a block)
//   .claude/hooks/quality-gate.sh the Claude Code Stop hook (the whole file)
//   .claude/settings.json         the Stop hook entry, added once; other settings are kept
//
// A generated block sits between "kition-quality:begin" and "kition-quality:end" markers.
// Text outside the block is the repository's own and is never changed.
//
// Old locations (MOVED): a CLAUDE.md, QUALITY.md or kit-waivers.yaml at the repository root is a
// finding. The tool never moves a file: with one present it writes nothing, names the `git mv`
// to run, and exits 1 (with or without --verify).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullCheckValues, qualityRepository, validCommand } from './quality-repositories.mjs'
import { fill } from './sync-community.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templates = path.join(root, 'templates', 'quality')
const HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/quality-gate.sh'

/** Files that moved out of the repository root (the layout standard): old path, new path. */
const MOVED = [
  ['CLAUDE.md', '.claude/CLAUDE.md'],
  ['QUALITY.md', 'docs/quality.md'],
  ['kit-waivers.yaml', 'cases/waivers.yaml'],
]

function usage(message) {
  if (message) console.error(`sync-quality: ${message}`)
  console.error('usage: sync-quality.mjs <repo> [--verify] [--owner <@owner>] [--name <title>] [--command <cmd>]')
  process.exit(2)
}

/**
 * Lines outside the generated blocks that contradict them, in one place. Each rule applies where
 * the repository's full checks run as `fullChecks` lists; `line` must match the line, and
 * `context`, when given, the line itself or the heading right above it (such as
 * "### Quality gates (before every commit)" over a paragraph).
 */
export const CONTRADICTIONS = [
  {
    fullChecks: ['kit-ci'],
    line: /cargo xtask ci\b|cargo test --workspace\b/,
    context: /\bbefore (every|each|a|you) commit|\bbefore you (change|finish|end)\b|\bquality gates?\b/i,
    say: "asks for the full checks on this machine before a commit or a task; they run in the kit's CI run",
  },
  {
    fullChecks: ['kit-ci', 'ci'],
    line: /\b(no|never|do not|don't)\b[^.]*?\b(CI|GitHub Actions)\b/i,
    say: 'forbids CI; the full checks run on GitHub',
  },
]

/** Generated blocks blanked out (their lines kept, so line numbers stay true). */
const outsideBlocks = (text) => text.replace(new RegExp(BLOCK.source, 'gm'), (block) => block.replace(/[^\n]/g, ''))

/** "warning: <file>:<line>: ..." for each CONTRADICTIONS line of AGENTS.md and .claude/CLAUDE.md. */
export function contradictions(repo, fullChecks) {
  const rules = CONTRADICTIONS.filter((rule) => rule.fullChecks.includes(fullChecks))
  const found = []
  for (const file of ['AGENTS.md', '.claude/CLAUDE.md']) {
    const full = path.join(repo, file)
    if (file !== 'AGENTS.md' && linksTo(full, path.join(repo, 'AGENTS.md'))) continue
    const text = read(full)
    if (text === null) continue
    const lines = outsideBlocks(text).split('\n')
    let heading = ''
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.line.test(line) && (!rule.context || rule.context.test(line) || rule.context.test(heading))) {
          found.push(`warning: ${file}:${index + 1}: ${rule.say}: ${line.trim()}`)
        }
      }
      if (line.trim()) heading = /^#{1,6} /.test(line) ? line : ''
    })
  }
  return found
}

function parseArgs(argv) {
  const options = { verify: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--verify') options.verify = true
    else if (arg === '--owner' || arg === '--name' || arg === '--command') {
      const value = argv[++i]
      if (value === undefined) usage(`${arg} needs a value`)
      options[arg.slice(2)] = value
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length !== 1) usage('give exactly one repository directory')
  options.repo = path.resolve(rest[0])
  if (!fs.existsSync(options.repo) || !fs.statSync(options.repo).isDirectory()) usage(`${rest[0]} is not a directory`)
  const dir = path.basename(options.repo)
  let data
  try {
    data = qualityRepository(dir)
  } catch (error) {
    usage(error.message)
  }
  if (data.listed && options.command !== undefined && options.command !== data.check) {
    usage(`templates/quality/repositories.json gives ${dir} the check ${data.check}; change it there, not with --command`)
  }
  options.owner ??= data.owner
  if (!/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(options.owner)) usage('--owner must look like @user or @org/team')
  options.command ??= data.check
  if (!validCommand(options.command)) usage('--command must be one line without backticks')
  options.name ??= data.name ?? dir
  options.fullChecks = data.fullChecks
  return options
}

/** Quotes a string for bash, single quotes and all. */
const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

/** Fills a template: {{name}} values, {{#flag}}…{{/flag}} and {{^flag}}…{{/flag}} sections (sync-community's syntax). */
const render = (file, values) => fill(fs.readFileSync(path.join(templates, file), 'utf8'), values, `templates/quality/${file}`)

/** Wraps generated text in markers; `comment` turns a marker line into a comment. */
function block(body, comment) {
  const begin = comment('kition-quality:begin (generated by kition-sdk tools/sync-quality.mjs; edit the template there)')
  const end = comment('kition-quality:end')
  return `${begin}\n${body.trimEnd()}\n${end}\n`
}
const markdownComment = (text) => `<!-- ${text} -->`
const hashComment = (text) => `# ${text}`

const BLOCK = /^[^\n]*kition-quality:begin[^\n]*\n[\s\S]*?^[^\n]*kition-quality:end[^\n]*\n?/m

/**
 * Puts a generated block into existing text: replaces the old block, or inserts it.
 * `afterHeading` inserts right after a leading level-1 Markdown heading;
 * otherwise the block goes first.
 */
function placeBlock(existing, generated, { afterHeading, create }) {
  if (existing === null) return create(generated)
  if (BLOCK.test(existing)) return existing.replace(BLOCK, generated)
  if (afterHeading) {
    const heading = existing.match(/^(?:[ \t]*\n)*# [^\n]*\n/)
    if (heading) {
      const rest = existing.slice(heading[0].length).replace(/^(?:[ \t]*\n)+/, '')
      return `${heading[0]}\n${generated}\n${rest}`
    }
  }
  return `${generated}\n${existing}`
}

/** Adds the Stop hook to Claude Code settings unless an entry already runs it. */
function mergeSettings(existing) {
  const hook = JSON.parse(fs.readFileSync(path.join(templates, 'claude', 'settings.json'), 'utf8'))
  if (existing === null) return `${JSON.stringify(hook, null, 2)}\n`
  let settings
  try {
    settings = JSON.parse(existing)
  } catch (error) {
    throw new Error(`.claude/settings.json is not valid JSON: ${error.message}`)
  }
  const stop = settings.hooks?.Stop ?? []
  const present = stop.some((entry) => (entry.hooks ?? []).some((h) => h.command === HOOK_COMMAND))
  if (present) return existing
  settings.hooks = { ...settings.hooks, Stop: [...stop, ...hook.hooks.Stop] }
  return `${JSON.stringify(settings, null, 2)}\n`
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

/** True when something (a file, a folder, a link, even a broken one) is at `file`. */
function present(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

/** One line for each file left at an old location (MOVED), saying what to run. */
function oldLocations(repo) {
  return MOVED.filter(([from]) => present(path.join(repo, from))).map(([from, to]) =>
    present(path.join(repo, to))
      ? `old location: ${from} (${to} exists: keep the repository's own text in ${to}, then git rm ${from})`
      : `old location: ${from} (move it: mkdir -p ${path.posix.dirname(to)} && git mv ${from} ${to})`,
  )
}

/** True when `link` is a symbolic link that resolves to `target`. */
function linksTo(link, target) {
  try {
    return fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(target)
  } catch {
    return false
  }
}

function plan(options) {
  const values = {
    name: options.name,
    check: options.command,
    check_shell: shellQuote(options.command),
    owner: options.owner,
    ...fullCheckValues(options.fullChecks, options.command),
  }
  const at = (relative) => path.join(options.repo, relative)
  const files = [
    {
      path: 'docs/quality.md',
      next: (old) => placeBlock(old, block(render('quality.md', values), markdownComment), { create: (b) => b }),
    },
    {
      path: 'AGENTS.md',
      next: (old) =>
        placeBlock(old, block(render('AGENTS.quality.md', values), markdownComment), {
          afterHeading: true,
          create: (b) => `# Agent rules\n\n${b}`,
        }),
    },
    {
      path: '.claude/CLAUDE.md',
      skip: () => linksTo(at('.claude/CLAUDE.md'), at('AGENTS.md')),
      next: (old) =>
        placeBlock(old, block(render('CLAUDE.quality.md', values), markdownComment), { afterHeading: true, create: (b) => b }),
    },
    {
      path: '.github/CODEOWNERS',
      next: (old) => placeBlock(old, block(render('CODEOWNERS', values), hashComment), { create: (b) => b }),
    },
    { path: '.claude/hooks/quality-gate.sh', mode: 0o755, next: () => render('claude/quality-gate.sh', values) },
    { path: '.claude/settings.json', next: mergeSettings },
  ]
  return files
    .filter((file) => !file.skip?.())
    .map((file) => {
      const full = at(file.path)
      const old = read(full)
      const next = file.next(old)
      const modeWrong = file.mode !== undefined && old !== null && (fs.statSync(full).mode & 0o777) !== file.mode
      return { ...file, full, old, next, changed: old !== next || modeWrong }
    })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let files
  try {
    files = plan(options)
  } catch (error) {
    console.error(`sync-quality: ${error.message}`)
    process.exit(2)
  }
  const moved = oldLocations(options.repo)
  for (const line of moved) console.log(line)
  if (moved.length > 0 && !options.verify) {
    console.log('sync-quality: wrote nothing; move the files above, then run it again')
    process.exit(1)
  }
  const changed = files.filter((file) => file.changed)
  for (const file of changed) {
    const verb = file.old === null ? 'create' : 'update'
    if (options.verify) {
      console.log(`${verb === 'create' ? 'missing' : 'differs'}: ${file.path}`)
      continue
    }
    fs.mkdirSync(path.dirname(file.full), { recursive: true })
    fs.writeFileSync(file.full, file.next)
    if (file.mode !== undefined) fs.chmodSync(file.full, file.mode)
    console.log(`${verb}: ${file.path}`)
  }
  // After the writes, so that the line numbers are those of the files as they are now.
  for (const line of contradictions(options.repo, options.fullChecks)) console.log(line)
  if (changed.length === 0 && moved.length === 0) console.log('sync-quality: up to date')
  process.exit(options.verify && changed.length + moved.length > 0 ? 1 : 0)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
