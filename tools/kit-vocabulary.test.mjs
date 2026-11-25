import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PUBLISHED_KITS } from './published-kits.mjs'
import { buildReport, buildReportFromTexts, measureVocabulary, parseCatalogue, renderMarkdown } from './kit-vocabulary.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, 'kit-vocabulary.mjs')
const kitsDir = path.resolve(here, '../packages/script/kits')

/** A generated catalogue around the given command lines. */
const catalogue = (lines, kit = 'Demo') => `// Generated. Do not edit.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Every command of kit.demo, by id, with its parameters. */
export interface ${kit}Commands extends CommandMap {
${lines.map((line) => `  ${line}`).join('\n')}
}

export type ${kit}Document = ModelDocument<Page, ${kit}Commands>
`

describe('parseCatalogue', () => {
  it('reads a command with no parameters', () => {
    const commands = parseCatalogue(catalogue(['/** Calculate now. */', '"calc.now": Record<string, never>']))
    expect(commands).toEqual([{ id: 'calc.now', description: 'Calculate now.', params: [] }])
  })

  it('reads an object type with only an index signature as no parameters', () => {
    const [command] = parseCatalogue(catalogue(['/** Refresh. */', '"view.refresh": { [key: string]: never }']))
    expect(command.params).toEqual([])
  })

  it('tells optional parameters from required ones', () => {
    const [command] = parseCatalogue(catalogue(['/** Move. */', '"shape.move": { id: string; dx?: number; dy?: number }']))
    expect(command.params).toEqual([
      { name: 'id', optional: false, type: 'string' },
      { name: 'dx', optional: true, type: 'number' },
      { name: 'dy', optional: true, type: 'number' },
    ])
  })

  it('keeps nested object, array and generic types whole, with their ; and }', () => {
    const [command] = parseCatalogue(
      catalogue([
        '/** Create. */',
        '"element.add": { elements: Array<{ kind: "a" | "b"; style?: { fill: string; "x}": number } }>; page?: string; box: [number, number]; map?: Record<string, Array<{ at: number }>> }',
      ]),
    )
    expect(command.params.map((param) => param.name)).toEqual(['elements', 'page', 'box', 'map'])
    expect(command.params[0].type).toBe('Array<{ kind: "a" | "b"; style?: { fill: string; "x}": number } }>')
    expect(command.params[3].type).toBe('Record<string, Array<{ at: number }>>')
  })

  it('skips /** */ comments between parameters, even ones holding ; and }', () => {
    const [command] = parseCatalogue(
      catalogue(['/** Mark. */', '"text.mark": { /** The element; see } here */ id: string; /** [start, end) */ range: Array<number>; /** How */ mode?: "add" | "remove" }']),
    )
    expect(command.params).toEqual([
      { name: 'id', optional: false, type: 'string' },
      { name: 'range', optional: false, type: 'Array<number>' },
      { name: 'mode', optional: true, type: '"add" | "remove"' },
    ])
  })

  it('reads several commands, each with its own description', () => {
    const commands = parseCatalogue(catalogue(['/** One. */', '"a.one": Record<string, never>', '/** Two. */', '"a.two": { x?: number }']))
    expect(commands.map((command) => [command.id, command.description])).toEqual([['a.one', 'One.'], ['a.two', 'Two.']])
  })

  it('refuses a file with no command interface', () => {
    expect(() => parseCatalogue('export const x = 1\n')).toThrow(/Commands extends CommandMap/)
  })
})

