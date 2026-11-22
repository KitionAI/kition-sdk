#!/usr/bin/env node
// Writes the community files from templates/community/ into one repository, and checks its
// README against the README skeleton. Running it again changes nothing; when a template or the
// repository's data changes, running it again updates every generated file.
//
//   node tools/sync-community.mjs <repo> [--entry <name>] [--check | --print-readme]
//
//   --entry         the repository's entry in templates/community/repositories.json (default:
//                   the directory's name; use it for a copy of a repository in another directory)
//   --check         write nothing; list each generated file that is missing or differs and each
//                   README finding, and exit 1 when there is any
//   --print-readme  write nothing; print the README skeleton for the repository, filled from its
//                   data (a starting point: of README.md the tool writes only the family section)
//
// Exit codes: 0 done (or nothing found), 1 findings with --check or a file at an old location,
// 2 usage errors, a repository without an entry, or invalid data.
//
// What it writes, relative to <repo> (whole files; a path in the entry's `keep` list belongs to
// the repository and is neither written nor checked):
//   .github/CONTRIBUTING.md, .github/CODE_OF_CONDUCT.md, .github/SECURITY.md, .github/SUPPORT.md
//   .github/ISSUE_TEMPLATE/bug_report.yml, feature_request.yml, config.yml
//   .github/pull_request_template.md
// Each file except CODE_OF_CONDUCT.md (kept identical to the Contributor Covenant text so that
// GitHub recognises it) starts with a comment naming this tool. Templates and the data write
// Markdown links relative to the repository root; in a file below it (.github/) the tool rewrites
// them relative to that file's folder.
//
// Old locations (MOVED): a CONTRIBUTING.md at the repository root is a finding, kept path or not.
// The tool never moves a file: with one present it writes nothing, names the `git mv` to run, and
// exits 1 (with or without --check).
//
// README.md: the tool writes one part of it, the "## The Kition family" section (rendered by
// tools/kition-family.mjs from the family in templates/community/repositories.json, the entry's own
// kit in bold), between kition-family markers right before "## License": a write run puts it there
// when it is missing and replaces it when it differs; the rest of README.md is the repository's
// own. An entry with family false has no such section (kiv, and the neutral kitharness.org).
//
// README.md rules (--check and the write run report them; translated README.<lang>.md files are
// not checked). A kit's README is a product page with pictures, in a fixed order of parts;
// --print-readme prints its skeleton.
//   every profile  no "Licence" spelling; "## License" exists and is the last H2; a link to
//                  https://developer.kition.ai, outside the family section, unless the entry sets
//                  developerLink false; no dev.kition.ai and no kition.one; unless the entry sets
//                  family false, one kition-family block, as the data gives it, right before
//                  "## License"
//   kit            H1 is the entry's title; links to https://kition.ai and
//                  https://github.com/kitharness/kitharness outside the family section; exactly the
//                  H2 sections "What it does", "Quick start", "Maturity", "Build and contribute",
//                  "The Kition family", "License", in this order
//                  ("Repository layout" and "Build and test" belong in docs/development.md, any
//                  other part is an H3 under "What it does"); the hero picture
//                  <img src="assets/readme/hero.png" …>; at least 3 pictures from
//                  assets/readme/, each with an alt of at least 20 characters, each in the
//                  repository and at most 400 KB; the Maturity section states kit.json's version
//                  ("Version <version>"), khp ("KHP <khp>") and level ("conformance level
//                  `<level>`"), and says no other; a KHP badge states kit.json's khp
//   project        an H1; a "## Build and test" H2 when the entry gives build commands
//
// docs/development.md rule (kits): when the kit has web/, it describes the KITION_LINK=1 opt-in.
//
// Templates use {{name}} for a value, {{#name}}…{{/name}} for text kept when the value is set,
// and {{^name}}…{{/name}} for text kept when it is not. A tag alone on its line takes the line.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILY_TITLE, familyBlock, findBlocks, kitFormats, readFamily, withoutFamily } from './kition-family.mjs'
import { fullCheckValues, qualityRepository, validCommand } from './quality-repositories.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templates = path.join(root, 'templates', 'community')
const DEVELOPER = 'https://developer.kition.ai'
/**
 * The module a kit README's "Embed it" names for the people who embed the kit (its npm badge and
 * the example's import): one that npm installs today. Switch to @kition/sdk/embed at the first
 * release of @kition/sdk (the badge and link then name its package, @kition/sdk).
 */
