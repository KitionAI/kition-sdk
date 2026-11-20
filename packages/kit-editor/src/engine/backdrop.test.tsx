// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasColor, useEngineBackdrop, type EngineBackdropOptions } from './backdrop'
import type { KitCanvasHandle } from './KitCanvas'
import type { KitEngine } from './kitEngine'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no 2D canvas: one whose `fillStyle` resolves the few colours the tests use, as a browser's does. */
function fakeCanvas2d() {
  const resolved: Record<string, string> = { 'hsl(0, 0%, 12%)': '#1f1f1f', 'rgb(240, 240, 240)': '#f0f0f0', 'rgba(0, 0, 0, 0.5)': 'rgba(0, 0, 0, 0.5)' }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    let style = '#000000'
    return {
      get fillStyle() {
        return style
      },
      set fillStyle(value: string) {
        style = resolved[value] ?? style
      },
    }
  }) as never)
  vi.stubGlobal('CSS', { supports: (_: string, value: string) => value in resolved || /^#/.test(value) })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-color-scheme')
})

describe('canvasColor', () => {
  it('answers a hex token as it is, lower case', () => {
    const root = document.createElement('div')
    root.style.setProperty('--kit-canvas', '#AABBCC')
    expect(canvasColor(root)).toBe('#aabbcc')
  })
  it('resolves any CSS colour through a 2D canvas, and reads the token it is given', () => {
    fakeCanvas2d()
    const root = document.createElement('div')
    root.style.setProperty('--kit-canvas', 'hsl(0, 0%, 12%)')
    root.style.setProperty('--kit-surface', 'rgb(240, 240, 240)')
    expect(canvasColor(root)).toBe('#1f1f1f')
    expect(canvasColor(root, '--kit-surface')).toBe('#f0f0f0')
  })
  it('answers null for no token, a non-colour, or a colour that is not opaque', () => {
    fakeCanvas2d()
    const root = document.createElement('div')
    expect(canvasColor(root)).toBeNull()
    root.style.setProperty('--kit-canvas', 'not-a-colour')
    expect(canvasColor(root)).toBeNull()
    root.style.setProperty('--kit-canvas', 'rgba(0, 0, 0, 0.5)')
    expect(canvasColor(root)).toBeNull()
  })
})

describe('useEngineBackdrop', () => {
  const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)))
  function mount(doc: KitEngine | null, options?: EngineBackdropOptions) {
    const canvas = createRef<KitCanvasHandle | null>() as { current: KitCanvasHandle | null }
    const retryRender = vi.fn(async () => true)
    canvas.current = { retryRender } as unknown as KitCanvasHandle
    function Probe() {
      useEngineBackdrop(doc, canvas, options)
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => root.render(<Probe />))
    return { retryRender, unmount: () => act(() => root.unmount()) }
  }
  const engine = () => {
    const invoke = vi.fn(async () => undefined)
    return { doc: { invoke } as unknown as KitEngine, invoke }
  }

  it('gives the engine the canvas colour at open and repaints', async () => {
    document.documentElement.style.setProperty('--kit-canvas', '#f2f2f2')
    const { doc, invoke } = engine()
    const { retryRender, unmount } = mount(doc)
    await settle()
    expect(invoke).toHaveBeenCalledWith('setBackdrop', '#f2f2f2')
    expect(retryRender).toHaveBeenCalledTimes(1)
    unmount()
  })
  it('follows a theme change once per new colour, and stops when closed', async () => {
    document.documentElement.style.setProperty('--kit-canvas', '#f2f2f2')
    const { doc, invoke } = engine()
    const { unmount } = mount(doc)
    await settle()
    document.documentElement.style.setProperty('--kit-canvas', '#1e1e1e')
    document.documentElement.dataset.colorScheme = 'dark'
    await settle()
    expect(invoke.mock.calls).toEqual([
      ['setBackdrop', '#f2f2f2'],
      ['setBackdrop', '#1e1e1e'],
    ])
    // A change that leaves the colour as it was gives nothing.
    document.documentElement.className = 'other'
    await settle()
    expect(invoke).toHaveBeenCalledTimes(2)
    unmount()
    document.documentElement.style.setProperty('--kit-canvas', '#ffffff')
    await settle()
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('takes another engine extra and token, and does nothing without a document', async () => {
    document.documentElement.style.setProperty('--kit-surface', '#202020')
    const { doc, invoke } = engine()
    mount(null)
    await settle()
    const { unmount } = mount(doc, { method: 'setPasteboard', token: '--kit-surface' })
    await settle()
    expect(invoke.mock.calls).toEqual([['setPasteboard', '#202020']])
    unmount()
  })
  it('keeps going when the engine refuses the colour, without repainting', async () => {
    document.documentElement.style.setProperty('--kit-canvas', '#f2f2f2')
    const invoke = vi.fn(async () => {
      throw new Error('no such extra')
    })
    const { retryRender, unmount } = mount({ invoke } as unknown as KitEngine)
    await settle()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(retryRender).not.toHaveBeenCalled()
    unmount()
  })
})
