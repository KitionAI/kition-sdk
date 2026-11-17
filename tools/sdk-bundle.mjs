#!/usr/bin/env node
// Assembles the Kition SDK bundle a customer receives (from a private registry or a Kition
// Console download): the npm packages as tarballs, the kit packages pinned in Kition's
// kits/kits.lock.json (each with its kit.json beside it, for `kition-kits serve --kits-dir`), the
// executables built on this machine (`kition-kits`, `kition-kits-mcp`, each kit's), the SDK guide,
// the platform documents and schemas it links to (the Kit Process Protocol among them), the examples
// it links to, and the Kit Harness Protocol (KHP, a KHP specification checkout), with a
// manifest and SHA-256 sums. Every relative link in the bundle's documents must resolve inside the
// bundle, and every kit executable must speak the SDK's Kit Process Protocol, or no bundle is made.
// Local only: it publishes nothing.
//
//   node tools/sdk-bundle.mjs [--out <dir>] [--lock <kits.lock.json>] [--kits slide,sheet]
//                             [--kit-assets <dir>] [--standard <dir>] [--no-kits] [--no-build] [--archive]
//
// --out          the bundle folder (default $HOME/.cache/kition-sdk-bundle/<version>)
// --lock         Kition's kit lock (default KITION_KITS_LOCK, else ../kition/kits/kits.lock.json)
// --kits         which kits (default sdk.json `kits`)
// --kit-assets   a folder holding the pinned kit tarballs already; else `gh release download`
// --standard     a supplied KHP checkout (or KIT_STANDARD_DIR); its spec/
//                and CHANGES.md become the bundle's docs/khp/
// --no-kits      leave the kit packages out (a packages-and-docs bundle)
// --no-build     use the packages' existing dist/
// --archive      also write kition-sdk-<version>.tar.gz (and .sha256) next to the folder
//
// Executables are taken when present: KITION_KITS, KITION_KITS_MCP and KITION_KIT_<KIT>_BINARY.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokenLinks, shippedFiles } from './bundle-docs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdk = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8'))

