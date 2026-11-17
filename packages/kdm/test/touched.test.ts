import { describe, expect, it } from 'vitest'
import { addThread, ChangeAudit, COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF, deleteComment, newDocId, parseSchema, person, Replica, reply, setResolved, system, touchesOnlyComments } from '../src/index'

const schema = (schemaVersion = 1) =>
  parseSchema({
    kdm: 1,
    kit: 'kit.test',
    schemaVersion,
    root: 'Doc',
    types: { Doc: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
  })

const said = (body: string) => ({ author: 'alice', body, created: '2026-10-19T10:00:00Z' })

/** A document, an audit following it, and a step that answers what one transaction touched. */
function setup() {
  const doc = Replica.create(schema(), newDocId(), 1n)
  const root = doc.transact(person('bob'), (tx) => {
    const id = tx.create('Doc', {})
    tx.textInsert(id, 'body', 0, 'Hello')
    return id
  })
  const audit = ChangeAudit.load(doc.exportChanges())
  const step = <R>(write: Parameters<Replica['transact']>[1], origin = person('alice')) => {
    const before = audit.version()
    const result = doc.transact(origin, write) as R
    return { result, touched: audit.touched(doc.exportChanges(before)) }
  }
  return { doc, root, audit, step }
}

describe('ChangeAudit', () => {
  it('sees a thread, a reply, a resolve, and a delete as comments only', () => {
    const { step } = setup()
    const added = step<{ thread: string; comment: string }>((tx) => addThread(tx, { object: 'doc', field: 'body' }, said('Why?')))
    expect(touchesOnlyComments(added.touched)).toBe(true)
    expect([...added.touched.objects.values()].sort()).toEqual(['Comment', 'CommentThread'])
    const { thread, comment } = added.result
    expect(touchesOnlyComments(step((tx) => reply(tx, thread, said('Because.'))).touched)).toBe(true)
    expect(touchesOnlyComments(step((tx) => setResolved(tx, thread, true)).touched)).toBe(true)
    // Deleting reads the deleted objects' types from before the change.
    const deleted = step((tx) => deleteComment(tx, thread, comment)).touched
    expect(touchesOnlyComments(deleted)).toBe(true)
  })

  it('sees an edit of the content beside a comment', () => {
    const { step, root } = setup()
    const touched = step((tx) => {
      addThread(tx, { object: root, field: 'body' }, said('Typo'))
      tx.textInsert(root, 'body', 5, '!')
    }).touched
    expect(touchesOnlyComments(touched)).toBe(false)
    expect(touched.objects.get(root)).toBe('Doc')
  })

  it('sees a change outside the objects', () => {
    const { doc, audit } = setup()
    const newer = Replica.load(schema(2), doc.snapshot(), 2n)
    const before = audit.version()
    expect(newer.transact(system('migrate'), (tx) => tx.raiseSchemaVersion(2))).toBe(true)
    const touched = audit.touched(newer.exportChanges(before))
    expect(touched.outside).toBe(true)
    expect(touchesOnlyComments(touched)).toBe(false)
  })

  it('follows changes it does not judge', () => {
    const { doc, root, audit, step } = setup()
    const before = audit.version()
    doc.transact(person('bob'), (tx) => tx.textInsert(root, 'body', 0, '> '))
    audit.follow(doc.exportChanges(before))
    expect(touchesOnlyComments(step((tx) => addThread(tx, { object: root }, said('Quote?'))).touched)).toBe(true)
  })
})
