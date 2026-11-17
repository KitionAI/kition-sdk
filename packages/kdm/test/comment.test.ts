import { describe, expect, it } from 'vitest'
import {
  addThread,
  COMMENT_THREAD_TYPE_DEF,
  COMMENT_TYPE_DEF,
  commentThreads,
  deleteComment,
  isCommentType,
  newDocId,
  parseSchema,
  person,
  relocateAnchorRange,
  Replica,
  reply,
  setResolved,
  type NewComment,
} from '../src/index'

const schema = () =>
  parseSchema({
    kdm: 1,
    kit: 'kit.test',
    schemaVersion: 1,
    root: 'Doc',
    types: { Doc: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
  })

const said = (author: string, body: string, created: string): NewComment => ({ author, name: author.toUpperCase(), body, created })

function sync(a: Replica, b: Replica) {
  const [va, vb] = [a.version(), b.version()]
  a.importChanges(b.exportChanges(va))
  b.importChanges(a.exportChanges(vb))
}

describe('comments', () => {
  it('shares the Rust raw batch contract for comments and threads', async () => {
    const { readFileSync } = await import('node:fs')
    const rust = readFileSync(new URL('../../../crates/kition-kdm/src/comment.rs', import.meta.url), 'utf8')
    for (const [name, definition] of [['COMMENT_THREAD_TYPE_JSON', COMMENT_THREAD_TYPE_DEF], ['COMMENT_TYPE_JSON', COMMENT_TYPE_DEF]] as const) {
      const source = rust.match(new RegExp(`${name}: &str =\\s*r#"([^]*?)"#;`))
      expect(source, name).not.toBeNull()
      expect(JSON.parse(source![1])).toEqual(definition)
      expect(definition).toMatchObject({ batchOps: { '*': { direct: true } } })
    }
  })
  it('opens a thread, replies, resolves, and reads them back', () => {
    const doc = Replica.create(schema(), newDocId(), 1n)
    const anchor = { object: 'root', field: 'body', range: { start: 2, end: 5 }, quote: 'llo' }
    const { thread, comment: first } = doc.transact(person('alice'), (tx) => addThread(tx, anchor, said('alice', 'Is this right?', '2026-10-19T10:00:00Z')))
    const second = doc.transact(person('bob'), (tx) => reply(tx, thread, said('bob', 'Yes.', '2026-10-19T10:01:00Z')))
    doc.transact(person('alice'), (tx) => setResolved(tx, thread, true))
    const [found] = commentThreads(doc)
    expect(found).toEqual({
      id: thread,
      anchor,
      resolved: true,
      comments: [
        { id: first, author: 'alice', name: 'ALICE', body: 'Is this right?', created: '2026-10-19T10:00:00Z' },
        { id: second, author: 'bob', name: 'BOB', body: 'Yes.', created: '2026-10-19T10:01:00Z' },
      ],
    })
    doc.transact(person('bob'), (tx) => deleteComment(tx, thread, second))
    expect(commentThreads(doc)[0].comments).toHaveLength(1)
    doc.transact(person('alice'), (tx) => deleteComment(tx, thread, first))
    expect(commentThreads(doc)).toEqual([])
    expect(doc.exists(thread)).toBe(false)
  })

  it('keeps concurrent replies and converges', () => {
    const a = Replica.create(schema(), newDocId(), 1n)
    const { thread } = a.transact(person('alice'), (tx) => addThread(tx, { object: 'root' }, said('alice', 'One', '2026-10-19T10:00:00Z')))
    const b = Replica.load(schema(), a.snapshot(), 2n)
    a.transact(person('alice'), (tx) => reply(tx, thread, said('alice', 'Two', '2026-10-19T10:02:00Z')))
    b.transact(person('bob'), (tx) => reply(tx, thread, said('bob', 'Three', '2026-10-19T10:02:00Z')))
    sync(a, b)
    expect(commentThreads(a)).toEqual(commentThreads(b))
    expect(commentThreads(a)[0].comments.map((comment) => comment.body).sort()).toEqual(['One', 'Three', 'Two'])
  })

  it('has none without the comment types, and names its types', () => {
    const plain = Replica.create(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Doc', types: { Doc: { fields: {} } } }), newDocId(), 1n)
    expect(commentThreads(plain)).toEqual([])
    expect(() => plain.transact(person('a'), (tx) => addThread(tx, { object: 'root' }, said('a', 'x', 't')))).toThrow()
    expect(isCommentType('Comment') && isCommentType('CommentThread') && !isCommentType('Doc')).toBe(true)
  })
})

describe('relocateAnchorRange', () => {
  const anchor = { object: 'root', field: 'body', range: { start: 6, end: 11 }, quote: 'world' }
  it('keeps a range whose text still reads the quote', () => {
    expect(relocateAnchorRange(anchor, 'Hello world')).toEqual({ start: 6, end: 11 })
  })
  it('follows the quote when text moved it, to the nearest occurrence', () => {
    expect(relocateAnchorRange(anchor, 'Oh, hello world, world')).toEqual({ start: 10, end: 15 })
  })
  it('answers null once the quote is gone, or without a range', () => {
    expect(relocateAnchorRange(anchor, 'Hello there')).toBeNull()
    expect(relocateAnchorRange({ object: 'root' }, 'Hello')).toBeNull()
  })
})
