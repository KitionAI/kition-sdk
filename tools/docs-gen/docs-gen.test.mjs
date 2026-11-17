import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PUBLISHED_KITS } from '../published-kits.mjs'
import { parseCatalogue as vocabularyCommands } from '../kit-vocabulary.mjs'
import { buildOutputs, parseCatalogue, readCatalogues, syncOutputs } from './build.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, 'build.mjs')
const catalogue = (body) => `export interface DemoCommands extends CommandMap {\n${body}\n}\n`
const sample = catalogue(`
  /** Write text. Changes the document. */
  "text.write": { /** Unicode text, including | and <tags>. */ text: string; /** Position from 0, in scalar units. */ at?: number; settings?: { /** Mode. */ mode: "a" | "b"; values?: Array<{ n: number }> }; anything?: Json }
  /** Read text. */
  "text.read": Record<string, never>
`)
const temporary = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'docs-gen-'))
  temporary.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('integration reference', () => {
  it('retains parameter comments, required flags and nested types without running a kit', () => {
    const records = parseCatalogue(sample, 'demo')
    expect(records.map((record) => record.id)).toEqual(['text.read', 'text.write'])
    const record = records[1]
    expect(record.mutates).toBe(true)
    expect(record.params.required).toEqual(['text'])
    expect(record.params.properties.text).toMatchObject({ type: 'string', description: 'Unicode text, including | and <tags>.' })
    expect(record.params.properties.settings).toMatchObject({
      type: 'object', required: ['mode'], properties: {
        mode: { anyOf: [{ const: 'a' }, { const: 'b' }], description: 'Mode.' },
        values: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } } } },
      },
    })
    expect(record.params.properties.anything).toEqual({ 'x-typescript-type': 'Json' })
    expect(record.source).toBe('packages/script/kits/demo.ts')
    expect(record.lint.L1.status).toBe('unknown')
    expect(record.lint.L7).toEqual({ status: 'missing', json_types: 1 })
    for (const field of ['output', 'availability', 'errors', 'examples', 'see_also', 'since']) expect(record[field]).toBeNull()
  })

  it('handles the no-parameter spelling used when a kit defines its own Record type', () => {
    const [record] = parseCatalogue(catalogue('"view.read": { [key: string]: never }'), 'demo')
    expect(record.params).toMatchObject({ type: 'object', properties: {}, required: [], additionalProperties: false })
    expect(record.mutates).toBe(false)
    expect(record.description).toBeNull()
    expect(record.lint.L2).toEqual({ status: 'pass', described: 0, properties: 0 })
  })

  it('does not infer a mutation from description prose or defaults and units from text', () => {
    const [record] = parseCatalogue(catalogue('/** Changes the document. Preview only. */ "a": { /** Pixels; defaults to 3. */ x: number }'), 'demo')
    expect(record.mutates).toBe(false)
    expect(record.params.properties.x).not.toHaveProperty('default')
    expect(record.params.properties.x).not.toHaveProperty('x-khp-unit')
    expect(record.lint.L3.status).toBe('unknown')
    expect(Object.keys(record.lint)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'])
  })

  it('refuses malformed, empty, duplicate and unsupported catalogues', () => {
    expect(() => parseCatalogue('export const x = 1', 'demo')).toThrow(/CommandMap/)
    expect(() => parseCatalogue(catalogue(''), 'demo')).toThrow(/empty/)
    expect(() => parseCatalogue(catalogue('"a": { x: string'), 'demo')).toThrow(/invalid TypeScript/)
    expect(() => parseCatalogue(catalogue('"a": {}; "a": {}'), 'demo')).toThrow(/duplicate/)
    expect(() => parseCatalogue(catalogue('"a": Json'), 'demo')).toThrow(/object parameter/)
    expect(() => parseCatalogue(sample, '../demo')).toThrow(/kit name/)
  })

  it('produces deterministic, standalone JSONL records and one linked Markdown page per command', () => {
    const outputs = buildOutputs({ zebra: sample, alpha: sample }, [{ title: 'Agent guide', url: 'https://example.org/guide' }])
    const reversed = buildOutputs({ alpha: sample, zebra: sample }, [{ title: 'Agent guide', url: 'https://example.org/guide' }])
    expect([...outputs]).toEqual([...reversed])
    const records = outputs.get('commands.jsonl').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(records.map(({ kit, id }) => `${kit}/${id}`)).toEqual(['alpha/text.read', 'alpha/text.write', 'zebra/text.read', 'zebra/text.write'])
    for (const record of records) {
      const page = outputs.get(record.markdown)
      expect(page).toContain(`# ${record.kit}: ${record.id}`)
      expect(page).toContain('## Parameter schema')
      expect(page).toContain('## Returns, availability and errors')
      expect(page).toContain('No tested examples')
      expect(page).not.toContain('see above')
      expect(outputs.get(`kits/${record.kit}/commands.jsonl`)).toContain(JSON.stringify(record))
      expect(outputs.get(`kits/${record.kit}/llms.txt`)).toContain(`](commands/${encodeURIComponent(record.id)}.md)`)
    }
    expect(outputs.get('kits/alpha/commands/text.write.md')).toContain('Unicode text, including &#124; and &lt;tags&gt;.')
    expect(outputs.get('llms.txt')).toContain('- [alpha](kits/alpha/llms.txt): 2 commands')
    expect(outputs.get('llms.txt')).toContain('[Agent guide](https://example.org/guide)')
  })

  it('escapes command ids for filenames without collapsing distinct names', () => {
    const outputs = buildOutputs({ demo: catalogue('"a/b": {}; "a%2Fb": {}; "a.b": {}') })
    expect(outputs.has('kits/demo/commands/a%2Fb.md')).toBe(true)
    expect(outputs.has('kits/demo/commands/a%252Fb.md')).toBe(true)
    expect(outputs.has('kits/demo/commands/a.b.md')).toBe(true)
  })

  it('checks missing, changed and removed outputs without writing, then removes obsolete pages', () => {
    const out = path.join(temp(), 'output')
    const outputs = buildOutputs({ demo: sample })
    expect(syncOutputs(outputs, out, true)).toHaveLength(outputs.size)
    expect(fs.existsSync(out)).toBe(false)
    syncOutputs(outputs, out)
    expect(syncOutputs(outputs, out, true)).toEqual([])
    fs.writeFileSync(path.join(out, 'llms.txt'), 'stale')
    const removed = path.join(out, 'kits/demo/commands/removed.md')
    fs.writeFileSync(removed, 'old command')
    fs.writeFileSync(path.join(out, 'notes.md'), 'leave alone')
    const changed = syncOutputs(outputs, out, true)
    expect(changed).toEqual(['kits/demo/commands/removed.md', 'llms.txt'])
    expect(fs.readFileSync(path.join(out, 'llms.txt'), 'utf8')).toBe('stale')
    expect(fs.existsSync(removed)).toBe(true)
    syncOutputs(outputs, out)
    expect(fs.existsSync(removed)).toBe(false)
    expect(fs.readFileSync(path.join(out, 'notes.md'), 'utf8')).toBe('leave alone')
    expect(syncOutputs(outputs, out, true)).toEqual([])
  })

  it('removes outputs for a removed kit and refuses symlinks', () => {
    const out = temp()
    syncOutputs(buildOutputs({ alpha: sample, zebra: sample }), out)
    const onlyAlpha = buildOutputs({ alpha: sample })
    expect(syncOutputs(onlyAlpha, out, true)).toContain('kits/zebra/llms.txt')
    syncOutputs(onlyAlpha, out)
    expect(fs.existsSync(path.join(out, 'kits/zebra/commands.jsonl'))).toBe(false)
    fs.symlinkSync(temp(), path.join(out, 'link'))
    expect(() => syncOutputs(onlyAlpha, out)).toThrow(/symlink/)
  })

  it('provides a CLI check with nonzero status on drift or bad arguments', () => {
    const dir = temp()
    const out = path.join(temp(), 'output')
    fs.writeFileSync(path.join(dir, 'demo.ts'), sample)
    const run = (...args) => spawnSync(process.execPath, [tool, '--dir', dir, '--out', out, ...args], { encoding: 'utf8' })
    expect(run('--check').status).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
    const generate = run()
    expect(generate.stderr).toBe('')
    expect(generate.status).toBe(0)
    expect(run('--check').status).toBe(0)
    fs.appendFileSync(path.join(out, 'commands.jsonl'), '\n')
    expect(run('--check').status).toBe(1)
    expect(run('--unknown').status).toBe(1)
    fs.writeFileSync(path.join(dir, 'demo.ts'), 'broken')
    const before = fs.readFileSync(path.join(out, 'llms.txt'), 'utf8')
    expect(run().status).toBe(1)
    expect(fs.readFileSync(path.join(out, 'llms.txt'), 'utf8')).toBe(before)
  })

  it('covers every command of every committed kit, independently counted by the vocabulary reader', () => {
    const texts = readCatalogues(path.resolve(here, '../../packages/script/kits'))
    expect(Object.keys(texts).sort()).toEqual([...PUBLISHED_KITS].sort())
    const outputs = buildOutputs(texts)
    const records = outputs.get('commands.jsonl').trimEnd().split('\n').map((line) => JSON.parse(line))
    let total = 0
    for (const [kit, text] of Object.entries(texts)) {
      const expectedIds = vocabularyCommands(text).map(({ id }) => id).sort()
      expect(records.filter((record) => record.kit === kit).map(({ id }) => id)).toEqual(expectedIds)
      total += expectedIds.length
    }
    expect(records).toHaveLength(total)
    expect([...outputs.keys()].filter((file) => file.endsWith('.md'))).toHaveLength(total)
  })
})
