#!/usr/bin/env node
// Starts the kits' MCP server for the kition-kits DeepSeek Harness plugin: the server (arguments
// `--workspace <folder>`) or the person's draft review (`drafts <command> ...`). The plugin's
// options are environment variables (DeepSeek Harness bundles have no settings form):
//
//   KITION_KITS_MCP      the server executable: `kition` (started as `kition mcp`) or a
//                        kition-kits-mcp; default: `kition` on the PATH (`npm install -g
//                        @kition/cli`), else where kition installs to (install.sh's ~/.kition/bin,
//                        ~/.cargo/bin, /usr/local/bin, /opt/homebrew/bin: DeepSeek Harness Desktop's
//                        PATH often has none of them), else kition-kits-mcp on the PATH, else
//                        `npx -y @kition/cli mcp`, the npm package, which brings kition
//                        for this platform. kition installs each kit in ~/.kition/kits on first
//                        use when no kits are given here
//   KITION_KITS_DIR      a folder with one folder per installed kit (kit.json beside its executable)
//   KITION_KIT_REPOS     a folder of kit repository checkouts, kition-<kit>/, whose debug builds
//                        (target/debug/kition-<kit>) are served with the kit.json above them; a
//                        kition-* folder without a kit.json is no kit and is passed over
//   KITION_KITS_UNIFIED  "true" (the default): one tool set for every kit (kit_<action>);
//                        anything else: <prefix>_<action> per kit
//
// An option set to an empty string, or to an unexpanded `${...}` reference, is unset.
import { spawn } from 'node:child_process'

import { executable, isKition, kitOptions, onPath, unset, wellKnownKition, windows } from '../lib/kition.mjs'

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
  command = onPath('kition') ?? wellKnownKition().find(executable) ?? onPath('kition-kits-mcp')
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
if (prefix.length === 0 && isKition(command)) prefix = ['mcp']

const options = kitOptions(env, { unified: serving })

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
