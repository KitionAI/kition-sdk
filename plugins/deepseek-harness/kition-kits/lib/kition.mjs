// Where the plugin finds kition, and the kit options it passes to it: shared by the MCP launcher
// (bin/kits-mcp.mjs) and the host module's gateways (lib/gateways.mjs), so a `kition mcp` and the
// `kition gateway` it relays to serve the same kits under the same tool names. kition comes with
// the plugin: it depends on @kition/cli, whose platform package carries the executable.
//
// The options are environment variables of the dsh process (DeepSeek Harness bundles have no
// settings form). An option set to an empty string, or to an unexpanded `${...}` reference, is unset.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const windows = process.platform === 'win32'

/** Whether an option's value counts as unset. */
export const unset = (value) => value === undefined || value === '' || value.includes('${')

/** Whether `file` is an executable file. */
export function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The executable `name` on `env.PATH`, or null. */
export function onPath(name, env = process.env) {
  const extensions = windows ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      if (executable(candidate)) return candidate
    }
  }
  return null
}

/**
 * Where kition is installed when the PATH does not say: install.sh's `~/.kition/bin`, `cargo
 * install`'s `~/.cargo/bin`, and the usual system folders. DeepSeek Harness Desktop started from
 * the Finder or the Dock has a PATH without most of them.
 */
export function wellKnownKition(env = process.env) {
  const home = unset(env.HOME) ? os.homedir() : env.HOME
  const name = windows ? 'kition.exe' : 'kition'
  return [path.join(home, '.kition', 'bin', name), path.join(home, '.cargo', 'bin', name), ...(windows ? [] : ['/usr/local/bin/kition', '/opt/homebrew/bin/kition'])]
}

/** Whether `file` names a kition executable (not a kition-kits-mcp). */
export const isKition = (file) => path.basename(file, windows ? path.extname(file) : '') === 'kition'

/** The plugin's own folder (where its package.json is). */
export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The npm package that brings kition: a dependency of the plugin, at the plugin's own version. */
export const CLI_PACKAGE = '@kition/cli'

/** A platform as @kition/cli names its packages: `${process.platform}-${process.arch}`. */
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

/**
 * The folder of the package `name` installed for the file `from`: in the nearest node_modules
 * above it that has it, as Node looks, from `from`'s real path (a package manager's links
 * followed). Neither NODE_PATH nor global folders, and not `require.resolve(name +
 * '/package.json')`, which a package whose `exports` leave out its package.json (as @kition/cli's
 * do) refuses.
 */
