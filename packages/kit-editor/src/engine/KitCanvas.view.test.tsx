// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas, type KitCanvasHandle } from './KitCanvas'
import type { KitEngine } from './kitEngine'
import type { KitTool } from './kitTools'
import { RasterViewport } from './rasterViewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no PointerEvent (see NumberField.test.tsx): a MouseEvent with a pointerId stands in.
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

// jsdom lays nothing out and has no ResizeObserver: the canvas is 800 × 400 CSS pixels here,
// and a test fires the observer by hand, as a first layout would.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
}
const sized = (name: 'clientWidth' | 'clientHeight', value: number) =>
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return this.classList.contains('kui-canvas-surface') ? value : 0 } })

let host: HTMLDivElement
let root: Root | null = null
beforeEach(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  sized('clientWidth', 800)
  sized('clientHeight', 400)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  FakeResizeObserver.instances = []
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  vi.restoreAllMocks()
})

const doc = { width: 400, height: 200, render: async () => new Uint8Array(0), renderArea: async () => new Uint8Array(0) } as unknown as KitEngine

function mount(tool: KitTool) {
  const ref = createRef<KitCanvasHandle>()
  const onView = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<KitCanvas ref={ref} doc={doc} change={{ revision: 0, damage: null }} tool={tool} onView={onView} viewMemory={{ current: null }} />))
  // The first layout places the view (fits the document).
  act(() => FakeResizeObserver.instances.at(-1)!.callback())
  const surface = host.querySelector('.kui-canvas-surface') as HTMLCanvasElement
  return { ref, onView, surface }
}

const pointer = (element: Element, type: string, init: MouseEventInit = {}) =>
  act(() => {
    element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, ...init }))
  })