function options(argv) {
  const out = { kits: sdk.kits, build: true, withKits: true, archive: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (!next) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--out') out.out = path.resolve(value())
    else if (arg === '--lock') out.lock = path.resolve(value())
    else if (arg === '--kits') out.kits = value().split(',').map((kit) => kit.trim()).filter(Boolean)
    else if (arg === '--kit-assets') out.kitAssets = path.resolve(value())
    else if (arg === '--standard') out.standard = path.resolve(value())
    else if (arg === '--no-kits') out.withKits = false
    else if (arg === '--no-build') out.build = false
    else if (arg === '--archive') out.archive = true
    else throw new Error(`unknown argument ${arg}`)
  }
  out.out ??= path.join(os.homedir(), '.cache', 'kition-sdk-bundle', sdk.version)
  out.lock ??= path.resolve(process.env.KITION_KITS_LOCK || path.join(root, '..', 'kition', 'kits', 'kits.lock.json'))
  out.standard ??= path.resolve(process.env.KIT_STANDARD_DIR || path.join(root, '..', 'khp'))
  return out
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  return result.stdout
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const entry = (bundle, file) => ({ file: path.relative(bundle, file).split(path.sep).join('/'), size: fs.statSync(file).size, sha256: sha256(file) })

/** The package folder of each workspace package, by name. */
function workspacePackages() {
  const dir = path.join(root, 'packages')
  const found = new Map()
  for (const name of fs.readdirSync(dir)) {
    const manifest = path.join(dir, name, 'package.json')
    if (fs.existsSync(manifest)) found.set(JSON.parse(fs.readFileSync(manifest, 'utf8')).name, path.join(dir, name))
  }
  return found
}

/**
 * The manifest a customer installs: no `private`, no scripts or development dependencies, and
 * entry points on the built modules where there are some, with their declarations where those
 * were emitted (else the types stay on the sources), and `main` and `types` on the `.` entry.
 */
function shippedManifest(manifest, packageDir) {
  const shipped = { ...manifest, kitionSdk: sdk.version }
  delete shipped.private
  delete shipped.scripts
  delete shipped.devDependencies
  if (shipped.exports && typeof shipped.exports === 'object') {
    shipped.exports = Object.fromEntries(
      Object.entries(shipped.exports).map(([key, target]) => {
        if (typeof target !== 'string' || !/\.ts$/.test(target)) return [key, target]
        // `./kits` (`kits/index.ts`) is built as `dist/kits/index.js`; `./node` as `dist/node.js`.
        const name = key === '.' ? 'index' : key.replace(/^\.\//, '')
        const built = [`./dist/${name}.js`, `./dist/${name}/index.js`].find((file) => fs.existsSync(path.join(packageDir, file)))
        if (!built) return [key, target]
        const declarations = built.replace(/\.js$/, '.d.ts')
        return [key, { types: fs.existsSync(path.join(packageDir, declarations)) ? declarations : target, import: built }]
      }),
    )
    const main = shipped.exports['.']
    if (main && typeof main === 'object' && main.import) {
      shipped.main = main.import
      if (main.types) shipped.types = main.types
    }
  }
  return shipped
}

function packPackage(name, packageDir, npmDir, scratch) {
  const before = new Set(fs.readdirSync(scratch))
  run('pnpm', ['pack', '--pack-destination', scratch], packageDir)
  const tarball = fs.readdirSync(scratch).find((file) => file.endsWith('.tgz') && !before.has(file))
  if (!tarball) throw new Error(`pnpm pack wrote no tarball for ${name}`)
  const stage = fs.mkdtempSync(path.join(scratch, 'stage-'))
  run('tar', ['-xzf', path.join(scratch, tarball), '-C', stage])
  const manifestFile = path.join(stage, 'package', 'package.json')
  const manifest = shippedManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), packageDir)
  const targets = Object.values(manifest.exports ?? {}).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)))
  targets.push(...(typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})))
  const missing = targets.filter((file) => !fs.existsSync(path.join(stage, 'package', file)))
  if (missing.length) throw new Error(`${name}: the package lacks ${missing.join(', ')} (build it, or leave out --no-build)`)
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const target = path.join(npmDir, tarball)
  run('tar', ['-czf', target, '-C', stage, 'package'])
  return { version: manifest.version, target }
}

function fetchKit(kit, pinned, kitsDir, kitAssets) {
  const target = path.join(kitsDir, pinned.asset)
  if (kitAssets) fs.copyFileSync(path.join(kitAssets, pinned.asset), target)
  else run('gh', ['release', 'download', pinned.tag, '--repo', pinned.repository, '--pattern', pinned.asset, '--dir', kitsDir, '--clobber'])
  const size = fs.statSync(target).size
  const sum = sha256(target)
  if (size !== pinned.size || sum !== pinned.sha256) {
    throw new Error(`${pinned.asset}: ${size} bytes, sha256 ${sum}; the lock pins ${pinned.size} bytes, sha256 ${pinned.sha256}`)
  }
  return target
}

/** The documents, schemas and examples (`shippedFiles`), and the KHP in `docs/khp/spec/`. */
function copyDocs(bundle, standardDir) {
  const copied = []
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    copied.push(to)
  }
  for (const file of shippedFiles(root)) copy(path.join(root, file), path.join(bundle, file))
  const spec = path.join(standardDir, 'spec')
  if (!fs.existsSync(path.join(spec, 'index.md'))) throw new Error(`no KHP at ${standardDir}: set --standard or KIT_STANDARD_DIR`)
  // As the KHP repository lays it out, so its links (to `../CHANGES.md`) hold.
  for (const file of fs.readdirSync(spec, { recursive: true })) {
    const from = path.join(spec, file)
    if (fs.statSync(from).isFile()) copy(from, path.join(bundle, 'docs', 'khp', 'spec', file))
  }
  for (const file of ['CHANGES.md', 'LICENSE']) {
    if (fs.existsSync(path.join(standardDir, file))) copy(path.join(standardDir, file), path.join(bundle, 'docs', 'khp', file))
  }
  return copied
}

