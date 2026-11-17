import { describe, expect, it, vi } from 'vitest'
import { kitSchemaLoader } from '../src/schemas'

const shipped = { kdm: 1, kit: 'kit.note', schemaVersion: 99, root: 'Note', types: {} }

describe('a kit schema for drafts and the agent', () => {
  it('is the page’s when it gives one, without reading the package', async () => {
    const given = { kit: 'kit.note' }
    const fromPackage = vi.fn(async () => shipped)
    await expect(kitSchemaLoader('kit.note', given, fromPackage)()).resolves.toBe(given)
    expect(fromPackage).not.toHaveBeenCalled()
  })

  it('is the one the kit package ships, read once', async () => {
    const fromPackage = vi.fn(async () => shipped)
    const load = kitSchemaLoader('kit.note', undefined, fromPackage)
    await expect(load()).resolves.toBe(shipped)
    await expect(load()).resolves.toBe(shipped)
    expect(fromPackage).toHaveBeenCalledTimes(1)
  })

  it('is the bundled kit’s when the package ships none, ships another kit’s, or cannot be read', async () => {
    for (const fromPackage of [async () => undefined, async () => ({ ...shipped, kit: 'kit.other' }), async () => Promise.reject(new Error('offline'))]) {
      const schema = (await kitSchemaLoader('kit.note', undefined, fromPackage)()) as { kit: string; schemaVersion: number }
      expect(schema.kit).toBe('kit.note')
      expect(schema.schemaVersion).not.toBe(99)
    }
  })

  it('is undefined for a kit with no bundled schema and no package schema', async () => {
    await expect(kitSchemaLoader('kit.unknown', undefined, async () => undefined)()).resolves.toBeUndefined()
  })
})
