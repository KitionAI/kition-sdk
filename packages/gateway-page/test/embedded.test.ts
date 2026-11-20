import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

it('the page kition gateway embeds is the build of this package', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-page-'))
  try {
    execFileSync(process.execPath, [path.join(here, '../build-page.mjs'), '--out', out], { stdio: 'pipe' })
    const embedded = path.join(here, '../../../crates/kition-kits-http/page')
    for (const file of ['index.html', 'page.js', 'page.css']) {
      expect(fs.readFileSync(path.join(embedded, file), 'utf8'), `${file}: run node packages/gateway-page/build-page.mjs`).toBe(fs.readFileSync(path.join(out, file), 'utf8'))
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}, 120_000)
