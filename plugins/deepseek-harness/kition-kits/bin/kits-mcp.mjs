#!/usr/bin/env node
// Starts the kits' MCP server for the kition-kits DeepSeek Harness plugin: the server (arguments
// `--workspace <folder>`) or the person's draft review (`drafts <command> ...`). The plugin's
// options are environment variables (DeepSeek Harness bundles have no settings form):
//
//   KITION_KITS_MCP      the server executable: `kition` (started as `kition mcp`) or a
//                        kition-kits-mcp; default: `kition` on the PATH (`npm install -g
//                        @kition/cli`, or install.sh's ~/.kition/bin), else kition-kits-mcp on the
//                        PATH, else `npx -y @kition/cli mcp`, the npm package, which brings kition
//                        for this platform. kition installs each kit in ~/.kition/kits on first
//                        use when no kits are given here
//   KITION_KITS_DIR      a folder with one folder per installed kit (kit.json beside its executable)
//   KITION_KIT_REPOS     a folder of kit repository checkouts, kition-<kit>/, whose debug builds
//                        (target/debug/kition-<kit>) are served with the kit.json above them
//   KITION_KITS_UNIFIED  "true" (the default): one tool set for every kit (kit_<action>);
//                        anything else: <prefix>_<action> per kit
//
// An option set to an empty string, or to an unexpanded `${...}` reference, is unset.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const windows = process.platform === 'win32'
const unset = (value) => value === undefined || value === '' || value.includes('${')

/** The executable `name` on the PATH, or null. */
function onPath(name) {
  const extensions = windows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      if (executable(candidate)) return candidate
    }
  }
  return null
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function fail(message) {
  process.stderr.write(`kition-kits: ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const serving = args[0] !== 'drafts'
const env = { ...process.env }

let command = env.KITION_KITS_MCP
let prefix = []
if (unset(command)) {
  // An unset option must not reach the server's environment as a path.
  delete env.KITION_KITS_MCP
  command = onPath('kition') ?? onPath('kition-kits-mcp')
  if (!command) {
    const npx = onPath('npx')
    if (npx) {
      command = npx
      prefix = ['-y', '@kition/cli', 'mcp']
    }
  }
  if (!command) {
    fail(
      'no kition, no kition-kits-mcp and no npx on the PATH. Install kition (npm install -g @kition/cli, or ' +
        'curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh and put ~/.kition/bin on the PATH), ' +
        'or set KITION_KITS_MCP to a kition or kition-kits-mcp executable.',
    )
  }
} else if (!executable(command)) {
  fail(`KITION_KITS_MCP is ${command}, which is not an executable file. Set it to a kition or kition-kits-mcp executable, or leave it unset.`)
}
// kition serves the kits as `kition mcp`, with kition-kits-mcp's arguments.
if (prefix.length === 0 && path.basename(command, windows ? path.extname(command) : '') === 'kition') prefix = ['mcp']

const options = []
if (!unset(env.KITION_KITS_DIR)) options.push('--kits-dir', env.KITION_KITS_DIR)
if (!unset(env.KITION_KIT_REPOS)) {
  const repos = env.KITION_KIT_REPOS
  const entries = fs.existsSync(repos) ? fs.readdirSync(repos).filter((name) => name.startsWith('kition-')).sort() : []
  for (const repo of entries) {
    const kit = repo.slice('kition-'.length)
    const built = path.join(repos, repo, 'target', 'debug', `kition-${kit}${windows ? '.exe' : ''}`)
    if (executable(built)) options.push('--kit', built)
  }
}
if (serving && (unset(env.KITION_KITS_UNIFIED) ? 'true' : env.KITION_KITS_UNIFIED) === 'true') options.push('--unified')

// npx is a .cmd script on Windows, which only a shell starts.
const shell = windows && /\.(cmd|bat)$/i.test(command)
const quote = (value) => (shell ? `"${String(value).replace(/"/g, '""')}"` : value)
const child = spawn(quote(command), [...prefix, ...args, ...options].map(quote), { stdio: 'inherit', env, shell })
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const signal of forwarded) process.on(signal, () => child.kill(signal))
child.on('error', (error) => fail(`could not start ${command}: ${error.message}`))
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1)
  // End the same way the server did.
  for (const name of forwarded) process.removeAllListeners(name)
  process.kill(process.pid, signal)
})
