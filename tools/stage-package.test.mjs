// tools/stage-package.mjs: the copies of the packed packages that release.yml publishes, renamed
// for a rehearsal on another scope and as packed for the real release on @kition.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { integrityOf } from './kit-npm.mjs'
import { CLI_PLATFORMS, checkPlatforms, checkScope, checkTarget, checkVersion, checkVersionSources, inCaretRange, installerProblems, installerScope, installerWithScope, parseTessera, publishOrder, RELEASE_TESSERA_RANGE, releaseManifest, releasePackage, releaseTarget, stageCliManifest, stageManifest, stagePackage, versionSources } from './stage-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tool = path.join(root, 'tools/stage-package.mjs')
const scratch = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const temp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)))
  scratch.push(dir)
  return dir
}

const target = { scope: '@kitionstage', version: '0.5.2-stage.4', tessera: '@kitionstage/tessera@0.1.1-stage.3' }
const packed = () => ({
  name: '@kition/sdk',
  version: '0.5.2',
  description: 'The Kition SDK in one package.',
  type: 'module',
  files: ['dist'],
  // A script that fails: the copy is packed without running it.
  scripts: { build: 'node ../../tools/build-sdk.mjs', prepack: 'exit 1' },
  dependencies: { 'loro-crdt': '1.16.4' },
  peerDependencies: { '@kition/tessera': '^0.1.0', react: '>=19', 'react-dom': '>=19' },
  peerDependenciesMeta: { '@kition/tessera': { optional: true }, react: { optional: true }, 'react-dom': { optional: true } },
  exports: { './embed': { types: './dist/embed.d.ts', import: './dist/embed.js' } },
})

