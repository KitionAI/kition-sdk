// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { RESERVED_SHORTCUTS, bindableShortcut, shortcutMatches } from './kitShortcuts'

describe('reserved shortcuts', () => {
  it("names Kition's own keys, which no kit command takes", () => {
    for (const shortcut of ['Cmd+N', 'Cmd+W', 'Cmd+O', 'Cmd+P', 'Cmd+Q', 'Cmd+,', 'Cmd+S', 'Cmd+Shift+S', 'Cmd+T', 'Cmd+.']) {
      expect(RESERVED_SHORTCUTS.has(shortcut)).toBe(true)
      expect(bindableShortcut(shortcut)).toBe(false)
    }
    expect(bindableShortcut('Cmd+K')).toBe(true)
    expect(bindableShortcut('K')).toBe(false)
  })

  it('matches a key event the way a kit writes the shortcut', () => {
    const event = { key: 'w', code: 'KeyW', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    expect(shortcutMatches('Cmd+W', event, true)).toBe(true)
    expect(shortcutMatches('Cmd+W', event, false)).toBe(false)
  })
})
