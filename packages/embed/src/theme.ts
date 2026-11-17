/**
 * The Kit UI protocol's theme (protocol section 4) from an integrator's `EmbedTheme`: the tokens
 * it sets over the defaults for its color scheme, so a kit always has every token it styles with.
 */
import type { KitTheme } from '@kition/kit-ui-protocol'
import type { EmbedTheme } from './types'

const SHARED = {
  '--kit-font-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--kit-font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  '--kit-primary-text': '#ffffff',
  '--kit-danger': '#e03131',
  '--kit-radius-control': '8px',
  '--kit-radius-card': '12px',
}

const DEFAULT_TOKENS: Record<KitTheme['colorScheme'], Record<string, string>> = {
  light: {
    ...SHARED,
    '--kit-surface': '#ffffff',
    '--kit-surface-muted': '#fafaf9',
    '--kit-canvas': '#f6f5f4',
    '--kit-text': '#1a1a1a',
    '--kit-text-muted': '#5d5b54',
    '--kit-border': '#e5e3df',
    '--kit-primary': '#5645d4',
    '--kit-primary-soft': 'rgba(86, 69, 212, 0.1)',
    '--kit-shadow-card': '0 1px 2px rgba(15, 15, 15, 0.06), 0 4px 16px rgba(15, 15, 15, 0.06)',
  },
  dark: {
    ...SHARED,
    '--kit-surface': '#1b1e23',
    '--kit-surface-muted': '#22262c',
    '--kit-canvas': '#15171b',
    '--kit-text': '#eceff1',
    '--kit-text-muted': '#a9b0ba',
    '--kit-border': '#33373e',
    '--kit-primary': '#8b7ff0',
    '--kit-primary-soft': 'rgba(139, 127, 240, 0.16)',
    '--kit-shadow-card': '0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.3)',
  },
}

export function kitTheme(theme: EmbedTheme | undefined): KitTheme {
  const colorScheme = theme?.colorScheme === 'dark' ? 'dark' : 'light'
  return { colorScheme, tokens: { ...DEFAULT_TOKENS[colorScheme], ...theme?.tokens }, ...(theme?.brand ? { brand: theme.brand } : {}) }
}
