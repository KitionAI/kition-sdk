/**
 * `@kition/embed` (`KitEmbed 1.3`): Kition's kit editors in any web page. `KitionEmbed.mount`
 * shows a kit's editor in an iframe from the kit package's origin, reads and saves the document
 * through the page's `StorageProvider`, and, with `collaboration`, co-edits it with others through
 * a `kition-sync/1` server, as the person the page's `IdentityProvider` names. Framework-free.
 */
import { mountEmbed } from './mount'
import type { EmbedEditor, EmbedOptions } from './types'

export { relayAgentPort } from './agent'
export { EmbedConflictError, EmbedError } from './errors'
export { EMBED_CAPABILITY_SETS, FRAME_ALLOW, FRAME_SANDBOX } from './mount'
export { ROOMS_KEY } from './rooms'
export { EMBED_VERSION } from './version'
export type * from './types'

export const KitionEmbed = {
  /**
   * Mounts the kit's editor for `options.file` in `element` (which it fills); `ready()` tells when
   * it shows the document.
   *
   * Co-editing editors with sync tokens on one page share one connection per sync server, which
   * the first of them opens with its `identity`; an editor with an open token (KitCollab 1.4) has
   * its own. Every editor asks its identity for a token before it connects. One document
   * (one room) co-edits in one editor per page: another editor of the same document fails
   * `ready()` with an `EmbedError` whose `code` is `document-open`.
   */
  mount: (element: HTMLElement, options: EmbedOptions): Promise<EmbedEditor> => mountEmbed(element, options),
}
