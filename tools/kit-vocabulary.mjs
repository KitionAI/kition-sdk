#!/usr/bin/env node
// The kits' command vocabulary: how consistently the 16 kits name and describe their commands, read
// from the SDK's generated catalogues (packages/script/kits/<kit>.ts, `<Kit>Commands extends CommandMap`)
// without starting any kit. A measuring tool, not a gate: it exits 0 whatever it finds.
//
//   node tools/kit-vocabulary.mjs [--json] [--dir <folder of <kit>.ts>]
//
// Per kit: commands; commands with no parameters; commands with a required parameter (one without
// `?`); commands whose description mentions selection state or current-part/view state (whole
// words, any case); commands with a top-level parameter of each target and time spelling; the types
// of id-like parameters; and the verbs that begin the last segment of each command id, by family.
// A verb begins a segment when the segment is the verb or goes on with an upper-case letter or a
// non-letter (`add`, `addMask`, `remove_all`; not `address` or `settings`).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLISHED_KITS } from './published-kits.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.resolve(here, '../packages/script/kits')

export const TARGET_NAMES = Object.freeze([
  'id', 'ids', 'object', 'objects', 'layer', 'layers', 'item', 'items', 'shape', 'shapes', 'clip', 'clips',
  'target', 'targets', 'node', 'nodes', 'handle', 'handles', 'element', 'elements', 'index', 'indices', 'name', 'names',
])
export const ID_NAMES = Object.freeze(['id', 'ids', 'object', 'objects', 'layer', 'layers', 'item', 'items', 'clip', 'clips', 'handle', 'handles'])
export const ID_TYPES = Object.freeze(['number', 'string', 'Json', 'number[]', 'string[]', 'Json[]', 'other'])
export const TIME_NAMES = Object.freeze(['time', 'seconds', 'frame', 'frames', 'ticks', 'ms', 'start', 'end', 'duration', 'at', 'fps'])
export const VERB_FAMILIES = Object.freeze({
  create: ['add', 'new', 'create', 'insert'],
  delete: ['delete', 'remove', 'clear'],
  change: ['set', 'edit', 'update'],
})
const VERBS = Object.values(VERB_FAMILIES).flat()
const SELECTION_WORDS = /\b(?:selected|selection|cursor|insertion\s+point)\b/i
const CURRENT_WORDS = /\b(?:current|active|playhead|viewport)\b/i

const OPEN = { '{': '}', '[': ']', '<': '>', '(': ')' }
const CLOSE = new Set(Object.values(OPEN))

/** A scanner over `text` that steps over strings and comments and tracks bracket depth. */
function scanner(text, start = 0) {
  let index = start
  const stack = []
  const s = {
    get index() { return index },
    set index(value) { index = value },
    get depth() { return stack.length },
    done: () => index >= text.length,
    peek: (length = 1) => text.slice(index, index + length),
    skipSpace() { while (index < text.length && /\s/.test(text[index])) index++ },
    /** Reads a comment at the cursor and answers its text, or null when there is none. */
    comment() {
      if (text.startsWith('/*', index)) {
        const end = text.indexOf('*/', index + 2)
        if (end < 0) throw new Error('unterminated comment')
        const body = text.slice(index + 2, end).replace(/^\*/, '')
        index = end + 2
        return body.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '')).join(' ').trim()
      }
      if (text.startsWith('//', index)) {
        const end = text.indexOf('\n', index)
        const body = text.slice(index + 2, end < 0 ? text.length : end)
        index = end < 0 ? text.length : end
        return body.trim()
      }
      return null
    },
    /** Reads a quoted string at the cursor and answers its value. */
    string() {
      const quote = text[index]
      let value = ''
      index++
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') index++
        value += text[index++]
      }
      if (index >= text.length) throw new Error('unterminated string')
      index++
      return value
    },
    /** Steps over one character, a string or a comment, keeping the bracket depth. */
    step() {
      const char = text[index]
      if (char === '"' || char === "'" || char === '`') return void s.string()
      if (s.comment() !== null) return
      if (char === '=' && text[index + 1] === '>') return void (index += 2)
      if (Object.hasOwn(OPEN, char)) stack.push(OPEN[char])
      else if (CLOSE.has(char)) {
        if (stack.at(-1) !== char) throw new Error(`unbalanced ${char} at ${index}`)
        stack.pop()
      }
      index++
    },
  }
  return s
}

