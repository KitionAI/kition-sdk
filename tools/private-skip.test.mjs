import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const wrapper = path.join(here, 'private-skip.mjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'private-skip-'))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** Runs `body` as a script through the wrapper; answers its exit status and output. */
function wrapped(name, body) {
  const script = path.join(scratch, `${name}.mjs`)
  fs.writeFileSync(script, body)
  const result = spawnSync(process.execPath, [wrapper, script], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout }
}

/** A script that prints `lines` and exits with `status`. */
const script = (status, ...lines) => `${lines.map((line) => `console.log(${JSON.stringify(line)})`).join('\n')}\nprocess.exit(${status})\n`
const report = (missing, reason) => JSON.stringify({ status: 'skipped', missing, reason }, null, 2)
const reason = 'the private kition-server is missing: KITION_SYNC_SERVER does not give its address'

describe('private-skip', () => {
  it('reports a skip for a missing private tool as skipped and exits 0', () => {
    const run = wrapped('private', script(77, `SKIP: ${reason}`, report('kition-server', reason)))
    expect(run.stdout).toContain(`skipped: ${reason}`)
    expect(run.status).toBe(0)
  })

  it('passes a 77 through when the missing tool is not private', () => {
    const run = wrapped('public', script(77, 'SKIP: poppler is missing', report('poppler', 'poppler is missing')))
    expect(run.stdout).not.toContain('skipped:')
    expect(run.status).toBe(77)
  })

  it('passes a 77 through without a report or without the SKIP line', () => {
    expect(wrapped('no-report', script(77, `SKIP: ${reason}`)).status).toBe(77)
    expect(wrapped('no-line', script(77, report('kition-server', reason))).status).toBe(77)
  })

  it('passes every other exit through, a private-tool report included', () => {
    expect(wrapped('failed', script(1, `SKIP: ${reason}`, report('kition-server', reason))).status).toBe(1)
    expect(wrapped('passed', script(0)).status).toBe(0)
  })
})
