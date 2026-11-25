#!/usr/bin/env node
// Runs review.mjs against the Note kit's native headless executable (`kition-note`) over the Kit
// Process Protocol: the kit serves the object model itself (`model.describe`, `model.batch`). Then saves
// the note, opens the saved file in a new kit process, and checks the edit survived.
//
// The script reaches the kit through `kition-kits serve` (docs/sdk/hosts.md), as every host does.
//
//   pnpm --filter @kition/script build
//   cargo build -p kition-kits    # here; or KITION_KITS=<bundle>/bin/<platform>/kition-kits
//   cargo build                   # in your kition-note checkout
//   KITION_KITS=target/debug/kition-kits KITION_KIT_NOTE_BINARY=<kition-note>/target/debug/kition-note \
//     node examples/sdk-scripts/run-headless.mjs [dir]
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHeadless } from '../../packages/script/dist/node.js'
import { quarterlyReview } from './review.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const binary = resolve(process.env.KITION_KIT_NOTE_BINARY ?? join(here, '../../../kition-note/target/debug/kition-note'))
if (!existsSync(binary)) throw new Error(`no kition-note at ${binary}: build it in your kition-note checkout (cargo build) or set KITION_KIT_NOTE_BINARY`)
const keep = process.argv[2]
const dir = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'kition-sdk-headless-'))
mkdirSync(dir, { recursive: true })
const path = join(dir, 'Review.md')
writeFileSync(path, '# Team notes\n\nRevenue grew in the north.\n')

try {
  const file = await openHeadless(binary, path, { stderr: 'inherit' })
  let done
  try {
    const note = await file.model({ origin: { kind: 'extension', principal: 'example:quarterly-review' } })
    const described = await note.describe()
    assert.equal(described.capability, 'KitObjectModel 1.0')
    assert.equal(described.root, 'Note')
    assert.ok(described.commands.some((command) => command.id === 'block.append'))
    const changes = []
    note.on('changed', (event) => changes.push(event.origin))
    done = await quarterlyReview(note)
    console.log(JSON.stringify(done, null, 2))
    assert.equal(done.heading, 'Q3 Quarterly review')
    assert.deepEqual(done.task, { text: 'Share the revenue numbers', checked: true })
    assert.ok(changes.includes('local'), 'the script announced its edits')
    assert.equal(file.state.dirty, true)
    await file.save()
  } finally {
    await file.shutdown()
  }

  // The kit took the edits: they are in the saved file, which a new kit process reads.
  assert.equal(readFileSync(path, 'utf8'), done.text)
  const again = await openHeadless(binary, path, { stderr: 'inherit' })
  try {
    const reopened = await again.model()
    const read = await reopened.run(async (context) => {
      const outline = context.commands.run('outline.read', {})
      const tasks = context.commands.run('task.list', {})
      await context.sync()
      return { headings: outline.value.headings.map((heading) => heading.path.at(-1)), tasks: tasks.value.tasks.map(({ text, done }) => ({ text, done })) }
    })
    assert.deepEqual(read, { headings: ['Team notes', 'Q3 Quarterly review'], tasks: [{ text: 'Share the revenue numbers', done: true }] })
    console.log('saved and reopened headless:', JSON.stringify(read))
  } finally {
    await again.shutdown()
  }
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true })
}
