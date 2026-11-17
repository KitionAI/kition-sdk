#!/usr/bin/env node
// A script on a shared document, over the sync protocol: Alice makes a small plan document with the
// Kit Data Model (KDM) alone, shares it as a room on a sync server, and a script of hers numbers every
// item's title through the room while Bob, who opened the room by its share link, sees the new titles
// arrive. Neither handle runs a kit: each keeps a KDM replica of the room and runs batches on it.
//
// The plan's schema is this example's own (kit id example.plan): a room handle needs only a schema,
// so the example runs without any kit package.
//
//   pnpm --filter @kition/kdm build && pnpm --filter @kition/script build
//   # in kition-server: cargo run -p kition-server -- --config config/dev.toml --memory
//   KITION_SYNC_SERVER=http://127.0.0.1:18300 node examples/sdk-scripts/run-room.mjs
//
// The dev server's tokens are dev-alice and dev-bob (KITION_TOKEN_ALICE, KITION_TOKEN_BOB).
//
// kition-server is a private tool (not open source; docs/quality.md, Private tools). Without
// KITION_SYNC_SERVER the script runs nothing: it prints `SKIP: <reason>` and a `skipped` report
// naming the missing tool, and exits 77, the skip status of the Automake and Meson test harnesses,
// never 0. `pnpm test:sdk:room` (tools/private-skip.mjs) reports that as skipped.
import assert from 'node:assert/strict'
import { newDocId, parseSchema, person, Replica } from '../../packages/kdm/dist/index.js'
import { createRoom, openRoom } from '../../packages/script/dist/node.js'

/** The exit status of a run that tested nothing because kition-server is missing. */
const SKIPPED = 77

const server = process.env.KITION_SYNC_SERVER
if (!server) {
  const reason = 'the private kition-server is missing: KITION_SYNC_SERVER does not give its address'
  console.log(`SKIP: ${reason}`)
  console.log(JSON.stringify({ status: 'skipped', missing: 'kition-server', reason }, null, 2))
  process.exit(SKIPPED)
}
const alice = process.env.KITION_TOKEN_ALICE ?? 'dev-alice'
const bob = process.env.KITION_TOKEN_BOB ?? 'dev-bob'

const kit = 'example.plan'
const schema = { kdm: 1, kit, schemaVersion: 1, root: 'Plan', types: { Plan: { fields: { items: { kind: 'list', of: 'Item' } } }, Item: { fields: { title: { kind: 'text' } } } } }

/** Every item's title; with `rewrite`, sets each first. */
async function titles(doc, rewrite) {
  return doc.run(async (context) => {
    const items = context.root.items
    items.load()
    await context.sync()
    const all = Array.from({ length: items.length }, (_, index) => items.at(index).load(['title']))
    await context.sync()
    if (rewrite) {
      const before = all.map((item) => item.title.toString())
      all.forEach((item, index) => item.title.set(rewrite(before[index], index)))
      for (const item of all) item.load(['title'])
      await context.sync()
    }
    return all.map((item) => item.title.toString())
  })
}

// Alice's plan, with two items, made with the KDM alone.
const { replica } = Replica.createWith(parseSchema(schema), newDocId(), 1n, person('u:alice'), (tx) => {
  const root = tx.create('Plan', {})
  ;['Q2 plan', 'Hiring'].forEach((title, index) => {
    const item = tx.create('Item', {})
    tx.textInsert(item, 'title', 0, title)
    tx.listInsert(root, 'items', index, item)
  })
})
const { docId, shareLink } = await createRoom({ server, token: alice, kit, schema, name: 'Plan', document: replica.snapshot() })
console.log('shared', docId, 'as', shareLink)

// Bob opens the room by its share link and listens.
const watcher = await openRoom({ server, token: bob, shareLink, schema })
const before = await titles(watcher)
console.log('Bob sees', JSON.stringify(before))
const arrived = new Promise((resolve) => watcher.on('changed', (event) => resolve(event.origin)))

// Alice's script, on the same room: extension/script is the origin its changes carry.
const script = await openRoom({ server, token: alice, docId, kit, schema, origin: { kind: 'extension', principal: 'example:retitle' } })
const after = await titles(script, (title, index) => `${index + 1}. ${title}`)
console.log('the script wrote', JSON.stringify(after))
assert.equal(await arrived, 'kit')
const seen = await titles(watcher)
console.log('Bob now sees', JSON.stringify(seen))
assert.deepEqual(seen, after)
assert.deepEqual(before, ['Q2 plan', 'Hiring'])
assert.deepEqual(after, ['1. Q2 plan', '2. Hiring'])

script.close()
watcher.close()