export const README_EMBED_SPECIFIER = '@kition/embed'
const MARKER = 'Generated by kition-sdk tools/sync-community.mjs; edit the template in kition-sdk, not this file.'

const FILES = [
  { path: '.github/CONTRIBUTING.md', comment: 'markdown' },
  { path: '.github/CODE_OF_CONDUCT.md', comment: null },
  { path: '.github/SECURITY.md', comment: 'markdown' },
  { path: '.github/SUPPORT.md', comment: 'markdown' },
  { path: '.github/ISSUE_TEMPLATE/bug_report.yml', comment: 'hash' },
  { path: '.github/ISSUE_TEMPLATE/feature_request.yml', comment: 'hash' },
  { path: '.github/ISSUE_TEMPLATE/config.yml', comment: 'hash' },
  { path: '.github/pull_request_template.md', comment: 'markdown' },
]
/** Files that moved out of the repository root (the layout standard): old path, new path. */
const MOVED = [['CONTRIBUTING.md', '.github/CONTRIBUTING.md']]
/** A kit README's H2 sections, in order, and those that belong in docs/development.md. */
const KIT_SECTIONS = ['What it does', 'Quick start', 'Maturity', 'Build and contribute', FAMILY_TITLE, 'License']
const DEVELOPMENT_SECTIONS = ['Repository layout', 'Build and test']
/** The README's pictures: where they live, the hero, how many, how big, how long an alt. */
const PICTURES = 'assets/readme/'
const HERO = `${PICTURES}hero.png`
const MIN_PICTURES = 3
export const MAX_PICTURE_BYTES = 400 * 1024
const MIN_ALT = 20
const FIELDS = new Set([
  'profile', 'title', 'github', 'docs', 'docsName', 'developerLink', 'description', 'uses', 'scope', 'build', 'notes',
  'check', 'quality', 'changelog', 'hasWeb', 'linksTessera', 'fonts', 'rules', 'licenseNote', 'keep', 'family',
])
const TOOLS = new Set(['rust', 'wasm32', 'wasm-pack', 'node', 'pnpm', 'npm'])

class DataError extends Error {}

