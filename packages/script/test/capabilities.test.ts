import { afterEach, describe, expect, it } from 'vitest'
import { advertiseCapabilitySets, CAPABILITY_SETS, capabilitySets, supports } from '../src/index'

describe('capability sets', () => {
  afterEach(() => advertiseCapabilitySets([CAPABILITY_SETS.model, CAPABILITY_SETS.objectModel]))

  it('serves the model and the object model by itself', () => {
    expect(supports('KitModel 1.0')).toBe(true)
    expect(supports('KitModel 1.1')).toBe(true)
    expect(supports('KitObjectModel 1.0')).toBe(true)
    expect(supports('KitCollab 1.0')).toBe(false)
  })

  it('tests what a host or a server advertised', () => {
    advertiseCapabilitySets(['KitModel 1.0', 'KitCollab 1.2'])
    expect(capabilitySets()).toEqual(['KitModel 1.0', 'KitCollab 1.2'])
    expect(supports('KitCollab 1.0')).toBe(true)
    expect(supports('KitCollab 1.2')).toBe(true)
    expect(supports('KitCollab 1.3')).toBe(false)
    expect(supports('KitCollab 2.0')).toBe(false)
  })

  it('tests a given list, and never a malformed name', () => {
    expect(supports('KitEmbed 1.0', ['KitEmbed 1.1', 'sync'])).toBe(true)
    expect(supports('KitEmbed', ['KitEmbed 1.1'])).toBe(false)
    expect(supports('KitEmbed 1.0', ['KitEmbed'])).toBe(false)
  })
})
