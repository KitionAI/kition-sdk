// @vitest-environment jsdom
/**
 * The engine worker saves in the format of the file it opened: it gives the engine the file's
 * name, from whose extension the engine picks the format (the slide engine writes PowerPoint for
 * a `.pptx` and `.kslide` otherwise). Without the name a `.pptx` edited through the embed saved
 * as `.kslide` bytes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
  createKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

const manifest = { kitId: 'kit.slide' } as KitModuleManifest

/** A slide-like engine: `.pptx` bytes for a `.pptx` name, `.kslide` bytes otherwise. */
function fakeSlide() {
  const names: Array<string | undefined> = []
  fake.doc = {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: () => '{}',
    inspect: () => '{}',
    commands: () => '[]',
    save: (name?: string) => {
      names.push(name)
      return new TextEncoder().encode(name?.toLowerCase().endsWith('.pptx') ? 'pptx' : 'kslide')
    },
    markSaved: () => undefined,
    free: () => undefined,
  }
  return names
}

const text = (value: unknown) => new TextDecoder().decode((value as { bytes: ArrayBuffer }).bytes)

describe('the engine worker saving in the opened format', () => {
  it('saves a .pptx it opened as .pptx, with or without the replica', async () => {
    const names = fakeSlide()
    await handle({ method: 'open', manifest, name: 'Quarterly.pptx', bytes: new ArrayBuffer(1), lent: null })
    expect(text((await handle({ method: 'save' })).value)).toBe('pptx')
    expect(text((await handle({ method: 'saveWithReplica' })).value)).toBe('pptx')
    expect(names).toEqual(['Quarterly.pptx', 'Quarterly.pptx'])
  })

  it('saves a .kslide as .kslide, and follows the next document opened', async () => {
    const names = fakeSlide()
    await handle({ method: 'open', manifest, name: 'a.kslide', bytes: new ArrayBuffer(1), lent: null })
    expect(text((await handle({ method: 'save' })).value)).toBe('kslide')
    fakeSlide()
    await handle({ method: 'open', manifest, name: 'b.PPTX', bytes: new ArrayBuffer(1), lent: null })
    expect(text((await handle({ method: 'save' })).value)).toBe('pptx')
    expect(names).toEqual(['a.kslide'])
  })

  it('saves a document it made under the name it was made with', async () => {
    const names = fakeSlide()
    await handle({ method: 'create', manifest, name: 'Untitled slide.kslide', width: 960, height: 540, lent: null })
    await handle({ method: 'save' })
    expect(names).toEqual(['Untitled slide.kslide'])
  })
})
