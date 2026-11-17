import { describe, expect, it } from 'vitest'
import { capabilitySetsOf, parseCapabilitySet, servesCapabilitySet } from '../src/capabilities'

describe('capability sets in sync/hello', () => {
  it('tells capability sets from protocol capabilities', () => {
    expect(parseCapabilitySet('KitCollab 1.2')).toEqual({ name: 'KitCollab', major: 1, minor: 2 })
    expect(parseCapabilitySet('leases')).toBeNull()
    expect(parseCapabilitySet('kitCollab 1.0')).toBeNull()
    expect(capabilitySetsOf(['leases', 'KitModel 1.0', 'headless', 'KitCollab 1.1'])).toEqual(['KitModel 1.0', 'KitCollab 1.1'])
  })

  it('serves a request for the same name and major version up to its minor version', () => {
    const sets = ['KitModel 1.0', 'KitCollab 1.1']
    expect(servesCapabilitySet('KitCollab 1.0', sets)).toBe(true)
    expect(servesCapabilitySet('KitCollab 1.1', sets)).toBe(true)
    expect(servesCapabilitySet('KitCollab 1.2', sets)).toBe(false)
    expect(servesCapabilitySet('KitCollab 2.0', sets)).toBe(false)
    expect(servesCapabilitySet('KitEmbed 1.0', sets)).toBe(false)
    expect(servesCapabilitySet('nonsense', sets)).toBe(false)
  })
})
