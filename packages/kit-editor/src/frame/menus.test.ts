import { describe, expect, it } from 'vitest'
import type { KitCommand } from '../engine/kitModule'
import type { MenuRow } from '../uiCatalog'
import { catalogTabs, commandMenuTabs, tabUiId } from './menus'

const row = (path: string[], label: string, command: string): MenuRow => ({ path, label, command, shortcut: null })
const command = (id: string, menu: string[]): KitCommand => ({ id, title: id, description: null, group: '', mutates: true, enabled: true, menu, shortcut: null })

describe('menu tabs', () => {
  it('makes one tab per top-level menu of a catalog, in catalog order, with its rows and handlers', () => {
    const catalog = [row(['File'], 'Open…', 'file.open'), row(['View'], 'Zoom In', 'view.zoomIn'), row(['File', 'Export'], 'PNG', 'file.export.png')]
    const onKitCommand = () => undefined
    const tabs = catalogTabs(catalog, { phrase: (english) => `p(${english})`, view: ['View'], onKitCommand })
    expect(tabs.map((tab) => [tab.id, tab.label, tab.view])).toEqual([
      ['File', 'p(File)', false],
      ['View', 'p(View)', true],
    ])
    expect(tabs[0].menu?.rows.map((item) => item.command)).toEqual(['file.open', 'file.export.png'])
    expect(tabs[0].menu?.onKitCommand).toBe(onKitCommand)
    // The same catalog splits into the same row lists, so the frame builds each menu once.
    expect(catalogTabs(catalog)[0].menu?.rows).toBe(tabs[0].menu?.rows)
  })

  it("makes tabs of the engine's menus: direct commands, a separator, then submenus; without excluded commands", () => {
    const commands = [command('help.about', ['Help']), command('file.export.png', ['File', 'Export']), command('file.open', ['File']), command('file.close', ['File'])]
    const templates = { label: 'Templates…', onSelect: () => undefined }
    const tabs = commandMenuTabs(commands, { order: ['File', 'Help'], exclude: ['file.close'], before: { File: [templates] } })
    expect(tabs.map((tab) => tab.id)).toEqual(['File', 'Help'])
    expect(tabs[0].menu?.rows.map((item) => [item.path.join('/'), item.command])).toEqual([
      ['File', 'file.open'],
      ['File', '---'],
      ['File/Export', 'file.export.png'],
    ])
    expect(tabs[0].menu?.before).toEqual([templates])
    // The same commands, order, and exclusions build the same row lists, as a catalog does.
    expect(commandMenuTabs(commands, { order: ['File', 'Help'], exclude: ['file.close'] })[0].menu?.rows).toBe(tabs[0].menu?.rows)
  })

  it('names a menu tab by its menu id and a ribbon tab by its tab id', () => {
    expect(tabUiId({ id: 'File', menu: { rows: [] } })).toBe('menu:File')
    expect(tabUiId({ id: 'home' })).toBe('tab:home')
  })
})
