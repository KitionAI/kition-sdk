// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'
import { UiProvider, type UiContextValue } from './uiContext'
import { TypeIcon as Type } from '@kition/tessera-icons/react'
import { OverflowStrip, RibbonButton, RibbonGroup, RibbonItem, RibbonPresentationContext, RibbonStack, overflowOf } from '@kition/tessera-ui'
import { RibbonMenu, commandGroups, commandsOfGroup } from './editor'
import { COMMAND_FALLBACK_ICON, commandIcon, toolIcon } from './toolIcons'
import type { KitCommand } from './engine/kitModule'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
})

function context(overrides: Partial<UiContextValue> = {}): UiContextValue {
  return {
    store: createUiStore(EMPTY_UI_CONFIG, null, () => undefined),
    locale: 'en-US',
    menuOf: () => [],
    declared: null,
    press: () => undefined,
    offerHide: null,
    openCustomize: null,
    hide: null,
    renderButtons: () => null,
    ...overrides,
  }
}

function render(value: UiContextValue, children: React.ReactNode) {
  const host = document.createElement('div')
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(<UiProvider value={value}>{children}</UiProvider>))
  return host
}

describe('RibbonGroup', () => {
  it('is hidden or disabled by its id, and ends with the host buttons for it', () => {
    const store = createUiStore({ ...EMPTY_UI_CONFIG, disable: ['group:insert/media'] }, null, () => undefined)
    const host = render(
      context({ store, renderButtons: (place: string) => <span data-place={place} /> }),
      <RibbonGroup id="group:insert/media" label="Media">
        <button type="button">Picture</button>
      </RibbonGroup>,
    )
    expect((host.querySelector('[data-kit-ui-id="group:insert/media"] fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect(host.querySelector('[data-place="group:insert/media"]')).not.toBeNull()
    act(() => store.replace({ ...EMPTY_UI_CONFIG, hide: ['group:insert/media'] }))
    expect(host.querySelector('[data-kit-ui-id="group:insert/media"]')).toBeNull()
  })

  it('without an id, renders its children in an enabled fieldset and never calls renderButtons', () => {
    const renderButtons = vi.fn(() => null)
    const host = render(
      context({ renderButtons }),
      <RibbonGroup label="Media">
        <button type="button">Picture</button>
      </RibbonGroup>,
    )
    expect(host.querySelector('button')?.textContent).toBe('Picture')
    expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false)
    expect(renderButtons).not.toHaveBeenCalled()
  })

  it('does not warn for an undeclared menu path id, even when declared lacks it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(
      context({ declared: new Set() }),
      <RibbonGroup id="menu:Insert/Media" label="Media">
        <button type="button">Picture</button>
      </RibbonGroup>,
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns once about an undeclared group id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(
      context({ declared: new Set() }),
      <RibbonGroup id="group:insert/other" label="Media">
        <button type="button">Picture</button>
      </RibbonGroup>,
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('group:insert/other')
    warn.mockRestore()
  })
})

const command = (id: string, title: string, menu: string[]): KitCommand => ({ id, title, description: null, group: id.split('.')[0], mutates: true, enabled: true, menu, shortcut: null })

describe('commandGroups', () => {
  it('folds a one-command group named after its command, and any "..." group, into one group named after the tab', () => {
    const groups = commandGroups(
      [
        command('insert', 'Block...', ['Insert', 'Block...']),
        command('layout.new', 'New Layout', ['Insert', 'Layout']),
        command('xref', 'External Reference…', ['Insert', 'Reference…']),
        command('image', 'Image', ['Insert', 'Image']),
        command('other', 'Elsewhere', ['Format', 'Other']),
      ],
      ['Insert'],
    )
    expect([...groups.keys()]).toEqual(['Insert', 'Layout'])
    expect(groups.get('Insert')).toEqual({ path: 'Insert', items: [expect.objectContaining({ id: 'insert' }), expect.objectContaining({ id: 'xref' }), expect.objectContaining({ id: 'image' })] })
    expect(groups.get('Layout')?.path).toBe('Insert/Layout')
    for (const label of groups.keys()) expect(label).not.toMatch(/(\.\.\.|…)$/)
  })

  it('keeps a real group, even of one command, and groups commands with no second segment under the tab', () => {
    const groups = commandGroups(
      [command('insert.table', 'Table', ['Insert', 'Tables']), command('insert.pivotTable', 'PivotTable', ['Insert', 'Tables']), command('insert.link', 'Link', ['Insert', 'Links']), command('insert.any', 'Anything', ['Insert'])],
      ['Insert'],
    )
    expect([...groups.keys()]).toEqual(['Tables', 'Links', 'Insert'])
    expect(groups.get('Insert')?.path).toBe('Insert')
  })
})

describe('commandsOfGroup', () => {
  it("takes an engine group's commands, less those a hand-made group of the same name already draws", () => {
    const commands = [
      command('insert.picture', 'Pictures', ['Insert', 'Illustrations']),
      command('insert.shape', 'Shapes', ['Insert', 'Illustrations']),
      command('insert.icons', 'Icons…', ['Insert', 'Illustrations']),
      command('insert.link', 'Link', ['Insert', 'Links']),
    ]
    expect(commandsOfGroup(commands, 'Insert/Illustrations', ['Shapes', 'Text Box']).map((c) => c.id)).toEqual(['insert.picture', 'insert.icons'])
    expect(commandsOfGroup(commands, 'Insert/Illustrations', ['icons']).map((c) => c.id)).toEqual(['insert.picture', 'insert.shape'])
    expect(commandsOfGroup(commands, 'Insert/Nothing')).toEqual([])
  })
})

describe('commandIcon', () => {
  it('reads the words of a command id and title', () => {
    expect(commandIcon({ id: 'insert.pivotTable', title: 'PivotTable' })).not.toBe(commandIcon({ id: 'insert.table', title: 'Table' }))
    expect(commandIcon({ id: 'insert.sparklines', title: 'Sparklines' })).not.toBe(commandIcon({ id: 'insert.line', title: 'Line' }))
    expect(commandIcon({ id: 'insert', title: 'Block...' })).not.toBe(COMMAND_FALLBACK_ICON)
    expect(commandIcon({ id: 'insert.headerFooter', title: 'Header & Footer' })).not.toBe(COMMAND_FALLBACK_ICON)
  })

  it('gives every command an icon, a generic one when no word matches', () => {
    expect(commandIcon({ id: 'zz.qqq', title: 'Frobnicate' })).toBe(COMMAND_FALLBACK_ICON)
    expect(commandIcon({ id: 'zz.qqq' })).toBe(COMMAND_FALLBACK_ICON)
  })
})

describe('toolIcon', () => {
  it('tells apart tools that used to share an icon', () => {
    const icons = ['tool-line', 'tool-arc', 'tool-spiral'].map((name) => toolIcon(name))
    expect(new Set(icons).size).toBe(3)
    const transforms = ['tool-scale', 'tool-shear', 'tool-reshape', 'tool-free-transform'].map((name) => toolIcon(name))
    expect(new Set(transforms).size).toBe(4)
    const dimensions = ['dimlinear', 'dimaligned', 'dimradius'].map((id) => toolIcon('tool-measure', id))
    expect(new Set(dimensions).size).toBe(3)
    expect(toolIcon('tool-measure')).toBe(toolIcon('tool-measure', 'measure'))
  })
})

describe('Ribbon overflow', () => {
  it('says which edges have more beyond them', () => {
    expect(overflowOf(0, 500, 500)).toBe('none')
    expect(overflowOf(0, 500, 800)).toBe('end')
    expect(overflowOf(300, 500, 800)).toBe('start')
    expect(overflowOf(100, 500, 800)).toBe('both')
  })

  it('shows a scroll button only on an edge with more, and scrolls the panel with it', () => {
    const widths = { scrollWidth: 800, clientWidth: 500 }
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => widths.scrollWidth)
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widths.clientWidth)
    const host = render(
      context(),
      <OverflowStrip className="kui-ribbon-body" panelClassName="kui-ribbon-panel" role="tabpanel" labels={{ start: 'Left', end: 'Right' }} testId="ribbon-scroll">
        <RibbonGroup label="Clipboard">
          <button type="button">Paste</button>
        </RibbonGroup>
      </OverflowStrip>,
    )
    expect(host.querySelector('.kui-ribbon-body')?.getAttribute('data-overflow')).toBe('end')
    expect(host.querySelector('[data-testid="ribbon-scroll-start"]')).toBeNull()
    const end = host.querySelector('[data-testid="ribbon-scroll-end"]') as HTMLButtonElement
    expect(end.getAttribute('aria-label')).toBe('Right')
    const panel = host.querySelector('.kui-ribbon-panel') as HTMLElement
    act(() => end.click())
    expect(panel.scrollLeft).toBeGreaterThan(0)
    act(() => panel.dispatchEvent(new Event('scroll')))
    expect(host.querySelector('[data-testid="ribbon-scroll-start"]')).not.toBeNull()
    scrollWidth.mockRestore()
    clientWidth.mockRestore()
  })

  it('fades an edge with an overlay, never a mask that would clip the popovers its menus open', () => {
    // kit-editor's own rules and Tessera's, which hold the ribbon's.
    const css = [join(__dirname, 'styles.css'), createRequire(import.meta.url).resolve('@kition/tessera-ui/styles.css')]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/mask(-image)?\s*:/)
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((item) => item.trim()), body }))
    for (const edge of ['::before', '::after']) {
      const fade = rules.filter((rule) => rule.selectors.includes(`.kui-overflow-strip${edge}`))
      expect(fade.some((rule) => /pointer-events:\s*none/.test(rule.body))).toBe(true)
    }
  })
})

