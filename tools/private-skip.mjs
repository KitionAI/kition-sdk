// Runs a test script for `pnpm test:*` and reads a skip for a missing private tool as skipped,
// not failed: node tools/private-skip.mjs <script> [args...]
//
// A script that finds a private tool missing (docs/quality.md, Private tools: kition-server) prints
// `SKIP: <reason>` and a `{"status": "skipped", "missing": "<tool>", "reason": ...}` report and
// exits 77. Only for that exit and a report naming a private tool does this print
// `skipped: <reason>` and exit 0. Every other exit, a 77 without such a report included, is
// passed through, so any other failure still fails.
import { spawn } from 'node:child_process'

const PRIVATE_TOOLS = new Set(['kition-server'])
const SKIPPED = 77

/** The reason of a skip for a missing private tool in the script's output, or `null`. */
function privateSkip(output) {
  const start = output.search(/^\{$/m)
  if (start < 0) return null
  try {
    const report = JSON.parse(output.slice(start))
    const named = report.status === 'skipped' && PRIVATE_TOOLS.has(report.missing)
    return named && output.includes(`SKIP: ${report.reason}\n`) ? report.reason : null
  } catch {
    return null
  }
}

const [script, ...args] = process.argv.slice(2)
if (!script) {
  console.error('usage: node tools/private-skip.mjs <script> [args...]')
  process.exit(2)
}
let output = ''
const child = spawn(process.execPath, [script, ...args], { stdio: ['inherit', 'pipe', 'inherit'] })
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  output += chunk
})
child.on('close', (code) => {
  const reason = code === SKIPPED ? privateSkip(output) : null
  if (reason) console.log(`skipped: ${reason}`)
  process.exit(reason ? 0 : (code ?? 1))
})
