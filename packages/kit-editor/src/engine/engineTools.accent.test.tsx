// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { useThemeAccent } from './engineTools'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => document.documentElement.style.removeProperty('--kit-primary'))

/** Overlays (the marquee, a selected swatch) take the kit's brand, and follow a theme change. */
it('the overlay accent follows --kit-primary', async () => {
  document.documentElement.style.setProperty('--kit-primary', '#1a8641')
  let accent: string | null = null
  function Probe() {
    accent = useThemeAccent()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  expect(accent).toBe('#1a8641')
  await act(async () => {
    document.documentElement.style.setProperty('--kit-primary', '#4fd17b')
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(accent).toBe('#4fd17b')
  await act(async () => root.unmount())
})
