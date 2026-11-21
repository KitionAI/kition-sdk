#!/usr/bin/env node
// Writes, packs and checks a kit version's npm packages (tools/kit-npm.mjs) for the kit
// repositories' Package workflow (KitionAI/kition .github/workflows/kit-package.yml). It never
// publishes: the workflow runs `npm publish` on what `pack` wrote, when `state` says so. The
// packages are named in the scope `--scope` names, else `KITION_NPM_SCOPE`, else @kition, by that
// scope's layout (tools/kit-npm.mjs); below with @kition's names. `headless` and `ui` print the
// folder they wrote, named as the package without its scope.
//
//   node tools/kit-npm-package.mjs headless --dir <folder> --platform <platform> --out <folder> [--commit <sha>] [--repository <owner/name>]
//       <folder> holds kit.json and the executable kition-<kit> (.exe on Windows), checked by the
//       workflow before; writes <out>/kit-<kit>-<platform>/, the package @kition/kit-<kit>-<platform>,
//       with a short README.md (headlessReadme).
//   node tools/kit-npm-package.mjs ui --from <kition-<kit>-<version>.tgz | <kit>-ui folder> --out <folder>
//        [--commit <sha>] [--sdk-commit <sha>] [--tessera-commit <sha>] [--fonts-commit <sha>] [--repository <owner/name>]
//       writes <out>/kit-<kit>-ui/, the package @kition/kit-<kit>-ui holding the folder <kit>-ui/; its
//       README (uiReadme) is package.json's `readme`, since kition and Kition take the package's
//       top to hold only that folder.
//   Without --repository the kit's repository is the one templates/community/repositories.json
//   gives; a kit not there is refused.
//   node tools/kit-npm-package.mjs pack --folder <package folder> --out <folder>
//       `npm pack`s it into <out> and checks the archive holds exactly package/package.json and
//       the folder's files, byte for byte; prints { file, name, version, size, integrity }.
//   node tools/kit-npm-package.mjs state --tarball <file.tgz> --registry <address>
//       Prints `publish` when the registry has no such version, `published` when it has the same
//       bytes (integrity); exits 1 when it has other bytes: a version is published once, never replaced.
//   node tools/kit-npm-package.mjs missing --kit <kit> --version <version> --registry <address>
//       Prints JSON { platforms, ui }: the platforms whose package of that version the registry
//       lacks, and whether it lacks the editor package.
//   node tools/kit-npm-package.mjs visible --name <package> --version <version> --registry <address> [--tag <dist-tag>] [--minutes <n>]
//       Waits until the registry shows <package>@<version> with its bytes (its metadata, the tag
//       pointing at it, and its tarball downloadable with the integrity the metadata gives), asking
//       every 30 seconds for at most <n> minutes (40): a first publish of a name shows only npm's
//       placeholder 0.0.0-stage for several minutes (12 to 24 for a 30 MB package). Exits 1 after
//       that, naming what is still missing.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kitFormats, kitOf, readFamily, renderFamily } from './kition-family.mjs'
import { checkScope, integrityOf, kitRepository, kitionField, npmScope, packageManifest, packageName, PLATFORMS, tarballPath } from './kit-npm.mjs'

const DEVELOPER = 'https://developer.kition.ai'
const SDK_DOCS = 'https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk'
/**
 * The module an editor package's README tells a page to mount the editor with: one that npm
 * installs today. Switch to @kition/sdk/embed at the first release of @kition/sdk (the link then
 * names its package, @kition/sdk).
 */
export const README_EMBED_SPECIFIER = '@kition/embed'

/** The license line of a kit package's README: kit.json's license and the repository's LICENSE. */
const licenseSection = (kitJson, github) => `## License\n\n${typeof kitJson.license === 'string' ? kitJson.license : 'UNLICENSED'} ([LICENSE](${github}/blob/main/LICENSE)).\n`

/**
 * The README of a kit's editor package (npm shows it): the kit, its links, what the package holds
 * (with its version and kit id), how it is used, its formats, the Kition family, the license. Every
 * link is absolute.
 */
