// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { ROOMS_KEY, RoomRecords, fromHex, localState, toHex, type RoomRecord } from '../src/rooms'
import type { EmbedState } from '../src/types'

const record: RoomRecord = { docId: 'd1', fileId: 'f1', kit: 'kit.note', role: 'owner', shareLink: 'https://sync.test/s/d1' }

describe('room records', () => {
  beforeEach(() => localStorage.clear())

  it('keeps them in one localStorage entry by default', async () => {
    const records = new RoomRecords(localState())
    await records.write(record)
    await records.update('d1', { lastSent: 'ab', seen: { seq: 3, version: 'ab' } })
    expect(JSON.parse(localStorage.getItem(ROOMS_KEY)!)).toEqual({ d1: { ...record, lastSent: 'ab', seen: { seq: 3, version: 'ab' } } })
    expect(await new RoomRecords(localState()).read('d1')).toMatchObject({ role: 'owner', seen: { seq: 3 } })
  })

  it('uses the integrator’s state, asynchronous or not, and keeps every update', async () => {
    const values = new Map<string, unknown>()
    const state: EmbedState = {
      get: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return values.get(key) ?? null
      },
      set: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        values.set(key, structuredClone(value))
      },
    }
    const records = new RoomRecords(state)
    await records.write(record)
    await Promise.all([records.update('d1', { lastSent: '01' }), records.update('d1', { seen: { seq: 1, version: '01' } }), records.update('d1', { role: 'viewer' })])
    expect(await records.read('d1')).toEqual({ ...record, lastSent: '01', seen: { seq: 1, version: '01' }, role: 'viewer' })
    expect(localStorage.getItem(ROOMS_KEY)).toBeNull()
  })

  it('ignores what is not a record of that room, and updates only existing records', async () => {
    localStorage.setItem(ROOMS_KEY, JSON.stringify({ d1: { docId: 'd2', fileId: 'f1', kit: 'kit.note', role: 'owner' }, d3: { docId: 'd3', role: 'admin' } }))
    const records = new RoomRecords(localState())
    expect(await records.read('d1')).toBeNull()
    expect(await records.read('d3')).toBeNull()
    await records.update('d4', { role: 'editor' })
    expect(await records.read('d4')).toBeNull()
    localStorage.setItem(ROOMS_KEY, 'not json')
    expect(await records.read('d1')).toBeNull()
  })

  it('works in memory without localStorage', async () => {
    const records = new RoomRecords(localState(null))
    await records.write(record)
    expect(await records.read('d1')).toEqual(record)
  })

  it('writes versions as hex', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff')
    expect(fromHex('000fff')).toEqual(new Uint8Array([0, 15, 255]))
    expect(fromHex('0g')).toEqual(new Uint8Array())
    expect(fromHex(undefined)).toEqual(new Uint8Array())
  })
})
