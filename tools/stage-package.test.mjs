// tools/stage-package.mjs: the rehearsal copy of the packed @kition/sdk the Stage workflow publishes.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { integrityOf } from './kit-npm.mjs'
import { CLI_PLATFORMS, checkPlatforms, checkScope, checkTarget, checkVersion, parseTessera, stageCliManifest, stageManifest, stagePackage } from './stage-package.mjs'

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

  it('is what the Stage workflow publishes: by hand only, never @kition, checked against the rehearsal Tessera, with the stage token, waited for, and the lines a kit uses', () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/stage.yml'), 'utf8'))
    expect(workflow.name).toBe('Stage')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const { inputs } = workflow.on.workflow_dispatch
    expect(inputs.scope.default).toBe('@kitionstage')
    expect(inputs.version.default).toBe('')
    expect(inputs.tessera.required).toBe(true)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const job = workflow.jobs.stage
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    // Node and pnpm as ci.yml sets them up.
    const ci = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')).jobs.check.steps
    const setup = (steps, action) => steps.find((step) => step.uses?.startsWith(action))?.with
    expect(setup(job.steps, 'actions/setup-node')['node-version']).toBe(setup(ci, 'actions/setup-node')['node-version'])
    expect(setup(job.steps, 'pnpm/action-setup')).toEqual(setup(ci, 'pnpm/action-setup'))
    const runs = job.steps.map((step) => step.run ?? '').join('\n')
    const order = [
      'if [ "$SCOPE" = "@kition" ]',
      'node tools/stage-package.mjs --check --scope "$SCOPE" --version "$version" --tessera "$TESSERA"',
      'npm install --ignore-scripts --no-audit --no-fund --no-package-lock "@kition/tessera@npm:$TESSERA"',
      'node tools/build-sdk.mjs',
      'node tools/pack-public-packages.mjs sdk',
      'node tools/smoke-sdk-package.mjs --tessera "$TESSERA_DIR"',
      'node tools/stage-package.mjs --from target/npm-pack/sdk.tgz',
      'npm publish "$TARBALL" --access public --tag latest --provenance --ignore-scripts',
      'node tools/kit-npm-package.mjs visible --name "$NAME" --version "$VERSION" --registry "$REGISTRY" --tag latest --minutes 40',
      'sdk_line="\\"@kition/sdk\\": \\"npm:$NAME@$VERSION\\","',
      'tessera_line="\\"@kition/tessera\\": \\"npm:$TESSERA\\""',
    ].map((text) => [text, runs.indexOf(text)])
    for (const [text, at] of order) expect(at, text).toBeGreaterThanOrEqual(0)
    expect(order.map(([, at]) => at)).toEqual(order.map(([, at]) => at).sort((a, b) => a - b))
    expect(runs).toContain('-stage.$GITHUB_RUN_NUMBER')
    expect(runs).toContain('$GITHUB_STEP_SUMMARY')
    const publish = job.steps.find((step) => step.name === 'Publish')
    expect(publish.env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN_STAGE }}' })
    // Inputs reach the scripts through the environment, never spliced into a script.
    expect(job.env).toMatchObject({ SCOPE: '${{ inputs.scope }}', VERSION_INPUT: '${{ inputs.version }}', TESSERA: '${{ inputs.tessera }}' })
    expect(runs).not.toContain('${{')
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

  it('is what the Stage CLI workflow publishes: by hand only, never @kition, platform packages before the launcher, with the stage token, waited for', () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/stage-cli.yml'), 'utf8'))
    expect(workflow.name).toBe('Stage CLI')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    const { inputs } = workflow.on.workflow_dispatch
    expect(inputs.scope.default).toBe('@kitionstage')
    expect(inputs.version.default).toBe('')
    expect(inputs.platforms.default).toBe('darwin-arm64')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env).toMatchObject({ SCOPE: '${{ inputs.scope }}', VERSION_INPUT: '${{ inputs.version }}', PLATFORMS_INPUT: '${{ inputs.platforms }}' })
    const { launcher: first, executables, publish } = workflow.jobs
    expect(executables.needs).toBe('launcher')
    expect(publish.needs).toEqual(['launcher', 'executables'])
    // Only the publishing job can mint a provenance token, and only it has the npm token.
    expect(first.permissions).toBeUndefined()
    expect(executables.permissions).toBeUndefined()
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const all = Object.values(workflow.jobs).flatMap((job) => job.steps)
    expect(all.filter((step) => JSON.stringify(step).includes('NPM_TOKEN')).map((step) => step.name)).toEqual(['Publish'])
    // Node as ci.yml and release.yml set it up; the build as release.yml's.
    const release = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')).jobs.executables
    const setup = (steps, action) => steps.find((step) => step.uses?.startsWith(action))?.with
    expect(setup(executables.steps, 'actions/setup-node')).toEqual(setup(release.steps, 'actions/setup-node'))
    expect(setup(executables.steps, 'mlugg/setup-zig')).toEqual(setup(release.steps, 'mlugg/setup-zig'))
    expect(executables.env.BUILD_TARGET).toBe(release.env.BUILD_TARGET)
    const runs = (job) => job.steps.map((step) => step.run ?? '').join('\n')
    const ordered = (text, list) => {
      const at = list.map((part) => [part, text.indexOf(part)])
      for (const [part, index] of at) expect(index, part).toBeGreaterThanOrEqual(0)
      expect(at.map(([, index]) => index)).toEqual(at.map(([, index]) => index).sort((a, b) => a - b))
    }
    ordered(runs(first), [
      'if [ "$SCOPE" = "@kition" ]',
      '-stage.$GITHUB_RUN_NUMBER',
      'node tools/stage-package.mjs --check --scope "$SCOPE" --version "$version" --platforms "$PLATFORMS_INPUT"',
      'node tools/pack-public-packages.mjs kition',
      'node tools/stage-package.mjs --from target/npm-pack/kition.tgz',
    ])
    ordered(runs(executables), [
      'cargo "$CARGO_BUILD" --locked --profile dist -p kition-cli --target "$BUILD_TARGET"',
      'node packages/kition/scripts/platform-package.mjs platform',
      'node tools/stage-package.mjs --from target/kition/packed/kition-cli-',
      'unset KITION_NPM_SCOPE KITION_BINARY',
      'node "$cli" kit install "$KIT"',
    ])
    ordered(runs(publish), [
      '`target/stage-cli/${platform}.tgz`, `${scope}/cli-${platform}`]), ["target/stage-cli/launcher.tgz", `${scope}/cli`]]',
      'node tools/kit-npm-package.mjs state --tarball "$archive" --registry "$REGISTRY"',
      'npm publish "$archive" --access public --tag latest --provenance --ignore-scripts',
      'node tools/kit-npm-package.mjs visible --name "$name" --version "$version" --registry "$REGISTRY" --tag latest --minutes "$left"',
      'npm view "$name@$version" dist.integrity --registry "$REGISTRY" --prefer-online',
    ])
    // Never npm view before publishing: npm's CDN would keep that 404 of a new name's metadata.
    const publishStep = publish.steps.find((step) => step.name === 'Publish').run
    expect(publishStep).toContain('node tools/kit-npm-package.mjs state --tarball "$archive" --registry "$REGISTRY"')
    expect(publishStep).not.toContain('npm view')
    for (const job of Object.values(workflow.jobs)) expect(runs(job)).not.toContain('${{')
  })
})
