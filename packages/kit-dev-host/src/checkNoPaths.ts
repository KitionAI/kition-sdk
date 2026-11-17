/**
 * `checkNoPaths` (KitFiles 1.0 section 13): a kit never sends a path-shaped string in a `files/*`
 * request. It names files by handle and suggests bare names; the host owns every path (FA-P2).
 */

/** A path-shaped string a kit sent: the request, where in its params, and the string. */
export type PathLeak = { method: string; at: string; value: string }

/** Params that hold a sentence for people (`purpose`, `title`): a slash is fine there, an absolute path is not. */
const FREE_TEXT = new Set(['purpose', 'title'])

/** Params that hold a MIME type (`files/create`'s and `files/print`'s `mime`): its slash is not a separator. */
const MIME_TYPE = new Set(['mime'])

/**
 * A MIME type: a registered top-level type (RFC 6838 section 4.2) and a subtype
 * (`application/pdf`, `image/svg+xml`, `application/vnd.oasis.opendocument.text`), with optional
 * parameters. The top-level type is what tells it from a folder and a name (`exports/Out.pdf`).
 */
const MIME = /^(application|audio|example|font|haptics|image|message|model|multipart|text|video)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;\s*[a-z0-9!#$&^_.+-]+=("[^"\\/]*"|[^\s;"\\/]+))*$/i

/** Absolute paths, home and drive paths, UNC shares, and file URIs, anywhere in a string. */
const ABSOLUTE = /(^|[\s"'(=])(\/(?:Users|home|root|var|tmp|private|Volumes|mnt|media|etc|opt|srv|data|workspace)\b|[A-Za-z]:[\\/]|\\\\[^\\\s]|~[\\/]|file:)/i

/** Whether `value` is path-shaped: an absolute path anywhere, or (outside free text) any separator. */
export function isPathShaped(value: string, freeText = false) {
  if (ABSOLUTE.test(value)) return true
  return !freeText && (/[\\/]/.test(value) || /^\.\.?$/.test(value))
}

/** Whether `value` is a MIME type rather than a path: `application/pdf` is, `exports/Out.pdf` and `/tmp/x` are not. */
export function isMimeType(value: string) {
  return MIME.test(value)
}

type Kind = 'name' | 'free' | 'mime'

function walk(value: unknown, at: string, kind: Kind, out: Array<{ at: string; value: string }>, depth = 0) {
  if (typeof value === 'string') {
    const leak = kind === 'mime' ? !isMimeType(value) && isPathShaped(value) : isPathShaped(value, kind === 'free')
    if (leak) out.push({ at, value })
    return
  }
  if (value === null || typeof value !== 'object' || depth > 8 || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`, kind, out, depth + 1))
  else for (const [key, item] of Object.entries(value)) walk(item, at ? `${at}.${key}` : key, FREE_TEXT.has(key) ? 'free' : MIME_TYPE.has(key) ? 'mime' : 'name', out, depth + 1)
}

/** The path-shaped strings in the `files/*` requests a kit sent; none when it kept to handles and names. */
export function checkNoPaths(requests: ReadonlyArray<{ method: string; params: unknown }>): PathLeak[] {
  const leaks: PathLeak[] = []
  for (const { method, params } of requests) {
    if (!method.startsWith('files/')) continue
    const found: Array<{ at: string; value: string }> = []
    walk(params, '', 'name', found)
    for (const leak of found) leaks.push({ method, ...leak })
  }
  return leaks
}
