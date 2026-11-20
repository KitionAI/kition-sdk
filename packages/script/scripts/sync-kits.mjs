#!/usr/bin/env node
// Regenerates every bundled kit module (`packages/script/kits/<kit>.ts`) from the kit packages a host
// pins, so the SDK's typings and schemas are the ones of the packages it ships with.
//
//   node packages/script/scripts/sync-kits.mjs [--lock <kits.lock.json>] [--kits <dir>] [--repos <dir>] [--check]
//
// --lock   the pinned packages (default: Kition's kits/kits.lock.json in a sibling checkout,
//          or $KITION_DIR/kits/kits.lock.json)
// --kits   the folder holding the pinned packages as `<kit>-ui/` (default: $KITION_KITS_DIR, else
//          Kition's public/kits); each package's kit-ui.json must name the pinned version and commit
// --repos  the folder holding the kit repositories as `kition-<kit>/` (default: the parent of this
//          repository), read only for a package that does not ship `model/schema.json`: the schema
//          is then taken from the kit's repository at the pinned commit
// --check  write nothing; exit 1 when a bundled module differs from what the packages generate
//
// A package's own `model/schema.json` wins: it is the schema its engine was built with.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PUBLISHED_KITS } from '../../../tools/published-kits.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(here, '../../..')
const kition = process.env.KITION_DIR ?? resolve(sdkRoot, '../kition')

const { values: args } = parseArgs({
  options: { lock: { type: 'string' }, kits: { type: 'string' }, repos: { type: 'string' }, kit: { type: 'string', multiple: true }, check: { type: 'boolean' } },
})
const lockFile = resolve(args.lock ?? join(kition, 'kits/kits.lock.json'))
const kitsDir = resolve(args.kits ?? process.env.KITION_KITS_DIR ?? join(kition, 'public/kits'))
const reposDir = resolve(args.repos ?? dirname(sdkRoot))

/** The bundled kit modules: the pinned kit's key in kits.lock.json, and its typings' name. */
const MODULES = Object.fromEntries(PUBLISHED_KITS.map((kit) => [kit, kit[0].toUpperCase() + kit.slice(1)]))

for (const kit of args.kit ?? []) {
  if (!Object.hasOwn(MODULES, kit)) throw new Error(`unknown SDK kit: ${kit}`)
}

const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'kition-sdk-kits-'))
const problems = []
const changed = []

const CONVENTIONAL = ['crates/kdm/kdm-model/model/schema.json', 'model/schema.json']

/** The kit's KDM schema: the package's `model/schema.json`, else its repository's at the pinned commit. */
function schemaText(kit, pinned, packageDir) {
  const shipped = join(packageDir, 'model/schema.json')
  if (existsSync(shipped)) return { text: readFileSync(shipped, 'utf8'), from: `${kit}-ui/model/schema.json` }
  const repo = join(reposDir, `kition-${kit}`)
  if (!existsSync(repo)) throw new Error(`${kit}-ui ships no model/schema.json and ${repo} is not a checkout of the kit's repository`)
  const git = (...rest) => execFileSync('git', ['-C', repo, ...rest], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const manifest = JSON.parse(git('show', `${pinned.commit}:kit.json`))
  // A contract 1 kit may name no schema in kit.json (K12) yet keep one where the KDM crates do.
  const files = new Set(git('ls-tree', '-r', '--name-only', pinned.commit).split('\n'))
  const path = manifest.model?.schema ?? CONVENTIONAL.find((candidate) => files.has(candidate))
  if (!path) throw new Error(`kition-${kit} ${pinned.commit}: kit.json names no model.schema and no ${CONVENTIONAL.join(' or ')}`)
  return { text: git('show', `${pinned.commit}:${path}`), from: `kition-${kit} ${pinned.commit.slice(0, 12)}:${path}` }
}

try {
  for (const [kit, name] of Object.entries(MODULES)) {
    if (args.kit && !args.kit.includes(kit)) continue
    const pinned = lock[kit]
    if (!pinned) {
      problems.push(`${kit}: not pinned in ${lockFile}`)
      continue
    }
    const packageDir = join(kitsDir, `${kit}-ui`)
    const manifestFile = join(packageDir, 'kit-ui.json')
    if (!existsSync(manifestFile)) {
      problems.push(`${kit}: no package at ${packageDir}`)
      continue
    }
    const shipped = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (shipped.version !== pinned.version || shipped.commit !== pinned.commit) {
      problems.push(`${kit}: ${packageDir} is ${shipped.version} (${shipped.commit}), not the pinned ${pinned.version} (${pinned.commit})`)
      continue
    }
    const schema = schemaText(kit, pinned, packageDir)
    const schemaFile = join(scratch, `${kit}.schema.json`)
    writeFileSync(schemaFile, schema.text)
    const out = join(sdkRoot, 'packages/script/kits', `${kit}.ts`)
    const generated = join(scratch, `${kit}.ts`)
    execFileSync(process.execPath, [join(here, 'generate-kit.mjs'), '--schema', schemaFile, '--package', packageDir, '--name', name, '--out', generated], {
      stdio: 'inherit',
    })
    const text = readFileSync(generated, 'utf8')
    const same = existsSync(out) && readFileSync(out, 'utf8') === text
    const version = JSON.parse(schema.text).schemaVersion
    console.log(`${kit} ${pinned.version}: schema version ${version} from ${schema.from}${same ? ', unchanged' : args.check ? ', differs' : ', written'}`)
    if (same) continue
    changed.push(kit)
    if (!args.check) writeFileSync(out, text)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

for (const problem of problems) console.error(problem)
if (problems.length || (args.check && changed.length)) process.exit(1)
