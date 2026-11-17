import { describe, expect, it } from 'vitest'
import { createAgentRelay } from '../src/agentRelay'

describe('createAgentRelay', () => {
  it('hands the agent’s requests to the page and the page’s replies back, renumbered', async () => {
    const relay = createAgentRelay()
    expect(relay.connected()).toBe(false)
    const first = relay.request({ jsonrpc: '2.0', id: 'a', method: 'tools/list' })
    const second = relay.request({ jsonrpc: '2.0', id: 'a', method: 'ping' })
    const taken = [await relay.next(), await relay.next()]
    expect(relay.connected()).toBe(true)
    expect(taken.map((message) => message?.method)).toEqual(['tools/list', 'ping'])
    expect(new Set(taken.map((message) => message?.id)).size).toBe(2)
    relay.reply({ jsonrpc: '2.0', id: taken[1]!.id, result: {} })
    relay.reply({ jsonrpc: '2.0', id: taken[0]!.id, result: { tools: [] } })
    expect(await first).toEqual({ jsonrpc: '2.0', id: 'a', result: { tools: [] } })
    expect(await second).toEqual({ jsonrpc: '2.0', id: 'a', result: {} })
  })

  it('passes notifications on without a reply, and waits for a page that is not there yet', async () => {
    const relay = createAgentRelay()
    expect(await relay.request({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect((await relay.next())?.method).toBe('notifications/initialized')
    const waiting = relay.next({ waitMs: 1000 })
    const asked = relay.request({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const message = await waiting
    relay.reply({ jsonrpc: '2.0', id: message!.id, result: {} })
    expect(await asked).toMatchObject({ id: 1, result: {} })
    expect(await relay.next({ waitMs: 5 })).toBeNull()
  })

  it('rejects a request no page takes in time, and everything once closed', async () => {
    const relay = createAgentRelay()
    await expect(relay.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { timeoutMs: 5 })).rejects.toThrow(/in time/)
    expect(await relay.next({ waitMs: 5 })).toBeNull()
    const pending = relay.request({ jsonrpc: '2.0', id: 2, method: 'ping' })
    relay.close()
    await expect(pending).rejects.toThrow(/closed/)
    await expect(relay.request({ jsonrpc: '2.0', id: 3, method: 'ping' })).rejects.toThrow(/closed/)
  })
  it('stops waiting on a page whose connection closed, and gives its message to the next page', async () => {
    const relay = createAgentRelay()
    const gone = new AbortController()
    const dead = relay.next({ waitMs: 1000, signal: gone.signal })
    gone.abort()
    expect(await dead).toBeNull()
    const asked = relay.request({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const message = await relay.next({ waitMs: 1000 })
    expect(message?.method).toBe('ping')
    relay.reply({ jsonrpc: '2.0', id: message!.id, result: {} })
    expect(await asked).toMatchObject({ id: 1 })
  })
})
