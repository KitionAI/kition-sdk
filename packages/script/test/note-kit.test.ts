import { describe, expect, it } from 'vitest'
import { kitDescriptor } from '../src/index'
import { noteKit, type NoteContext } from '../kits/note'

/** Type-checked use of the published Note typings (run by `pnpm typecheck`). */
export async function typedScript(context: NoteContext) {
  const added = context.commands.run('text.insert', { at: 0, text: 'Hello' })
  context.root.load(['body', 'eol'])
  await context.sync()
  context.root.body.insert(0, 'Hi')
  context.root.body = 'Replaced'
  context.root.eol = 'lf'
  return added.value
}

describe('generated Note typings', () => {
  it('register the Note schema', () => {
    expect(kitDescriptor('kit.note')).toBe(noteKit)
    expect((noteKit.schema as { root: string }).root).toBe('Note')
  })
})
