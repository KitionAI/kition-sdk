import { describe, expect, it } from 'vitest'
import { checkKitNaming } from './kit-naming.mjs'

const doc = {
  id: 'kit.doc', name: 'Doc', agent: { prefix: 'doc', tools: 'document' },
  creates: [{ id: 'doc', baseName: 'Untitled doc', extension: 'docx' }],
  formats: [{ id: 'docx', extensions: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  headless: { executable: 'kition-doc', features: ['file.check'] },
}

describe('Kition naming boundaries', () => {
  it('preserves standard formats and generic document contracts', () => {
    expect(checkKitNaming(doc)).toEqual([])
  })
  it.each([['design', 'Design'], ['scene', 'Scene']])('names %s as a Kition kit like the other fourteen', (name, display) => {
    expect(checkKitNaming({ id: `kit.${name}`, name: name }).join()).toContain(`name: expected "${display}"`)
  })
  it('does not impose Kition product names on third-party kits', () => {
    expect(checkKitNaming({ id: 'org.example.word', name: 'Word processor', agent: { prefix: 'writer' } })).toEqual([])
  })
  it.each(['word', 'document', 'deck', 'presentation'])('rejects the retired kit identity %s', (name) => {
    expect(checkKitNaming({ ...doc, id: `kit.${name}` }).join()).toContain('id:')
  })
  it('names the headless program kition-<kit> and rejects the old kit-<kit>', () => {
    expect(checkKitNaming({ ...doc, headless: { executable: 'kit-doc' } }).join()).toContain('headless.executable: expected "kition-doc"')
  })
  it('rejects a mismatched prefix and create type', () => {
    expect(checkKitNaming({ ...doc, agent: { prefix: 'word' }, creates: [{ id: 'document', baseName: 'Untitled Word document' }] })).toHaveLength(3)
  })
  it('rejects a legacy extension and MIME while accepting the short native format', () => {
    const film = { id: 'kit.film', name: 'Film', formats: [{ extensions: ['kfilm'], mime: 'application/vnd.kition.film+json' }] }
    expect(checkKitNaming(film)).toEqual([])
    expect(checkKitNaming({ ...film, formats: [{ extensions: ['kitionfilm'], mime: 'application/vnd.kition.film.project+json' }] })).toHaveLength(2)
  })
  it('accepts the SQLite suffix for a kit whose native file is a SQLite database', () => {
    const table = { id: 'kit.table', name: 'Table', formats: [{ extensions: ['ktable'], mime: 'application/vnd.kition.table+sqlite3' }] }
    expect(checkKitNaming(table)).toEqual([])
    expect(checkKitNaming({ ...table, formats: [{ extensions: ['ktable'], mime: 'application/vnd.kition.table+sqlite' }] })).toHaveLength(1)
  })
  it('detects a different packaged kit and stale lock', () => {
    const source = { ...doc, version: '1.0.0', model: { schemaVersion: 2 } }
    const failures = checkKitNaming(source, {
      schema: { kit: 'kit.word', schemaVersion: 1 },
      packageManifest: { kitId: 'kit.word', version: '0.9.0', commit: 'old' },
      pin: { repository: 'KitionAI/kition-word', asset: 'kition-word-0.9.0.tgz', version: '0.9.0', commit: 'new' }, key: 'word',
    })
    expect(failures).toHaveLength(9)
  })
  it('distinguishes the slide file root from a single slide', () => {
    const slide = { id: 'kit.slide', name: 'Slide', model: { schemaVersion: 6 } }
    expect(checkKitNaming(slide, { schema: { kit: slide.id, schemaVersion: 6, root: 'SlideFile' } })).toEqual([])
    expect(checkKitNaming(slide, { schema: { kit: slide.id, schemaVersion: 6, root: 'Slide' } }).join()).toContain('model.schema.root')
  })
})
