/**
 * `kition [arguments]`: starts this platform's kition (`resolveKition`) with the same arguments,
 * standard input, output and error, and exits as it does. kition can be an MCP server on standard
 * output (`kition mcp`), so this launcher never writes there: what it has to say goes to standard
 * error. It tells kition how it was started in `KITION_LAUNCHER` (`launchedAs`).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { thisMachine } from './machine'
import { LAUNCHER_VARIABLE, launchedAs, resolveKition } from './resolve'

const machine = thisMachine(fileURLToPath(import.meta.url))
const resolved = resolveKition(machine)
if (!resolved.ok) {
  process.stderr.write(`kition (npm): ${resolved.message}\n`)
  process.exit(1)
}
const launched = launchedAs(machine, resolved.command)
const env = { ...process.env }
if (launched) env[LAUNCHER_VARIABLE] = JSON.stringify(launched)
else delete env[LAUNCHER_VARIABLE]

// MCP clients stop a stdio server by signalling the process they started: this one.
// Install handlers before spawning: the server can announce readiness before spawn returns.
// Node queues signals received during spawn until this stack yields and child is assigned.
const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
const forward = (signal: NodeJS.Signals) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}
for (const signal of signals) process.on(signal, forward)

const child = spawn(resolved.command, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: true })

child.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(`kition (npm): cannot start ${resolved.command}: ${error.message}\n`)
  process.exit(error.code === 'ENOENT' ? 127 : 126)
})

child.on('exit', (code, signal) => {
  for (const name of signals) process.off(name, forward)
  if (signal) {
    // End the way kition ended, so the client sees the same signal.
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
