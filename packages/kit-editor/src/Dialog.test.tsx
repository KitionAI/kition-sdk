// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from '@kition/tessera-ui'
import { PreviewDialog } from '@kition/tessera-ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no PointerEvent; a MouseEvent of the right type reaches React's pointer handlers.
if (typeof PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
    }
  }
  globalThis.PointerEvent = FakePointerEvent as unknown as typeof PointerEvent
}

let host: HTMLDivElement
let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  host?.remove()
})

function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(node))
}

const dialog = () => document.querySelector<HTMLElement>('.kui-dialog')!
const title = () => document.querySelector<HTMLElement>('.kui-dialog h2')!
const pointer = (target: Element, type: string, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
  })

describe('Dialog: movable by its title (opt-in)', () => {
  it('by default stays where the layout puts it and its title does not move it', () => {
    render(
      <Dialog title="Plain" actions={null} onClose={() => undefined}>
        body
      </Dialog>,
    )
    expect(dialog().style.left).toBe('')
    expect(title().dataset.movable).toBeUndefined()
    pointer(title(), 'pointerdown', 10, 10)
    pointer(title(), 'pointermove', 60, 40)
    pointer(title(), 'pointerup', 60, 40)
    expect(dialog().style.left).toBe('')
  })

  it('with onMove, a drag of the title moves it and reports where it ended; position places it', () => {
    const onMove = vi.fn()
    render(
      <Dialog title="Movable" actions={null} onClose={() => undefined} position={{ x: 40, y: 30 }} onMove={onMove}>
        body
      </Dialog>,
    )
    expect([dialog().style.left, dialog().style.top]).toEqual(['40px', '30px'])
    expect(title().dataset.movable).toBe('true')
    pointer(title(), 'pointerdown', 100, 100)
    pointer(title(), 'pointermove', 130, 150)
    // While dragging it follows the pointer; the place is reported once, on release.
    expect([dialog().style.left, dialog().style.top]).toEqual(['70px', '80px'])
    expect(onMove).not.toHaveBeenCalled()
    pointer(title(), 'pointerup', 130, 150)
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith({ x: 70, y: 80 })
  })

  it('never moves it off the top or the left of the window', () => {
    const onMove = vi.fn()
    render(
      <Dialog title="Movable" actions={null} onClose={() => undefined} position={{ x: 10, y: 10 }} onMove={onMove}>
        body
      </Dialog>,
    )
    pointer(title(), 'pointerdown', 100, 100)
    pointer(title(), 'pointermove', 0, 0)
    pointer(title(), 'pointerup', 0, 0)
    expect(onMove).toHaveBeenCalledWith({ x: 0, y: 0 })
  })
})

describe('PreviewDialog: passes position and onMove to its dialog', () => {
  it('moves by its title when asked, and not by default', () => {
    const onMove = vi.fn()
    render(
      <PreviewDialog title="Speed" onOk={() => undefined} onCancel={() => undefined} position={null} onMove={onMove} modal={false}>
        fields
      </PreviewDialog>,
    )
    expect(title().dataset.movable).toBe('true')
    pointer(title(), 'pointerdown', 50, 50)
    pointer(title(), 'pointermove', 70, 60)
    pointer(title(), 'pointerup', 70, 60)
    expect(onMove).toHaveBeenCalledWith({ x: 20, y: 10 })
    act(() => roots.pop()!.unmount())
    host.remove()
    render(
      <PreviewDialog title="Speed" onOk={() => undefined} onCancel={() => undefined}>
        fields
      </PreviewDialog>,
    )
    expect(title().dataset.movable).toBeUndefined()
  })
})

describe('Dialog: a new position after a drag', () => {
  it('takes a position given after it was dragged', () => {
    const at = (position: { x: number; y: number } | null) => (
      <Dialog title="Movable" actions={null} onClose={() => undefined} position={position} onMove={() => undefined}>
        body
      </Dialog>
    )
    host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => root.render(at({ x: 10, y: 10 })))
    pointer(title(), 'pointerdown', 0, 0)
    pointer(title(), 'pointermove', 50, 50)
    pointer(title(), 'pointerup', 50, 50)
    expect([dialog().style.left, dialog().style.top]).toEqual(['60px', '60px'])
    act(() => root.render(at({ x: 200, y: 120 })))
    expect([dialog().style.left, dialog().style.top]).toEqual(['200px', '120px'])
  })
})

describe('Dialog: Escape', () => {
  const press = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

  it('a modal dialog closes on any Escape (the default)', () => {
    const onClose = vi.fn()
    const outside = document.createElement('button')
    document.body.append(outside)
    render(
      <Dialog title="Modal" actions={null} onClose={onClose}>
        body
      </Dialog>,
    )
    outside.focus()
    press()
    expect(onClose).toHaveBeenCalledTimes(1)
    outside.remove()
  })

  it('a non-modal dialog closes on Escape only with focus inside it or nowhere', () => {
    const onClose = vi.fn()
    const outside = document.createElement('button')
    document.body.append(outside)
    render(
      <Dialog title="Non-modal" actions={<button type="button">OK</button>} onClose={onClose} modal={false}>
        body
      </Dialog>,
    )
    // In the timeline, a menu over the dialog, any other place: that place's Escape.
    outside.focus()
    press()
    expect(onClose).not.toHaveBeenCalled()
    dialog().querySelector('button')!.focus()
    press()
    expect(onClose).toHaveBeenCalledTimes(1)
    outside.blur()
    ;(document.activeElement as HTMLElement | null)?.blur()
    press()
    expect(onClose).toHaveBeenCalledTimes(2)
    outside.remove()
  })
})
