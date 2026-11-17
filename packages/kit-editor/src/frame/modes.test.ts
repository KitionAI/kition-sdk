// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DISPLAY_MODES, LINE_MIN_WIDTH, NO_MODE_RULES, allowedModes, chosenMode, isDisplayMode, modeStorageKey, readStoredMode, stepDown, validDisplay, writeStoredMode } from './modes'

beforeEach(() => localStorage.clear())

describe('display modes', () => {
  it('knows the four modes, and which a kit may default to', () => {
    expect(DISPLAY_MODES).toEqual(['menus', 'line', 'classic', 'focus'])
    expect(['menus', 'focus', 'ribbon', 3].map(isDisplayMode)).toEqual([true, true, false, false])
    expect(['line', 'focus', undefined].map(validDisplay)).toEqual(['line', null, null])
  })

  it('allows every mode unless the host lists some, in the modes order', () => {
    expect(allowedModes(NO_MODE_RULES)).toEqual(DISPLAY_MODES)
    expect(allowedModes({ allowed: [], default: null })).toEqual(DISPLAY_MODES)
    expect(allowedModes({ allowed: ['classic', 'menus'], default: null })).toEqual(['menus', 'classic'])
  })

  it('opens in the stored choice, else the host preset, else Menus when read-only, else the kit default, else Single line', () => {
    const base = { stored: null, rules: NO_MODE_RULES, kit: null, readOnly: false }
    expect(chosenMode(base)).toBe('line')
    expect(chosenMode({ ...base, kit: 'menus' })).toBe('menus')
    expect(chosenMode({ ...base, kit: 'classic', readOnly: true })).toBe('menus')
    expect(chosenMode({ ...base, kit: 'menus', rules: { allowed: null, default: 'classic' } })).toBe('classic')
    expect(chosenMode({ ...base, stored: 'line', rules: { allowed: null, default: 'classic' } })).toBe('line')
    // A stored or preset mode the host does not allow is skipped.
    expect(chosenMode({ ...base, stored: 'line', kit: 'line', rules: { allowed: ['menus', 'classic'], default: 'classic' } })).toBe('classic')
    // Focus is never the base mode: a Focus preset falls through to the kit's default.
    expect(chosenMode({ ...base, kit: 'classic', rules: { allowed: null, default: 'focus' } })).toBe('classic')
    expect(chosenMode({ ...base, rules: { allowed: ['focus'], default: null } })).toBe('menus')
  })

  it('stores Menus, Single line, or Classic per kit, and reads nothing else', () => {
    expect(modeStorageKey('kit.doc')).toBe('kui.mode.kit.doc')
    writeStoredMode('kit.doc', 'classic')
    expect(localStorage.getItem('kui.mode.kit.doc')).toBe('classic')
    expect(readStoredMode('kit.doc')).toBe('classic')
    expect(readStoredMode('kit.sheet')).toBeNull()
    localStorage.setItem('kui.mode.kit.sheet', 'focus')
    expect(readStoredMode('kit.sheet')).toBeNull()
  })

  it('steps down Classic, Single line, Menus while a mode does not fit, skipping modes the host does not allow', () => {
    const all = DISPLAY_MODES
    expect(stepDown('classic', 1440, {}, all)).toBe('classic')
    expect(stepDown('classic', LINE_MIN_WIDTH - 1, {}, all)).toBe('menus')
    expect(stepDown('classic', 1000, { classic: 1300 }, all)).toBe('line')
    expect(stepDown('classic', 1000, { classic: 1300, line: 1100 }, all)).toBe('menus')
    expect(stepDown('line', 1300, { classic: 1200 }, all)).toBe('line')
    expect(stepDown('classic', 1000, { classic: 1300 }, ['menus', 'classic', 'focus'])).toBe('menus')
    // Nothing fits and Menus is not allowed: the lowest allowed mode, which scrolls.
    expect(stepDown('classic', 500, {}, ['line', 'classic'])).toBe('line')
    expect(stepDown('classic', 500, {}, ['classic'])).toBe('classic')
  })
})