/** The top-level parameters of an object type's body (the text between its outer braces). */
function parseParams(body) {
  const params = []
  const s = scanner(body)
  for (;;) {
    for (;;) {
      s.skipSpace()
      if (s.peek() === ';' || s.peek() === ',') s.index++
      else if (s.comment() === null) break
    }
    if (s.done()) return params
    let name
    if (s.peek() === '[') {
      // An index signature (`[key: string]: never`) names no parameter: step over it and its type.
      s.step()
      while (s.depth > 0) s.step()
      s.skipSpace()
      if (s.peek() === '?') s.index++
      s.skipSpace()
      if (s.peek() !== ':') throw new Error('expected : after an index signature')
      s.index++
      while (!s.done() && !(s.depth === 0 && (s.peek() === ';' || s.peek() === ','))) s.step()
      continue
    }
    if (s.peek() === '"' || s.peek() === "'") name = s.string()
    else {
      const match = /^[A-Za-z_$][\w$]*/.exec(body.slice(s.index))
      if (!match) throw new Error(`expected a parameter name at ${JSON.stringify(body.slice(s.index, s.index + 20))}`)
      name = match[0]
      s.index += name.length
      if (name === 'readonly' && /^\s+[A-Za-z_$"']/.test(body.slice(s.index))) continue
    }
    s.skipSpace()
    const optional = s.peek() === '?'
    if (optional) s.index++
    s.skipSpace()
    if (s.peek() !== ':') throw new Error(`expected : after parameter ${name}`)
    s.index++
    const start = s.index
    while (!s.done() && !(s.depth === 0 && (s.peek() === ';' || s.peek() === ','))) s.step()
    params.push({ name, optional, type: body.slice(start, s.index).trim() })
  }
}

/** The commands of a generated catalogue: id, description and top-level parameters, in order. */
export function parseCatalogue(text) {
  const head = /export\s+interface\s+\w+Commands\s+extends\s+CommandMap\s*\{/.exec(text)
  if (!head) throw new Error('no `<Kit>Commands extends CommandMap` interface')
  const s = scanner(text, head.index + head[0].length)
  const commands = []
  let description = ''
  for (;;) {
    s.skipSpace()
    if (s.done()) throw new Error('unterminated command interface')
    if (s.peek() === '}') return commands
    const comment = s.comment()
    if (comment !== null) {
      description = comment
      continue
    }
    if (s.peek() !== '"' && s.peek() !== "'") throw new Error(`expected a command id at ${JSON.stringify(text.slice(s.index, s.index + 20))}`)
    const id = s.string()
    s.skipSpace()
    if (s.peek() !== ':') throw new Error(`expected : after command ${id}`)
    s.index++
    s.skipSpace()
    const start = s.index
    while (!s.done() && !(s.depth === 0 && (s.peek() === ';' || s.peek() === '\n' || s.peek() === '}'))) s.step()
    const type = text.slice(start, s.index).trim()
    if (s.peek() === ';') s.index++
    const params = type.startsWith('{') && type.endsWith('}') ? parseParams(type.slice(1, -1)) : []
    commands.push({ id, description, params })
    description = ''
  }
}

/** `number`, `string`, `Json`, an array of one of them, or `other`. */
export function classifyType(type) {
  const t = type.trim()
  const array = /^Array<(.*)>$/s.exec(t) ?? /^(.*)\[\]$/s.exec(t)
  if (array) {
    const inner = classifyType(array[1])
    return inner === 'other' || inner.endsWith('[]') ? 'other' : `${inner}[]`
  }
  return ['number', 'string', 'Json'].includes(t) ? t : 'other'
}

const zeros = (names) => Object.fromEntries(names.map((name) => [name, 0]))
const verbOf = (id) => {
  const last = id.split('.').at(-1)
  return VERBS.find((verb) => last.startsWith(verb) && (last.length === verb.length || !/[a-z]/.test(last[verb.length])))
}

/** The vocabulary measures of one catalogue. */
export function measureVocabulary(catalogueText) {
  const commands = parseCatalogue(catalogueText)
  const measure = {
    commands: commands.length,
    noParams: 0,
    requiredParams: 0,
    selectionMentions: 0,
    currentMentions: 0,
    targets: zeros(TARGET_NAMES),
    idTypes: zeros(ID_TYPES),
    idTypesByName: {},
    verbs: zeros(VERBS),
    families: {},
    time: zeros(TIME_NAMES),
  }
  for (const command of commands) {
    if (command.params.length === 0) measure.noParams++
    if (command.params.some((param) => !param.optional)) measure.requiredParams++
    if (SELECTION_WORDS.test(command.description)) measure.selectionMentions++
    if (CURRENT_WORDS.test(command.description)) measure.currentMentions++
    const names = new Set(command.params.map((param) => param.name))
    for (const name of names) {
      if (TARGET_NAMES.includes(name)) measure.targets[name]++
      if (TIME_NAMES.includes(name)) measure.time[name]++
    }
    for (const param of command.params) {
      if (!ID_NAMES.includes(param.name)) continue
      const kind = classifyType(param.type)
      measure.idTypes[kind]++
      const byName = (measure.idTypesByName[param.name] ??= {})
      byName[kind] = (byName[kind] ?? 0) + 1
    }
    const verb = verbOf(command.id)
    if (verb) measure.verbs[verb]++
  }
  for (const [family, verbs] of Object.entries(VERB_FAMILIES)) measure.families[family] = verbs.filter((verb) => measure.verbs[verb] > 0)
  return measure
}

const sumInto = (total, part) => {
  for (const [key, value] of Object.entries(part)) total[key] = (total[key] ?? 0) + value
  return total
}

/** The report over catalogues given as text, by kit name. */
export function buildReportFromTexts(texts) {
  const kits = Object.fromEntries(Object.entries(texts).map(([kit, text]) => {
    try {
      return [kit, measureVocabulary(text)]
    } catch (error) {
      throw new Error(`${kit}: ${error.message}`)
    }
  }))
  const measures = Object.values(kits)
  const sum = (key) => measures.reduce((total, measure) => total + measure[key], 0)
  const totals = {
    commands: sum('commands'),
    noParams: sum('noParams'),
    requiredParams: sum('requiredParams'),
    selectionMentions: sum('selectionMentions'),
    currentMentions: sum('currentMentions'),
    targets: measures.reduce((total, measure) => sumInto(total, measure.targets), zeros(TARGET_NAMES)),
    idTypes: measures.reduce((total, measure) => sumInto(total, measure.idTypes), zeros(ID_TYPES)),
    verbs: measures.reduce((total, measure) => sumInto(total, measure.verbs), zeros(VERBS)),
    time: measures.reduce((total, measure) => sumInto(total, measure.time), zeros(TIME_NAMES)),
  }
  const targetSpellingsInUse = TARGET_NAMES.filter((name) => totals.targets[name] > 0)
  const summary = {
    kits: measures.length,
    distinctTargetSpellings: targetSpellingsInUse.length,
    targetSpellingsInUse,
    kitsWithoutRequiredParams: Object.keys(kits).filter((kit) => kits[kit].requiredParams === 0),
    kitsMixingVerbs: Object.fromEntries(Object.keys(VERB_FAMILIES).map((family) => [family, Object.keys(kits).filter((kit) => kits[kit].families[family].length > 1)])),
  }
  return { kits, totals, summary }
}

/** The report over `<dir>/<kit>.ts` for every published kit. */
export function buildReport(dir = DEFAULT_DIR, kits = PUBLISHED_KITS) {
  return buildReportFromTexts(Object.fromEntries(kits.map((kit) => [kit, fs.readFileSync(path.join(dir, `${kit}.ts`), 'utf8')])))
}

const row = (cells) => `| ${cells.join(' | ')} |`
function table(headers, rows) {
  return [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n')
}

/** The report as Markdown. */
export function renderMarkdown(report) {
  const kits = Object.keys(report.kits)
  const perKit = (headers, cellsOf, totalCells) => table(['Kit', ...headers], [...kits.map((kit) => [kit, ...cellsOf(report.kits[kit])]), ['**total**', ...totalCells]])
  const t = report.totals
  const targets = report.summary.targetSpellingsInUse
  const familyCell = (measure, family) => VERB_FAMILIES[family].map((verb) => measure.verbs[verb]).join(' / ')
  const families = Object.keys(VERB_FAMILIES)
  return [
    '# Kit command vocabulary',
    '',
    `Generated by kition-sdk \`tools/kit-vocabulary.mjs\` from the SDK's command catalogues (packages/script/kits). ${report.summary.kits} kits, ${t.commands} commands.`,
    '',
    '## Commands',
    '',
    perKit(['Commands', 'No parameters', 'A required parameter', 'Mentions selection', 'Mentions current/active'],
      (m) => [m.commands, m.noParams, m.requiredParams, m.selectionMentions, m.currentMentions],
      [t.commands, t.noParams, t.requiredParams, t.selectionMentions, t.currentMentions]),
    '',
    `Kits that mark no parameter required: ${report.summary.kitsWithoutRequiredParams.join(', ') || 'none'}.`,
    '',
    '## Target parameters',
    '',
    `${report.summary.distinctTargetSpellings} distinct target spellings in use: ${targets.join(', ') || 'none'}. Commands with a top-level parameter of each name:`,
    '',
    perKit(targets, (m) => targets.map((name) => m.targets[name]), targets.map((name) => t.targets[name])),
    '',
    '## Types of id-like parameters',
    '',
    `Parameters named ${ID_NAMES.join(', ')}.`,
    '',
    perKit(ID_TYPES, (m) => ID_TYPES.map((kind) => m.idTypes[kind]), ID_TYPES.map((kind) => t.idTypes[kind])),
    '',
    '## Verb families',
    '',
    `Commands whose id's last segment begins with each verb. ${families.map((family) => `${family} (${VERB_FAMILIES[family].join(' / ')})`).join('; ')}.`,
    '',
    perKit(families, (m) => families.map((family) => familyCell(m, family)), families.map((family) => familyCell(t, family))),
    '',
    ...families.map((family) => `- Kits using more than one ${family} verb: ${report.summary.kitsMixingVerbs[family].length}${report.summary.kitsMixingVerbs[family].length ? ` (${report.summary.kitsMixingVerbs[family].join(', ')})` : ''}`),
    '',
    '## Time parameters',
    '',
    perKit(TIME_NAMES, (m) => TIME_NAMES.map((name) => m.time[name]), TIME_NAMES.map((name) => t.time[name])),
    '',
  ].join('\n')
}

function main(argv) {
  let json = false
  let dir = DEFAULT_DIR
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--json') json = true
    else if (argv[index] === '--dir' && argv[index + 1] !== undefined) dir = path.resolve(argv[++index])
    else {
      console.error('usage: node tools/kit-vocabulary.mjs [--json] [--dir <folder of <kit>.ts>]')
      return 2
    }
  }
  const report = buildReport(dir)
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
