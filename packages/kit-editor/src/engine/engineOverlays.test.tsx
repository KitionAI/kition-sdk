// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_OVERLAY_STYLE, drawEngineOverlays, overlayStyle, type EngineOverlay, type OverlayDrawer } from './engineOverlays'
import { useEngineTools, type EngineToolResponse } from './engineTools'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // jsdom has no Path2D; the path overlay only hands it to `stroke`.
  ;(globalThis as { Path2D?: unknown }).Path2D ??= class {
    constructor(readonly d: string) {}
  }
})

/** A 2D context that records each drawing call with the state it was made in. */
function recorder() {
  const log: string[] = []
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 1, dash: [] as number[], globalAlpha: 1, font: '' }
  const stack: (typeof state)[] = []
  const record = (name: string, args: unknown[]) => {
    const style = name.startsWith('fill') ? `fill ${state.fillStyle}` : name.startsWith('stroke') ? `stroke ${state.strokeStyle} w${state.lineWidth} dash[${state.dash}]` : ''
    const alpha = state.globalAlpha !== 1 ? ` a${state.globalAlpha}` : ''
    log.push(`${name}(${args.map((n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : typeof n === 'string' ? n : '_')).join(',')}) ${style}${alpha}`.trim())
  }
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target && key !== 'dash') return target[key as keyof typeof target]
      if (key === 'save') return () => stack.push({ ...target, dash: [...target.dash] })
      if (key === 'restore') return () => Object.assign(target, stack.pop())
      if (key === 'setLineDash') return (dash: number[]) => { target.dash = [...dash] }
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      return (...args: unknown[]) => {
        if (['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'arc', 'roundRect'].includes(String(key))) record(String(key), args)
      }
    },
    set(target, key, value) {
      ;(target as Record<string, unknown>)[key as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { log, context, depth: () => stack.length }
}

const toScreen = (x: number, y: number) => ({ x: x * 2, y: y * 2 })
const view = { zoom: 2, x: 0, y: 0 }
const GREEN: [number, number, number, number] = [0, 135, 95, 255]
const marquee: EngineOverlay = { kind: 'marquee', x0: 0, y0: 0, x1: 10, y1: 5 }
const anchor: EngineOverlay = { kind: 'anchor', x: 5, y: 5, color: GREEN, filled: false, size: 8 }

describe('drawEngineOverlays', () => {
  it("draws in Kition's style by default", () => {
    const { log, context, depth } = recorder()
    drawEngineOverlays([marquee, anchor, { kind: 'measure', x: 0, y: 0, text: '20' }])(context, toScreen, view)
    expect(log).toEqual([
      'fillRect(0,0,20,10) fill #5645d4 a0.08',
      'strokeRect(0.5,0.5,20,10) stroke #5645d4 w1 dash[4,3]',
      'fillRect(6,6,8,8) fill #ffffff',
      'strokeRect(6.5,6.5,7,7) stroke rgba(0, 135, 95, 1) w1 dash[]',
      'roundRect(12,12,24,18,4)',
      'fill() fill #1f1d2b',
      'fillText(20,18,21) fill #ffffff',
    ])
    expect(depth()).toBe(0)
  })

  it("takes the kit's style changes per overlay kind", () => {
    const { log, context } = recorder()
    const style = overlayStyle({ accent: '#00875f', marquee: { fillOpacity: 0.1, dash: [], inside: true }, anchor: { shape: 'circle' }, measure: { fill: '#f24822', align: 'center', height: null, padX: 4 } })
    expect(style.marquee.width).toBe(1)
    expect(DEFAULT_OVERLAY_STYLE.marquee.dash).toEqual([4, 3])
    drawEngineOverlays([marquee, anchor, { kind: 'measure', x: 0, y: 0, text: '20' }], style)(context, toScreen, view)
    expect(log).toEqual([
      'fillRect(0,0,20,10) fill #00875f a0.1',
      'strokeRect(0.5,0.5,19,9) stroke #00875f w1 dash[]',
      'arc(10,10,4,0,6.28)',
      'fill() fill #ffffff',
      'arc(10,10,3.5,0,6.28)',
      'stroke() stroke rgba(0, 135, 95, 1) w1 dash[]',
      'roundRect(2,12,20,17,4)',
      'fill() fill #f24822',
      'fillText(20,6,20.5) fill #ffffff',
    ])
  })

  it("lets the kit's hook draw overlays itself, the others in the style", () => {
    const { log, context, depth } = recorder()
    const seen: string[] = []
    const draw: OverlayDrawer = (overlay, at) => {
      seen.push(`${overlay.kind} ${at.index}/${at.overlays.length} ${at.view.zoom} ${at.style.accent}`)
      at.frame.count = Number(at.frame.count ?? 0) + 1
      if (overlay.kind === 'anchor') {
        const p = at.toScreen(overlay.x, overlay.y)
        at.context.fillStyle = 'white'
        at.context.fillRect(p.x - 4, p.y - 4, 8, 8)
        at.context.lineWidth = 3
        return true
      }
      if (overlay.kind === 'measure') {
        at.drawDefault({ kind: 'label', x: 0, y: 0, text: `#${String(at.frame.count)}`, color: GREEN })
        return true
      }
      return undefined
    }
    drawEngineOverlays([anchor, marquee, { kind: 'measure', x: 0, y: 0, text: '20' }], DEFAULT_OVERLAY_STYLE, draw)(context, toScreen, view)
    expect(seen).toEqual(['anchor 0/3 2 #5645d4', 'marquee 1/3 2 #5645d4', 'measure 2/3 2 #5645d4'])
    expect(log).toEqual([
      'fillRect(6,6,8,8) fill white',
      'fillRect(0,0,20,10) fill #5645d4 a0.08',
      'strokeRect(0.5,0.5,20,10) stroke #5645d4 w1 dash[4,3]',
      'fillText(#3,4,-4) fill rgba(0, 135, 95, 1)',
    ])
    expect(depth()).toBe(0)
  })
})

describe('useEngineTools', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!()
  })

  it("draws the engine's overlays with the kit's style and hook", async () => {
    const answer: EngineToolResponse = { requests: [], overlays: [marquee, anchor], cursor: 'default', busy: false, wantsText: false }
    const tool = (async (name: string) => (name === 'tools' ? [{ id: 'select', label: 'Select', group: 0 }] : answer)) as Parameters<typeof useEngineTools>[0]
    const kinds: string[] = []
    const drawOverlay: OverlayDrawer = (overlay) => {
      kinds.push(overlay.kind)
      return overlay.kind === 'anchor'
    }
    const style = { marquee: { stroke: '#f24822' } }
    let current!: ReturnType<typeof useEngineTools>
    function Probe() {
      current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select', overlayStyle: style, drawOverlay })
      return null
    }
    const root = createRoot(document.createElement('div'))
    cleanups.push(() => act(() => root.unmount()))
    await act(async () => root.render(<Probe />))
    expect(current.decorate).toBeTruthy()
    const { log, context } = recorder()
    current.decorate!(context, toScreen, view)
    expect(kinds).toEqual(['marquee', 'anchor'])
    expect(log).toEqual(['fillRect(0,0,20,10) fill #5645d4 a0.08', 'strokeRect(0.5,0.5,20,10) stroke #f24822 w1 dash[4,3]'])
  })

  it('asks the tool state again when the view zooms, at the new zoom', async () => {
    const answer: EngineToolResponse = { requests: [], overlays: [anchor], cursor: 'default', busy: false, wantsText: false }
    const calls: unknown[][] = []
    const tool = (async (name: string, args: unknown[] = []) => {
      if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0 }]
      calls.push([name, ...args])
      return answer
    }) as Parameters<typeof useEngineTools>[0]
    let current!: ReturnType<typeof useEngineTools>
    function Probe() {
      current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
      return null
    }
    const root = createRoot(document.createElement('div'))
    cleanups.push(() => act(() => root.unmount()))
    await act(async () => root.render(<Probe />))
    calls.length = 0
    await act(async () => current.viewZoom(4))
    await act(async () => current.viewZoom(4))
    expect(calls).toEqual([['toolState', 0, 0, '{}', 4]])
  })
})