export function uiReadme(kitJson, { repository } = {}) {
  const { kit, id, version } = kitionField(kitJson, 'ui')
  const info = kitOf(kit)
  const github = `https://github.com/${kitRepository(kit, repository)}`
  const formats = kitFormats(kitJson)
  return [
    `# ${info.title}`,
    '',
    `${info.description}.`,
    '',
    `[GitHub](${github}) · [Showcase](https://github.com/KitionAI/kition-showcase/tree/main/${kit}) · [Developer docs](${DEVELOPER})`,
    '',
    `This package is ${info.title}'s editor and its WebAssembly engine: the folder \`${kit}-ui/\` (\`index.html\`, the engine, fonts and the kit's \`kit.json\`), kit \`${id}\` version ${version}.`,
    '',
    '## Use it',
    '',
    `You do not install this package by hand. [\`kition\`](${SDK_DOCS}/cli.md) installs it with the kit (\`kition kit install ${kit}\`, or \`npx @kition/cli kit install ${kit}\`), and \`kition gateway\` installs it the first time its page opens a ${info.name} file.`,
    '',
    `To embed the editor in your own page, host the folder \`${kit}-ui/\` on its own origin and mount it with [\`${README_EMBED_SPECIFIER}\`](https://www.npmjs.com/package/${README_EMBED_SPECIFIER.split('/').slice(0, 2).join('/')}): \`KitionEmbed.mount(element, { kit: { id: '${id}', url: 'https://kits.example.com/${kit}-ui/' }, file, storage, identity })\` ([the embed guide](${SDK_DOCS}/embed.md)).`,
    '',
    '## Formats',
    '',
    '| Opens | Creates | Exports |',
    '| --- | --- | --- |',
    `| ${formats.opens} | ${formats.creates} | ${formats.exports} |`,
    '',
    renderFamily(readFamily(), { kit }).trimEnd(),
    '',
    licenseSection(kitJson, github),
  ].join('\n')
}

/** The README of a kit's headless package for `platform` (npm shows it): short, no family table. */
export function headlessReadme(kitJson, { platform, repository, scope = npmScope() }) {
  const { kit } = kitionField(kitJson, 'headless', { platform })
  const info = kitOf(kit)
  const github = `https://github.com/${kitRepository(kit, repository)}`
  return [
    `# ${info.title} for ${platform}`,
    '',
    `The headless executable of ${info.title} for ${platform}, with the kit's \`kit.json\`. [\`kition\`](${SDK_DOCS}/cli.md) installs it (\`kition kit install ${kit}\`); it is not meant to be installed by hand.`,
    '',
    `${info.description}.`,
    '',
    `GitHub: ${github} · The editor: [\`${packageName(kit, 'ui', scope)}\`](https://www.npmjs.com/package/${packageName(kit, 'ui', scope)})`,
    '',
    `Part of Kition: ${readFamily().org}`,
    '',
    licenseSection(kitJson, github),
  ].join('\n')
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Every file under `dir`, as `/`-separated paths relative to it, sorted. */
function filesUnder(dir, prefix = '') {
  const found = []
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...filesUnder(dir, relative))
    else if (entry.isFile()) found.push(relative)
    else throw new Error(`${path.join(dir, relative)} is neither a file nor a folder`)
  }
  return found.sort()
}

/** Writes the headless package of the build in `dir` for `platform` into `out`; answers its folder. */
export function writeHeadless({ dir, platform, out, commit, repository, scope = npmScope() }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORMS.join(', ')})`)
  const kitJson = readJson(path.join(dir, 'kit.json'))
  const executable = `${kitJson.headless?.executable ?? ''}${platform.startsWith('win32') ? '.exe' : ''}`
  if (!kitJson.headless?.executable || kitJson.headless.executable.includes('/')) throw new Error(`${dir}/kit.json names no executable (headless.executable)`)
  if (!fs.statSync(path.join(dir, executable), { throwIfNoEntry: false })?.isFile()) throw new Error(`${dir} has no ${executable}`)
  const manifest = packageManifest(kitJson, 'headless', { platform, build: { commit }, files: ['README.md', 'kit.json', executable], repository, scope })
  const readme = headlessReadme(kitJson, { platform, repository, scope })
  const folder = path.join(out, manifest.name.split('/')[1])
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
  fs.copyFileSync(path.join(dir, 'kit.json'), path.join(folder, 'kit.json'))
  fs.copyFileSync(path.join(dir, executable), path.join(folder, executable))
  fs.chmodSync(path.join(folder, executable), 0o755)
  fs.writeFileSync(path.join(folder, 'README.md'), readme)
  fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return folder
}

/** Writes the editor package of `from` (the kit's package archive or its `<kit>-ui` folder) into `out`; answers its folder. */
export function writeUi({ from, out, commit, sdkCommit, tesseraCommit, fontsCommit, repository, scope = npmScope() }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-ui-'))
  try {
    let source = from
    if (fs.statSync(from).isFile()) {
      execFileSync('tar', ['-xzf', path.basename(from), '-C', stage], { cwd: path.dirname(from) })
      const tops = fs.readdirSync(stage)
      if (tops.length !== 1 || !tops[0].endsWith('-ui')) throw new Error(`${from} holds ${tops.join(', ')}, not one folder <kit>-ui`)
      source = path.join(stage, tops[0])
    }
    const top = path.basename(source)
    const kitJson = readJson(path.join(source, 'kit.json'))
    const kit = String(kitJson.id).replace(/^kit\./, '')
    if (top !== `${kit}-ui`) throw new Error(`${source}: the folder of ${kitJson.id}'s editor is ${kit}-ui, not ${top}`)
    if (!fs.existsSync(path.join(source, 'index.html'))) throw new Error(`${source} has no index.html`)
    const manifest = packageManifest(kitJson, 'ui', { build: { commit, sdkCommit, tesseraCommit, fontsCommit }, files: [top], repository, scope, readme: uiReadme(kitJson, { repository }) })
    const folder = path.join(out, manifest.name.split('/')[1])
    fs.rmSync(folder, { recursive: true, force: true })
    fs.mkdirSync(folder, { recursive: true })
    fs.cpSync(source, path.join(folder, top), { recursive: true, filter: (file) => path.basename(file) !== '.kition-package.json' })
    fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return folder
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * `npm pack`s `folder` into `out`, and checks the archive holds exactly `package/package.json` and
 * the folder's files with their bytes (npm leaves out some names by its own rules, which must not
 * drop a file a kit needs). Answers `{ file, name, version, size, integrity }`.
 */
