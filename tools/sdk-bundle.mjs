#!/usr/bin/env node
// Assembles the Kition SDK bundle for one platform, as the release workflow publishes it
// (.github/workflows/release.yml, docs/sdk/distribution.md): the npm packages as tarballs, the kit
// packages pinned in Kition's kits/kits.lock.json (each with its kit.json beside it, for
// `kition-kits serve --kits-dir`), the executables (`kition-kits`, `kition-kits-mcp`, each kit's)
// in bin/<platform>/, the SDK guide, the platform documents and schemas it links to (the Kit
// Process Protocol among them), the examples it links to, and the Kit Harness Protocol (KHP, a KHP
// specification checkout), with a manifest and SHA-256 sums. Every relative link in the bundle's
// documents must resolve inside the bundle, and every kit executable must answer `kit.initialize`
// with the SDK's Kit Process Protocol and its package's kit id and version
// (tools/kit-handshake.mjs), or no bundle is made. It publishes nothing.
//
//   node tools/sdk-bundle.mjs [--out <dir>] [--lock <kits.lock.json>] [--kits slide,sheet]
//                             [--kit-assets <dir>] [--standard <dir>] [--no-kits] [--no-build]
//                             [--bin <dir> --platform <platform>] [--archive]
//
// --out          the bundle folder (default $HOME/.cache/kition-sdk-bundle/kition-sdk-<version>[-<platform>])
// --lock         Kition's kit lock (default KITION_KITS_LOCK, else ../kition/kits/kits.lock.json):
//                an npm pin of each kit (tools/kit-lock.mjs)
// --kits         which kits (default sdk.json `kits`)
// --kit-assets   a folder holding the pinned kit packages already (kition-kit-<kit>-ui-<version>.tgz);
//                else they are downloaded from the npm registries (KITION_NPM_REGISTRY, npm's
//                registry setting, registry.npmjs.org, registry.npmmirror.com), checked against
//                the lock's integrity and size
// --standard     a supplied KHP checkout (or KIT_STANDARD_DIR); its spec/
//                and CHANGES.md become the bundle's docs/khp/
// --no-kits      leave the kit packages out (a packages-and-docs bundle)
// --no-build     use the packages' existing dist/
// --bin          executables built and checked on another machine for --platform: the folder
//                holds them and the handshakes.json that `kit-handshake.mjs --record` wrote there
// --platform     the platform of --bin (`darwin-arm64`, `linux-x64`, `win32-x64`, ...)
// --archive      also write <folder>.tar.gz (and .sha256) next to the folder
//
// Without --bin, executables built on this machine are taken when present: KITION_KITS,
// KITION_KITS_MCP and KITION_KIT_<KIT>_BINARY.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokenLinks, shippedFiles } from './bundle-docs.mjs'
import { handshake, readHandshakes, sdkProtocol } from './kit-handshake.mjs'
import { lockPins } from './kit-lock.mjs'
import { fetchPackage, integrityOf, registries as npmRegistries } from './kit-npm.mjs'

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
    else if (arg === '--bin') out.bin = path.resolve(value())
    else if (arg === '--platform') out.platform = value()
    else throw new Error(`unknown argument ${arg}`)
  }
  if (Boolean(out.bin) !== Boolean(out.platform)) throw new Error('--bin and --platform go together')
  out.platform ??= `${process.platform}-${process.arch}`
  const name = `kition-sdk-${sdk.version}${out.bin || hostExecutables().length ? `-${out.platform}` : ''}`
  out.out ??= path.join(os.homedir(), '.cache', 'kition-sdk-bundle', name)
  out.lock ??= path.resolve(process.env.KITION_KITS_LOCK || path.join(root, '..', 'kition', 'kits', 'kits.lock.json'))
  out.standard ??= path.resolve(process.env.KIT_STANDARD_DIR || path.join(root, '..', 'khp'))
  return out
}

/** The executables this machine's environment names (KITION_KITS, KITION_KITS_MCP, KITION_KIT_<KIT>_BINARY). */
function hostExecutables() {
  const named = [sdk.binaries.service.env, sdk.binaries.mcp.env, ...sdk.kits.map((kit) => `KITION_KIT_${kit.toUpperCase()}_BINARY`)]
  return named.map((variable) => process.env[variable]).filter((file) => file && fs.existsSync(file))
}

/** The commit of a git checkout, or null. */
function gitCommit(dir) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
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

/** The file `npm pack` names a pinned kit's editor package: `kition-kit-<kit>-ui-<version>.tgz`, `kitionstage-<kit>-<version>.tgz`. */
const packageFile = (pin) => `${pin.editor.package.replace(/^@/, '').replace('/', '-')}-${pin.version}.tgz`

/**
 * The pinned kit's editor package (tools/kit-lock.mjs `lockPin`: `@kition/kit-<kit>-ui` at its
 * version), from the npm registries (tools/kit-npm.mjs `registries`), or from `kitAssets` when
 * given; its integrity and size must be the lock's.
 */
async function fetchKit(pin, kitsDir, kitAssets) {
  const target = path.join(kitsDir, packageFile(pin))
  if (kitAssets) fs.copyFileSync(path.join(kitAssets, packageFile(pin)), target)
  else fs.writeFileSync(target, await fetchPackage(npmRegistries(process.env, readNpmrc()), pin.editor.package, pin.version, pin.editor.integrity))
  const bytes = fs.readFileSync(target)
  const found = integrityOf(bytes)
  if (found !== pin.editor.integrity) throw new Error(`${packageFile(pin)}: its integrity is ${found}; the lock pins ${pin.editor.integrity}`)
  if (bytes.length !== pin.editor.size) throw new Error(`${packageFile(pin)}: ${bytes.length} bytes; the lock pins ${pin.editor.size}`)
  return target
}

