/**
 * The editor's live UI configuration (protocol section 9): the host's, replaced by `ui/configure`,
 * and the person's hides, applied at once and kept by the host (`host/customize`).
 */
import type { KitNotifications } from '@kition/kit-ui-protocol'
import type { UiConfig } from './uiConfig'

export type UiStore = {
  get: () => UiConfig
  /** For `useSyncExternalStore`. */
  subscribe: (listener: () => void) => () => void
  /** Replaces the host's configuration. While a personal change is being kept, it stays over the host's. */
  replace: (config: UiConfig) => void
  /** Whether the host keeps what the person hides (capability `customize`). */
  customizable: boolean
  /** Sets the person's hides; rejects when the host could not keep them (they still apply). */
  setPersonal: (hide: string[]) => Promise<void>
  /** A host button was pressed (`ui/action`). */
  action: (params: KitNotifications['ui/action']) => void
}

export function createUiStore(
  initial: UiConfig,
  customize: ((hide: string[]) => Promise<void>) | null,
  action: (params: KitNotifications['ui/action']) => void,
): UiStore {
  let config = initial
  /** The person's hides the host has not yet finished keeping; a `replace` while this is set keeps it over the host's value. */
  let pending: string[] | null = null
  const listeners = new Set<() => void>()
  const set = (next: UiConfig) => {
    config = pending ? { ...next, personal: pending } : next
    for (const listener of listeners) listener()
  }
  return {
    get: () => config,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    replace: set,
    customizable: customize !== null,
    setPersonal: async (hide) => {
      const personal = [...new Set(hide)]
      pending = personal
      set({ ...config, personal })
      try {
        if (customize) await customize(personal)
      } finally {
        if (pending === personal) pending = null
      }
    },
    action,
  }
}
