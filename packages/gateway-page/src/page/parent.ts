/**
 * The page's side of its `postMessage` protocol with the window that frames it (`../index.ts`,
 * `docs/sdk/gateway-page.md`): it posts to `window.parent` only, with its own origin as the target,
 * and hears `window.parent` only, from its own origin. Standalone it posts nothing.
 */
import { GATEWAY_PAGE_PROTOCOL, isGatewayPageMessage, type GatewayPageCommand, type GatewayPageMessage } from '../index'

type Outgoing = GatewayPageMessage extends infer M ? (M extends { kitionGatewayPage: 1 } ? Omit<M, 'kitionGatewayPage'> : never) : never

/** The page's own origin as a `postMessage` target: `*` only where the browser names it `null` (an opaque origin). */
const target = () => (location.origin && location.origin !== 'null' ? location.origin : '*')

export const framed = () => window.parent !== window

export function post(message: Outgoing) {
  if (!framed()) return
  window.parent.postMessage({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, ...message }, target())
}

/** Hears the commands of the window that frames the page. */
export function listen(handler: (command: GatewayPageCommand) => void) {
  window.addEventListener('message', (event) => {
    if (!framed() || event.source !== window.parent) return
    if (target() !== '*' && event.origin !== location.origin) return
    if (!isGatewayPageMessage(event.data)) return
    handler(event.data as GatewayPageCommand)
  })
}
