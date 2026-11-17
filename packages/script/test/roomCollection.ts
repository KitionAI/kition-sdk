/**
 * An entry file for the room tests: one entry per title, each with a title shape whose body's
 * first paragraph holds the title, made with the KDM alone (no kit engine), and a script that
 * reads or rewrites every entry's title through the object model.
 */
import { newDocId, parseSchema, person, Replica, type Tx } from '@kition/kdm'
import { roomKit } from './roomKit'
import type { ModelDocument } from '../src/document'
import type { ModelObject } from '../src/proxy'

/** An entry file with one entry per title, by `owner`. */
export function makeCollection(titles: string[], owner = 'u:alice'): Replica {
  const { replica } = Replica.createWith(parseSchema(roomKit.schema), newDocId(), 1n, person(owner), (tx: Tx) => {
    const root = tx.create('Collection', {})
    titles.forEach((title, index) => {
      const entry = tx.create('Entry', {})
      tx.listInsert(root, 'entries', index, entry)
      const body = tx.create('TextBody', {})
      const paragraph = tx.create('Paragraph', {})
      tx.listInsert(body, 'paragraphs', 0, paragraph)
      tx.textInsert(paragraph, 'text', 0, title)
      const shape = tx.create('Shape', { kind: 'shape', name: 'Title 1', body })
      tx.listInsert(entry, 'shapes', 0, shape)
    })
  })
  return replica
}

type Paragraph = ModelObject & { text: { set(text: string): void; toString(): string } }

/** Every entry's title (its first shape's first paragraph), or with `rewrite`, sets each to `rewrite(title, index)` first. */
export async function titles(doc: ModelDocument, rewrite?: (title: string, index: number) => string): Promise<string[]> {
  return doc.run(async (context) => {
    const root = context.root as ModelObject & { entries: { load(): unknown; length: number; at(index: number): ModelObject & { shapes: { load(): unknown; at(index: number): ModelObject & { body: string } } } } }
    root.entries.load()
    await context.sync()
    const entries = Array.from({ length: root.entries.length }, (_, index) => root.entries.at(index))
    for (const entry of entries) entry.shapes.load()
    await context.sync()
    const shapes = entries.map((entry) => entry.shapes.at(0).load(['body']) as ModelObject & { body: string })
    await context.sync()
    const bodies = shapes.map((shape) => context.object(shape.body, 'TextBody') as ModelObject & { paragraphs: { load(): unknown; at(index: number): Paragraph } })
    for (const body of bodies) body.paragraphs.load()
    await context.sync()
    const paragraphs = bodies.map((body) => body.paragraphs.at(0).load(['text']) as Paragraph)
    await context.sync()
    if (rewrite) {
      const before = paragraphs.map((paragraph) => paragraph.text.toString())
      paragraphs.forEach((paragraph, index) => paragraph.text.set(rewrite(before[index], index)))
      for (const paragraph of paragraphs) paragraph.load(['text'])
      await context.sync()
    }
    return paragraphs.map((paragraph) => paragraph.text.toString())
  })
}
