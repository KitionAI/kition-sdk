import { describe, expect, it } from 'vitest'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'

describe('the UI store', () => {
  it('replaces the configuration and tells its listeners', () => {
    const store = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)
    let heard = 0
    const stop = store.subscribe(() => (heard += 1))
    store.replace({ ...EMPTY_UI_CONFIG, hide: ['menu:Help'] })
    expect(store.get().hide).toEqual(['menu:Help'])
    expect(heard).toBe(1)
    stop()
    store.replace(EMPTY_UI_CONFIG)
    expect(heard).toBe(1)
  })

  it('applies personal hides at once, then has the host keep them', async () => {
    const kept: string[][] = []
    const store = createUiStore(EMPTY_UI_CONFIG, async (hide) => void kept.push(hide), () => undefined)
    expect(store.customizable).toBe(true)
    await store.setPersonal(['panel:history', 'panel:history', 'tool:Brush'])
    expect(store.get().personal).toEqual(['panel:history', 'tool:Brush'])
    expect(kept).toEqual([['panel:history', 'tool:Brush']])
  })

  it('keeps a personal hide for the session when the host fails to keep it', async () => {
    const store = createUiStore(EMPTY_UI_CONFIG, async () => {
      throw new Error('disk full')
    }, () => undefined)
    await expect(store.setPersonal(['panel:history'])).rejects.toThrow('disk full')
    expect(store.get().personal).toEqual(['panel:history'])
  })

  it('applies personal hides without a host that keeps them', async () => {
    const store = createUiStore(EMPTY_UI_CONFIG, null, () => undefined)
    expect(store.customizable).toBe(false)
    await store.setPersonal(['panel:history'])
    expect(store.get().personal).toEqual(['panel:history'])
  })

  it('keeps a pending personal hide through a host reconfigure', async () => {
    let resolveCustomize: (() => void) | undefined
    const store = createUiStore(
      EMPTY_UI_CONFIG,
      () => new Promise<void>((resolve) => void (resolveCustomize = resolve)),
      () => undefined,
    )
    const setting = store.setPersonal(['panel:history'])
    store.replace({ ...EMPTY_UI_CONFIG, hide: ['menu:Help'], personal: [] })
    expect(store.get().hide).toEqual(['menu:Help'])
    expect(store.get().personal).toEqual(['panel:history'])
    resolveCustomize?.()
    await setting
    store.replace({ ...EMPTY_UI_CONFIG, personal: ['tool:Brush'] })
    expect(store.get().personal).toEqual(['tool:Brush'])
  })

  it('reports host button presses', () => {
    const pressed: unknown[] = []
    const store = createUiStore(EMPTY_UI_CONFIG, null, (params) => pressed.push(params))
    store.action({ id: 'submit', document: { path: 'a.psd', dirty: false, revision: 3 } })
    expect(pressed).toEqual([{ id: 'submit', document: { path: 'a.psd', dirty: false, revision: 3 } }])
  })
})