function packageDir(name, from) {
  let dir = fs.realpathSync(path.dirname(from))
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (path.basename(dir) !== 'node_modules' && fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Linux on a C library other than glibc (musl, as on Alpine): @kition/cli's Linux builds need glibc. */
function musl() {
  if (process.platform !== 'linux') return false
  return !process.report?.getReport()?.header?.glibcVersionRuntime
}

/**
 * The kition that came with the plugin: the executable of `@kition/cli-<platform>`, the optional
 * package that `@kition/cli` (the plugin's dependency) brings on the platforms it is built for,
 * found from `@kition/cli`'s own folder as its launcher finds it, so a hoisted and an isolated
 * node_modules both do. The plugin starts it directly, not through the Node launcher, so signals,
 * the end of its standard input and its exit status are kition's own.
 *
 * `{ file }`, or `{ reason, platform, platforms }`: `folder` (the plugin was added from a folder,
 * which DeepSeek Harness links without installing its dependencies, and the folder has none),
 * `no-cli` (@kition/cli is not installed beside the plugin otherwise), `unsupported` (it carries
 * no kition for this platform), `omitted` (it does, and the package is not installed: the install
 * left out optional dependencies). `platforms`: those it carries kition for.
 * @param {{ from?: string, platform?: string, arch?: string, musl?: boolean }} [where]
 */
export function bundledKition({ from = PLUGIN_DIR, platform = process.platform, arch = process.arch, musl: notGlibc = musl() } = {}) {
  const key = platformKey(platform, arch)
  const cli = packageDir(CLI_PACKAGE, path.join(from, 'package.json'))
  if (!cli) {
    // A package manager installs a package into a node_modules; a folder added as it is is linked.
    const linked = !fs.realpathSync(from).split(path.sep).includes('node_modules')
    return linked ? { reason: 'folder', folder: from, platform: key, platforms: [] } : { reason: 'no-cli', platform: key, platforms: [] }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8'))
  const platforms = Object.keys(manifest.optionalDependencies ?? {})
    .filter((name) => name.startsWith(`${CLI_PACKAGE}-`))
    .map((name) => name.slice(CLI_PACKAGE.length + 1))
    .sort()
  if (platform === 'linux' && notGlibc) return { reason: 'unsupported', platform: `${key} (musl)`, platforms }
  if (!platforms.includes(key)) return { reason: 'unsupported', platform: key, platforms }
  const dir = packageDir(`${CLI_PACKAGE}-${key}`, path.join(cli, 'package.json'))
  const file = dir && path.join(dir, 'bin', platform === 'win32' ? 'kition.exe' : 'kition')
  if (file && executable(file)) return { file }
  return { reason: 'omitted', platform: key, platforms }
}

/** Whether a kition executable has the `gateway` command, by its path, size and modification time. */
const gatewayChecked = new Map()

/**
 * Whether the kition `file` has the `gateway` command the plugin needs. Its version does not tell
 * (npm's @kition/cli 0.5.2 predates the gateway); `kition gateway --help` does. Asked once per
 * executable, and again when the file changes.
 */
export function hasGateway(file) {
  let signature
  try {
    const stat = fs.statSync(file)
    signature = `${file}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return false
  }
  if (!gatewayChecked.has(signature)) {
    const asked = spawnSync(file, ['gateway', '--help'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    gatewayChecked.set(signature, asked.status === 0 && /kition gateway/.test(`${asked.stdout}${asked.stderr}`))
  }
  return gatewayChecked.get(signature)
}

/** Versions of kition executables, by path, size and modification time. */
const versions = new Map()

/** The version `kition --version` says (`kition 0.5.2 (...)`), or null; asked once per executable. */
export function kitionVersion(file) {
  let signature
  try {
    const stat = fs.statSync(file)
    signature = `${file}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
  if (!versions.has(signature)) {
    const asked = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    versions.set(signature, asked.status === 0 ? (/^kition (\S+)/.exec(asked.stdout)?.[1] ?? null) : null)
  }
  return versions.get(signature)
}

/**
 * The kition the plugin runs, in this order:
 * 1. `KITION_BIN`, the person's choice (a development build), as it is;
 * 2. `KITION_KITS_MCP` when it names a kition (the draft skills' server is the gateways' then too),
 *    which must have the `gateway` command;
 * 3. the kition that came with the plugin (`bundledKition`);
 * 4. a kition on the PATH, else in a place kition installs to, only when it has the `gateway`
 *    command: an older one is passed over, never started to fail.
 *
 * `{ file, from }` (`from`: `env`, `bundled` or `system`); `{ error }` for an option that names no
 * usable kition; or `{ missing: true, reason, platform, platforms, passedOver }` when there is
 * none (`reason` as `bundledKition` says; `passedOver`: the kitions without `gateway` found).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ bundled?: () => ReturnType<typeof bundledKition>, gateway?: (file: string) => boolean }} [look]
 */
export function findKition(env = process.env, { bundled = bundledKition, gateway = hasGateway } = {}) {
  if (!unset(env.KITION_BIN)) {
    return executable(env.KITION_BIN) ? { file: env.KITION_BIN, from: 'env' } : { error: `KITION_BIN is ${env.KITION_BIN}, which is not an executable file` }
  }
  if (!unset(env.KITION_KITS_MCP) && isKition(env.KITION_KITS_MCP) && executable(env.KITION_KITS_MCP)) {
    return gateway(env.KITION_KITS_MCP) ? { file: env.KITION_KITS_MCP, from: 'env' } : { error: `KITION_KITS_MCP is ${env.KITION_KITS_MCP}, a kition without the gateway command (an older version)` }
  }
  const own = bundled()
  if (own.file) return { file: own.file, from: 'bundled' }
  const passedOver = []
  for (const candidate of [onPath('kition', env), ...wellKnownKition(env)]) {
    if (!candidate || passedOver.includes(candidate) || !executable(candidate)) continue
    if (gateway(candidate)) return { file: candidate, from: 'system' }
    passedOver.push(candidate)
  }
  return { missing: true, reason: own.reason, platform: own.platform, platforms: own.platforms, ...(own.folder ? { folder: own.folder } : {}), passedOver }
}

/** What a person, and the agent's setup tool, are told when `findKition` found no kition. */
export function missingMessage(found) {
  const built = found.platforms?.length ? ` It is built for ${found.platforms.join(', ')}.` : ''
  const why =
    found.reason === 'unsupported'
      ? `The plugin's kition (${CLI_PACKAGE}) has no build for this platform, ${found.platform}.${built} Set KITION_BIN to a kition built for it (cargo build -p kition-cli in kition-sdk) and restart DeepSeek Harness.`
      : found.reason === 'folder'
        ? `The plugin was added from a folder (${found.folder}), which DeepSeek Harness links without installing the plugin's dependencies, so ${CLI_PACKAGE}, which brings its kition, is not there. Run npm install --omit=dev in that folder, or add the plugin by name (dsh plugin add @kition/dsh-kits) or from its .tgz, which install it.`
      : found.reason === 'omitted'
        ? `The plugin's kition, the optional package ${CLI_PACKAGE}-${found.platform}, is not installed: the plugin was installed with optional dependencies left out. Add the plugin again without leaving them out, or set KITION_BIN to a kition executable and restart DeepSeek Harness.`
        : `${CLI_PACKAGE}, which brings the plugin's kition, is not installed beside it. Add the plugin again, or set KITION_BIN to a kition executable and restart DeepSeek Harness.`
  const passed = found.passedOver?.length ? ` Passed over, as they have no gateway command (older versions): ${found.passedOver.join(', ')}.` : ''
  return `kition cannot run here. ${why}${passed}`
}

/**
 * The kit options of `kition mcp` and `kition gateway` from the environment: `--kits-dir`, one
 * `--kit` per built kit repository, and `--unified` (unless `KITION_KITS_UNIFIED` says otherwise).
 */
export function kitOptions(env = process.env, { unified = true } = {}) {
  const options = []
  if (!unset(env.KITION_KITS_DIR)) options.push('--kits-dir', env.KITION_KITS_DIR)
  if (!unset(env.KITION_KIT_REPOS)) {
    const repos = env.KITION_KIT_REPOS
    const entries = fs.existsSync(repos) ? fs.readdirSync(repos).filter((name) => name.startsWith('kition-')).sort() : []
    for (const repo of entries) {
      const kit = repo.slice('kition-'.length)
      const built = path.join(repos, repo, 'target', 'debug', `kition-${kit}${windows ? '.exe' : ''}`)
      // A kition-* folder without a kit.json is no kit.
      if (fs.existsSync(path.join(repos, repo, 'kit.json')) && executable(built)) options.push('--kit', built)
    }
  }
  if (unified && (unset(env.KITION_KITS_UNIFIED) ? 'true' : env.KITION_KITS_UNIFIED) === 'true') options.push('--unified')
  return options
}
