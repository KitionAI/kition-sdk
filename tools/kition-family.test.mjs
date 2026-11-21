// The Kition family (tools/kition-family.mjs): one source, the family of
// templates/community/repositories.json, rendered for READMEs, npm and the organization profile.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FAMILY_BEGIN, FAMILY_END, ORG_PROFILE, familyBlock, findBlocks, kitFormats, kitOf, readData, readFamily, renderFamily, renderOrgProfile, shortLine, withTail, withoutFamily } from './kition-family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = readData()
const family = readFamily(data)
const ORDER = ['note', 'table', 'board', 'doc', 'sheet', 'slide', 'pdf', 'html', 'photo', 'vector', 'layout', 'design', 'film', 'motion', 'cad', 'scene']
const PRODUCTS = ['Kition Desktop', 'Kition SDK', '`kition` command line', 'Kition One', 'Kition Server', 'Kit Harness Protocol (KHP)', 'Kition Tessera', 'Kition Showcase', 'Kition Universe', 'Kition Fonts']
/** Names that are private or frozen, and never in the family. */
const PRIVATE = [/\bkiv\b/i, /khp-bench/i, /Kition Cloud/i, /sponsor/i, /Kition Kits/]

describe('the family data', () => {
  it('lists the products and the 16 kits by product line, in the fixed order', () => {
    expect(family.products.map((product) => product.name)).toEqual(PRODUCTS)
    expect(family.lines.map((line) => [line.name, line.kits.length])).toEqual([['Office', 8], ['Design', 4], ['Media', 2], ['Engineering', 2]])
    expect(family.kits.map((info) => info.kit)).toEqual(ORDER)
    expect(family.kits.filter((info) => info.preview).map((info) => info.kit)).toEqual(['html', 'design', 'scene'])
    for (const product of family.products) for (const [, url] of product.links) expect(url).toMatch(/^https:\/\//)
  })

  it('takes each kit from its repository entry, the short line from its description', () => {
    expect(kitOf('note')).toEqual({
      kit: 'note',
      title: 'Kition Note',
      name: 'Note',
      github: 'KitionAI/kition-note',
      url: 'https://github.com/KitionAI/kition-note',
      description: 'Kition Note: a Markdown editor that never rewrites your file, for people and AI agents',
      short: 'A Markdown editor that never rewrites your file',
      preview: false,
    })
    expect(kitOf('pdf').short).toBe('Read and edit PDF files')
    expect(shortLine({ title: 'Kition X', description: 'Kition X: an editor, for people and AI agents' })).toBe('An editor')
    expect(() => kitOf('nope')).toThrow('"nope" is not a kit of templates/community/repositories.json (no kit entry kition-nope)')
  })

  it('refuses a kit entry in no product line, a kit twice, a Preview kit outside the lines, a relative link', () => {
    const copy = () => JSON.parse(JSON.stringify(data))
    const dropped = copy()
    dropped.family.lines[2].kits = ['film']
    expect(() => readFamily(dropped)).toThrow('kit entry kition-motion is in no product line')
    const twice = copy()
    twice.family.lines[3].kits.push('note')
    expect(() => readFamily(twice)).toThrow('kit note in two product lines')
    const preview = copy()
    preview.family.preview.push('nope')
    expect(() => readFamily(preview)).toThrow('preview kit nope is in no product line')
    const relative = copy()
    relative.family.products[0].links[0][1] = 'docs/x.md'
    expect(() => readFamily(relative)).toThrow('desktop: a link is [label, https URL]')
  })
})

describe('the family section', () => {
  it('bolds a kit README\'s own kit, not linked, and links every other kit, with the Preview labels', () => {
    const text = renderFamily(family, { kit: 'note' })
    expect(text.startsWith('## The Kition family\n\n')).toBe(true)
    expect(text).toContain('| Office | **Note** · [Table](https://github.com/KitionAI/kition-table) · ')
    expect(text).not.toContain('[Note](')
    expect(text).toContain('[HTML](https://github.com/KitionAI/kition-html) (Preview) |')
    expect(text).toContain('[Design](https://github.com/KitionAI/kition-design) (Preview) |')
    expect(text).toContain('| Engineering | [CAD](https://github.com/KitionAI/kition-cad) · [Scene](https://github.com/KitionAI/kition-scene) (Preview) |')
    expect(renderFamily(family, { kit: 'scene' })).toContain('**Scene** (Preview) |')
    // The kits in their fixed order.
    const order = [...text.matchAll(/(?:\[|\*\*)(\w+)(?:\]|\*\*)(?:\(https:\/\/github\.com\/KitionAI\/kition-\w+\))?/g)].map((match) => match[1].toLowerCase())
    expect(order.filter((name) => ORDER.includes(name))).toEqual(ORDER)
  })

  it('lists the products in order, bolds the README\'s own product, and has no private product', () => {
    const text = renderFamily(family, { product: 'sdk' })
    const rows = text.split('\n').filter((line) => line.startsWith('| ') && line.split(' | ').length === 3)
    expect(rows.slice(2).map((row) => row.slice(2).split(' | ')[0])).toEqual(PRODUCTS.map((name) => (name === 'Kition SDK' ? '**Kition SDK**' : name)))
    expect(renderFamily(family)).not.toContain('**')
    for (const text of [renderFamily(family), renderOrgProfile(family)]) {
      for (const name of PRIVATE) expect(text).not.toMatch(name)
      // Every link is absolute (npm shows it away from GitHub).
      for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) expect(target).toMatch(/^https:\/\//)
    }
  })

  it('sits between markers, which find and strip it', () => {
    const block = familyBlock(family, { kit: 'film' })
    expect(block.startsWith(`${FAMILY_BEGIN}\n## The Kition family\n`)).toBe(true)
    expect(block.endsWith(`${FAMILY_END}\n`)).toBe(true)
    const readme = `# X\n\nText.\n\n${block}\n## License\n\nApache-2.0.\n`
    expect(findBlocks(readme)).toEqual({ blocks: [{ start: readme.indexOf(FAMILY_BEGIN), end: readme.indexOf('\n## License') }], broken: false })
    expect(withoutFamily(readme)).toBe('# X\n\nText.\n\n\n## License\n\nApache-2.0.\n')
    expect(findBlocks(`a\n${FAMILY_BEGIN}\nb\n`).broken).toBe(true)
    expect(findBlocks(`a\n${FAMILY_END}\n`).broken).toBe(true)
  })
})

describe('the generated files', () => {
  it('writes the org profile: the tagline, where to start, the products and the kits with their short lines', () => {
    const text = renderOrgProfile(family)
    expect(text.split('\n')[1]).toBe('# Kition: the open pro suite for AI.')
    expect(text).toContain('- **Use it:** [kition.ai](https://kition.ai)\n- **Build with it:** [developer.kition.ai](https://developer.kition.ai)\n- **Give it to your agent:** `npx @kition/cli`')
    expect(text).toContain('| Office | [Note](https://github.com/KitionAI/kition-note) | A Markdown editor that never rewrites your file |\n|  | [Table](https://github.com/KitionAI/kition-table) | Tables, views and dashboards in one file |')
    expect(text).toContain('| Engineering | [CAD](https://github.com/KitionAI/kition-cad) | A 2D CAD editor for .dxf drawings |\n|  | [Scene](https://github.com/KitionAI/kition-scene) (Preview) | A 3D scene editor |')
    expect(fs.readFileSync(path.join(root, ORG_PROFILE), 'utf8')).toBe(text)
  })

  it('keeps a package README\'s own text and replaces or appends its tail', () => {
    expect(withTail('# @kition/x\n\nWhat it is.\n\nLicense: Apache-2.0\n', 'TAIL\n')).toBe('# @kition/x\n\nWhat it is.\n\nLicense: Apache-2.0\n\nTAIL\n')
    const once = withTail('# @kition/x\n\nWhat it is.\n', `${FAMILY_BEGIN}\nold\n${FAMILY_END}\n`)
    expect(withTail(once, `${FAMILY_BEGIN}\nnew\n${FAMILY_END}\n`)).toBe(`# @kition/x\n\nWhat it is.\n\n${FAMILY_BEGIN}\nnew\n${FAMILY_END}\n`)
  })

  it('reads a kit.json\'s formats for the tables', () => {
    expect(kitFormats({ formats: [{ extensions: ['md', '.markdown'] }, { extensions: ['md'] }], creates: [{ extension: 'md' }], exports: [] })).toEqual({ opens: '`.md`, `.markdown`', creates: '`.md`', exports: '—' })
    expect(kitFormats(null)).toEqual({ opens: '—', creates: '—', exports: '—' })
  })
})
