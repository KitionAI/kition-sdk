/**
 * The worker's lent files (`kitionHost`): `exists` answers `kition_kit::host::exists`. It is `false`
 * only for a path the binding lets through that the host answers 404 for; a path above the workspace
 * or with a hidden segment (host contract LR2) is refused before the host is asked, the same whether
 * it exists or not (regressions/issue-file-not-found).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lendFiles, lendHandle } from './lentFiles'

type Host = { size: (file: string) => number; exists: (file: string) => boolean }
const host = () => (globalThis as unknown as { kitionHost: Host }).kitionHost

/** A host whose workspace holds `files` (URL path to bytes), answering HEAD and GET as a file server does. */
function serve(files: Record<string, number>) {
  const asked: string[] = []
  class FakeRequest {
    status = 0
    responseType = ''
    response: ArrayBuffer | null = null
    private url = ''
    private length = 0
    open(_method: string, url: string) {
      this.url = url
    }
    setRequestHeader() {}
    send() {
      const path = new URL(this.url).pathname
      asked.push(path)
      const size = files[path]
      this.status = size == null ? 404 : 200
      this.length = size ?? 0
    }
    getResponseHeader(name: string) {
      return name === 'Content-Length' ? String(this.length) : null
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
  lendFiles(null)
})

describe('lent files: exists', () => {
  it('tells a missing file from one that is there', () => {
    serve({ '/ws/media/a.png': 3 })
    lendFiles({ root: 'http://host.test/ws/', folder: 'notes' })
    expect(host().exists('../media/a.png')).toBe(true)
    expect(host().exists('/media/a.png')).toBe(true)
    expect(host().exists('../media/missing.png')).toBe(false)
    expect(host().size('../media/a.png')).toBe(3)
  })

  it('refuses a path above the workspace or with a hidden segment alike, existing or not, without asking the host', () => {
    const asked = serve({ '/ws/.kition/drafts/a.png': 5, '/ws/.git/config': 6 })
    lendFiles({ root: 'http://host.test/ws/', folder: 'notes' })
    const refusal = (file: string) => {
      try {
        host().exists(file)
      } catch (error) {
        return String(error).replace(file, '<path>')
      }
      return 'answered'
    }
    for (const [existing, missing] of [['../.kition/drafts/a.png', '../.kition/drafts/b.png'], ['../.git/config', '../.nothing/config'], ['../../x.png', '../../y.png']]) {
      expect(refusal(existing)).not.toBe('answered')
      expect(refusal(existing)).toBe(refusal(missing))
    }
    expect(asked).toEqual([])
  })

  it('answers a granted handle by its lent bytes', () => {
    serve({})
    lendFiles({ root: 'http://host.test/ws/', folder: '' })
    lendHandle('fh_1', new Uint8Array([1]))
    expect(host().exists('fh_1')).toBe(true)
    expect(() => host().exists('fh_2')).toThrow()
  })
})
