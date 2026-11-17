/**
 * `openRoom` against a real Kition Server, when `KITION_SYNC_SERVER` names one (its address,
 * such as `http://127.0.0.1:18300`; in `kition-server`, `cargo run -p kition-server -- --config
 * config/dev.toml --memory`, whose dev tokens are `dev-alice` and `dev-bob`). Alice shares a
 * entry file; a script of hers retitles its entries while Bob's handle, opened by the share link,
 * hears the change and reads the new titles. kition-server is a private tool (not open source;
 * docs/quality.md, Private tools): without the variable the tests are skipped, and the file prints
 * `SKIP: <reason>`.
 */
import { describe, expect, it } from 'vitest'
import './roomKit'
import { createRoom, openRoom } from '../src/room'
import { makeCollection, titles } from './roomCollection'

const server = process.env.KITION_SYNC_SERVER
if (!server) console.log('SKIP: the private kition-server is missing: KITION_SYNC_SERVER does not give its address')

describe.skipIf(!server)('openRoom against a Kition Server', () => {
  it("lets a script edit a shared Entry room's titles while another member sees them", async () => {
    const collection = makeCollection(['Q2 plan', 'Hiring', 'Budget'])
    const { shareLink } = await createRoom({ server: server!, token: 'dev-alice', kit: 'kit.mockroom', name: 'Room script test', document: collection.snapshot() })

    const script = await openRoom({ server: server!, token: 'dev-alice', docId: collection.docId, kit: 'kit.mockroom' })
    const bob = await openRoom({ server: server!, tokenProvider: async () => 'dev-bob', shareLink })
    try {
      expect(script.role).toBe('owner')
      expect(bob.role).toBe('editor')
      expect(await titles(bob)).toEqual(['Q2 plan', 'Hiring', 'Budget'])
      const heard = new Promise<string>((resolve) => bob.on('changed', (event) => resolve(event.origin)))
      expect(await titles(script, (title, index) => `${index + 1}. ${title}`)).toEqual(['1. Q2 plan', '2. Hiring', '3. Budget'])
      expect(await heard).toBe('kit')
      expect(await titles(bob)).toEqual(['1. Q2 plan', '2. Hiring', '3. Budget'])
    } finally {
      script.close()
      bob.close()
    }
  }, 30_000)

  it("keeps a commenter's script to comments, which the server takes", async () => {
    const collection = makeCollection(['Q3 plan'])
    await createRoom({ server: server!, token: 'dev-alice', kit: 'kit.mockroom', name: 'Room commenter test', document: collection.snapshot() })
    const alice = await openRoom({ server: server!, token: 'dev-alice', docId: collection.docId, kit: 'kit.mockroom' })
    const { shareLink } = await alice.sync.createLink(collection.docId, 'commenter')
    const bob = await openRoom({ server: server!, token: 'dev-bob', shareLink })
    try {
      expect(bob.role).toBe('commenter')
      await expect(titles(bob, () => 'Mine')).rejects.toThrow(/only comments/)
      const heard = new Promise<void>((resolve) => alice.on('changed', () => resolve()))
      const author = bob.principal!.id
      const added = await bob.batch({
        ops: [
          { op: 'create', type: 'CommentThread', ref: '$thread', fields: { anchor: { object: 'root' }, resolved: false } },
          { op: 'create', type: 'Comment', ref: '$comment', in: '$thread.comments', fields: { author, created: '2026-10-19T09:00:00Z' } },
          { op: 'text.insert', target: '$comment', field: 'body', index: 0, text: 'Check the numbers' },
        ],
      })
      await heard
      const read = await alice.batch({ load: [{ target: added.refs.$comment, fields: ['author', 'body'] }] })
      expect(read.loaded[0].fields).toEqual({ author, body: 'Check the numbers' })
      expect(await titles(alice)).toEqual(['Q3 plan'])
    } finally {
      alice.close()
      bob.close()
    }
  }, 30_000)
})
