// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { drawEngineOverlays, overlayStyle, overlaysAnimate, type EngineOverlay } from './engineOverlays'
import { useEngineTools, type EngineToolResponse } from './engineTools'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  ;(globalThis as { Path2D?: unknown }).Path2D ??= class {
    constructor(readonly d: string) {}
  }
})

/** A 2D context that records strokes, fills, texts and boxes with the state they were made in. */
function recorder() {
  const log: string[] = []
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, lineDashOffset: 0, font: '' }
  let dash: number[] = []
  const stack: Record<string, unknown>[] = []
  const round = (n: number) => Math.round(n * 100) / 100
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key as string]
      if (key === 'save') return () => stack.push({ ...target, dash })
      if (key === 'restore') return () => {
        const back = stack.pop()!
        dash = back.dash as number[]
        Object.assign(target, back)
      }
      if (key === 'setLineDash') return (next: number[]) => { dash = [...next] }
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
      return (...args: unknown[]) => {
        if (key === 'stroke') log.push(`stroke ${target.strokeStyle} w${round(target.lineWidth as number)} dash[${dash.map(round)}] offset${round(target.lineDashOffset as number)}`)
        if (key === 'fill') log.push(`fill ${target.fillStyle}`)
        if (key === 'fillText') log.push(`text ${args[0]} ${round(args[1] as number)},${round(args[2] as number)} ${target.fillStyle}`)
        if (key === 'roundRect') log.push(`box ${args.slice(0, 4).map((n) => round(n as number)).join(',')}`)
      }
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { log, context }
}

const toScreen = (x: number, y: number) => ({ x: x * 2, y: y * 2 })
const view = { zoom: 2, x: 0, y: 0 }
const ants: EngineOverlay = { kind: 'ants', d: 'M0,0 L10,0 L10,5 L0,5 Z', color: [0, 135, 95, 255], width: 2 }
const label: EngineOverlay = { kind: 'label', x: 10, y: 10, text: '64 px', color: [31, 29, 43, 255] }

afterEach(() => vi.restoreAllMocks())

describe('marching ants (Stage S of sheet usable by hand)', () => {
  it('draw dashes in the overlay colour over the gaps, moving along the path with the clock', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const first = recorder()
    drawEngineOverlays([ants])(first.context, toScreen, view)
    // At zoom 2 the path is drawn in document pixels: widths, dashes and offsets halve.
    expect(first.log).toEqual(['stroke #ffffff w1 dash[] offset0', 'stroke rgba(0, 135, 95, 1) w1 dash[2,2] offset0'])
    now.mockReturnValue(250)
    const later = recorder()
    drawEngineOverlays([ants])(later.context, toScreen, view)
    // 16 CSS pixels a second: 4 pixels on in a quarter second (2 document pixels).
    expect(later.log[1]).toBe('stroke rgba(0, 135, 95, 1) w1 dash[2,2] offset-2')
  })

  it("take the kit's dash, speed and gap", () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    const { log, context } = recorder()
    drawEngineOverlays([ants], overlayStyle({ ants: { dash: [6, 2], speed: 0, gap: 'transparent' } }))(context, toScreen, view)
    expect(log).toEqual(['stroke rgba(0, 135, 95, 1) w1 dash[3,1] offset0'])
  })

  it('are the overlays that animate', () => {
    expect(overlaysAnimate([label, ants])).toBe(true)
    expect(overlaysAnimate([label, { kind: 'path', d: 'M0,0', color: [0, 0, 0, 255], width: 1, dashed: true }])).toBe(false)
    expect(overlaysAnimate(null)).toBe(false)
  })

  it("make the engine tools' canvas animate only while one is shown", async () => {
    let answer: EngineToolResponse = { requests: [], overlays: [ants], cursor: 'default', busy: false, wantsText: false }
    const tool = (async (name: string) => (name === 'tools' ? [{ id: 'select', label: 'Select', group: 0 }] : answer)) as Parameters<typeof useEngineTools>[0]
    let current!: ReturnType<typeof useEngineTools>
    function Probe() {
      current = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    expect(current.animated).toBe(true)
    answer = { ...answer, overlays: [label] }
    await act(async () => current.refresh())
    expect(current.animated).toBe(false)
    act(() => root.unmount())
  })
})

describe('labels (Stage S of sheet usable by hand)', () => {
  it('are text alone by default', () => {
    const { log, context } = recorder()
    drawEngineOverlays([label])(context, toScreen, view)
    expect(log).toEqual(['text 64 px 24,16 rgba(31, 29, 43, 1)'])
  })

  it("draw on a box of the kit's style, in its text colour", () => {
    const { log, context } = recorder()
    drawEngineOverlays([label], overlayStyle({ label: { fill: '#fffbe6', stroke: '#c8c8c8', color: '#333333', padX: 4, padY: 2, radius: 2 } }))(context, toScreen, view)
    expect(log).toEqual(['box 20,6,38,14', 'fill #fffbe6', 'box 20.5,6.5,37,13', 'stroke #c8c8c8 w1 dash[] offset0', 'text 64 px 24,16 #333333'])
  })
})
