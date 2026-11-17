// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SquareIcon as Square } from '@kition/tessera-icons/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'
import { KitElement, UiProvider, useUi, type UiContextValue } from './uiContext'
import { HostButtons, hostIcon } from './HostButtons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  host?.remove()
})

function render(value: UiContextValue | null, children: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(value ? <UiProvider value={value}>{children}</UiProvider> : <>{children}</>))
  return root
}

function context(store = createUiStore(EMPTY_UI_CONFIG, null, () => undefined), pressed: string[] = []): UiContextValue {
  return {
    store,
    locale: 'en-US',
    menuOf: () => [],
    declared: null,
    press: (id) => pressed.push(id),
    offerHide: null,
    openCustomize: null,
    hide: null,
    renderButtons: () => null,
  }
}

describe('KitElement', () => {
  it('draws, disables, and hides with the configuration, live', () => {
    const store = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)
    render(context(store), <KitElement id="control:colors"><button type="button">Colors</button></KitElement>)
    const fieldset = () => host.querySelector('fieldset[data-kit-ui-id="control:colors"]') as HTMLFieldSetElement | null
    expect(fieldset()?.disabled).toBe(false)
    act(() => store.replace({ ...EMPTY_UI_CONFIG, disable: ['control:colors'] }))
    expect(fieldset()?.disabled).toBe(true)
    act(() => store.replace({ ...EMPTY_UI_CONFIG, personal: ['control:colors'] }))
    expect(fieldset()).toBeNull()
  })
})

describe('useUi outside a provider', () => {
  it('hides nothing and renders no host buttons', () => {
    let probe!: ReturnType<typeof useUi>
    function Probe() {
      probe = useUi()
      return null
    }
    render(null, <Probe />)
    expect(probe.state('control:colors').hidden).toBe(false)
    expect(probe.state('control:colors').disabled).toBe(false)
    expect(probe.renderButtons('action', 'action')).toBeNull()
  })
})

describe('HostButtons', () => {
  it('draws the buttons at a place and reports presses', () => {
    const pressed: string[] = []
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' }, icon: 'send', disabled: false, pressed: false }] }, null, () => undefined)
    render(context(store, pressed), <HostButtons place="action" as="action" />)
    const button = host.querySelector('[data-kit-ui-id="host:submit"]') as HTMLButtonElement
    expect(button.textContent).toBe('Submit')
    act(() => button.click())
    expect(pressed).toEqual(['submit'])
  })

  it('shows a data: icon as an image', () => {
    const icon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'mark', place: 'action', label: { 'en-US': 'Mark' }, icon, disabled: true, pressed: false }] }, null, () => undefined)
    render(context(store), <HostButtons place="action" as="action" />)
    expect(host.querySelector('img')?.getAttribute('src')).toBe(icon)
    expect((host.querySelector('[data-kit-ui-id="host:mark"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('never renders an <img> for a non data: URL icon', () => {
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'evil', place: 'action', label: { 'en-US': 'Evil' }, icon: 'https://example.com/x.png' }] }, null, () => undefined)
    render(context(store), <HostButtons place="action" as="action" />)
    expect(host.querySelector('img')).toBeNull()
  })

  it('does not resolve icon names inherited from Object.prototype', () => {
    expect(hostIcon('constructor')).toBe(Square)
    expect(hostIcon('__proto__')).toBe(Square)
    expect(hostIcon('hasOwnProperty')).toBe(Square)
    expect(hostIcon('toString')).toBe(Square)
  })

  it('draws a plain square, without throwing, for a button whose icon name shadows Object.prototype', () => {
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'a', place: 'action', label: { 'en-US': 'A' }, icon: 'constructor' }] }, null, () => undefined)
    expect(() => render(context(store), <HostButtons place="action" as="action" />)).not.toThrow()
    expect(host.querySelector('[data-kit-ui-id="host:a"] svg')).not.toBeNull()
  })

  it('omits aria-pressed when the host button does not say, and sets it when it does', () => {
    const store = createUiStore(
      {
        ...EMPTY_UI_CONFIG,
        add: [
          { id: 'a', place: 'action', label: { 'en-US': 'A' } },
          { id: 'b', place: 'action', label: { 'en-US': 'B' }, pressed: true },
        ],
      },
      null,
      () => undefined,
    )
    render(context(store), <HostButtons place="action" as="action" />)
    expect((host.querySelector('[data-kit-ui-id="host:a"]') as HTMLButtonElement).hasAttribute('aria-pressed')).toBe(false)
    expect((host.querySelector('[data-kit-ui-id="host:b"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('carries a data-kit-ui-id on a menu host button', () => {
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'go', place: 'menu:File', label: { 'en-US': 'Go' } }] }, null, () => undefined)
    render(context(store), <HostButtons place="menu:File" as="menu" />)
    expect(host.querySelector('[data-kit-ui-id="host:go"]')).not.toBeNull()
  })

  it('carries a data-kit-ui-id on a ribbon host button', () => {
    const store = createUiStore({ ...EMPTY_UI_CONFIG, add: [{ id: 'go', place: 'group:Home/Edit', label: { 'en-US': 'Go' } }] }, null, () => undefined)
    render(context(store), <HostButtons place="group:Home/Edit" as="ribbon" />)
    expect(host.querySelector('[data-kit-ui-id="host:go"]')).not.toBeNull()
  })
})
