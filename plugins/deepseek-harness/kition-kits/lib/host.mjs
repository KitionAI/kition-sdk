// @kition/dsh-kits, the host module: a cordis plugin DeepSeek Harness loads on its host from the
// bundle's patch (row `kition-kits-host`). It holds the workspaces' `kition gateway`s, registers
// the kits' tools and resources so each session's calls reach its own folder's gateway
// (lib/tools.mjs), keeps them current (lib/freshness.mjs), and, in a profile with the browser UI,
// serves the gateways' editor page and its files same-origin under /kition/ behind DeepSeek
// Harness's own login (lib/routes.mjs). Its settings (the row's Config) are the person's, edited in
// DeepSeek Harness's settings and read by the browser module. Every API it uses is the same in
// DeepSeek Harness 0.2.2-rc.2 and rc.5; what a profile lacks (no web server in `headless`, no
// resource tools) is left out by its injections, never by version.
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { Freshness } from './freshness.mjs'
import { LiveAnnouncer } from './live.mjs'
import { catalog, connectionId, GatewayMcp } from './mcp.mjs'
import { Gateways } from './gateways.mjs'
import { createRoutes, PREFIX } from './routes.mjs'
import { KitTools, SERVER } from './tools.mjs'
import { Workspaces } from './workspaces.mjs'

export const name = '@kition/dsh-kits'

/** The person's settings, with their defaults (the browser module reads them through `configForms`). */
export const SETTINGS = {
  liveFloat: true,
  openWith: 'dsh',
  autoOpen: false,
}

/**
 * DeepSeek Harness's own schemastery, from the runtime that loads this module (a plugin installs
 * none of its own): the settings form is made from a Config of it. Null where it is not found;
 * the browser module then uses the defaults.
 */
function runtimeSchema() {
  for (const entry of [process.argv[1], process.mainModule?.filename]) {
    if (typeof entry !== 'string' || !entry) continue
    try {
      const schema = createRequire(fs.realpathSync(entry))('@deepseek-ai/schemastery')
      return schema.default ?? schema
    } catch {
      // Not from this entry.
    }
  }
  return null
}

const z = runtimeSchema()
export const Config = z
  ? z
      .object({
        liveFloat: z
          .boolean()
          .default(SETTINGS.liveFloat)
          .i18n({ en: 'Show an agent’s edit of a Kition file that is not open in a window, as it happens.', zh: 'Agent 编辑一个没有打开的 Kition 文件时，在窗口里实时显示。' })
          .volatile(),
        openWith: z
          .union([z.const('dsh').i18n({ en: 'DeepSeek Harness’s preview', zh: 'DeepSeek Harness 的预览' }), z.const('kition').i18n({ en: 'the Kition editor', zh: 'Kition 编辑器' })])
          .default(SETTINGS.openWith)
          .i18n({ en: 'What opens a Markdown, HTML, PDF, Word, Excel, PowerPoint, CSV or SVG file first.', zh: 'Markdown、HTML、PDF、Word、Excel、PowerPoint、CSV 和 SVG 文件先用什么打开。' })
          .volatile(),
        autoOpen: z
          .boolean()
          .default(SETTINGS.autoOpen)
          .i18n({ en: 'Open a file in the right sidebar after an agent’s first edit of it in a turn.', zh: 'Agent 在一轮里第一次编辑一个文件后，在右侧栏打开它。' })
          .volatile(),
      })
      .i18n({ en: 'Kition kits', zh: 'Kition 套件' })
  : undefined

/** A setting's value now: a volatile field is read through its `get()`. */
function setting(config, name) {
  const value = config?.[name]
  const now = typeof value?.get === 'function' ? value.get() : value
  return now ?? SETTINGS[name]
}

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

export function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('kition') : null
  const log = (message) => (logger ? logger.info(message) : process.stderr.write(`kition: ${message}\n`))
  const gateways = new Gateways({ env: process.env, log })
  ctx.effect(() => () => gateways.stop(), 'kition: the workspaces’ gateways')
  // The live window's handshake, while the person has it on.
  const live = new LiveAnnouncer({ enabled: () => setting(config, 'liveFloat') !== false })
  ctx.effect(() => () => live.close(), 'kition: the live window’s streams')
  /** The kit tools, once registered: the web routes have them listed again when a file opens. */
  let kitTools = null
  let freshness = null
  const opener = connectionId()

  ctx.plugin({
    name: `${name}/tools`,
    inject: ['tools'],
    async apply(inner) {
      const tools = new KitTools({ ctx: inner, register: (definition) => inner.tools.register(definition), gateways, mcp: new GatewayMcp(), log, beforeEdit: (sessionId, path) => live.announce(sessionId, path) })
      inner.effect(() => () => tools.dispose(), 'kition: kit tools')
      inner.inject(['systemPrompt'], (prompt) => {
        prompt.effect(
          () =>
            prompt.systemPrompt.section({
              name: `mcp:${SERVER}`,
              order: prompt.systemPrompt.getSectionOrder('MCP_SERVERS'),
              interpolate: false,
              text: () => (tools.missing ? '' : tools.instructions ? `### MCP server: ${SERVER}\n\n${tools.instructions}` : ''),
            }),
          'kition: the kits’ instructions',
        )
      })
      // The kits' resources, as DeepSeek Harness's resource tools read an MCP server's.
      inner.inject(['mcpResources'], (resources) => {
        resources.effect(() => resources.mcpResources.register(SERVER, tools.resourceProvider()), 'kition: the kits’ resources')
      })
      const fresh = new Freshness({ env: process.env, tools, gateways, catalog, log })
      inner.effect(() => () => fresh.stop(), 'kition: keeping the kit tools current')
      kitTools = tools
      freshness = fresh
      await fresh.start()
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
      const opened = (gateway) => {
        // A person opened a kit file: kition may be new, or the gateway may serve kits since installed.
        if (!gateway) void freshness?.check()
        else kitTools?.refresh(gateway, opener)
      }
      const handle = createRoutes({ gateways, workspaces, rejection, log, opened, live })
      inner.effect(() => inner.webServer.register({ kind: 'prefix', path: PREFIX, handler: handle }), 'kition: /kition/ routes')
    },
  })
}