/** A packed package as pnpm pack leaves it: a folder `package/` and its archive. */
function packedPackage() {
  const dir = temp('stage-from-')
  const folder = path.join(dir, 'package')
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(packed(), null, 2)}\n`)
  fs.writeFileSync(path.join(folder, 'README.md'), '# @kition/sdk\n')
  fs.writeFileSync(path.join(folder, 'dist/embed.js'), "export const embed = 1\nimport '@kition/tessera/ui'\n")
  fs.writeFileSync(path.join(folder, 'dist/embed.d.ts'), 'export declare const embed: number\n')
  const archive = path.join(dir, 'sdk.tgz')
  execFileSync('tar', ['-czf', archive, '-C', dir, 'package'])
  return { folder, archive }
}

const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((file) => [file, fs.statSync(path.join(dir, file)).isFile() ? fs.readFileSync(path.join(dir, file), 'utf8') : null]))

describe('stage-package: the rehearsal copy of @kition/sdk', () => {
  it('takes a rehearsal scope, a semantic version npm keeps as written, and <scope>/tessera@<version>', () => {
    expect(checkScope('@kitionstage')).toBe('@kitionstage')
    expect(checkScope('@k1-stage')).toBe('@k1-stage')
    for (const scope of ['kitionstage', '@KitionStage', '@-stage', '@kition/stage', '@', '', undefined]) expect(() => checkScope(scope), String(scope)).toThrow('is not an npm scope')
    expect(() => checkScope('@kition')).toThrow("@kition is the real release's scope")
    expect(checkVersion('0.5.2-stage.4')).toBe('0.5.2-stage.4')
    expect(checkVersion('1.0.0')).toBe('1.0.0')
    for (const version of ['0.5', 'v0.5.2', '0.5.2-', '01.2.3', '0.5.2 ', '', undefined]) expect(() => checkVersion(version), String(version)).toThrow('is not a semantic version')
    expect(() => checkVersion('0.5.2+sha.1')).toThrow('build metadata')
    expect(parseTessera('@kitionstage/tessera@0.1.1-stage.3')).toEqual({ scope: '@kitionstage', name: '@kitionstage/tessera', version: '0.1.1-stage.3' })
    expect(parseTessera('@kition/tessera@0.1.1')).toEqual({ scope: '@kition', name: '@kition/tessera', version: '0.1.1' })
    for (const spec of ['@kitionstage/tessera', '@kitionstage/sdk@0.1.1', 'tessera@0.1.1', 'npm:@kitionstage/tessera@0.1.1', '@kitionstage/tessera@^0.1.1', '@kitionstage/tessera@latest']) expect(() => parseTessera(spec), spec).toThrow()
    expect(() => checkTarget({ ...target, scope: '@kition' })).toThrow('real release')
  })

  it('renames the manifest to <scope>/sdk at the version, the peer @kition/tessera kept by name at the exact rehearsal Tessera version, the rest as packed', () => {
    const before = packed()
    const staged = stageManifest(before, target)
    expect(staged).toEqual({ ...packed(), name: '@kitionstage/sdk', version: '0.5.2-stage.4', peerDependencies: { '@kition/tessera': '0.1.1-stage.3', react: '>=19', 'react-dom': '>=19' } })
    expect(Object.keys(staged)).toEqual(Object.keys(before))
    expect(before).toEqual(packed())
    expect(() => stageManifest({ ...packed(), name: '@kition/kit-editor' }, target)).toThrow('not @kition/sdk')
    expect(() => stageManifest({ ...packed(), peerDependencies: { react: '>=19' } }, target)).toThrow('has no peer @kition/tessera')
  })

  it('writes and packs a copy, from the archive or the unpacked folder, without running scripts or touching what it was given', () => {
    const { folder, archive } = packedPackage()
    const folderBefore = snapshot(folder)
    const archiveBefore = fs.readFileSync(archive)
    for (const from of [archive, folder]) {
      const out = path.join(temp('stage-out-'), 'out')
      const result = stagePackage({ from, out, ...target })
      expect(result).toEqual({ tarball: path.join(out, 'kitionstage-sdk-0.5.2-stage.4.tgz'), name: '@kitionstage/sdk', version: '0.5.2-stage.4', integrity: integrityOf(fs.readFileSync(result.tarball)), tessera: '@kitionstage/tessera@0.1.1-stage.3' })
      const files = execFileSync('tar', ['-tzf', result.tarball], { encoding: 'utf8' }).trim().split('\n').sort()
      expect(files).toEqual(['package/README.md', 'package/dist/embed.d.ts', 'package/dist/embed.js', 'package/package.json'])
      const manifest = JSON.parse(execFileSync('tar', ['-xOzf', result.tarball, 'package/package.json'], { encoding: 'utf8' }))
      expect(manifest).toEqual(stageManifest(packed(), target))
      expect(execFileSync('tar', ['-xOzf', result.tarball, 'package/dist/embed.js'], { encoding: 'utf8' })).toBe(fs.readFileSync(path.join(folder, 'dist/embed.js'), 'utf8'))
    }
    expect(snapshot(folder)).toEqual(folderBefore)
    expect(fs.readFileSync(archive).equals(archiveBefore)).toBe(true)
  })

  it('refuses an output folder in this checkout or not empty, a bad target, and a source folder with node_modules', () => {
    const { folder, archive } = packedPackage()
    expect(() => stagePackage({ from: archive, out: path.join(root, 'target/stage'), ...target })).toThrow('is in this checkout')
    expect(() => stagePackage({ from: archive, out: path.dirname(root), ...target })).toThrow('is in this checkout')
    const full = temp('stage-full-')
    fs.writeFileSync(path.join(full, 'x'), '')
    expect(() => stagePackage({ from: archive, out: full, ...target })).toThrow('is not empty')
    expect(() => stagePackage({ from: archive, out: path.join(temp('stage-out-'), 'o'), ...target, scope: '@kition' })).toThrow('real release')
    expect(() => stagePackage({ from: archive, out: path.join(temp('stage-out-'), 'o'), ...target, version: 'next' })).toThrow('not a semantic version')
    fs.mkdirSync(path.join(folder, 'node_modules'))
    expect(() => stagePackage({ from: folder, out: path.join(temp('stage-out-'), 'o'), ...target })).toThrow('has node_modules')
    expect(fs.existsSync(path.join(root, 'target/stage'))).toBe(false)
  })

  it('as a command: --check names the rehearsal and refuses @kition; a run prints the archive as JSON', () => {
    const args = ['--scope', target.scope, '--version', target.version, '--tessera', target.tessera]
    const checked = spawnSync(process.execPath, [tool, '--check', ...args], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
    expect(checked.stdout.trim()).toBe('@kitionstage/sdk@0.5.2-stage.4 with @kition/tessera at @kitionstage/tessera@0.1.1-stage.3')
    const refused = spawnSync(process.execPath, [tool, '--check', '--scope', '@kition', '--version', target.version, '--tessera', target.tessera], { encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("stage-package: @kition is the real release's scope")
    expect(spawnSync(process.execPath, [tool, '--check', '--scope', target.scope, '--version', target.version], { encoding: 'utf8' }).stderr).toContain('needs --tessera')
    const { archive } = packedPackage()
    const out = path.join(temp('stage-out-'), 'out')
    const ran = spawnSync(process.execPath, [tool, '--from', archive, '--out', out, ...args], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    expect(JSON.parse(ran.stdout)).toMatchObject({ name: '@kitionstage/sdk', version: '0.5.2-stage.4', tarball: path.join(out, 'kitionstage-sdk-0.5.2-stage.4.tgz') })
  })
})

describe('stage-package: the rehearsal copy of the command line', () => {
  const cli = { scope: '@kitionstage', version: '0.5.2-stage.1', platforms: 'darwin-arm64' }
  const launcher = () => ({ name: '@kition/cli', version: '0.5.2', type: 'module', bin: { kition: './dist/cli.js' }, files: ['dist'], scripts: { prepack: 'exit 1' } })
  const platform = (name = 'darwin-arm64') => ({ name: `@kition/cli-${name}`, version: '0.5.2', description: 'kition for it. Installed by the npm package @kition/cli, whose `kition` command starts it.', os: ['darwin'], cpu: ['arm64'], files: ['bin'] })
  const archiveOf = (manifest, files) => {
    const dir = temp('stage-cli-from-')
    fs.mkdirSync(path.join(dir, 'package'))
    fs.writeFileSync(path.join(dir, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'package', file)), { recursive: true })
      fs.writeFileSync(path.join(dir, 'package', file), text, { mode: 0o755 })
    }
    const archive = path.join(dir, 'packed.tgz')
    execFileSync('tar', ['-czf', archive, '-C', dir, 'package'])
    return archive
  }

  it('takes known platforms, each once', () => {
    expect(checkPlatforms('darwin-arm64')).toEqual(['darwin-arm64'])
    expect(checkPlatforms(' darwin-arm64, linux-x64 ')).toEqual(['darwin-arm64', 'linux-x64'])
    expect(CLI_PLATFORMS).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
    expect(() => checkPlatforms('')).toThrow('name at least one platform')
    expect(() => checkPlatforms('darwin-arm64,sunos-x64')).toThrow('no platform sunos-x64')
    expect(() => checkPlatforms('linux-x64,linux-x64')).toThrow('named twice')
  })

  it('renames the launcher to <scope>/cli, depending on exactly the platforms built at the stage scope and version', () => {
    const staged = stageCliManifest(launcher(), { ...cli, platforms: 'darwin-arm64,linux-x64' })
    expect(staged).toEqual({ ...launcher(), name: '@kitionstage/cli', version: '0.5.2-stage.1', optionalDependencies: { '@kitionstage/cli-darwin-arm64': '0.5.2-stage.1', '@kitionstage/cli-linux-x64': '0.5.2-stage.1' } })
    // One the real release linked (every platform at @kition) is replaced, never merged.
    const linked = { ...launcher(), optionalDependencies: { '@kition/cli-darwin-arm64': '0.5.2', '@kition/cli-win32-x64': '0.5.2' } }
    expect(stageCliManifest(linked, cli).optionalDependencies).toEqual({ '@kitionstage/cli-darwin-arm64': '0.5.2-stage.1' })
    expect(() => stageCliManifest(launcher(), { ...cli, platforms: '' })).toThrow('name at least one platform')
    expect(() => stageCliManifest(launcher(), { ...cli, scope: '@kition' })).toThrow('real release')
    expect(() => stageCliManifest(launcher(), { ...cli, version: '0.5.2+x' })).toThrow('build metadata')
  })

  it('renames a platform package to <scope>/cli-<platform>, its description naming the staged launcher', () => {
    const staged = stageCliManifest(platform(), cli)
    expect(staged).toEqual({ ...platform(), name: '@kitionstage/cli-darwin-arm64', version: '0.5.2-stage.1', description: 'kition for it. Installed by the npm package @kitionstage/cli, whose `kition` command starts it.' })
    expect(Object.keys(staged)).toEqual(Object.keys(platform()))
    expect(() => stageCliManifest(platform('linux-x64'), cli)).toThrow('is not one of the platforms darwin-arm64')
    expect(() => stageCliManifest({ ...platform(), name: '@kition/cli-sunos-x64' }, cli)).toThrow('not @kition/cli or @kition/cli-<platform>')
    expect(() => stageCliManifest({ ...platform(), name: '@kition/dsh-kits' }, cli)).toThrow('not @kition/cli or')
  })

  it('packs both copies with their files, the executable kept executable, and prints them as a command', () => {
    const fromPlatform = archiveOf(platform(), { 'bin/kition': '#!/bin/sh\necho kition\n', 'README.md': '# x\n' })
    const out = path.join(temp('stage-cli-out-'), 'out')
    const args = ['--scope', cli.scope, '--version', cli.version, '--platforms', cli.platforms]
    const ran = spawnSync(process.execPath, [tool, '--from', fromPlatform, '--out', out, ...args], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    const result = JSON.parse(ran.stdout)
    expect(result).toEqual({ tarball: path.join(out, 'kitionstage-cli-darwin-arm64-0.5.2-stage.1.tgz'), name: '@kitionstage/cli-darwin-arm64', version: '0.5.2-stage.1', integrity: integrityOf(fs.readFileSync(result.tarball)) })
    expect(execFileSync('tar', ['-tvzf', result.tarball], { encoding: 'utf8' })).toMatch(/^-rwx.*package\/bin\/kition$/m)
    const fromLauncher = archiveOf(launcher(), { 'dist/cli.js': '#!/usr/bin/env node\n' })
    const launched = stagePackage({ from: fromLauncher, out: path.join(temp('stage-cli-out-'), 'out'), ...cli })
    expect(JSON.parse(execFileSync('tar', ['-xOzf', launched.tarball, 'package/package.json'], { encoding: 'utf8' })).optionalDependencies).toEqual({ '@kitionstage/cli-darwin-arm64': '0.5.2-stage.1' })
    const checked = spawnSync(process.execPath, [tool, '--check', ...args], { encoding: 'utf8' })
    expect(checked.stdout.trim()).toBe('@kitionstage/cli@0.5.2-stage.1 with @kitionstage/cli-darwin-arm64')
    const refused = spawnSync(process.execPath, [tool, '--check', '--scope', '@kition', '--version', cli.version, '--platforms', cli.platforms], { encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("@kition is the real release's scope")
  })
})

describe('stage-package: the release target, one path for a rehearsal and the real release', () => {
  const agreeing = (version) => [{ file: 'sdk.json', version }, { file: 'crates/kition-cli/Cargo.toml', version }, { file: 'packages/kition/package.json', version }, { file: 'packages/sdk/package.json', version }]
  const stage = { scope: '@kitionstage', version: '', platforms: '', tessera: '@kitionstage/tessera@0.1.1-stage.2', runNumber: 9, sources: agreeing('0.1.0') }
  const real = { scope: '@kition', version: '', platforms: '', tessera: '@kition/tessera@0.1.3', runNumber: 9, sources: agreeing('0.1.0') }

  it("reads this checkout's version sources, which agree, and names each one when they do not", () => {
    const sources = versionSources()
    expect(sources.map(({ file }) => file)).toEqual(['sdk.json', 'crates/kition-cli/Cargo.toml', 'packages/kition/package.json', 'packages/sdk/package.json'])
    const sdk = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8')).version
    expect(checkVersionSources(sources)).toBe(sdk)
    const disagreeing = agreeing('0.1.0').map((source) => (source.file === 'packages/sdk/package.json' ? { ...source, version: '0.5.2' } : source))
    expect(() => checkVersionSources(disagreeing)).toThrow('the version sources disagree (sdk.json 0.1.0, crates/kition-cli/Cargo.toml 0.1.0, packages/kition/package.json 0.1.0, packages/sdk/package.json 0.5.2)')
    expect(() => releaseTarget({ ...stage, sources: disagreeing })).toThrow('the version sources disagree')
    expect(() => releaseTarget({ ...real, sources: disagreeing })).toThrow('the version sources disagree')
    expect(() => checkVersionSources([{ file: 'sdk.json', version: null }])).toThrow('sdk.json names none')
  })

  it('reads caret ranges as npm does', () => {
    expect(RELEASE_TESSERA_RANGE).toBe('^0.1.0')
    for (const version of ['0.1.0', '0.1.1', '0.1.42']) expect(inCaretRange(version, '^0.1.0'), version).toBe(true)
    for (const version of ['0.0.9', '0.2.0', '1.0.0', '0.1.1-stage.2', '0.1']) expect(inCaretRange(version, '^0.1.0'), version).toBe(false)
    expect(inCaretRange('1.4.0', '^1.2.0')).toBe(true)
    expect(inCaretRange('2.0.0', '^1.2.0')).toBe(false)
    expect(inCaretRange('0.0.3', '^0.0.3')).toBe(true)
    expect(inCaretRange('0.0.4', '^0.0.3')).toBe(false)
    expect(() => inCaretRange('0.1.0', '0.1.0')).toThrow('not a caret range')
  })

  it('a rehearsal: <version>-stage.<run number>, darwin-arm64, the peer at the rehearsal Tessera, by default', () => {
    expect(releaseTarget(stage)).toEqual({
      scope: '@kitionstage',
      real: false,
      version: '0.1.0-stage.9',
      platforms: ['darwin-arm64'],
      tessera: '@kitionstage/tessera@0.1.1-stage.2',
      peer: '0.1.1-stage.2',
      names: { platforms: { 'darwin-arm64': '@kitionstage/cli-darwin-arm64' }, cli: '@kitionstage/cli', sdk: '@kitionstage/sdk' },
    })
    expect(releaseTarget({ ...stage, version: '0.1.0-stage.20', platforms: 'linux-x64,darwin-arm64' })).toMatchObject({ version: '0.1.0-stage.20', platforms: ['linux-x64', 'darwin-arm64'] })
    expect(() => releaseTarget({ ...stage, runNumber: '' })).toThrow('needs the run number')
    expect(() => releaseTarget({ ...stage, version: '0.1+x' })).toThrow('not a semantic version')
    expect(() => releaseTarget({ ...stage, platforms: 'sunos-x64' })).toThrow('no platform sunos-x64')
    expect(() => releaseTarget({ ...stage, tessera: '@kitionstage/tessera' })).toThrow('is not <scope>/tessera@<version>')
    for (const scope of ['kitionstage', '@KITION', '', undefined]) expect(() => releaseTarget({ ...stage, scope }), String(scope)).toThrow('is not an npm scope')
  })

  it("the real release: every source's version, every platform, @kition/tessera in ^0.1.0 and the peer at that range; nothing else", () => {
    const target = releaseTarget(real)
    expect(target).toEqual({
      scope: '@kition',
      real: true,
      version: '0.1.0',
      platforms: CLI_PLATFORMS,
      tessera: '@kition/tessera@0.1.3',
      peer: '^0.1.0',
      names: { platforms: Object.fromEntries(CLI_PLATFORMS.map((platform) => [platform, `@kition/cli-${platform}`])), cli: '@kition/cli', sdk: '@kition/sdk' },
    })
    expect(releaseTarget({ ...real, version: '0.1.0', platforms: [...CLI_PLATFORMS].reverse().join(',') })).toEqual(target)
    expect(() => releaseTarget({ ...real, version: '0.1.1' })).toThrow('the real release publishes 0.1.0, the version every source names, not 0.1.1')
    expect(() => releaseTarget({ ...real, version: '0.1.0-stage.9' })).toThrow('not 0.1.0-stage.9')
    expect(() => releaseTarget({ ...real, sources: agreeing('0.1.0-rc.1') })).toThrow('does not publish a prerelease')
    expect(() => releaseTarget({ ...real, platforms: 'darwin-arm64' })).toThrow('the real release publishes kition for every platform')
    expect(() => releaseTarget({ ...real, tessera: '@kitionstage/tessera@0.1.1-stage.2' })).toThrow('checked with @kition/tessera at a published version in ^0.1.0')
    expect(() => releaseTarget({ ...real, tessera: '@kition/tessera@0.2.0' })).toThrow('in ^0.1.0')
    const command = spawnSync(process.execPath, [tool, 'target', '--scope', '@kition', '--version', '', '--platforms', '', '--tessera', '@kition/tessera@0.1.0', '--run-number', '3'], { encoding: 'utf8' })
    expect(command.status, command.stderr).toBe(0)
    expect(JSON.parse(command.stdout)).toMatchObject({ scope: '@kition', real: true, version: checkVersionSources(versionSources()), peer: '^0.1.0' })
  })

  it('makes the real copies without renaming: the SDK peer at the range, the launcher on every platform, the platform package as packed', () => {
    const target = releaseTarget(real)
    const sdk = { name: '@kition/sdk', version: '0.1.0', peerDependencies: { '@kition/tessera': '0.1.1-stage.2', react: '>=19' } }
    expect(releaseManifest(sdk, target)).toEqual({ ...sdk, peerDependencies: { '@kition/tessera': '^0.1.0', react: '>=19' } })
    expect(() => releaseManifest({ ...sdk, version: '0.5.2' }, target)).toThrow('the package is @kition/sdk@0.5.2; the release publishes 0.1.0')
    expect(() => releaseManifest({ ...sdk, peerDependencies: {} }, target)).toThrow('has no peer @kition/tessera')
    const cli = { name: '@kition/cli', version: '0.1.0', bin: { kition: './dist/cli.js' } }
    expect(releaseManifest(cli, target)).toEqual({ ...cli, optionalDependencies: Object.fromEntries(CLI_PLATFORMS.map((platform) => [`@kition/cli-${platform}`, '0.1.0'])) })
    const platform = { name: '@kition/cli-linux-x64', version: '0.1.0', os: ['linux'] }
    expect(releaseManifest(platform, target)).toEqual(platform)
    expect(() => releaseManifest({ ...platform, name: '@kition/dsh-kits' }, target)).toThrow('not @kition/sdk, @kition/cli or @kition/cli-<platform>')
    // A rehearsal's target renames, as the rehearsal copies do.
    const staged = releaseTarget(stage)
    expect(releaseManifest(sdk, staged)).toEqual(stageManifest(sdk, { scope: '@kitionstage', version: '0.1.0-stage.9', tessera: staged.tessera }))
    expect(releaseManifest(cli, staged)).toEqual(stageCliManifest(cli, { scope: '@kitionstage', version: '0.1.0-stage.9', platforms: 'darwin-arm64' }))
    // A target edited by hand is refused.
    expect(() => releaseManifest(sdk, { ...target, peer: '0.1.0' })).toThrow('not one releaseTarget gives')
    expect(() => releaseManifest(sdk, { ...staged, scope: '@kition' })).toThrow()
  })

  it("names the installers' scope on one line each: install/ installs @kition's packages, nothing else names @kition in code", () => {
    for (const file of ['install.sh', 'install.ps1']) {
      const text = fs.readFileSync(path.join(root, 'install', file), 'utf8')
      expect(installerScope(file, text), file).toBe('@kition')
      expect(installerProblems(file, text, '@kition'), file).toEqual([])
      const staged = installerWithScope(file, text, '@kitionstage')
      expect(installerScope(file, staged)).toBe('@kitionstage')
      expect(installerProblems(file, staged, '@kitionstage'), file).toEqual([])
      const changed = staged.split('\n').map((line, at) => [line, text.split('\n')[at]]).filter(([a, b]) => a !== b)
      expect(changed.length, file).toBe(1)
      expect(installerProblems(file, text, '@kitionstage'), file).toEqual([`${file} installs @kition's packages, not @kitionstage's`])
    }
    expect(installerProblems('install.sh', "scope='@kition'\npackage=\"@kition/cli-$target\"\n", '@kition')).toEqual(['install.sh:2 names @kition itself: package="@kition/cli-$target"'])
    expect(installerProblems('install.sh', "# @kition/cli in a comment\nscope='@kition'\n", '@kition')).toEqual([])
    expect(() => installerScope('install.sh', "scope='@kition'\nscope='@kition'\n")).toThrow('on 2 lines, not one')
    expect(() => installerScope('install.ps1', 'no scope\n')).toThrow('on 0 lines, not one')
  })

  /** A packed launcher with the repository's installers, a platform package and @kition/sdk, as the jobs pack them. */
  function packedRelease(version) {
    const dir = temp('release-from-')
    const write = (name, manifest, files) => {
      const folder = path.join(dir, name, 'package')
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
        fs.writeFileSync(path.join(folder, file), text, { mode: 0o755 })
      }
      const archive = path.join(dir, `${name}.tgz`)
      execFileSync('tar', ['-czf', archive, '-C', path.join(dir, name), 'package'])
      return archive
    }
    const installers = Object.fromEntries(['install.sh', 'install.ps1'].map((file) => [`dist/${file}`, fs.readFileSync(path.join(root, 'install', file), 'utf8')]))
    return {
      cli: write('cli', { name: '@kition/cli', version, bin: { kition: './dist/cli.js' }, files: ['dist'] }, { 'dist/cli.js': '#!/usr/bin/env node\n', ...installers }),
      platform: (key) => write(`cli-${key}`, { name: `@kition/cli-${key}`, version, description: 'Installed by the npm package @kition/cli.', files: ['bin'] }, { 'bin/kition': '#!/bin/sh\necho kition\n' }),
      sdk: write('sdk', { ...packed(), version }, { 'dist/embed.js': 'export const embed = 1\n' }),
    }
  }

  /** The release's copies of `from` for `target` in a folder of their own, named as the jobs name them. */
  function releaseCopies(from, target) {
    const dir = temp('release-copies-')
    const copy = (archive, file) => fs.copyFileSync(releasePackage({ from: archive, out: path.join(temp('release-out-'), 'o'), target }).tarball, path.join(dir, file))
    for (const key of target.platforms) copy(from.platform(key), `cli-${key}.tgz`)
    copy(from.cli, 'cli.tgz')
    copy(from.sdk, 'sdk.tgz')
    return dir
  }

  it('a rehearsal: the copies in publishing order, the launcher installing the scope from its installers', () => {
    const target = releaseTarget(stage)
    const dir = releaseCopies(packedRelease('0.1.0'), target)
    const order = publishOrder({ dir, target })
    expect(order.map(({ name, version }) => `${name}@${version}`)).toEqual(['@kitionstage/cli-darwin-arm64@0.1.0-stage.9', '@kitionstage/cli@0.1.0-stage.9', '@kitionstage/sdk@0.1.0-stage.9'])
    for (const { archive, integrity } of order) expect(integrityOf(fs.readFileSync(archive))).toBe(integrity)
    const read = (file, inner) => execFileSync('tar', ['-xzOf', file, `package/${inner}`], { cwd: dir, encoding: 'utf8' })
    expect(installerScope('install.sh', read('cli.tgz', 'dist/install.sh'))).toBe('@kitionstage')
    expect(installerScope('install.ps1', read('cli.tgz', 'dist/install.ps1'))).toBe('@kitionstage')
    expect(JSON.parse(read('sdk.tgz', 'package.json')).peerDependencies['@kition/tessera']).toBe('0.1.1-stage.2')
    // As a command, from a target file: one line per package, "<archive> <name> <version> <integrity>".
    const file = path.join(temp('release-target-'), 'target.json')
    fs.writeFileSync(file, JSON.stringify(target))
    const ran = spawnSync(process.execPath, [tool, 'order', '--target', file, '--dir', dir], { encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toBe(order.map(({ archive, name, version, integrity }) => `${archive} ${name} ${version} ${integrity}\n`).join(''))
  })

  it('the real release: the copies as packed, under @kition, in the same order', () => {
    const target = releaseTarget(real)
    const from = packedRelease('0.1.0')
    const dir = releaseCopies(from, target)
    const order = publishOrder({ dir, target })
    expect(order.map(({ name }) => name)).toEqual([...CLI_PLATFORMS.map((platform) => `@kition/cli-${platform}`), '@kition/cli', '@kition/sdk'])
    const read = (file, inner) => execFileSync('tar', ['-xzOf', file, `package/${inner}`], { cwd: dir, encoding: 'utf8' })
    expect(read('cli.tgz', 'dist/install.sh')).toBe(fs.readFileSync(path.join(root, 'install/install.sh'), 'utf8'))
    expect(read('cli.tgz', 'dist/install.ps1')).toBe(fs.readFileSync(path.join(root, 'install/install.ps1'), 'utf8'))
    expect(JSON.parse(read('sdk.tgz', 'package.json')).peerDependencies['@kition/tessera']).toBe('^0.1.0')
    expect(JSON.parse(read('cli-linux-x64.tgz', 'package.json'))).toEqual(JSON.parse(execFileSync('tar', ['-xzOf', from.platform('linux-x64'), 'package/package.json'], { encoding: 'utf8' })))
    // Packed at another version than the target's: refused before any copy.
    expect(() => releasePackage({ from: packedRelease('0.5.2').sdk, out: path.join(temp('release-out-'), 'o'), target })).toThrow('the release publishes 0.1.0')
  })

  it('refuses a folder that is not exactly the copies: a missing or stray archive, a launcher installing another scope, a peer at another range', () => {
    const target = releaseTarget(stage)
    const from = packedRelease('0.1.0')
    const dir = releaseCopies(from, target)
    fs.writeFileSync(path.join(dir, 'kdm.tgz'), '')
    expect(() => publishOrder({ dir, target })).toThrow('the release publishes exactly cli-darwin-arm64.tgz, cli.tgz, sdk.tgz')
    fs.rmSync(path.join(dir, 'kdm.tgz'))
    fs.rmSync(path.join(dir, 'sdk.tgz'))
    expect(() => publishOrder({ dir, target })).toThrow('holds cli-darwin-arm64.tgz, cli.tgz;')
    // The rehearsal copy of the SDK made for another Tessera, and a launcher whose installers still install @kition.
    const other = releaseTarget({ ...stage, tessera: '@kitionstage/tessera@0.1.1-stage.3' })
    fs.copyFileSync(releasePackage({ from: from.sdk, out: path.join(temp('release-out-'), 'o'), target: other }).tarball, path.join(dir, 'sdk.tgz'))
    expect(() => publishOrder({ dir, target })).toThrow('@kitionstage/sdk names its peer @kition/tessera at 0.1.1-stage.3, not 0.1.1-stage.2')
    fs.copyFileSync(releasePackage({ from: from.sdk, out: path.join(temp('release-out-'), 'o'), target }).tarball, path.join(dir, 'sdk.tgz'))
    const unscoped = temp('release-unscoped-')
    fs.mkdirSync(path.join(unscoped, 'package'))
    execFileSync('tar', ['-xzf', path.join(dir, 'cli.tgz'), '-C', unscoped])
    fs.copyFileSync(path.join(root, 'install/install.sh'), path.join(unscoped, 'package/dist/install.sh'))
    execFileSync('tar', ['-czf', path.join(dir, 'cli.tgz'), '-C', unscoped, 'package'])
    expect(() => publishOrder({ dir, target })).toThrow("@kitionstage/cli's dist/install.sh: install.sh installs @kition's packages, not @kitionstage's")
  })
})

describe('release.yml: the one path of a rehearsal and of the real release', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'))
  const text = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const runs = (job) => job.steps.map((step) => step.run ?? '').join('\n')
  const ordered = (where, list) => {
    const at = list.map((part) => [part, where.indexOf(part)])
    for (const [part, index] of at) expect(index, part).toBeGreaterThanOrEqual(0)
    expect(at.map(([, index]) => index)).toEqual(at.map(([, index]) => index).sort((a, b) => a - b))
  }

  it('is started by hand, rehearses by default, and only `scope=@kition` reaches the real packages and their token', () => {
    expect(workflow.name).toBe('release')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const { inputs } = workflow.on.workflow_dispatch
    expect(inputs.scope.default).toBe('@kitionstage')
    expect(inputs.version.default).toBe('')
    expect(inputs.platforms.default).toBe('')
    expect(inputs.tessera.required).toBe(true)
    expect(inputs.kition_commit.default).toBe('')
    expect(inputs.kit.default).toBe('note')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env).toMatchObject({ SCOPE: '${{ inputs.scope }}' })
    // Every input is checked by tools/stage-package.mjs target before anything is built.
    const target = workflow.jobs.target.steps.find((step) => step.id === 'target')
    expect(target.env).toEqual({ VERSION_INPUT: '${{ inputs.version }}', PLATFORMS_INPUT: '${{ inputs.platforms }}', TESSERA: '${{ inputs.tessera }}', KITION_COMMIT: '${{ inputs.kition_commit }}' })
    expect(target.run).toContain('node tools/stage-package.mjs target --scope "$SCOPE" --version "$VERSION_INPUT" --platforms "$PLATFORMS_INPUT"')
    expect(target.run).toContain('--tessera "$TESSERA" --run-number "$GITHUB_RUN_NUMBER"')
    for (const [name, job] of Object.entries(workflow.jobs)) if (name !== 'target') expect([job.needs].flat(), name).toContain('target')
    // Only the publishing job can write or mint a provenance token, and only its Publish step has an npm token, chosen by scope.
    for (const name of ['target', 'launcher', 'sdk', 'executables']) expect(workflow.jobs[name].permissions, name).toBeUndefined()
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' })
    const all = Object.values(workflow.jobs).flatMap((job) => job.steps)
    expect(all.filter((step) => JSON.stringify(step).includes('NPM_TOKEN')).map((step) => step.name)).toEqual(['Publish'])
    expect(all.find((step) => step.name === 'Publish').env).toEqual({ NODE_AUTH_TOKEN: "${{ inputs.scope == '@kition' && secrets.NPM_TOKEN || (inputs.scope != '@kition' && secrets.NPM_TOKEN_STAGE || '') }}" })
    // Inputs reach the scripts through the environment, never spliced into a script.
    for (const job of Object.values(workflow.jobs)) expect(runs(job)).not.toContain('${{')
  })

  it('builds and checks @kition/sdk against the Tessera given, kition on each platform, and the copies, as ci.yml sets up Node and pnpm', () => {
    const ci = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')).jobs.check.steps
    const setup = (steps, action) => steps.find((step) => step.uses?.startsWith(action))?.with
    for (const name of ['launcher', 'sdk']) {
      expect(setup(workflow.jobs[name].steps, 'actions/setup-node')['node-version'], name).toBe(setup(ci, 'actions/setup-node')['node-version'])
      expect(setup(workflow.jobs[name].steps, 'pnpm/action-setup'), name).toEqual(setup(ci, 'pnpm/action-setup'))
    }
    ordered(runs(workflow.jobs.sdk), [
      'npm install --ignore-scripts --no-audit --no-fund --no-package-lock "@kition/tessera@npm:$TESSERA"',
      'node tools/build-sdk.mjs',
      'node tools/pack-public-packages.mjs sdk',
      'node tools/smoke-sdk-package.mjs --tessera "$TESSERA_DIR"',
      'node tools/smoke-sdk-worker.mjs --tessera "$TESSERA_DIR"',
      'node tools/stage-package.mjs release --target ../release-work/target.json --from target/npm-pack/sdk.tgz',
    ])
    ordered(runs(workflow.jobs.launcher), ['node tools/pack-public-packages.mjs kition', 'node tools/stage-package.mjs release --target ../release-work/target.json --from target/npm-pack/kition.tgz'])
    const executables = workflow.jobs.executables
    expect(executables.strategy.matrix).toBe('${{ fromJSON(needs.target.outputs.matrix) }}')
    ordered(runs(executables), [
      'cargo "$CARGO_BUILD" --locked --profile dist -p kition-kits --bins -p kition-cli --target "$BUILD_TARGET"',
      'node packages/kition/scripts/platform-package.mjs platform',
      'kition kit add "$smoke/kits/$kit"',
      'node tools/stage-package.mjs release --target ../release-work/target.json --from "$(ls target/kition/packed/kition-cli-',
      'unset KITION_NPM_SCOPE KITION_BINARY KITION_INDEX',
      'node "$cli" kit install "$KIT"',
    ])
  })

  it('asks npm about every copy before publishing any, publishes platform packages, launcher, SDK in that order, and waits until npm serves them', () => {
    const publish = workflow.jobs.publish
    expect(publish.needs).toEqual(['target', 'launcher', 'sdk', 'executables'])
    const names = publish.steps.map((step) => step.name ?? step.uses)
    const at = (name) => {
      expect(names, name).toContain(name)
      return names.indexOf(name)
    }
    expect(at('The packages to publish, in order')).toBeLessThan(at('What npm has of them'))
    expect(at('What npm has of them')).toBeLessThan(at('The GitHub Release, as a draft'))
    expect(at('The GitHub Release, as a draft')).toBeLessThan(at('Publish'))
    expect(at('Publish')).toBeLessThan(at('Wait until npm serves them'))
    expect(at('Wait until npm serves them')).toBeLessThan(at('Publish the GitHub Release'))
    ordered(runs(publish), [
      'node tools/stage-package.mjs order --target "$RUNNER_TEMP/target.json" --dir target/release',
      'node tools/kit-npm-package.mjs state --tarball "$archive" --registry "$REGISTRY"',
      'node tools/sdk-release.mjs --notes "target/sdk-release/kition-sdk-$version.json" --scope "$SCOPE"',
      'gh release create "sdk-v$VERSION"',
      'npm publish "$archive" --access public --tag latest --provenance --ignore-scripts',
      'node tools/kit-npm-package.mjs visible --name "$name" --version "$version" --registry "$REGISTRY" --tag latest --minutes "$left"',
      'npm view "$name@$version" dist.integrity --registry "$REGISTRY" --prefer-online',
      'gh release edit "sdk-v$VERSION"',
    ])
    // Never npm view before publishing: npm's CDN would keep that 404 of a new name's metadata.
    const step = (name) => publish.steps.find((each) => each.name === name)
    for (const name of ['What npm has of them', 'Publish']) expect(step(name).run, name).not.toContain('npm view')
    expect(step('Publish').run).toContain('node tools/kit-npm-package.mjs state --tarball "$archive" --registry "$REGISTRY"')
    expect(step('Publish').run).toContain('case "$name" in "$SCOPE"/*)')
    // A rehearsal: no tag, no GitHub Release, no attestation, no npmmirror request; its release files are an artifact.
    for (const name of ['The GitHub Release, as a draft', 'Publish the GitHub Release']) expect(step(name).if, name).toBe("needs.target.outputs.real == 'true' && needs.target.outputs.released != 'true'")
    expect(step('Ask npmmirror to copy the packages').if).toBe("needs.target.outputs.real == 'true'")
    expect(publish.steps.find((each) => each.uses?.startsWith('actions/attest-build-provenance')).if).toBe("needs.target.outputs.real == 'true' && needs.target.outputs.released != 'true'")
    expect(publish.steps.find((each) => each.with?.name === 'sdk-release-files').if).toBe("needs.target.outputs.real != 'true' && needs.target.outputs.bundle == 'true'")
    // The kits and the SDK bundles: always for the real release, for a rehearsal given a kition_commit.
    expect(runs(workflow.jobs.target)).toContain(`if [ "$(node -p 'require(process.argv[1]).real' "$RUNNER_TEMP/target.json")" = true ] || [ -n "$KITION_COMMIT" ]; then echo "bundle=true"; else echo "bundle=false"; fi`)
    for (const name of ['The kit index snapshot', 'The SDK bundle of each platform, and the release files']) expect(step(name).if, name).toBe("needs.target.outputs.bundle == 'true' && needs.target.outputs.released != 'true'")
    expect(runs(publish).match(/gh release (create|edit|delete)/g)).toEqual(['gh release delete', 'gh release create', 'gh release edit'])
    expect(runs(workflow.jobs.target)).toContain('if [ "$REAL" != true ] || ! state=$(gh release view')
  })

  it('publishes neither the twelve library packages nor the frozen DeepSeek Harness plugin', () => {
    for (const name of ['kdm', 'kit-ui-protocol', 'embed', 'kit-engine', 'sync', 'convergence', 'script', 'extensions', 'embed-server', 'kit-host', 'kit-dev-host', 'kit-editor']) {
      expect(text, name).not.toContain(`target/npm-pack/${name}.tgz`)
    }
    expect(text).not.toMatch(/pack-public-packages\.mjs\s*$/m)
    const scripts = Object.values(workflow.jobs).map(runs).join('\n')
    expect(scripts).not.toContain('dsh-kits')
    expect(scripts).not.toContain('deepseek-harness')
    expect(scripts).not.toContain('check-dsh-plugin-package.mjs')
    expect(fs.existsSync(path.join(root, '.github/workflows/stage.yml'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.github/workflows/stage-cli.yml'))).toBe(false)
  })
})
