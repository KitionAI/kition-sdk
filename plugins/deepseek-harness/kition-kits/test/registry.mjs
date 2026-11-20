// A local npm registry for the tests: it serves the packages whose archives (`npm pack` tarballs)
// are in one folder, and nothing else, the way the npm registry serves them (a packument per
// package with every version's manifest, its tarball's address, shasum and integrity, and the
// versions' publication times). The tests make it the only registry of an install
// (`hermeticInstallEnv`), so `@kition/dsh-kits`, `@kition/cli` and `@kition/cli-<platform>` of this
// checkout install as they will from npm, before any of them is published, and never the published
// packages of the same names and version; each run checks it served them (`assertServed`). Run as
// a process, it prints each request it served on standard error (`served GET <path>`).
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

/**
 * The environment and npm configuration of an install that may take packages from the registry at
 * `url` only, under `base`: every npm and pnpm setting the parent's environment carries is dropped
 * (`npm run`, `npm exec` and `npx` set npm_config_userconfig to the person's own ~/.npmrc, which a
 * package manager then reads instead of the test's, so the @kition scope fell through to the public
 * registry, whose @kition/cli of the same version has no gateway), and `<base>/home/.npmrc` names
 * that registry for every package and for the @kition scope; the cache, the store and the XDG
 * folders are the test's own. Proxies are dropped too: the registry is on loopback. Writes the
 * .npmrc when `url` is given; answers the environment, with `HOME` the folder of that .npmrc.
 */
export function hermeticInstallEnv(base, url, inherited = process.env) {
  const home = path.join(base, 'home')
  fs.mkdirSync(home, { recursive: true })
  const npmrc = path.join(home, '.npmrc')
  // Without `url` (the registry starts later), the .npmrc is written then, with writeNpmrc.
  if (url) writeNpmrc(base, url)
  const env = { ...inherited }
  for (const key of Object.keys(env)) if (/^(npm|pnpm)_config_|^(https?|all|no)_proxy$|^PNPM_HOME$|^XDG_/i.test(key)) delete env[key]
  const own = (name) => path.join(base, name)
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: own('no-global-npmrc'),
    ...(url ? { npm_config_registry: url } : {}),
    npm_config_cache: own('npm-cache'),
    npm_config_store_dir: own('pnpm-store'),
    pnpm_config_store_dir: own('pnpm-store'),
    PNPM_HOME: own('pnpm'),
    XDG_CACHE_HOME: own('xdg-cache'),
    XDG_CONFIG_HOME: own('xdg-config'),
    XDG_DATA_HOME: own('xdg-data'),
    XDG_STATE_HOME: own('xdg-state'),
  })
}

/** Writes `<base>/home/.npmrc`, naming the registry at `url` for every package and for the @kition scope. */
export function writeNpmrc(base, url) {
  fs.mkdirSync(path.join(base, 'home'), { recursive: true })
  fs.writeFileSync(path.join(base, 'home', '.npmrc'), `registry=${url}\n@kition:registry=${url}\n`)
}

/**
 * Checks that the registry served each of `packages` (names) as a tarball, and answers the tarball
 * paths it served; throws naming what an install took from elsewhere (a cache, another registry).
 */
export function assertServed(requests, packages) {
  const tarballs = requests.filter((request) => request.startsWith('GET ') && request.includes('/-/')).map((request) => decodeURIComponent(request.slice(4)))
  const missing = packages.filter((name) => !tarballs.some((tarball) => tarball.startsWith(`/${name}/-/`)))
  if (missing.length) throw new Error(`the local registry did not serve ${missing.join(', ')}: the install took them from elsewhere (it served ${tarballs.join(', ') || 'no tarball'})`)
  return tarballs
}

/** Serves `folder` on 127.0.0.1:`port` (0: any); answers `{ url, requests, stop }`. */
export async function startRegistry(folder, port = 0, { logRequests = false } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://registry')
    requests.push(`${req.method} ${url.pathname}`)
    if (logRequests) process.stderr.write(`served ${req.method} ${url.pathname}\n`)
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
  const registry = await startRegistry(path.resolve(folder), Number(port ?? 0), { logRequests: true })
  process.stdout.write(`${JSON.stringify({ registry: registry.url })}\n`)
}
