// @vitest-environment jsdom
// Stage S of "slide usable by hand": a mouse wheel's notch zooms a step (not e, 2.72 times), and a
// kit can give its own steps; a right-click reaches the tool in document pixels (on a Mac, Ctrl and
// a click too), and the engine's tool as a secondary press and release before the kit's menu; the
// editing keys reach a tool that takes them with nothing selected, Cmd and Ctrl apart; an input
// method's composition reaches the tool, and the hidden text field sits on the tool's caret; a
// tool can be chosen locked; an answer can say no pixel changed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas, WHEEL_NOTCH_ZOOM, defaultWheelZoom, wheelNotches } from './KitCanvas'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import type { KitEngine } from './kitEngine'
import type { KitPointer, KitTool, KitToolContext } from './kitTools'
import { NOTHING } from './owedDamage'
import { toolDamage, type KitChange } from './useKitDocument'
import { TextSink } from '../TextSink'
import { bindableShortcut, commandForShortcut, commandShortcuts } from './kitShortcuts'
import { kitModuleCommands, type KitCommand } from './kitModule'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
    }
  }
  globalThis.PointerEvent = FakePointerEvent as unknown as typeof PointerEvent
}
if (typeof WheelEvent === 'undefined') globalThis.WheelEvent = class extends MouseEvent {} as unknown as typeof WheelEvent

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('a mouse wheel zooms in steps (Stage S of slide usable by hand)', () => {
  it('counts the notches of a mouse wheel and none for a trackpad', () => {
    expect(wheelNotches({ deltaMode: 0, deltaY: -100 })).toBe(1)
    expect(wheelNotches({ deltaMode: 0, deltaY: 300 })).toBe(3)
    expect(wheelNotches({ deltaMode: 0, deltaY: 2000 })).toBe(5)
    expect(wheelNotches({ deltaMode: 1, deltaY: -3 })).toBe(1)
    expect(wheelNotches({ deltaMode: 2, deltaY: 1 })).toBe(1)
    // A pinch and a trackpad's fine scroll are no notches.
    expect(wheelNotches({ deltaMode: 0, deltaY: -4.5 })).toBe(0)
    expect(wheelNotches({ deltaMode: 0, deltaY: 37 })).toBe(0)
    expect(wheelNotches({ deltaMode: 0, deltaY: 0 })).toBe(0)
  })

  it('zooms a step a notch, continuously for a pinch', () => {
    expect(defaultWheelZoom(1, { notches: 1, direction: 1, deltaY: -100 })).toBeCloseTo(WHEEL_NOTCH_ZOOM)
    expect(defaultWheelZoom(1, { notches: 3, direction: 1, deltaY: -300 })).toBeCloseTo(WHEEL_NOTCH_ZOOM ** 3)
    expect(defaultWheelZoom(1.2, { notches: 1, direction: -1, deltaY: 100 })).toBeCloseTo(1)
    expect(WHEEL_NOTCH_ZOOM).toBeLessThan(1.3)
    expect(defaultWheelZoom(1, { notches: 0, direction: 1, deltaY: -10 })).toBeCloseTo(Math.exp(0.1))
  })
})