describe('Single line groups', () => {
  const line = (node: React.ReactNode, value = context()) => render(value, <RibbonPresentationContext.Provider value="line">{node}</RibbonPresentationContext.Provider>)
  const labels = (scope: Element | null) => [...(scope?.querySelectorAll('button[aria-label]') ?? [])].map((button) => button.getAttribute('aria-label'))

  it('shows the primary items inline, large ones small, and the whole group in its popover', () => {
    const host = line(
      <RibbonGroup label="Clipboard">
        <RibbonButton label="Paste" size="large" primary />
        <RibbonStack>
          <RibbonButton label="Cut" />
          <RibbonButton label="Copy" />
        </RibbonStack>
      </RibbonGroup>,
    )
    const inline = host.querySelector('.kui-line-inline')
    expect(labels(inline)).toEqual(['Paste'])
    expect(inline?.querySelector('button')?.getAttribute('data-size')).toBe('small')
    act(() => (host.querySelector('[data-testid="kui-line-more-Clipboard"]') as HTMLButtonElement).click())
    const popover = host.querySelector('[data-testid="kui-line-popover-Clipboard"]')
    expect(labels(popover)).toEqual(['Paste', 'Cut', 'Copy'])
    expect(popover?.querySelector('button')?.getAttribute('data-size')).toBe('large')
  })

  it('draws a group without primary items as one labeled button that opens it', () => {
    const host = line(
      <RibbonGroup label="Font" icon={Type}>
        <RibbonButton label="Bold" />
        <RibbonItem>
          <select aria-label="Size" />
        </RibbonItem>
      </RibbonGroup>,
    )
    const collapsed = host.querySelector('[data-testid="kui-line-group-Font"]') as HTMLButtonElement
    expect(collapsed.textContent).toContain('Font')
    expect((host.querySelector('.kui-line-inline') as HTMLElement).hidden).toBe(true)
    act(() => collapsed.click())
    const popover = host.querySelector('[data-testid="kui-line-popover-Font"]')
    expect(popover?.querySelector('[aria-label="Bold"]')).not.toBeNull()
    expect(popover?.querySelector('select[aria-label="Size"]')).not.toBeNull()
  })

  it('shows a primary RibbonItem inline', () => {
    const host = line(
      <RibbonGroup label="Font">
        <RibbonItem primary>
          <select aria-label="Font name" />
        </RibbonItem>
        <RibbonButton label="Bold" />
      </RibbonGroup>,
    )
    expect(host.querySelector('.kui-line-inline select[aria-label="Font name"]')).not.toBeNull()
    expect(host.querySelector('.kui-line-inline [aria-label="Bold"]')).toBeNull()
  })

  it('draws a primary item with an icon as the icon alone, named by its label, unless it keeps its label', () => {
    const host = line(
      <RibbonGroup label="Font">
        <RibbonButton label="Bold" icon={Type} primary />
        <RibbonButton label="Styles" icon={Type} size="large" lineLabel primary />
        <RibbonButton label="Plain" size="large" primary />
        <RibbonMenu icon={Type} label="Color" primary testId="color">
          <span />
        </RibbonMenu>
      </RibbonGroup>,
    )
    const inline = [...host.querySelectorAll('.kui-line-inline button')]
    expect(inline.map((button) => [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-size'), button.textContent])).toEqual([
      ['Bold', 'Bold', 'icon', ''],
      ['Styles', 'Styles', 'small', 'Styles'],
      ['Plain', 'Plain', 'small', 'Plain'],
      ['Color', 'Color', 'icon', ''],
    ])
  })

  it('keeps labels and sizes in the Classic ribbon whatever lineLabel says', () => {
    const host = render(context(), <RibbonButton label="Bold" icon={Type} size="large" lineLabel primary />)
    expect(host.querySelector('button')?.getAttribute('data-size')).toBe('large')
    expect(host.querySelector('button')?.textContent).toBe('Bold')
  })

  it('mounts each item once, inline or in the open popover, and keeps raw fields out of the row', () => {
    const host = line(
      <RibbonGroup label="Font" icon={Type}>
        <RibbonButton label="Bold" data-testid="bold" primary />
        <div className="kui-command-grid">
          <RibbonButton label="Italic" data-testid="italic" primary />
          <select data-testid="size" aria-label="Size" />
        </div>
        <select data-testid="name" aria-label="Font name" />
        <RibbonButton label="Underline" data-testid="underline" />
      </RibbonGroup>,
    )
    const ids = () => [...host.querySelectorAll<HTMLElement>('[data-testid]')].map((element) => element.dataset.testid)
    const repeated = () => ids().filter((id, index, all) => all.indexOf(id) !== index)
    expect(labels(host.querySelector('.kui-line-inline'))).toEqual(['Bold', 'Italic'])
    expect(host.querySelector('.kui-line-inline select')).toBeNull()
    expect(repeated()).toEqual([])
    const more = host.querySelector('[data-testid="kui-line-more-Font"]') as HTMLButtonElement
    expect(more.getAttribute('aria-label')).toBe('More: Font')
    expect(more.getAttribute('aria-haspopup')).toBe('dialog')
    act(() => more.click())
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const popover = host.querySelector('[data-testid="kui-line-popover-Font"]')
    expect(labels(popover)).toEqual(['Bold', 'Italic', 'Underline'])
    expect([...(popover?.querySelectorAll('select') ?? [])].map((select) => select.dataset.testid)).toEqual(['size', 'name'])
    expect(repeated()).toEqual([])
    expect(host.querySelector('.kui-line-inline button')).toBeNull()
    act(() => more.click())
    expect(labels(host.querySelector('.kui-line-inline'))).toEqual(['Bold', 'Italic'])
  })

  it("draws the host's buttons for a group only in its popover", () => {
    const host = line(
      <RibbonGroup id="group:home/clipboard" label="Clipboard">
        <RibbonButton label="Paste" primary />
      </RibbonGroup>,
      context({ renderButtons: (place: string) => <span data-place={place} /> }),
    )
    expect(host.querySelector('.kui-line-inline [data-place]')).toBeNull()
    act(() => (host.querySelector('[data-testid="kui-line-more-group:home/clipboard"]') as HTMLButtonElement).click())
    expect(host.querySelector('[data-testid="kui-line-popover-group:home/clipboard"] [data-place="group:home/clipboard"]')).not.toBeNull()
  })

  it('leaves the Classic ribbon as it was: every item, large buttons large', () => {
    const host = render(
      context(),
      <RibbonGroup label="Clipboard">
        <RibbonButton label="Paste" size="large" primary />
        <RibbonButton label="Cut" />
      </RibbonGroup>,
    )
    expect([...host.querySelectorAll('button')].map((button) => [button.getAttribute('aria-label'), button.getAttribute('data-size')])).toEqual([
      ['Paste', 'large'],
      ['Cut', 'small'],
    ])
  })
})