function usage(message) {
  if (message) console.error(`sync-community: ${message}`)
  console.error('usage: sync-community.mjs <repo> [--entry <name>] [--check | --print-readme]')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { check: false, printReadme: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') options.check = true
    else if (arg === '--print-readme') options.printReadme = true
    else if (arg === '--entry') {
      const value = argv[++i]
      if (value === undefined) usage('--entry needs a value')
      options.entry = value
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length !== 1) usage('give exactly one repository directory')
  if (options.check && options.printReadme) usage('--check and --print-readme do not go together')
  options.repo = path.resolve(rest[0])
  if (!fs.existsSync(options.repo) || !fs.statSync(options.repo).isDirectory()) usage(`${rest[0]} is not a directory`)
  options.entry ??= path.basename(options.repo)
  return options
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Fills a template: sections first (innermost last), then values. Throws on unknown names. */
export function fill(text, values, where) {
  const lookup = (name) => {
    if (!Object.hasOwn(values, name)) throw new DataError(`${where}: unknown placeholder ${name}`)
    return values[name]
  }
  const set = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))
  let out = text.replace(/^[ \t]*(\{\{[#^/]\w+\}\})[ \t]*\n/gm, '$1')
  const section = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g
  for (let before = null; before !== out; ) {
    before = out
    out = out.replace(section, (_, kind, name, body) => ((kind === '#') === set(lookup(name)) ? body : ''))
  }
  out = out.replace(/\{\{(\w+)\}\}/g, (_, name) => String(lookup(name)))
  const left = out.match(/\{\{[^}]*\}\}/)
  if (left) throw new DataError(`${where}: unreplaced ${left[0]}`)
  return out.replace(/\n{3,}/g, '\n\n')
}

const template = (file) => fs.readFileSync(path.join(templates, file), 'utf8')

function fail(name, message) {
  throw new DataError(`templates/community/repositories.json: ${name}: ${message}`)
}

/** The entry for `name` with its defaults applied, and the values the templates use. */
export function entryValues(name, data = readJson(path.join(templates, 'repositories.json'))) {
  if (!Object.hasOwn(data.repositories, name)) {
    throw new DataError(`templates/community/repositories.json has no entry ${name}`)
  }
  const raw = data.repositories[name]
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) fail(name, `unknown field ${key}`)
  const kit = raw.profile === 'kit'
  if (!kit && raw.profile !== 'project') fail(name, 'profile must be kit or project')
  for (const key of ['title', 'github', 'description']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) fail(name, `${key} is required`)
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(raw.github)) fail(name, 'github must be owner/name')
  const entry = {
    docs: DEVELOPER,
    docsName: 'Kition for Developers',
    developerLink: true,
    quality: true,
    changelog: true,
    keep: [],
    hasWeb: kit,
    linksTessera: kit,
    family: true,
    fonts: false,
    rules: [],
    ...(kit ? { uses: ['rust', 'wasm32', 'wasm-pack', 'node', 'pnpm'], ...data.kitDefaults } : {}),
    ...raw,
  }
  if (!/^https:\/\/[^\s)]+$/.test(entry.docs)) fail(name, 'docs must be an https URL')
  if (!kit && (entry.linksTessera || entry.fonts)) fail(name, 'linksTessera and fonts are kit fields')
  if (typeof entry.family !== 'boolean') fail(name, 'family must be true or false')
  if (!Array.isArray(entry.uses) || entry.uses.length === 0) fail(name, 'uses is required')
  for (const tool of entry.uses) if (!TOOLS.has(tool)) fail(name, `unknown tool ${tool} in uses`)
  if (entry.quality && entry.check !== undefined) {
    fail(name, 'the check command of a repository with docs/quality.md lives in templates/quality/repositories.json')
  }
  // A repository with docs/quality.md takes its check, and where its full checks run, from the quality table.
  const quality = entry.quality ? qualityRepository(name, { community: data }) : { check: entry.check, fullChecks: 'check' }
  const check = quality.check
  if (!validCommand(check)) fail(name, 'check must be one line without backticks')
  const keep = entry.keep.map((pattern) => {
    const matches = FILES.filter((file) =>
      pattern.endsWith('/*') ? path.posix.dirname(file.path) === pattern.slice(0, -2) : file.path === pattern,
    )
    if (matches.length === 0) fail(name, `keep entry ${pattern} matches no generated file`)
    return matches.map((file) => file.path)
  })
  const kept = new Set(keep.flat())
  if (!kept.has('.github/CONTRIBUTING.md') && !Array.isArray(entry.scope)) fail(name, 'scope is required')

  const where = `repositories.json ${name}`
  const values = {
    repo: name,
    // A section flag for kits, and the kit's short name in the README skeleton's Publish line.
    kit: kit ? name.replace(/^kition-/, '') : '',
    title: entry.title,
    // The kit's name without "Kition " ("Why Note", "Made with Note").
    name: entry.title.replace(/^Kition /, ''),
    description: entry.description,
    github: entry.github,
    docs: entry.docs,
    docsName: entry.docsName,
    developerLink: entry.developerLink,
    check,
    ...fullCheckValues(quality.fullChecks, check),
    quality: entry.quality,
    changelog: entry.changelog,
    hasWeb: entry.hasWeb,
    linksTessera: entry.linksTessera,
    issueForms: !kept.has('.github/ISSUE_TEMPLATE/bug_report.yml'),
    licenseNote: entry.licenseNote ?? '',
    // The README's "## The Kition family" section with its markers ('' for an entry without one).
    family: entry.family ? familyBlock(readFamily(data), familySelf(name, kit, data)) : '',
  }
  const lines = (list) => (list ?? []).map((line) => fill(line, values, where))
  values.build = lines(entry.build).join('\n')
  values.scopeRows = (entry.scope ?? []).map(([at, what]) => `| ${at} | ${what} |`).join('\n')
  if (values.scopeRows && entry.quality) {
    values.scopeRows += '\n| `features.yaml`, `cases/` | The feature catalogue and its cases ([docs/quality.md](docs/quality.md)) |'
  }
  values.rules = lines(entry.rules).join('\n')
  values.toolchain = toolchain(entry.uses, data.toolchain)
  const notes = []
  if (kit && entry.hasWeb) notes.push(fill(template('partials/kition-link.md'), values, 'partials/kition-link.md').trimEnd())
  if (entry.fonts) {
    notes.push(
      '`pnpm engine` copies fonts from a [kition-fonts](https://github.com/KitionAI/kition-fonts) checkout next to\nthis repository (or the one `KITION_FONTS_DIR` names).',
    )
  }
  if (entry.notes) notes.push(fill(entry.notes, values, where))
  values.setupNotes = notes.join('\n\n')
  return { name, entry, kit, kept, values }
}

/** Whose README the family section is in: the entry's kit, or the product that lives in the entry's repository. */
function familySelf(name, kit, data) {
  if (kit) return { kit: name.replace(/^kition-/, '') }
  const product = (data.family?.products ?? []).find((candidate) => candidate.repo === name)
  return product ? { product: product.id } : {}
}

function toolchain(uses, versions) {
  const has = (tool) => uses.includes(tool)
  const parts = []
  if (has('rust')) {
    parts.push(
      `Rust ${versions.rust} or later with rustfmt${has('wasm32') ? ', clippy, and the `wasm32-unknown-unknown` target' : ' and clippy'}`,
    )
  }
  if (has('wasm-pack')) parts.push(`wasm-pack ${versions.wasmPack}`)
  if (has('node')) parts.push(`Node.js ${versions.node} or a later 22.x release`)
  if (has('pnpm')) parts.push(`pnpm ${versions.pnpm}`)
  if (has('npm')) parts.push('npm')
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts.at(-1)}`
}

function withMarker(text, comment) {
  if (comment === 'markdown') return `<!-- ${MARKER} -->\n${text}`
  if (comment === 'hash') return `# ${MARKER}\n${text}`
  return text
}