describe('KitCanvas view and pointer reports', () => {
  it('reports every view with the canvas size, and answers view() with the same', () => {
    const { ref, onView } = mount({ id: 't', cursor: 'default', begin: () => undefined })
    expect(onView).toHaveBeenCalled()
    const reported = onView.mock.calls.at(-1)![0]
    expect(reported.width).toBe(800)
    expect(reported.height).toBe(400)
    // Fitted: 400 × 200 in 800 × 400 less the margins.
    expect(reported.zoom).toBeCloseTo(Math.min((800 - 64) / 400, (400 - 64) / 200))
    expect(ref.current!.view()).toEqual({ zoom: reported.zoom, x: reported.x, y: reported.y, width: 800, height: 400 })
    act(() => ref.current!.panTo(10, 20))
    expect(onView.mock.calls.at(-1)![0]).toMatchObject({ x: 10, y: 20, width: 800, height: 400 })
    expect(ref.current!.view()).toMatchObject({ x: 10, y: 20 })
  })

  it('tracks the pointer while it hovers, in a gesture, and while Space pans; hover only while it hovers', () => {
    const track = vi.fn()
    const hover = vi.fn()
    const move = vi.fn()
    const { surface, ref } = mount({ id: 't', cursor: 'default', begin: () => ({ move }), hover, track })
    surface.setPointerCapture = () => undefined
    const { zoom, x, y } = ref.current!.view()!
    pointer(surface, 'pointermove', { clientX: 100, clientY: 50 })
    expect(track).toHaveBeenCalledTimes(1)
    expect(track.mock.calls[0][0]).toMatchObject({ x: x + 100 / zoom, y: y + 50 / zoom })
    expect(hover).toHaveBeenCalledTimes(1)
    pointer(surface, 'pointerdown', { clientX: 100, clientY: 50, buttons: 1 })
    pointer(surface, 'pointermove', { clientX: 120, clientY: 60, buttons: 1 })
    expect(track).toHaveBeenCalledTimes(2)
    expect(move).toHaveBeenCalledTimes(1)
    expect(hover).toHaveBeenCalledTimes(1)
    pointer(surface, 'pointerup', { clientX: 120, clientY: 60 })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    })
    pointer(surface, 'pointermove', { clientX: 130, clientY: 70 })
    expect(track).toHaveBeenCalledTimes(3)
    expect(hover).toHaveBeenCalledTimes(1)
  })

  it('drops a held gesture on Escape and takes that Escape; the release then commits nothing', () => {
    const move = vi.fn()
    const end = vi.fn()
    const cancel = vi.fn()
    const { surface } = mount({ id: 't', cursor: 'default', begin: () => ({ move, end, cancel }) })
    surface.setPointerCapture = () => undefined
    const later = vi.fn()
    window.addEventListener('keydown', later)
    try {
      pointer(surface, 'pointerdown', { clientX: 10, clientY: 10, buttons: 1 })
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => void document.body.dispatchEvent(escape))
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(escape.defaultPrevented).toBe(true)
      expect(later).not.toHaveBeenCalled()
      pointer(surface, 'pointermove', { clientX: 40, clientY: 40, buttons: 1 })
      pointer(surface, 'pointerup', { clientX: 40, clientY: 40 })
      expect(move).not.toHaveBeenCalled()
      expect(end).not.toHaveBeenCalled()
      // With no gesture held, Escape is not the canvas's.
      const free = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => void document.body.dispatchEvent(free))
      expect(free.defaultPrevented).toBe(false)
      expect(later).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', later)
    }
  })

  it('tells the tool when the pointer leaves the canvas, but not during a held gesture', () => {
    const leave = vi.fn()
    const { surface } = mount({ id: 't', cursor: 'default', begin: () => ({}), leave })
    surface.setPointerCapture = () => undefined
    pointer(surface, 'pointerover', { clientX: 10, clientY: 10 })
    pointer(surface, 'pointerout', { relatedTarget: document.body })
    expect(leave).toHaveBeenCalledTimes(1)
    pointer(surface, 'pointerover', { clientX: 10, clientY: 10 })
    pointer(surface, 'pointerdown', { clientX: 10, clientY: 10, buttons: 1 })
    pointer(surface, 'pointerout', { relatedTarget: document.body })
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('repaints once per repaint tick, the damage only, without a document change', () => {
    const render = vi.spyOn(RasterViewport.prototype, 'render')
    const renderArea = vi.spyOn(RasterViewport.prototype, 'renderArea')
    const change = { revision: 0, damage: null }
    const tool: KitTool = { id: 't', cursor: 'default', begin: () => undefined }
    const draw = (repaint: { tick: number; damage: { x0: number; y0: number; x1: number; y1: number } | null }) =>
      act(() => root!.render(<KitCanvas doc={doc} change={change} repaint={repaint} tool={tool} onView={() => undefined} viewMemory={{ current: null }} />))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    draw({ tick: 0, damage: null })
    act(() => FakeResizeObserver.instances.at(-1)!.callback())
    const before = { render: render.mock.calls.length, area: renderArea.mock.calls.length }
    const damage = { x0: 0, y0: 0, x1: 10, y1: 10 }
    const first = { tick: 1, damage }
    draw(first)
    expect(renderArea.mock.calls.length).toBe(before.area + 1)
    expect(renderArea.mock.calls.at(-1)![0]).toEqual(damage)
    // The same repaint drawn again (the editor rendered for another reason) paints nothing.
    draw(first)
    expect(renderArea.mock.calls.length).toBe(before.area + 1)
    const rendered = render.mock.calls.length
    draw({ tick: 2, damage: null })
    expect(render.mock.calls.length).toBe(rendered + 1)
  })
})

describe('KitCanvas backdrop', () => {
  it('re-reads --kit-canvas when the host switches the theme', async () => {
    const setBackdrop = vi.spyOn(RasterViewport.prototype, 'setBackdrop')
    document.documentElement.style.setProperty('--kit-canvas', '#f3f3f6')
    mount({ id: 't', cursor: 'default', begin: () => undefined })
    await act(async () => {
      document.documentElement.style.setProperty('--kit-canvas', '#1e1f22')
      document.documentElement.dataset.colorScheme = 'dark'
      await Promise.resolve()
    })
    expect(setBackdrop).toHaveBeenLastCalledWith('#1e1f22')
    document.documentElement.style.removeProperty('--kit-canvas')
    delete document.documentElement.dataset.colorScheme
  })
})
