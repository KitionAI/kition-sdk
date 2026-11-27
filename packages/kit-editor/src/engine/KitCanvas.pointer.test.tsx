// @vitest-environment jsdom
// Stage S1 of "design usable by hand": the canvas gives a tool the real Control key (`ctrl`, apart
// from `meta`) and a press's click count (`clicks`, KitPointer PT14).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas, clickCounter } from './KitCanvas'
import type { KitEngine } from './kitEngine'
import type { KitPointer } from './kitTools'

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

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
}

describe('clickCounter', () => {
  it('counts presses close in time and place, up to three, then starts again', () => {
    const count = clickCounter()
    const press = (timeStamp: number, clientX = 10, button = 0) => count({ timeStamp, clientX, clientY: 10, button })
    expect([press(0), press(200), press(400), press(600)]).toEqual([1, 2, 3, 1])
    // Too late, too far, or another button: a first click again.
    expect(press(1200)).toBe(1)
    expect(press(1300, 30)).toBe(1)
    expect(press(1400, 30, 1)).toBe(1)
  })
})

describe('the pointer a tool is given', () => {
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

  it('has the real Control key and the press’s click count', () => {
    const doc = { width: 400, height: 200, render: async () => new Uint8Array(0), renderArea: async () => new Uint8Array(0), onFonts: () => () => undefined } as unknown as KitEngine
    const pressed: KitPointer[] = []
    const moved: KitPointer[] = []
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const tool = { id: 't', cursor: 'default', begin: (pointer: KitPointer) => { pressed.push(pointer); return { move: (at: KitPointer) => { moved.push(at) } } } }
    act(() => root!.render(<KitCanvas doc={doc} change={{ revision: 0, damage: null }} tool={tool} onView={() => undefined} viewMemory={{ current: null }} />))
    act(() => FakeResizeObserver.instances.at(-1)!.callback())
    const surface = host.querySelector('.kui-canvas-surface') as HTMLCanvasElement
    surface.setPointerCapture = () => undefined
    const fire = (type: string, init: MouseEventInit) => act(() => { surface.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: 100, clientY: 50, ...init })) })
    fire('pointerdown', { ctrlKey: true })
    fire('pointermove', { ctrlKey: true, buttons: 1 })
    fire('pointerup', {})
    fire('pointerdown', { metaKey: true })
    fire('pointerup', {})
    expect(pressed.map((pointer) => [pointer.meta, pointer.ctrl, pointer.clicks])).toEqual([[true, true, 1], [true, false, 2]])
    expect(moved[0]).toMatchObject({ ctrl: true })
    expect(moved[0].clicks).toBeUndefined()
  })
})
