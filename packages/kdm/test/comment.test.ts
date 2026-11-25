import { describe, expect, it } from 'vitest'
import { COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF, commentThreads, isCommentType, parseSchema, Replica } from '../src/index'
import { bytes } from './fixtures'

const schema = () =>
  parseSchema({
    kdm: 1,
    kit: 'kit.test',
    schemaVersion: 1,
    root: 'Doc',
    types: { Doc: { fields: { body: { kind: 'text' } } }, CommentThread: COMMENT_THREAD_TYPE_DEF, Comment: COMMENT_TYPE_DEF },
  })

const DOC = '0193a5c4-0000-7000-8000-000000000006'
const THREAD = '0193a5c4-0000-7000-8000-0000000000e1'
const OLDER = '0193a5c4-0000-7000-8000-0000000000e0'
const [FIRST, SECOND, GONE] = ['0193a5c4-0000-7000-8000-0000000000f1', '0193a5c4-0000-7000-8000-0000000000f2', '0193a5c4-0000-7000-8000-0000000000f3']

const content = (objects: string[]) => bytes(`{"kdm":1,"kit":"kit.test","docId":"${DOC}","schemaVersion":1,"objects":{\n${objects.join(',\n')}\n}}\n`)

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

  it('reads threads oldest first, with their live comments in order', () => {
    const anchor = { object: 'root', field: 'body', range: { start: 2, end: 5 }, quote: 'llo' }
    const doc = Replica.load(
      schema(),
      content([
        `"${OLDER}":{"$type":"CommentThread","anchor":{"object":"root"},"comments":["${GONE}"]}`,
        `"${THREAD}":{"$type":"CommentThread","anchor":${JSON.stringify(anchor)},"comments":["${FIRST}","${SECOND}"],"resolved":true}`,
        `"${FIRST}":{"$type":"Comment","author":"alice","body":"Is this right?","created":"2026-10-19T10:00:00Z","name":"ALICE"}`,
        `"${SECOND}":{"$type":"Comment","author":"bob","body":"Yes.","created":"2026-10-19T10:01:00Z"}`,
        `"${GONE}":{"$type":"Comment","author":"carol","body":"Early","created":"2026-10-18T09:00:00Z"}`,
      ]),
    )
    expect(commentThreads(doc)).toEqual([
      { id: OLDER, anchor: { object: 'root' }, resolved: false, comments: [{ id: GONE, author: 'carol', body: 'Early', created: '2026-10-18T09:00:00Z' }] },
      {
        id: THREAD,
        anchor,
        resolved: true,
        comments: [
          { id: FIRST, author: 'alice', name: 'ALICE', body: 'Is this right?', created: '2026-10-19T10:00:00Z' },
          { id: SECOND, author: 'bob', body: 'Yes.', created: '2026-10-19T10:01:00Z' },
        ],
      },
    ])
  })

  it('has none without the comment types, and names its types', () => {
    const plain = Replica.load(parseSchema({ kdm: 1, kit: 'kit.test', schemaVersion: 1, root: 'Doc', types: { Doc: { fields: {} } } }), content([`"${OLDER}":{"$type":"Doc"}`]))
    expect(commentThreads(plain)).toEqual([])
    expect(isCommentType('Comment') && isCommentType('CommentThread') && !isCommentType('Doc')).toBe(true)
  })
})
