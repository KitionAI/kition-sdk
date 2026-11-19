#!/usr/bin/env node
// Writes the `kition` archives of one Kition SDK GitHub Release (`sdk-v<version>`, made by
// .github/workflows/release.yml), from the executables each platform built and checked:
//
//   kition-<version>-<platform>.tar.gz   `kition` (`kition.exe` on Windows) and LICENSE, at the
//                                        top: what install.sh and install.ps1 install (the npm
//                                        package @kition/cli-<platform> carries the same kition)
//
//   node tools/release-archives.mjs --bin <folder> --out <folder> [--version <sdk version>]
//
// --bin       a folder of `bin-<platform>/` folders, one per platform, as the release workflow
//             downloads them, each holding `kition`
// --out       where the archives go
// --version   the SDK version the archives are named for (default sdk.json `version`; another
//             one only to rehearse a release locally)
//
// Kit archives and the kit index are not part of an SDK release: each kit repository publishes
// its own archives, and tools/kits-index.mjs gathers the index (docs/sdk/distribution.md). It
// publishes nothing.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLATFORMS = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const exeOf = (platform) => (platform.startsWith('win32') ? '.exe' : '')
export const cliArchive = (version, platform) => `kition-${version}-${platform}.tar.gz`

/**
 * `<archive>` holding `files` (`{ name, from, mode }`) at its top. tar runs in a folder beside the
 * archive and is given relative paths only: Git for Windows' GNU tar reads `D:\...` as a remote host.
 */
function writeArchive(archive, files) {
  const stage = fs.mkdtempSync(path.join(path.dirname(archive), '.stage-'))
  try {
    for (const { name, from, mode } of files) {
      fs.copyFileSync(from, path.join(stage, name))
      fs.chmodSync(path.join(stage, name), mode)
    }
    execFileSync('tar', ['-czf', `../${path.basename(archive)}`, ...files.map(({ name }) => name)], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return { size: fs.statSync(archive).size, sha256: sha256(archive) }
}

/** The `bin-<platform>/` folders of `binDir`, by platform. */
export function platformFolders(binDir) {
  const found = fs
    .readdirSync(binDir)
    .filter((name) => name.startsWith('bin-') && fs.statSync(path.join(binDir, name)).isDirectory())
    .map((name) => ({ platform: name.slice(4), dir: path.join(binDir, name) }))
    .sort((a, b) => a.platform.localeCompare(b.platform))
  for (const { platform } of found) if (!PLATFORMS.includes(platform)) throw new Error(`${binDir}/bin-${platform}: no platform ${platform} (${PLATFORMS.join(', ')})`)
  if (!found.length) throw new Error(`${binDir} holds no bin-<platform>/ folder`)
  return found
}

/** Writes the kition archive of each platform in `out`; answers what it wrote. */
export function writeReleaseArchives({ binDir, out, version }) {
  fs.mkdirSync(out, { recursive: true })
  const cli = platformFolders(binDir).map(({ platform, dir }) => {
    const exe = exeOf(platform)
    const executable = path.join(dir, `kition${exe}`)
    if (!fs.existsSync(executable)) throw new Error(`${dir} has no kition${exe}`)
    const file = cliArchive(version, platform)
    const written = writeArchive(path.join(out, file), [
      { name: `kition${exe}`, from: executable, mode: 0o755 },
      { name: 'LICENSE', from: path.join(root, 'LICENSE'), mode: 0o644 },
    ])
    return { platform, file, ...written }
  })
  return { cli }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const binDir = flag('--bin')
  const out = flag('--out')
  if (!binDir || !out) {
    process.stderr.write('usage: release-archives.mjs --bin <folder of bin-<platform>/> --out <folder> [--version <sdk version>]\n')
    process.exit(2)
  }
  try {
    const version = flag('--version') ?? JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8')).version
    const done = writeReleaseArchives({ binDir: path.resolve(binDir), out: path.resolve(out), version })
    process.stdout.write(`kition ${version}: ${done.cli.map((entry) => entry.platform).join(', ')}\n`)
  } catch (error) {
    process.stderr.write(`release-archives: ${error.message}\n`)
    process.exit(1)
  }
}
