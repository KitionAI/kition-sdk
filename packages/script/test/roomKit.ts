import { COMMENT_THREAD_TYPE_DEF, COMMENT_TYPE_DEF } from '@kition/kdm'
import { registerKit } from '../src/kits'

// A synthetic model with lists, references, text and comments, independent of kit packages.
export const roomKit = registerKit({
  id: 'kit.mockroom',
  schema: {
    kdm: 1, kit: 'kit.mockroom', schemaVersion: 1, root: 'Collection',
    types: {
      Collection: { fields: { entries: { kind: 'list', of: 'Entry' } } },
      Entry: { fields: { shapes: { kind: 'list', of: 'Shape' } } },
      Shape: { fields: { kind: { kind: 'string' }, name: { kind: 'string' }, body: { kind: 'ref', of: 'TextBody', owns: true } } },
      TextBody: { fields: { paragraphs: { kind: 'list', of: 'Paragraph' } } },
      Paragraph: { fields: { text: { kind: 'text' } } },
      CommentThread: COMMENT_THREAD_TYPE_DEF,
      Comment: COMMENT_TYPE_DEF,
    },
  },
})
