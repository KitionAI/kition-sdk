// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitUiElement } from '@kition/kit-ui-protocol'
import { CustomizeDialog, customizeTree, type CustomizeNode } from './CustomizeDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
})

const element = (id: string, label: string, parent: string | null, hidden = false): KitUiElement => ({ id, kind: id.split(':')[0], label, parent, hidden, disabled: false })
const catalog = [
  element('menu:Filter', 'Filter', null),
  element('command:filter.blur.gaussianBlur', 'Gaussian Blur…', 'menu:Filter'),
  element('command:layer.select', 'Select Layer', null),
  element('menu:Help', 'Help', null, true),
  element('panel:layers', 'Layers', null),
]
const labels = { title: 'Customize interface', search: 'Search', restore: 'Restore defaults', cancel: 'Cancel', save: 'Save' }

describe('customizeTree', () => {
  it('leaves out host-hidden elements and commands outside menus', () => {
    expect(customizeTree(catalog, '').map((node) => [node.element.id, node.children.map((child) => child.element.id)])).toEqual([
      ['menu:Filter', ['command:filter.blur.gaussianBlur']],
      ['panel:layers', []],
    ])
  })

  it('keeps matches and the elements above them when searching', () => {
    expect(customizeTree(catalog, 'gauss').map((node) => [node.element.id, node.children.map((child) => child.element.id)])).toEqual([['menu:Filter', ['command:filter.blur.gaussianBlur']]])
  })

  it('leaves out the elements under a host-hidden parent, all the way down', () => {
    const under = [
      ...catalog,
      element('command:help.about', 'About', 'menu:Help'),
      element('tool:Brush', 'Brush', null, true),
      element('control:colors', 'Colors', 'tool:Brush'),
      element('control:swatch', 'Swatch', 'control:colors'),
    ]
    expect(customizeTree(under, '').map((node) => [node.element.id, node.children.map((child) => child.element.id)])).toEqual([
      ['menu:Filter', ['command:filter.blur.gaussianBlur']],
      ['panel:layers', []],
    ])
  })

  it('never offers More, the way back to this dialog', () => {
    const withMore = [...catalog, element('action:save', 'Save', null), element('action:more', 'More', null)]
    expect(customizeTree(withMore, '').map((node) => node.element.id)).toEqual(['menu:Filter', 'panel:layers', 'action:save'])
  })

  it('renders a self-parented element once instead of recursing forever', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const selfCycle = [element('tool:selfie', 'Selfie', 'tool:selfie')]
    expect(() => customizeTree(selfCycle, '')).not.toThrow()
    expect(customizeTree(selfCycle, '').map((node) => [node.element.id, node.children.map((child) => child.element.id)])).toEqual([['tool:selfie', []]])
    expect(warn).toHaveBeenCalledWith('[kit-editor] tool:selfie is its own ancestor in the declared elements')
    warn.mockRestore()
  })

  it('cuts a two-element loop at its back edge, keeping each element once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = [element('tool:looper-a', 'A', 'tool:looper-b'), element('tool:looper-b', 'B', 'tool:looper-a')]
    expect(() => customizeTree(loop, '')).not.toThrow()
    const tree = customizeTree(loop, '')
    expect(tree).toHaveLength(1)
    const ids: string[] = []
    const walk = (node: CustomizeNode) => {
      ids.push(node.element.id)
      node.children.forEach(walk)
    }
    tree.forEach(walk)
    expect(ids.sort()).toEqual(['tool:looper-a', 'tool:looper-b'])
    expect(warn).toHaveBeenCalledWith('[kit-editor] tool:looper-a is its own ancestor in the declared elements')
    warn.mockRestore()
  })
})

describe('CustomizeDialog', () => {
  it('saves what the person unchecks, and restores defaults', () => {
    const saved: string[][] = []
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => root.render(<CustomizeDialog catalog={catalog} personal={['panel:layers']} labels={labels} onSave={(hide) => saved.push(hide)} onClose={() => undefined} />))
    const box = (id: string) => host.querySelector(`input[data-element="${id}"]`) as HTMLInputElement
    expect(box('panel:layers').checked).toBe(false)
    act(() => box('menu:Filter').click())
    expect(box('command:filter.blur.gaussianBlur').disabled).toBe(true)
    act(() => (host.querySelector('[data-action="save"]') as HTMLButtonElement).click())
    expect(saved).toEqual([['panel:layers', 'menu:Filter']])
    act(() => (host.querySelector('[data-action="restore"]') as HTMLButtonElement).click())
    act(() => (host.querySelector('[data-action="save"]') as HTMLButtonElement).click())
    expect(saved[1]).toEqual([])
    host.remove()
  })
})
