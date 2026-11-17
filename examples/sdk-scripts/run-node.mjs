#!/usr/bin/env node
// Runs review.mjs headless: the Note engine from its kit package, loaded in Node with no page.
// Then saves the note, opens the saved file again, and checks the edit survived.
//
//   pnpm --filter @kition/script build
//   KITION_KITS_DIR=<kits> node examples/sdk-scripts/run-node.mjs [out.md]
//
// <kits> holds the Note kit's package as note-ui/ (Kition ships it in public/kits).
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openKitPackage } from '../../packages/script/dist/node.js'
import { quarterlyReview } from './review.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const kits = resolve(process.env.KITION_KITS_DIR ?? join(here, '../../../kition/public/kits'))
const notes = await openKitPackage(join(kits, 'note-ui'))

const file = notes.create('Review.md')
file.engine.execute('note.write', JSON.stringify({ markdown: '# Team notes\n\nRevenue grew in the north.\n' }))
const note = await file.model({ origin: { kind: 'extension', principal: 'example:quarterly-review' } })
const changes = []
note.on('changed', (event) => changes.push(event.origin))
const done = await quarterlyReview(note)
console.log(JSON.stringify(done, null, 2))
assert.equal(done.heading, 'Q3 Quarterly review')
assert.equal(done.level, 2)
assert.deepEqual(done.task, { text: 'Share the revenue numbers', checked: true })
assert.ok(done.text.endsWith('## Q3 Quarterly review\n\n- [x] Share the revenue numbers\n'), done.text)
assert.ok(changes.includes('local'), 'the script announced its edits')

// The engine took the edits: they are in the saved file.
const bytes = file.save()
if (process.argv[2]) writeFileSync(process.argv[2], bytes)
const saved = new TextDecoder().decode(bytes)
assert.equal(saved, done.text)
const reopened = await notes.open('Review.md', bytes).model()
const read = await reopened.run(async (context) => {
  const outline = context.commands.run('outline.read', {})
  const tasks = context.commands.run('tasks.list', {})
  await context.sync()
  return { headings: outline.value.headings.map((heading) => heading.path.at(-1)), tasks: tasks.value.tasks.map(({ text, done }) => ({ text, done })) }
})
console.log('saved and reopened:', JSON.stringify(read))
assert.deepEqual(read, { headings: ['Team notes', 'Q3 Quarterly review'], tasks: [{ text: 'Share the revenue numbers', done: true }] })
