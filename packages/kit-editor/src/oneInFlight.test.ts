// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { oneInFlight } from './oneInFlight'

/** A read whose calls finish only when the test lets them. */
function gatedRead() {
  const calls: Array<() => void> = []
  const read = () => new Promise<void>((resolve) => calls.push(resolve))
  return { read, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('oneInFlight', () => {
  it('runs one read at a time, and once more after it however many asks came meanwhile', async () => {
    const { read, calls } = gatedRead()
    const ask = oneInFlight(read)
    void ask()
    void ask()
    void ask()
    await tick()
    expect(calls).toHaveLength(1)
    calls[0]()
    await tick()
    expect(calls).toHaveLength(2)
    calls[1]()
    await tick()
    expect(calls).toHaveLength(2)
  })

  it('answers every ask when the read that covers it has finished', async () => {
    const { read, calls } = gatedRead()
    const ask = oneInFlight(read)
    let first = false
    let second = false
    void ask().then(() => (first = true))
    void ask().then(() => (second = true))
    await tick()
    calls[0]()
    await tick()
    expect(second).toBe(false)
    calls[1]()
    await tick()
    expect(first && second).toBe(true)
  })

  it('reports a failed read and keeps reading', async () => {
    const errors: unknown[] = []
    let count = 0
    const ask = oneInFlight(async () => {
      count += 1
      if (count === 1) throw new Error('refused')
    }, (error) => errors.push(error))
    await ask()
    await ask()
    expect(count).toBe(2)
    expect(errors).toHaveLength(1)
  })
})
