import { describe, expect, it } from 'vitest'
import { pressureOf } from './KitCanvas'

describe('pressureOf', () => {
  it('gives every pointer but a pen full pressure, whatever the browser reports', () => {
    expect(pressureOf({ pointerType: 'mouse', pressure: 0.5 })).toBe(1)
    expect(pressureOf({ pointerType: 'mouse', pressure: 0 })).toBe(1)
    expect(pressureOf({ pointerType: 'touch', pressure: 0.3 })).toBe(1)
    expect(pressureOf({ pointerType: '', pressure: 0.2 })).toBe(1)
    expect(pressureOf({ pressure: 0.4 })).toBe(1)
  })

  it("keeps a pen's pressure", () => {
    expect(pressureOf({ pointerType: 'pen', pressure: 0.3 }, 0.8)).toBe(0.3)
  })

  it("gives a pen sample without pressure the stroke's last one, and 1 at its first", () => {
    expect(pressureOf({ pointerType: 'pen', pressure: 0 }, 0.6)).toBe(0.6)
    expect(pressureOf({ pointerType: 'pen', pressure: 0 })).toBe(1)
  })
})
