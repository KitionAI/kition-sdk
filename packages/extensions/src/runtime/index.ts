/**
 * `@kition/extensions/runtime`: the extension's side. `startRuntime` serves the host on a port
 * (the sandbox worker runs it); `ExtensionContext` is what an extension's `activate(ctx)` gets.
 * `WORKER_RUNTIME`, `SANDBOX_HTML`, and `PANEL_HTML` are the built worker, sandbox page, and panel
 * page; `KitionPanel` is what a panel's scripts get as `window.kitionPanel`.
 */
export { PANEL_HTML, RUNTIME_INPUTS_SHA256, SANDBOX_HTML, WORKER_RUNTIME } from '../generated/runtime'
export { ExtensionDocument, type DocumentChangedEvent } from './document'
export type { KitionPanel } from './panel'
export { startRuntime, type CommandHandler, type ExtensionContext, type ExtensionModule, type ModuleLoader, type PanelConnection, type PanelHandler } from './runtime'
