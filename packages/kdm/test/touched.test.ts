/**
 * ChangeAudit reads which objects a change list touches, with their types, from the KDM formats
 * alone. The change lists here are in the form the Rust KDM exports (`changes.json` of
 * `crates/kition-kdm/tests/fixtures/content/` is one it checks).
 */
import { describe, expect, it } from 'vitest'
import { ChangeAudit, touchesOnlyComments } from '../src/index'
import { bytes, reasonOf } from './fixtures'

const DOC = '0193a5c4-0000-7000-8000-000000000005'
const LINE = '0193a5c4-0000-7000-8000-0000000000fd'
const ROOT = '0193a5c4-0000-7000-8000-0000000000d1'
const THREAD = '0193a5c4-0000-7000-8000-0000000000e1'
const FIRST = '0193a5c4-0000-7000-8000-0000000000e2'
const SECOND = '0193a5c4-0000-7000-8000-0000000000e3'

const snapshot = (seq = 1) =>
  bytes(`{"kdm":1,"kit":"kit.test","docId":"${DOC}","version":{"lineage":"${LINE}","seq":${seq}},"schemaVersion":1,"objects":{
"${ROOT}":{"$type":"Doc","body":"Hello"}
}}
`)

const person = ['person', 'alice', null, 1]
const comment = (id: string, body: string) => [
  { op: 'create', id, object: { $type: 'Comment', author: 'alice', created: '2026-10-19T10:00:00Z' } },
  { op: 'textInsert', id, field: 'body', index: 0, text: body, marks: {} },
]

/** A change list of these changes (each a list of operations), the first following `after`. */
function changes(after: number, ...ops: unknown[][]) {
  return bytes(
    JSON.stringify({
      kdm: 1,
      docId: DOC,
      lineage: LINE,
      after: { seq: after, actor: null },
      changes: ops.map((list, index) => ({ seq: after + index + 1, actor: '0000000000000002', origin: person, ops: list })),
    }),
  )
}

const addThread = [
  { op: 'create', id: THREAD, object: { $type: 'CommentThread', anchor: { object: ROOT, field: 'body' }, resolved: false } },
  ...comment(FIRST, 'Why?'),
  { op: 'listInsert', id: THREAD, field: 'comments', index: 0, item: FIRST },
]

describe('ChangeAudit', () => {
  it('sees a thread, a reply, a resolve, and a delete as comments only', () => {
    const audit = ChangeAudit.load(snapshot())
    const added = audit.touched(changes(1, addThread))
    expect(touchesOnlyComments(added)).toBe(true)
    expect([...added.objects.values()].sort()).toEqual(['Comment', 'CommentThread'])
    expect(audit.version().seq).toBe(2)
    expect(touchesOnlyComments(audit.touched(changes(2, [...comment(SECOND, 'Because.'), { op: 'listInsert', id: THREAD, field: 'comments', index: 1, item: SECOND }])))).toBe(true)
    expect(touchesOnlyComments(audit.touched(changes(3, [{ op: 'set', id: THREAD, field: 'resolved', value: true, was: false }])))).toBe(true)
    // A deleted object's type is read from the operation's `was`.
    const deleted = audit.touched(
      changes(4, [
        { op: 'listRemove', id: THREAD, field: 'comments', index: 0, item: FIRST },
        { op: 'delete', id: FIRST, was: { $type: 'Comment', author: 'alice', body: 'Why?', created: '2026-10-19T10:00:00Z' } },
      ]),
    )
    expect(deleted.objects.get(FIRST)).toBe('Comment')
    expect(touchesOnlyComments(deleted)).toBe(true)
  })

  it('sees an edit of the content beside a comment', () => {
    const audit = ChangeAudit.load(snapshot())
    const touched = audit.touched(changes(1, [...addThread, { op: 'textInsert', id: ROOT, field: 'body', index: 5, text: '!', marks: {} }]))
    expect(touchesOnlyComments(touched)).toBe(false)
    expect(touched.objects.get(ROOT)).toBe('Doc')
  })

  it('sees a change outside the objects, and an object it does not know', () => {
    const audit = ChangeAudit.load(snapshot())
    const raised = audit.touched(changes(1, [{ op: 'raiseSchema', version: 2, was: 1 }]))
    expect(raised.outside).toBe(true)
    expect(touchesOnlyComments(raised)).toBe(false)
    const unknown = audit.touched(changes(2, [{ op: 'set', id: '0193a5c4-0000-7000-8000-0000000000ee', field: 'x', value: 1, was: null }]))
    expect(unknown.objects.get('0193a5c4-0000-7000-8000-0000000000ee')).toBeNull()
    expect(touchesOnlyComments(unknown)).toBe(false)
  })

  it('follows changes it does not judge, and skips the changes it has', () => {
    const audit = ChangeAudit.load(snapshot())
    audit.follow(changes(1, [{ op: 'textInsert', id: ROOT, field: 'body', index: 0, text: '> ', marks: {} }]))
    expect(audit.version().seq).toBe(2)
    const again = audit.touched(changes(1, [{ op: 'textInsert', id: ROOT, field: 'body', index: 0, text: '> ', marks: {} }], addThread))
    expect(touchesOnlyComments(again)).toBe(true)
    expect(again.objects.has(ROOT)).toBe(false)
  })

  it('takes a snapshot as a change of the whole document', () => {
    const audit = ChangeAudit.load(snapshot())
    const touched = audit.touched(snapshot(7))
    expect(touched.outside).toBe(true)
    expect(audit.version().seq).toBe(7)
  })

  it('refuses changes that do not follow it, or of another document', () => {
    const audit = ChangeAudit.load(snapshot())
    expect(reasonOf(() => audit.touched(changes(2, addThread)))).toBe('stale')
    expect(reasonOf(() => audit.touched(bytes(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(changes(1, addThread))), docId: '0193a5c4-0000-7000-8000-000000000009' }))))).toBe('wrong-document')
    expect(audit.version().seq).toBe(1)
  })
})