describe('the canvas (Stage S of slide usable by hand)', () => {
  let host: HTMLDivElement
  let root: Root | null = null
  let platform: PropertyDescriptor | undefined
  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    for (const [name, value] of [['clientWidth', 800], ['clientHeight', 400]] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return this.classList.contains('kui-canvas-surface') ? value : 0 } })
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    Object.assign(HTMLElement.prototype, { setPointerCapture: () => undefined, releasePointerCapture: () => undefined, hasPointerCapture: () => false })
    platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  })
  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = null
    host?.remove()
    FakeResizeObserver.instances = []
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
    if (platform) Object.defineProperty(navigator, 'platform', platform)
    else delete (navigator as unknown as Record<string, unknown>).platform
    vi.restoreAllMocks()
  })
  const onMac = (mac: boolean) => Object.defineProperty(navigator, 'platform', { configurable: true, value: mac ? 'MacIntel' : 'Linux x86_64' })

  const doc = { width: 400, height: 200, render: async () => new Uint8Array(0), renderArea: async () => new Uint8Array(0), onFonts: () => () => undefined } as unknown as KitEngine
  function mount(tool: KitTool, props: Partial<Parameters<typeof KitCanvas>[0]> = {}, around?: (canvas: React.ReactNode) => React.ReactNode) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const canvas = <KitCanvas doc={doc} change={{ revision: 0, damage: null }} tool={tool} onView={() => undefined} viewMemory={{ current: { x: 0, y: 0, zoom: 1 } }} {...props} />
    act(() => root!.render(around ? around(canvas) : canvas))
    act(() => FakeResizeObserver.instances.at(-1)!.callback())
    return host.querySelector('.kui-canvas-surface') as HTMLCanvasElement
  }
  const plain: KitTool = { id: 't', cursor: 'default', begin: () => undefined }

  it('zooms one step for a notch of the wheel with Cmd, or the step the kit gives', () => {
    let zoom = 0
    const views: number[] = []
    const surface = mount(plain, { onView: (view) => views.push(view.zoom) })
    const wheel = () => act(() => { surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true, clientX: 10, clientY: 10 })) })
    wheel()
    expect(views.at(-1)).toBeCloseTo(WHEEL_NOTCH_ZOOM)
    act(() => root!.unmount())
    root = null
    host.remove()
    FakeResizeObserver.instances = []
    const asked: Array<{ zoom: number; notches: number; direction: number }> = []
    const own = mount(plain, { onView: (view) => { zoom = view.zoom }, wheelZoom: (from, wheel) => (asked.push({ zoom: from, notches: wheel.notches, direction: wheel.direction }), 1.5) })
    act(() => { own.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, metaKey: true, clientX: 10, clientY: 10 })) })
    expect(asked).toEqual([{ zoom: 1, notches: 1, direction: 1 }])
    expect(zoom).toBeCloseTo(1.5)
  })

  it("gives a right-click to the tool's contextMenu in document pixels; without one nothing happens", () => {
    const menus: KitPointer[] = []
    const begun: KitPointer[] = []
    const tool: KitTool = { id: 't', cursor: 'default', begin: (at) => void begun.push(at), contextMenu: (at: KitPointer, context: KitToolContext) => void (context.viewport && menus.push(at)) }
    onMac(false)
    const surface = mount(tool)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40, button: 2 })
    act(() => { surface.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(menus).toHaveLength(1)
    expect([menus[0].x, menus[0].y, menus[0].clientX, menus[0].clientY]).toEqual([30, 40, 30, 40])
    // A right press reaches no begin.
    act(() => { surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, clientX: 30, clientY: 40 })) })
    expect(begun).toEqual([])
    // Off a Mac, Ctrl and a click is a press with Ctrl.
    act(() => { surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true, clientX: 30, clientY: 40 })) })
    expect(begun).toHaveLength(1)
    act(() => { surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 30, clientY: 40 })) })
  })

  it('makes a Ctrl and a click on a Mac no press of a tool with a context menu, and leaves a tool without one its press', () => {
    onMac(true)
    const begun: string[] = []
    const surface = mount({ id: 't', cursor: 'default', begin: () => void begun.push('menu tool'), contextMenu: () => undefined })
    act(() => { surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true, clientX: 5, clientY: 5 })) })
    expect(begun).toEqual([])
    act(() => root!.unmount())
    root = null
    host.remove()
    FakeResizeObserver.instances = []
    const other = mount({ id: 'u', cursor: 'default', begin: () => void begun.push('plain tool') })
    act(() => { other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: true, clientX: 5, clientY: 5 })) })
    expect(begun).toEqual(['plain tool'])
  })

  it("keeps the editor's text field on the tool's caret as the view moves", () => {
    const surface = mount(plain, { caret: { x: 50, y: 20, height: 10 } }, (canvas) => (
      <div className="kui-app">
        {canvas}
        <TextSink active={false} onText={() => undefined} onKey={() => false} />
      </div>
    ))
    const field = host.querySelector('textarea.kui-text-sink') as HTMLTextAreaElement
    expect(surface).not.toBeNull()
    expect([field.style.left, field.style.top, field.style.height]).toEqual(['50px', '20px', '10px'])
    expect(field.style.lineHeight).toBe('10px')
    act(() => { surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 10, deltaY: 0 })) })
    expect(field.style.left).toBe('40px')
  })

  it('redraws its decoration each time redrawOn tells', async () => {
    const { RasterViewport } = await import('./rasterViewport')
    const draw = vi.spyOn(RasterViewport.prototype, 'draw')
    const listeners = new Set<() => void>()
    mount(plain, { redrawOn: { subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) } })
    const before = draw.mock.calls.length
    act(() => listeners.forEach((listener) => listener()))
    expect(draw.mock.calls.length).toBe(before + 1)
    act(() => root!.unmount())
    root = null
    expect(listeners.size).toBe(0)
  })
})

