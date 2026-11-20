import type { KitTheme } from '@kition/kit-host'

/** The page's two schemes, as the kit's theme tokens (Kit UI protocol `ui/theme`). */
const THEMES: Record<'light' | 'dark', KitTheme> = {
  light: {
    colorScheme: 'light',
    tokens: {
      '--kit-primary': '#5645d4',
      '--kit-surface': '#ffffff',
      '--kit-surface-muted': '#fafaf9',
      '--kit-canvas': '#f6f5f4',
      '--kit-text': '#1a1a1a',
      '--kit-text-muted': '#5d5b54',
      '--kit-border': '#e5e3df',
    },
  },
  dark: {
    colorScheme: 'dark',
    tokens: {
      '--kit-primary': '#8b7ff0',
      '--kit-surface': '#1b1e23',
      '--kit-surface-muted': '#22262c',
      '--kit-canvas': '#15171b',
      '--kit-text': '#eceff1',
      '--kit-text-muted': '#a9b0ba',
      '--kit-border': '#33373e',
    },
  },
}

export type Scheme = 'light' | 'dark'

let scheme: Scheme = 'light'

export const currentScheme = () => scheme

export function kitTheme(): KitTheme {
  return THEMES[scheme]
}

/** `light` or `dark` from a `theme` parameter, else the system's preference. */
export function schemeFrom(value: string | null): Scheme {
  if (value === 'light' || value === 'dark') return value
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function setScheme(next: Scheme) {
  scheme = next
  document.documentElement.dataset.theme = next
  document.documentElement.style.colorScheme = next
}
