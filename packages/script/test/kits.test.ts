/// <reference types="node" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KITS } from '../kits/index'
import publishedKits from '../../../published-kits.json'
import { kitDescriptor } from '../src/index'
import { openKitPackage } from '../src/node'

const kitsDir = resolve(process.env.KITION_KITS_DIR ?? fileURLToPath(new URL('../../../../kition/public/kits', import.meta.url)))
const kitPackage = (kit: string) => join(kitsDir, `${kit}-ui`)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('the generated kits', () => {
  it('register every kit Kition ships with an object model', () => {
    expect(Object.keys(KITS).sort()).toEqual(publishedKits.map((kit) => `kit.${kit}`).sort())
    for (const [id, kit] of Object.entries(KITS)) {
      expect(kitDescriptor(id)).toBe(kit)
      expect((kit.schema as { kit: string }).kit).toBe(id)
    }
  })

  it('match the schema each kit package ships (model/schema.json), where the package ships one', () => {
    // packages/script/scripts/sync-kits.mjs regenerates them from the packages kits.lock.json pins.
    for (const [id, kit] of Object.entries(KITS)) {
      const shipped = join(kitPackage(id.slice('kit.'.length)), 'model', 'schema.json')
      if (!existsSync(shipped)) continue
      expect(kit.schema, `${id}: regenerate it with packages/script/scripts/sync-kits.mjs`).toEqual(JSON.parse(readFileSync(shipped, 'utf8')))
    }
  })

  it('refuse a kit package whose model/schema.json is another kit’s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kition-sdk-package-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'model'))
    writeFileSync(join(dir, 'kit-ui.json'), JSON.stringify({ kitId: 'kit.doc', version: '1.0.0' }))
    writeFileSync(join(dir, 'model', 'schema.json'), JSON.stringify({ kdm: 1, kit: 'kit.sheet', schemaVersion: 1, root: 'Workbook', types: {} }))
    await expect(openKitPackage(dir)).rejects.toThrow(/schema of kit.sheet, not of kit.doc/)
  })

})
