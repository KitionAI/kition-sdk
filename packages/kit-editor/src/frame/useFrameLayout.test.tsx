// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISPLAY_MODES } from './modes'
import { useStepDown, useTouchDensity } from './useFrameLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The layout a browser would report: the frame's width (fractional, as a ResizeObserver gives it) and the command row's. */
const layout = { frame: 1024, panel: 900, content: 900 }
let observed: ResizeObserverCallback | null = null
class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observed = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function resize(frame: number, panel: number, content: number) {
  Object.assign(layout, { frame, panel, content })
  act(() => observed?.([{ contentRect: { width: frame } } as unknown as ResizeObserverEntry], {} as ResizeObserver))
}

function Harness() {
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const fit = useStepDown(root, 'line', 'home', DISPLAY_MODES)
  useLayoutEffect(() => {
    if (fit.effective === 'line') fit.measure('line', panel.current)
  })
  return (
    <div ref={root} data-role="frame" data-effective={fit.effective}>
      {fit.effective === 'line' ? <div ref={panel} data-role="panel" /> : null}
    </div>
  )
}

let container: HTMLDivElement
let root: Root | null = null
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  const role = (element: Element) => (element as HTMLElement).dataset.role
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    // Browsers round clientWidth; the frame's real width may be fractional.
    return role(this) === 'panel' ? layout.panel : Math.round(layout.frame)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return role(this) === 'panel' ? Math.max(layout.panel, layout.content) : Math.round(layout.frame)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = role(this) === 'panel' ? layout.panel : layout.frame
    return { width, height: 30, left: 0, top: 0, right: width, bottom: 30, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  observed = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const effective = () => (container.firstElementChild as HTMLElement).dataset.effective

describe('useStepDown', () => {
  it('keeps a row that fits at a fractional width, steps down when it overflows, and steps back up when it fits again', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<Harness />))
    // Fits at a fractional width: no need is recorded from the rounded clientWidth.
    resize(1023.5, 900, 900)
    expect(effective()).toBe('line')
    // A narrower frame where the row still fits: no step-down.
    resize(950.25, 830, 830)
    expect(effective()).toBe('line')
    // The row overflows by 100 px: it needs 1051 px and steps down to Menus.
    resize(951, 831, 931)
    expect(effective()).toBe('menus')
    resize(1000, 880, 880)
    expect(effective()).toBe('menus')
    // Wide enough again: back to Single line, where the row fits.
    resize(1100, 980, 931)
    expect(effective()).toBe('line')
  })
})

describe('useTouchDensity', () => {
  it('is false without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    let touch: boolean | null = null
    function Probe() {
      touch = useTouchDensity()
      return null
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<Probe />))
    expect(touch).toBe(false)
  })
})
