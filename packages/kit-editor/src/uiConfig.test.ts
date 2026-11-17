import { describe, expect, it } from 'vitest'
import { KitRpcError } from '@kition/kit-ui-protocol'
import { EMPTY_UI_CONFIG, agentCommands, buttonLabel, buttonsAt, idsFor, matches, notAllowed, parseUiConfig, refusedStep, uiState, type UiConfig } from './uiConfig'

const config = (partial: Partial<UiConfig>): UiConfig => ({ ...EMPTY_UI_CONFIG, ...partial })

describe('parseUiConfig', () => {
  it('keeps valid entries and drops invalid ones one by one', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig(
      {
        hide: ['menu:Help', 'nonsense', 3, 'command:file.export.*'],
        disable: 'action:save',
        add: [
          { id: 'submit', place: 'action', label: { 'en-US': 'Submit' } },
          { id: 'bad', place: 'ribbon', label: { 'en-US': 'Bad' } },
          { id: 'nolabel', place: 'action', label: {} },
        ],
        personal: { hide: ['panel:history'] },
      },
      (message) => warnings.push(message),
    )
    expect(parsed.hide).toEqual(['menu:Help', 'command:file.export.*'])
    expect(parsed.disable).toEqual([])
    expect(parsed.add).toEqual([{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' }, icon: undefined, shortcut: undefined, disabled: undefined, pressed: undefined }])
    expect(parsed.personal).toEqual(['panel:history'])
    expect(warnings).toHaveLength(5)
  })

  it('answers the empty configuration for nothing or a non-object', () => {
    expect(parseUiConfig(undefined)).toEqual(EMPTY_UI_CONFIG)
    expect(parseUiConfig(['menu:Help'], () => undefined)).toEqual(EMPTY_UI_CONFIG)
  })

  it('freezes the empty configuration', () => {
    expect(Object.isFrozen(EMPTY_UI_CONFIG)).toBe(true)
    expect(Object.isFrozen(EMPTY_UI_CONFIG.hide)).toBe(true)
    expect(Object.isFrozen(EMPTY_UI_CONFIG.add)).toBe(true)
  })

  it('never throws on unstringifiable input, and still warns', () => {
    const warnings: string[] = []
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => parseUiConfig({ hide: [10n], add: [circular] }, (message) => warnings.push(message))).not.toThrow()
    expect(warnings).toContain('ui.hide: bigint is not an element id')
    expect(warnings).toContain('ui.add: object is not a valid button')
  })

  it('drops a button whose label is not a plain object of non-empty strings', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig(
      {
        add: [
          { id: 'a', place: 'action', label: ['Go'] },
          { id: 'b', place: 'action', label: { 'en-US': '' } },
        ],
      },
      (message) => warnings.push(message),
    )
    expect(parsed.add).toEqual([])
    expect(warnings).toHaveLength(2)
  })

  it('drops a button whose id repeats an earlier one', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig(
      {
        add: [
          { id: 'submit', place: 'action', label: { 'en-US': 'Submit' } },
          { id: 'submit', place: 'action', label: { 'en-US': 'Again' } },
        ],
      },
      (message) => warnings.push(message),
    )
    expect(parsed.add).toEqual([{ id: 'submit', place: 'action', label: { 'en-US': 'Submit' }, icon: undefined, shortcut: undefined, disabled: undefined, pressed: undefined }])
    expect(warnings).toContain('ui.add: duplicate button id "submit"')
  })

  it('keeps a pattern with * only at the end, and drops one with * in the middle', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig({ hide: ['command:file.*', 'command:file.*.png'] }, (message) => warnings.push(message))
    expect(parsed.hide).toEqual(['command:file.*'])
    expect(warnings).toEqual(['ui.hide: "command:file.*.png" is not an element id'])
  })

  it('warns when personal is present but not an object', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig({ personal: 'nonsense' }, (message) => warnings.push(message))
    expect(parsed.personal).toEqual([])
    expect(warnings).toEqual(['ui.personal is not an object'])
  })
})

describe('matching', () => {
  it('matches an id or a prefix ending in *', () => {
    expect(matches('command:file.export.*', 'command:file.export.png')).toBe(true)
    expect(matches('command:file.export.*', 'command:file.exportAll')).toBe(false)
    expect(matches('menu:Help', 'menu:Help')).toBe(true)
  })

  it('names a command by its menus, and undo and redo by their actions', () => {
    expect(idsFor('command:filter.blur.gaussianBlur', ['Filter', 'Blur'])).toEqual(['command:filter.blur.gaussianBlur', 'menu:Filter', 'menu:Filter/Blur'])
    expect(idsFor('menu:Filter/Blur')).toEqual(['menu:Filter/Blur', 'menu:Filter'])
    expect(idsFor('command:edit.undo')).toEqual(['command:edit.undo', 'action:undo'])
  })
})

