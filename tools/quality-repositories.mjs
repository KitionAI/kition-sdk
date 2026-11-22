// What templates/quality/repositories.json records about each repository that tools/sync-quality.mjs
// writes the quality rules into, read in one place for sync-quality and sync-community.
//
// Two notions, kept apart because a kit's are not the same:
//   check       the local pre-finish check: what the Stop hook runs before an agent ends a task
//               (default `cargo xtask ci`)
//   fullChecks  where the full checks and tests run:
//                 "kit-ci"  on GitHub, in the kit's CI run (Kition's kit-ci.yml, pushed through
//                           Kition's scripts/kit-ci.sh); the check is only a fast local subset
//                 "ci"      on GitHub, in the repository's CI run (.github/workflows/ci.yml) on every
//                           push to main and every pull request
//                 "check"   on the developer's machine: the check is the full check (the default)
//   xtask       whether the repository has `tools/xtask` (a `cargo xtask` command; default true).
//               Without it the templates name what runs instead: the kit CI's fmt, clippy and
//               `cargo test --workspace` without the `cargo xtask ci` step (Kition's kit-ci.yml skips
//               it), the tests a case's steps name instead of `cargo xtask gate`, a hand-kept
//               `cases` list instead of `cargo xtask features`, kition-sdk's tools/eval-cases.mjs
//               instead of `cargo xtask eval`.
//
// The title of a repository's docs/quality.md is its product name from one source: the entry's
// title in templates/community/repositories.json, else the family product that lives in the
// repository (its `repo`), else the `name` given here (only for a repository the community data
// does not name). The CODEOWNERS owner is the table's `owner`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TABLE = path.join(root, 'templates', 'quality', 'repositories.json')
const COMMUNITY = path.join(root, 'templates', 'community', 'repositories.json')
export const DEFAULT_CHECK = 'cargo xtask ci'
const FULL_CHECKS = new Set(['kit-ci', 'ci', 'check'])
const FIELDS = new Set(['name', 'check', 'fullChecks', 'xtask'])

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function fail(message) {
  throw new Error(`templates/quality/repositories.json: ${message}`)
}

/** A one-line command without backticks (it goes into Markdown code spans and a bash string). */
export function validCommand(command) {
  return typeof command === 'string' && command.trim() !== '' && !/[\r\n`]/.test(command)
}

/** The product name the community data gives the repository `dir`, if any. */
function communityName(dir, community) {
  const entry = community.repositories?.[dir]
  if (entry?.title) return entry.title
  return (community.family?.products ?? []).find((product) => product.repo === dir)?.name ?? null
}

/**
 * The quality data of the repository in directory `dir`:
 * { listed, name, check, fullChecks, xtask, owner }. `name` is null when no data names the repository.
 * Throws for invalid data.
 */
export function qualityRepository(dir, { table = readJson(TABLE), community = readJson(COMMUNITY) } = {}) {
  if (typeof table.owner !== 'string' || !/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/.test(table.owner)) fail('owner must look like @user or @org/team')
  const listed = Object.hasOwn(table.repositories ?? {}, dir)
  const entry = listed ? table.repositories[dir] : {}
  for (const key of Object.keys(entry)) if (!FIELDS.has(key)) fail(`${dir}: unknown field ${key}`)
  const fromCommunity = communityName(dir, community)
  if (entry.name !== undefined) {
    if (fromCommunity !== null) fail(`${dir}: name is ${JSON.stringify(fromCommunity)} in templates/community/repositories.json; give it there only`)
    if (typeof entry.name !== 'string' || !entry.name.trim()) fail(`${dir}: name must be a non-empty string`)
  }
  const check = entry.check ?? DEFAULT_CHECK
  if (!validCommand(check)) fail(`${dir}: check must be one line without backticks`)
  const fullChecks = entry.fullChecks ?? 'check'
  if (!FULL_CHECKS.has(fullChecks)) fail(`${dir}: fullChecks must be one of ${[...FULL_CHECKS].join(', ')}`)
  const xtask = entry.xtask ?? true
  if (typeof xtask !== 'boolean') fail(`${dir}: xtask must be true or false`)
  if (!xtask && /\bcargo xtask\b/.test(check)) fail(`${dir}: check runs cargo xtask, but xtask is false`)
  return { listed, name: fromCommunity ?? entry.name ?? null, check, fullChecks, xtask, owner: table.owner }
}

/**
 * The template values that say where the full checks run: `full` names them in a sentence
 * ("the kit's CI run", "the repository's CI run", or the check command in backticks), and one of
 * the flags kitCi, repoCi, localFull is set.
 */
export function fullCheckValues(fullChecks, check) {
  return {
    full: { 'kit-ci': "the kit's CI run", ci: "the repository's CI run", check: `\`${check}\`` }[fullChecks],
    kitCi: fullChecks === 'kit-ci',
    repoCi: fullChecks === 'ci',
    localFull: fullChecks === 'check',
  }
}
