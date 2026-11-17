import { describe, expect, it } from 'vitest'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { buildCatalog, declaredIds, defineKitUi } from './uiCatalog'

const commands = [
  { id: 'filter.blur.gaussianBlur', title: 'Gaussian Blur…', description: null, group: 'filter', mutates: true, enabled: true, menu: ['Filter', 'Blur'], shortcut: null },
  { id: 'filter.lastFilter', title: 'Last Filter', description: null, group: 'filter', mutates: true, enabled: true, menu: ['Filter'], shortcut: null },
  { id: 'layer.select', title: 'Select Layer', description: null, group: 'layer', mutates: false, enabled: true, menu: [], shortcut: null },
]
const declaration = defineKitUi({
  panels: [{ id: 'panel:layers', label: 'layers' }],
  controls: [{ id: 'control:colors', label: 'colors', parent: 'tool:Brush' }],
})
const t = (key: string) => `t(${key})`
const phrase = (english: string) => `p(${english})`

describe('the element catalog', () => {
  it('lists menus, commands, engine tools, declared elements, and document actions', () => {
    const catalog = buildCatalog({ commands, declaration, engineTools: [{ id: 'Brush', label: 'Brush' }], agent: true, t, phrase, config: { ...EMPTY_UI_CONFIG, hide: ['menu:Filter/Blur'], disable: ['action:save'] } })
    expect(catalog).toEqual([
      { id: 'menu:Filter', kind: 'menu', label: 'p(Filter)', parent: null, hidden: false, disabled: false },
      { id: 'menu:Filter/Blur', kind: 'menu', label: 'p(Blur)', parent: 'menu:Filter', hidden: true, disabled: false },
      { id: 'command:filter.blur.gaussianBlur', kind: 'command', label: 'p(Gaussian Blur…)', parent: 'menu:Filter/Blur', hidden: true, disabled: false },
      { id: 'command:filter.lastFilter', kind: 'command', label: 'p(Last Filter)', parent: 'menu:Filter', hidden: false, disabled: false },
      { id: 'command:layer.select', kind: 'command', label: 'p(Select Layer)', parent: null, hidden: false, disabled: false },
      { id: 'tool:Brush', kind: 'tool', label: 'p(Brush)', parent: null, hidden: false, disabled: false },
      { id: 'panel:layers', kind: 'panel', label: 't(layers)', parent: null, hidden: false, disabled: false },
      { id: 'control:colors', kind: 'control', label: 't(colors)', parent: 'tool:Brush', hidden: false, disabled: false },
      { id: 'action:undo', kind: 'action', label: 't(undo)', parent: null, hidden: false, disabled: false },
      { id: 'action:redo', kind: 'action', label: 't(redo)', parent: null, hidden: false, disabled: false },
      { id: 'action:agent', kind: 'action', label: 't(askAgent)', parent: null, hidden: false, disabled: false },
      { id: 'action:mode', kind: 'action', label: 't(modeMenu)', parent: null, hidden: false, disabled: false },
      { id: 'action:save', kind: 'action', label: 't(save)', parent: null, hidden: false, disabled: true },
      { id: 'action:more', kind: 'action', label: 't(more)', parent: null, hidden: false, disabled: false },
    ])
  })

  it('lists an id once when a kit declares an engine tool again', () => {
    const catalog = buildCatalog({ commands: [], declaration: defineKitUi({ tools: [{ id: 'tool:Brush', label: 'brush' }] }), engineTools: [{ id: 'Brush', label: 'Brush' }], agent: true, t, phrase, config: EMPTY_UI_CONFIG })
    expect(catalog.filter((element) => element.id === 'tool:Brush')).toHaveLength(1)
  })

  it('leaves Ask Agent out when the host has no agent', () => {
    const catalog = buildCatalog({ commands: [], declaration, engineTools: [], agent: false, t, phrase, config: EMPTY_UI_CONFIG })
    expect(catalog.map((element) => element.id)).toEqual(['panel:layers', 'control:colors', 'action:undo', 'action:redo', 'action:mode', 'action:save', 'action:more'])
  })

  it('knows the declared ids, document actions included', () => {
    expect(declaredIds(declaration)).toEqual(new Set(['panel:layers', 'control:colors', 'action:undo', 'action:redo', 'action:agent', 'action:mode', 'action:save', 'action:more']))
    expect(declaredIds(null)).toBeNull()
  })

  describe('a declared menu catalog', () => {
    const menus = [
      { path: ['Filter'], label: 'Last Filter', shortcut: 'Cmd+F', command: 'filter.lastFilter' },
      { path: ['Filter'], label: '---', shortcut: null, command: '---' },
      { path: ['Filter', 'Blur', 'More'], label: 'Lens Blur…', shortcut: null, command: 'filter.blur.more.lensBlur' },
      { path: ['Window'], label: 'Layers', shortcut: null, command: 'kit:panel.layers' },
    ]
    const withMenus = defineKitUi({ menus })

    it('lists its menus, engine rows, and kit rows before the engine-derived entries, each id once', () => {
      const catalog = buildCatalog({ commands, declaration: withMenus, engineTools: [], agent: false, t, phrase, config: { ...EMPTY_UI_CONFIG, hide: ['menu:Window'], disable: ['menu:Filter/Blur'] } })
      expect(catalog.slice(0, 7)).toEqual([
        { id: 'menu:Filter', kind: 'menu', label: 'p(Filter)', parent: null, hidden: false, disabled: false },
        { id: 'command:filter.lastFilter', kind: 'command', label: 'p(Last Filter)', parent: 'menu:Filter', hidden: false, disabled: false },
        { id: 'menu:Filter/Blur', kind: 'menu', label: 'p(Blur)', parent: 'menu:Filter', hidden: false, disabled: true },
        { id: 'menu:Filter/Blur/More', kind: 'menu', label: 'p(More)', parent: 'menu:Filter/Blur', hidden: false, disabled: true },
        { id: 'command:filter.blur.more.lensBlur', kind: 'command', label: 'p(Lens Blur…)', parent: 'menu:Filter/Blur/More', hidden: false, disabled: true },
        { id: 'menu:Window', kind: 'menu', label: 'p(Window)', parent: null, hidden: true, disabled: false },
        { id: 'control:panel.layers', kind: 'control', label: 'p(Layers)', parent: 'menu:Window', hidden: true, disabled: false },
      ])
      // The engine's own entries follow, without the ids the catalog already listed (catalog first wins).
      expect(catalog.slice(7, 9).map((element) => element.id)).toEqual(['command:filter.blur.gaussianBlur', 'command:layer.select'])
      expect(catalog.filter((element) => element.id === 'command:filter.lastFilter')).toHaveLength(1)
      expect(catalog.filter((element) => element.id === 'menu:Filter/Blur')).toHaveLength(1)
      expect(catalog.some((element) => element.id.includes('---'))).toBe(false)
    })

    it('counts its ids as declared', () => {
      const ids = declaredIds(withMenus)
      for (const id of ['menu:Filter', 'menu:Filter/Blur', 'menu:Filter/Blur/More', 'command:filter.lastFilter', 'command:filter.blur.more.lensBlur', 'menu:Window', 'control:panel.layers']) expect(ids?.has(id)).toBe(true)
      expect(ids?.has('command:kit:panel.layers')).toBe(false)
    })
  })
})
