// "KHP" is the Kit Harness Protocol only: how an AI agent uses a kit (KHP specification). The JSON-RPC
// protocol between a host and a kit process is the Kit Process Protocol, always written in full
// (docs/platform/reference/kit-process-protocol.md, "Names"). A section of the
// Kit Process Protocol is "Kit Process Protocol section 5"; a section of KHP names its spec file ("KHP
// spec/agent.md section 8"), since KHP has several. The old Kit Standard is now the Kition kit
// platform: its rules are cited as the platform's ("engine contract E15", "KitModel rule M23",
// "kit editors U8b", "`KitAgent 1.4` D1"), never as KHP's, and KHP's version is 1.0. CHANGELOG.md
// history and cases are records and stay as written.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** Whitespace, or a line break and the comment marker the next line starts with (`///`, `*`, `#`, `>`). */
const GAP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*(?:(?:\/\/[\/!]?|\*|>|#)[ \t]*)?)`
/** "KHP", "(KHP)" as in "Kit Harness Protocol (KHP) 2.0", "KHP," */
const KHP = String.raw`\bKHP\)?,?`

/** `KHP v2`, `KHP §10`, `KHP section 5`: what the Kit Process Protocol was miscalled. */
const MISNAMED = new RegExp(String.raw`\bKHP[ -]?${GAP}?(?:v\d|§\s*\d|section${GAP}\d)`, 'g')
/** `KHP 2.0`, `(KHP) 2.0`, `KHP 6.1`: the old Kit Standard's version or sections; KHP is 1.x. */
const OLD_VERSION = new RegExp(String.raw`${KHP}${GAP}(?!1\.)\d+\.\d+`, 'g')
/** `KHP E15`, `KHP U8a`, `(KHP) D1`, `KHP 2.0 rule M23`, `KHP UI-K1`: a platform rule id after KHP. */
const PLATFORM_ID = new RegExp(String.raw`${KHP}${GAP}(?:rules?${GAP})?(?![AK]\d)[A-Z]+-?[A-Z]*\d`, 'g')
/** `KHP KitAgent`, ``KHP `ToolOverlay` ``: a platform set or an SDK type called KHP's. */
const PLATFORM_NAME = new RegExp(String.raw`${KHP}${GAP}(?:Kit[A-Z]\w*|\`ToolOverlay\`)`, 'g')
/** `Kit Harness Protocol (KHP): [..](../platform/…)`: a platform page introduced as KHP. */
const PLATFORM_LINK = /\bKHP\)?:\s*\[[^\]]*\]\((?:\.\.\/)*platform\//g
/** `KHP A5, A18`, `KHP A21–A23`, `KHP K3`: A and K ids cited as KHP's, each of which must be one. */
const ID = String.raw`[AK]\d+[a-z]?`
const SEP = String.raw`(?:${GAP}?[,\/–-]${GAP}?|${GAP}(?:to|and)${GAP})`
const CITED = new RegExp(String.raw`\bKHP\)?${GAP}(${ID}(?:${SEP}${ID})*)`, 'g')
/** KHP's own rule ids (KHP spec/agent.md, spec/manifest.md; spec/index.md section 5.1).
 * A8, A17, A20, A23 and D1 to D4 left KHP for the platform's `KitAgent 1.4`; K3, K6 to K15, K18,
 * and K22 are the platform manifest's. K21 is both: KHP's `agent.links` and the platform's
 * `agent.describe`, `render`, `parts` and `export`, told apart by "KHP" or "platform" before it. */
const KHP_IDS = new Set([
  ...Array.from({ length: 58 }, (_, i) => `A${i + 1}`).filter((id) => !['A8', 'A17', 'A20', 'A23'].includes(id)),
  'A5a', 'A5b', 'A5c', 'A16a', 'A24a',
  'K1', 'K2', 'K4', 'K5', 'K16', 'K17', 'K19', 'K20', 'K21',
])

/** Every finding in `text` as `<line>: <match>`. */
function misnamings(text) {
  const found = []
  const at = (index) => text.slice(0, index).split('\n').length
  for (const pattern of [MISNAMED, OLD_VERSION, PLATFORM_ID, PLATFORM_NAME, PLATFORM_LINK]) {
    for (const match of text.matchAll(pattern)) found.push(`${at(match.index)}: ${match[0].replace(/\s+/g, ' ')}`)
  }
  for (const match of text.matchAll(CITED)) {
    const foreign = match[1].match(/[AK]\d+[a-z]?/g).filter((id) => !KHP_IDS.has(id))
    if (foreign.length) found.push(`${at(match.index)}: ${match[0].replace(/\s+/g, ' ')} (not KHP's: ${foreign.join(', ')})`)
  }
  return found
}

describe('protocol names', () => {
  it('never call the Kit Process Protocol or the Kition kit platform KHP', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && file !== 'CHANGELOG.md' && !file.startsWith('cases/') && file !== 'tools/protocol-names.test.mjs')
      .filter((file) => /\.(md|rs|ts|tsx|mjs|js|json|toml|ya?ml|py|svg|txt)$/.test(file))
    const found = []
    for (const file of files) {
      const full = path.join(root, file)
      if (!fs.existsSync(full)) continue
      for (const finding of misnamings(fs.readFileSync(full, 'utf8'))) found.push(`${file}:${finding}`)
    }
    expect(found).toEqual([])
  })

  it('flags the old names and keeps the real KHP citations', () => {
    for (const wrong of [
      'the Kit Harness Protocol (KHP) 2.0 convergence suite',
      'KHP 2.0 rule M23',
      '(KHP 6.1)',
      'a granted file (KHP E15)',
      '(Kit Harness Protocol (KHP), U8a)',
      '(KHP, U3a)',
      '(Kit Harness Protocol (KHP) D1)',
      'KHP UI-K1',
      '(KHP KitAgent, as kition-kits-mcp answers them)',
      '(KHP `ToolOverlay`)',
      'Kit Harness Protocol (KHP): [`KitObjectModel 1.0`](../platform/sets/object-model.md)',
      '(Kit Harness Protocol (KHP) A20)',
      'KHP A21–A23',
      '(KHP K9)',
      '`view.screenshot` (KHP\n  section 7)',
      '(KHP 2.0\n   * rule M5a)',
      'KHP v2',
    ]) {
      expect(misnamings(wrong), wrong).not.toEqual([])
    }
    for (const right of [
      'KHP 1.0, edition 2026.11',
      'KHP A16a, A18, A48; KitObjectModel OM1a',
      '(KHP K1, K2, K4, K5, K16,\n/// K17, K19; platform K3)',
      'KHP A12 to A15',
      'KHP A21 and A22, KitAgent A23',
      'KHP spec/agent.md section 8',
      'KHP Agent-ready',
      '`khp://kits/<id>/kit.json` (KHP K20)',
      '`agent.links` (KHP K21), the private runtime folder (KHP A58)',
      'DEFAULT_KHP_VERSION',
      'engine contract E15',
      'KitModel rule M23',
    ]) {
      expect(misnamings(right), right).toEqual([])
    }
  })
})
