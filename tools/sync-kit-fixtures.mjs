#!/usr/bin/env node
// Copies each kit's committed manifest (kition-<kit>/kit.json at its HEAD) into kition-kits'
// fixtures, crates/kition-kits/tests/fixtures/kits/<kit>.json, byte for byte, so the crate's tests
// read the kits as they are. The kit repositories stay the only source: never edit a fixture by
// hand.
//
//   node tools/sync-kit-fixtures.mjs [--repos <folder>]          write the fixtures
//   node tools/sync-kit-fixtures.mjs --check [--repos <folder>]  fail when a fixture differs
//
// `--repos` is the folder holding the kit repositories (kition-<kit>/), by default this
// repository's parent; `--fixtures` the folder written, by default the crate's. The committed
// manifest is read (`git show HEAD:kit.json`), never the working tree, which other sessions may
// be editing. A kit whose repository isn't there is skipped with a note, and --check passes when
// none is there, so it can run where only kition-sdk is checked out.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { PUBLISHED_KITS } from './published-kits.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** The kit.json committed at the repository's HEAD, or null when there is none. */
function committed(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'show', 'HEAD:kit.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function option(args, name, otherwise) {
  const at = args.indexOf(name)
  return path.resolve(at >= 0 ? args[at + 1] : otherwise)
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const repos = option(args, '--repos', path.join(root, '..'))
  const fixtures = option(args, '--fixtures', path.join(root, 'crates/kition-kits/tests/fixtures/kits'))
  const kits = PUBLISHED_KITS
  let found = 0
  const differ = []
  for (const kit of kits) {
    const repo = path.join(repos, `kition-${kit}`)
    const text = fs.existsSync(repo) ? committed(repo) : null
    if (text === null) {
      console.error(`skip ${kit}: no kit.json committed in ${path.relative(repos, repo)}`)
      continue
    }
    found++
    const out = path.join(fixtures, `${kit}.json`)
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
    if (current === text) continue
    if (check) {
      differ.push(out)
    } else {
      fs.mkdirSync(fixtures, { recursive: true })
      fs.writeFileSync(out, text)
      console.log(`wrote ${path.relative(root, out)}`)
    }
  }
  // Fixtures of kits no longer in the list.
  for (const entry of fs.existsSync(fixtures) ? fs.readdirSync(fixtures) : []) {
    if (entry.endsWith('.json') && !kits.includes(entry.slice(0, -'.json'.length))) {
      if (check) differ.push(`${path.join(fixtures, entry)} (no such kit)`)
      else fs.rmSync(path.join(fixtures, entry))
    }
  }
  if (check) {
    if (differ.length) {
      console.error(`sync-kit-fixtures: ${differ.length} fixture(s) differ from their kit's committed kit.json; run node tools/sync-kit-fixtures.mjs`)
      for (const file of differ) console.error(`  ${path.relative(root, file)}`)
      process.exit(1)
    }
    if (found === 0) {
      console.log('sync-kit-fixtures: no kit repositories next to kition-sdk; nothing to check')
      return
    }
    console.log(`sync-kit-fixtures: ${found} fixtures match their kits' committed kit.json`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
