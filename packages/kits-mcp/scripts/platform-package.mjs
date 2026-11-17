#!/usr/bin/env node
// Writes the npm packages that carry kition-kits-mcp, from executables already built. Nothing here
// builds, publishes or commits: the packages go to a folder under target/.
//
//   node packages/kits-mcp/scripts/platform-package.mjs platform --platform <platform>
//        --server <kition-kits-mcp> [--kit <kit.json>=<kition-kit>]... [--out <folder>]
//
//     writes <out>/<platform>/ (default out: target/kits-mcp/npm), the package
//     @kition/kits-mcp-<platform>:
//       package.json         os, cpu (and libc) of the platform, so npm installs it only there
//       bin/kition-kits-mcp  the server
//       kits/<kit>/kit.json  each kit's manifest, with its headless executable beside it
//       kits/<kit>/kition-<kit>
//       README.md LICENSE
//     The launcher passes kits/ as the server's --kits-dir. A kit enters only when it is in
//     published-kits.json and its kit.json names the executable given (headless.executable).
//
//   node packages/kits-mcp/scripts/platform-package.mjs link --launcher <kits-mcp.tgz> [--out <folder>]
//
//     makes the packed @kition/kits-mcp depend on every platform package in <out>, as folders or
//     as the archives `npm pack` makes of them (its optionalDependencies), rewriting the archive
//     in place. Every platform in src/platforms.json
//     must be there, at the launcher's version, so a release never lacks one silently.
//
// <platform> is a key of src/platforms.json (`darwin-arm64`, `linux-x64`, ...).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const launcherDir = path.resolve(here, '..')
const PLATFORMS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(launcherDir, 'src/platforms.json'), 'utf8'))).filter(([key]) => !key.startsWith('$')))
const PUBLISHED_KITS = JSON.parse(fs.readFileSync(path.join(root, 'published-kits.json'), 'utf8'))
const launcher = JSON.parse(fs.readFileSync(path.join(launcherDir, 'package.json'), 'utf8'))

export const packageName = (platform) => `${launcher.name}-${platform}`

/**
 * The manifest of the platform package: installed by npm only on its platform (os, cpu, libc), as
 * an optional dependency of the launcher.
 */
export function platformManifest(platform, version, kits) {
  const target = PLATFORMS[platform]
  if (!target) throw new Error(`no platform ${platform}: one of ${Object.keys(PLATFORMS).join(', ')}`)
  return {
    name: packageName(platform),
    version,
    description: `kition-kits-mcp for ${platform}${target.libc ? ` (${target.libc})` : ''}, with the published Kition kits (${kits.map(({ kit, version: v }) => `${kit} ${v}`).join(', ') || 'none'}). Installed by ${launcher.name}; run that.`,
    license: launcher.license,
    repository: launcher.repository,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ['bin', 'kits'],
    preferUnplugged: true,
    kitionKits: Object.fromEntries(kits.map(({ kit, version: v }) => [kit, v])),
  }
}

/** Reads `<kit.json>=<executable>` and checks the pair against the publication allowlist. */
export function kitInput(spec) {
  const at = spec.lastIndexOf('=')
  if (at <= 0) throw new Error(`--kit ${spec}: give <kit.json>=<executable>`)
  const manifestFile = spec.slice(0, at)
  const executable = spec.slice(at + 1)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const kit = typeof manifest.id === 'string' && manifest.id.startsWith('kit.') ? manifest.id.slice(4) : null
  if (!kit || !PUBLISHED_KITS.includes(kit)) throw new Error(`${manifestFile}: ${manifest.id} is not in published-kits.json (${PUBLISHED_KITS.join(', ')})`)
  const named = manifest.headless?.executable
  const given = path.basename(executable).replace(/\.exe$/, '')
  if (named !== given) throw new Error(`${manifestFile}: headless.executable is ${named}, not ${given}`)
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new Error(`${executable}: no such file`)
  return { kit, version: manifest.version, manifestFile, executable, name: named }
}

function copyExecutable(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  fs.chmodSync(to, 0o755)
}

