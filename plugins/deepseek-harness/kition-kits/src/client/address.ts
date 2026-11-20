/**
 * DeepSeek Harness's file addresses, as its right sidebar names a file (the tab's content id):
 * `dsh-resource://file/session/<session id>/<path>` (a path relative to the session's workspace
 * folder, or absolute) and `dsh-resource://file/absolute/<path>` (no session; the leading `/`
 * dropped). Every segment is component-encoded. Only reading is needed here.
 */
const PREFIX = 'dsh-resource://file/'

export type FileAddress = { scope: 'session'; sessionId: string; path: string } | { scope: 'absolute'; path: string }

export function parseFileAddress(address: string): FileAddress | null {
  if (typeof address !== 'string' || !address.startsWith(PREFIX)) return null
  const end = address.search(/[?#]/)
  const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? undefined : end).split('/')
  try {
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (!id || segments.length === 0) return null
      const path = segments.map(decodeURIComponent).join('/')
      return path ? { scope: 'session', sessionId: decodeURIComponent(id), path } : null
    }
    if (scope === 'absolute' && rest.length > 0) {
      const path = rest.map(decodeURIComponent).join('/')
      // A Windows drive (`C:/...`) is absolute as written; anything else gets its `/` back.
      return { scope: 'absolute', path: /^[A-Za-z]:/.test(path) ? path : `/${path}` }
    }
  } catch {
    return null
  }
  return null
}

/** The file's name: the last segment of its path. */
export const baseName = (path: string) => path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)

/** The file's extension, lower case, without the dot; `''` when it has none. */
export function extensionOf(path: string) {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
