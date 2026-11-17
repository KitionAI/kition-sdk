import { describe, expect, it } from 'vitest'
import { SyncRpcError } from '../src/protocol'

describe('sync errors', () => {
  it('reads the limit a collab-limit error names', () => {
    const full = new SyncRpcError(-32000, 'co-editing is limited to 5 people on this server', { code: 'collab-limit', limit: 5 })
    expect(full.reason).toBe('collab-limit')
    expect(full.collabLimit).toBe(5)
    expect(new SyncRpcError(-32000, 'slow down', { code: 'rate-limited', limit: 5 }).collabLimit).toBeUndefined()
    expect(new SyncRpcError(-32000, 'full', { code: 'collab-limit' }).collabLimit).toBeUndefined()
  })
})