/** The Kit Process Protocol version this SDK's kits speak (kition-kit-process-protocol's PROTOCOL_VERSION). */
function sdkProtocol() {
  const source = fs.readFileSync(path.join(root, 'crates', 'kition-kit-process-protocol', 'src', 'lib.rs'), 'utf8')
  const version = source.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)
  if (!version) throw new Error('kition-kit-process-protocol states no PROTOCOL_VERSION')
  return Number(version[1])
}

/**
 * Starts a kit executable as a host would (protocol section 3) and answers the version its ready
 * line announces: what the bundle says it speaks is what it was seen to speak.
 */
function readyProtocol(executable, protocol) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'))
  fs.chmodSync(dir, 0o700)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--kition-kit'], {
      env: { ...process.env, KITION_KIT_PROTOCOL: String(protocol), KITION_KIT_ENDPOINT: path.join(dir, 'kit.sock'), KITION_KIT_TOKEN: crypto.randomBytes(32).toString('hex'), KITION_KIT_SURFACE: 'headless' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    const done = (outcome) => {
      clearTimeout(timer)
      child.kill()
      fs.rmSync(dir, { recursive: true, force: true })
      outcome instanceof Error ? reject(outcome) : resolve(outcome)
    }
    const timer = setTimeout(() => done(new Error(`${path.basename(executable)} wrote no ready line within 10 s`)), 10_000)
    child.stderr.on('data', (chunk) => (errors += chunk))
    child.stdout.on('data', (chunk) => {
      output += chunk
      const line = output.split('\n')[0]
      if (output.includes('\n')) {
        try {
          done(JSON.parse(line).protocolVersion)
        } catch {
          done(new Error(`${path.basename(executable)}: not a ready line: ${line}`))
        }
      }
    })
    child.on('exit', (code) => done(new Error(`${path.basename(executable)} exited (${code}) before its ready line: ${errors.trim()}`)))
  })
}

/** The kit.json inside a kit package (`<kit>-ui/kit.json`), unpacked to `kits/<kit>/kit.json`. */
function unpackManifest(tarball, kit, kitsDir) {
  const entry = run('tar', ['-tzf', tarball]).split('\n').find((name) => /^[^/]+\/kit\.json$/.test(name))
  if (!entry) throw new Error(`${path.basename(tarball)} has no kit.json`)
  const target = path.join(kitsDir, kit, 'kit.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, run('tar', ['-xzOf', tarball, entry]))
  return target
}

const opts = options(process.argv.slice(2))
const bundle = opts.out
fs.rmSync(bundle, { recursive: true, force: true })
const dirs = { npm: path.join(bundle, 'npm'), kits: path.join(bundle, 'kits'), bin: path.join(bundle, 'bin', `${process.platform}-${process.arch}`) }
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
const scratch = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'kition-sdk-pack-'))