describe('measureVocabulary', () => {
  it('counts commands, parameterless commands and commands with a required parameter', () => {
    const measure = measureVocabulary(
      catalogue(['/** A. */', '"a.one": Record<string, never>', '/** B. */', '"a.two": { x?: number }', '/** C. */', '"a.three": { id: string; x?: number }']),
    )
    expect(measure.commands).toBe(3)
    expect(measure.noParams).toBe(1)
    expect(measure.requiredParams).toBe(1)
  })

  it('matches selection and current-state words whole and in any case', () => {
    const measure = measureVocabulary(
      catalogue([
        '/** Deletes the Selected shapes. */', '"a.one": Record<string, never>',
        '/** Moves the cursor. */', '"a.two": Record<string, never>',
        '/** Inserts at the Insertion Point. */', '"a.three": Record<string, never>',
        '/** Reselected items are unselected; the selections list. */', '"a.four": Record<string, never>',
        '/** On the current page, the active layer. */', '"a.five": Record<string, never>',
        '/** Moves the playhead and the viewport. */', '"a.six": Record<string, never>',
        '/** Concurrently and recurrently, inactive viewports. */', '"a.seven": Record<string, never>',
      ]),
    )
    expect(measure.selectionMentions).toBe(3)
    expect(measure.currentMentions).toBe(2)
  })

  it('counts verb families on the last segment of the command id only', () => {
    const measure = measureVocabulary(
      catalogue([
        '/** */', '"add.delete": Record<string, never>',
        '/** */', '"layer.addMask": Record<string, never>',
        '/** */', '"shape.insert": Record<string, never>',
        '/** */', '"style.set": Record<string, never>',
        '/** */', '"style.settings": Record<string, never>',
        '/** */', '"node.address": Record<string, never>',
        '/** */', '"node.remove_all": Record<string, never>',
      ]),
    )
    expect(measure.verbs).toEqual({ add: 1, new: 0, create: 0, insert: 1, delete: 1, remove: 1, clear: 0, set: 1, edit: 0, update: 0 })
    expect(measure.families).toEqual({ create: ['add', 'insert'], delete: ['delete', 'remove'], change: ['set'] })
  })

  it('counts target and time parameter spellings at the top level only', () => {
    const measure = measureVocabulary(
      catalogue([
        '/** */', '"a.one": { id: string; at?: Json; items: Array<{ id: string; time: number }> }',
        '/** */', '"a.two": { ids: Array<string>; start: number; end?: number }',
        '/** */', '"a.three": { id?: number; layer: string }',
      ]),
    )
    expect(measure.targets.id).toBe(2)
    expect(measure.targets.ids).toBe(1)
    expect(measure.targets.items).toBe(1)
    expect(measure.targets.layer).toBe(1)
    expect(measure.targets.shape).toBe(0)
    expect(measure.time).toMatchObject({ at: 1, start: 1, end: 1, time: 0 })
  })

  it('classifies the types of id-like parameters', () => {
    const measure = measureVocabulary(
      catalogue([
        '/** */', '"a.one": { id: string; ids: Array<string> }',
        '/** */', '"a.two": { id: number; ids?: number[] }',
        '/** */', '"a.three": { object: Json; objects: Array<Json>; clip: string | null }',
        '/** */', '"a.four": { handle: "a" | "b"; shape: number; index: number }',
      ]),
    )
    expect(measure.idTypes).toEqual({ number: 1, string: 1, Json: 1, 'number[]': 1, 'string[]': 1, 'Json[]': 1, other: 2 })
    expect(measure.idTypesByName.id).toEqual({ number: 1, string: 1 })
    expect(measure.idTypesByName.clip).toEqual({ other: 1 })
    expect(measure.idTypesByName.shape).toBeUndefined()
  })
})

describe('buildReportFromTexts', () => {
  const report = buildReportFromTexts({
    one: catalogue(['/** The selected items. */', '"item.add": { id: string }', '/** */', '"item.create": Record<string, never>', '/** */', '"item.delete": { ids?: Array<string> }']),
    two: catalogue(['/** On the current page. */', '"node.new": { node?: number }', '/** */', '"node.remove": { node?: number }', '/** */', '"node.clear": Record<string, never>']),
  })

  it('sums each measure across kits', () => {
    expect(report.totals.commands).toBe(6)
    expect(report.totals.selectionMentions).toBe(1)
    expect(report.totals.currentMentions).toBe(1)
    expect(report.totals.targets).toMatchObject({ id: 1, ids: 1, node: 2 })
  })

  it('summarises spellings, families and kits without required parameters', () => {
    expect(report.summary.distinctTargetSpellings).toBe(3)
    expect(report.summary.targetSpellingsInUse).toEqual(['id', 'ids', 'node'])
    expect(report.summary.kitsWithoutRequiredParams).toEqual(['two'])
    expect(report.summary.kitsMixingVerbs).toEqual({ create: ['one'], delete: ['two'], change: [] })
  })

  it('renders a Markdown report naming every kit', () => {
    const markdown = renderMarkdown(report)
    expect(markdown).toMatch(/^# Kit command vocabulary/)
    expect(markdown).toContain('| one |')
    expect(markdown).toContain('| two |')
  })
})

describe('the real catalogues', () => {
  it('measures all published kits from packages/script/kits', () => {
    const report = buildReport(kitsDir)
    expect(Object.keys(report.kits).sort()).toEqual([...PUBLISHED_KITS].sort())
    expect(Object.keys(report.kits)).toHaveLength(PUBLISHED_KITS.length)
    for (const measure of Object.values(report.kits)) expect(measure.commands).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('exits 0 and prints JSON with --json and Markdown by default', () => {
    const json = spawnSync(process.execPath, [tool, '--json'], { encoding: 'utf8' })
    expect(json.status).toBe(0)
    expect(Object.keys(JSON.parse(json.stdout).kits)).toHaveLength(PUBLISHED_KITS.length)
    const markdown = spawnSync(process.execPath, [tool], { encoding: 'utf8' })
    expect(markdown.status).toBe(0)
    expect(markdown.stdout).toMatch(/^# Kit command vocabulary/)
  })
})
