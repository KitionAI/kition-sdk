// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSink } from './TextSink'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement | undefined
const render = (active = true) => {
  if (!host) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(<TextSink active={active} onText={() => undefined} onKey={() => false} />))
  return host.querySelector('textarea')!
}
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TextSink embedded focus ownership', () => {
  it('does not focus on activation while the host owns keyboard focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    render()
    expect(focus).not.toHaveBeenCalled()
  })

  it('focuses when the editor document is active, but respects another input', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const sink = render()
    expect(document.activeElement).toBe(sink)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    render(false)
    render(true)
    expect(document.activeElement).toBe(input)
    input.remove()
  })

  it('does not reclaim focus when a deferred pointer action outlives iframe focus', () => {
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    let pending: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { pending = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const sink = render()
    const focus = vi.spyOn(sink, 'focus')
    act(() => window.dispatchEvent(new Event('pointerup')))
    focused.mockReturnValue(false)
    act(() => pending?.(0))
    expect(focus).not.toHaveBeenCalled()
  })

  it('cancels pending focus when text editing deactivates', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7))
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    render()
    act(() => window.dispatchEvent(new Event('pointerup')))
    render(false)
    expect(cancel).toHaveBeenCalledWith(7)
  })

  it('keeps keyboard focus in the field when a toolbar button is pressed while typing, so the next Space is text', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const sink = render()
    expect(document.activeElement).toBe(sink)
    const button = document.createElement('button')
    const icon = document.createElement('span')
    button.append(icon)
    document.body.append(button)
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => void icon.dispatchEvent(press))
    // A pressed button would otherwise take focus until the next frame, and a Space typed in
    // between would press it again (a second Undo) instead of reaching the document.
    expect(press.defaultPrevented).toBe(true)
    button.remove()
  })

  it('leaves presses alone when the field is not focused (Tab to a button, typing in another field)', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render()
    const input = document.createElement('input')
    const button = document.createElement('button')
    document.body.append(input, button)
    input.focus()
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => void button.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(false)
    input.remove()
    button.remove()
  })
})
