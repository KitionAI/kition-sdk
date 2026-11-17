/**
 * `kition-kits-mcp [arguments]`: starts kition-kits-mcp (`resolveServer`) with the same arguments,
 * standard input, output and error, and exits as it does. The server speaks MCP on standard
 * output, so this launcher never writes there: what it has to say goes to standard error.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { thisMachine } from './machine'
import { LAUNCHED_VARIABLE, resolveServer, serverArgs } from './resolve'

const resolved = resolveServer(thisMachine(fileURLToPath(import.meta.url)))
if (!resolved.ok) {
  process.stderr.write(`kition-kits-mcp: ${resolved.message}\n`)
  process.exit(1)
}

// MCP clients stop a stdio server by signalling the process they started: this one.
// Install handlers before spawning: the server can announce readiness before spawn returns.
// Node queues signals received during spawn until this stack yields and child is assigned.
const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
const forward = (signal: NodeJS.Signals) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}
for (const signal of signals) process.on(signal, forward)

const child = spawn(resolved.server, serverArgs(process.argv.slice(2), resolved.kitsDir), {
  stdio: 'inherit',
  env: { ...process.env, [LAUNCHED_VARIABLE]: '1' },
  windowsHide: true,
})

child.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(`kition-kits-mcp: cannot start ${resolved.server}: ${error.message}\n`)
  process.exit(error.code === 'ENOENT' ? 127 : 126)
})

child.on('exit', (code, signal) => {
  for (const name of signals) process.off(name, forward)
  if (signal) {
    // End the way the server ended, so the client sees the same signal.
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