describe('uiState', () => {
  it('hides a command under a hidden menu and denies it', () => {
    const state = uiState(config({ hide: ['menu:Filter'] }), 'command:filter.blur.gaussianBlur', ['Filter', 'Blur'])
    expect(state).toMatchObject({ hidden: true, hostHidden: true, denied: true, disabled: false })
  })

  it('disables without hiding, and denies', () => {
    expect(uiState(config({ disable: ['action:save'] }), 'action:save')).toMatchObject({ hidden: false, disabled: true, denied: true })
  })

  it('lets a personal hide change drawing only', () => {
    expect(uiState(config({ personal: ['panel:history'] }), 'panel:history')).toMatchObject({ hidden: true, personalHidden: true, denied: false })
  })

  it('counts a host hide before a personal one', () => {
    expect(uiState(config({ hide: ['tool:Brush'], personal: ['tool:Brush'] }), 'tool:Brush')).toMatchObject({ hostHidden: true, personalHidden: false })
  })

  it('denies undo when its action is hidden', () => {
    expect(uiState(config({ hide: ['action:undo'] }), 'command:edit.undo').denied).toBe(true)
  })

  it('never lets a personal hide take More away, the way back to Customize', () => {
    expect(uiState(config({ personal: ['action:more'] }), 'action:more').hidden).toBe(false)
    expect(uiState(config({ personal: ['action:*'] }), 'action:more').hidden).toBe(false)
    expect(uiState(config({ personal: ['action:*'] }), 'action:save').hidden).toBe(true)
    expect(uiState(config({ hide: ['action:more'] }), 'action:more').hidden).toBe(true)
  })
})

describe('host buttons', () => {
  const button = { id: 'submit', place: 'action', label: { 'en-US': 'Submit', zh: 'Z' }, disabled: false, pressed: false }
  it('finds buttons by place and labels them by locale', () => {
    expect(buttonsAt(config({ add: [button] }), 'action')).toEqual([button])
    expect(buttonsAt(config({ add: [button] }), 'menu:File')).toEqual([])
    expect(buttonLabel(button, 'zh-CN')).toBe('Z')
    expect(buttonLabel(button, 'fr-FR')).toBe('Submit')
    expect(buttonLabel({ ...button, label: { de: 'X' } }, 'fr-FR')).toBe('submit')
  })

  it('looks labels up by own property, so a locale named like an object method falls back', () => {
    expect(buttonLabel(button, 'constructor')).toBe('Submit')
    expect(buttonLabel(button, 'toString-x')).toBe('Submit')
    expect(buttonLabel({ ...button, label: { de: 'X' } }, '__proto__')).toBe('submit')
  })
})

describe('the agent', () => {
  const commands = [
    { id: 'file.export.png', title: 'PNG', description: null, group: 'file', mutates: false, enabled: true, menu: ['File', 'Export'], shortcut: null },
    { id: 'image.crop', title: 'Crop', description: null, group: 'image', mutates: true, enabled: true, menu: ['Image'], shortcut: null },
    { id: 'layer.select', title: 'Select Layer', description: null, group: 'layer', mutates: false, enabled: true, menu: [], shortcut: null },
  ]
  const menuOf = (id: string) => commands.find((command) => command.id === id)?.menu ?? []

  it('finds the first refused step before any runs', () => {
    const steps = [{ command: 'image.crop' }, { command: 'file.export.png' }]
    expect(refusedStep(config({ hide: ['menu:File/Export'] }), steps, menuOf)).toBe(1)
    expect(refusedStep(config({}), steps, menuOf)).toBe(-1)
  })

  it('omits host-hidden commands and lists host-disabled ones as not enabled', () => {
    const listed = agentCommands(config({ hide: ['command:file.*'], disable: ['command:image.crop'], personal: ['command:layer.select'] }), commands)
    expect(listed.map((command) => [command.id, command.enabled])).toEqual([
      ['image.crop', false],
      ['layer.select', true],
    ])
  })

  it('refuses with the not-allowed reason', () => {
    const error = notAllowed('image.crop', 2)
    expect(error).toBeInstanceOf(KitRpcError)
    expect(error.code).toBe(-32000)
    expect(error.message).toBe('step 2 (`image.crop`) is not allowed in this editor')
    expect(error.data).toEqual({ reason: 'not-allowed', command: 'image.crop', step: 2 })
    const direct = notAllowed('image.crop')
    expect(direct.message).toBe('`image.crop` is not allowed in this editor')
    expect(direct.data).toEqual({ reason: 'not-allowed', command: 'image.crop' })
  })
})

describe('display modes', () => {
  it('keeps the allowed modes and the default, dropping what is not a mode', () => {
    const warnings: string[] = []
    const parsed = parseUiConfig({ modes: { allowed: ['menus', 'ribbon', 'focus'], default: 'line' } }, (message) => warnings.push(message))
    expect(parsed.modes).toEqual({ allowed: ['menus', 'focus'], default: 'line' })
    expect(warnings).toEqual(['ui.modes.allowed: "ribbon" is not a display mode'])
  })

  it('allows every mode when the list is absent, empty, or not a list', () => {
    expect(parseUiConfig({}).modes).toEqual({ allowed: null, default: null })
    expect(parseUiConfig({ modes: { allowed: [] } }).modes.allowed).toBeNull()
    const warnings: string[] = []
    expect(parseUiConfig({ modes: { allowed: 'menus', default: 'wide' } }, (message) => warnings.push(message)).modes).toEqual({ allowed: null, default: null })
    expect(warnings).toEqual(['ui.modes.allowed is not a list', 'ui.modes.default: "wide" is not a display mode'])
  })

  it('ignores modes that are not an object', () => {
    const warnings: string[] = []
    expect(parseUiConfig({ modes: 'line' }, (message) => warnings.push(message)).modes).toEqual({ allowed: null, default: null })
    expect(warnings).toEqual(['ui.modes is not an object'])
  })
})
