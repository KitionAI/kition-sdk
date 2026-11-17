// The sources the extension runtime (src/generated/runtime.ts) is built from, and their hash.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function runtimeInputs() {
  const runtime = readdirSync(join(root, 'src/runtime'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/runtime/${name}`)
  return [...runtime, 'src/rpc.ts', 'src/protocol.ts', 'sandbox/bootstrap.js', '../script/src/proxy.ts', 'scripts/build-runtime.mjs'].sort()
}

export function inputsHash() {
  const hash = createHash('sha256')
  for (const path of runtimeInputs()) {
    // Line endings do not count, so a checkout with CRLF agrees.
    hash.update(path).update('\0').update(readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')).update('\0')
  }
  return hash.digest('hex')
}
