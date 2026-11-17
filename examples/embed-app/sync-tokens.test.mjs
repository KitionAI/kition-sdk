import { verify, createPublicKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { issueToken, localSigner, tokenRequest } from './sync-tokens.mjs'

// A fake test seed (32 bytes of 0x05), the one kition-console's and kition-server's sync token tests use.
const SEED = Buffer.alloc(32, 5)
const NOW = 1_800_000_000

function claimsOf(token) {
  const [, segment] = token.split('.')
  return JSON.parse(Buffer.from(segment, 'base64url').toString())
}

describe('the example sync token route', () => {
  it('signs a token Kition Server verifies, keys sorted, with the self-hosted issuer', async () => {
    const signer = localSigner(SEED, 'test-sync-1')
    const answer = await issueToken({ user: { id: 'ann', name: 'Ann' }, documents: ['0192f2d4-7b1a-4c6e-9f10-3a5b6c7d8e9f'], role: 'viewer', ttl: 600 }, { KITION_SYNC_TENANT: 'acme' }, signer, () => NOW)
    expect(answer).toMatchObject({ tenant: 'acme', expires: NOW + 600, url: 'ws://127.0.0.1:18300/v1/t/acme' })
    expect(answer.token.startsWith('ks1.')).toBe(true)
    const [, segment, signature] = answer.token.split('.')
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signer.publicKey }, format: 'jwk' })
    expect(verify(null, Buffer.from(segment), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
    const claims = claimsOf(answer.token)
    expect(Object.keys(claims)).toEqual([...Object.keys(claims)].sort())
    expect(claims).toMatchObject({ v: 1, typ: 'kition-sync', kid: 'test-sync-1', iss: 'self', tenant: 'acme', sub: 'ann', role: 'viewer', iat: NOW, exp: NOW + 600 })
    // The same seed gives the public key kition-server's tests configure.
    expect(signer.publicKey).toBe(localSigner(SEED).publicKey)
  })

  it('clamps the lifetime to Kition Server’s bounds', async () => {
    const signer = localSigner(SEED)
    expect((await issueToken({ user: { id: 'ann' }, ttl: 86_400 }, {}, signer, () => NOW)).expires).toBe(NOW + 3600)
    expect((await issueToken({ user: { id: 'ann' }, ttl: 1 }, {}, signer, () => NOW)).expires).toBe(NOW + 60)
  })

  it('exchanges the tenant at Console when one is configured, the secret in the header only', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { token: 'ks1.a.b', expires: NOW + 900, tenant: 'acme', url: 'wss://sync.example.com/v1/t/acme' } })))
    vi.stubGlobal('fetch', fetch)
    const env = { KITION_SYNC_EXCHANGE: 'https://console.example.com/api/sdk/sync-tokens', KITION_SYNC_SECRET: 'kss_test', KITION_SYNC_TENANT: 'acme' }
    const answer = await issueToken({ user: { id: 'ann', name: 'Ann' }, documents: '*', role: 'editor' }, env)
    expect(answer.url).toBe('wss://sync.example.com/v1/t/acme')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(env.KITION_SYNC_EXCHANGE)
    expect(init.headers.authorization).toBe('Bearer kss_test')
    expect(JSON.parse(init.body)).toEqual({ tenant: 'acme', user: { id: 'ann', name: 'Ann' }, documents: '*', role: 'editor', ttl: 900 })
    vi.unstubAllGlobals()
  })

  it('refuses what it should not pass on', () => {
    expect(() => tokenRequest({})).toThrow(/user.id/)
    expect(() => tokenRequest({ user: { id: 'ann' }, role: 'admin' })).toThrow(/role/)
    expect(() => tokenRequest({ user: { id: 'ann' }, documents: [] })).toThrow(/documents/)
  })
})
