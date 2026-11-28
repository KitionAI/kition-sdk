// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandDialog, type CommandDialogOptions } from './CommandDialog'
import type { KitCommand } from './engine/kitModule'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

const SCHEMA = {
  rows: { type: 'array', items: { type: 'integer' } },
  at: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
  sides: { type: 'array', items: { type: 'string', enum: ['top', 'bottom', 'left'] } },
  range: { type: 'object', properties: { start: { type: 'string' }, whole: { type: 'boolean' } } },
  data: { type: 'array', items: { type: 'object' } },
  name: { type: 'string', required: true },
}
const COMMAND = { id: 'grid.mark', title: 'Mark', description: null, group: '', mutates: true, enabled: true, menu: [], shortcut: null, schema: SCHEMA } as unknown as KitCommand

function open(options: CommandDialogOptions, values: Record<string, unknown> = {}) {
  const onRun = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<CommandDialog command={COMMAND} values={values} onRun={onRun} onClose={() => undefined} labels={{ run: 'Run', cancel: 'Cancel', required: 'Required', add: 'Add', remove: 'Remove' }} {...options} />))
  return onRun
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement

function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const click = (element: Element) => act(() => void element.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('the parameters dialog (Stage S of sheet usable by hand)', () => {
  it('shows a list or an object as one JSON text box, under the schema names, by default', () => {
    const onRun = open({}, { rows: [1, 2], name: 'a' })
    expect(byId('param-rows').value).toBe('[1,2]')
    expect(byId('param-range').type).toBe('text')
    expect(document.querySelector('label[for="param-rows"]')?.textContent).toBe('rows')
    click(byTestId('command-dialog-run'))
    expect(onRun).toHaveBeenCalledWith({ rows: [1, 2], name: 'a' })
  })

  it('names the fields and choices as the kit says', () => {
    open({ label: (param) => ({ name: 'Name', 'range.start': 'From' })[param], choice: (_, value) => (value === 'top' ? 'Top edge' : null), structured: true })
    expect(document.querySelector('label[for="param-name"]')?.textContent).toContain('Name')
    expect(document.querySelector('label[for="param-range-start"]')?.textContent).toBe('From')
    expect(document.querySelector('label[for="param-range-whole"]')?.textContent).toBe('whole')
    expect(byId('param-sides-top').parentElement?.textContent).toBe('Top edge')
    expect(byId('param-sides-left').parentElement?.textContent).toBe('left')
  })

  it('gives lists, named numbers, choices and objects fields of their own when structured', () => {
    const onRun = open({ structured: true }, { rows: [3] })
    expect(byId('param-rows-0').value).toBe('3')
    click(byTestId('param-rows-add'))
    type(byId('param-rows-1'), '7')
    click(byTestId('param-rows-add'))
    click(byTestId('param-rows-remove-0'))
    expect(byId('param-rows-0').value).toBe('7')
    type(byId('param-at-x'), '10')
    click(byId('param-sides-bottom'))
    type(byId('param-range-start'), 'B2')
    type(byId('param-data'), '[{"a":1}]')
    // The name is required: Run waits for it.
    expect((byTestId('command-dialog-run') as HTMLButtonElement).disabled).toBe(true)
    type(byId('param-name'), 'n')
    click(byTestId('command-dialog-run'))
    expect(onRun).toHaveBeenCalledWith({ rows: [7], at: [10, 0], sides: ['bottom'], range: { start: 'B2', whole: false }, data: [{ a: 1 }], name: 'n' })
  })
})
