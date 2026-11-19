#!/usr/bin/env node
// Writes the npm packages that carry `kition`, from executables already built. Nothing here
// builds, publishes or commits: the packages go to a folder under target/.
//
//   node packages/kition/scripts/platform-package.mjs platform --platform <platform>
//        --kition <kition> [--out <folder>]
//
//     writes <out>/<platform>/ (default out: target/kition/npm), the package
//     @kition/cli-<platform>:
//       package.json         os, cpu (and libc) of the platform, so npm installs it only there
//       bin/kition           the Kition command line (kition.exe on Windows)
//       README.md LICENSE
//     It carries no kit: kition installs each kit into the kit store (~/.kition/kits) when it is
//     first needed.
//
//   node packages/kition/scripts/platform-package.mjs link --launcher <kition.tgz> [--out <folder>] [--local]
//
//     makes the packed `@kition/cli` (the launcher) depend on every platform package in <out>, as
//     folders or as the archives `npm pack` makes of them (its optionalDependencies), rewriting
//     the archive in place. Every platform in src/platforms.json must be there, at the launcher's
//     version, so a release never lacks one silently.
//     --local: a rehearsal's launcher, never published: it depends on the archives in <out> by
//     their `file:` paths (the platforms there only), so `npm install -g <kition.tgz>` installs
//     the platform package from them the way it installs it from the registry.
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
const launcher = JSON.parse(fs.readFileSync(path.join(launcherDir, 'package.json'), 'utf8'))

export const packageName = (platform) => `@kition/cli-${platform}`

/**
 * The manifest of the platform package: installed by npm only on its platform (os, cpu, libc), as
 * an optional dependency of the launcher.
 */
export function platformManifest(platform, version) {
  const target = PLATFORMS[platform]
  if (!target) throw new Error(`no platform ${platform}: one of ${Object.keys(PLATFORMS).join(', ')}`)
  return {
    name: packageName(platform),
    version,
    description: `kition, the Kition command line, for ${platform}${target.libc ? ` (${target.libc})` : ''}; it installs kits on first use. Installed by the npm package ${launcher.name}, whose \`kition\` command starts it.`,
    license: launcher.license,
    repository: launcher.repository,
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    files: ['bin'],
    preferUnplugged: true,
  }
}

/** Writes `<out>/<platform>/` and answers its folder. */
export function writePlatformPackage({ platform, kition, out, version = launcher.version }) {
  if (!PLATFORMS[platform]) throw new Error(`no platform ${platform}: one of ${Object.keys(PLATFORMS).join(', ')}`)
  if (!fs.statSync(kition, { throwIfNoEntry: false })?.isFile()) throw new Error(`${kition}: no such file`)
  const exe = PLATFORMS[platform].os === 'win32' ? '.exe' : ''
  const named = path.basename(kition)
  if (named !== `kition${exe}`) throw new Error(`${kition}: give the kition${exe} executable, not ${named}`)
  const dir = path.join(out, platform)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.copyFileSync(kition, path.join(dir, 'bin', `kition${exe}`))
  fs.chmodSync(path.join(dir, 'bin', `kition${exe}`), 0o755)
  const manifest = platformManifest(platform, version)
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `# ${manifest.name}\n\n${manifest.description}\n\nDo not install this package yourself: install or run [\`${launcher.name}\`](https://www.npmjs.com/package/${launcher.name}) (\`npm install -g ${launcher.name}\`, or \`npx -y ${launcher.name} <command>\`), which depends on it on ${platform} and starts its \`bin/kition\`. Kits are downloaded on first use into \`~/.kition/kits\`.\n`,
  )
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'))
  return dir
}

/**
 * The manifest of a platform package in `out`: its folder (`<platform>/`), or the archive `npm pack`
 * made of it (`kition-cli-<platform>-<version>.tgz`). Null when neither is there.
 */
function platformIn(out, platform, version) {
  const file = path.join(out, platform, 'package.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const archive = archiveName(platform, version)
  if (!fs.existsSync(path.join(out, archive))) return null
  // Relative paths only: Git for Windows' GNU tar reads `D:\...` as a remote host.
  return { ...JSON.parse(execFileSync('tar', ['-xzOf', archive, 'package/package.json'], { cwd: out, encoding: 'utf8' })), archive: path.join(out, archive) }
}

/** The file `npm pack` writes for a platform package. */
const archiveName = (platform, version) => `${packageName(platform).replace(/^@/, '').replace('/', '-')}-${version}.tgz`

/**
 * The launcher's optionalDependencies: every platform package in `out` (folders or archives), at
 * `version`. `local`: for a rehearsal, the archives that are in `out`, by their `file:` path, so
 * that npm installs the launcher with its platform package from them as it would from the
 * registry; the platforms missing are left out.
 */
export function optionalDependencies(out, version, { local = false } = {}) {
  const found = {}
  const missing = []
  for (const platform of Object.keys(PLATFORMS)) {
    const manifest = platformIn(out, platform, version)
    if (!manifest || (local && !manifest.archive)) {
      missing.push(platform)
      continue
    }
    if (manifest.version !== version) throw new Error(`${manifest.name} is ${manifest.version}; the launcher is ${version}`)
    found[manifest.name] = local ? `file:${path.resolve(manifest.archive).split(path.sep).join('/')}` : version
  }
  if (local ? !Object.keys(found).length : missing.length) throw new Error(`no platform package ${local ? 'archive ' : ''}for ${missing.join(', ')} in ${out}`)
  return found
}

function link(archive, out, options) {
  // tar runs beside the archive, on relative paths: Git for Windows' GNU tar reads `D:\...` as a
  // remote host.
  const folder = path.dirname(archive)
  const stage = fs.mkdtempSync(path.join(folder, '.kition-link-'))
  const relative = path.relative(folder, stage)
  try {
    execFileSync('tar', ['-xzf', path.basename(archive), '-C', relative], { cwd: folder })
    const file = path.join(stage, 'package', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (manifest.name !== launcher.name) throw new Error(`${archive} is ${manifest.name}, not ${launcher.name}`)
    manifest.optionalDependencies = optionalDependencies(out, manifest.version, options)
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('tar', ['-czf', path.basename(archive), '-C', relative, 'package'], { cwd: folder, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return manifest.optionalDependencies
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

function main(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--local') {
      flags.local = true
      continue
    }
    const name = rest[i].replace(/^--/, '')
    const value = rest[++i]
    if (!rest[i - 1].startsWith('--') || value === undefined) throw new Error(`${rest[i - 1]} needs a value`)
    flags[name] = value
  }
  const out = path.resolve(flags.out ?? path.join(root, 'target/kition/npm'))
  if (command === 'platform') {
    if (!flags.platform || !flags.kition) throw new Error('platform needs --platform and --kition')
    const dir = writePlatformPackage({ platform: flags.platform, kition: path.resolve(flags.kition), out })
    process.stderr.write(`wrote ${dir}\n`)
  } else if (command === 'link') {
    if (!flags.launcher) throw new Error('link needs --launcher')
    const linked = link(path.resolve(flags.launcher), out, { local: flags.local === true })
    process.stderr.write(`${flags.launcher}: optionalDependencies ${Object.entries(linked).map(([name, spec]) => (flags.local ? `${name} (${spec})` : name)).join(', ')}\n`)
  } else {
    throw new Error('usage: platform-package.mjs platform --platform <p> --kition <exe> [--out <dir>] | link --launcher <tgz> [--out <dir>] [--local]')
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