/**
 * Rewrites the relative link targets of Markdown `text`, written from the repository root, for a
 * file at `file`: in `.github/CONTRIBUTING.md`, `[AGENTS.md](AGENTS.md)` links `../AGENTS.md`.
 * URLs, anchors and absolute paths stay as they are.
 */
export function relink(text, file) {
  const dir = path.posix.dirname(file)
  if (dir === '.') return text
  return text.replace(/\]\(([^()\s]+)\)/g, (link, target) =>
    /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target) ? link : `](${path.posix.relative(dir, target)})`,
  )
}

/** Every generated file for the entry: { path, text }; kept paths are left out. */
export function generate(info) {
  return FILES.filter((file) => !info.kept.has(file.path)).map((file) => {
    const text = fill(template(file.path), info.values, file.path)
    return { path: file.path, text: withMarker(file.path.endsWith('.md') ? relink(text, file.path) : text, file.comment) }
  })
}

/** The README skeleton for the entry; `manifest` is the kit's kit.json (kits only). */
export function readmeSkeleton(info, manifest) {
  const values = { ...info.values }
  if (info.kit) {
    Object.assign(values, {
      version: manifest.version,
      khp: manifest.khp,
      // A shields.io badge writes a dash as two and a space as an underscore.
      khpBadge: String(manifest.khp).replaceAll('-', '--').replaceAll('_', '__').replaceAll(' ', '_'),
      level: manifest.level,
      ...kitFormats(manifest),
      embedSpecifier: README_EMBED_SPECIFIER,
      embedPackage: README_EMBED_SPECIFIER.split('/').slice(0, 2).join('/'),
      embedLabel: encodeURIComponent(README_EMBED_SPECIFIER),
    })
  }
  return fill(template(info.kit ? 'README.kit.md' : 'README.project.md'), values, 'README skeleton')
}

/** The text's lines as a reader sees them: fenced code blocks (and their fences) and HTML comments blanked. */
function prose(text) {
  let fence = null
  let comment = false
  return text.split('\n').map((line) => {
    if (!comment) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (marker) {
        if (fence === null) fence = marker[1][0]
        else if (marker[1][0] === fence) fence = null
        return ''
      }
      if (fence !== null) return ''
    }
    let shown = ''
    let rest = line
    while (rest) {
      const at = rest.indexOf(comment ? '-->' : '<!--')
      if (at < 0) {
        if (!comment) shown += rest
        break
      }
      if (!comment) shown += rest.slice(0, at)
      rest = rest.slice(at + (comment ? 3 : 4))
      comment = !comment
    }
    return shown
  })
}

/** The README's H1 and H2 headings with their sections, outside fenced code blocks and HTML comments. */
function outline(text) {
  let h1 = null
  const sections = []
  prose(text).forEach((line, index) => {
    const heading = /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading?.[1] === '#' && h1 === null) h1 = heading[2]
    if (heading?.[1] === '##') sections.push({ title: heading[2], line: index + 1, body: [] })
    else if (sections.length > 0) sections.at(-1).body.push(line)
  })
  return { h1, sections: sections.map((section) => ({ ...section, body: section.body.join('\n') })) }
}

