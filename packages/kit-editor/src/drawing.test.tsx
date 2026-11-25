// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrawingFormatGroup, DrawingInsertGroup } from './drawing'
import { KitEditorProvider, createKitStrings, type KitEditor } from './editor'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  document.body.innerHTML = ''
})

function fakeEditor(locale = 'en-US', enabled: (id: string) => boolean = () => true) {
  const ui = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)
  return {
    session: { doc: { info: { canUndo: false, canRedo: false, dirty: false, revision: 1 } }, dirty: false, saving: false, editedBy: null },
    host: { ui, init: { locale, capabilities: [], document: { path: 'a' } }, declaration: {}, peer: { handle() {} }, openAgent: vi.fn() },
    commands: [],
    byId: new Map(),
    enabled,
    run: vi.fn(async () => null),
    ask: vi.fn(),
    query: vi.fn(),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: createKitStrings({}, locale),
    phrase: (english: string) => english,
    testId: 'k',
  } as unknown as KitEditor
}

function render(editor: KitEditor, node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<KitEditorProvider editor={editor}>{node}</KitEditorProvider>))
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (element: Element | null) => act(() => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('drawing controls', () => {
  it('insert shapes and text boxes through drawing.insert', () => {
    const editor = fakeEditor()
    render(editor, <DrawingInsertGroup testId="d" />)
    click(byTestId('d-shapes'))
    click(byTestId('d-shape-ellipse'))
    expect(editor.run).toHaveBeenCalledWith('drawing.insert', { geometry: { preset: 'ellipse' } })
    click(byTestId('d-text-box'))
    expect(editor.run).toHaveBeenCalledWith('drawing.insert', { kind: 'textBox', text: '' })
  })

  it('arm a shape for the next drag where the kit draws shapes with the pointer', () => {
    const editor = fakeEditor()
    ;(editor as unknown as { byId: Map<string, unknown> }).byId = new Map([['ink.shape', { id: 'ink.shape' }]])
    render(editor, <DrawingInsertGroup testId="d" />)
    click(byTestId('d-shapes'))
    click(byTestId('d-shape-line'))
    expect(editor.run).toHaveBeenLastCalledWith('ink.shape', { preset: 'line' })
    expect(editor.run).not.toHaveBeenCalledWith('drawing.insert', expect.anything())
  })

  it('format the selected objects through drawing.format, drawing.transform and drawing.delete', () => {
    const editor = fakeEditor()
    render(editor, <DrawingFormatGroup ids={['7']} testId="d" />)
    click(byTestId('d-fill'))
    click(document.querySelector('[data-testid="d-fill-colors"] button'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], fill: { color: expect.stringMatching(/^#/) } })
    click(byTestId('d-outline'))
    click(byTestId('d-weight-3'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], stroke: { width: 3 } })
    click(byTestId('d-outline'))
    click(byTestId('d-no-outline'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], stroke: { none: true } })
    click(byTestId('d-rotate'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.transform', { ids: ['7'], rotateBy: 90 })
    click(byTestId('d-delete'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.delete', { ids: ['7'] })
  })

  it('move the selected objects in the stack through drawing.arrange, where the kit has it', () => {
    const editor = fakeEditor()
    render(editor, <DrawingFormatGroup ids={['7', '9']} testId="d" />)
    for (const [menu, item, order] of [['bring', 'bring-forward', 'forward'], ['bring', 'bring-front', 'front'], ['send', 'send-backward', 'backward'], ['send', 'send-back', 'back']]) {
      click(byTestId(`d-${menu}`))
      click(byTestId(`d-${item}`))
      expect(editor.run).toHaveBeenLastCalledWith('drawing.arrange', { ids: ['7', '9'], order })
    }
    document.body.innerHTML = ''
    const without = fakeEditor('en-US', (id) => id !== 'drawing.arrange')
    render(without, <DrawingFormatGroup ids={['7']} testId="w" />)
    expect((byTestId('w-bring') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('w-rotate') as HTMLButtonElement).disabled).toBe(false)
  })

  it('group two or more objects and ungroup a group', async () => {
    const editor = fakeEditor()
    ;(editor.query as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ objects: [{ kind: 'group' }] }))
    render(editor, <DrawingFormatGroup ids={['7', '9']} testId="d" />)
    await act(async () => {})
    click(byTestId('d-group'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.group', { ids: ['7', '9'] })
    click(byTestId('d-connect'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.connect', { from: '7', to: '9' })
    click(byTestId('d-ungroup'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.ungroup', { ids: ['7', '9'] })
    document.body.innerHTML = ''
    const one = fakeEditor()
    ;(one.query as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ objects: [{ kind: 'shape' }] }))
    render(one, <DrawingFormatGroup ids={['7']} testId="o" />)
    await act(async () => {})
    expect((byTestId('o-group') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('o-ungroup') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('o-connect') as HTMLButtonElement).disabled).toBe(true)
  })

  it("fill with a gradient of the shape's own colour", async () => {
    const editor = fakeEditor()
    ;(editor.query as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ objects: [{ kind: 'shape', fill: { color: { rgb: '#204080' } } }] }))
    render(editor, <DrawingFormatGroup ids={['7']} testId="d" />)
    await act(async () => {})
    click(byTestId('d-fill'))
    click(byTestId('d-gradient-down'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', {
      ids: ['7'],
      fill: { gradient: { stops: [{ pos: 0, color: '#204080' }, { pos: 1, color: '#C7CFDF' }], angle: 90 } },
    })
    click(byTestId('d-fill'))
    click(byTestId('d-gradient-center'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', {
      ids: ['7'],
      fill: { gradient: { stops: [{ pos: 0, color: '#C7CFDF' }, { pos: 1, color: '#204080' }], angle: 0, path: 'circle' } },
    })
  })

  it('cast a shadow and a glow, and leave effects to kits that draw them', async () => {
    const editor = fakeEditor()
    ;(editor.query as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ objects: [{ kind: 'shape', fill: { color: { rgb: '#204080' } } }] }))
    render(editor, <DrawingFormatGroup ids={['7']} testId="d" />)
    await act(async () => {})
    click(byTestId('d-effects'))
    click(byTestId('d-shadow-bottomRight'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], effects: { shadow: { color: { rgb: '#000000', alpha: 0.4 }, blur: 4, distance: 3, angle: 45 } } })
    click(byTestId('d-effects'))
    click(byTestId('d-glow'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], effects: { glow: { color: { rgb: '#204080', alpha: 0.6 }, size: 5 } } })
    click(byTestId('d-effects'))
    click(byTestId('d-no-shadow'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.format', { ids: ['7'], effects: { shadow: null } })
    document.body.innerHTML = ''
    render(fakeEditor(), <DrawingFormatGroup ids={['7']} testId="s" effects={false} />)
    expect(byTestId('s-effects')).toBeNull()
  })

  it("bend each selected object's text with an art text transform, and take it off", () => {
    const editor = fakeEditor()
    render(editor, <DrawingFormatGroup ids={['7', '9']} testId="d" />)
    click(byTestId('d-transform'))
    click(byTestId('d-warp-textArchUp'))
    expect(editor.run).toHaveBeenCalledWith('drawing.text', { id: '7', warp: 'textArchUp' })
    expect(editor.run).toHaveBeenLastCalledWith('drawing.text', { id: '9', warp: 'textArchUp' })
    click(byTestId('d-transform'))
    click(byTestId('d-no-warp'))
    expect(editor.run).toHaveBeenLastCalledWith('drawing.text', { id: '9', warp: null })
    document.body.innerHTML = ''
    render(fakeEditor('en-US', (id) => id !== 'drawing.text'), <DrawingFormatGroup ids={['7']} testId="o" />)
    expect((byTestId('o-transform') as HTMLButtonElement).disabled).toBe(true)
  })

  it('is disabled without a selection or where the commands are not allowed, and speaks the locale', () => {
    const editor = fakeEditor('zh-CN', (id) => id !== 'drawing.insert')
    render(editor, <><DrawingInsertGroup testId="i" /><DrawingFormatGroup ids={[]} testId="f" /></>)
    expect((byTestId('i-text-box') as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId('f-rotate') as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).toContain('文本框')
  })
})
