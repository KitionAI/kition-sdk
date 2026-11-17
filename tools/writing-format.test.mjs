import { describe, expect, it } from 'vitest'
import { guideExamples, writingFormat } from './writing-format.mjs'

const manifest = { id: 'kit.demo', name: 'Demo', version: '1.2.3', agent: { prefix: 'demo' } }
const commands = [
  {
    id: 'page.rotate',
    title: 'Rotate pages',
    description: 'Rotates pages by a multiple of 90 degrees.',
    menu: ['Pages'],
    schema: {
      degrees: { type: 'integer', required: true },
      subset: { type: 'string', enum: ['all', 'even', 'odd'], default: 'all' },
    },
    mutates: true,
  },
  { id: 'page.list', title: 'List pages', description: 'Answers the pages.', menu: ['Pages'], schema: {}, mutates: false },
  {
    id: 'theme.apply',
    title: 'Apply theme',
    description: 'Applies a theme.',
    menu: [],
    schema: { theme: { type: 'string', enum: ['light', 'dark'] }, subset: { type: 'string', enum: ['all', 'even', 'odd'] } },
    mutates: true,
  },
]
const guide = [
  '# Demo kit: a guide for models',
  '',
  '## Workflow',
  '',
  'Inspect first.',
  '',
  '## Example 1: rotate a page',
  '',
  '```json',
  'demo_run { "path": "a.demo", "steps": [{ "command": "page.rotate", "params": { "degrees": 90 } }] }',
  '```',
  '',
  '## Pitfalls',
  '',
  'None.',
  '',
].join('\n')

describe('writingFormat', () => {
  const text = writingFormat({ manifest, commands, guide, engineVersion: '1.2.0' })

  it('names the kit, the engine version it was made from, and the run syntax with the prefix', () => {
    expect(text).toMatch(/^# Demo writing format\n/)
    expect(text).toContain('engine 1.2.0')
    expect(text).toContain('`demo_run`')
    expect(text).toContain('"steps": [{ "command": "<command id>", "params": { … } }]')
  })

  it('lists every command under its menu, with required parameters, defaults and value lists', () => {
    expect(text).toContain('### Pages')
    expect(text).toContain('- `page.rotate` (writes): Rotates pages by a multiple of 90 degrees.')
    expect(text).toContain('`degrees` integer, required')
    expect(text).toContain('`subset` string, default `"all"`, one of `all` | `even` | `odd`')
    expect(text).toContain('- `page.list` (reads): Answers the pages. No parameters.')
    expect(text).toContain('### (no menu)')
    expect(text).toContain('3 commands')
  })

  it('collects each value list once, with the commands that take it', () => {
    expect(text).toContain('| `subset` | `all`, `even`, `odd` | `page.rotate`, `theme.apply` |')
    expect(text).toContain('| `theme` | `light`, `dark` | `theme.apply` |')
  })

  it('lists the parameters that state a default', () => {
    expect(text).toContain('| `page.rotate` | `subset` | `"all"` |')
  })

  it("copies the guide's examples and nothing else from it", () => {
    expect(text).toContain('### Example 1: rotate a page')
    expect(text).toContain('"degrees": 90')
    expect(text).not.toContain('Inspect first.')
    expect(text).not.toContain('## Pitfalls')
  })
})

describe('guideExamples', () => {
  it('answers an empty list for a guide without examples', () => {
    expect(guideExamples('# Guide\n\n## Workflow\n\nText.\n')).toEqual([])
  })
})