export function pack({ folder, out }) {
  fs.mkdirSync(out, { recursive: true })
  const manifest = readJson(path.join(folder, 'package.json'))
  // npm is npm.cmd on Windows, which only a shell starts.
  const windows = process.platform === 'win32'
  const quote = (value) => (windows ? `"${value}"` : value)
  const [packed] = JSON.parse(
    execFileSync(windows ? 'npm.cmd' : 'npm', ['pack', quote(folder), '--pack-destination', quote(out), '--json', '--ignore-scripts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: windows }),
  )
  const file = path.join(out, packed.filename)
  const check = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-pack-check-'))
  try {
    execFileSync('tar', ['-xzf', path.basename(file), '-C', check], { cwd: out })
    const inside = filesUnder(check)
    const expected = ['package/package.json', ...filesUnder(folder).filter((name) => name !== 'package.json').map((name) => `package/${name}`)].sort()
    const missing = expected.filter((name) => !inside.includes(name))
    const extra = inside.filter((name) => !expected.includes(name))
    if (missing.length || extra.length) throw new Error(`${packed.filename} is not the folder's files: ${[...missing.map((name) => `lacks ${name}`), ...extra.map((name) => `adds ${name}`)].join(', ')}`)
    for (const name of expected.filter((name) => name !== 'package/package.json')) {
      if (!fs.readFileSync(path.join(check, name)).equals(fs.readFileSync(path.join(folder, name.slice('package/'.length))))) throw new Error(`${packed.filename}: ${name} is not the folder's bytes`)
    }
  } finally {
    fs.rmSync(check, { recursive: true, force: true })
  }
  const bytes = fs.readFileSync(file)
  return { file, name: manifest.name, version: manifest.version, size: bytes.length, integrity: integrityOf(bytes) }
}

/** The registry's metadata of `name` at `version`, or null when it has no such version. */
export async function registryVersion(registry, name, version, fetchImpl = globalThis.fetch) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const response = await fetchImpl(`${base}${name.replace('/', '%2f')}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${base} answered HTTP ${response.status} for ${name}@${version}`)
  const found = await response.json()
  if (found?.version !== version) return null
  return found
}

/** `publish` or `published` for the packed `tarball`; throws when the registry holds other bytes. */
export async function state({ tarball, registry }, fetchImpl) {
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path.basename(tarball), 'package/package.json'], { cwd: path.dirname(tarball), encoding: 'utf8' }))
  const found = await registryVersion(registry, manifest.name, manifest.version, fetchImpl)
  if (!found) return 'publish'
  const ours = integrityOf(fs.readFileSync(tarball))
  if (found.dist?.integrity !== ours) {
    throw new Error(`${manifest.name}@${manifest.version} is on ${registry} with the integrity ${found.dist?.integrity}; this build's is ${ours}. A version is published once: bump the kit's version to publish a change`)
  }
  return 'published'
}

/** The packages of `kit` `version` the registry lacks: `{ platforms, ui }`. */
export async function missing({ kit, version, registry, scope = npmScope() }, fetchImpl) {
  const platforms = []
  for (const platform of PLATFORMS) if (!(await registryVersion(registry, packageName(kit, platform, scope), version, fetchImpl))) platforms.push(platform)
  const ui = !(await registryVersion(registry, packageName(kit, 'ui', scope), version, fetchImpl))
  return { platforms, ui }
}