describe('the engine tools (Stage S of slide usable by hand)', () => {
  const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
  const at: KitPointer = { x: 10, y: 20, clientX: 110, clientY: 120, canvasX: 10, canvasY: 20, pressure: 1, shift: false, alt: false, meta: false, ctrl: false }
  const context = { viewport: { view: { zoom: 2 } } } as unknown as KitToolContext

  async function mount(options: Partial<Parameters<typeof useEngineTools>[3]> = {}, answer: (name: string, args: unknown[]) => EngineToolResponse | null = () => idle) {
    let current!: ReturnType<typeof useEngineTools>
    const calls: Array<{ name: string; args: unknown[]; settled: boolean }> = []
    const tool = (async (name: string, args: unknown[] = [], settled = false) => {
      if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0 }]
      calls.push({ name, args, settled })
      return answer(name, args)
    }) as Parameters<typeof useEngineTools>[0]
    const change: KitChange = { revision: 0, damage: null }
    function Probe() {
      current = useEngineTools(tool, true, change, { initial: 'select', ...options })
      return null
    }
    const root = createRoot(document.createElement('div'))
    cleanups.push(() => act(() => root.unmount()))
    await act(async () => root.render(<Probe />))
    calls.length = 0
    return { get tools() { return current }, calls }
  }
  const key = (name: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({ key: name, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods })

  it('gives a right-click to the engine as a secondary press and release, then opens the kit menu with the answer', async () => {
    const menus: Array<{ at: KitPointer; answer: EngineToolResponse | null }> = []
    const answered: EngineToolResponse = { ...idle, cursor: 'move' }
    const kit = await mount({ onContextMenu: (where, answer) => void menus.push({ at: where, answer }) }, (name, args) => (name === 'pointer' && JSON.parse(String(args[0])).action === 'up' ? answered : idle))
    expect(kit.tools.canvasTool.contextMenu).toBeTypeOf('function')
    await act(async () => kit.tools.canvasTool.contextMenu!(at, context))
    const events = kit.calls.filter((call) => call.name === 'pointer').map((call) => [JSON.parse(String(call.args[0])), call.settled])
    expect(events).toEqual([
      [{ action: 'down', x: 10, y: 20, mods: { shift: false, alt: false, command: false, control: false, space: false }, pressure: 1, zoom: 2, button: 'secondary', clicks: 1 }, false],
      [{ action: 'up', x: 10, y: 20, mods: { shift: false, alt: false, command: false, control: false, space: false }, pressure: 1, zoom: 2, button: 'secondary' }, true],
    ])
    expect(menus).toEqual([{ at, answer: answered }])
    // A kit that opens no context menu from the canvas gives the engine no right-click.
    const other = await mount()
    expect(other.tools.canvasTool.contextMenu).toBeUndefined()
  })

  it("gives the editing keys to a tool that takes them with nothing selected, not Escape, with Ctrl apart from Cmd", async () => {
    const kit = await mount({}, () => ({ ...idle, takesKeys: true }))
    await act(async () => kit.tools.refresh())
    kit.calls.length = 0
    let taken = false
    await act(async () => { taken = kit.tools.keyDown(key('ArrowDown')) })
    expect(taken).toBe(true)
    await act(async () => { taken = kit.tools.keyDown(key('Home')) })
    expect(taken).toBe(true)
    await act(async () => { taken = kit.tools.keyDown(key('Escape')) })
    expect(taken).toBe(false)
    await act(async () => { kit.tools.keyDown(key('ArrowRight', { ctrlKey: true })) })
    await act(async () => { kit.tools.keyDown(key('ArrowLeft', { metaKey: true })) })
    expect(kit.calls.map((call) => [call.args[0], JSON.parse(String(call.args[1]))])).toEqual([
      ['ArrowDown', { shift: false, alt: false, command: false, control: false, space: false }],
      ['Home', { shift: false, alt: false, command: false, control: false, space: false }],
      ['ArrowRight', { shift: false, alt: false, command: true, control: true, space: false }],
      ['ArrowLeft', { shift: false, alt: false, command: true, control: false, space: false }],
    ])
    // A tool that takes none leaves them to the frame.
    const plainKit = await mount()
    await act(async () => plainKit.tools.refresh())
    await act(async () => { taken = plainKit.tools.keyDown(key('ArrowDown')) })
    expect(taken).toBe(false)
  })

  it("sends an input method's composition to the tool, the newest one waiting, and shows the caret while it takes text", async () => {
    const caret = { x: 5, y: 6, height: 12 }
    const kit = await mount({}, () => ({ ...idle, wantsText: true, caret }))
    await act(async () => kit.tools.refresh())
    kit.calls.length = 0
    await act(async () => {
      kit.tools.compose('n', 1)
      kit.tools.compose('ni', 2)
      kit.tools.compose('', 0)
      kit.tools.typeText('你')
    })
    const sent = kit.calls.map((call) => [call.name, call.args.slice(0, 2)])
    expect(sent.at(-1)).toEqual(['toolText', ['你', 1]])
    expect(sent.filter(([name]) => name === 'toolPreedit').at(-1)).toEqual(['toolPreedit', ['', 0]])
    expect(sent.findIndex(([name]) => name === 'toolPreedit')).toBeLessThan(sent.findIndex(([name]) => name === 'toolText'))
    expect(kit.tools.caret).toEqual(caret)
    // No caret while the tool takes no text.
    const idleKit = await mount({}, () => ({ ...idle, caret }))
    await act(async () => idleKit.tools.refresh())
    expect(idleKit.tools.caret).toBeNull()
  })

  it('chooses a tool locked, and says whether the engine keeps it locked', async () => {
    let locked = false
    const kit = await mount({}, (name, args) => {
      if (name === 'selectTool') locked = args[2] === true
      return { ...idle, toolLocked: locked }
    })
    await act(async () => kit.tools.select('select', { locked: true }))
    expect(kit.calls.filter((call) => call.name === 'selectTool').map((call) => call.args)).toEqual([['select', 1, true]])
    expect(kit.tools.locked).toBe(true)
    await act(async () => kit.tools.select('select'))
    expect(kit.calls.filter((call) => call.name === 'selectTool').at(-1)?.args).toEqual(['select', 1])
    expect(kit.tools.locked).toBe(false)
  })
})