/** The person's .npmrc (npm_config_userconfig, else ~/.npmrc), read only. */
function readNpmrc() {
  const file = process.env.npm_config_userconfig || path.join(os.homedir(), '.npmrc')
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
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

/** The kit.json inside a kit package (`package/<kit>-ui/kit.json`), unpacked to `kits/<kit>/kit.json`. */
function unpackManifest(tarball, kit, kitsDir) {
  const entry = run('tar', ['-tzf', tarball]).split('\n').find((name) => /^package\/[^/]+\/kit\.json$/.test(name))
  if (!entry) throw new Error(`${path.basename(tarball)} has no kit.json`)
  const target = path.join(kitsDir, kit, 'kit.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, run('tar', ['-xzOf', tarball, entry]))
  return target
}

const opts = options(process.argv.slice(2))
const bundle = opts.out
fs.rmSync(bundle, { recursive: true, force: true })
const dirs = { npm: path.join(bundle, 'npm'), kits: path.join(bundle, 'kits'), bin: path.join(bundle, 'bin', opts.platform) }
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
    platform: opts.platform,
    standard: { commit: gitCommit(opts.standard) },
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
    for (const pin of lockPins(opts.lock, opts.kits)) {
      const { kit } = pin
      const file = await fetchKit(pin, dirs.kits, opts.kitAssets)
      const kitJson = unpackManifest(file, kit, dirs.kits)
      const declared = JSON.parse(fs.readFileSync(kitJson, 'utf8'))
      if (declared.version !== pin.version) throw new Error(`${packageFile(pin)}: its kit.json says ${declared.version}; the lock pins ${pin.version}`)
      const protocol = declared.headless?.protocol ?? null
      manifest.kits.push({
        kit,
        id: declared.id,
        version: pin.version,
        package: pin.editor.package,
        integrity: pin.editor.integrity,
        commit: pin.commit,
        sdkCommit: pin.sdkCommit,
        protocol,
        manifest: path.relative(bundle, kitJson).split(path.sep).join('/'),
        ...entry(bundle, file),
      })
    }
  }

  // What each executable speaks: a kit the Kit Process Protocol, with its package's id and
  // version (seen here, or on its own platform by `kit-handshake.mjs --record` for --bin), the
  // service the Kits Service API to its host and the Kit Process Protocol to the kits.
  const protocol = sdkProtocol()
  const exe = opts.platform.startsWith('win32') ? '.exe' : ''
  const from = (name, variable) => (opts.bin ? path.join(opts.bin, `${name}${exe}`) : process.env[variable])
  const recorded = opts.bin ? readHandshakes(opts.bin) : null
  const executables = [
    { name: sdk.binaries.service.name, from: from(sdk.binaries.service.name, sdk.binaries.service.env), speaks: { service: `kits-service/${sdk.binaries.service.version}`, protocol: `kition-kit/${protocol}` } },
    { name: sdk.binaries.mcp.name, from: from(sdk.binaries.mcp.name, sdk.binaries.mcp.env), speaks: { protocol: `kition-kit/${protocol}` } },
    ...opts.kits.map((kit) => ({ name: `kition-${kit}`, from: from(`kition-${kit}`, `KITION_KIT_${kit.toUpperCase()}_BINARY`), kit })),
  ]
  for (const { name, from: source, speaks, kit } of executables) {
    if (!source || !fs.existsSync(source)) {
      if (opts.bin) throw new Error(`${opts.bin} has no ${name}${exe}`)
      continue
    }
    const target = path.join(dirs.bin, `${name}${exe}`)
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
    let said = speaks
    let kitVersion
    if (kit) {
      const seen = recorded ? recorded[`${name}${exe}`] : { sha256: sha256(target), ...(await handshake(target, protocol)) }
      if (!seen) throw new Error(`${opts.bin}/handshakes.json has no ${name}${exe}`)
      if (seen.sha256 !== sha256(target)) throw new Error(`${name}${exe} is not the file its handshake was recorded for`)
      if (seen.protocolVersion !== protocol) throw new Error(`${name} speaks Kit Process Protocol ${seen.protocolVersion}; this SDK's hosts speak ${protocol}: build it on this kition-sdk`)
      said = { protocol: `kition-kit/${seen.protocolVersion}` }
      const pinned = manifest.kits.find((entry) => entry.kit === kit)
      if (pinned) {
        if (pinned.protocol !== said.protocol) throw new Error(`${name} speaks ${said.protocol}, but its package's kit.json says ${pinned.protocol}`)
        if (seen.kit?.id !== pinned.id || seen.kit?.version !== pinned.version) {
          throw new Error(`${name} answers kit.initialize as ${seen.kit?.id} ${seen.kit?.version}; its package is ${pinned.id} ${pinned.version}`)
        }
      }
      kitVersion = seen.kit.version
    }
    manifest.binaries.push({ name, ...(kit ? { kit, kitVersion } : {}), ...said, ...entry(bundle, target) })
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
    const archive = path.join(path.dirname(bundle), `${path.basename(bundle)}.tar.gz`)
    run('tar', ['-czf', archive, '-C', path.dirname(bundle), path.basename(bundle)])
    fs.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`)
    console.log(`archive: ${archive}`)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
