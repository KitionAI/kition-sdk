import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DraftCommandError, workspaceDrafts } from '../src/drafts'

/** A stand-in `kition-kits-mcp`: answers as `drafts` does, echoing its arguments. */
function fakeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'kition-drafts-'))
  const script = join(dir, 'server.mjs')
  writeFileSync(
    script,
    `const args = process.argv.slice(2)
const [command, sub, path] = args
if (command !== 'drafts') process.exit(2)
const answer =
  sub === 'list' ? { drafts: [{ version: 1, path: 'a.xlsx', kit: 'kit.sheet', mode: 'replica', state: 'ready', baseSha256: 'x', created: 1, updated: 2, stale: false }], args } :
  sub === 'merge' && !args.includes('--overwrite') ? { error: { code: 'stale', message: path + ' changed' } } :
  sub === 'merge' ? { path, merged: true, sha256: 'y', args } :
  sub === 'compare' ? { path, kit: 'kit.sheet', mode: 'replica', state: 'ready', stale: false, diff: null, summary: {}, args } :
  { path, discarded: true, args }
console.log(JSON.stringify(answer))
process.exit(answer.error ? 1 : 0)
`,
  )
  return script
}

describe('workspaceDrafts', () => {
  const drafts = workspaceDrafts({ server: process.execPath, serverArgs: [fakeServer()], workspace: '/work', kits: { sheet: '/bin/kition-sheet' }, kitsDir: '/kits' })

  it('lists, compares, merges, and discards through `kition-kits-mcp drafts`', async () => {
    const listed = await drafts.list()
    expect(listed[0]).toMatchObject({ path: 'a.xlsx', state: 'ready', mode: 'replica' })
    const compared = (await drafts.compare('a.xlsx', { previews: true })) as unknown as { args: string[] }
    expect(compared.args).toEqual(['drafts', 'compare', 'a.xlsx', '--previews', '--workspace', '/work', '--kit', 'sheet=/bin/kition-sheet', '--kits-dir', '/kits'])
    expect(await drafts.merge('a.xlsx', { overwrite: true })).toMatchObject({ merged: true })
    expect(await drafts.discard('a.xlsx')).toMatchObject({ discarded: true })
  })

  it('throws the refusal with its code', async () => {
    const refused = await drafts.merge('a.xlsx').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(DraftCommandError)
    expect((refused as DraftCommandError).code).toBe('stale')
  })
})
