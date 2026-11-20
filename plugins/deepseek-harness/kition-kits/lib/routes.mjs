// The host module's web routes under /kition/, on DeepSeek Harness's own web server (and through
// Desktop's dsh-app:// forwarding, which adds the Host's login cookie):
//
//   GET  /kition/api/open?session=<id>&path=<file>   the editor page's address for a session's file,
//        its gateway started: { key, workspace, path, page }; or { error, message } (kition-missing,
//        gateway-failed, session-unknown, outside-workspace, ...)
//   *    /kition/w/<key>/<rest>                       <rest> of the gateway of the workspace <key>
//        names, which must be a workspace of a DeepSeek Harness session (docs/sdk/gateway-page.md);
//        a merge or discard of a draft that passes is recorded with the workspace (lib/reviews.mjs)
//   GET  /kition/api/reviews?session=<id>             those records, for the session's workspace
//   GET  /kition/api/live?session=<id>                the live window's event stream (lib/live.mjs)
//   POST /kition/api/live {id, state}                 a browser's answer to an announcement
//
// Every request passes DeepSeek Harness's own login first (the connection service's Host/Origin
// fence and browser cookie: plugin routes are not guarded otherwise), and nothing reaches a
// gateway for a folder no session works in.
import path from 'node:path'

import { answerJson, forward } from './forward.mjs'
import { GatewayError, workspaceKey } from './gateways.mjs'
import { readReviews, recordReview } from './reviews.mjs'

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
 *   opened?: (gateway: import('./gateways.mjs').Gateway | null) => void,
 *   live?: import('./live.mjs').LiveAnnouncer,
 * }} options `opened` hears each file a person opens (with its gateway once it runs)
 */
export function createRoutes({ gateways, workspaces, rejection, log = () => {}, opened = () => {}, live = null }) {
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
        opened(null)
        opened(await gateways.get(workspace))
        const page = `${PREFIX}/w/${key}/page/?${new URLSearchParams({ path: relative })}`
        return answerJson(res, 200, { key, workspace, path: relative, page })
      }
      if (pathname === `${PREFIX}/api/reviews`) {
        if (req.method !== 'GET') return answerJson(res, 405, { error: 'method', message: 'GET only' })
        const workspace = await workspaces.ofSession(url.searchParams.get('session') ?? '')
        if (!workspace) return answerJson(res, 404, { error: 'session-unknown', message: 'DeepSeek Harness knows no such session, or it has no workspace folder' })
        return answerJson(res, 200, { reviews: readReviews(workspace) })
      }
      if (pathname === `${PREFIX}/api/live` && live) {
        if (req.method === 'GET') {
          const session = url.searchParams.get('session') ?? ''
          if (!(await workspaces.ofSession(session))) return answerJson(res, 404, { error: 'session-unknown', message: 'DeepSeek Harness knows no such session' })
          return live.watch(session, req, res)
        }
        if (req.method !== 'POST') return answerJson(res, 405, { error: 'method', message: 'GET or POST' })
        const body = await readJson(req)
        return answerJson(res, live.answer(String(body?.id ?? ''), String(body?.state ?? '')) ? 200 : 404, {})
      }
      const routed = /^\/kition\/w\/([0-9a-f]{32})(\/.*)?$/.exec(pathname)
      if (routed) {
        const workspace = await workspaces.ofKey(routed[1])
        if (!workspace) return answerJson(res, 404, { error: 'workspace-unknown', message: 'no DeepSeek Harness session works in this workspace' })
        const gateway = await gateways.get(workspace)
        const rest = `${routed[2] ?? '/'}${url.search}`
        const review = req.method === 'POST' ? /^\/api\/v1\/kits\/drafts\/(merge|discard)$/.exec(routed[2] ?? '') : null
        if (review) {
          // The person's review of a draft: recorded with the workspace once the gateway did it.
          const body = await readBody(req)
          let asked = {}
          try {
            asked = JSON.parse(body.toString('utf8'))
          } catch {
            // The gateway answers a body it cannot read.
          }
          const turn = Number(req.headers['kition-dsh-turn'])
          return forward(req, res, gateway, rest, () => gateways.forget(workspace), {
            body,
            answered: (status) => {
              if (status < 200 || status >= 300 || typeof asked.path !== 'string') return
              try {
                recordReview(workspace, { path: asked.path, outcome: review[1] === 'merge' ? 'merged' : 'discarded', overwrite: asked.overwrite === true, session: String(req.headers['kition-dsh-session'] ?? '') || null, turn: Number.isSafeInteger(turn) ? turn : null })
              } catch (error) {
                log(`could not record the review of ${asked.path}: ${error.message}`)
              }
            },
          })
        }
        return forward(req, res, gateway, rest, () => gateways.forget(workspace))
      }
      return answerJson(res, 404, { error: 'not-found', message: 'no such Kition route' })
    } catch (error) {
      return failure(res, error)
    }
  }
}

/** A request's body, whole (a small JSON one), at most 1 MiB. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1 << 20) throw new Error('the request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)).toString('utf8'))
  } catch {
    return null
  }
}
