#!/usr/bin/env node
// Checks the packed DeepSeek Harness plugin against the packed kition packages it is published
// with (.github/workflows/release.yml), and installs it as a person's DeepSeek Harness does.
// Nothing is published: the packages are served from a local registry in a folder of its own.
//
//   node tools/check-dsh-plugin-package.mjs --plugin <dsh-kits.tgz> --launcher <kition.tgz>
//        --platforms <folder of kition-cli-<platform>-<version>.tgz>
//
// - @kition/dsh-kits depends on @kition/cli at exactly its own version, and on nothing else;
// - @kition/cli is that version and depends, optionally, on @kition/cli-<platform> at that version
//   for every platform of packages/kition/src/platforms.json, each one packed in <platforms>;
// - `npm install @kition/dsh-kits` from those archives (as `dsh plugin add @kition/dsh-kits` installs
//   it, with optional dependencies) brings this platform's kition, which the plugin finds
//   (lib/kition.mjs bundledKition) and which answers --version with that version and has the
//   gateway command.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestOf = (archive) => JSON.parse(execFileSync('tar', ['-xzOf', path.basename(archive), 'package/package.json'], { cwd: path.dirname(archive), encoding: 'utf8' }))

/** The checks of the manifests alone; answers the version. */
export function checkManifests({ plugin, launcher, platforms }) {
  const pluginManifest = manifestOf(plugin)
  const launcherManifest = manifestOf(launcher)
  const { version } = pluginManifest
  assert.equal(pluginManifest.name, '@kition/dsh-kits')
  assert.deepEqual(pluginManifest.dependencies, { '@kition/cli': version }, '@kition/dsh-kits depends on @kition/cli at exactly its own version, and on nothing else')
  assert.equal(launcherManifest.name, '@kition/cli')
  assert.equal(launcherManifest.version, version, `@kition/cli is ${launcherManifest.version}; @kition/dsh-kits needs ${version}`)
  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))
  assert.deepEqual(launcherManifest.optionalDependencies, Object.fromEntries(keys.map((key) => [`@kition/cli-${key}`, version])), '@kition/cli depends on every platform package at its version')
  for (const key of keys) {
    const archive = path.join(platforms, `kition-cli-${key}-${version}.tgz`)
    assert.ok(fs.existsSync(archive), `${archive}: not packed`)
    const manifest = manifestOf(archive)
    assert.equal(manifest.name, `@kition/cli-${key}`)
    assert.equal(manifest.version, version)
  }
  return version
}

/** Installs the plugin by name from the archives, as DeepSeek Harness does, and runs its kition. */
export async function checkInstall({ plugin, launcher, platforms }, version) {
  const { startRegistry } = await import(pathToFileURL(path.join(root, 'plugins/deepseek-harness/kition-kits/test/registry.mjs')).href)
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kition-dsh-package-')))
  try {
    const served = path.join(scratch, 'registry')
    fs.mkdirSync(served)
    fs.copyFileSync(plugin, path.join(served, `kition-dsh-kits-${version}.tgz`))
    fs.copyFileSync(launcher, path.join(served, `kition-cli-${version}.tgz`))
    for (const file of fs.readdirSync(platforms).filter((name) => name.startsWith('kition-cli-') && name.endsWith(`-${version}.tgz`))) fs.copyFileSync(path.join(platforms, file), path.join(served, file))
    const registry = await startRegistry(served)
    try {
      const home = path.join(scratch, 'home')
      const project = path.join(scratch, 'profile')
      fs.mkdirSync(home)
      fs.mkdirSync(project)
      fs.writeFileSync(path.join(home, '.npmrc'), `@kition:registry=${registry.url}\n`)
      fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n')
      const env = { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_userconfig: path.join(home, '.npmrc') }
      // The registry is on loopback: no proxy may stand between.
      for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy|npm_config_(https_)?proxy)$/i.test(key)) delete env[key]
      // Not execFileSync: the registry answers from this process, whose event loop must go on.
      await new Promise((resolve, reject) => {
        const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--no-update-notifier', `@kition/dsh-kits@${version}`], { cwd: project, env, stdio: 'inherit', shell: process.platform === 'win32' })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with status ${code}`))))
      })
      const installed = path.join(project, 'node_modules/@kition/dsh-kits')
      const { bundledKition } = await import(pathToFileURL(path.join(installed, 'lib/kition.mjs')).href)
      const found = bundledKition({ from: installed })
      assert.ok(found.file, `the installed plugin finds no kition of its own: ${JSON.stringify(found)}`)
      const said = execFileSync(found.file, ['--version'], { encoding: 'utf8' })
      assert.ok(said.startsWith(`kition ${version} `), `${found.file} --version: ${said}`)
      assert.match(execFileSync(found.file, ['gateway', '--help'], { encoding: 'utf8' }), /kition gateway/)
      return found.file
    } finally {
      await registry.stop()
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = path.resolve(argv[i + 1])
  try {
    if (!flags.plugin || !flags.launcher || !flags.platforms) throw new Error('usage: check-dsh-plugin-package.mjs --plugin <tgz> --launcher <tgz> --platforms <folder>')
    const version = checkManifests(flags)
    const kition = await checkInstall(flags, version)
    console.log(`PASS @kition/dsh-kits ${version} installs @kition/cli ${version} and this platform's kition (${kition}), which has the gateway command`)
  } catch (error) {
    process.stderr.write(`check-dsh-plugin-package: ${error.message}\n`)
    process.exit(1)
  }
}
