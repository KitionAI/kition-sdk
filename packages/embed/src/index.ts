/**
 * `@kition/embed` (`KitEmbed 1.3`): Kition's kit editors in any web page. `KitionEmbed.mount`
 * shows a kit's editor in an iframe from the kit package's origin, reads and saves the document
 * through the page's `StorageProvider`, as the person the page's `IdentityProvider` names.
 * Framework-free.
 */
import { mountEmbed } from './mount'
import type { EmbedEditor, EmbedOptions } from './types'

export { relayAgentPort } from './agent'
export { EmbedConflictError, EmbedError } from './errors'
export { EMBED_CAPABILITY_SETS, FRAME_ALLOW, FRAME_SANDBOX } from './mount'
export { EMBED_VERSION } from './version'
export type * from './types'

export const KitionEmbed = {
  /**
   * Mounts the kit's editor for `options.file` in `element` (which it fills); `ready()` tells when
   * it shows the document.
   */
  mount: (element: HTMLElement, options: EmbedOptions): Promise<EmbedEditor> => mountEmbed(element, options),
}
