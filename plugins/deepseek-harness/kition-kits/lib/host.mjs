// @kition/dsh-kits, the host module: a cordis plugin DeepSeek Harness loads on its host from the
// bundle's patch (row `kition-kits-host`). It holds the workspaces' `kition gateway`s, registers
// the kits' tools so each session's calls reach its own folder's gateway (lib/tools.mjs), and, in
// a profile with the browser UI, serves the gateways' editor page and its files same-origin under
// /kition/ behind DeepSeek Harness's own login (lib/routes.mjs). Every API it uses is the same in
// DeepSeek Harness 0.2.2-rc.2 and rc.5; what a profile lacks (no web server in `headless`) is
// left out by its injections, never by version.
import { catalog, GatewayMcp } from './mcp.mjs'
import { Gateways } from './gateways.mjs'
import { createRoutes, PREFIX } from './routes.mjs'
import { KitTools, SERVER } from './tools.mjs'
import { Workspaces } from './workspaces.mjs'

export const name = '@kition/dsh-kits'

/** The working folders DeepSeek Harness knows: its projects, and its live and saved sessions'. */
async function knownFolders(ctx) {
  const folders = []
  for (const workspace of ctx.get('workspaceRegistry')?.list?.() ?? []) folders.push(workspace?.path)
  for (const session of ctx.get('sessions')?.list?.() ?? []) folders.push(session?.header?.cwd)
  try {
    for (const snapshot of (await ctx.get('sessionPersistence')?.list?.()) ?? []) folders.push(snapshot?.header?.cwd)
  } catch {
    // Saved sessions are a fallback only.
  }
  return folders.filter((folder) => typeof folder === 'string' && folder !== '')
}

/** A session's working folder, live or saved. */
async function sessionFolder(ctx, id) {
  const live = ctx.get('sessions')?.get?.(id)
  if (live) return live.header?.cwd
  return (await ctx.get('sessionPersistence')?.stat?.(id))?.header?.cwd
}

export function apply(ctx) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('kition') : null
  const log = (message) => (logger ? logger.info(message) : process.stderr.write(`kition: ${message}\n`))
  const gateways = new Gateways({ env: process.env, log })
  ctx.effect(() => () => gateways.stop(), 'kition: the workspaces’ gateways')

  ctx.plugin({
    name: `${name}/tools`,
    inject: ['tools'],
    async apply(inner) {
      const tools = new KitTools({ ctx: inner, register: (definition) => inner.tools.register(definition), gateways, mcp: new GatewayMcp(), log })
      inner.effect(() => () => tools.dispose(), 'kition: kit tools')
      inner.inject(['systemPrompt'], (prompt) => {
        prompt.effect(
          () =>
            prompt.systemPrompt.section({
              name: `mcp:${SERVER}`,
              order: prompt.systemPrompt.getSectionOrder('MCP_SERVERS'),
              interpolate: false,
              text: () => (tools.instructions ? `### MCP server: ${SERVER}\n\n${tools.instructions}` : ''),
            }),
          'kition: the kits’ instructions',
        )
      })
      try {
        tools.update(await catalog(process.env))
      } catch (error) {
        log(`no kit tools: ${error.message}`)
      }
    },
  })

  ctx.plugin({
    name: `${name}/web`,
    inject: ['webServer', 'connection'],
    apply(inner) {
      const connection = inner.get('connection')
      const rejection =
        typeof connection?.requestRejection === 'function'
          ? (req) => connection.requestRejection(req)
          : // Without DeepSeek Harness's own login check nothing is served.
            () => 401
      const workspaces = new Workspaces({ cwdOf: (id) => sessionFolder(inner, id), list: () => knownFolders(inner) })
      const handle = createRoutes({ gateways, workspaces, rejection, log })
      inner.effect(() => inner.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle }), 'kition: /kition/ routes')
    },
  })
}
