import { expect, it } from 'vitest'
import { schemaOfDescription } from '../src/index'

// A reader with only a kit's `model/describe` answer (OM1 names a text field's marks by key)
// builds the schema it describes; the marks' definitions (M4c) are not in the description.
it('reads the schema a model description describes, its marks expanding after', () => {
  const described = {
    capability: 'KitObjectModel 1.0',
    kit: 'kit.mock',
    schemaVersion: 3,
    root: 'Board',
    rootId: null,
    commands: [],
    types: {
      Board: { fields: { elements: { kind: 'list', of: 'Element' } } },
      Element: {
        toolId: { field: 'key', prefix: 'el:' },
        fields: {
          key: { kind: 'integer', readOnly: true },
          kind: { kind: 'enum', values: ['rect', 'text'] },
          text: { kind: 'text', marks: ['bold', 'link'] },
          plain: { kind: 'text' },
        },
      },
    },
  }
  const read = schemaOfDescription(described)
  expect(read.kit).toBe('kit.mock')
  expect(read.schemaVersion).toBe(3)
  expect(read.root).toBe('Board')
  expect(read.types.Element.fields.text.marks).toEqual({ bold: { expand: 'after' }, link: { expand: 'after' } })
  expect(read.types.Element.fields.plain.marks).toBeUndefined()
  expect(read.types.Element.toolId).toEqual({ field: 'key', prefix: 'el:' })
  expect(read.types.Element.fields.kind.values).toEqual(['rect', 'text'])
  expect(read.types.Board.fields.elements).toMatchObject({ kind: 'list', of: 'Element' })
})

it('refuses a description without the schema\'s own members', () => {
  expect(() => schemaOfDescription({ kit: 'kit.mock', schemaVersion: 1, types: {} })).toThrow(/root/)
})
