// Where the plugin finds kition, and the kit options it passes to it: shared by the MCP launcher
// (bin/kits-mcp.mjs) and the host module's gateways (lib/gateways.mjs), so a `kition mcp` and the
// `kition gateway` it relays to serve the same kits under the same tool names.
//
// The options are environment variables of the dsh process (DeepSeek Harness bundles have no
// settings form). An option set to an empty string, or to an unexpanded `${...}` reference, is unset.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/**
 * The kition executable: `KITION_BIN`, else `KITION_KITS_MCP` when it is a kition, else kition on
 * the PATH, else the first well-known place that has one. `{ file }`, or `{ error }` saying what
 * is wrong (an option that names no executable) or `{ missing: true }` when there is none.
 */
export function findKition(env = process.env) {
  if (!unset(env.KITION_BIN)) {
    return executable(env.KITION_BIN) ? { file: env.KITION_BIN } : { error: `KITION_BIN is ${env.KITION_BIN}, which is not an executable file` }
  }
  if (!unset(env.KITION_KITS_MCP) && isKition(env.KITION_KITS_MCP) && executable(env.KITION_KITS_MCP)) return { file: env.KITION_KITS_MCP }
  const found = onPath('kition', env) ?? wellKnownKition(env).find(executable)
  return found ? { file: found } : { missing: true }
}

/** How to install kition, for a person who has none. */
export const INSTALL_HINT =
  'Install kition: npm install -g @kition/cli, or curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh ' +
  '(into ~/.kition/bin). Or set KITION_BIN to a kition executable and restart DeepSeek Harness.'

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
