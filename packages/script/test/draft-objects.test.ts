import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { workspaceDrafts } from '../src/drafts'
import type { DraftComparison } from '../src/node'

it('workspaceDrafts preserves the bounded generic Rust comparison and numeric ids', async () => {
  const comparison: DraftComparison = {
    path: 'Review.kfilm',
    kit: 'kit.film',
    mode: 'file',
    state: 'ready',
    stale: true,
    diff: {
      created: [{ id: 4, type: 'Clip', fields: ['opacity'], values: { opacity: 100 }, at: { parent: '20', field: 'clips', index: 2 } }],
      changed: [{ id: 1, type: 'Clip', fields: ['effects.0.amount'], edits: [{ field: 'effects.0.amount', before: 5, after: 9, named: 'blur.amount' }] }],
      moved: [{ id: 3, type: 'Clip', from: { parent: '20', field: 'clips', index: 2 }, to: null }],
      deleted: [{ id: 2, type: 'Clip', fields: [], at: { parent: '20', field: 'clips', index: 1 } }],
      texts: [{ id: 1, field: 'caption', before: 'Short', after: { excerpt: 'Long…', length: 1000 } }],
      renumbered: ['9'],
      truncated: { created: 10, changed: 0, moved: 0, deleted: 0, texts: 3, fields: 2, edits: 2, members: 1, values: 1, renumbered: 1 },
    },
    summary: { base: 'Before', draft: 'After' },
  }
  const dir = mkdtempSync(join(tmpdir(), 'kition-draft-objects-'))
  try {
    const script = join(dir, 'compare.mjs')
    writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(comparison))})`)
    const drafts = workspaceDrafts({ server: process.execPath, serverArgs: [script], workspace: dir })
    const answer = await drafts.compare(comparison.path)
    expect(answer).toEqual(comparison)
    expect(answer.diff?.changed[0]?.id).toBe(1)
    expect(answer.diff?.created[0]?.at?.parent).toBe('20')
    expect(answer.diff?.texts[0]?.after).toEqual({ excerpt: 'Long…', length: 1000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
