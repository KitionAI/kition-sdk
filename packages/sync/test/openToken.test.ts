import { describe, expect, it } from 'vitest'
import vectors from '../../../crates/kition-open-token/tests/vectors.json'
import { OpenTokenError, checkOpenTokenKeys, openTokenPrincipal, decodeOpenToken, deriveDocKey, isOpenToken, openTokenDocument, openTokenRole, signOpenToken, verifyOpenToken, type OpenTokenKey } from '../src/openToken'

const keySets = vectors.keySets as Record<string, OpenTokenKey[]>

async function refusal(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    if (error instanceof OpenTokenError) return error.code
    throw error
  }
  return null
}

describe('open tokens (D2), against the Rust crate`s vectors', () => {
  for (const vector of vectors.cases) {
    it(vector.name, async () => {
      const run = verifyOpenToken(vector.token, keySets[vector.keys]!, vector.audience, vector.now)
      if ('error' in vector && vector.error) {
        expect(await refusal(run)).toBe(vector.error)
        return
      }
      const claims = await run
      const ok = (vector as { ok: Record<string, unknown> }).ok
      expect({ sub: claims.sub, name: claims.name, tenant: claims.tenant, iss: claims.iss, aud: claims.aud, principal: openTokenPrincipal(claims), file: claims.file, version: claims.version, docKey: claims.doc_key, role: openTokenRole(claims.perms), perms: claims.perms, watermark: claims.watermark, exp: claims.exp }).toEqual(ok)
    })
  }

  for (const entry of vectors.keySetErrors) {
    it(entry.name, () => {
      expect(() => checkOpenTokenKeys(entry.keys as OpenTokenKey[])).toThrow(expect.objectContaining({ code: entry.error }))
    })
  }

  it('derives the same doc keys', async () => {
    for (const entry of vectors.docKeys) expect(await deriveDocKey(entry.file, entry.generation)).toBe(entry.docKey)
    expect(await deriveDocKey('res:a', 1)).not.toBe(await deriveDocKey('res:a', 2))
  })

  it('reads a token without verifying it, and tells it from a sync token', () => {
    const token = vectors.cases[0]!.token
    expect(isOpenToken(token)).toBe(true)
    expect(isOpenToken(`ks1${token.slice(3)}`)).toBe(false)
    expect(decodeOpenToken(token).watermark).toEqual({ text: 'Alice 2026-11-03' })
    expect(() => decodeOpenToken('ko1.e30')).toThrow(OpenTokenError)
  })
})

describe('signing open tokens', () => {
  const claims = { iss: 'one.test', aud: 'srv', tenant: 'example-corp', sub: 'u1', name: 'Ann', file: 'res:1', version: 'r1', doc_key: 'abc', perms: { edit: true, comment: true, download: false, share: false, export: false }, watermark: null, iat: 1000, exp: 1300 }

  it('signs what it verifies, and what Rust would verify (sorted keys)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const publicKey = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const token = await signOpenToken(claims, 'k1', pair.privateKey)
    const verified = await verifyOpenToken(token, [{ kid: 'k1', publicKey, tenant: 'example-corp', iss: 'one.test' }], 'srv', 1100)
    expect(verified).toMatchObject({ ...claims, v: 1, typ: 'kition-open', kid: 'k1' })
    const json = atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))
    const keys = Object.keys(JSON.parse(json) as object)
    expect(keys).toEqual([...keys].sort())
    expect(await refusal(verifyOpenToken(token, [{ kid: 'k1', publicKey, tenant: 'other-corp', iss: 'one.test' }], 'srv', 1100))).toBe('unknown-key')
    expect(await refusal(verifyOpenToken(token, [{ kid: 'k1', publicKey, tenant: 'example-corp', iss: 'one.other' }], 'srv', 1100))).toBe('issuer')
    expect(await refusal(verifyOpenToken(token, [{ kid: 'k1', publicKey, tenant: 'example-corp', iss: 'one.test' }], 'other', 1100))).toBe('audience')
  })

  it('refuses claims the crate refuses', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    expect(await refusal(signOpenToken({ ...claims, perms: { ...claims.perms, comment: false } }, 'k1', pair.privateKey))).toBe('claims')
    expect(await refusal(signOpenToken({ ...claims, doc_key: '*' }, 'k1', pair.privateKey))).toBe('claims')
    expect(await refusal(signOpenToken({ ...claims, file: 'a/b.docx' }, 'k1', pair.privateKey))).toBe('claims')
    expect(await refusal(signOpenToken({ ...claims, exp: 1000 + 3601 }, 'k1', pair.privateKey))).toBe('expired')
  })

  it('opens the kit as the token says (Kit UI 2.6)', () => {
    expect(openTokenDocument({ perms: { edit: false, comment: true, download: false, share: true, export: false }, watermark: { text: 'Ann' } })).toEqual({ readOnly: true, canComment: true, permissions: { download: false, export: false, share: true }, watermark: { text: 'Ann' } })
  })

  it('maps permissions to the sync role, never owner', () => {
    expect(openTokenRole({ edit: true, comment: true, download: false, share: false, export: false })).toBe('editor')
    expect(openTokenRole({ edit: false, comment: true, download: true, share: true, export: true })).toBe('commenter')
    expect(openTokenRole({ edit: false, comment: false, download: true, share: true, export: true })).toBe('viewer')
  })
})
