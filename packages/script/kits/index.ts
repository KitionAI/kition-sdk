// Every generated kit (`@kition/script/kits`): importing this module registers each kit's schema with
// @kition/script, so `openDocument` (and an extension host) works on documents of any of them. The
// typings stay per kit (`@kition/script/kits/<kit>`): their type names overlap.
import type { KitDescriptor } from '../src/kits'
import { noteKit } from './note'

export { noteKit }

/** Every generated kit's descriptor, by kit id. */
export const KITS: Readonly<Record<string, KitDescriptor>> = Object.fromEntries(
  [noteKit].map((kit) => [kit.id, kit]),
)
