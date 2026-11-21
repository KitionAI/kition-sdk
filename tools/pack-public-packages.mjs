#!/usr/bin/env node
// Inspect local archives only. This tool never publishes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { undeclaredImports } from './check-public-package-imports.mjs'
import { CLIENT_NAMES, editorWorkerProblems, oldNamesIn, SDK, sdkExports, TESSERA } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, 'target/npm-pack')
fs.mkdirSync(destination, { recursive: true })
const reports = []
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  return result
}
const packages = new Map(fs.readdirSync(path.join(root, 'packages')).map((directory) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packages', directory, 'package.json'), 'utf8'))
  return [manifest.name, { directory, manifest }]
}).filter(([, { manifest }]) => !manifest.private))
const ordered = []
const visited = new Set()
const visiting = new Set()
const visit = (name) => {
  if (visited.has(name)) return
  assert.ok(!visiting.has(name), `circular package dependency: ${name}`)
  const pkg = packages.get(name)
  assert.ok(pkg, `missing public workspace dependency: ${name}`)
  visiting.add(name)
  for (const [dependency, version] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })) {
    if (packages.has(dependency) || version.startsWith('workspace:')) visit(dependency)
  }
  visiting.delete(name)
  visited.add(name)
  ordered.push(pkg)
}
for (const [name, { directory }] of packages) {
  if (process.argv.length === 2 || process.argv.slice(2).includes(directory)) visit(name)
}
for (const { directory, manifest } of ordered) {
  const cwd = path.join(root, 'packages', directory)
  const dry = run('pnpm', ['pack', '--dry-run'], cwd)
  if (dry.status !== 0 && !`${dry.stdout}${dry.stderr}`.includes("Unknown option: 'dry-run'")) throw new Error(dry.stdout + dry.stderr)
  const archive = path.join(destination, `${directory}.tgz`)
  const packed = run('pnpm', ['pack', '--json', '--out', archive], cwd)
  if (packed.status !== 0) throw new Error(packed.stdout + packed.stderr)
  const listing = run('tar', ['-tzf', archive], root)
  assert.equal(listing.status, 0)
  const files = listing.stdout.trim().split('\n').filter((file) => !file.endsWith('/')).map((file) => file.replace(/^package\//, '')).sort()
  for (const file of files) {
    assert.match(file, /^(?:dist\/|package\.json$|README(?:\.md)?$|LICENSE(?:\.md)?$)/, file)
    assert.doesNotMatch(file, /(?:\.map$|\.test\.|(?:^|\/)(?:test|tests|fixtures|bench|prototypes)\/)/, file)
  }
  const extracted = run('tar', ['-xOf', archive, 'package/package.json'], root)
  assert.equal(extracted.status, 0)
  const published = JSON.parse(extracted.stdout)
  assert.equal(published.private, undefined)
  for (const version of Object.values(published.dependencies ?? {})) assert.doesNotMatch(version, /^(?:link:|file:|workspace:)/)
  for (const target of Object.values(published.exports)) {
    for (const file of typeof target === 'string' ? [target] : Object.values(target)) assert.ok(files.includes(file.replace(/^\.\//, '')), `${published.name}: missing ${file}`)
  }
  let bundlesLoro = false
  for (const file of files.filter((file) => /\.(?:js|mjs|ts|css|html)$/.test(file))) {
    const content = run('tar', ['-xOf', archive, `package/${file}`], root)
    assert.equal(content.status, 0)
    assert.doesNotMatch(content.stdout, /(?:\/Users\/|\/home\/|sourceMappingURL=|C8-)/, `${published.name}: ${file}`)
    if (/\.(?:[cm]?js|ts)$/.test(file)) assert.deepEqual(undeclaredImports(published, content.stdout), [], `${published.name}: ${file} has undeclared imports`)
    bundlesLoro ||= content.stdout.includes('__wbg_lorodoc_free')
  }
  // The installers ride in @kition/cli, the same bytes as install/ (tools/build-package.mjs).
  if (published.name === '@kition/cli') {
    for (const script of ['install.sh', 'install.ps1']) {
      assert.ok(files.includes(`dist/${script}`), `${published.name}: lacks dist/${script}`)
      assert.equal(run('tar', ['-xOf', archive, `package/dist/${script}`], root).stdout, fs.readFileSync(path.join(root, 'install', script), 'utf8'), `${published.name}: dist/${script} is not install/${script}`)
    }
  }
  // @kition/sdk carries the twelve library packages: it depends on none of them, and has every
  // subpath tools/sdk-package.mjs gives (tools/smoke-sdk-package.mjs installs and uses it).
  if (published.name === SDK) {
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const name of Object.keys(published[section] ?? {})) assert.ok(!name.startsWith('@kition/') || name === TESSERA, `${SDK}: ${section} names ${name}`)
    }
    assert.deepEqual(published.exports, sdkExports(), `${SDK}: its exports are not tools/sdk-package.mjs's`)
    // No file names one of the old packages (the twelve, Tessera's three) to its reader: comments,
    // messages and declarations say @kition/sdk/<subpath>. Allowed: the client names a library sends
    // a server (CLIENT_NAMES in tools/sdk-package.mjs), which the owner renames at cutover or not.
    const left = []
    for (const file of files) {
      const content = run('tar', ['-xOf', archive, `package/${file}`], root)
      assert.equal(content.status, 0)
      for (const { name, line } of oldNamesIn(content.stdout)) left.push(`${file}:${line}: ${name}`)
    }
    assert.deepEqual(left, [], `${SDK} names old packages (allowed: the client names ${CLIENT_NAMES.join(', ')})`)
    // The editor's worker names Loro's WebAssembly, a file beside it, and inlines none of it.
    assert.deepEqual(editorWorkerProblems(files, (file) => run('tar', ['-xOf', archive, `package/${file}`], root).stdout), [], `${SDK}: its editor worker and Loro's wasm`)
  }
  // Bundled third-party code ships with its license (tools/build-package.mjs writes the notices).
  if (bundlesLoro) {
    assert.ok(files.includes('dist/THIRD_PARTY_NOTICES'), `${published.name}: bundles loro-crdt without dist/THIRD_PARTY_NOTICES`)
    const notices = run('tar', ['-xOf', archive, 'package/dist/THIRD_PARTY_NOTICES'], root).stdout
    assert.ok(notices.includes(fs.readFileSync(path.join(root, 'packages/kdm/node_modules/loro-crdt/LICENSE'), 'utf8').trim()), `${published.name}: THIRD_PARTY_NOTICES lacks Loro's license`)
  }
  reports.push({ name: published.name, dryRunExit: dry.status, packExit: packed.status, archive, files })
  console.log(`${published.name}: dry-run=${dry.status}, pack=${packed.status}; archive verified`)
}
fs.writeFileSync(path.join(destination, 'files.json'), `${JSON.stringify(reports, null, 2)}\n`)
console.log(`File lists: ${path.join(destination, 'files.json')}`)