describe('an answer that changed no pixel (Stage S of slide usable by hand)', () => {
  it('reads the empty area at the origin as nothing to repaint, any other empty area as everything', () => {
    expect(toolDamage({ damage: { x0: 0, y0: 0, x1: 0, y1: 0 } })).toEqual(NOTHING)
    expect(toolDamage({ damage: { x0: 5, y0: 0, x1: 5, y1: 9 } })).toBeNull()
  })
})

describe('the text sink (Stage S of slide usable by hand)', () => {
  it("hands the composition to onCompose as it changes, and ends it before its finished text", () => {
    const seen: string[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    cleanups.push(() => {
      act(() => root.unmount())
      host.remove()
    })
    act(() => root.render(<TextSink active onText={(text) => void seen.push(`text ${text}`)} onKey={() => false} onCompose={(text, cursor) => void seen.push(`compose ${text} ${cursor}`)} />))
    const field = host.querySelector('textarea') as HTMLTextAreaElement
    const composition = (type: string, data: string) => act(() => { field.dispatchEvent(new CompositionEvent(type, { bubbles: true, data })) })
    composition('compositionstart', '')
    field.value = 'n'
    field.setSelectionRange(1, 1)
    composition('compositionupdate', 'n')
    field.value = 'ni'
    field.setSelectionRange(2, 2)
    composition('compositionupdate', 'ni')
    field.value = '你'
    composition('compositionend', '你')
    expect(seen).toEqual(['compose n 1', 'compose ni 2', 'compose  0', 'text 你'])
  })
})

describe('shortcuts (Stage S of slide usable by hand)', () => {
  const command = (id: string, shortcut: string | null, moreShortcuts?: string[]): KitCommand => ({ id, title: id, description: null, group: id.split('.')[0], mutates: true, enabled: true, menu: [], shortcut, ...(moreShortcuts ? { moreShortcuts } : {}) })
  const press = (key: string, code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

  it('binds a bare Home and End, as Page Up and Page Down', () => {
    expect(bindableShortcut('Home')).toBe(true)
    expect(bindableShortcut('End')).toBe(true)
    expect(bindableShortcut('ArrowDown')).toBe(false)
    const commands = [command('slide.first', 'Home'), command('slide.last', 'End')]
    expect(commandForShortcut(commands, press('Home', 'Home'), true)?.id).toBe('slide.first')
    expect(commandForShortcut(commands, press('End', 'End'), false)?.id).toBe('slide.last')
  })

  it("runs a command from any of its keys, the menu's one first", () => {
    const commands = [command('edit.redo', 'Cmd+Y', ['Cmd+Shift+Z']), command('slide.last', 'Cmd+End', ['End'])]
    expect(commandShortcuts(commands[0])).toEqual(['Cmd+Y', 'Cmd+Shift+Z'])
    expect(commandForShortcut(commands, press('y', 'KeyY', { metaKey: true }), true)?.id).toBe('edit.redo')
    expect(commandForShortcut(commands, press('Z', 'KeyZ', { metaKey: true, shiftKey: true }), true)?.id).toBe('edit.redo')
    expect(commandForShortcut(commands, press('End', 'End'), true)?.id).toBe('slide.last')
    expect(commandForShortcut(commands, press('z', 'KeyZ', { metaKey: true }), true)).toBeUndefined()
    // Kition's own keys stay Kition's in the more shortcuts too.
    expect(commandShortcuts(command('file.saveTwice', null, ['Cmd+S', 'F12']))).toEqual(['F12'])
    // The catalog's JSON carries them.
    expect(kitModuleCommands(JSON.stringify([{ id: 'edit.redo', title: 'Redo', menu: null, shortcut: 'Cmd+Y', moreShortcuts: ['Cmd+Shift+Z'], mutates: true, enabled: true }]))[0].moreShortcuts).toEqual(['Cmd+Shift+Z'])
  })
})

describe('quiet answers (Stage S of slide usable by hand)', () => {
  const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
  const at: KitPointer = { x: 1, y: 2, clientX: 1, clientY: 2, canvasX: 1, canvasY: 2, pressure: 1, shift: false, alt: false, meta: false }
  const context = { viewport: { view: { zoom: 1 } } } as unknown as KitToolContext

  async function mount(quietAnswers: boolean, answer: () => EngineToolResponse) {
    const results: ReturnType<typeof useEngineTools>[] = []
    const tool = (async (name: string) => (name === 'tools' ? [{ id: 'select', label: 'Select', group: 0 }] : answer())) as Parameters<typeof useEngineTools>[0]
    const change: KitChange = { revision: 0, damage: null }
    function Probe() {
      results.push(useEngineTools(tool, true, change, { initial: 'select', quietAnswers }))
      return null
    }
    const root = createRoot(document.createElement('div'))
    cleanups.push(() => act(() => root.unmount()))
    await act(async () => root.render(<Probe />))
    return results
  }

  it("keeps the caller's render and its drawing for answers that only move the overlays, and tells each answer", async () => {
    let n = 0
    const marquee = () => ({ ...idle, overlays: [{ kind: 'marquee' as const, x0: 0, y0: 0, x1: ++n, y1: 1 }] })
    const results = await mount(true, marquee)
    await act(async () => results.at(-1)!.refresh())
    const settled = results.at(-1)!
    const heard: number[] = []
    const stop = settled.answers.subscribe(() => heard.push((settled.answers.get()?.overlays[0] as { x1: number }).x1))
    const renders = results.length
    for (let move = 0; move < 3; move += 1) await act(async () => settled.canvasTool.hover!(at, context))
    expect(results.length).toBe(renders)
    expect(results.at(-1)!.decorate).toBe(settled.decorate)
    expect(settled.quietAnswers).toBe(true)
    expect(heard).toHaveLength(3)
    expect(heard.at(-1)).toBe(n)
    stop()
    // Without it each answer is a new drawing.
    const loud = await mount(false, marquee)
    await act(async () => loud.at(-1)!.refresh())
    const before = loud.at(-1)!.decorate
    await act(async () => loud.at(-1)!.canvasTool.hover!(at, context))
    expect(loud.at(-1)!.decorate).not.toBe(before)
  })
})
