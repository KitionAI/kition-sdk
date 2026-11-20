// A local npm registry for the tests: it serves the packages whose archives (`npm pack` tarballs)
// are in one folder, and nothing else, the way the npm registry serves them (a packument per
// package with every version's manifest, its tarball's address, shasum and integrity, and the
// versions' publication times). The tests point the `@kition` scope at it in an isolated HOME's
// .npmrc, so `@kition/dsh-kits`, `@kition/cli` and `@kition/cli-<platform>` of this checkout
// install as they will from npm, before any of them is published.
//
//   node test/registry.mjs <folder of .tgz> [port]   prints {"registry": "http://127.0.0.1:<port>/"}
//   node test/registry.mjs --write <folder> <kition>  writes the release's archives there first
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The packuments of the archives in `folder`: `{ [name]: { packument, files: { [file]: path } } }`. */
export function packuments(folder, base) {
  const packages = {}
  for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.tgz')).sort()) {
    const archive = path.join(folder, file)
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { cwd: folder, encoding: 'utf8' }))
    const bytes = fs.readFileSync(archive)
    const entry = (packages[manifest.name] ??= { packument: { name: manifest.name, 'dist-tags': {}, versions: {}, time: {} }, files: {} })
    const time = fs.statSync(archive).mtime.toISOString()
    entry.files[file] = archive
    entry.packument.versions[manifest.version] = {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      dist: {
        tarball: `${base}${encodeURIComponent(manifest.name).replace('%40', '@')}/-/${file}`,
        shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
        integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      },
    }
    entry.packument.time[manifest.version] = time
    entry.packument.time.created ??= time
    entry.packument.time.modified = time
    entry.packument['dist-tags'].latest = manifest.version
  }
  return packages
}

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(plugin, '../../..')
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options })

/**
 * Writes into `out` the archives a release publishes for the plugin, made the way
 * .github/workflows/release.yml makes them, from this checkout: @kition/cli (the launcher, packed
 * by tools/pack-public-packages.mjs), @kition/cli-<platform> for this platform carrying `kition`
 * (packages/kition/scripts/platform-package.mjs platform), the launcher linked to every platform
 * package by version (`link`), and the plugin (npm pack). The other platforms' packages, which the
 * link step requires and npm never installs here, carry a stand-in executable. Answers the
 * plugin's archive.
 */
export function releaseArchives(out, kition) {
  const platforms = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, 'packages/kition/src/platforms.json'), 'utf8'))).filter((key) => !key.startsWith('$'))
  const here = `${process.platform}-${process.arch}`
  const folders = path.join(out, '.platforms')
  fs.mkdirSync(out, { recursive: true })
  const script = path.join(repo, 'packages/kition/scripts/platform-package.mjs')
  for (const platform of platforms) {
    let executable = kition
    if (platform !== here) {
      executable = path.join(out, '.stand-in', platform, platform.startsWith('win32') ? 'kition.exe' : 'kition')
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      fs.writeFileSync(executable, `#!/bin/sh\necho "a stand-in for ${platform}" >&2\nexit 1\n`, { mode: 0o755 })
    }
    run(process.execPath, [script, 'platform', '--platform', platform, '--kition', executable, '--out', folders])
    run('npm', ['pack', path.join(folders, platform), '--pack-destination', out])
  }
  run(process.execPath, [path.join(repo, 'tools/pack-public-packages.mjs'), 'kition'], { cwd: repo })
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'packages/kition/package.json'), 'utf8')).version
  const launcher = path.join(out, `kition-cli-${version}.tgz`)
  fs.copyFileSync(path.join(repo, 'target/npm-pack/kition.tgz'), launcher)
  run(process.execPath, [script, 'link', '--launcher', launcher, '--out', out])
  const packed = JSON.parse(run('npm', ['pack', plugin, '--pack-destination', out, '--json']))[0].filename
  fs.rmSync(folders, { recursive: true, force: true })
  fs.rmSync(path.join(out, '.stand-in'), { recursive: true, force: true })
  return path.join(out, packed)
}

/** Serves `folder` on 127.0.0.1:`port` (0: any); answers `{ url, requests, stop }`. */
export async function startRegistry(folder, port = 0) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://registry')
    requests.push(`${req.method} ${url.pathname}`)
    const base = `http://127.0.0.1:${server.address().port}/`
    const packages = packuments(folder, base)
    const name = decodeURIComponent(url.pathname.slice(1).split('/-/')[0])
    const entry = packages[name]
    if (!entry) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
    if (url.pathname.includes('/-/')) {
      const file = entry.files[path.basename(url.pathname)]
      if (!file) return res.writeHead(404).end()
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fs.readFileSync(file))
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entry.packument))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, stop: () => new Promise((resolve) => server.close(resolve)) }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv[0] === '--write') {
    releaseArchives(path.resolve(argv[1]), path.resolve(argv[2]))
    argv.splice(0, 3, argv[1])
  }
  const [folder, port] = argv
  const registry = await startRegistry(path.resolve(folder), Number(port ?? 0))
  process.stdout.write(`${JSON.stringify({ registry: registry.url })}\n`)
}