try {
  const packages = workspacePackages()
  const built = sdk.packages.filter((name) => JSON.parse(fs.readFileSync(path.join(packages.get(name), 'package.json'), 'utf8')).scripts?.build)
  if (opts.build && built.length) run('pnpm', built.flatMap((name) => ['--filter', name]).concat('build'))

  const manifest = {
    name: 'kition-sdk',
    version: sdk.version,
    created: new Date().toISOString(),
    source: { commit: run('git', ['rev-parse', 'HEAD']).trim(), clean: run('git', ['status', '--porcelain', '--untracked-files=no']).trim() === '' },
    platform: `${process.platform}-${process.arch}`,
    packages: [],
    kits: [],
    binaries: [],
    docs: [],
  }

  for (const name of sdk.packages) {
    const dir = packages.get(name)
    if (!dir) throw new Error(`no workspace package ${name}`)
    const packed = packPackage(name, dir, dirs.npm, scratch)
    manifest.packages.push({ name, version: packed.version, ...entry(bundle, packed.target) })
  }

  if (opts.withKits) {
    if (!fs.existsSync(opts.lock)) throw new Error(`no kit lock at ${opts.lock}: set --lock or KITION_KITS_LOCK, or pass --no-kits`)
    const lock = JSON.parse(fs.readFileSync(opts.lock, 'utf8'))
    for (const kit of opts.kits) {
      const pinned = lock[kit]
      if (!pinned) throw new Error(`the lock pins no ${kit}`)
      const file = fetchKit(kit, pinned, dirs.kits, opts.kitAssets)
      const kitJson = unpackManifest(file, kit, dirs.kits)
      const protocol = JSON.parse(fs.readFileSync(kitJson, 'utf8')).headless?.protocol ?? null
      manifest.kits.push({
        kit,
        version: pinned.version,
        repository: pinned.repository,
        tag: pinned.tag,
        commit: pinned.commit,
        sdkCommit: pinned.sdkCommit,
        protocol,
        manifest: path.relative(bundle, kitJson).split(path.sep).join('/'),
        ...entry(bundle, file),
      })
    }
  }

  // What each executable speaks: a kit the Kit Process Protocol (its ready line, seen here), the
  // service the Kits Service API to its host and the Kit Process Protocol to the kits.
  const protocol = sdkProtocol()
  const executables = [
    { name: sdk.binaries.service.name, from: process.env[sdk.binaries.service.env], speaks: { service: `kits-service/${sdk.binaries.service.version}`, protocol: `kition-kit/${protocol}` } },
    { name: sdk.binaries.mcp.name, from: process.env[sdk.binaries.mcp.env], speaks: { protocol: `kition-kit/${protocol}` } },
    ...opts.kits.map((kit) => ({ name: `kition-${kit}`, from: process.env[`KITION_KIT_${kit.toUpperCase()}_BINARY`], kit })),
  ]
  for (const { name, from, speaks, kit } of executables) {
    if (!from || !fs.existsSync(from)) continue
    const target = path.join(dirs.bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
    fs.copyFileSync(from, target)
    fs.chmodSync(target, 0o755)
    let said = speaks
    if (kit) {
      const version = await readyProtocol(target, protocol)
      if (version !== protocol) throw new Error(`${name} speaks Kit Process Protocol ${version}; this SDK's hosts speak ${protocol}: build it on this kition-sdk`)
      said = { protocol: `kition-kit/${version}` }
      const pinned = manifest.kits.find((entry) => entry.kit === kit)
      if (pinned && pinned.protocol !== said.protocol) throw new Error(`${name} speaks ${said.protocol}, but its package's kit.json says ${pinned.protocol}`)
    }
    manifest.binaries.push({ name, ...said, ...entry(bundle, target) })
  }

  for (const file of copyDocs(bundle, opts.standard)) manifest.docs.push(path.relative(bundle, file).split(path.sep).join('/'))
  const broken = brokenLinks(bundle)
  if (broken.length) throw new Error(`links that name no file in the bundle:\n  ${broken.join('\n  ')}`)

  fs.writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const sums = fs
    .readdirSync(bundle, { recursive: true })
    .map((file) => path.join(bundle, file))
    .filter((file) => fs.statSync(file).isFile() && path.basename(file) !== 'SHA256SUMS')
    .sort()
    .map((file) => `${sha256(file)}  ${path.relative(bundle, file).split(path.sep).join('/')}`)
  fs.writeFileSync(path.join(bundle, 'SHA256SUMS'), `${sums.join('\n')}\n`)

  console.log(`kition-sdk ${sdk.version}: ${manifest.packages.length} packages, ${manifest.kits.length} kits, ${manifest.binaries.length} executables, ${manifest.docs.length} documents in ${bundle}`)
  if (opts.archive) {
    const archive = path.join(path.dirname(bundle), `kition-sdk-${sdk.version}.tar.gz`)
    run('tar', ['-czf', archive, '-C', path.dirname(bundle), path.basename(bundle)])
    fs.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`)
    console.log(`archive: ${archive}`)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
