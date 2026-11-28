// @vitest-environment jsdom
// Stage S of "PDF usable by hand": a tool's `hover` can answer the cursor (no new tool object for
// each cursor), a wheel over the HTML a kit lays over the canvas scrolls the document, and the
// tool types a kit writes its tools with come from the package.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas } from './KitCanvas'
import type { KitEngine } from './kitEngine'
import type { KitGesture, KitOverlay, KitPointer, KitTool, KitToolContext } from '../index'

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

describe('the canvas and its tool (Stage S of PDF usable by hand)', () => {
  let host: HTMLDivElement
  let root: Root | null = null
  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    for (const [name, value] of [['clientWidth', 800], ['clientHeight', 400]] as const) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return this.classList.contains('kui-canvas-surface') ? value : 0 } })
    }
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

  const doc = { width: 400, height: 200, render: async () => new Uint8Array(0), renderArea: async () => new Uint8Array(0), onFonts: () => () => undefined } as unknown as KitEngine
  function mount(tool: KitTool, children?: React.ReactNode) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<KitCanvas doc={doc} change={{ revision: 0, damage: null }} tool={tool} onView={() => undefined} viewMemory={{ current: null }}>{children}</KitCanvas>))
    act(() => FakeResizeObserver.instances.at(-1)!.callback())
    return host.querySelector('.kui-canvas-surface') as HTMLCanvasElement
  }

  it("shows the cursor the tool's hover answers, until it answers none or the pointer leaves", () => {
    let over = 'text'
    const gesture: KitGesture = { end: () => undefined }
    const tool: KitTool = { id: 'page', cursor: 'default', begin: () => gesture, hover: () => over || undefined }
    const surface = mount(tool)
    const move = () => act(() => { surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10, buttons: 0 })) })
    expect(surface.style.cursor).toBe('default')
    move()
    expect(surface.style.cursor).toBe('text')
    over = 'move'
    move()
    expect(surface.style.cursor).toBe('move')
    over = ''
    move()
    expect(surface.style.cursor).toBe('default')
    over = 'text'
    move()
    act(() => { surface.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
    expect(surface.style.cursor).toBe('default')
  })

  it('scrolls the document for a wheel over HTML laid over the canvas, not for one a scrolling list in it can take', () => {
    const tool: KitTool = { id: 't', cursor: 'default', begin: (_pointer: KitPointer, context: KitToolContext) => void (context.overlay satisfies KitOverlay) }
    const surface = mount(tool, (
      <div className="field" data-testid="field">
        <div data-testid="list" style={{ overflowY: 'auto' }} />
      </div>
    ))
    const list = host.querySelector('[data-testid="list"]') as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
    const wheel = (target: Element) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 })
      act(() => void target.dispatchEvent(event))
      return event
    }
    expect(wheel(surface).defaultPrevented).toBe(true)
    expect(wheel(host.querySelector('[data-testid="field"]')!).defaultPrevented).toBe(true)
    expect(wheel(list).defaultPrevented).toBe(false)
  })
})
