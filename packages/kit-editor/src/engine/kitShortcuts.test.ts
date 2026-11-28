// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { RESERVED_SHORTCUTS, bindableShortcut, commandForShortcut, shortcutMatches } from './kitShortcuts'
import type { KitCommand } from './kitModule'

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

describe('Ctrl+ shortcuts off a Mac (Stage S of sheet usable by hand)', () => {
  const ctrlEnter = { key: 'Enter', code: 'Enter', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }
  const command = (id: string, shortcut: string) => ({ id, title: id, description: null, group: '', mutates: true, enabled: true, menu: [], shortcut }) as unknown as KitCommand

  it('are the Control key by default, which no key off a Mac matches; with primary, Ctrl', () => {
    expect(shortcutMatches('Ctrl+Enter', ctrlEnter, false)).toBe(false)
    expect(shortcutMatches('Ctrl+Enter', ctrlEnter, false, false, 'primary')).toBe(true)
    expect(shortcutMatches('Ctrl+Shift+Enter', ctrlEnter, false, false, 'primary')).toBe(false)
    // On a Mac Ctrl stays the Control key either way.
    expect(shortcutMatches('Ctrl+Enter', ctrlEnter, true, false, 'primary')).toBe(true)
    expect(shortcutMatches('Ctrl+Enter', { ...ctrlEnter, metaKey: true }, true, false, 'primary')).toBe(false)
    // A shortcut with both stays unpressable off a Mac.
    expect(shortcutMatches('Ctrl+Cmd+V', { ...ctrlEnter, key: 'v', code: 'KeyV' }, false, false, 'primary')).toBe(false)
  })

  it('lose to a Cmd+ shortcut of the same key', () => {
    const commands = [command('range.fill', 'Ctrl+Enter'), command('edit.fill', 'Cmd+Enter')]
    expect(commandForShortcut(commands, ctrlEnter, false, 'primary')?.id).toBe('edit.fill')
    expect(commandForShortcut([commands[0]], ctrlEnter, false, 'primary')?.id).toBe('range.fill')
    expect(commandForShortcut([commands[0]], ctrlEnter, false)).toBeUndefined()
  })
})