/**
 * The pictures the README shows, outside fenced code blocks and HTML comments: `<img …>` tags (each
 * on one line) and Markdown images, each { src, alt (null when it has none), tag: 'img' |
 * 'markdown', line }; a src loses its "./".
 */
export function readmePictures(text) {
  const pictures = []
  const attribute = (tag, name) => {
    const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
    return found ? (found[1] ?? found[2]) : null
  }
  prose(text).forEach((line, index) => {
    for (const [tag] of line.matchAll(/<img\b[^>]*>/gi)) {
      const src = attribute(tag, 'src')
      if (src !== null) pictures.push({ src: src.replace(/^\.\//, ''), alt: attribute(tag, 'alt'), tag: 'img', line: index + 1 })
    }
    for (const [, alt, src] of line.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      pictures.push({ src: src.replace(/^\.\//, ''), alt, tag: 'markdown', line: index + 1 })
    }
  })
  return pictures
}

/** The 1-based numbers of the lines that match `pattern`, as "line 3" or "lines 3, 9". */
function onLines(text, pattern) {
  const lines = text.split('\n').flatMap((line, index) => (pattern.test(line) ? [index + 1] : []))
  return lines.length === 0 ? null : `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`
}

/**
 * README findings for the entry, as strings. `repo.size(file)` answers the size in bytes of a
 * file of the repository (a path relative to its root), or null when there is none.
 */
export function checkReadme(info, readme, manifest, repo = { size: () => null }) {
  if (readme === null) return ['README.md is missing']
  const findings = []
  const say = (text) => findings.push(`README.md: ${text}`)
  const licence = onLines(readme, /licence/i)
  if (licence) say(`"Licence" spelling on ${licence}; write "License"`)
  const { h1, sections } = outline(readme)
  const titles = sections.map((section) => section.title)
  if (!titles.includes('License')) say('no "## License" section')
  else if (titles.at(-1) !== 'License') say(`"## License" is not the last H2 (the last is "## ${titles.at(-1)}")`)
  // The links a README must have count in its own text, not in the generated family section.
  const own = withoutFamily(readme)
  if (info.values.developerLink && !own.includes(DEVELOPER)) say(`no link to ${DEVELOPER}`)
  const dev = onLines(readme, /(?<![\w-])dev\.kition\.ai/i)
  if (dev) say(`dev.kition.ai on ${dev}; the developer site is ${DEVELOPER}`)
  const one = onLines(readme, /\bkition\.one\b/i)
  if (one) say(`kition.one on ${one}; Kition's site is https://kition.ai`)
  findings.push(...checkFamily(info, readme, titles))

  if (!info.kit) {
    if (h1 === null) say('no H1')
    if (info.values.build && !titles.includes('Build and test')) say('no "## Build and test" section (the entry gives build commands)')
    return findings
  }

  if (h1 !== info.values.title) say(`the H1 is ${h1 === null ? 'missing' : `"${h1}"`}; it should be "${info.values.title}"`)
  for (const link of ['https://kition.ai', 'https://github.com/kitharness/kitharness']) {
    if (!own.includes(link)) say(`no link to ${link}`)
  }
  // A missing family section is checkFamily's finding.
  for (const title of KIT_SECTIONS.slice(0, -1)) if (title !== FAMILY_TITLE && !titles.includes(title)) say(`no "## ${title}" section`)
  const present = titles.filter((title) => KIT_SECTIONS.includes(title))
  const expected = KIT_SECTIONS.filter((title) => present.includes(title))
  if (present.join('\n') !== expected.join('\n')) {
    say(`the H2 sections are out of order: ${present.join(', ')} (expected ${expected.join(', ')})`)
  }
  for (const title of titles) {
    if (KIT_SECTIONS.includes(title)) continue
    if (DEVELOPMENT_SECTIONS.includes(title)) say(`"## ${title}" belongs in docs/development.md, not the README`)
    else say(`"## ${title}" is not one of the README's sections (${KIT_SECTIONS.join(', ')}); make it an H3 inside one of them`)
  }

  const pictures = readmePictures(readme).filter((picture) => picture.src.startsWith(PICTURES))
  if (!pictures.some((picture) => picture.tag === 'img' && picture.src === HERO)) {
    say(`no hero picture: <img src="${HERO}" alt="…" width="100%" /> under the introduction`)
  }
  const files = [...new Set(pictures.map((picture) => picture.src))]
  if (files.length < MIN_PICTURES) {
    say(`${files.length} picture${files.length === 1 ? '' : 's'} from ${PICTURES}; a kit README has at least ${MIN_PICTURES} (the hero and the "See it" pictures)`)
  }
  for (const picture of pictures) {
    const alt = picture.alt?.trim() ?? ''
    if (!alt) say(`${picture.src} (line ${picture.line}) has no alt; write a full sentence of at least ${MIN_ALT} characters saying what the picture shows`)
    else if (alt.length < MIN_ALT) {
      say(`${picture.src} (line ${picture.line}) has an alt of ${alt.length} characters; write a full sentence of at least ${MIN_ALT} saying what the picture shows`)
    }
  }
  for (const file of files.sort()) {
    const size = repo.size(file)
    if (size === null) say(`${file} is referenced but not in the repository`)
    else if (size > MAX_PICTURE_BYTES) {
      say(`${file} is ${Math.ceil(size / 1024)} KB; a README picture is at most ${MAX_PICTURE_BYTES / 1024} KB (pngquant --quality 70-90)`)
    }
  }

  const maturity = sections.find((section) => section.title === 'Maturity')?.body ?? null
  if (manifest === null) {
    if (maturity !== null) say('kit.json is missing, so the Maturity line and the KHP badge cannot be checked')
    return findings
  }
  if (maturity !== null) {
    // Each fact kit.json holds, as the Maturity section states it: what else it says, or that it says nothing.
    const facts = [
      { label: 'Version', key: 'version', want: `Version ${manifest.version}`, pattern: /\bVersion\s+(\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)/g },
      { label: 'KHP', key: 'khp', want: `KHP ${manifest.khp}`, pattern: /\bKHP\s+(\d+(?:\.\d+)*)/g },
      { label: 'conformance level', key: 'level', want: `the conformance level \`${manifest.level}\``, pattern: /\bconformance level\s+`?([a-z][a-z-]*)`?/g },
    ]
    for (const { label, key, want, pattern } of facts) {
      const said = [...maturity.matchAll(pattern)].map((match) => match[1])
      const other = [...new Set(said.filter((value) => value !== String(manifest[key])))]
      for (const value of other) say(`the Maturity section says ${label} ${value}; kit.json says ${manifest[key]}`)
      if (other.length === 0 && !said.includes(String(manifest[key]))) say(`the Maturity section does not state ${want} (kit.json's ${key})`)
    }
  }
  const badges = new Set()
  for (const line of prose(readme)) {
    for (const [, value] of line.matchAll(/img\.shields\.io\/badge\/KHP-((?:[^-\s)"/]|--)+)-/gi)) {
      badges.add(value.replaceAll('--', '\u0000').replaceAll('__', '\u0001').replaceAll('_', ' ').replaceAll('\u0000', '-').replaceAll('\u0001', '_'))
    }
    for (const [, value] of line.matchAll(/!\[KHP:?\s+([^\]\s]+)\]/g)) badges.add(value)
  }
  for (const value of badges) {
    if (value !== String(manifest.khp)) say(`a KHP badge says ${value}; kit.json's khp is ${manifest.khp}`)
  }
  return findings
}

/**
 * README findings about the family section: an entry with family true has exactly one
 * kition-family block, the one the data gives, right before "## License" (a kit's section order
 * is checkReadme's). `titles` are the README's H2 titles in order.
 */
function checkFamily(info, readme, titles) {
  if (!info.values.family) return []
  const run = 'run node tools/sync-community.mjs <repo> (without --check) to write it'
  const { blocks, broken } = findBlocks(readme)
  if (broken) return ['README.md: a kition-family marker without its partner; remove the broken block, then run node tools/sync-community.mjs <repo> (without --check)']
  if (blocks.length === 0) return [`README.md: no "## ${FAMILY_TITLE}" section (the kition-family block before "## License"); ${run}`]
  if (blocks.length > 1) return [`README.md: ${blocks.length} kition-family blocks; keep one, before "## License"`]
  const findings = []
  if (readme.slice(blocks[0].start, blocks[0].end) !== info.values.family) {
    findings.push(`README.md: the "## ${FAMILY_TITLE}" section is not the one templates/community/repositories.json gives; ${run}`)
  }
  const at = titles.indexOf(FAMILY_TITLE)
  if (!info.kit && at >= 0 && titles[at + 1] !== 'License') findings.push(`README.md: the "## ${FAMILY_TITLE}" section is not right before "## License"`)
  return findings
}

/**
 * `readme` with the entry's family section written: replaced when its one block differs, put right
 * before "## License" when there is none. Null when nothing changes or it cannot be placed (no
 * "## License", a broken or doubled block: checkReadme reports those).
 */
export function writeFamily(info, readme) {
  if (!info.values.family || readme === null) return null
  const { blocks, broken } = findBlocks(readme)
  if (broken || blocks.length > 1) return null
  if (blocks.length === 1) {
    const [{ start, end }] = blocks
    const next = readme.slice(0, start) + info.values.family + readme.slice(end)
    return next === readme ? null : next
  }
  const license = outline(readme).sections.filter((section) => section.title === 'License').at(-1)
  if (!license) return null
  const lines = readme.split('\n')
  const before = lines.slice(0, license.line - 1).join('\n').replace(/\s+$/, '')
  return `${before}\n\n${info.values.family}\n${lines.slice(license.line - 1).join('\n')}`
}

/** docs/development.md findings for the entry: a kit with web/ describes the KITION_LINK=1 opt-in there. */
export function checkDevelopment(info, text, { web }) {
  if (!info.kit || !web) return []
  if (text === null) return ['docs/development.md: missing; it describes building the kit, and the KITION_LINK=1 opt-in of web/']
  return text.includes('KITION_LINK') ? [] : ['docs/development.md: does not describe the KITION_LINK=1 opt-in of web/']
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

function main() {
  const options = parseArgs(process.argv.slice(2))
  let info
  let files
  let manifest = null
  try {
    info = entryValues(options.entry)
    files = generate(info)
    if (info.kit) {
      const text = read(path.join(options.repo, 'kit.json'))
      if (text !== null) manifest = JSON.parse(text)
    }
  } catch (error) {
    if (!(error instanceof DataError) && !(error instanceof SyntaxError)) throw error
    console.error(`sync-community: ${error.message}`)
    process.exit(2)
  }

  if (options.printReadme) {
    if (info.kit && manifest === null) {
      console.error('sync-community: the kit skeleton needs the repository\'s kit.json')
      process.exit(2)
    }
    process.stdout.write(readmeSkeleton(info, manifest))
    process.exit(0)
  }

  const moved = oldLocations(options.repo)
  for (const line of moved) console.log(line)
  if (moved.length > 0 && !options.check) {
    console.log('sync-community: wrote nothing; move the files above, then run it again')
    process.exit(1)
  }
  let changed = 0
  for (const file of files) {
    const full = path.join(options.repo, file.path)
    const old = read(full)
    if (old === file.text) continue
    changed++
    if (options.check) {
      console.log(`${old === null ? 'missing' : 'differs'}: ${file.path}`)
      continue
    }
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, file.text)
    console.log(`${old === null ? 'create' : 'update'}: ${file.path}`)
  }
  const readmeFile = path.join(options.repo, 'README.md')
  // --check reports the family section through checkReadme; a write run writes it first.
  const family = options.check ? null : writeFamily(info, read(readmeFile))
  if (family !== null) {
    changed++
    fs.writeFileSync(readmeFile, family)
    console.log('update: README.md (the Kition family section)')
  }
  const size = (file) => {
    try {
      const stat = fs.statSync(path.join(options.repo, file))
      return stat.isFile() ? stat.size : null
    } catch {
      return null
    }
  }
  const web = fs.existsSync(path.join(options.repo, 'web')) && fs.statSync(path.join(options.repo, 'web')).isDirectory()
  const findings = [
    ...checkReadme(info, read(path.join(options.repo, 'README.md')), manifest, { size }),
    ...checkDevelopment(info, read(path.join(options.repo, 'docs', 'development.md')), { web }),
  ]
  for (const finding of findings) console.log(finding)
  if (changed + findings.length + moved.length === 0) console.log('sync-community: up to date')
  else if (!options.check && changed === 0) console.log('sync-community: the generated files are up to date')
  process.exit(options.check && changed + findings.length + moved.length > 0 ? 1 : 0)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
