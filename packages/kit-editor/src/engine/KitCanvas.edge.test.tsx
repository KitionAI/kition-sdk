// @vitest-environment jsdom
// Stage S of "sheet usable by hand": a held gesture's pointer past the canvas's edge scrolls the
// view and is told (`edgeScroll`), and a kit can say where a wheel's scroll takes the view
// (`wheelPan`, a sheet's whole rows).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitCanvas, type KitCanvasView, type KitEdgePast, type KitEdgeScroll, type KitWheelPan } from './KitCanvas'
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

let host: HTMLDivElement
let root: Root | null = null
let frames: FrameRequestCallback[] = []
beforeEach(() => {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  for (const [name, value] of [['clientWidth', 800], ['clientHeight', 400]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return this.classList.contains('kui-canvas-surface') ? value : 0 } })
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames[id - 1] = () => undefined
  })
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

/** The edge scrolling's own frames (the viewport asks for frames of its own too). */
const edgeFrames = () => frames.filter((frame) => frame.name === 'edgeTick')

/** Runs the animation frames asked for so far, at `now`. */
function runFrames(now: number) {
  const due = frames
  frames = []
  for (const frame of due) act(() => frame(now))
}

function mount(props: { edgeScroll?: KitEdgeScroll; wheelPan?: (pan: KitWheelPan) => { x: number; y: number } | null; pinned?: { left: number; top: number } }) {
  const doc = { width: 4000, height: 4000, pinned: props.pinned, render: async () => new Uint8Array(0), renderArea: async () => new Uint8Array(0), onFonts: () => () => undefined } as unknown as KitEngine
  const moved: KitPointer[] = []
  const ended: KitPointer[] = []
  const views: KitCanvasView[] = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const tool = { id: 't', cursor: 'default', begin: () => ({ move: (at: KitPointer) => void moved.push(at), end: (at: KitPointer) => void ended.push(at) }) }
  act(() => root!.render(<KitCanvas doc={doc} change={{ revision: 0, damage: null }} tool={tool} onView={(view) => void views.push(view)} viewMemory={{ current: { zoom: 1, x: 100, y: 100 } }} edgeScroll={props.edgeScroll} wheelPan={props.wheelPan} />))
  act(() => FakeResizeObserver.instances.at(-1)!.callback())
  const surface = host.querySelector('.kui-canvas-surface') as HTMLCanvasElement
  surface.setPointerCapture = () => undefined
  const fire = (type: string, clientX: number, clientY: number) => act(() => void surface.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX, clientY, buttons: 1 })))
  return { moved, ended, views, fire, region: host.querySelector('.kui-canvas') as HTMLElement }
}

describe('scrolling at the edge during a gesture (edgeScroll)', () => {
  it('scrolls every frame while the pointer is past the edge, sends the move again held at the edge, and tells the kit', () => {
    const edges: (KitEdgePast | null)[] = []
    const { moved, ended, views, fire } = mount({ edgeScroll: { speed: (over) => over * 10, hold: true, onEdge: (past) => void edges.push(past) } })
    fire('pointerdown', 400, 200)
    fire('pointermove', 850, 200)
    // Held just inside the right edge: the document point under x 799 (the view's x is 100).
    expect(moved.at(-1)).toMatchObject({ x: 899, y: 300, clientX: 850 })
    expect(edges).toEqual([{ left: 0, right: 51, top: 0, bottom: 0 }])
    // The first frame scrolls a sixtieth of a second: 510 CSS pixels a second, 8.5 pixels.
    // (The view reported is placed on a whole device pixel.)
    runFrames(1000)
    expect(Math.abs(views.at(-1)!.x - 108.5)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(moved.at(-1)!.x - 907.5)).toBeLessThanOrEqual(0.5)
    // Then by the time between frames: 50 ms, 25.5 pixels more.
    runFrames(1050)
    expect(Math.abs(views.at(-1)!.x - 134)).toBeLessThanOrEqual(0.5)
    // Back inside: the timer stops and the kit hears it once.
    fire('pointermove', 700, 200)
    expect(edges.at(-1)).toBeNull()
    runFrames(1100)
    expect(edgeFrames()).toEqual([])
    fire('pointerup', 900, 200)
    expect(Math.abs(ended.at(-1)!.x - (134 + 799))).toBeLessThanOrEqual(0.5)
    expect(edges.filter((past) => past === null)).toHaveLength(1)
  })

  it('names where the pointer is without hold, and counts the left edge past the pinned band only while the view can go back', () => {
    const edges: (KitEdgePast | null)[] = []
    const { moved, views, fire } = mount({ pinned: { left: 50, top: 0 }, edgeScroll: { speed: () => 6000, onEdge: (past) => void edges.push(past) } })
    fire('pointerdown', 400, 200)
    fire('pointermove', 30, 200)
    expect(moved.at(-1)).toMatchObject({ clientX: 30 })
    expect(edges.at(-1)).toMatchObject({ left: 21 })
    // The first frame takes the view back 100 pixels, to 0, where a pinned band stops it; then
    // the left edge no longer counts.
    runFrames(0)
    expect(views.at(-1)?.x).toBe(0)
    runFrames(20)
    expect(edgeFrames()).toEqual([])
    expect(edges.at(-1)).toBeNull()
  })

  it('does nothing without edgeScroll, or when the kit says the gesture may not scroll', () => {
    const plain = mount({})
    plain.fire('pointerdown', 400, 200)
    plain.fire('pointermove', 900, 200)
    expect(edgeFrames()).toEqual([])
    expect(plain.moved.at(-1)?.x).toBe(1000)
    act(() => root!.unmount())
    root = null
    const edges: unknown[] = []
    const still = mount({ edgeScroll: { speed: () => 100, ways: () => null, onEdge: (past) => void edges.push(past) } })
    still.fire('pointerdown', 400, 200)
    still.fire('pointermove', 900, 200)
    expect(edgeFrames()).toEqual([])
    expect(edges).toEqual([])
  })
})

describe("the wheel's pan (wheelPan)", () => {
  it('pans to where the kit says, or by the wheel when it says nothing', () => {
    const pans: KitWheelPan[] = []
    let snap = true
    const { views, region } = mount({ wheelPan: (pan) => (pans.push(pan), snap ? { x: pan.x, y: Math.round(pan.y / 20) * 20 } : null) })
    act(() => void region.dispatchEvent(new WheelEvent('wheel', { deltaY: 33, bubbles: true, cancelable: true })))
    expect(pans[0]).toMatchObject({ dx: 0, dy: 33, x: 100, y: 133, view: { zoom: 1, x: 100, y: 100 } })
    expect(views.at(-1)?.y).toBe(140)
    snap = false
    act(() => void region.dispatchEvent(new WheelEvent('wheel', { deltaY: 7, bubbles: true, cancelable: true })))
    expect(views.at(-1)?.y).toBe(147)
    // With Cmd or Ctrl the wheel zooms, as before; the kit is not asked.
    act(() => void region.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, ctrlKey: true, bubbles: true, cancelable: true })))
    expect(pans).toHaveLength(2)
  })
})
