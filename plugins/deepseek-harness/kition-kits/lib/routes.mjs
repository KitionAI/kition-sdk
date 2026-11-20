// The host module's web routes under /kition/, on DeepSeek Harness's own web server (and through
// Desktop's dsh-app:// forwarding, which adds the Host's login cookie):
//
//   GET  /kition/api/open?session=<id>&path=<file>   the editor page's address for a session's file,
//        its gateway started: { key, workspace, path, page }; or { error, message } (kition-missing,
//        gateway-failed, session-unknown, outside-workspace, ...)
//   *    /kition/w/<key>/<rest>                       <rest> of the gateway of the workspace <key>
//        names, which must be a workspace of a DeepSeek Harness session (docs/sdk/gateway-page.md)
//
// Every request passes DeepSeek Harness's own login first (the connection service's Host/Origin
// fence and browser cookie: plugin routes are not guarded otherwise), and nothing reaches a
// gateway for a folder no session works in.
import path from 'node:path'

import { answerJson, forward } from './forward.mjs'
import { GatewayError, workspaceKey } from './gateways.mjs'

export const PREFIX = '/kition'

/**
 * The workspace-relative path of `file` (relative to the workspace, or absolute inside it), with
 * `/` separators; null when it is outside the workspace or names the workspace itself.
 */
export function relativeInside(workspace, file) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return null
  const absolute = path.resolve(workspace, file)
  const relative = path.relative(workspace, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/**
 * The routes' handler.
 * @param {{
 *   gateways: import('./gateways.mjs').Gateways,
 *   workspaces: import('./workspaces.mjs').Workspaces,
 *   rejection: (req: import('node:http').IncomingMessage) => number | undefined,
 *   log?: (message: string) => void,
 * }} options
 */
export function createRoutes({ gateways, workspaces, rejection, log = () => {} }) {
  const failure = (res, error) => {
    if (error instanceof GatewayError) return answerJson(res, 503, { error: error.code, message: error.message })
    log(`error: ${error?.stack ?? error}`)
    return answerJson(res, 500, { error: 'internal', message: String(error?.message ?? error) })
  }

  return async function handle(req, res) {
    // DeepSeek Harness's login first, before anything is read or started.
    const refused = rejection(req)
    if (refused !== undefined) return answerJson(res, refused, { error: refused === 403 ? 'forbidden' : 'unauthenticated', message: 'sign in to DeepSeek Harness first' })
    let url
    try {
      // WHATWG parsing resolves `.`, `..` and their %2e spellings: no segment climbs out below.
      url = new URL(req.url ?? '/', 'http://host.invalid')
    } catch {
      return answerJson(res, 400, { error: 'bad-request', message: 'not a request path' })
    }
    const { pathname } = url
    try {
      if (pathname === `${PREFIX}/api/open`) {
        if (req.method !== 'GET') return answerJson(res, 405, { error: 'method', message: 'GET only' })
        const workspace = await workspaces.ofSession(url.searchParams.get('session') ?? '')
        if (!workspace) return answerJson(res, 404, { error: 'session-unknown', message: 'DeepSeek Harness knows no such session, or it has no workspace folder' })
        const relative = relativeInside(workspace, url.searchParams.get('path'))
        if (!relative) return answerJson(res, 403, { error: 'outside-workspace', message: 'the file is not inside the session’s workspace folder' })
        const key = workspaceKey(workspace)
        await gateways.get(workspace)
        const page = `${PREFIX}/w/${key}/page/?${new URLSearchParams({ path: relative })}`
        return answerJson(res, 200, { key, workspace, path: relative, page })
      }
      const routed = /^\/kition\/w\/([0-9a-f]{32})(\/.*)?$/.exec(pathname)
      if (routed) {
        const workspace = await workspaces.ofKey(routed[1])
        if (!workspace) return answerJson(res, 404, { error: 'workspace-unknown', message: 'no DeepSeek Harness session works in this workspace' })
        const gateway = await gateways.get(workspace)
        return forward(req, res, gateway, `${routed[2] ?? '/'}${url.search}`, () => gateways.forget(workspace))
      }
      return answerJson(res, 404, { error: 'not-found', message: 'no such Kition route' })
    } catch (error) {
      return failure(res, error)
    }
  }
}
