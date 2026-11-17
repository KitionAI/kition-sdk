// @vitest-environment jsdom
/**
 * A TypeScript engine (`runtime: 'ts-worker'`, rule K11) loads through the same loader as a
 * WebAssembly one: its module's default export is called with the package folder, and its class
 * opens documents like a wasm-pack class.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kitModuleCommands, loadKitModule, openKitModuleDocument, type KitModuleManifest } from './kitModule'

const fixtures = pathToFileURL(path.join(__dirname, 'fixtures') + path.sep).href

describe('kitModuleCommands', () => {
  it('keeps a command\'s output schema and answers null without one', () => {
    const outputSchema = { type: 'object', additionalProperties: true, properties: { id: { type: 'integer', required: true } } }
    const json = JSON.stringify([
      { id: 'table.records.create', title: 'Create Record', menu: null, shortcut: null, mutates: true, enabled: true, schema: { tableId: { type: 'integer', required: true } }, outputSchema },
      { id: 'edit.undo', title: 'Undo', menu: ['Edit'], shortcut: 'Cmd+Z', mutates: true, enabled: true },
    ])
    const [create, undo] = kitModuleCommands(json)
    expect(create.outputSchema).toEqual(outputSchema)
    expect(undo.outputSchema).toBeNull()
  })
})

describe('a ts-worker engine', () => {
  it('is prepared with its folder and opens documents', async () => {
    const manifest: KitModuleManifest = { kitId: 'kit.notes', base: fixtures, module: 'notes_engine', documentClass: 'NotesDocument', runtime: 'ts-worker' }
    const module = await loadKitModule(manifest)
    const prepared = (module as unknown as { prepared: Array<{ base: string }> }).prepared
    expect(prepared).toEqual([{ base: fixtures }])
    const doc = openKitModuleDocument(module, manifest, 'List.notes', new TextEncoder().encode('Groceries'))
    expect(new TextDecoder().decode(doc.save())).toBe('Groceries')
    expect(kitModuleCommands(doc.commands()).map((command) => command.id)).toEqual(['edit.undo', 'edit.redo'])
    expect(typeof doc.exportChanges).toBe('function')
  })
})
