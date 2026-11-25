/// <reference types="node" />
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openKitPackage } from '../src/node'
import type { Note, NoteCommands } from '../kits/note'

const kitsDir = resolve(process.env.KITION_KITS_DIR ?? fileURLToPath(new URL('../../../../kition/public/kits', import.meta.url)))
const notePackage = join(kitsDir, 'note-ui')

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('the object model on an engine in this process', () => {
  it.skipIf(!existsSync(join(notePackage, 'kit-ui.json')))('reads and edits a note whose schema declares projected sections and tasks (kit package from KITION_KITS_DIR)', async () => {
    const note = await openKitPackage(notePackage)
    const file = note.create('Plan.md')
    cleanups.push(() => file.close())
    file.engine.execute('note.write', JSON.stringify({ markdown: '# Plan\n\nShip it.\n\n- [ ] Write the notes\n' }))
    const document = await file.model<Note, NoteCommands>()
    const read = await document.run(async (context) => {
      const root = context.root
      root.load(['body'])
      root.sections.load()
      await context.sync()
      const section = root.sections.at(0)
      section.load(['heading', 'level'])
      section.tasks.load()
      await context.sync()
      const task = section.tasks.at(0)
      task.load(['text', 'checked'])
      await context.sync()
      task.checked = true
      root.body.insert(2, 'Our ')
      await context.sync()
      root.load(['body'])
      await context.sync()
      return { heading: section.heading, level: section.level, task: task.text, body: root.body.toString() }
    })
    expect(read).toEqual({ heading: 'Plan', level: 1, task: 'Write the notes', body: '# Our Plan\n\nShip it.\n\n- [x] Write the notes\n' })
  })
})
