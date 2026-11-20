#!/usr/bin/env node
// Writes, packs and checks a kit version's npm packages (tools/kit-npm.mjs) for the kit
// repositories' Package workflow (KitionAI/kition .github/workflows/kit-package.yml). It never
// publishes: the workflow runs `npm publish` on what `pack` wrote, when `state` says so.
//
//   node tools/kit-npm-package.mjs headless --dir <folder> --platform <platform> --out <folder> [--commit <sha>] [--repository <owner/name>]
//       <folder> holds kit.json and the executable kition-<kit> (.exe on Windows), checked by the
//       workflow before; writes <out>/kit-<kit>-<platform>/, the package @kition/kit-<kit>-<platform>.
//   node tools/kit-npm-package.mjs ui --from <kition-<kit>-<version>.tgz | <kit>-ui folder> --out <folder>
//        [--commit <sha>] [--sdk-commit <sha>] [--tessera-commit <sha>] [--fonts-commit <sha>] [--repository <owner/name>]
//       writes <out>/kit-<kit>-ui/, the package @kition/kit-<kit>-ui holding the folder <kit>-ui/.
//   node tools/kit-npm-package.mjs pack --folder <package folder> --out <folder>
//       `npm pack`s it into <out> and checks the archive holds exactly package/package.json and
//       the folder's files, byte for byte; prints { file, name, version, size, integrity }.
//   node tools/kit-npm-package.mjs state --tarball <file.tgz> --registry <address>
//       Prints `publish` when the registry has no such version, `published` when it has the same
//       bytes (integrity); exits 1 when it has other bytes: a version is published once, never replaced.
//   node tools/kit-npm-package.mjs missing --kit <kit> --version <version> --registry <address>
//       Prints JSON { platforms, ui }: the platforms whose package of that version the registry
//       lacks, and whether it lacks the editor package.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrityOf, packageManifest, packageName, PLATFORMS } from './kit-npm.mjs'

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
export function writeHeadless({ dir, platform, out, commit, repository }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORMS.join(', ')})`)
  const kitJson = readJson(path.join(dir, 'kit.json'))
  const executable = `${kitJson.headless?.executable ?? ''}${platform.startsWith('win32') ? '.exe' : ''}`
  if (!kitJson.headless?.executable || kitJson.headless.executable.includes('/')) throw new Error(`${dir}/kit.json names no executable (headless.executable)`)
  if (!fs.statSync(path.join(dir, executable), { throwIfNoEntry: false })?.isFile()) throw new Error(`${dir} has no ${executable}`)
  const manifest = packageManifest(kitJson, 'headless', { platform, build: { commit }, files: ['kit.json', executable], repository })
  const folder = path.join(out, manifest.name.split('/')[1])
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
  fs.copyFileSync(path.join(dir, 'kit.json'), path.join(folder, 'kit.json'))
  fs.copyFileSync(path.join(dir, executable), path.join(folder, executable))
  fs.chmodSync(path.join(folder, executable), 0o755)
  fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return folder
}

/** Writes the editor package of `from` (the kit's package archive or its `<kit>-ui` folder) into `out`; answers its folder. */
export function writeUi({ from, out, commit, sdkCommit, tesseraCommit, fontsCommit, repository }) {
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
    const manifest = packageManifest(kitJson, 'ui', { build: { commit, sdkCommit, tesseraCommit, fontsCommit }, files: [top], repository })
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
export async function missing({ kit, version, registry }, fetchImpl) {
  const platforms = []
  for (const platform of PLATFORMS) if (!(await registryVersion(registry, packageName(kit, platform), version, fetchImpl))) platforms.push(platform)
  const ui = !(await registryVersion(registry, packageName(kit, 'ui'), version, fetchImpl))
  return { platforms, ui }
}

async function main(argv) {
  const [command, ...args] = argv
  const flag = (name, required = true) => {
    const at = args.indexOf(name)
    const value = at >= 0 ? args[at + 1] : undefined
    if (required && (value === undefined || value.startsWith('--'))) throw new Error(`${command} needs ${name}`)
    return value
  }
  switch (command) {
    case 'headless':
      process.stdout.write(`${writeHeadless({ dir: path.resolve(flag('--dir')), platform: flag('--platform'), out: path.resolve(flag('--out')), commit: flag('--commit', false), repository: flag('--repository', false) })}\n`)
      return
    case 'ui':
      process.stdout.write(
        `${writeUi({ from: path.resolve(flag('--from')), out: path.resolve(flag('--out')), commit: flag('--commit', false), sdkCommit: flag('--sdk-commit', false), tesseraCommit: flag('--tessera-commit', false), fontsCommit: flag('--fonts-commit', false), repository: flag('--repository', false) })}\n`,
      )
      return
    case 'pack':
      process.stdout.write(`${JSON.stringify(pack({ folder: path.resolve(flag('--folder')), out: path.resolve(flag('--out')) }))}\n`)
      return
    case 'state':
      process.stdout.write(`${await state({ tarball: path.resolve(flag('--tarball')), registry: flag('--registry') })}\n`)
      return
    case 'missing':
      process.stdout.write(`${JSON.stringify(await missing({ kit: flag('--kit'), version: flag('--version'), registry: flag('--registry') }))}\n`)
      return
    default:
      throw new Error('usage: kit-npm-package.mjs headless|ui|pack|state|missing ... (see the header of tools/kit-npm-package.mjs)')
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