/**
 * What the registry does not show yet of `name`@`version` with its bytes: its metadata at that
 * version, `tag` (when given) pointing at it, and its tarball downloadable with the integrity the
 * metadata gives. Answers null when it shows all of it. An answer of the registry other than 200
 * or 404 is "not yet" too: the caller asks again.
 */
export async function notVisible({ registry, name, version, tag }, fetchImpl = globalThis.fetch) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  try {
    const found = await registryVersion(base, name, version, fetchImpl)
    if (!found) return `${name}@${version} is not listed yet`
    if (tag) {
      const response = await fetchImpl(`${base}${name.replace('/', '%2f')}/${encodeURIComponent(tag)}`, { headers: { accept: 'application/json' } })
      const tagged = response.ok ? (await response.json())?.version : null
      if (tagged !== version) return `${name}'s ${tag} is ${tagged ?? `not answered (HTTP ${response.status})`}, not ${version} yet`
    }
    const integrity = found.dist?.integrity
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return `${name}@${version} gives no sha512 integrity yet`
    const tarball = await fetchImpl(`${base}${tarballPath(name, version)}`)
    if (!tarball.ok) return `${name}@${version}'s tarball answers HTTP ${tarball.status}`
    const bytes = Buffer.from(await tarball.arrayBuffer())
    if (integrityOf(bytes) !== integrity) return `${name}@${version}'s tarball does not have the integrity ${integrity} yet`
    return null
  } catch (error) {
    return `${base} cannot be asked: ${error.message}`
  }
}

/**
 * Waits until `notVisible` answers null, asking every `intervalMs` for at most `timeoutMs`; says
 * each new reason through `log`. Throws after `timeoutMs`, naming the last reason.
 */
export async function waitVisible({ registry, name, version, tag, timeoutMs = 40 * 60_000, intervalMs = 30_000 }, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, log = () => {} } = {}) {
  const start = now()
  let said = null
  for (;;) {
    const why = await notVisible({ registry, name, version, tag }, fetchImpl)
    if (why === null) return now() - start
    if (why !== said) log(`${Math.round((now() - start) / 1000)}s: ${why}`)
    said = why
    if (now() - start + intervalMs > timeoutMs) throw new Error(`${name}@${version} is not visible on ${registry} after ${Math.round(timeoutMs / 60_000)} minutes: ${why}`)
    await sleep(intervalMs)
  }
}

async function main(argv) {
  const [command, ...args] = argv
  const flag = (name, required = true) => {
    const at = args.indexOf(name)
    const value = at >= 0 ? args[at + 1] : undefined
    if (required && (value === undefined || value.startsWith('--'))) throw new Error(`${command} needs ${name}`)
    return value
  }
  const scope = args.includes('--scope') ? checkScope(flag('--scope', false), '--scope') : npmScope()
  switch (command) {
    case 'headless':
      process.stdout.write(`${writeHeadless({ dir: path.resolve(flag('--dir')), platform: flag('--platform'), out: path.resolve(flag('--out')), commit: flag('--commit', false), repository: flag('--repository', false), scope })}\n`)
      return
    case 'ui':
      process.stdout.write(
        `${writeUi({ from: path.resolve(flag('--from')), out: path.resolve(flag('--out')), commit: flag('--commit', false), sdkCommit: flag('--sdk-commit', false), tesseraCommit: flag('--tessera-commit', false), fontsCommit: flag('--fonts-commit', false), repository: flag('--repository', false), scope })}\n`,
      )
      return
    case 'pack':
      process.stdout.write(`${JSON.stringify(pack({ folder: path.resolve(flag('--folder')), out: path.resolve(flag('--out')) }))}\n`)
      return
    case 'state':
      process.stdout.write(`${await state({ tarball: path.resolve(flag('--tarball')), registry: flag('--registry') })}\n`)
      return
    case 'missing':
      process.stdout.write(`${JSON.stringify(await missing({ kit: flag('--kit'), version: flag('--version'), registry: flag('--registry'), scope }))}\n`)
      return
    case 'visible': {
      const minutes = Number(flag('--minutes', false) ?? 40)
      if (!(minutes > 0)) throw new Error('visible: --minutes is a number of minutes above 0')
      const name = flag('--name')
      const version = flag('--version')
      const waited = await waitVisible({ registry: flag('--registry'), name, version, tag: flag('--tag', false), timeoutMs: minutes * 60_000 }, { log: (line) => process.stderr.write(`${line}\n`) })
      process.stdout.write(`${name}@${version} is visible with its bytes after ${Math.round(waited / 1000)}s\n`)
      return
    }
    default:
      throw new Error('usage: kit-npm-package.mjs headless|ui|pack|state|missing|visible ... [--scope <@scope>] (see the header of tools/kit-npm-package.mjs)')
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`kit-npm-package: ${error.message}\n`)
    process.exit(1)
  }
}