/** Writes `<out>/<platform>/` and answers its folder. */
export function writePlatformPackage({ platform, server, kits, out, version = launcher.version }) {
  if (!PLATFORMS[platform]) throw new Error(`no platform ${platform}: one of ${Object.keys(PLATFORMS).join(', ')}`)
  if (!fs.statSync(server, { throwIfNoEntry: false })?.isFile()) throw new Error(`${server}: no such file`)
  const exe = PLATFORMS[platform].os === 'win32' ? '.exe' : ''
  const dir = path.join(out, platform)
  fs.rmSync(dir, { recursive: true, force: true })
  copyExecutable(server, path.join(dir, 'bin', `kition-kits-mcp${exe}`))
  for (const kit of kits) {
    const kitDir = path.join(dir, 'kits', kit.kit)
    fs.mkdirSync(kitDir, { recursive: true })
    fs.copyFileSync(kit.manifestFile, path.join(kitDir, 'kit.json'))
    copyExecutable(kit.executable, path.join(kitDir, `${kit.name}${exe}`))
  }
  const manifest = platformManifest(platform, version, kits)
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `# ${manifest.name}\n\n${manifest.description}\n\nDo not install this package yourself: install or run [\`${launcher.name}\`](https://www.npmjs.com/package/${launcher.name}), which depends on it on ${platform} and starts \`bin/kition-kits-mcp\` with \`--kits-dir kits\`.\n`,
  )
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'))
  return dir
}

/**
 * The manifest of a platform package in `out`: its folder (`<platform>/`), or the archive `npm pack`
 * made of it (`kition-kits-mcp-<platform>-<version>.tgz`). Null when neither is there.
 */
function platformIn(out, platform, version) {
  const file = path.join(out, platform, 'package.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const archive = path.join(out, `${packageName(platform).replace(/^@/, '').replace('/', '-')}-${version}.tgz`)
  if (!fs.existsSync(archive)) return null
  return JSON.parse(execFileSync('tar', ['-xzOf', archive, 'package/package.json'], { encoding: 'utf8' }))
}

/**
 * The launcher's optionalDependencies: every platform package in `out` (folders or archives), at
 * `version`.
 */
export function optionalDependencies(out, version) {
  const found = {}
  const missing = []
  for (const platform of Object.keys(PLATFORMS)) {
    const manifest = platformIn(out, platform, version)
    if (!manifest) {
      missing.push(platform)
      continue
    }
    if (manifest.version !== version) throw new Error(`${manifest.name} is ${manifest.version}; the launcher is ${version}`)
    found[manifest.name] = version
  }
  if (missing.length) throw new Error(`no platform package for ${missing.join(', ')} in ${out}`)
  return found
}

function link(archive, out) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kits-mcp-link-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', stage])
    const file = path.join(stage, 'package', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (manifest.name !== launcher.name) throw new Error(`${archive} is ${manifest.name}, not ${launcher.name}`)
    manifest.optionalDependencies = optionalDependencies(out, manifest.version)
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('tar', ['-czf', archive, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return manifest.optionalDependencies
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

function main(argv) {
  const [command, ...rest] = argv
  const flags = { kit: [] }
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i].replace(/^--/, '')
    const value = rest[++i]
    if (!rest[i - 1].startsWith('--') || value === undefined) throw new Error(`${rest[i - 1]} needs a value`)
    if (name === 'kit') flags.kit.push(value)
    else flags[name] = value
  }
  const out = path.resolve(flags.out ?? path.join(root, 'target/kits-mcp/npm'))
  if (command === 'platform') {
    if (!flags.platform || !flags.server) throw new Error('platform needs --platform and --server')
    const dir = writePlatformPackage({ platform: flags.platform, server: path.resolve(flags.server), kits: flags.kit.map(kitInput), out })
    process.stderr.write(`wrote ${dir}\n`)
  } else if (command === 'link') {
    if (!flags.launcher) throw new Error('link needs --launcher')
    const linked = link(path.resolve(flags.launcher), out)
    process.stderr.write(`${flags.launcher}: optionalDependencies ${Object.keys(linked).join(', ')}\n`)
  } else {
    throw new Error('usage: platform-package.mjs platform --platform <p> --server <exe> [--kit <kit.json>=<exe>]... [--out <dir>] | link --launcher <tgz> [--out <dir>]')
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`platform-package: ${error.message}\n`)
    process.exit(1)
  }
}
